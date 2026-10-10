// F-088 · REST surface for ERC-8350 anchoring. Decoupled sub-module, same pattern
// as telemetry-api-handlers.mjs. All routes are no-ops (404-ish JSON) when the
// feature is disabled — the daemon never fails because of anchoring.

import fs from 'node:fs';
import path from 'node:path';
import {confirmSeq, getMeta} from './anchoring/anchor-state.mjs';
import {verifyEvmConfirmation} from './anchoring/evm-confirmation.mjs';

function localRequest(req) {
  const host = req.headers.host;
  try {
    if (host && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(`http://${host}`).hostname)) return false;
    if (!req.headers.origin) return true;
    const origin = new URL(req.headers.origin);
    return origin.protocol === 'http:' && !!host && origin.host === host;
  } catch { return false; }
}

function workspacePath(daemon, mgr) {
  const projectDir = daemon.projectDir || mgr.daemon?.projectDir ||
    path.dirname(daemon.awarenessDir || mgr.daemon?.awarenessDir || '');
  return fs.realpathSync(projectDir);
}

function json(res, status, body) {
  res.writeHead(status, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      data += c;
      if (Buffer.byteLength(data) > 64 * 1024) {
        tooLarge = true; data = ''; reject(new Error('body too large'));
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export async function handleAnchorRoute(daemon, req, res, route) {
  // Status builds a local delta too; protect all routes against browser-origin
  // requests and DNS rebinding. The native CLI has no Origin header.
  if (!localRequest(req)) return json(res, 403, {error: 'forbidden_origin'});
  const mgr = daemon.anchoring;
  if (!mgr) {
    return json(res, 200, {enabled: false, hint: 'set anchoring.enabled=true in .awareness/config.json and restart'});
  }

  try {
    if (route === '/anchor/status' && req.method === 'GET') {
      return json(res, 200, mgr.status());
    }

    if (route === '/anchor/outbox' && req.method === 'GET') {
      const solana = mgr.cfg.backend === 'solana';
      return json(res, 200, {pending: mgr.outbox(), projectDir: workspacePath(daemon, mgr),
        backend: mgr.cfg.backend || 'evm', spaceId: getMeta(mgr.db, 'space_id'),
        chainId: solana ? null : mgr.cfg.chain_id, registry: solana ? null : mgr.cfg.registry_address,
        programId: solana ? mgr.cfg.program_id : null, genesisHash: solana ? mgr.cfg.genesis_hash : null,
        controller: mgr.cfg.controller_address || null});
    }

    // F-088 P3 · per-card anchor state for UI badges: card_id → {seq, status, tx}
    if (route === '/anchor/cards' && req.method === 'GET') {
      const rows = mgr.db.prepare(
        `SELECT s.card_id, s.built_seq AS seq, COALESCE(o.status, 'pending') AS status, o.tx_hash
         FROM anchor_state s LEFT JOIN anchor_outbox o ON o.seq = s.built_seq`
      ).all();
      const cards = {};
      for (const r of rows) cards[r.card_id] = {seq: r.seq, status: r.status, tx: r.tx_hash || null};
      return json(res, 200, {cards});
    }

    if (route === '/anchor/confirm' && req.method === 'POST') {
      if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return json(res, 415, {error: 'application/json required'});
      }
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); }
      catch { return json(res, 400, {error: 'invalid JSON body'}); }
      if (!body || typeof body !== 'object') return json(res, 400, {error: 'invalid confirmation'});
      if (daemon.anchoring !== mgr || !mgr.db?.open || body.project_dir !== workspacePath(daemon, mgr)) {
        return json(res, 409, {error: 'confirmation workspace does not match; retry in the original workspace'});
      }
      const seq = Number(body.seq);
      const txHash = body.tx_hash ?? null;
      if (!Number.isSafeInteger(seq) || seq < 1 ||
          !/^0x[0-9a-fA-F]{64}$/.test(body.space_id) ||
          !/^0x[0-9a-fA-F]{64}$/.test(body.transition_id) ||
          (txHash !== null && typeof txHash !== 'string')) {
        return json(res, 400, {error: 'expected seq, space_id, transition_id and tx_hash (or null for recovery)'});
      }
      const row = mgr.db.prepare("SELECT * FROM anchor_outbox WHERE seq = ? AND status = 'pending'").get(seq);
      if (!row || row.space_id !== body.space_id || row.transition_id !== body.transition_id) {
        return json(res, 409, {error: 'pending transition does not match this workspace'});
      }
      // Never trust the caller's success claim: use the configured RPC and
      // immutable transition record to independently verify the exact content.
      const cfg = mgr.cfg;
      try {
        if (cfg.backend === 'solana') {
          const {verifySolanaConfirmation} = await import('./anchoring/solana-client.mjs');
          await verifySolanaConfirmation({rpcUrl: cfg.rpc_url, programId: cfg.program_id,
            genesisHash: cfg.genesis_hash, spaceId: row.space_id, row, txHash});
        } else {
          await verifyEvmConfirmation({rpcUrl: cfg.rpc_url, chainId: cfg.chain_id,
            registry: cfg.registry_address, spaceId: row.space_id, row, txHash});
        }
      } catch (err) { return json(res, 422, {error: `chain verification failed: ${err.message}`}); }
      if (daemon.anchoring !== mgr || !mgr.db?.open) {
        return json(res, 409, {error: 'workspace changed during confirmation; retry in the original workspace'});
      }
      const ok = confirmSeq(mgr.db, seq, txHash);
      return ok
        ? json(res, 200, {confirmed: seq, tx_hash: txHash})
        : json(res, 409, {error: `seq ${seq} is not pending`});
    }

    return json(res, 404, {error: `unknown anchor route: ${route}`});
  } catch (err) {
    return json(res, 500, {error: err.message});
  }
}

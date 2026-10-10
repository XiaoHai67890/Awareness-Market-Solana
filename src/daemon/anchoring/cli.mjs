import fs from 'node:fs';
import path from 'node:path';
import {loadLocalConfig} from '../../core/config.mjs';

async function request(base, route, options) {
  const response = await fetch(`${base}${route}`, {...options, signal: AbortSignal.timeout(60000)});
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `daemon HTTP ${response.status}`);
  return body;
}

export async function runAnchor({flags, sub, promptHidden, log = console.log}) {
  const projectDir = fs.realpathSync(path.resolve(String(flags.project || flags.dir || process.cwd())));
  const port = Number(flags.port || loadLocalConfig(projectDir)?.daemon?.port || 37800);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid daemon port');
  const base = `http://127.0.0.1:${port}/api/v1`;
  const status = await request(base, '/anchor/status');
  if (!status.enabled) {
    log('Anchoring is disabled. Configure .awareness/config.json and restart the daemon.');
    return;
  }
  if (!status.projectDir || fs.realpathSync(status.projectDir) !== projectDir) {
    throw new Error('daemon is serving a different workspace; switch it to the requested --project first');
  }
  const solana = status.backend === 'solana';
  if (sub === 'status') {
    log(`Space:        ${status.spaceId || '(created on first build)'}`);
    log(`Controller:   ${status.controller || '(not configured)'}`);
    log(solana ? `Network:      Solana ${status.cluster} · program ${status.programId}` :
      `Chain:        ${status.chainId} · registry ${status.registry}`);
    log(`Local head:   seq ${status.lastBuilt.seq} · ${status.lastBuilt.root || '(empty)'}`);
    log(`Anchored:     ${status.anchored.count} transition(s)`);
    log(`Pending:      ${status.pending.length}`);
    for (const row of status.pending) log(`  seq ${row.seq} · ${row.opsCount} ops · ${row.transitionId}`);
    if (status.pending.length) log('Run awareness-local anchor flush to broadcast.');
    return;
  }
  if (sub !== 'flush') throw new Error(`unknown anchor subcommand: ${sub} (expected status or flush)`);
  if (!status.pending.length) { log('Nothing to anchor.'); return; }
  if (!status.controller) throw new Error('anchoring.controller_address is not configured');
  const outbox = await request(base, '/anchor/outbox');
  if (outbox.projectDir !== projectDir ||
      ['backend', 'spaceId', 'chainId', 'registry', 'programId', 'genesisHash', 'controller']
        .some(key => (outbox[key] ?? null) !== (status[key] ?? null))) {
    throw new Error('workspace or anchoring identity changed while reading outbox; retry');
  }
  const {pending} = outbox;
  if (!pending.length) { log('Nothing to anchor.'); return; }
  const onConfirm = async (seq, txHash) => {
    const row = pending.find((candidate) => candidate.seq === seq);
    if (!row) throw new Error('confirmation sequence is absent from this flush');
    await request(base, '/anchor/confirm', {method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({seq, tx_hash: txHash, project_dir: projectDir,
        space_id: row.space_id, transition_id: row.transition_id}),
    });
  };
  let results;
  if (solana) {
    if (typeof flags.keypair !== 'string') throw new Error('Solana flush requires --keypair /path/to/test-wallet.json');
    const {Keypair} = await import('@solana/web3.js');
    let secret;
    try { secret = JSON.parse(fs.readFileSync(path.resolve(flags.keypair), 'utf8')); }
    catch { throw new Error('cannot read a valid JSON Solana keypair file'); }
    if (!Array.isArray(secret) || secret.length !== 64 ||
        !secret.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error('invalid Solana keypair file');
    const bytes = Uint8Array.from(secret);
    let keypair;
    try {
      keypair = Keypair.fromSecretKey(bytes);
      const {flushSolanaOutbox} = await import('./solana-client.mjs');
      results = await flushSolanaOutbox({rpcUrl: status.rpcUrl, programId: status.programId,
        genesisHash: status.genesisHash, keypair, controller: status.controller,
        spaceId: status.spaceId, spaceSalt: status.spaceSalt, rows: pending, onConfirm, log});
    } finally {
      bytes.fill(0);
      secret.fill(0);
      // JS runtimes may retain copies; key material is never sent to the daemon.
      keypair?.secretKey.fill(0);
    }
  } else {
    const key = await promptHidden(`Paste the private key for ${status.controller} (input hidden): `);
    const {flushOutbox} = await import('./flush.mjs');
    results = await flushOutbox({rpcUrl: status.rpcUrl, chainId: status.chainId, registry: status.registry,
      privKeyHex: key.startsWith('0x') ? key : `0x${key}`, controller: status.controller,
      spaceId: status.spaceId, spaceSalt: status.spaceSalt, rows: pending, onConfirm, log});
  }
  const sent = results.filter((row) => !row.skipped).length;
  log(`Done: ${sent} anchored, ${results.length - sent} reconciled.`);
}

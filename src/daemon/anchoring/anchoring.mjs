// F-088 · ERC-8350 anchoring manager (pull-based snapshot diff → local outbox).
//
// Design contract (docs/features/f-088-erc8350-anchoring/PLAN.md):
// - Reads knowledge_cards ONLY; never touches any write path (covers all four
//   mutation paths — submit-insights, extractor, cloud pull, evolution — for free).
// - The chain is never a hard dependency: everything here is local. Broadcasting
//   is a separate concern owned by the CLI, which is the only place a key exists.
// - Fail-soft: any error disables anchoring for the session and warns; memory
//   features are unaffected.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  deriveSpaceId, computeTransitionId, computeNextStateRoot,
  computeDeltaCommitment, keccakUtf8, stableStringify, ZERO32,
} from './erc8350.mjs';
import {
  openAnchoringDatabase, getMeta, setMeta, getStateMap, applySnapshot,
  insertOutbox, listPending, countAnchored,
} from './anchor-state.mjs';
import {deriveSolanaSpaceId, validateSolanaPublicKey} from './solana-codec.mjs';

// Digest profile: one delta summarizes a batch of card mutations. Unsalted and
// public by design (profile ids are documented as effectively public).
export const CARD_DIGEST_PROFILE_V1_ID = keccakUtf8(
  'https://awareness.market/profiles/memory/card-digest/v1'
);
export const CARD_DIGEST_PROFILE_ID = keccakUtf8(
  'https://awareness.market/profiles/memory/card-digest/v2'
);
export const CARD_DIGEST_PROFILE_V2_ID = CARD_DIGEST_PROFILE_ID;

/** Reproduce both frozen profiles, including already-published v1 witnesses. */
export function computeCardDigest(row, profileId = CARD_DIGEST_PROFILE_ID) {
  const profile = typeof profileId === 'string' ? profileId.toLowerCase() : '';
  let basis;
  if (profile === CARD_DIGEST_PROFILE_V1_ID) {
    basis = [row.id, row.category ?? '', row.title ?? '', row.summary ?? '',
      row.tags ?? '', row.status ?? ''].join('');
  } else if (profile === CARD_DIGEST_PROFILE_ID) {
    // Canonical JSON encodes boundaries explicitly and retains null values.
    basis = stableStringify({
      id: row.id, category: row.category ?? null, title: row.title ?? null,
      summary: row.summary ?? null, tags: row.tags ?? null, status: row.status ?? null,
    });
  } else throw new Error('unsupported Awareness card digest profile');
  return crypto.createHash('sha256').update(basis, 'utf8').digest('hex');
}

const META_SALT = 'space_salt';
const META_SPACE = 'space_id';
const META_CONTROLLER = 'controller';
const META_LAST_SEQ = 'last_seq';
const META_LAST_ROOT = 'last_root';

export class AnchoringManager {
  constructor(daemon, cfg) {
    this.daemon = daemon;
    this.cfg = {...cfg, backend: cfg?.backend || 'evm'};
    if (!['evm', 'solana'].includes(this.cfg.backend)) {
      throw new Error(`unsupported anchoring.backend: ${this.cfg.backend}`);
    }
    this.db = null;
    this.witnessDir = path.join(daemon.awarenessDir, 'witness');
  }

  ensureInit() {
    if (this.db?.open) return this;
    const indexDb = this.daemon.indexer?.db;
    if (!indexDb || indexDb.open === false) {
      throw new Error('indexer db unavailable (NoopIndexer?) — anchoring disabled');
    }
    const {db} = openAnchoringDatabase(this.daemon.awarenessDir, indexDb);
    this.db = db;
    try {
      fs.mkdirSync(this.witnessDir, {recursive: true, mode: 0o700});
      fs.chmodSync(this.witnessDir, 0o700);
      this.db.transaction(() => {
        this._assertIdentityBinding(false);
        this._validatePersistedIdentity();
      }).immediate();
      return this;
    } catch (err) {
      this.close();
      throw err;
    }
  }

  _cardHash(row) {
    return computeCardDigest(row, CARD_DIGEST_PROFILE_ID);
  }

  _snapshot() {
    const indexDb = this.daemon.indexer?.db;
    if (!indexDb || indexDb.open === false) throw new Error('indexer db unavailable — no snapshot was built');
    const rows = indexDb.prepare(
      "SELECT id, category, title, summary, tags, status FROM knowledge_cards " +
      "WHERE status IS NULL OR status != 'superseded'"
    ).all();
    return rows.map((r) => ({card_id: r.id, content_hash: this._cardHash(r)}));
  }

  _diff(stateMap, snapshot) {
    const ops = [];
    const seen = new Set();
    for (const e of snapshot) {
      seen.add(e.card_id);
      const prev = stateMap.get(e.card_id);
      if (prev === undefined) ops.push({card: e.card_id, hash: e.content_hash, op: 'added'});
      else if (prev !== e.content_hash) ops.push({card: e.card_id, hash: e.content_hash, op: 'updated'});
    }
    for (const [cardId] of stateMap) {
      if (!seen.has(cardId)) ops.push({card: cardId, op: 'removed'});
    }
    ops.sort((a, b) => (a.card < b.card ? -1 : a.card > b.card ? 1 : 0));
    return ops;
  }

  _configBinding(requireConfigured = false) {
    const backend = this.cfg.backend;
    const controller = (this.cfg.controller_address || '').trim();
    if (controller) {
      if (backend === 'evm' && !/^0x[0-9a-fA-F]{40}$/.test(controller)) {
        throw new Error(`invalid anchoring.controller_address: ${controller}`);
      }
      if (backend === 'solana') validateSolanaPublicKey(controller, 'controller_address');
    }
    if (backend === 'evm') {
      const chainId = this.cfg.chain_id == null ? '' : String(this.cfg.chain_id);
      const registry = (this.cfg.registry_address || '').trim().toLowerCase();
      if (chainId && (!Number.isSafeInteger(Number(chainId)) || Number(chainId) <= 0)) {
        throw new Error('invalid anchoring.chain_id');
      }
      if (registry && !/^0x[0-9a-f]{40}$/.test(registry)) throw new Error('invalid anchoring.registry_address');
      if (requireConfigured && (!chainId || !registry)) {
        throw new Error('anchoring requires chain_id and registry_address before creating a Space');
      }
      return {backend, chainId: chainId ? String(Number(chainId)) : '', registry};
    }
    const programId = (this.cfg.program_id || '').trim();
    const genesisHash = (this.cfg.genesis_hash || '').trim();
    if (programId) validateSolanaPublicKey(programId, 'program_id');
    if (genesisHash) validateSolanaPublicKey(genesisHash, 'genesis_hash');
    if (requireConfigured && (!programId || !genesisHash)) {
      throw new Error('Solana anchoring requires program_id and genesis_hash before creating a Space');
    }
    return {backend, programId, genesisHash};
  }

  _assertIdentityBinding(bind) {
    const savedBackend = getMeta(this.db, 'backend');
    if (savedBackend && savedBackend !== this.cfg.backend) {
      throw new Error(`anchoring backend changed (${savedBackend} -> ${this.cfg.backend}); a new Space is required`);
    }
    const controller = (this.cfg.controller_address || '').trim();
    const saved = getMeta(this.db, META_CONTROLLER);
    const comparable = (address) => this.cfg.backend === 'evm' ? address.toLowerCase() : address;
    if (saved && controller && comparable(saved) !== comparable(controller)) {
      throw new Error(`controller changed (${saved} -> ${controller}); a new wallet requires a new Space`);
    }
    const binding = this._configBinding(bind);
    const previous = getMeta(this.db, 'identity_binding_v1');
    if (previous && previous !== stableStringify(binding)) {
      throw new Error('anchoring network/program binding changed; a new Space is required');
    }
    // Legacy identities have no historical network pin. Bind their existing
    // EVM configuration once without changing any queued v1 data.
    if ((bind || getMeta(this.db, META_SPACE)) && !previous) {
      this._configBinding(true);
      setMeta(this.db, 'identity_binding_v1', stableStringify(binding));
      setMeta(this.db, 'backend', this.cfg.backend);
    }
    return binding;
  }

  _spaceIdentity() {
    const controller = (this.cfg.controller_address || '').trim();
    if (!controller) return null;
    const binding = this._assertIdentityBinding(true);
    this._validatePersistedIdentity();
    let salt = getMeta(this.db, META_SALT);
    let spaceId = getMeta(this.db, META_SPACE);
    if (!salt) {
      // Stable, path-independent workspace identity: minted once, persisted forever.
      salt = keccakUtf8('awareness-workspace:' + crypto.randomUUID());
      spaceId = this.cfg.backend === 'solana'
        ? deriveSolanaSpaceId(controller, salt)
        : deriveSpaceId(controller, salt);
      setMeta(this.db, META_SALT, salt);
      setMeta(this.db, META_SPACE, spaceId);
      setMeta(this.db, META_CONTROLLER, controller);
    }
    if (!spaceId) throw new Error('incomplete persisted Space identity; existing state was preserved');
    return {controller, salt, spaceId, ...binding};
  }

  _validatePersistedIdentity() {
    const controller = getMeta(this.db, META_CONTROLLER);
    const salt = getMeta(this.db, META_SALT);
    const spaceId = getMeta(this.db, META_SPACE);
    const fields = [controller, salt, spaceId].filter(Boolean).length;
    const seq = getMeta(this.db, META_LAST_SEQ);
    const root = getMeta(this.db, META_LAST_ROOT);
    const hasHistory = this.db.prepare('SELECT 1 FROM anchor_outbox LIMIT 1').get()
      || this.db.prepare('SELECT 1 FROM anchor_state LIMIT 1').get()
      || (seq && seq !== '0') || (root && root !== ZERO32);
    if ((fields > 0 && fields < 3) || (fields === 0 && hasHistory)) {
      throw new Error('incomplete persisted Space identity; existing state was preserved');
    }
    if (!fields) return;
    if (!/^0x[0-9a-fA-F]{64}$/.test(salt) || !/^0x[0-9a-fA-F]{64}$/.test(spaceId)) {
      throw new Error('invalid persisted Space identity; existing state was preserved');
    }
    const expected = this.cfg.backend === 'solana'
      ? deriveSolanaSpaceId(controller, salt)
      : deriveSpaceId(controller, salt);
    if (expected.toLowerCase() !== spaceId.toLowerCase()) {
      throw new Error('persisted Space identity does not match its controller and salt; existing state was preserved');
    }
  }

  /** Build one delta from the current diff, if any. Local only — no chain. */
  buildIfNeeded() {
    if (!this.db?.open) throw new Error('anchoring database is closed');
    let createdWitness = null;
    // IMMEDIATE locks the independent database before reading identity/head or
    // allocating a sequence. Two processes cannot build the same sequence.
    const txn = this.db.transaction(() => {
      const identity = this._spaceIdentity();
      if (!identity) return {built: false, reason: 'controller_address not configured'};
      const snapshot = this._snapshot();
      const ops = this._diff(getStateMap(this.db), snapshot);
      if (ops.length === 0) return {built: false, reason: 'no changes'};

      const seq = Number(getMeta(this.db, META_LAST_SEQ) || 0) + 1;
      if (!Number.isSafeInteger(seq) || seq <= 0) throw new Error('anchoring sequence exceeds the safe integer range');
      const prevRoot = getMeta(this.db, META_LAST_ROOT) || ZERO32;
      const payloadObj = {
        v: 2, standard: 'ERC-8350', space: identity.spaceId,
        profile: CARD_DIGEST_PROFILE_ID, seq, ops,
      };
      const payloadJson = stableStringify(payloadObj);
      const deltaSalt = '0x' + crypto.randomBytes(32).toString('hex');
      const delta = {
        spaceId: identity.spaceId, sequence: seq, prevStateRoot: prevRoot,
        deltaCommitment: computeDeltaCommitment(
          new TextEncoder().encode(payloadJson), deltaSalt, CARD_DIGEST_PROFILE_ID
        ),
        provenanceCommitment: ZERO32, profileId: CARD_DIGEST_PROFILE_ID,
        locatorCommitment: ZERO32,
      };
      const transitionId = computeTransitionId(delta);
      const nextRoot = computeNextStateRoot(prevRoot, transitionId);
      const witnessPath = path.join(
        this.witnessDir,
        `${identity.spaceId.slice(2)}-${CARD_DIGEST_PROFILE_ID.slice(2)}-${seq}-${transitionId.slice(2)}.json`
      );
      const fd = fs.openSync(witnessPath, 'wx', 0o600);
      createdWitness = witnessPath;
      try {
        fs.writeFileSync(fd, JSON.stringify({
          _warning: 'PRIVATE WITNESS — never share or commit. Required to open the on-chain commitment.',
          backend: this.cfg.backend, profileId: CARD_DIGEST_PROFILE_ID,
          seq, payload: payloadJson, delta_salt: deltaSalt, delta,
          transitionId, nextStateRoot: nextRoot, space: identity,
        }, null, 2));
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }

      insertOutbox(this.db, {
        seq,
        space_id: delta.spaceId,
        prev_state_root: delta.prevStateRoot,
        delta_commitment: delta.deltaCommitment,
        provenance_commitment: delta.provenanceCommitment,
        profile_id: delta.profileId,
        locator_commitment: delta.locatorCommitment,
        transition_id: transitionId,
        next_state_root: nextRoot,
        ops_count: ops.length,
        witness_path: witnessPath,
        created_at: new Date().toISOString(),
      });
      applySnapshot(this.db, snapshot, seq);
      setMeta(this.db, META_LAST_SEQ, seq);
      setMeta(this.db, META_LAST_ROOT, nextRoot);
      return {built: true, seq, transitionId, opsCount: ops.length};
    });
    try { return txn.immediate(); }
    catch (err) {
      // Remove only this call's newly created file on transaction rollback.
      // Existing witnesses (including all legacy v1 files) are never replaced.
      if (createdWitness) {
        try { fs.unlinkSync(createdWitness); } catch { /* preserve the original error */ }
      }
      throw err;
    }
  }

  close() {
    if (this.db?.open) this.db.close();
    this.db = null;
  }

  status() {
    const build = this.buildIfNeeded(); // cheap; makes status always current
    const pending = listPending(this.db).map((r) => ({
      seq: r.seq, transitionId: r.transition_id, opsCount: r.ops_count,
      createdAt: r.created_at, witnessPath: r.witness_path,
    }));
    return {
      enabled: true,
      backend: this.cfg.backend,
      projectDir: this.daemon.projectDir || path.dirname(this.daemon.awarenessDir),
      chainId: this.cfg.backend === 'evm' ? this.cfg.chain_id : null,
      registry: this.cfg.backend === 'evm' ? this.cfg.registry_address : null,
      programId: this.cfg.backend === 'solana' ? this.cfg.program_id : null,
      genesisHash: this.cfg.backend === 'solana' ? this.cfg.genesis_hash : null,
      cluster: this.cfg.backend === 'solana' ? this.cfg.cluster || null : null,
      rpcUrl: this.cfg.rpc_url,
      controller: this.cfg.controller_address || null,
      spaceId: getMeta(this.db, META_SPACE),
      spaceSalt: getMeta(this.db, META_SALT),
      lastBuilt: {seq: Number(getMeta(this.db, META_LAST_SEQ) || 0), root: getMeta(this.db, META_LAST_ROOT)},
      lastBuildResult: build,
      pending,
      anchored: countAnchored(this.db),
      estGasPerCommit: this.cfg.backend === 'evm' ? 110000 : null,
    };
  }

  outbox() { return listPending(this.db); }
}

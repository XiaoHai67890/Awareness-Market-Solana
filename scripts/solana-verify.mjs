#!/usr/bin/env node
// Read-only verification. Never loads a wallet, builds deltas, or confirms rows.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import Database from 'better-sqlite3';
import {Connection, PublicKey} from '@solana/web3.js';
import {verifySolanaConfirmation} from '../src/daemon/anchoring/solana-client.mjs';
import {computeCardDigest} from '../src/daemon/anchoring/anchoring.mjs';
import {validateSolanaConfig, validateSolanaRow, hex32, safeInteger,
  deriveSolanaSpaceId, deriveSpacePda, decodeSolanaSpace} from '../src/daemon/anchoring/solana-codec.mjs';
import {computeDeltaCommitment, computeTransitionId, computeNextStateRoot, stableStringify,
  ZERO32} from '../src/daemon/anchoring/erc8350.mjs';

class VerificationError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new VerificationError(code, message); };

/** Checks an opening entirely in memory; errors never contain witness content. */
export function verifyLocalWitness(witness, row, identity) {
  try {
    const r = validateSolanaRow(row, row.space_id), w = witness;
    if (!w || typeof w !== 'object' || Array.isArray(w) || w.backend !== 'solana' ||
        w.seq !== r.seq || hex32(w.profileId) !== r.profile_id || typeof w.payload !== 'string') throw new Error();
    const payload = JSON.parse(w.payload);
    if (![1, 2].includes(payload.v) || payload.standard !== 'ERC-8350' ||
        hex32(payload.space) !== r.space_id || payload.seq !== r.seq ||
        hex32(payload.profile) !== r.profile_id || !Array.isArray(payload.ops) ||
        payload.ops.length !== r.ops_count || stableStringify(payload) !== w.payload) throw new Error();
    const opening = computeDeltaCommitment(new TextEncoder().encode(w.payload), w.delta_salt, w.profileId);
    if (opening !== r.delta_commitment || computeTransitionId(w.delta) !== r.transition_id ||
        computeNextStateRoot(w.delta.prevStateRoot, w.transitionId) !== r.next_state_root ||
        hex32(w.transitionId) !== r.transition_id || hex32(w.nextStateRoot) !== r.next_state_root) throw new Error();
    const d = w.delta;
    const witnessRow = validateSolanaRow({seq: d.sequence, space_id: d.spaceId,
      prev_state_root: d.prevStateRoot, delta_commitment: d.deltaCommitment,
      provenance_commitment: d.provenanceCommitment, profile_id: d.profileId,
      locator_commitment: d.locatorCommitment, transition_id: w.transitionId,
      next_state_root: w.nextStateRoot}, r.space_id);
    for (const field of Object.keys(witnessRow)) if (witnessRow[field] !== r[field]) throw new Error();
    if (w.space?.backend !== 'solana' || hex32(w.space.spaceId) !== r.space_id ||
        deriveSolanaSpaceId(w.space.controller, w.space.salt) !== r.space_id) throw new Error();
    if (identity && (w.space.controller !== identity.controller || hex32(w.space.salt) !== identity.spaceSalt ||
        w.space.programId !== identity.programId || w.space.genesisHash !== identity.genesisHash)) throw new Error();
    return true;
  } catch { fail('WITNESS_INVALID', 'local witness does not match its recorded transition'); }
}

/** Require a complete, already anchored history starting from the zero root. */
export function verifyLocalHistory(rows, {spaceId, lastSeq, lastRoot}) {
  if (!Array.isArray(rows) || rows.length === 0) fail('NO_HISTORY', 'workspace has no anchored transitions');
  if (rows.some(row => row.status === 'pending')) fail('PENDING_TRANSITIONS', 'workspace still has pending transitions');
  try {
    let root = ZERO32;
    for (let i = 0; i < rows.length; i++) {
      const r = validateSolanaRow(rows[i], spaceId);
      if (rows[i].status !== 'anchored' || r.seq !== i + 1 || r.prev_state_root !== root) throw new Error();
      root = r.next_state_root;
    }
    if (safeInteger(lastSeq, 'local sequence', 1) !== rows.length || hex32(lastRoot) !== root) throw new Error();
    return true;
  } catch { fail('HISTORY_INVALID', 'local sequences, roots, or recorded head are inconsistent'); }
}

/** Compare current indexed digest fields with state and replayed witness ops. */
export function verifyCurrentCards({cards, state, rows, witnesses}) {
  try {
    if (![cards, state, rows, witnesses].every(Array.isArray) || rows.length !== witnesses.length) throw new Error();
    const expected = new Map(), profiles = new Map(rows.map(r => [r.seq, r.profile_id]));
    for (let i = 0; i < witnesses.length; i++) {
      verifyLocalWitness(witnesses[i], rows[i]);
      const seen = new Set();
      for (const op of JSON.parse(witnesses[i].payload).ops) {
        if (typeof op.card !== 'string' || !op.card || seen.has(op.card)) throw new Error();
        seen.add(op.card);
        if (op.op === 'removed') {
          if (!expected.has(op.card) || op.hash !== undefined) throw new Error();
          expected.delete(op.card);
        } else {
          if (!['added', 'updated'].includes(op.op) || !/^[0-9a-f]{64}$/.test(op.hash) ||
              (op.op === 'added' ? expected.has(op.card) : !expected.has(op.card))) throw new Error();
          expected.set(op.card, op.hash);
        }
      }
    }
    const current = new Map(cards.map(card => [card.id, card]));
    if (current.size !== cards.length || cards.length !== state.length || state.length !== expected.size) throw new Error();
    const seenState = new Set();
    for (const recorded of state) {
      if (seenState.has(recorded.card_id)) throw new Error();
      seenState.add(recorded.card_id);
      const card = current.get(recorded.card_id), profile = profiles.get(safeInteger(recorded.built_seq, 'card sequence', 1));
      if (!card || !profile || expected.get(recorded.card_id) !== recorded.content_hash ||
          computeCardDigest(card, profile) !== recorded.content_hash) throw new Error();
    }
    return {currentCardCount: cards.length, cardDigestsVerified: true};
  } catch { fail('CARD_DIGEST_MISMATCH', 'current indexed card digests do not match the anchored history; build and flush before verification'); }
}

function readSnapshot(db) {
  return db.transaction(() => ({
    meta: Object.fromEntries(db.prepare('SELECT key, value FROM anchor_meta ORDER BY key').all().map(r => [r.key, r.value])),
    rows: db.prepare('SELECT * FROM anchor_outbox ORDER BY seq').all(),
    state: db.prepare('SELECT card_id, content_hash, built_seq FROM anchor_state ORDER BY card_id').all(),
  })).deferred();
}
function readCards(db) {
  return db.transaction(() => db.prepare(
    "SELECT id, category, title, summary, tags, status FROM knowledge_cards WHERE status IS NULL OR status != 'superseded' ORDER BY id"
  ).all()).deferred();
}

export async function verifyProject(project) {
  let db, indexDb, cards, configFile, witnessDir, originalConfig, cfg, snapshot, identity, lastSeq;
  try {
    const dir = path.join(fs.realpathSync(path.resolve(project)), '.awareness');
    configFile = path.join(dir, 'config.json');
    witnessDir = path.join(dir, 'witness');
    originalConfig = fs.readFileSync(configFile, 'utf8');
    const anchoring = JSON.parse(originalConfig).anchoring;
    if (anchoring?.backend !== 'solana') throw new Error();
    cfg = validateSolanaConfig(anchoring);
    db = new Database(path.join(dir, 'anchoring.sqlite'), {readonly: true, fileMustExist: true});
    snapshot = readSnapshot(db);
    indexDb = new Database(path.join(dir, 'index.db'), {readonly: true, fileMustExist: true});
    cards = readCards(indexDb);
    const m = snapshot.meta, binding = JSON.parse(m.identity_binding_v1);
    identity = {controller: cfg.controller, spaceSalt: hex32(m.space_salt),
      programId: cfg.programId, genesisHash: cfg.genesisHash, spaceId: hex32(m.space_id)};
    if (m.backend !== 'solana' || binding.backend !== 'solana' || binding.programId !== cfg.programId ||
        binding.genesisHash !== cfg.genesisHash || m.controller !== cfg.controller ||
        deriveSolanaSpaceId(identity.controller, identity.spaceSalt) !== identity.spaceId ||
        !/^[1-9][0-9]*$/.test(m.last_seq)) throw new Error();
    lastSeq = safeInteger(Number(m.last_seq), 'local sequence', 1);
  } catch {
    indexDb?.close();db?.close();
    fail('WORKSPACE_INVALID', 'workspace configuration or existing anchoring database is unavailable or inconsistent');
  }
  try {
    verifyLocalHistory(snapshot.rows, {spaceId: identity.spaceId, lastSeq, lastRoot: snapshot.meta.last_root});
    const checkWitnesses = () => {
      const witnesses = [];
      for (const row of snapshot.rows) {
        let witness, fd;
        try {
          // A corrupted DB must not direct this reader to a wallet or another
          // workspace. Witnesses are regular JSON files in this workspace only.
          if (!fs.lstatSync(witnessDir).isDirectory() || typeof row.witness_path !== 'string' ||
              path.extname(row.witness_path) !== '.json' ||
              path.dirname(fs.realpathSync(row.witness_path)) !== fs.realpathSync(witnessDir)) throw new Error();
          fd = fs.openSync(row.witness_path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          if (!fs.fstatSync(fd).isFile()) throw new Error();
          witness = JSON.parse(fs.readFileSync(fd, 'utf8'));
        }
        catch { fail('WITNESS_UNAVAILABLE', 'a required local witness is unavailable or invalid'); }
        finally { if (fd !== undefined) fs.closeSync(fd); }
        verifyLocalWitness(witness, row, identity);
        witnesses.push(witness);
      }
      return witnesses;
    };
    const currentCards = verifyCurrentCards({cards, state: snapshot.state, rows: snapshot.rows, witnesses: checkWitnesses()});
    const transitions = [];
    for (const row of snapshot.rows) {
      let proof;
      try {
        proof = await verifySolanaConfirmation({rpcUrl: cfg.rpcUrl, programId: cfg.programId,
          genesisHash: cfg.genesisHash, spaceId: identity.spaceId, row, txHash: row.tx_hash ?? null});
      } catch { fail('CHAIN_CONFIRMATION_FAILED', `finalized chain confirmation failed for sequence ${row.seq}`); }
      transitions.push({seq: proof.seq, prevStateRoot: row.prev_state_root, transitionId: proof.transitionId,
        nextStateRoot: proof.nextStateRoot, tx: proof.txHash, receipt: proof.receiptAddress, slot: proof.slot,
        confirmationBasis: proof.txHash === null ? 'finalized receipt recovery' : 'finalized transaction and receipt',
        witnessVerified: true});
    }
    const connection = new Connection(cfg.rpcUrl, {commitment: 'finalized', disableRetryOnRateLimit: true,
      fetch: (url, options) => fetch(url, {...options, signal: AbortSignal.timeout(15_000)})});
    const [spacePda] = deriveSpacePda(cfg.programId, identity.spaceId);
    let head;
    try {
      if (await connection.getGenesisHash() !== cfg.genesisHash) throw new Error();
      const account = await connection.getAccountInfo(spacePda, 'finalized');
      if (!account || account.executable || !account.owner.equals(new PublicKey(cfg.programId))) throw new Error();
      head = decodeSolanaSpace(account.data, cfg.programId, identity.spaceId);
      if (head.sequence !== lastSeq || head.stateRoot !== hex32(snapshot.meta.last_root) ||
          head.transitionId !== snapshot.rows.at(-1).transition_id || head.initialController !== identity.controller ||
          head.salt !== identity.spaceSalt || head.controller !== cfg.controller) throw new Error();
    } catch { fail('CHAIN_HEAD_MISMATCH', 'finalized Space head or identity does not match the complete local history'); }
    // A concurrent build/configuration change must not turn a stale snapshot into
    // an apparent success. Witnesses are reopened locally without exposing them.
    if (fs.readFileSync(configFile, 'utf8') !== originalConfig ||
        stableStringify(readSnapshot(db)) !== stableStringify(snapshot) ||
        stableStringify(readCards(indexDb)) !== stableStringify(cards)) {
      fail('WORKSPACE_CHANGED', 'workspace changed during verification; retry once it is stable');
    }
    verifyCurrentCards({cards, state: snapshot.state, rows: snapshot.rows, witnesses: checkWitnesses()});
    return {verified: true, verifiedAt: new Date().toISOString(), commitment: 'finalized',
      programId: cfg.programId, genesisHash: cfg.genesisHash, spaceId: identity.spaceId,
      spacePda: spacePda.toBase58(), sequence: head.sequence, receiptCount: transitions.length,
      stateRoot: head.stateRoot, witnessesVerified: true, ...currentCards, transitions};
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    fail('VERIFICATION_FAILED', 'verification could not complete');
  } finally { indexDb.close();db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const {values} = parseArgs({options: {project: {type: 'string'}, help: {type: 'boolean'}}});
    if (values.help) console.log('node scripts/solana-verify.mjs --project <workspace>');
    else {
      if (!values.project) fail('ARGUMENTS_INVALID', '--project is required');
      console.log(JSON.stringify(await verifyProject(values.project), null, 2));
    }
  } catch (error) {
    const safe = error instanceof VerificationError ? error
      : new VerificationError('VERIFICATION_FAILED', 'verification could not complete');
    console.error(JSON.stringify({verified: false, error: {code: safe.code, message: safe.message}}));
    process.exitCode = 1;
  }
}

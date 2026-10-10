import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {Keypair} from '@solana/web3.js';
import {deriveSolanaSpaceId} from '../src/daemon/anchoring/solana-codec.mjs';
import {computeDeltaCommitment, computeTransitionId, computeNextStateRoot, stableStringify,
  keccakUtf8, ZERO32} from '../src/daemon/anchoring/erc8350.mjs';
import {computeCardDigest} from '../src/daemon/anchoring/anchoring.mjs';
import {verifyLocalWitness, verifyLocalHistory, verifyCurrentCards, verifyProject} from '../scripts/solana-verify.mjs';

// Fixed synthetic openings only; no RPC, real workspace, wallet, or credentials.
const controller = Keypair.fromSeed(Buffer.alloc(32, 7)).publicKey.toBase58();
const spaceSalt = '0x' + '11'.repeat(32), spaceId = deriveSolanaSpaceId(controller, spaceSalt);
const programId = '9RQqnFRPg2z7XNtggHLTnw3sREjwivB88mXZjuMnvxit';
const genesisHash = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const profileId = keccakUtf8('https://awareness.market/profiles/memory/card-digest/v2');
const identity = {controller, spaceSalt, spaceId, programId, genesisHash};
function fixture(seq = 1, prevStateRoot = ZERO32, card, operation = seq === 1 ? 'added' : 'updated') {
  const payload = stableStringify({v: 2, standard: 'ERC-8350', space: spaceId, profile: profileId, seq,
    ops: [{card: card?.id ?? 'public-synthetic-card', hash: card ? computeCardDigest(card, profileId) : String(seq).repeat(64), op: operation}]});
  const deltaSalt = '0x' + '22'.repeat(32);
  const delta = {spaceId, sequence: seq, prevStateRoot,
    deltaCommitment: computeDeltaCommitment(new TextEncoder().encode(payload), deltaSalt, profileId),
    provenanceCommitment: ZERO32, profileId, locatorCommitment: ZERO32};
  const transitionId = computeTransitionId(delta), nextStateRoot = computeNextStateRoot(prevStateRoot, transitionId);
  return {
    row: {seq, space_id: spaceId, prev_state_root: prevStateRoot, delta_commitment: delta.deltaCommitment,
      provenance_commitment: ZERO32, profile_id: profileId, locator_commitment: ZERO32,
      transition_id: transitionId, next_state_root: nextStateRoot, ops_count: 1, status: 'anchored', tx_hash: null},
    witness: {backend: 'solana', profileId, seq, payload, delta_salt: deltaSalt, delta, transitionId, nextStateRoot,
      space: {controller, salt: spaceSalt, spaceId, backend: 'solana', programId, genesisHash}},
  };
}
const clone = value => JSON.parse(JSON.stringify(value));

test('two exact witness openings and the complete continuous local history verify', () => {
  const a = fixture(), b = fixture(2, a.row.next_state_root);
  for (const f of [a, b]) assert.equal(verifyLocalWitness(f.witness, f.row, identity), true);
  assert.equal(verifyLocalHistory([a.row, b.row], {spaceId, lastSeq: 2, lastRoot: b.row.next_state_root}), true);
});

test('witness tampering is rejected without disclosing payload, salt, or paths', () => {
  const {row, witness} = fixture();
  for (const mutate of [
    w => { w.payload = '{"private-secret-marker":'; },
    w => { w.delta_salt = '0x' + '44'.repeat(32); },
    w => { w.seq = 2; },
    w => { w.profileId = ZERO32; },
    w => { w.delta.sequence = 2; },
    w => { w.delta.prevStateRoot = '0x' + '55'.repeat(32); },
    w => { w.delta.spaceId = ZERO32; },
    w => { w.transitionId = ZERO32; },
    w => { w.nextStateRoot = ZERO32; },
    w => { w.space.salt = '0x' + '66'.repeat(32); },
    w => { w.space.programId = controller; },
    w => { w.space.genesisHash = controller; },
  ]) {
    const changed = clone(witness); mutate(changed);
    assert.throws(() => verifyLocalWitness(changed, row, identity), error => {
      assert.equal(error.code, 'WITNESS_INVALID');
      assert.equal(error.message, 'local witness does not match its recorded transition');
      assert.ok(!error.message.includes('private-secret-marker'));return true;
    });
  }
});

test('a self-consistent alternative opening cannot verify a different recorded row', () => {
  const {row, witness} = fixture(), changed = clone(witness);
  const payload = JSON.parse(changed.payload);payload.ops[0].hash = 'a'.repeat(64);
  changed.payload = stableStringify(payload);
  changed.delta.deltaCommitment = computeDeltaCommitment(new TextEncoder().encode(changed.payload),
    changed.delta_salt, changed.profileId);
  changed.transitionId = computeTransitionId(changed.delta);
  changed.nextStateRoot = computeNextStateRoot(changed.delta.prevStateRoot, changed.transitionId);
  assert.throws(() => verifyLocalWitness(changed, row, identity), {code: 'WITNESS_INVALID'});
});

test('pending rows, missing sequences, discontinuous roots, and stale heads cannot pass', () => {
  const a = fixture(), b = fixture(2, a.row.next_state_root);
  const head = {spaceId, lastSeq: 2, lastRoot: b.row.next_state_root};
  assert.throws(() => verifyLocalHistory([a.row, {...b.row, status: 'pending'}], head), {code: 'PENDING_TRANSITIONS'});
  assert.throws(() => verifyLocalHistory([b.row], head), {code: 'HISTORY_INVALID'});
  const unrelated = fixture(2, ZERO32);
  assert.throws(() => verifyLocalHistory([a.row, unrelated.row], {...head, lastRoot: unrelated.row.next_state_root}),
    {code: 'HISTORY_INVALID'});
  assert.throws(() => verifyLocalHistory([a.row, b.row], {...head, lastRoot: a.row.next_state_root}), {code: 'HISTORY_INVALID'});
  assert.throws(() => verifyLocalHistory([a.row, b.row], {...head, lastSeq: 1}), {code: 'HISTORY_INVALID'});
});

test('current indexed cards agree with replayed witnesses even when an unchanged card has a later built_seq', () => {
  const cardA = {id: 'synthetic-a', category: 'decision', title: 'alpha', summary: 'public fixture', tags: '[]', status: 'active'};
  const cardB = {...cardA, id: 'synthetic-b', title: 'beta'};
  const a = fixture(1, ZERO32, cardA), b = fixture(2, a.row.next_state_root, cardB, 'added');
  const state = [cardA, cardB].map(card => ({card_id: card.id, content_hash: computeCardDigest(card), built_seq: 2}));
  assert.deepEqual(verifyCurrentCards({cards: [cardA, cardB], state, rows: [a.row, b.row],
    witnesses: [a.witness, b.witness]}), {currentCardCount: 2, cardDigestsVerified: true});
});

test('unbuilt additions, edits, removals, or a state/index rewrite cannot masquerade as the anchored card snapshot', () => {
  const card = {id: 'synthetic-a', category: 'decision', title: 'alpha', summary: 'public fixture', tags: '[]', status: 'active'};
  const a = fixture(1, ZERO32, card);
  const state = [{card_id: card.id, content_hash: computeCardDigest(card), built_seq: 1}];
  const base = {cards: [card], state, rows: [a.row], witnesses: [a.witness]};
  for (const cards of [[card, {...card, id: 'new-unbuilt-card'}], [{...card, title: 'unbuilt edit'}], []]) {
    assert.throws(() => verifyCurrentCards({...base, cards}), {code: 'CARD_DIGEST_MISMATCH'});
  }
  const changed = {...card, title: 'unbuilt edit'};
  assert.throws(() => verifyCurrentCards({...base, cards: [changed], state: [{...state[0], content_hash: computeCardDigest(changed)}]}),
    {code: 'CARD_DIGEST_MISMATCH'});
});

test('project reader fails pending history before RPC and leaves SQLite/config unchanged', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'awareness-readonly-verification-'));
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
  const dir = path.join(temp, '.awareness');fs.mkdirSync(dir);
  const cfg = {anchoring: {backend: 'solana', rpc_url: 'http://127.0.0.1:1', program_id: programId,
    genesis_hash: genesisHash, controller_address: controller}, cloud: {api_key: 'private-secret-marker'}};
  const configText = JSON.stringify(cfg), filename = path.join(dir, 'anchoring.sqlite');
  fs.writeFileSync(path.join(dir, 'config.json'), configText);
  const {row} = fixture(), db = new Database(filename);
  db.exec('CREATE TABLE anchor_meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE anchor_state ' +
    '(card_id TEXT, content_hash TEXT, built_seq INTEGER); CREATE TABLE anchor_outbox ' +
    '(seq INTEGER, space_id TEXT, prev_state_root TEXT, delta_commitment TEXT, provenance_commitment TEXT, ' +
    'profile_id TEXT, locator_commitment TEXT, transition_id TEXT, next_state_root TEXT, ops_count INTEGER, status TEXT, tx_hash TEXT)');
  const meta = {space_id: spaceId, space_salt: spaceSalt, controller, backend: 'solana', last_seq: '1',
    last_root: row.next_state_root, identity_binding_v1: JSON.stringify({backend: 'solana', programId, genesisHash})};
  for (const [key, value] of Object.entries(meta)) db.prepare('INSERT INTO anchor_meta VALUES (?,?)').run(key, value);
  db.prepare('INSERT INTO anchor_outbox VALUES (@seq,@space_id,@prev_state_root,@delta_commitment,' +
    '@provenance_commitment,@profile_id,@locator_commitment,@transition_id,@next_state_root,@ops_count,@status,@tx_hash)')
    .run({...row, status: 'pending'});
  db.close();const originalDb = fs.readFileSync(filename);
  const indexFile = path.join(dir, 'index.db'), index = new Database(indexFile);
  index.exec('CREATE TABLE knowledge_cards (id TEXT, category TEXT, title TEXT, summary TEXT, tags TEXT, status TEXT)');
  index.close();const originalIndex = fs.readFileSync(indexFile);
  await assert.rejects(verifyProject(temp), error => {
    assert.equal(error.code, 'PENDING_TRANSITIONS');assert.ok(!error.message.includes(temp));
    assert.ok(!error.message.includes('private-secret-marker'));return true;
  });
  assert.deepEqual(fs.readFileSync(filename), originalDb);
  assert.deepEqual(fs.readFileSync(indexFile), originalIndex);
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), configText);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3';
import {Keypair} from '@solana/web3.js';
import {
  AnchoringManager, CARD_DIGEST_PROFILE_ID, CARD_DIGEST_PROFILE_V1_ID, computeCardDigest,
} from '../src/daemon/anchoring/anchoring.mjs';
import {
  ensureAnchorTables, migrateLegacyAnchoring, getMeta, setMeta,
  insertOutbox, listPending, applySnapshot, confirmSeq, countAnchored,
} from '../src/daemon/anchoring/anchor-state.mjs';
import {
  deriveSpaceId, computeTransitionId, computeNextStateRoot, computeDeltaCommitment, ZERO32,
} from '../src/daemon/anchoring/erc8350.mjs';
import {deriveSolanaSpaceId} from '../src/daemon/anchoring/solana-codec.mjs';

const EVM = {
  enabled: true, backend: 'evm', chain_id: 11155111, rpc_url: 'http://unused.invalid',
  registry_address: '0x' + '11'.repeat(20),
  controller_address: '0x3d0ab53241A2913D7939ae02f7083169fE7b823B',
};
const TABLE = 'CREATE TABLE knowledge_cards (id TEXT PRIMARY KEY, category TEXT, title TEXT, summary TEXT, tags TEXT, status TEXT)';
const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function makeEnv(t, cfg = EVM, start = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anchoring-persistence-'));
  const dir = path.join(root, '.awareness');
  fs.mkdirSync(dir);
  const indexFile = path.join(dir, 'index.db');
  const indexDb = new Database(indexFile);
  indexDb.exec(TABLE);
  const daemon = {projectDir: root, awarenessDir: dir, indexer: {db: indexDb}};
  const env = {root, dir, indexFile, indexDb, daemon, cfg, mgr: null};
  t.after(() => {
    env.mgr?.close();
    if (env.indexDb?.open) env.indexDb.close();
    fs.rmSync(root, {recursive: true, force: true});
  });
  if (start) env.mgr = new AnchoringManager(daemon, cfg).ensureInit();
  env.add = (id = 'kc_1', title = 'alpha', summary = 'summary') => env.indexDb.prepare(
    "INSERT INTO knowledge_cards VALUES (?, 'decision', ?, ?, '[]', 'open')"
  ).run(id, title, summary);
  return env;
}

function solanaCfg() {
  return {
    enabled: true, backend: 'solana', rpc_url: 'http://unused.invalid', cluster: 'local-test',
    controller_address: Keypair.generate().publicKey.toBase58(),
    program_id: Keypair.generate().publicKey.toBase58(),
    genesis_hash: Keypair.generate().publicKey.toBase58(),
  };
}

test('private independent database and space/profile/transition-namespaced witness', (t) => {
  const {mgr, dir, root, indexDb, add} = makeEnv(t);
  add();
  mgr.buildIfNeeded();
  const [row] = listPending(mgr.db);
  assert.notEqual(mgr.db, indexDb);
  assert.equal(mgr.db.name, path.join(dir, 'anchoring.sqlite'));
  assert.equal(fs.statSync(mgr.db.name).mode & 0o777, 0o600);
  assert.equal(fs.statSync(row.witness_path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, 'witness')).mode & 0o777, 0o700);
  assert.ok(path.basename(row.witness_path).includes(row.space_id.slice(2)));
  assert.ok(path.basename(row.witness_path).includes(CARD_DIGEST_PROFILE_ID.slice(2)));
  assert.ok(path.basename(row.witness_path).includes(row.transition_id.slice(2)));
  const witness = JSON.parse(fs.readFileSync(row.witness_path, 'utf8'));
  assert.equal(witness.profileId, row.profile_id);
  assert.equal(witness.space.spaceId, row.space_id);
  assert.equal(witness.backend, 'evm');
  assert.equal(mgr.status().projectDir, root);
  assert.equal(indexDb.prepare("SELECT 1 FROM sqlite_master WHERE name='anchor_meta'").get(), undefined);
});

test('rebuilding index.db preserves identity, outbox and witness', (t) => {
  const env = makeEnv(t);
  env.add();
  env.mgr.buildIfNeeded();
  const [row] = listPending(env.mgr.db);
  const witness = fs.readFileSync(row.witness_path, 'utf8');
  const space = getMeta(env.mgr.db, 'space_id');
  env.mgr.close();
  env.indexDb.close();
  fs.unlinkSync(env.indexFile);
  env.indexDb = new Database(env.indexFile);
  env.indexDb.exec(TABLE);
  env.daemon.indexer.db = env.indexDb;
  env.add();
  env.mgr = new AnchoringManager(env.daemon, EVM).ensureInit();
  assert.equal(getMeta(env.mgr.db, 'space_id'), space);
  assert.deepEqual(listPending(env.mgr.db), [row]);
  assert.equal(fs.readFileSync(row.witness_path, 'utf8'), witness);
  assert.equal(env.mgr.buildIfNeeded().built, false);
});

test('legacy v1 migration is atomic, idempotent and retains old witness bytes', (t) => {
  const env = makeEnv(t, EVM, false);
  env.add();
  ensureAnchorTables(env.indexDb);
  const salt = '0x' + '22'.repeat(32);
  const space = deriveSpaceId(EVM.controller_address, salt);
  const card = env.indexDb.prepare('SELECT * FROM knowledge_cards').get();
  const hash = computeCardDigest(card, CARD_DIGEST_PROFILE_V1_ID);
  const payload = JSON.stringify({v: 1, ops: [{card: card.id, hash, op: 'added'}]});
  const delta = {
    spaceId: space, sequence: 1, prevStateRoot: ZERO32,
    deltaCommitment: computeDeltaCommitment(new TextEncoder().encode(payload), salt, CARD_DIGEST_PROFILE_V1_ID),
    provenanceCommitment: ZERO32, profileId: CARD_DIGEST_PROFILE_V1_ID, locatorCommitment: ZERO32,
  };
  const transition = computeTransitionId(delta);
  const next = computeNextStateRoot(ZERO32, transition);
  fs.mkdirSync(path.join(env.dir, 'witness'));
  const witnessPath = path.join(env.dir, 'witness', '1.json');
  const oldWitness = JSON.stringify({delta, payload, delta_salt: salt});
  fs.writeFileSync(witnessPath, oldWitness, {mode: 0o600});
  insertOutbox(env.indexDb, {
    seq: 1, space_id: space, prev_state_root: ZERO32, delta_commitment: delta.deltaCommitment,
    provenance_commitment: ZERO32, profile_id: CARD_DIGEST_PROFILE_V1_ID,
    locator_commitment: ZERO32, transition_id: transition, next_state_root: next,
    ops_count: 1, witness_path: witnessPath, created_at: '2026-10-10T00:00:00.000Z',
  });
  applySnapshot(env.indexDb, [{card_id: card.id, content_hash: hash}], 1);
  for (const [key, value] of Object.entries({space_id: space, space_salt: salt,
    controller: EVM.controller_address, last_seq: '1', last_root: next})) setMeta(env.indexDb, key, value);
  const [legacyRow] = listPending(env.indexDb);
  assert.equal(migrateLegacyAnchoring(env.dir, env.indexDb).migrated, true);
  assert.equal(migrateLegacyAnchoring(env.dir, env.indexDb).migrated, false);
  env.mgr = new AnchoringManager(env.daemon, EVM).ensureInit();
  assert.deepEqual(listPending(env.mgr.db), [legacyRow]);
  assert.deepEqual(listPending(env.indexDb), [legacyRow]);
  assert.equal(env.mgr.buildIfNeeded().seq, 2);
  const [old, current] = listPending(env.mgr.db);
  assert.equal(old.profile_id, CARD_DIGEST_PROFILE_V1_ID);
  assert.equal(current.profile_id, CARD_DIGEST_PROFILE_ID);
  assert.equal(current.prev_state_root, next);
  assert.equal(fs.readFileSync(witnessPath, 'utf8'), oldWitness);
  assert.equal(migrateLegacyAnchoring(env.dir, env.indexDb).migrated, false);
});

test('failed migration leaves original data and destination rows intact', (t) => {
  const env = makeEnv(t, EVM, false);
  env.indexDb.exec('CREATE TABLE anchor_state (card_id TEXT PRIMARY KEY, content_hash TEXT, built_seq INTEGER)');
  ensureAnchorTables(env.indexDb);
  env.indexDb.prepare('INSERT INTO anchor_state VALUES (?, NULL, 1)').run('broken');
  assert.throws(() => migrateLegacyAnchoring(env.dir, env.indexDb), /NOT NULL/);
  assert.equal(env.indexDb.prepare('SELECT content_hash FROM anchor_state').get().content_hash, null);
  const destination = new Database(path.join(env.dir, 'anchoring.sqlite'));
  try {
    assert.equal(destination.prepare('SELECT COUNT(*) AS n FROM anchor_state').get().n, 0);
    assert.equal(getMeta(destination, 'legacy_index_migration_v1'), null);
  } finally { destination.close(); }
});

test('empty legacy tables do not force a fresh Solana identity to EVM', (t) => {
  const cfg = solanaCfg();
  const env = makeEnv(t, cfg, false);
  ensureAnchorTables(env.indexDb);
  assert.equal(migrateLegacyAnchoring(env.dir, env.indexDb).migrated, false);
  env.mgr = new AnchoringManager(env.daemon, cfg).ensureInit();
  env.add();
  env.mgr.buildIfNeeded();
  const status = env.mgr.status();
  assert.equal(status.backend, 'solana');
  assert.equal(status.spaceId, deriveSolanaSpaceId(cfg.controller_address, status.spaceSalt));
  assert.equal(status.programId, cfg.program_id);
  assert.equal(status.genesisHash, cfg.genesis_hash);
  assert.equal(status.chainId, null);
});

test('persistent binding refuses EVM chain/registry and Solana genesis/program changes', (t) => {
  const env = makeEnv(t);
  env.add();
  env.mgr.buildIfNeeded();
  for (const cfg of [
    {...EVM, chain_id: 1}, {...EVM, registry_address: '0x' + '22'.repeat(20)}, solanaCfg(),
  ]) assert.throws(() => new AnchoringManager(env.daemon, cfg).ensureInit(), /new Space/);
  const same = new AnchoringManager(env.daemon, {
    ...EVM, controller_address: EVM.controller_address.toLowerCase(),
  }).ensureInit();
  same.close();
  const cfg = solanaCfg();
  const sol = makeEnv(t, cfg);
  sol.add();
  sol.mgr.buildIfNeeded();
  for (const changed of [
    {...cfg, genesis_hash: Keypair.generate().publicKey.toBase58()},
    {...cfg, program_id: Keypair.generate().publicKey.toBase58()},
  ]) assert.throws(() => new AnchoringManager(sol.daemon, changed).ensureInit(), /new Space/);
  const labelChange = new AnchoringManager(sol.daemon, {...cfg, cluster: 'renamed-label'}).ensureInit();
  labelChange.close();
});

test('partial or mismatched persisted identity is refused without overwriting it', (t) => {
  const env = makeEnv(t);
  env.add();
  env.mgr.buildIfNeeded();
  const originalSpace = getMeta(env.mgr.db, 'space_id');
  env.mgr.db.prepare("DELETE FROM anchor_meta WHERE key='space_salt'").run();
  env.mgr.close();
  assert.throws(() => new AnchoringManager(env.daemon, EVM).ensureInit(), /incomplete/);
  const db = new Database(path.join(env.dir, 'anchoring.sqlite'));
  try {
    assert.equal(getMeta(db, 'space_id'), originalSpace);
    assert.equal(listPending(db).length, 1);
    setMeta(db, 'space_salt', '0x' + '99'.repeat(32));
  } finally { db.close(); }
  assert.throws(() => new AnchoringManager(env.daemon, EVM).ensureInit(), /does not match/);
});

test('v2 detects delimiter-boundary edits as updates', (t) => {
  const env = makeEnv(t);
  env.add('kc_1', 'A\u001fB', 'C');
  env.mgr.buildIfNeeded();
  env.indexDb.prepare("UPDATE knowledge_cards SET title=?, summary=? WHERE id='kc_1'").run('A', 'B\u001fC');
  assert.equal(env.mgr.buildIfNeeded().seq, 2);
  const [row] = listPending(env.mgr.db).filter((entry) => entry.seq === 2);
  const witness = JSON.parse(fs.readFileSync(row.witness_path, 'utf8'));
  assert.equal(JSON.parse(witness.payload).ops[0].op, 'updated');
});

test('one snapshot supplies both the commitment and persisted baseline', (t) => {
  const env = makeEnv(t);
  env.add();
  const snapshot = env.mgr._snapshot.bind(env.mgr);
  let reads = 0;
  env.mgr._snapshot = () => {
    reads++;
    const result = snapshot();
    env.indexDb.prepare("UPDATE knowledge_cards SET title='changed-after-read'").run();
    return result;
  };
  env.mgr.buildIfNeeded();
  assert.equal(reads, 1);
  env.mgr._snapshot = snapshot;
  assert.equal(env.mgr.buildIfNeeded().seq, 2, 'the later mutation must remain visible');
});

test('transaction failure rolls back state and removes only its new witness', (t) => {
  const env = makeEnv(t);
  env.add();
  env.mgr.db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON anchor_outbox BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
  assert.throws(() => env.mgr.buildIfNeeded(), /injected failure/);
  assert.deepEqual(fs.readdirSync(path.join(env.dir, 'witness')), []);
  assert.equal(listPending(env.mgr.db).length, 0);
  assert.equal(getMeta(env.mgr.db, 'space_id'), null);
  env.mgr.db.exec('DROP TRIGGER fail_outbox');
  assert.equal(env.mgr.buildIfNeeded().seq, 1);
});

test('an orphan witness from an interrupted build is retained and does not block retry', (t) => {
  const env = makeEnv(t);
  env.add();
  env.mgr.buildIfNeeded();
  const [first] = listPending(env.mgr.db);
  const originalHash = env.mgr.db.prepare('SELECT content_hash FROM anchor_state').get().content_hash;
  env.indexDb.prepare("UPDATE knowledge_cards SET title='second'").run();
  env.mgr.buildIfNeeded();
  const orphan = listPending(env.mgr.db)[1];
  const orphanBytes = fs.readFileSync(orphan.witness_path, 'utf8');
  // Restore the database state that existed before seq 2 committed; leave the
  // already-fsynced file exactly as a process crash would.
  env.mgr.db.transaction(() => {
    env.mgr.db.prepare('DELETE FROM anchor_outbox WHERE seq=2').run();
    env.mgr.db.prepare('UPDATE anchor_state SET content_hash=?, built_seq=1').run(originalHash);
    setMeta(env.mgr.db, 'last_seq', '1');
    setMeta(env.mgr.db, 'last_root', first.next_state_root);
  }).immediate();
  assert.equal(env.mgr.buildIfNeeded().seq, 2);
  const retry = listPending(env.mgr.db)[1];
  assert.notEqual(retry.witness_path, orphan.witness_path);
  assert.equal(fs.readFileSync(orphan.witness_path, 'utf8'), orphanBytes);
});

test('latest anchored transaction is ordered by sequence, not hash text', (t) => {
  const env = makeEnv(t);
  env.add();
  env.mgr.buildIfNeeded();
  env.indexDb.prepare("UPDATE knowledge_cards SET title='second'").run();
  env.mgr.buildIfNeeded();
  confirmSeq(env.mgr.db, 1, '0x' + 'ff'.repeat(32));
  confirmSeq(env.mgr.db, 2, '0x' + '11'.repeat(32));
  assert.deepEqual(countAnchored(env.mgr.db), {count: 2, lastTxHash: '0x' + '11'.repeat(32)});
});

test('two independent processes serialize sequence allocation', {timeout: 10000}, async (t) => {
  const env = makeEnv(t);
  env.add();
  env.mgr.close();
  const script = `
    import Database from 'better-sqlite3';
    import path from 'node:path';
    import {AnchoringManager} from './src/daemon/anchoring/anchoring.mjs';
    const dir=process.argv[1];
    const db=new Database(path.join(dir,'index.db'));
    const cfg=JSON.parse(process.env.ANCHOR_TEST_CONFIG);
    const mgr=new AnchoringManager({awarenessDir:dir,indexer:{db}},cfg).ensureInit();
    process.send({ready:true});
    process.once('message',()=>{
      try { process.send({result:mgr.buildIfNeeded()}); }
      catch(error) { process.send({error:error.message}); process.exitCode=1; }
      finally { mgr.close(); db.close(); process.disconnect(); }
    });
  `;
  const runs = [0, 1].map(() => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, env.dir], {
      cwd: REPO, env: {...process.env, ANCHOR_TEST_CONFIG: JSON.stringify(EVM)},
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let stderr = '';
    child.stderr.on('data', (bytes) => { stderr += bytes; });
    const ready = new Promise((resolve, reject) => {
      child.on('message', (message) => { if (message.ready) resolve(); });
      child.once('error', reject);
      child.once('exit', (code) => { if (code !== 0) reject(new Error(stderr)); });
    });
    const result = new Promise((resolve, reject) => {
      child.on('message', (message) => {
        if (message.result) resolve(message.result);
        if (message.error) reject(new Error(message.error));
      });
      child.once('error', reject);
      child.once('exit', (code) => { if (code !== 0) reject(new Error(stderr)); });
    });
    return {child, ready, result};
  });
  await Promise.all(runs.map((run) => run.ready));
  runs.forEach((run) => run.child.send({build: true}));
  const results = await Promise.all(runs.map((run) => run.result));
  assert.equal(results.filter((result) => result.built).length, 1);
  env.mgr = new AnchoringManager(env.daemon, EVM).ensureInit();
  assert.equal(listPending(env.mgr.db).length, 1);
  assert.equal(getMeta(env.mgr.db, 'last_seq'), '1');
  assert.equal(fs.readdirSync(path.join(env.dir, 'witness')).length, 1);
});

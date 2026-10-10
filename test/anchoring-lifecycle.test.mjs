import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {AwarenessLocalDaemon} from '../src/daemon.mjs';

const cfg = {
  enabled: true, backend: 'evm', chain_id: 11155111, rpc_url: 'http://unused.invalid',
  registry_address: '0x' + '11'.repeat(20),
  controller_address: '0x3d0ab53241A2913D7939ae02f7083169fE7b823B',
};

function makeHost(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anchoring-lifecycle-'));
  const db = new Database(':memory:');
  db.exec('CREATE TABLE knowledge_cards (id TEXT PRIMARY KEY, category TEXT, title TEXT, summary TEXT, tags TEXT, status TEXT)');
  const host = Object.assign(Object.create(AwarenessLocalDaemon.prototype), {
    projectDir: root, awarenessDir: path.join(root, '.awareness'),
    indexer: {db, close: () => db.close()}, anchoring: null,
    _loadConfig: () => ({anchoring: cfg}), _mcpSessions: new Map(),
  });
  t.after(() => {
    host._closeAnchoring();
    if (db.open) db.close();
    fs.rmSync(root, {recursive: true, force: true});
  });
  return {host, root, db};
}

test('reinitializing closes the old anchor database and uses the new workspace', async (t) => {
  const first = makeHost(t);
  const second = makeHost(t);
  await first.host._initAnchoring();
  first.db.prepare("INSERT INTO knowledge_cards VALUES ('kc_1','decision','alpha','summary','[]','open')").run();
  const oldManager = first.host.anchoring;
  const oldDb = oldManager.db;
  const oldSpace = oldManager.status().spaceId;
  first.host.projectDir = second.root;
  first.host.awarenessDir = second.host.awarenessDir;
  first.host.indexer = {db: second.db, close: () => second.db.close()};
  await first.host._initAnchoring();
  assert.equal(oldDb.open, false);
  assert.equal(oldManager.db, null);
  assert.notEqual(first.host.anchoring, oldManager);
  second.db.prepare("INSERT INTO knowledge_cards VALUES ('kc_2','decision','beta','summary','[]','open')").run();
  const current = first.host.anchoring.status();
  assert.equal(current.projectDir, second.root);
  assert.notEqual(current.spaceId, oldSpace);
  assert.equal(current.lastBuilt.seq, 1);
  assert.equal(first.host.anchoring.db.name, path.join(second.root, '.awareness', 'anchoring.sqlite'));
});

test('disabling anchoring closes its existing manager', async (t) => {
  const {host} = makeHost(t);
  await host._initAnchoring();
  const db = host.anchoring.db;
  host._loadConfig = () => ({anchoring: {...cfg, enabled: false}});
  await host._initAnchoring();
  assert.equal(host.anchoring, null);
  assert.equal(db.open, false);
});

test('stop closes independent anchoring before its index source', async (t) => {
  const {host, db} = makeHost(t);
  await host._initAnchoring();
  const anchorDb = host.anchoring.db;
  let indexClosed = false;
  host.indexer.close = () => {
    assert.equal(anchorDb.open, false);
    db.close();
    indexClosed = true;
  };
  await host.stop();
  assert.equal(indexClosed, true);
  assert.equal(host.anchoring, null);
  assert.equal(host.indexer, null);
});

test('a pending async initialization cannot resurrect a closed manager', async (t) => {
  const {host} = makeHost(t);
  const initialization = host._initAnchoring();
  host._closeAnchoring();
  await initialization;
  assert.equal(host.anchoring, null);
  assert.equal(fs.existsSync(path.join(host.awarenessDir, 'anchoring.sqlite')), false);
});

test('a pending initialization cannot carry old config into another workspace', async (t) => {
  const {host, root} = makeHost(t);
  const initialization = host._initAnchoring();
  host.awarenessDir = path.join(root, 'another-workspace');
  await initialization;
  assert.equal(host.anchoring, null);
  assert.equal(fs.existsSync(path.join(host.awarenessDir, 'anchoring.sqlite')), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Keypair} from '@solana/web3.js';
import Database from 'better-sqlite3';
import {runAnchor} from '../src/daemon/anchoring/cli.mjs';

const exec = promisify(execFile);
test('CLI checks the selected workspace and surfaces daemon HTTP failures', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-cli-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  let statusCode = 200;
  let body = {enabled: true, projectDir: path.dirname(dir)};
  const server = http.createServer((req, res) => {
    res.writeHead(statusCode, {'Content-Type': 'application/json'}); res.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const flags = {project: dir, port: server.address().port};
  await assert.rejects(runAnchor({flags, sub: 'flush'}), /different workspace/);
  body = {error: 'test verification failure'}; statusCode = 422;
  await assert.rejects(runAnchor({flags, sub: 'status'}), /test verification failure/);
});

test('CLI refuses workspace changes between status and outbox and never signs an empty queue', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-cli-race-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const projectDir = fs.realpathSync(dir);
  const status = {enabled: true, backend: 'evm', projectDir, spaceId: 'test-space', controller: 'test-controller',
    pending: [{seq: 1}], chainId: 31337, registry: 'test-registry'};
  let switched = true;
  const server = http.createServer((req, res) => {
    const body = req.url.endsWith('/status') ? status : {...status, pending: [],
      projectDir: switched ? path.dirname(projectDir) : projectDir};
    res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const args = {flags: {project: dir, port: server.address().port}, sub: 'flush',
    promptHidden: () => assert.fail('an empty/switched queue must never request a key'), log: () => {}};
  await assert.rejects(runAnchor(args), /changed while reading outbox/);
  switched = false;
  await runAnchor(args);
});

test('Solana configure pins a local cluster, preserves other config, and rejects identity replacement', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solana-config-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const awareness = path.join(dir, '.awareness'); fs.mkdirSync(awareness);
  const configFile = path.join(awareness, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({daemon: {port: 39000}, marker: 'preserve'}));
  const program = Keypair.generate().publicKey.toBase58();
  const controller = Keypair.generate().publicKey.toBase58();
  const genesis = Keypair.generate().publicKey.toBase58();
  let changeDuringRpc = false;
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const {id, method} = JSON.parse(text);
    if (changeDuringRpc && method === 'getAccountInfo') {
      const changed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      changed.marker = 'concurrent update';
      fs.writeFileSync(configFile, JSON.stringify(changed));
    }
    const result = method === 'getGenesisHash' ? genesis : {context: {slot: 1}, value: {
      executable: true, owner: 'BPFLoaderUpgradeab1e11111111111111111111111', lamports: 1, rentEpoch: 0, data: ['', 'base64'],
    }};
    res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify({jsonrpc: '2.0', id, result}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const script = new URL('../scripts/solana-configure.mjs', import.meta.url).pathname;
  const args = [script, '--project', dir, '--program-id', program, '--controller', controller,
    '--cluster', 'localnet', '--rpc', `http://127.0.0.1:${server.address().port}`];
  await exec(process.execPath, args);
  const configured = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(configured.marker, 'preserve'); assert.equal(configured.daemon.port, 39000);
  assert.equal(configured.anchoring.genesis_hash, genesis);
  assert.equal(configured.anchoring.program_id, program);
  assert.equal(configured.anchoring.backend, 'solana');
  changeDuringRpc = true;
  await assert.rejects(exec(process.execPath, args), /configuration changed during RPC/);
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).marker, 'concurrent update');
  changeDuringRpc = false;
  fs.writeFileSync(configFile, JSON.stringify(configured));
  const db = new Database(path.join(awareness, 'anchoring.sqlite'));
  db.exec("CREATE TABLE anchor_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO anchor_meta VALUES('space_id','existing-space')"); db.close();
  const changed = [...args]; changed[changed.indexOf('--controller') + 1] = Keypair.generate().publicKey.toBase58();
  await assert.rejects(exec(process.execPath, changed), /different or incomplete anchoring identity/);
  // Matching JSON settings cannot bypass a different durable database identity.
  await assert.rejects(exec(process.execPath, args), /different or incomplete anchoring identity/);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), configured);
});

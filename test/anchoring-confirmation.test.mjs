import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Database from 'better-sqlite3';
import {handleAnchorRoute} from '../src/daemon/anchor-api-handlers.mjs';
import {ensureAnchorTables, insertOutbox} from '../src/daemon/anchoring/anchor-state.mjs';
import {computeTransitionId, computeNextStateRoot, ZERO32} from '../src/daemon/anchoring/erc8350.mjs';
import {encodeCommitTransition} from '../src/daemon/anchoring/registry-abi.mjs';
import {verifyEvmConfirmation} from '../src/daemon/anchoring/evm-confirmation.mjs';
import {flushOutbox} from '../src/daemon/anchoring/flush.mjs';
import {addressFromPrivateKey} from '../src/daemon/anchoring/eth-tx.mjs';

const hex = (c) => '0x' + c.repeat(64);
const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const registry = '0x' + '11'.repeat(20);
const txHash = hex('b');
const KEY = '0x' + '01'.repeat(32); // test-only deterministic key, never funded externally
function row() {
  const d = {spaceId: hex('1'), sequence: 1, prevStateRoot: ZERO32,
    deltaCommitment: hex('2'), provenanceCommitment: ZERO32,
    profileId: hex('3'), locatorCommitment: ZERO32};
  const id = computeTransitionId(d);
  return {seq: 1, space_id: d.spaceId, prev_state_root: ZERO32, delta_commitment: d.deltaCommitment,
    provenance_commitment: ZERO32, profile_id: d.profileId, locator_commitment: ZERO32,
    transition_id: id, next_state_root: computeNextStateRoot(ZERO32, id),
    ops_count: 1, witness_path: '/unused-test-witness', created_at: new Date().toISOString()};
}
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('confirmation independently verifies exact chain content and refuses browser/foreign workspace claims', async (t) => {
  const r = row();
  let matching = false;
  let failedTx = false;
  let rpcCalls = 0;
  const controller = addressFromPrivateKey(KEY);
  const rpc = http.createServer(async (req, res) => {
    rpcCalls++;
    let text = ''; for await (const chunk of req) text += chunk;
    const {id, method, params} = JSON.parse(text);
    let result;
    if (method === 'eth_chainId') result = '0x7a69';
    else if (method === 'eth_call') {
      const data = params[0].data;
      const {SEL_HEAD, SEL_SPACE_AUTHORIZATION} = await import('../src/daemon/anchoring/registry-abi.mjs');
      if (data.startsWith(SEL_HEAD)) result = r.transition_id + r.next_state_root.slice(2) + word(3);
      else if (data.startsWith(SEL_SPACE_AUTHORIZATION)) result = '0x' + controller.slice(2).toLowerCase().padStart(64, '0').repeat(2) + word(0);
      else result = (matching ? r.space_id : ZERO32) + r.next_state_root.slice(2) + word(1) + word(123);
    } else if (method === 'eth_getTransactionReceipt') result = {status: failedTx ? '0x0' : '0x1', to: registry, blockHash: hex('c'), blockNumber: '0x1'};
    else if (method === 'eth_getTransactionByHash') result = {to: registry, input: encodeCommitTransition(r)};
    else if (method === 'eth_getBlockByNumber') result = {hash: hex('c')};
    else throw new Error(`unexpected method ${method}`);
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({jsonrpc: '2.0', id, result}));
  });
  const rpcUrl = await listen(rpc); t.after(() => rpc.close());
  const db = new Database(':memory:'); ensureAnchorTables(db); insertOutbox(db, r); t.after(() => db.close());
  const mgr = {db, cfg: {backend: 'evm', chain_id: 31337, registry_address: registry, rpc_url: rpcUrl}};
  const daemon = {anchoring: mgr, projectDir: process.cwd()};
  const api = http.createServer((req, res) => handleAnchorRoute(daemon, req, res, '/anchor/confirm'));
  const base = await listen(api); t.after(() => api.close());
  const post = (body = {}, headers = {}) => fetch(base, {method: 'POST', headers: {'Content-Type': 'application/json', ...headers},
    body: JSON.stringify({seq: 1, project_dir: process.cwd(), space_id: r.space_id, transition_id: r.transition_id, tx_hash: txHash, ...body})});
  assert.equal((await post({}, {Origin: 'https://untrusted.example'})).status, 403);
  assert.equal((await post({}, {'Content-Type': 'text/plain'})).status, 415);
  assert.equal(rpcCalls, 0);
  assert.equal((await post({project_dir: '/different-workspace'})).status, 409);
  assert.equal((await post({space_id: hex('f')})).status, 409);
  assert.equal((await post()).status, 422, 'fabricated success must leave row pending');
  assert.equal(db.prepare('SELECT status FROM anchor_outbox').get().status, 'pending');
  await assert.rejects(flushOutbox({rpcUrl, chainId: 31337, registry, privKeyHex: KEY, controller,
    spaceId: r.space_id, spaceSalt: ZERO32, rows: [r], onConfirm: () => assert.fail('must not confirm conflicting history')}), /no matching/);
  matching = true; failedTx = true;
  assert.equal((await post()).status, 422, 'failed transaction is rejected');
  failedTx = false;
  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 409, 'already confirmed does not mutate again');
  assert.equal(db.prepare('SELECT status FROM anchor_outbox').get().status, 'anchored');
  await verifyEvmConfirmation({rpcUrl, chainId: 31337, registry, spaceId: r.space_id, row: r, txHash: null});
  await assert.rejects(verifyEvmConfirmation({rpcUrl, chainId: 31337, registry, spaceId: r.space_id,
    row: {...r, delta_commitment: hex('e')}, txHash: null}), /commitment\/root mismatch/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {Keypair, PublicKey, Transaction} from '@solana/web3.js';
import {computeTransitionId, computeNextStateRoot, ZERO32} from '../src/daemon/anchoring/erc8350.mjs';
import {
  deriveSolanaSpaceId, deriveSpacePda, deriveReceiptPda, bytes32, u64le,
  SPACE_DISCRIMINATOR, RECEIPT_DISCRIMINATOR, SPACE_ACCOUNT_SIZE, RECEIPT_ACCOUNT_SIZE,
  validateSolanaConfig, validateSolanaPublicKey, validateSolanaRow, decodeBase58, encodeBase58,
  encodeRegisterSpace, encodeCommitTransition, encodeSetAuthorization, createRegisterSpaceInstruction,
  decodeSolanaSpace, decodeSolanaReceipt, createCommitTransitionInstruction,
} from '../src/daemon/anchoring/solana-codec.mjs';
import {flushSolanaOutbox, verifySolanaConfirmation} from '../src/daemon/anchoring/solana-client.mjs';

// Deterministic, public test keys; no wallet files or external network requests.
const controllerKey = Keypair.fromSeed(Buffer.alloc(32, 7));
const authorizerKey = Keypair.fromSeed(Buffer.alloc(32, 8));
const controller = controllerKey.publicKey.toBase58();
const programId = '8a7xdYvy49bBQUE3ycPyjLowg5m5czxQ2YReSEG6RHWA';
const genesisHash = Keypair.fromSeed(Buffer.alloc(32, 9)).publicKey.toBase58();
const blockhash = Keypair.fromSeed(Buffer.alloc(32, 10)).publicKey.toBase58();
const salt = '0x' + '11'.repeat(32);
const spaceId = deriveSolanaSpaceId(controller, salt);
function makeRow(seq = 1, prev = ZERO32) {
  const r = {seq, space_id: spaceId, prev_state_root: prev, delta_commitment: '0x'+'22'.repeat(32),
    provenance_commitment: ZERO32, profile_id: '0x'+'33'.repeat(32), locator_commitment: ZERO32, ops_count: 1};
  r.transition_id = computeTransitionId({spaceId, sequence: seq, prevStateRoot: prev,
    deltaCommitment: r.delta_commitment, provenanceCommitment: ZERO32,
    profileId: r.profile_id, locatorCommitment: ZERO32});
  r.next_state_root = computeNextStateRoot(prev, r.transition_id);
  return r;
}
function spaceData(head = {}) {
  return Buffer.concat([SPACE_DISCRIMINATOR, Buffer.from([1, deriveSpacePda(programId, spaceId)[1]]),
    bytes32(spaceId), controllerKey.publicKey.toBuffer(), bytes32(salt),
    new PublicKey(head.controller ?? controller).toBuffer(), new PublicKey(head.authorizer ?? controller).toBuffer(),
    u64le(head.sequence ?? 0), u64le(head.configNonce ?? 0),
    bytes32(head.transitionId ?? ZERO32), bytes32(head.stateRoot ?? ZERO32)]);
}
function receiptData(row, authorizer = controller, slot = 42) {
  return Buffer.concat([RECEIPT_DISCRIMINATOR, Buffer.from([1, deriveReceiptPda(programId, spaceId, row.seq)[1]]),
    bytes32(spaceId), u64le(row.seq), ...['prev_state_root','delta_commitment','provenance_commitment',
      'profile_id','locator_commitment','transition_id','next_state_root'].map(f => bytes32(row[f])),
    new PublicKey(authorizer).toBuffer(), u64le(slot)]);
}
const account = (data, owner = programId, executable = false) => ({data: [data.toString('base64'), 'base64'],
  executable, lamports: 1_000_000, owner, rentEpoch: 0});
function transactionJson(tx, slot) {
  const m = tx.compileMessage();
  return {slot, blockTime: 1, version: 'legacy', meta: {err: null, fee: 5000,
    preBalances: m.accountKeys.map(()=>1_000_000), postBalances:m.accountKeys.map(()=>1_000_000),
    innerInstructions:[],logMessages:[],preTokenBalances:[],postTokenBalances:[],rewards:[],
    loadedAddresses:{writable:[],readonly:[]}}, transaction:{signatures:tx.signatures.map(s=>encodeBase58(s.signature)),
      message:{header:m.header,accountKeys:m.accountKeys.map(k=>k.toBase58()),recentBlockhash:m.recentBlockhash,
        instructions:m.instructions}}};
}
async function withRpc(fn, initial = {}) {
  const state = {head:{}, receipt:null, slot:42, requests:[], transactions:new Map(), ...initial};
  const server = http.createServer(async (req, res) => {
    let body='';for await(const chunk of req)body+=chunk;
    const call=JSON.parse(body);state.requests.push(call);
    let result;
    try {
      if(call.method==='getGenesisHash')result=state.genesisHash??genesisHash;
      else if(call.method==='getAccountInfo') {
        const addr=call.params[0];let value=null;
        if(addr===programId)value=state.programMissing?null:account(Buffer.alloc(0),'BPFLoaderUpgradeab1e11111111111111111111111',state.programExecutable??true);
        else if(addr===deriveSpacePda(programId,spaceId)[0].toBase58())value=state.head===null?null:account(
          state.spaceBytes??spaceData(state.head),state.spaceOwner??programId);
        else if(addr===deriveReceiptPda(programId,spaceId,1)[0].toBase58())value=state.receipt?account(
          state.receipt,state.receiptOwner??programId):null;
        result={context:{slot:state.slot},value};
      } else if(call.method==='getSignatureStatuses')result={context:{slot:state.slot},value:[{
        slot:state.slot,confirmations:null,err:state.transactionErr??null,confirmationStatus:state.finality??'finalized'}]};
      else if(call.method==='getTransaction')result=state.transactionOverride??state.transactions.get(call.params[0])??null;
      else if(call.method==='getLatestBlockhash')result={context:{slot:state.slot},value:{blockhash,lastValidBlockHeight:state.lastValidBlockHeight??1000}};
      else if(call.method==='getBlockHeight')result=100;
      else if(call.method==='sendTransaction') {
        const tx=Transaction.from(Buffer.from(call.params[0],'base64'));
        const ix=tx.instructions[0];const txHash=encodeBase58(tx.signature);
        if(ix.data.subarray(0,8).equals(encodeRegisterSpace(spaceId,salt,controller).subarray(0,8))) {
          state.head={};
        } else {
          const row=makeRow();state.head={sequence:1,transitionId:row.transition_id,stateRoot:row.next_state_root,
            authorizer:state.head.authorizer??controller};
          state.receipt=receiptData(row,state.head.authorizer,state.slot);
        }
        state.transactions.set(txHash,transactionJson(tx,state.slot));
        if(state.afterSend)state.afterSend(state,tx);
        result=state.wrongReturnedSignature??txHash;
      } else throw new Error('unexpected RPC method '+call.method);
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:call.id,result}));
    } catch(e) {res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:call.id,
      error:{code:-32000,message:e.message}}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const rpcUrl=`http://127.0.0.1:${server.address().port}`;
  try{return await fn({rpcUrl,state});}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
function confirmation(rpcUrl,row=makeRow(),txHash=null) {
  return verifySolanaConfirmation({rpcUrl,programId,genesisHash,spaceId,row,txHash});
}
function flush(rpcUrl,onConfirm,keypair=controllerKey) {
  return flushSolanaOutbox({rpcUrl,programId,genesisHash,spaceId,spaceSalt:salt,controller,
    keypair,rows:[makeRow()],onConfirm});
}

test('Solana Space domain, PDA and account layout stay fixed',()=>{
  assert.equal(spaceId,'0x2b10fa2b5154c831bff6e036d1e683cf1e817d4763e910f20f64cd1778ed85e0');
  assert.equal(spaceData().length,SPACE_ACCOUNT_SIZE);assert.equal(receiptData(makeRow()).length,RECEIPT_ACCOUNT_SIZE);
  assert.equal(decodeSolanaSpace(spaceData(),programId,spaceId).controller,controller);
  assert.equal(decodeSolanaReceipt(receiptData(makeRow()),programId,spaceId,1).transitionId,makeRow().transition_id);
  assert.equal(encodeRegisterSpace(spaceId,salt,controller).length,104);
  assert.equal(encodeCommitTransition(makeRow()).length,176);
  assert.equal(encodeSetAuthorization(controller,authorizerKey.publicKey,1).length,80);
  assert.deepEqual(decodeBase58(encodeBase58(Buffer.alloc(176,1))),Buffer.alloc(176,1));
});
test('JS wire bytes and PDA accounts match Rust Anchor-generated ABI fixtures',()=>{
  const fixture=JSON.parse(fs.readFileSync(new URL('../contracts/solana/fixtures/abi-v1.json',import.meta.url),'utf8'));
  const r={seq:Number(fixture.sequence),space_id:fixture.spaceId,prev_state_root:fixture.prevStateRoot,
    delta_commitment:fixture.deltaCommitment,provenance_commitment:fixture.provenanceCommitment,
    profile_id:fixture.profileId,locator_commitment:fixture.locatorCommitment,
    transition_id:fixture.transitionId,next_state_root:fixture.nextStateRoot};
  assert.equal(deriveSolanaSpaceId(fixture.controller,fixture.salt),fixture.spaceId);
  const register=createRegisterSpaceInstruction({programId:fixture.programId,payer:fixture.payer,
    controller:fixture.controller,spaceId:fixture.spaceId,spaceSalt:fixture.salt,authorizer:fixture.authorizer});
  const commit=createCommitTransitionInstruction({programId:fixture.programId,payer:fixture.payer,
    authorizer:fixture.authorizer,spaceId:fixture.spaceId,row:r});
  for(const [ix,name] of [[register,'registerSpace'],[commit,'commitTransition']]) {
    assert.equal('0x'+ix.data.toString('hex'),fixture.instructions[name].data);
    assert.deepEqual(ix.keys.map(k=>({...k,pubkey:k.pubkey.toBase58()})),fixture.instructions[name].accounts);
  }
  assert.equal('0x'+encodeSetAuthorization(fixture.controller,fixture.authorizer,1).toString('hex'),
    fixture.instructions.setAuthorization.data);
  assert.equal(decodeSolanaSpace(Buffer.from(fixture.accounts.space.data.slice(2),'hex'),fixture.programId,
    fixture.spaceId).stateRoot,fixture.nextStateRoot);
  assert.equal(decodeSolanaReceipt(Buffer.from(fixture.accounts.receipt.data.slice(2),'hex'),fixture.programId,
    fixture.spaceId,1).nextStateRoot,fixture.nextStateRoot);
});
test('public keys, config, hashes and sequence reject ambiguous or unsafe inputs',()=>{
  for(const v of ['', '0x'+'11'.repeat(20),controller+' ','11111111111111111111111111111111']) {
    assert.throws(()=>validateSolanaPublicKey(v));
  }
  for(const rpc_url of ['file:///tmp/x','https://user:pass@example.org','https://example.org/#secret']) {
    assert.throws(()=>validateSolanaConfig({rpc_url,program_id:programId,genesis_hash:genesisHash}));
  }
  for(const seq of [0,-1,1.2,Number.MAX_SAFE_INTEGER+1,'1'])assert.throws(()=>validateSolanaRow({...makeRow(),seq},spaceId));
  assert.throws(()=>validateSolanaRow({...makeRow(),delta_commitment:'0x'+'gg'.repeat(32)},spaceId));
  assert.throws(()=>validateSolanaRow({...makeRow(),transition_id:ZERO32},spaceId),/transition ID/);
  assert.throws(()=>validateSolanaRow({...makeRow(),next_state_root:ZERO32},spaceId),/next state root/);
  const corrupt=spaceData();corrupt[8]=2;assert.throws(()=>decodeSolanaSpace(corrupt,programId,spaceId),/version/);
  const bump=receiptData(makeRow());bump[9]^=1;assert.throws(()=>decodeSolanaReceipt(bump,programId,spaceId,1),/PDA/);
  assert.throws(()=>decodeSolanaSpace(Buffer.concat([spaceData(),Buffer.from([0])]),programId,spaceId),/length/);
  const unsafe=spaceData();unsafe.writeBigUInt64LE(2n**63n,170);assert.throws(()=>decodeSolanaSpace(unsafe,programId,spaceId),/safe integer/);
});
test('confirmation reconciles an exact immutable receipt after head advancement',async()=>{
  await withRpc(async({rpcUrl,state})=>{
    const proof=await confirmation(rpcUrl);assert.equal(proof.confirmed,true);assert.equal(proof.txHash,null);
    assert.equal(state.requests.every(r=>!r.params||!JSON.stringify(r.params).includes(controllerKey.secretKey.toString())),true);
    assert.equal(state.requests.some(r=>r.method==='getSignatureStatuses'),false);
  },{head:{sequence:4,stateRoot:'0x'+'44'.repeat(32)},receipt:receiptData(makeRow())});
});
for(const [name,initial,pattern] of [
  ['wrong genesis',{genesisHash:controller},/genesis/],
  ['non-executable program',{programExecutable:false},/executable/],
  ['missing program',{programMissing:true},/absent/],
  ['wrong Space owner',{spaceOwner:controller},/owner/],
  ['wrong receipt owner',{receiptOwner:controller},/owner/],
  ['wrong Space discriminator',{spaceBytes:Buffer.alloc(SPACE_ACCOUNT_SIZE)},/discriminator/],
  ['wrong receipt discriminator',{receipt:Buffer.alloc(RECEIPT_ACCOUNT_SIZE)},/discriminator/],
  ['head advanced without receipt',{receipt:null,head:{sequence:8}},/Receipt is absent/],
  ['conflicting exact sequence receipt',{receipt:receiptData({...makeRow(),transition_id:ZERO32})},/transitionId/],
  ['conflicting receipt root',{receipt:receiptData({...makeRow(),next_state_root:ZERO32})},/nextStateRoot/],
])test('confirmation refuses '+name,async()=>{
  await withRpc(async({rpcUrl})=>assert.rejects(confirmation(rpcUrl),pattern),
    {head:{sequence:1,transitionId:makeRow().transition_id,stateRoot:makeRow().next_state_root},
      receipt:receiptData(makeRow()),...initial});
});
test('confirmation requires exact transaction program, instruction, signer and slot',async()=>{
  const tx=new Transaction({feePayer:controllerKey.publicKey,recentBlockhash:blockhash})
    .add(createCommitTransitionInstruction({programId,payer:controllerKey.publicKey,authorizer:controller,
      spaceId,row:makeRow()}));tx.sign(controllerKey);const txHash=encodeBase58(tx.signature);
  const good=transactionJson(tx,42);
  const base={head:{sequence:1,transitionId:makeRow().transition_id,stateRoot:makeRow().next_state_root},
    receipt:receiptData(makeRow()),transactionOverride:good};
  await withRpc(async({rpcUrl})=>assert.equal((await confirmation(rpcUrl,makeRow(),txHash)).txHash,txHash),base);
  for(const change of [{finality:'confirmed'},{transactionErr:{InstructionError:[0,'Custom']}},
    {transactionOverride:{...good,slot:43}},
    {receipt:receiptData(makeRow(),authorizerKey.publicKey.toBase58())},
    {transactionOverride:{...good,transaction:{...good.transaction,message:{...good.transaction.message,
      accountKeys:good.transaction.message.accountKeys.map((key,index)=>
        index===good.transaction.message.instructions[0].programIdIndex?authorizerKey.publicKey.toBase58():key)}}}},
    {transactionOverride:{...good,transaction:{...good.transaction,message:{...good.transaction.message,
      accountKeys:good.transaction.message.accountKeys.map((key,index)=>
        index===good.transaction.message.instructions[0].accounts[3]?authorizerKey.publicKey.toBase58():key)}}}},
    {transactionOverride:{...good,transaction:{...good.transaction,message:{...good.transaction.message,
      instructions:[{...good.transaction.message.instructions[0],data:encodeBase58(Buffer.alloc(176))}]}}}},
  ])await withRpc(async({rpcUrl})=>assert.rejects(confirmation(rpcUrl,makeRow(),txHash)),{...base,...change});
});
test('flush registers, commits, verifies and confirms; retry uses immutable receipt',async()=>{
  await withRpc(async({rpcUrl,state})=>{
    const confirmations=[];const results=await flush(rpcUrl,async(seq,tx)=>confirmations.push({seq,tx}));
    assert.equal(results[0].skipped,false);assert.equal(confirmations.length,1);assert.ok(confirmations[0].tx);
    const before=state.requests.filter(r=>r.method==='sendTransaction').length;
    const again=await flush(rpcUrl,async(seq,tx)=>confirmations.push({seq,tx}));
    assert.equal(again[0].skipped,true);assert.equal(confirmations[1].tx,null);
    assert.equal(state.requests.filter(r=>r.method==='sendTransaction').length,before);
    const rawRequests=JSON.stringify(state.requests);
    assert.equal(rawRequests.includes(Buffer.from(controllerKey.secretKey).toString('base64')),false);
  },{head:null});
});
test('an empty Solana outbox is a no-op before any RPC or Space registration',async()=>{
  await withRpc(async({rpcUrl,state})=>{
    const result=await flushSolanaOutbox({rpcUrl,programId,genesisHash,spaceId,spaceSalt:salt,controller,
      keypair:controllerKey,rows:[],onConfirm:async()=>assert.fail('empty queue must not confirm'),
      log:()=>assert.fail('empty queue must not register')});
    assert.deepEqual(result,[]);assert.equal(state.requests.length,0);assert.equal(state.head,null);
  },{head:null});
});
test('an existing Space permits a distinct authorized signing key',async()=>{
  await withRpc(async({rpcUrl})=>{
    let count=0;await flush(rpcUrl,async()=>count++,authorizerKey);assert.equal(count,1);
  },{head:{authorizer:authorizerKey.publicKey.toBase58()}});
});
test('flush refuses mismatched authority and conflicting receipts without confirmation',async()=>{
  await withRpc(async({rpcUrl,state})=>{
    let count=0;await assert.rejects(flush(rpcUrl,async()=>count++,authorizerKey),/authorizer/);
    assert.equal(count,0);assert.equal(state.requests.some(r=>r.method==='sendTransaction'),false);
  });
  await withRpc(async({rpcUrl})=>{
    let count=0;await assert.rejects(flush(rpcUrl,async()=>count++),/transitionId/);assert.equal(count,0);
  },{head:{sequence:4},receipt:receiptData({...makeRow(),transition_id:ZERO32})});
});
test('flush rejects invalid rows before network and a malicious send signature',async()=>{
  await assert.rejects(flushSolanaOutbox({rpcUrl:'http://127.0.0.1:1',programId,genesisHash,spaceId,
    spaceSalt:salt,controller,keypair:controllerKey,rows:[{...makeRow(),seq:1.5}],onConfirm:async()=>{}}),/safe integer/);
  await withRpc(async({rpcUrl})=>{
    let count=0;await assert.rejects(flush(rpcUrl,async()=>count++),/different from the signed/);assert.equal(count,0);
  },{wrongReturnedSignature:encodeBase58(Buffer.alloc(64,9))});
});
test('flush rejects sequence gaps and does not submit a new Space with the wrong key',async()=>{
  await withRpc(async({rpcUrl,state})=>{
    await assert.rejects(flushSolanaOutbox({rpcUrl,programId,genesisHash,spaceId,spaceSalt:salt,controller,
      keypair:controllerKey,rows:[makeRow(2)],onConfirm:async()=>{assert.fail('must not confirm');}}),/continue/);
    assert.equal(state.requests.some(r=>r.method==='sendTransaction'),false);
  });
  await withRpc(async({rpcUrl,state})=>{
    await assert.rejects(flush(rpcUrl,async()=>{assert.fail('must not confirm');},authorizerKey),/controller keypair/);
    assert.equal(state.requests.some(r=>r.method==='sendTransaction'),false);
  },{head:null});
  await withRpc(async({rpcUrl,state})=>{
    await assert.rejects(flush(rpcUrl,async()=>{assert.fail('must not confirm');}),/safe integer/);
    assert.equal(state.requests.some(r=>r.method==='sendTransaction'),false);
  },{lastValidBlockHeight:Number.MAX_SAFE_INTEGER+1});
});

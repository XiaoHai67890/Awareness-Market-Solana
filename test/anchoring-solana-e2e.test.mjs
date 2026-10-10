// Real SBF program + local voting validator + persistent SQLite outbox + the
// real daemon confirmation API. No public cluster, existing wallet, or mock RPC.
// Enable with AWARENESS_SOLANA_TEST_VALIDATOR and AWARENESS_SOLANA_PROGRAM_SO.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {Connection, Keypair, PublicKey} from '@solana/web3.js';
import Database from 'better-sqlite3';
import {AnchoringManager} from '../src/daemon/anchoring/anchoring.mjs';
import {listPending, getMeta} from '../src/daemon/anchoring/anchor-state.mjs';
import {handleAnchorRoute} from '../src/daemon/anchor-api-handlers.mjs';
import {flushSolanaOutbox, verifySolanaConfirmation} from '../src/daemon/anchoring/solana-client.mjs';
import {deriveSpacePda, decodeSolanaSpace} from '../src/daemon/anchoring/solana-codec.mjs';
import {computeTransitionId, computeNextStateRoot} from '../src/daemon/anchoring/erc8350.mjs';

const VALIDATOR = process.env.AWARENESS_SOLANA_TEST_VALIDATOR || '';
const PROGRAM_SO = process.env.AWARENESS_SOLANA_PROGRAM_SO || '';
const IDL_PATH = new URL('../contracts/solana/idl/awareness_memory.json', import.meta.url);
let idlProgramId;
if (fs.existsSync(IDL_PATH)) idlProgramId = JSON.parse(fs.readFileSync(IDL_PATH,'utf8')).address;
const PROGRAM_ID = process.env.AWARENESS_SOLANA_PROGRAM_ID || process.env.AWARENESS_SOLANA_TEST_PROGRAM_ID ||
  idlProgramId || '8a7xdYvy49bBQUE3ycPyjLowg5m5czxQ2YReSEG6RHWA';
const enabled = VALIDATOR && PROGRAM_SO && fs.existsSync(VALIDATOR) && fs.existsSync(PROGRAM_SO);
async function freePort() {
  const s=net.createServer();await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',resolve);});
  const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p;
}
async function rpcPair() {
  for(let i=0;i<20;i++) {
    const port=await freePort();if(port===65535)continue;
    const s=net.createServer();
    try {await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(port+1,'127.0.0.1',resolve);});
      await new Promise(resolve=>s.close(resolve));return port;}
    catch {s.close();}
  }
  throw new Error('no free local RPC/websocket port pair');
}

test('Solana E2E: manager → SBF → finalized receipt → daemon confirmation → retry',
  {skip: !enabled && 'set AWARENESS_SOLANA_TEST_VALIDATOR and AWARENESS_SOLANA_PROGRAM_SO', timeout: 240_000}, async t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'awareness-solana-e2e-'));
  let child,api,indexDb,manager;
  // Cleanup is registered before spawn or readiness checks, including failures.
  t.after(async()=>{
    if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}
    manager?.close();indexDb?.close();
    if(child?.pid&&child.exitCode===null&&child.signalCode===null) {
      const exited=new Promise(resolve=>child.once('close',resolve));child.kill('SIGTERM');
      await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,5_000))]);
      if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
      await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,2_000))]);
    }
    fs.rmSync(temp,{recursive:true,force:true});
  });
  const keypair=Keypair.generate(),controller=keypair.publicKey.toBase58();
  const wallet=path.join(temp,'temporary-wallet.json'),config=path.join(temp,'cli.yml');
  fs.writeFileSync(wallet,JSON.stringify(Array.from(keypair.secretKey)),{mode:0o600});
  const port=await rpcPair(),faucet=await freePort(),gossip=await freePort();
  const rpcUrl=`http://127.0.0.1:${port}`;
  // Explicit config prevents the validator from reading the user's wallet or
  // global Solana configuration. Genesis mint funds this disposable local key.
  fs.writeFileSync(config,`json_rpc_url: ${rpcUrl}\nwebsocket_url: ''\nkeypair_path: ${wallet}\ncommitment: finalized\n`,{mode:0o600});
  const dynamicStart=20_000+Math.floor(Math.random()*20_000);
  let output='';
  child=spawn(VALIDATOR,['--ledger',path.join(temp,'ledger'),'--config',config,'--reset','--quiet',
    '--rpc-port',String(port),'--bind-address','127.0.0.1','--faucet-port',String(faucet),
    '--gossip-port',String(gossip),'--dynamic-port-range',`${dynamicStart}-${dynamicStart+128}`,
    '--mint',controller,'--bpf-program',PROGRAM_ID,PROGRAM_SO],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  child.stdout.on('data',b=>{output=(output+b.toString()).slice(-16_000);});
  child.stderr.on('data',b=>{output=(output+b.toString()).slice(-16_000);});
  let spawnError;child.on('error',e=>{spawnError=e;});
  const connection=new Connection(rpcUrl,{commitment:'finalized',disableRetryOnRateLimit:true,
    fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(2_000)})});
  let genesisHash;
  const readyDeadline=Date.now()+60_000;
  while(Date.now()<readyDeadline) {
    if(spawnError)throw spawnError;
    if(child.exitCode!==null)throw new Error(`local Solana validator exited: ${output}`);
    try {
      genesisHash=await connection.getGenesisHash();
      // Genesis upgradeable programs need a later bank before execution. Wait
      // for voting/finalization readiness even when executable=true at slot 0.
      if((await connection.getAccountInfo(new PublicKey(PROGRAM_ID),'finalized'))?.executable&&
          await connection.getBalance(keypair.publicKey,'finalized')>1_000_000_000&&
          await connection.getSlot('finalized')>=32)break;
      genesisHash=null;
    } catch {genesisHash=null;}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.ok(genesisHash,`local voting validator did not become ready: ${output}`);

  const awarenessDir=path.join(temp,'workspace','.awareness');fs.mkdirSync(awarenessDir,{recursive:true});
  indexDb=new Database(path.join(awarenessDir,'index.db'));
  indexDb.exec('CREATE TABLE knowledge_cards (id TEXT PRIMARY KEY, category TEXT, title TEXT, summary TEXT, tags TEXT, status TEXT)');
  const cfg={enabled:true,backend:'solana',rpc_url:rpcUrl,program_id:PROGRAM_ID,genesis_hash:genesisHash,
    cluster:'localnet',controller_address:controller};
  const daemon={indexer:{db:indexDb},awarenessDir,projectDir:fs.realpathSync(path.dirname(awarenessDir))};
  manager=new AnchoringManager(daemon,cfg).ensureInit();daemon.anchoring=manager;
  indexDb.prepare("INSERT INTO knowledge_cards VALUES ('kc_a','decision','alpha','public synthetic card','[]','active')").run();
  assert.equal(manager.buildIfNeeded().seq,1);
  indexDb.prepare("UPDATE knowledge_cards SET title='alpha v2' WHERE id='kc_a'").run();
  assert.equal(manager.buildIfNeeded().seq,2);
  const rows=listPending(manager.db),spaceId=getMeta(manager.db,'space_id'),spaceSalt=getMeta(manager.db,'space_salt');
  assert.equal(rows.length,2);

  api=http.createServer((req,res)=>handleAnchorRoute(daemon,req,res,new URL(req.url,'http://localhost').pathname));
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const apiUrl=`http://127.0.0.1:${api.address().port}`;
  const results=await flushSolanaOutbox({rpcUrl,programId:PROGRAM_ID,genesisHash,keypair,controller,spaceId,spaceSalt,rows,
    onConfirm:async(seq,txHash)=>{
      const row=rows.find(r=>r.seq===seq);
      const response=await fetch(apiUrl+'/anchor/confirm',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({seq,space_id:spaceId,transition_id:row.transition_id,tx_hash:txHash,
          project_dir:daemon.projectDir})});
      assert.equal(response.status,200,JSON.stringify(await response.json()));
    }});
  assert.equal(results.length,2);assert.ok(results.every(r=>!r.skipped&&r.txHash));
  assert.equal(listPending(manager.db).length,0);
  assert.equal(manager.db.prepare("SELECT COUNT(*) AS n FROM anchor_outbox WHERE status='anchored'").get().n,2);
  const headAccount=await connection.getAccountInfo(deriveSpacePda(PROGRAM_ID,spaceId)[0],'finalized');
  assert.ok(headAccount.owner.equals(new PublicKey(PROGRAM_ID)));
  const head=decodeSolanaSpace(headAccount.data,PROGRAM_ID,spaceId);
  assert.equal(head.sequence,2);assert.equal(head.stateRoot,getMeta(manager.db,'last_root'));

  const again=await flushSolanaOutbox({rpcUrl,programId:PROGRAM_ID,genesisHash,keypair,controller,spaceId,spaceSalt,rows,
    onConfirm:async(seq,txHash)=>{
      assert.equal(txHash,null);
      assert.equal((await verifySolanaConfirmation({rpcUrl,programId:PROGRAM_ID,genesisHash,spaceId,
        row:rows.find(r=>r.seq===seq),txHash})).confirmed,true);
    }});
  assert.ok(again.every(r=>r.skipped));

  // Even with head=2, a different locally self-consistent seq=1 is rejected.
  const wrong={...rows[0],delta_commitment:'0x'+'99'.repeat(32)};
  wrong.transition_id=computeTransitionId({spaceId,sequence:wrong.seq,prevStateRoot:wrong.prev_state_root,
    deltaCommitment:wrong.delta_commitment,provenanceCommitment:wrong.provenance_commitment,
    profileId:wrong.profile_id,locatorCommitment:wrong.locator_commitment});
  wrong.next_state_root=computeNextStateRoot(wrong.prev_state_root,wrong.transition_id);
  await assert.rejects(verifySolanaConfirmation({rpcUrl,programId:PROGRAM_ID,genesisHash,spaceId,row:wrong,txHash:null}),/differs/);
});

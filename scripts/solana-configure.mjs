#!/usr/bin/env node
// Configure an already deployed native program. Reads public addresses only.
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import Database from 'better-sqlite3';
import {Connection, PublicKey} from '@solana/web3.js';

const {values} = parseArgs({options: {
  project: {type: 'string'}, 'program-id': {type: 'string'}, controller: {type: 'string'},
  cluster: {type: 'string', default: 'devnet'}, rpc: {type: 'string'}, help: {type: 'boolean'},
}});
if (values.help) {
  console.log('node scripts/solana-configure.mjs --project <workspace> --program-id <deployed ID> --controller <public key> [--cluster devnet|testnet|localnet] [--rpc URL]');
} else {
  try {
    if (!values.project || !values['program-id'] || !values.controller) throw new Error('--project, --program-id and --controller are required');
    const endpoints = {devnet: 'https://api.devnet.solana.com', testnet: 'https://api.testnet.solana.com', localnet: 'http://127.0.0.1:8899'};
    if (!Object.hasOwn(endpoints, values.cluster)) throw new Error('only devnet, testnet and localnet are supported by this helper');
    const rpc = values.rpc || endpoints[values.cluster];
    const program = new PublicKey(values['program-id']);
    const controller = new PublicKey(values.controller);
    if (program.equals(PublicKey.default) || controller.equals(PublicKey.default)) throw new Error('zero public keys are not allowed');
    const project = fs.realpathSync(path.resolve(values.project));
    const dir = path.join(project, '.awareness');
    const configFile = path.join(dir, 'config.json');
    const originalConfigText = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : null;
    const config = originalConfigText === null ? {} : JSON.parse(originalConfigText);
    const connection = new Connection(rpc, {commitment: 'finalized',
      fetch: (url, options) => fetch(url, {...options, signal: AbortSignal.timeout(30000)})});
    const genesis = await connection.getGenesisHash();
    if (values.cluster !== 'localnet') {
      const official = new Connection(endpoints[values.cluster], {fetch: (url, options) =>
        fetch(url, {...options, signal: AbortSignal.timeout(30000)})});
      if (genesis !== await official.getGenesisHash()) throw new Error('RPC is not the selected test cluster');
    }
    const account = await connection.getAccountInfo(program, 'finalized');
    if (!account?.executable) throw new Error('Program ID is not deployed/executable on this cluster');
    const desired = {enabled: true, backend: 'solana', cluster: values.cluster,
      rpc_url: rpc, program_id: program.toBase58(), genesis_hash: genesis,
      controller_address: controller.toBase58()};
    // Once a Space exists, changing identity must never be a silent reset.
    for (const filename of ['anchoring.sqlite', 'index.db']) {
      const dbPath = path.join(dir, filename);
      if (!fs.existsSync(dbPath)) continue;
      const db = new Database(dbPath, {readonly: true, fileMustExist: true});
      try {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='anchor_meta'").get()) continue;
        if (!db.prepare("SELECT value FROM anchor_meta WHERE key='space_id'").get()) continue;
        const meta = key => db.prepare('SELECT value FROM anchor_meta WHERE key = ?').get(key)?.value;
        const binding = JSON.parse(meta('identity_binding_v1') || '{}');
        if (meta('backend') !== 'solana' || binding.backend !== 'solana' ||
            binding.programId !== desired.program_id || binding.genesisHash !== desired.genesis_hash ||
            meta('controller') !== desired.controller_address) {
          throw new Error('workspace already has a different or incomplete anchoring identity; use a separate workspace and preserve its existing state');
        }
      } finally { db.close(); }
    }
    config.anchoring = desired;
    const currentConfigText = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : null;
    if (currentConfigText !== originalConfigText) throw new Error('configuration changed during RPC checks; retry without overwriting the newer settings');
    fs.mkdirSync(dir, {recursive: true});
    const temp = `${configFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
      fs.renameSync(temp, configFile);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    console.log(`Configured ${configFile}\nSolana ${values.cluster}\nProgram: ${program.toBase58()}\nGenesis: ${genesis}\nRestart the daemon for this workspace.`);
  } catch (err) {
    console.error(`Configuration failed: ${err.message}`);
    process.exitCode = 1;
  }
}

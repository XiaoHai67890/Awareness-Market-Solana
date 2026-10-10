#!/usr/bin/env node
// Record public demonstration data through the normal memory API. No signing.
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';

const {values} = parseArgs({options: {
  project: {type: 'string'}, port: {type: 'string'}, step: {type: 'string'},
  help: {type: 'boolean'},
}});

if (values.help) {
  console.log('node scripts/solana-demo-record.mjs --project <workspace> --step 1|2 [--port <daemon port>]');
} else {
  try {
    if (!values.project || !['1', '2'].includes(values.step)) throw new Error('--project and --step 1|2 are required');
    const project = fs.realpathSync(path.resolve(values.project));
    const config = JSON.parse(fs.readFileSync(path.join(project, '.awareness/config.json'), 'utf8'));
    const port = Number(values.port || config.daemon?.port || 37800);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid daemon port');
    const base = `http://127.0.0.1:${port}/api/v1`;
    async function request(route, options) {
      const response = await fetch(base + route, {...options, signal: AbortSignal.timeout(90_000)});
      if (!response.ok) throw new Error(`daemon HTTP ${response.status}`);
      return response.json();
    }
    const status = await request('/anchor/status');
    const idl = JSON.parse(fs.readFileSync(new URL('../contracts/solana/idl/awareness_memory.json', import.meta.url), 'utf8'));
    if (status.projectDir !== project || status.backend !== 'solana' || status.cluster !== 'devnet' ||
        status.genesisHash !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' || status.programId !== idl.address) {
      throw new Error('daemon must serve the requested workspace and this program on Devnet');
    }
    const payload = JSON.parse(fs.readFileSync(new URL(`../examples/solana-devnet/memory-${values.step}.json`, import.meta.url), 'utf8'));
    const card = payload.insights.knowledge_cards[0];
    async function present() {
      const result = await request('/knowledge?limit=1000');
      if (!Array.isArray(result.items)) throw new Error('invalid knowledge response');
      const matches = result.items.filter(item => item.title === card.title);
      if (matches.length > 1 || (matches.length === 1 && matches[0].summary !== card.summary)) {
        throw new Error('existing demonstration card differs; preserve it and use a fresh workspace');
      }
      return matches.length === 1;
    }
    if (await present()) {
      console.log(`Demonstration memory ${values.step} is already indexed; nothing was written.`);
    } else {
      const result = await request('/memories', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
      if (result.error || !result.id) throw new Error('memory was not accepted');
      const deadline = Date.now() + 90_000;
      while (!(await present())) {
        if (Date.now() >= deadline) throw new Error('memory was recorded but its knowledge card is not indexed yet; inspect the daemon before retrying');
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
      console.log(`Demonstration memory ${values.step} and its knowledge card are indexed. Run anchor flush to submit.`);
    }
  } catch (error) {
    console.error(`Demo record failed: ${error.message}`);
    process.exitCode = 1;
  }
}

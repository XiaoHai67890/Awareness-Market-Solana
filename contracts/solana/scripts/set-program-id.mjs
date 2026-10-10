#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';

// Takes only a public address. It never opens a wallet or a program keypair.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--program-id') {
  throw new Error('Usage: node scripts/set-program-id.mjs --program-id <public program address>');
}
const program = new PublicKey(args[1]);
if (program.equals(PublicKey.default)) throw new Error('Program ID must be nonzero');
const id = program.toBase58();
const lib = fileURLToPath(new URL('../programs/awareness-memory/src/lib.rs', import.meta.url));
const config = fileURLToPath(new URL('../Anchor.toml', import.meta.url));
const source = readFileSync(lib, 'utf8');
const toml = readFileSync(config, 'utf8');
const declaration = /declare_id!\("[1-9A-HJ-NP-Za-km-z]+"\);/g;
const localProgram = /^awareness_memory\s*=\s*"[1-9A-HJ-NP-Za-km-z]+"\s*$/gm;
if ([...source.matchAll(declaration)].length !== 1 || [...toml.matchAll(localProgram)].length !== 1) {
  throw new Error('Expected exactly one declare_id! and one awareness_memory program entry');
}
writeFileSync(lib, source.replace(declaration, `declare_id!("${id}");`));
writeFileSync(config, toml.replace(localProgram, `awareness_memory = "${id}"`));
console.log(`Program ID synchronized: ${id}. Run ./scripts/build.sh to update ELF, IDL and ABI fixtures.`);

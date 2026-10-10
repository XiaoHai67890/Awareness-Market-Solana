// Solana wire format for the Awareness memory registry. Commitments keep the
// existing ERC-8350 hashes; only the public-key Space domain is Solana-specific.
import {createHash} from 'node:crypto';
import {keccak_256} from '@noble/hashes/sha3.js';
import {PublicKey, SystemProgram, TransactionInstruction} from '@solana/web3.js';
import {computeTransitionId, computeNextStateRoot} from './erc8350.mjs';

export const SOLANA_SPACE_TYPE = 'AwarenessMemorySpace(bytes32 initialController,bytes32 salt)';
export const SPACE_ACCOUNT_SIZE = 250;
export const RECEIPT_ACCOUNT_SIZE = 314;
export const anchorDiscriminator = name => createHash('sha256').update(name).digest().subarray(0, 8);
export const SPACE_DISCRIMINATOR = anchorDiscriminator('account:Space');
export const RECEIPT_DISCRIMINATOR = anchorDiscriminator('account:TransitionReceipt');

export function validateSolanaPublicKey(value, label = 'public key') {
  let key;
  try {
    if (value instanceof PublicKey) key = value;
    else if (typeof value === 'string' && value && value.trim() === value) {
      key = new PublicKey(value);
      if (key.toBase58() !== value) throw new Error('non-canonical');
    } else throw new Error('invalid');
  } catch { throw new Error(`invalid Solana ${label}`); }
  if (key.equals(PublicKey.default)) throw new Error(`Solana ${label} must not be the default public key`);
  return key;
}

export function validateSolanaConfig(cfg = {}) {
  const rpcUrl = cfg.rpc_url ?? cfg.rpcUrl;
  let url;
  try { url = new URL(rpcUrl); } catch { throw new Error('invalid Solana RPC URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('Solana RPC URL must be HTTP(S), without embedded credentials or a fragment');
  }
  const programId = validateSolanaPublicKey(cfg.program_id ?? cfg.programId, 'program ID').toBase58();
  // A genesis hash is also a canonical base58-encoded 32-byte value.
  const genesisHash = validateSolanaPublicKey(cfg.genesis_hash ?? cfg.genesisHash, 'genesis hash').toBase58();
  const controllerValue = cfg.controller_address ?? cfg.controller;
  const controller = controllerValue === undefined ? undefined
    : validateSolanaPublicKey(controllerValue, 'controller').toBase58();
  return {rpcUrl: url.href, programId, genesisHash, ...(controller ? {controller} : {})};
}

export function hex32(value, label = 'bytes32') {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`invalid ${label}: expected 0x-prefixed 32 bytes`);
  }
  return value.toLowerCase();
}
export const bytes32 = (value, label) => Buffer.from(hex32(value, label).slice(2), 'hex');
export function safeInteger(value, label = 'integer', minimum = 0) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a safe integer >= ${minimum}`);
  }
  return value;
}
export function u64le(value, label = 'sequence') {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(safeInteger(value, label)));
  return buffer;
}
const toHex = bytes => '0x' + Buffer.from(bytes).toString('hex');

export function deriveSolanaSpaceId(controller, salt) {
  const key = validateSolanaPublicKey(controller, 'initial controller');
  return toHex(keccak_256(Buffer.concat([
    Buffer.from(keccak_256(Buffer.from(SOLANA_SPACE_TYPE))), key.toBuffer(), bytes32(salt, 'Space salt'),
  ])));
}

export function deriveSpacePda(programId, spaceId) {
  return PublicKey.findProgramAddressSync([
    Buffer.from('space'), bytes32(spaceId, 'Space ID'),
  ], validateSolanaPublicKey(programId, 'program ID'));
}
export function deriveReceiptPda(programId, spaceId, sequence) {
  return PublicKey.findProgramAddressSync([
    Buffer.from('transition'), bytes32(spaceId, 'Space ID'), u64le(safeInteger(sequence, 'sequence', 1)),
  ], validateSolanaPublicKey(programId, 'program ID'));
}

export function validateSolanaRow(row, spaceId) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid outbox row');
  const normalized = {seq: safeInteger(row.seq, 'sequence', 1)};
  for (const field of ['space_id', 'prev_state_root', 'delta_commitment', 'provenance_commitment',
    'profile_id', 'locator_commitment', 'transition_id', 'next_state_root']) {
    normalized[field] = hex32(row[field], field);
  }
  if (normalized.space_id !== hex32(spaceId, 'Space ID')) throw new Error('outbox row belongs to a different Space');
  if (row.ops_count !== undefined) normalized.ops_count = safeInteger(row.ops_count, 'operation count');
  const transition = computeTransitionId({spaceId: normalized.space_id, sequence: normalized.seq,
    prevStateRoot: normalized.prev_state_root, deltaCommitment: normalized.delta_commitment,
    provenanceCommitment: normalized.provenance_commitment, profileId: normalized.profile_id,
    locatorCommitment: normalized.locator_commitment});
  if (normalized.transition_id !== transition) throw new Error('outbox transition ID does not match its fields');
  if (normalized.next_state_root !== computeNextStateRoot(normalized.prev_state_root, transition)) {
    throw new Error('outbox next state root does not match its transition');
  }
  return normalized;
}

export function encodeRegisterSpace(spaceId, salt, authorizer) {
  return Buffer.concat([anchorDiscriminator('global:register_space'), bytes32(spaceId), bytes32(salt),
    validateSolanaPublicKey(authorizer, 'authorizer').toBuffer()]);
}
export function encodeCommitTransition(row) {
  const r = validateSolanaRow(row, row.space_id);
  return Buffer.concat([anchorDiscriminator('global:commit_transition'), u64le(r.seq),
    ...['prev_state_root', 'delta_commitment', 'provenance_commitment', 'profile_id', 'locator_commitment']
      .map(field => bytes32(r[field]))]);
}
export function encodeSetAuthorization(controller, authorizer, nonce) {
  return Buffer.concat([anchorDiscriminator('global:set_authorization'),
    validateSolanaPublicKey(controller, 'controller').toBuffer(),
    validateSolanaPublicKey(authorizer, 'authorizer').toBuffer(), u64le(nonce, 'config nonce')]);
}

export function createRegisterSpaceInstruction({programId, payer, controller, spaceId, spaceSalt, authorizer}) {
  return new TransactionInstruction({programId: validateSolanaPublicKey(programId, 'program ID'),
    keys: [{pubkey: validateSolanaPublicKey(payer, 'payer'), isSigner: true, isWritable: true},
      {pubkey: validateSolanaPublicKey(controller, 'controller'), isSigner: true, isWritable: false},
      {pubkey: deriveSpacePda(programId, spaceId)[0], isSigner: false, isWritable: true},
      {pubkey: SystemProgram.programId, isSigner: false, isWritable: false}],
    data: encodeRegisterSpace(spaceId, spaceSalt, authorizer)});
}
export function createCommitTransitionInstruction({programId, payer, authorizer, spaceId, row}) {
  const r = validateSolanaRow(row, spaceId);
  return new TransactionInstruction({programId: validateSolanaPublicKey(programId, 'program ID'),
    keys: [{pubkey: validateSolanaPublicKey(payer, 'payer'), isSigner: true, isWritable: true},
      {pubkey: validateSolanaPublicKey(authorizer, 'authorizer'), isSigner: true, isWritable: false},
      {pubkey: deriveSpacePda(programId, spaceId)[0], isSigner: false, isWritable: true},
      {pubkey: deriveReceiptPda(programId, spaceId, r.seq)[0], isSigner: false, isWritable: true},
      {pubkey: SystemProgram.programId, isSigner: false, isWritable: false}],
    data: encodeCommitTransition(r)});
}

function accountReader(data, size, discriminator, label) {
  if (!(data instanceof Uint8Array)) throw new Error(`invalid ${label} account data`);
  const b = Buffer.from(data);
  if (b.length !== size || !b.subarray(0, 8).equals(discriminator)) {
    throw new Error(`invalid ${label} account length or discriminator`);
  }
  let offset = 8;
  const reader = {
    byte() { return b[offset++]; },
    hex() { const v = toHex(b.subarray(offset, offset + 32)); offset += 32; return v; },
    key(label) { const v = new PublicKey(b.subarray(offset, offset + 32)); offset += 32;
      return validateSolanaPublicKey(v, label).toBase58(); },
    integer(label) { const v = b.readBigUInt64LE(offset); offset += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds safe integer range`);
      return Number(v); },
  };
  if (reader.byte() !== 1) throw new Error(`unsupported ${label} account version`);
  return reader;
}

export function decodeSolanaSpace(data, programId, expectedSpaceId) {
  const r = accountReader(data, SPACE_ACCOUNT_SIZE, SPACE_DISCRIMINATOR, 'Space');
  const result = {bump: r.byte(), spaceId: r.hex(), initialController: r.key('initial controller'),
    salt: r.hex(), controller: r.key('controller'), authorizer: r.key('authorizer'),
    sequence: r.integer('Space sequence'), configNonce: r.integer('config nonce'),
    transitionId: r.hex(), stateRoot: r.hex()};
  if (result.spaceId !== hex32(expectedSpaceId, 'Space ID') ||
      result.spaceId !== deriveSolanaSpaceId(result.initialController, result.salt) ||
      result.bump !== deriveSpacePda(programId, result.spaceId)[1]) {
    throw new Error('Space identity or PDA bump does not match');
  }
  return result;
}
export function decodeSolanaReceipt(data, programId, expectedSpaceId, expectedSequence) {
  const r = accountReader(data, RECEIPT_ACCOUNT_SIZE, RECEIPT_DISCRIMINATOR, 'Receipt');
  const result = {bump: r.byte(), spaceId: r.hex(), sequence: r.integer('Receipt sequence'),
    prevStateRoot: r.hex(), deltaCommitment: r.hex(), provenanceCommitment: r.hex(),
    profileId: r.hex(), locatorCommitment: r.hex(), transitionId: r.hex(), nextStateRoot: r.hex(),
    authorizer: r.key('receipt authorizer'), observedSlot: r.integer('observed slot')};
  if (result.spaceId !== hex32(expectedSpaceId, 'Space ID') ||
      result.sequence !== safeInteger(expectedSequence, 'sequence', 1) ||
      result.bump !== deriveReceiptPda(programId, result.spaceId, result.sequence)[1]) {
    throw new Error('Receipt identity, sequence or PDA bump does not match');
  }
  return result;
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function decodeBase58(value, expectedLength, label = 'base58 value') {
  if (typeof value !== 'string' || !value || value.length > (expectedLength ? expectedLength * 2 : 4096)) {
    throw new Error(`invalid ${label}`);
  }
  let n = 0n;
  for (const c of value) { const i = BASE58.indexOf(c); if (i < 0) throw new Error(`invalid ${label}`); n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  const leading = value.match(/^1*/)[0].length;
  const result = Buffer.concat([Buffer.alloc(leading), body]);
  if (expectedLength !== undefined && result.length !== expectedLength) throw new Error(`invalid ${label} length`);
  return result;
}
export function encodeBase58(bytes) {
  const b = Buffer.from(bytes); let n = b.length ? BigInt('0x' + b.toString('hex')) : 0n;
  let out = '';
  while (n) { out = BASE58[Number(n % 58n)] + out; n /= 58n; }
  for (const c of b) { if (c !== 0) break; out = '1' + out; }
  return out;
}

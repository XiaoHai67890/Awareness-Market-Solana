// Broadcasting is CLI-only. Independent confirmation uses finalized public
// accounts and transactions and never accepts or transmits a private key.
import {Connection, Keypair, PublicKey, SystemProgram, Transaction} from '@solana/web3.js';
import {ZERO32} from './erc8350.mjs';
import {
  validateSolanaConfig, validateSolanaRow, hex32, safeInteger,
  deriveSolanaSpaceId, deriveSpacePda, deriveReceiptPda,
  decodeSolanaSpace, decodeSolanaReceipt, decodeBase58, encodeBase58,
  encodeCommitTransition, createRegisterSpaceInstruction, createCommitTransitionInstruction,
} from './solana-codec.mjs';

const RPC_TIMEOUT_MS = 15_000;
const FINALIZATION_TIMEOUT_MS = 60_000;

function connectionFor(rpcUrl) {
  return new Connection(rpcUrl, {commitment: 'finalized', disableRetryOnRateLimit: true,
    fetch: async (url, init) => {
      try { return await fetch(url, {...init, signal: AbortSignal.timeout(RPC_TIMEOUT_MS)}); }
      catch { throw new Error('Solana RPC request failed or timed out'); }
    }});
}
async function checkNetwork(connection, programId, genesisHash) {
  if (await connection.getGenesisHash() !== genesisHash) throw new Error('Solana RPC genesis hash does not match the configured cluster');
  const program = await connection.getAccountInfo(programId, 'finalized');
  if (!program || program.executable !== true) throw new Error('configured Solana program is absent or is not executable');
}
async function readOwnedAccount(connection, address, programId, label) {
  const account = await connection.getAccountInfo(address, 'finalized');
  if (!account) return null;
  if (!account.owner.equals(programId) || account.executable !== false) {
    throw new Error(`${label} account has an unexpected owner or executable flag`);
  }
  return account.data;
}
async function readSpace(connection, programId, spaceId) {
  const [address] = deriveSpacePda(programId, spaceId);
  const data = await readOwnedAccount(connection, address, programId, 'Space');
  return data ? decodeSolanaSpace(data, programId, spaceId) : null;
}
async function readReceipt(connection, programId, spaceId, row) {
  const [address] = deriveReceiptPda(programId, spaceId, row.seq);
  const data = await readOwnedAccount(connection, address, programId, 'Receipt');
  if (!data) return null;
  const receipt = decodeSolanaReceipt(data, programId, spaceId, row.seq);
  for (const [field, expected] of Object.entries({prevStateRoot: row.prev_state_root,
    deltaCommitment: row.delta_commitment, provenanceCommitment: row.provenance_commitment,
    profileId: row.profile_id, locatorCommitment: row.locator_commitment,
    transitionId: row.transition_id, nextStateRoot: row.next_state_root})) {
    if (receipt[field] !== expected) throw new Error(`Receipt ${field} differs from the local transition`);
  }
  return {...receipt, address: address.toBase58()};
}

function signature(value) {
  const bytes = decodeBase58(value, 64, 'transaction signature');
  if (bytes.every(b => b === 0)) throw new Error('transaction signature must not be zero');
  return value;
}
async function requireFinalizedSignature(connection, txHash) {
  const {value} = await connection.getSignatureStatuses([signature(txHash)], {searchTransactionHistory: true});
  const status = value[0];
  if (!status || status.err !== null || status.confirmationStatus !== 'finalized') {
    throw new Error('transaction is absent, failed, or not finalized');
  }
  return status;
}

// A successful, unrelated signature must not be used as evidence for a receipt.
// Match the exact commit instruction and its signer/Space/Receipt accounts.
async function checkCommitTransaction(connection, programId, spaceId, row, receipt, txHash) {
  const status = await requireFinalizedSignature(connection, txHash);
  const response = await connection.getTransaction(txHash, {commitment: 'finalized', maxSupportedTransactionVersion: 0});
  if (!response || !response.meta || response.meta.err !== null ||
      !response.transaction.signatures.includes(txHash) || response.slot !== status.slot ||
      response.slot !== receipt.observedSlot) {
    throw new Error('finalized transaction does not match the receipt slot or successful signature');
  }
  const message = response.transaction.message;
  const keys = message.getAccountKeys
    ? message.getAccountKeys({accountKeysFromLookups: response.meta.loadedAddresses})
    : {get: index => message.accountKeys[index]};
  const instructions = message.compiledInstructions ?? message.instructions;
  const expectedSpace = deriveSpacePda(programId, spaceId)[0];
  const expectedReceipt = deriveReceiptPda(programId, spaceId, row.seq)[0];
  const expectedData = encodeCommitTransition(row);
  const signer = index => message.isAccountSigner ? message.isAccountSigner(index)
    : index < message.header.numRequiredSignatures;
  const matched = instructions.some(ix => {
    if (!keys.get(ix.programIdIndex)?.equals(programId)) return false;
    const accounts = ix.accountKeyIndexes ?? ix.accounts;
    const data = typeof ix.data === 'string' ? decodeBase58(ix.data) : Buffer.from(ix.data);
    return data.equals(expectedData) && accounts.length === 5 && signer(accounts[0]) && signer(accounts[1]) &&
      keys.get(accounts[1])?.toBase58() === receipt.authorizer && keys.get(accounts[2])?.equals(expectedSpace) &&
      keys.get(accounts[3])?.equals(expectedReceipt) && keys.get(accounts[4])?.equals(SystemProgram.programId);
  });
  if (!matched) throw new Error('transaction does not contain the expected program commit and Receipt PDA');
}

async function verifyWithConnection(connection, programId, spaceId, row, txHash) {
  const space = await readSpace(connection, programId, spaceId);
  if (!space) throw new Error('Space is not registered on the configured program');
  const receipt = await readReceipt(connection, programId, spaceId, row);
  if (!receipt) throw new Error('immutable transition Receipt is absent');
  if (space.sequence < row.seq || (space.sequence === row.seq &&
      (space.stateRoot !== row.next_state_root || space.transitionId !== row.transition_id))) {
    throw new Error('Space head disagrees with the verified Receipt');
  }
  if (txHash !== null) await checkCommitTransaction(connection, programId, spaceId, row, receipt, txHash);
  return {confirmed: true, seq: row.seq, spaceId, transitionId: receipt.transitionId,
    nextStateRoot: receipt.nextStateRoot, receiptAddress: receipt.address, txHash, slot: receipt.observedSlot};
}

/** Read-only verification for the daemon. Null signature reconciles an exact,
 * immutable Receipt from finalized state; a supplied signature is verified too. */
export async function verifySolanaConfirmation({rpcUrl, programId, genesisHash, spaceId, row, txHash = null}) {
  const cfg = validateSolanaConfig({rpcUrl, programId, genesisHash});
  const space = hex32(spaceId, 'Space ID');
  const normalized = validateSolanaRow(row, space);
  if (txHash !== null) signature(txHash);
  const program = new PublicKey(cfg.programId), connection = connectionFor(cfg.rpcUrl);
  await checkNetwork(connection, program, cfg.genesisHash);
  return verifyWithConnection(connection, program, space, normalized, txHash);
}

async function sendFinalized(connection, keypair, instruction) {
  const block = await connection.getLatestBlockhash('finalized');
  decodeBase58(block.blockhash, 32, 'recent blockhash');
  safeInteger(block.lastValidBlockHeight, 'last valid block height');
  const transaction = new Transaction({feePayer: keypair.publicKey,
    blockhash: block.blockhash, lastValidBlockHeight: block.lastValidBlockHeight}).add(instruction);
  transaction.sign(keypair);
  const expectedSignature = encodeBase58(transaction.signature);
  const returnedSignature = await connection.sendRawTransaction(transaction.serialize(),
    {skipPreflight: false, preflightCommitment: 'finalized', maxRetries: 3});
  if (returnedSignature !== expectedSignature) throw new Error('RPC returned a signature different from the signed transaction');
  const deadline = Date.now() + FINALIZATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const {value} = await connection.getSignatureStatuses([expectedSignature], {searchTransactionHistory: true});
    const status = value[0];
    if (status && status.err !== null) throw new Error(`Solana transaction failed (${expectedSignature})`);
    if (status?.confirmationStatus === 'finalized') return expectedSignature;
    if (safeInteger(await connection.getBlockHeight('finalized'), 'block height') > block.lastValidBlockHeight) {
      throw new Error(`Solana transaction expired before finalization (${expectedSignature})`);
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new Error(`Solana transaction finalization timed out (${expectedSignature}); retry to reconcile its Receipt`);
}

/** CLI-only: the keypair signs locally and never reaches the daemon. Existing
 * Spaces support a separate authorizer; registration requires the controller. */
export async function flushSolanaOutbox({rpcUrl, programId, genesisHash, keypair, controller,
  spaceId, spaceSalt, rows, onConfirm, log = () => {}}) {
  const cfg = validateSolanaConfig({rpcUrl, programId, genesisHash, controller});
  if (!(keypair instanceof Keypair)) throw new Error('Solana flush requires a local Keypair');
  // Revalidate the keypair without printing its secret or placing it in RPC data.
  if (!Keypair.fromSecretKey(keypair.secretKey).publicKey.equals(keypair.publicKey)) throw new Error('invalid Solana keypair');
  if (!Array.isArray(rows) || typeof onConfirm !== 'function' || typeof log !== 'function') {
    throw new Error('flush requires ordered rows, onConfirm, and an optional log function');
  }
  if (rows.length === 0) return [];
  const space = hex32(spaceId, 'Space ID'), salt = hex32(spaceSalt, 'Space salt');
  const normalized = rows.map(row => validateSolanaRow(row, space));
  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i].seq <= normalized[i - 1].seq) throw new Error('outbox rows must have strictly increasing sequences');
  }
  const program = new PublicKey(cfg.programId), connection = connectionFor(cfg.rpcUrl);
  await checkNetwork(connection, program, cfg.genesisHash);
  let head = await readSpace(connection, program, space);
  if (!head) {
    if (keypair.publicKey.toBase58() !== cfg.controller || deriveSolanaSpaceId(cfg.controller, salt) !== space) {
      throw new Error('new Space identity must match its controller keypair and salt');
    }
    log(`registering Solana Space ${space.slice(0, 12)}…`);
    try {
      await sendFinalized(connection, keypair, createRegisterSpaceInstruction({programId: program,
        payer: keypair.publicKey, controller: cfg.controller, spaceId: space, spaceSalt: salt, authorizer: cfg.controller}));
    } catch (error) {
      // Concurrent registration or a lost RPC response is recoverable only by
      // the exact finalized account, never by swallowing an arbitrary RPC error.
      head = await readSpace(connection, program, space);
      if (!head) throw error;
    }
    head = await readSpace(connection, program, space);
    if (!head) throw new Error('registration has no finalized Space account');
  }
  if (head.controller !== cfg.controller || head.salt !== salt || head.authorizer !== keypair.publicKey.toBase58()) {
    throw new Error('Space controller, salt, or current authorizer does not match this flush');
  }

  const results = [];
  for (const row of normalized) {
    // Exact immutable receipts survive later head advancement and make retry
    // reconciliation safe even when the original transaction signature is lost.
    const existing = await readReceipt(connection, program, space, row);
    if (existing) {
      const proof = await verifyWithConnection(connection, program, space, row, null);
      await onConfirm(row.seq, null);
      results.push({...proof, skipped: true});
      continue;
    }
    head = await readSpace(connection, program, space);
    if (!head || head.controller !== cfg.controller || head.authorizer !== keypair.publicKey.toBase58()) {
      throw new Error('Space authorization changed during flush');
    }
    if (row.seq !== head.sequence + 1 || row.prev_state_root !== head.stateRoot ||
        (head.sequence === 0 && (head.stateRoot !== ZERO32 || head.transitionId !== ZERO32))) {
      throw new Error('outbox does not continue the finalized Solana Space head');
    }
    log(`committing Solana seq ${row.seq}…`);
    const txHash = await sendFinalized(connection, keypair, createCommitTransitionInstruction({programId: program,
      payer: keypair.publicKey, authorizer: keypair.publicKey, spaceId: space, row}));
    const proof = await verifyWithConnection(connection, program, space, row, txHash);
    await onConfirm(row.seq, txHash);
    log(`anchored Solana seq ${row.seq}: ${txHash}`);
    results.push({...proof, skipped: false});
  }
  return results;
}

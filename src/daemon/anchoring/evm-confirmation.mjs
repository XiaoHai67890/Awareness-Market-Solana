// Verify the exact stored transition, including when recovering an interrupted flush.
import {rpcCall} from './eth-tx.mjs';
import {encodeTransitionCall, decodeTransition, encodeCommitTransition} from './registry-abi.mjs';
import {computeTransitionId, computeNextStateRoot} from './erc8350.mjs';

export function validateOutboxRow(row, spaceId) {
  for (const key of ['space_id', 'prev_state_root', 'delta_commitment',
    'provenance_commitment', 'profile_id', 'locator_commitment', 'transition_id', 'next_state_root']) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(row[key])) throw new Error(`invalid outbox ${key}`);
  }
  if (!Number.isSafeInteger(row.seq) || row.seq < 1) throw new Error('invalid outbox sequence');
  if (row.space_id.toLowerCase() !== spaceId.toLowerCase()) throw new Error('outbox Space mismatch');
  const id = computeTransitionId({spaceId: row.space_id, sequence: row.seq,
    prevStateRoot: row.prev_state_root, deltaCommitment: row.delta_commitment,
    provenanceCommitment: row.provenance_commitment, profileId: row.profile_id,
    locatorCommitment: row.locator_commitment});
  if (id !== row.transition_id.toLowerCase() ||
      computeNextStateRoot(row.prev_state_root, id) !== row.next_state_root.toLowerCase()) {
    throw new Error('outbox commitment/root mismatch');
  }
}

export async function verifyEvmConfirmation({rpcUrl, chainId, registry, spaceId, row, txHash = null}) {
  validateOutboxRow(row, spaceId);
  if (Number(BigInt(await rpcCall(rpcUrl, 'eth_chainId'))) !== Number(chainId)) {
    throw new Error('RPC chain does not match anchoring configuration');
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(registry)) throw new Error('invalid registry address');
  const record = decodeTransition(await rpcCall(rpcUrl, 'eth_call', [
    {to: registry, data: encodeTransitionCall(row.transition_id)}, 'latest',
  ]));
  if (record.spaceId !== spaceId.toLowerCase() || record.sequence !== row.seq ||
      record.nextStateRoot !== row.next_state_root.toLowerCase()) {
    throw new Error(`seq ${row.seq} has no matching on-chain transition`);
  }
  if (txHash !== null) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash) || /^0x0{64}$/.test(txHash)) throw new Error('invalid transaction hash');
    const [receipt, tx] = await Promise.all([
      rpcCall(rpcUrl, 'eth_getTransactionReceipt', [txHash]),
      rpcCall(rpcUrl, 'eth_getTransactionByHash', [txHash]),
    ]);
    if (!receipt || receipt.status !== '0x1' || !receipt.blockHash ||
        receipt.to?.toLowerCase() !== registry.toLowerCase() ||
        tx?.to?.toLowerCase() !== registry.toLowerCase() ||
        tx?.input?.toLowerCase() !== encodeCommitTransition(row).toLowerCase()) {
      throw new Error('transaction is not a successful matching registry commit');
    }
    const block = await rpcCall(rpcUrl, 'eth_getBlockByNumber', [receipt.blockNumber, false]);
    if (block?.hash !== receipt.blockHash) throw new Error('transaction block is no longer canonical');
  }
  return true;
}

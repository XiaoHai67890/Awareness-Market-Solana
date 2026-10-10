# Awareness memory card digest v2

Profile identifier: `keccak256(UTF8("https://awareness.market/profiles/memory/card-digest/v2"))`.

This document defines the identifier used by the local implementation. Deploying a registry does not publish or change the website at that URL. The v1 definition remains available through `computeCardDigest(row, CARD_DIGEST_PROFILE_V1_ID)` for historical verification; new batches use v2.

## Card content hash

For each selected `knowledge_cards` row, construct an object containing exactly these six keys: `id`, `category`, `title`, `summary`, `tags`, `status`. `id` is the card's string identifier. Each other field is its stored string, or JSON `null` when missing/null. In particular, `tags` remains the stored text; do not parse or reorder it.

Serialize using `stableStringify`: sort object keys lexicographically, encode strings with JSON escaping, preserve null, and omit whitespace. Hash the UTF-8 serialization using SHA-256 and encode as 64 lowercase hexadecimal characters without a `0x` prefix. This preserves field boundaries even when a string contains U+001F. Missing/null and empty strings are deliberately distinct in v2.

The independent expected hashes in `test/card-digest-profile.test.mjs` pin this definition. Do not alter the v2 encoding under the same identifier; another change requires another profile.

## Batch payload and private commitment

Read a single consistent SQLite statement snapshot of cards whose status is null or not `superseded`. Compare their v2 hashes against the last built snapshot. Produce `added`/`updated` operations with `{card, hash, op}`, and `removed` operations with `{card, op}`. Sort operations by card ID using JavaScript string comparison. Omit a batch when there are no operations.

The payload object is `{v: 2, standard: "ERC-8350", space, profile, seq, ops}`. `standard` names the commitment/transition hashing family; the witness's `backend` field distinguishes EVM from its Solana adapter. Serialize the payload with the same `stableStringify` function.

Generate a fresh private 32-byte delta salt. Compute `deltaCommitment` using the existing ERC-8350 baseline commitment: Keccak of four concatenated 32-byte words containing the delta domain hash, profile ID, salt, and Keccak of the UTF-8 payload. The on-chain transition includes this commitment and profile ID. The private witness contains the payload, salt, delta, transition ID and next state root.

## Migration

Existing v1 witnesses, outbox rows and profile IDs are preserved byte-for-byte. The next snapshot uses v2; existing live cards therefore normally appear as updates once, with the new profile ID. Their new transition continues the preceding root and sequence. The legacy v1 helper intentionally retains its original U+001F encoding for verification only.

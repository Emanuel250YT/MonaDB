# MonaDB blobs: erasure-coded storage with storage proofs

A **blob** stores a large payload as `n = k + m` erasure-coded shards spread over
`n` replicator nodes, with **one** on-chain entry per blob (a Merkle root),
time-based payments and challenge/response storage proofs. It complements the
chunk paths (ledger chunks, direct chunks), which keep working.

Why: with chunks, 1 TB needs ~119 000 chunk entries and ~1 000 wallet
transactions, and every replica is a full copy. A blob needs one entry and one
transaction, stores 1.4× the data with Reed-Solomon 10+4 instead of 2–3×, and
tolerates `m` lost nodes.

Everything below is normative: the SDK (TypeScript), the node (TypeScript,
reusing the SDK) and the contract (Solidity) must agree byte for byte. The
format (§2–§4, §6) is the same as SolaDB's; §5 is the EVM contract.

## 1. Constants

| Name | Value | Meaning |
| --- | --- | --- |
| `SEGMENT_SIZE` | 1024 | bytes per Merkle leaf (and per storage-proof answer) |
| `MAX_SHARDS` | 32 | `n = k + m ≤ 32`, `k ≥ 1`, `m ≥ 0` |
| `MIN_FRAGMENT` / `MAX_FRAGMENT` | 1 KiB / 1 MiB | fragment size `F`, a power of two |
| `ENCRYPTION_OVERHEAD` | 28 | AES-256-GCM: 12-byte nonce + 16-byte tag (SDK `encryptBytes` layout) |
| `CHALLENGE_DELAY_BLOCKS` | 2 | a challenge's randomness is the hash of a block not yet produced |

## 2. Merkle trees

- `EMPTY` = 32 zero bytes.
- `leafHash(segment) = sha256(0x00 ‖ segment)` (segment is exactly 1024 bytes).
- `nodeHash(l, r) = sha256(0x01 ‖ l ‖ r)`.
- `rootOfNodes(nodes)`: pad `nodes` to the next power of two with `EMPTY`, then
  pair adjacent nodes with `nodeHash` level by level until one node is left. One
  node is its own root (depth 0). Padding happens once, at the input level.
- **Shard root** `r_j = rootOfNodes(segments(shard_j).map(leafHash))`. Shards
  are always a multiple of 1024 bytes.
- **Blob root** `R = rootOfNodes([r_0, …, r_{n-1}])` (shard roots are used as
  nodes directly, no extra leaf hashing).
- **Proof** for node index `i` in a tree whose input level has `N` nodes
  (padded to `P = 2^d`): the `d` siblings bottom-up. Verify: `h = node`; for
  level `ℓ = 0..d-1`: if `(i >> ℓ) & 1 == 0` then `h = nodeHash(h, sib_ℓ)` else
  `h = nodeHash(sib_ℓ, h)`; accept if `h == root`.
- `depth(N) = ceil(log2(N))` (0 for N = 1).
- **Fragment proofs.** `F = 2^a · 1024`, so fragment `s` of shard `j` covers
  leaves `[s·2^a, (s+1)·2^a)`, an aligned subtree. Its root is
  `rootOfNodes(its 2^a leaf hashes)`; its proof to `r_j` is the sibling path of
  node index `s` at level `a` of the shard tree (depth `depth(N) − a`), computed
  on the padded tree (padding leaves are `EMPTY`, so padded subtrees hash to
  `Z_h`, with `Z_0 = EMPTY`, `Z_{h+1} = nodeHash(Z_h, Z_h)`).

## 3. Payload → stripes → shards

1. **Payload**: the file bytes, gzip-compressed first when that saves ≥ 10 %
   (SDK `maybeCompress`). A *bundle* payload packs many small files (§6).
2. **Stripes**: capacity `C = k·F − 28`. The payload is cut into stripes of `C`
   bytes (the last one shorter, at least 1 byte; an empty payload is one empty
   stripe). Stripe `s` ciphertext = `encryptBytes(dek, plain_s)` (fresh random
   nonce each time), right-padded with zeros to exactly `k·F` bytes.
3. **Data fragments**: stripe ciphertext split into `k` consecutive `F`-byte
   fragments, `frag(s, j)` for `j < k`.
4. **Parity fragments** `j = k … n−1`: systematic Reed-Solomon over GF(2^8),
   primitive polynomial `0x11D`, generator 2. For every byte position `x`:
   `frag(s, k+i)[x] = Σ_{j<k} C[i][j] · frag(s, j)[x]` with the Cauchy matrix
   `C[i][j] = inv(X_i ⊕ Y_j)`, `X_i = k + i`, `Y_j = j` (field addition is XOR).
   Any `k` of the `n` fragments of a stripe recover it (invert the `k×k`
   matrix made of the identity rows of the data fragments you hold and the
   Cauchy rows of the parity fragments you hold).
5. **Shard** `j` = `frag(0, j) ‖ frag(1, j) ‖ … ‖ frag(stripes−1, j)`, length
   `shard_size = stripes · F`.
6. Shard roots, blob root as in §2. Blob id =
   `keccak256(abi.encodePacked("blob", owner, R))`.

Large files are split into several blobs of at most `stripesPerBlob` stripes
(SDK default: `F = 1 MiB`, ≤ 1024 stripes → shards ≤ 1 GiB); the payload is
consumed in order, blob after blob.

## 4. File manifest v3 (sealed in the Record, like v2)

Little endian:

```
u8  version = 3
u8  flags            GZIP 4, BUNDLE 8
u64 size             plaintext file size (bundle: payload size before compression)
u32 createdAt
[32] sha256          of the plaintext (bundle: of the uncompressed bundle payload)
[32] dek
u8  nameLen, name    (≤ 200 bytes)
u8  mimeLen, mime    (≤ 100 bytes)
u64 payloadSize      bytes after compression, before encryption
u8  k, u8 m
u32 fragmentSize
u16 blobCount
blobCount × ([32] root, u32 stripes)
```

Records stay ≤ 2048 bytes, so a file has at most 48 blobs. Record schema:
`monadb.file.v3`.

## 5. Contract

### Config (blob fields)

`epochSeconds` (uint32, storage is paid per epoch), `pricePerMibEpoch`
(uint256, wei per MiB of shard per epoch), `challengeWindowBlocks` (uint16,
≤ 240: blocks to answer after the challenge's target block; the answer must
land while `BLOCKHASH` still returns that block, i.e. within 256 blocks),
`challengeCooldown` (uint32 seconds between challenges of one slot),
`challengerBountyBps` (uint16, share of forfeited rewards paid to whoever
reports a failed challenge).

### Blob entry (`blobs[keccak256("blob", owner, root)]`)

```
owner address | state uint8 (0 None, 1 Hot, 2 Cool) | needsHolders bool
dataShards uint8 (k) | totalShards uint8 (n) | held uint8 | epochs uint32
root bytes32
shardSize uint64 | payloadSize uint64 | openedAt uint40 | expiresAt uint40
rewardPerShardEpoch uint128 | escrow uint128
slots: ShardSlot[32] (the first n are used)

ShardSlot: holder address (0 = vacant) | provenAt uint40 | claimedUntil uint40
           lastChallengeAt uint40 | challengeBlock uint64 (0 = none) | challengeDeadline uint64 (block)
```

Blobs with a vacant slot are kept in an on-chain set (`pendingBlobs(offset,
limit)`), so nodes find work with `eth_call` alone (Monad RPCs have no
`eth_newFilter`); nodes skip expired ones. Read entries with `getBlob(id)` /
`getBlobs(ids)`.

### Fee

`fee = n · (baseFeePerReplica + ⌈shardSize · pricePerMibEpoch · epochs / 2^20⌉)`.
Protocol share `fee · protocolFeeBps / 10 000` accrues to the treasury
(`withdrawProtocolFees`), the rest is escrowed for the blob (`escrow`);
`rewardPerShardEpoch = ⌊escrow / (n · epochs)⌋` (dust to the protocol).

### Functions

- `openBlob(root, dataShards, totalShards, shardSize, payloadSize, epochs, maxFee)`
  (payable; also inside `upload`) — owner with an identity; state Hot,
  `needsHolders = true`, `expiresAt = now + epochs · epochSeconds`.
- `confirmShard(blob, index)` — an active replicator takes vacant slot
  `index` (one slot per replicator per blob): `provenAt = claimedUntil = now`.
  `held ≥ k` → Cool; `held == n` → `needsHolders = false`. Taking the slot
  **opens a challenge** (as `createChallenge` would): a node that confirms
  without the bytes cannot answer and loses the slot within the window, so
  slots cannot be squatted.
- `createChallenge(blob, index)` — anyone; slot held, no open challenge,
  cooldown elapsed, at most one epoch past expiry.
  `challengeBlock = block.number + CHALLENGE_DELAY_BLOCKS`,
  `challengeDeadline = challengeBlock + challengeWindowBlocks`.
- `proveShard(blob, index, segment[1024], shardProof, topProof)` — anyone
  (only a holder of the data can), in a block after `challengeBlock` and no
  later than the deadline. Segment index = `u64_le(sha256(H ‖ blob ‖
  [index])[0..8]) mod (shardSize / 1024)`, where `H = blockhash(challengeBlock)`
  and `blob` is the 32-byte blob id. Verifies `leafHash(segment)` → `r_index`
  (`shardProof`, depth `depth(shardSize/1024)`) → `R` (`topProof`, depth
  `depth(n)`). Success: `provenAt = now`, challenge cleared. The view
  `challengeSegment(blob, index)` returns the segment once `H` is readable:
  an `eth_call` at the latest block cannot read that block's own hash, so it
  succeeds one block after `challengeBlock` has been produced.
- `failChallenge(blob, index)` — anyone, after the deadline: the slot is
  vacated, its unclaimed rewards are forfeited (`challengerBountyBps` of them
  to the caller, the rest stays in escrow), `held −= 1` (below `k` → Hot),
  the blob is back in `pendingBlobs`. Monad produces every block, so a window
  of at least one block always allowed an answer (no voiding as on Solana,
  where leaders can skip slots).
- `claimShardRewards(blob, index)` — the holder is paid
  `rewardPerShardEpoch · (min(provenAt, expiresAt) − claimedUntil) / epochSeconds`
  out of the escrow; `claimedUntil` moves forward. Rewards unlock only up to
  the last proof. `claimableShardRewards(blob, index)` is the view.
- `extendBlob(blob, epochs, maxFee)` / `extendBlobs(blobs[], epochs, maxFee)`
  (payable) — owner, before expiry, at the blob's own rate:
  `escrow' = rewardPerShardEpoch · n · epochs`, fee = `escrow' + escrow' · bps / (10 000 − bps)`.
- `closeBlob(blob)` — owner: after `expiresAt + epochSeconds` (grace to
  claim), or when nobody holds a shard and it was opened more than 10 minutes
  ago. The unspent escrow goes back to the owner and the entry is deleted.

## 6. Bundles (many small files in one blob)

Payload = `u32 entryCount | entries | file bytes…` where each entry is
`u8 nameLen, name | u8 mimeLen, mime | u64 offset | u64 length | [32] sha256`
(offsets relative to the start of the file bytes). The manifest sets
`BUNDLE`; its `name` is the bundle name. One blob and one record for any
number of files.

## 7. Node HTTP API for blobs

- `PUT /blob/:blob/shard/:index?offset=<bytes>` — append shard bytes (resumable;
  `offset` must equal the bytes already received). Headers on the first
  request: `x-monadb-shard-roots: <n hex roots, comma separated>` and
  `x-monadb-fragment-size: <F>`. When the
  shard is complete the node checks `r_index` and the roots against the
  on-chain `R`, stores it and sends `confirmShard`. Responses: `202
  {received}`, `201 {stored, confirmed, transaction?}`, `400/404/409/413` like
  chunk pushes.
- `GET /blob/:blob/roots` — the `n` shard roots (hex), verifiable against `R`.
- `GET /blob/:blob/shard/:index/fragment/:stripe` — the fragment bytes;
  header `x-monadb-proof: <hex siblings, comma separated>` = its fragment proof
  to `r_index`.
- Nodes rebuild vacant slots from any `k` other shards (fragment by fragment),
  answer challenges on their slots, claim rewards, and may challenge others.

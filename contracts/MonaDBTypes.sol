// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Lifecycle of a chunk.  `None` = no chunk at this id (never opened, or closed).
enum ChunkState {
    None,
    /// Opened; ledger segments are still being written
    Pending,
    /// Complete and waiting for replicas: the bytes are in the event logs
    /// (ledger chunks) or with the nodes the uploader sent them to (direct)
    Hot,
    /// Enough replicas confirmed
    Cool
}

/// Lifecycle of a blob.  `None` = no blob at this id (never opened, or closed).
enum BlobState {
    None,
    /// Fewer than `dataShards` holders: not reconstructable from the nodes yet
    Hot,
    /// At least `dataShards` holders
    Cool
}

/// Protocol settings, changed by the admin with `updateConfig`
struct ConfigParams {
    /// Receives the protocol share of every upload (`withdrawProtocolFees`)
    address treasury;
    /// Flat fee per requested replica, in wei (covers the node's confirmation)
    uint256 baseFeePerReplica;
    /// Price per MiB per requested replica, in wei, charged pro rata to the byte
    uint256 pricePerMib;
    /// Wei per MiB of shard per epoch (blobs), charged pro rata to the byte
    uint256 pricePerMibEpoch;
    /// Share of each upload kept by the protocol, in basis points
    uint16 protocolFeeBps;
    /// Percentage of the requested replicas that turns a chunk Cool
    uint8 replicationThresholdPct;
    /// Seconds replicators have before the uploader can reclaim empty slots
    uint32 replicationWindow;
    /// Blob storage is prepaid per epoch of this many seconds
    uint32 epochSeconds;
    /// Blocks a holder has to answer a challenge after its target block
    uint16 challengeWindowBlocks;
    /// Seconds between two challenges of the same shard slot
    uint32 challengeCooldown;
    /// Share of forfeited rewards paid to whoever reports a failed challenge
    uint16 challengerBountyBps;
}

/// Public X25519 key other users seal data to
struct Identity {
    bytes32 encryptionKey;
    uint40 registeredAt;
    uint40 updatedAt;
    /// Seeds the next record id of this user
    uint64 recordNonce;
}

/// Storage node approved by the admin
struct Replicator {
    bool registered;
    bool active;
    uint40 registeredAt;
    uint64 confirmations;
    uint128 earned;
    /// HTTP endpoint that serves `/chunk/:id/data` and the blob API
    string endpoint;
}

/// One chunk of encrypted data, id = keccak256("chunk", owner, contentHash).
/// The bytes never live in contract storage: a ledger chunk is written in
/// `SegmentWritten` events, a direct chunk goes straight to the nodes.
struct Chunk {
    address owner;
    ChunkState state;
    /// Complete, not reclaimed and still short of replicas (in the work queue)
    bool needsReplicas;
    bool reclaimed;
    uint8 requiredReplicas;
    uint8 confirmedReplicas;
    uint32 size;
    /// sha256 of the full chunk
    bytes32 contentHash;
    /// Address allowed to write segments (the owner or a session key)
    address writer;
    /// Bytes per segment; 0 = direct chunk
    uint32 segmentSize;
    uint32 segmentsTotal;
    uint32 segmentsWritten;
    /// Wei escrowed in the contract for each replica
    uint128 rewardPerReplica;
    uint40 openedAt;
    uint40 completedAt;
    uint40 reclaimableAt;
    /// Blocks bounding the chunk's `SegmentWritten` events
    uint64 openedBlock;
    uint64 completedBlock;
    /// Replicators that confirmed, in order
    address[] replicators;
}

/// One erasure-coded shard position of a blob
struct ShardSlot {
    /// Replicator holding the shard; address(0) = vacant
    address holder;
    /// Last successful storage proof (or the confirmation)
    uint40 provenAt;
    /// Rewards are paid up to this time
    uint40 claimedUntil;
    uint40 lastChallengeAt;
    /// Block whose hash picks the challenged segment; 0 = no open challenge
    uint64 challengeBlock;
    /// Last block to answer the open challenge
    uint64 challengeDeadline;
}

/// An erasure-coded payload, id = keccak256("blob", owner, root)
/// (docs/blob-protocol.md).  One entry per blob whatever its size: `root`
/// commits to every shard, nodes hold one shard each and are paid per epoch
/// once they prove they still have it.
struct Blob {
    address owner;
    BlobState state;
    /// Some slot is vacant and the blob has not expired (in the work queue)
    bool needsHolders;
    /// Shards needed to reconstruct (`k`)
    uint8 dataShards;
    /// Shards stored (`n = k + m`)
    uint8 totalShards;
    /// Slots with a holder
    uint8 held;
    uint32 epochs;
    /// Merkle root over the shard roots
    bytes32 root;
    /// Bytes per shard, a multiple of 1024
    uint64 shardSize;
    /// Encrypted payload bytes (informative)
    uint64 payloadSize;
    uint40 openedAt;
    uint40 expiresAt;
    /// Escrowed reward of one shard slot for one epoch
    uint128 rewardPerShardEpoch;
    /// Wei still escrowed for this blob
    uint128 escrow;
    /// The first `totalShards` entries are used
    ShardSlot[32] slots;
}

/// Encrypted record, id = keccak256("record", owner, nonce).  `content` is
/// sealed to the owner's encryption key; readers get their own copy in a Grant.
struct Record {
    address owner;
    uint64 nonce;
    uint40 createdAt;
    uint40 updatedAt;
    /// Block of the upload: ledger segments of its chunks are logged from here on
    uint64 createdBlock;
    /// Unencrypted schema hint, e.g. `monadb.file.v3`
    string schema;
    bytes content;
}

/// A reader's copy of a record, sealed to the viewer's encryption key
struct Grant {
    uint40 grantedAt;
    uint40 updatedAt;
    bytes content;
}

/// Arguments of one chunk in `openChunk` / `upload`
struct ChunkArgs {
    /// sha256 of the full chunk
    bytes32 contentHash;
    uint32 size;
    /// Bytes per `writeSegment` (the last one may be shorter); 0 = direct chunk
    uint32 segmentSize;
    uint8 replicas;
    /// Revert if the quote is above this many wei
    uint256 maxFee;
}

/// Arguments of one blob in `openBlob` / `upload`
struct BlobArgs {
    /// Merkle root over the shard roots (docs/blob-protocol.md §2)
    bytes32 root;
    uint8 dataShards;
    uint8 totalShards;
    /// Bytes per shard, a multiple of 1024
    uint64 shardSize;
    uint64 payloadSize;
    /// Storage prepaid, in epochs of `epochSeconds`
    uint32 epochs;
    /// Revert if the quote is above this many wei
    uint256 maxFee;
}

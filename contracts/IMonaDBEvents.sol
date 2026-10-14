// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Events and custom errors of MonaDB (the SDK and the node decode both from the ABI)
interface IMonaDBEvents {
    // ── Admin ───────────────────────────────────────────────────────────────
    event ConfigUpdated(
        address indexed admin,
        address treasury,
        uint256 baseFeePerReplica,
        uint256 pricePerMib,
        uint256 pricePerMibEpoch,
        uint16 protocolFeeBps,
        uint32 epochSeconds
    );
    event ReplicatorUpdated(address indexed authority, bool active, string endpoint);
    event ProtocolFeesWithdrawn(address indexed treasury, uint256 amount);

    // ── Identity ────────────────────────────────────────────────────────────
    event IdentityRegistered(address indexed user, bytes32 encryptionKey);

    // ── Chunks ──────────────────────────────────────────────────────────────
    event ChunkOpened(
        bytes32 indexed chunk,
        address indexed owner,
        bytes32 contentHash,
        uint32 size,
        uint32 segmentSize,
        uint8 requiredReplicas,
        uint256 fee,
        uint256 protocolFee,
        uint256 rewardPerReplica
    );
    /// One ledger segment; its bytes live only in this event
    event SegmentWritten(bytes32 indexed chunk, uint32 index, bytes data);
    event ChunkCompleted(bytes32 indexed chunk, address indexed owner, uint32 size);
    event ReplicationConfirmed(
        bytes32 indexed chunk,
        address indexed replicator,
        uint256 reward,
        uint8 confirmedReplicas,
        uint8 requiredReplicas
    );
    event ChunkCooled(bytes32 indexed chunk, uint8 confirmedReplicas);
    event UnreplicatedReclaimed(bytes32 indexed chunk, address indexed owner, uint256 amount);
    event ChunkClosed(bytes32 indexed chunk, address indexed owner, uint256 refund);

    // ── Blobs ───────────────────────────────────────────────────────────────
    event BlobOpened(
        bytes32 indexed blob,
        address indexed owner,
        bytes32 root,
        uint8 dataShards,
        uint8 totalShards,
        uint64 shardSize,
        uint32 epochs,
        uint256 fee,
        uint256 protocolFee,
        uint256 rewardPerShardEpoch
    );
    event ShardConfirmed(bytes32 indexed blob, uint8 index, address indexed holder, uint8 held);
    event ShardChallenged(
        bytes32 indexed blob,
        uint8 index,
        address indexed holder,
        uint64 challengeBlock,
        uint64 deadline
    );
    event ShardProven(bytes32 indexed blob, uint8 index, address indexed holder, uint64 segment);
    event ShardLost(bytes32 indexed blob, uint8 index, address indexed holder, uint256 forfeited, uint256 bounty);
    event ShardRewardsClaimed(bytes32 indexed blob, uint8 index, address indexed holder, uint256 amount);
    event BlobExtended(bytes32 indexed blob, uint32 epochs, uint40 expiresAt, uint256 fee);
    event BlobClosed(bytes32 indexed blob, address indexed owner, uint256 refund);

    // ── Records ─────────────────────────────────────────────────────────────
    event RecordCreated(bytes32 indexed record, address indexed owner, string schema);
    event RecordUpdated(bytes32 indexed record, address indexed owner);
    event RecordDeleted(bytes32 indexed record, address indexed owner);
    event AccessGranted(bytes32 indexed record, address indexed owner, address indexed viewer);
    event AccessRevoked(bytes32 indexed record, address indexed owner, address indexed viewer);

    // ── Errors: admin ───────────────────────────────────────────────────────
    error NotAdmin();
    error InvalidParameter();
    error ZeroAddress();
    error InvalidEndpoint();
    error ReplicatorExists();
    error UnknownReplicator();
    error TransferFailed();
    error InsufficientPayment(uint256 required, uint256 paid);

    // ── Errors: identity ────────────────────────────────────────────────────
    error AlreadyRegistered();
    error NotRegistered();
    error InvalidEncryptionKey();

    // ── Errors: chunks ──────────────────────────────────────────────────────
    error InvalidSize();
    error InvalidSegmentSize();
    error TooManySegments();
    error InvalidReplicas();
    error FeeAboveMax(uint256 fee, uint256 maxFee);
    error ChunkExists();
    error ChunkNotFound();
    error NotWriter();
    error ChunkNotPending();
    error InvalidSegmentIndex();
    error SegmentAlreadyWritten();
    error InvalidSegmentLength();
    error ReplicatorInactive();
    error ChunkIncomplete();
    error AlreadyReplicated();
    error FullyReplicated();
    error ReplicationClosed();
    error ReplicationWindowOpen();
    error NothingToClaim();
    error ChunkNotSettled();
    error NotOwner();

    // ── Errors: blobs ───────────────────────────────────────────────────────
    error InvalidShardLayout();
    error InvalidEpochs();
    error BlobExists();
    error BlobNotFound();
    error InvalidShardIndex();
    error SlotOccupied();
    error SlotVacant();
    error NotHolder();
    error AlreadyHolder();
    error BlobExpired();
    error ChallengeOpen();
    error ChallengeCooldown();
    error NoChallenge();
    error ChallengeNotReady();
    error ChallengeExpired();
    error ChallengeStillOpen();
    error InvalidProof();
    error InvalidSegment();
    error BlobNotClosable();

    // ── Errors: records ─────────────────────────────────────────────────────
    error RecordNotFound();
    error InvalidContent();
    error InvalidSchema();
    error CannotGrantSelf();
    error GrantNotFound();
}

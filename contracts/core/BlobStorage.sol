// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {MonaDBBase} from "./MonaDBBase.sol";
import {BlobMerkle} from "../libraries/BlobMerkle.sol";
import {Blob, BlobArgs, BlobState, ShardSlot} from "../MonaDBTypes.sol";

/**
 * @title BlobStorage
 * @notice Erasure-coded blobs with storage proofs (docs/blob-protocol.md).
 *
 *  A blob stores a payload as `n = k + m` Reed-Solomon shards on `n` nodes,
 *  with one on-chain entry per blob (a Merkle root).  Storage is prepaid per
 *  epoch and escrowed in the blob; a holder's rewards unlock only up to its
 *  last storage proof.  Anyone can challenge a holder: the segment it must
 *  answer with is picked by the hash of a block that does not exist yet, and
 *  the answer must land within `challengeWindowBlocks`.  A holder that lets a
 *  challenge expire loses its slot (and a bounty goes to the reporter), so
 *  another node can rebuild the shard from any `k` others and take it.
 */
abstract contract BlobStorage is MonaDBBase {
    using EnumerableSet for EnumerableSet.Bytes32Set;

    mapping(bytes32 id => Blob) internal _blobs;
    /// Blobs with a vacant slot (nodes skip the expired ones)
    EnumerableSet.Bytes32Set internal _pendingBlobs;
    /// Open blobs per owner
    mapping(address owner => EnumerableSet.Bytes32Set) internal _ownerBlobs;

    function blobId(address owner, bytes32 root) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("blob", owner, root));
    }

    // ── open ────────────────────────────────────────────────────────────────

    /// Reserve a blob and prepay its storage; extra value is returned
    function openBlob(BlobArgs calldata args) external payable nonReentrant returns (bytes32 id) {
        uint256 fee;
        (id, fee) = _openBlob(msg.sender, args);
        _settle(fee, msg.sender);
    }

    function _openBlob(address owner, BlobArgs calldata args) internal returns (bytes32 id, uint256 fee) {
        _requireIdentity(owner);
        if (
            args.dataShards == 0 ||
            args.dataShards > args.totalShards ||
            args.totalShards > MAX_SHARDS ||
            args.shardSize == 0 ||
            args.shardSize % SEGMENT_SIZE != 0 ||
            args.shardSize > MAX_SHARD_SIZE
        ) revert InvalidShardLayout();
        if (args.epochs == 0 || args.epochs > MAX_BLOB_EPOCHS) revert InvalidEpochs();

        id = blobId(owner, args.root);
        Blob storage b = _blobs[id];
        if (b.state != BlobState.None) revert BlobExists();

        fee = quoteBlob(args.shardSize, args.totalShards, args.epochs);
        if (fee > args.maxFee) revert FeeAboveMax(fee, args.maxFee);
        uint256 slotEpochs = uint256(args.totalShards) * args.epochs;
        uint256 rewardPerShardEpoch = (fee - (fee * _config.protocolFeeBps) / 10_000) / slotEpochs;
        uint256 escrow = rewardPerShardEpoch * slotEpochs;
        uint256 protocolFee = fee - escrow;
        protocolFees += protocolFee;

        b.owner = owner;
        b.dataShards = args.dataShards;
        b.totalShards = args.totalShards;
        b.epochs = args.epochs;
        b.root = args.root;
        b.shardSize = args.shardSize;
        b.payloadSize = args.payloadSize;
        b.openedAt = uint40(block.timestamp);
        b.expiresAt = uint40(block.timestamp + uint256(args.epochs) * _config.epochSeconds);
        b.rewardPerShardEpoch = uint128(rewardPerShardEpoch);
        b.escrow = uint128(escrow);
        _refresh(id, b);
        _ownerBlobs[owner].add(id);

        emit BlobOpened(
            id,
            owner,
            args.root,
            args.dataShards,
            args.totalShards,
            args.shardSize,
            args.epochs,
            fee,
            protocolFee,
            rewardPerShardEpoch
        );
    }

    // ── confirmShard ────────────────────────────────────────────────────────

    /**
     * An active replicator stored shard `index` and checked it against the
     * blob root: it takes the slot.  Taking it opens a challenge right away,
     * so a node that confirms without the bytes cannot answer and loses the
     * slot within `challengeWindowBlocks` (no squatting).
     */
    function confirmShard(bytes32 id, uint8 index) external {
        _requireActiveReplicator(msg.sender);
        Blob storage b = _existing(id);
        if (index >= b.totalShards) revert InvalidShardIndex();
        if (block.timestamp >= b.expiresAt) revert BlobExpired();
        ShardSlot storage slot = b.slots[index];
        if (slot.holder != address(0)) revert SlotOccupied();
        for (uint256 i = 0; i < b.totalShards; i++) if (b.slots[i].holder == msg.sender) revert AlreadyHolder();

        uint64 challengeBlock = uint64(block.number) + CHALLENGE_DELAY_BLOCKS;
        slot.holder = msg.sender;
        slot.provenAt = uint40(block.timestamp);
        slot.claimedUntil = uint40(block.timestamp);
        slot.lastChallengeAt = uint40(block.timestamp);
        slot.challengeBlock = challengeBlock;
        slot.challengeDeadline = challengeBlock + _config.challengeWindowBlocks;
        b.held++;
        _refresh(id, b);
        _replicators[msg.sender].confirmations++;

        emit ShardConfirmed(id, index, msg.sender, b.held);
        emit ShardChallenged(id, index, msg.sender, challengeBlock, slot.challengeDeadline);
    }

    // ── challenges ──────────────────────────────────────────────────────────

    /// Ask the holder of shard `index` to prove it still has it.  The segment
    /// to answer with is picked by the hash of a block that does not exist
    /// yet, so neither side can choose it.
    function createChallenge(bytes32 id, uint8 index) external {
        Blob storage b = _existing(id);
        if (index >= b.totalShards) revert InvalidShardIndex();
        // challenges stay possible one epoch past expiry, so holders can prove the last stretch
        if (block.timestamp >= uint256(b.expiresAt) + _config.epochSeconds) revert BlobExpired();
        ShardSlot storage slot = b.slots[index];
        if (slot.holder == address(0)) revert SlotVacant();
        if (slot.challengeBlock != 0) revert ChallengeOpen();
        if (block.timestamp < uint256(slot.lastChallengeAt) + _config.challengeCooldown) revert ChallengeCooldown();

        slot.challengeBlock = uint64(block.number) + CHALLENGE_DELAY_BLOCKS;
        slot.challengeDeadline = slot.challengeBlock + _config.challengeWindowBlocks;
        slot.lastChallengeAt = uint40(block.timestamp);
        emit ShardChallenged(id, index, slot.holder, slot.challengeBlock, slot.challengeDeadline);
    }

    /**
     * Answer the open challenge of shard `index` with the challenged 1 KiB
     * segment and its Merkle path to the blob root.  Only someone holding the
     * shard's bytes can do it.
     */
    function proveShard(
        bytes32 id,
        uint8 index,
        bytes calldata segment,
        bytes32[] calldata shardProof,
        bytes32[] calldata topProof
    ) external {
        Blob storage b = _existing(id);
        if (index >= b.totalShards) revert InvalidShardIndex();
        ShardSlot storage slot = b.slots[index];
        if (slot.holder == address(0)) revert SlotVacant();
        if (slot.challengeBlock == 0) revert NoChallenge();
        if (block.number > slot.challengeDeadline) revert ChallengeExpired();
        if (segment.length != SEGMENT_SIZE) revert InvalidSegment();

        uint256 segments = b.shardSize / SEGMENT_SIZE;
        uint64 segmentIndex = _challengeSegment(id, index, slot, segments);
        if (
            shardProof.length != BlobMerkle.depth(segments) || topProof.length != BlobMerkle.depth(b.totalShards)
        ) revert InvalidProof();
        bytes32 shardRoot = BlobMerkle.fold(BlobMerkle.leafHash(segment), segmentIndex, shardProof);
        if (BlobMerkle.fold(shardRoot, index, topProof) != b.root) revert InvalidProof();

        slot.provenAt = uint40(block.timestamp);
        slot.challengeBlock = 0;
        slot.challengeDeadline = 0;
        emit ShardProven(id, index, slot.holder, segmentIndex);
    }

    /// The segment the open challenge of shard `index` asks for (once its
    /// block exists).  Nodes call this instead of hashing block headers.
    function challengeSegment(bytes32 id, uint8 index) external view returns (uint64) {
        Blob storage b = _existing(id);
        if (index >= b.totalShards) revert InvalidShardIndex();
        return _challengeSegment(id, index, b.slots[index], b.shardSize / SEGMENT_SIZE);
    }

    function _challengeSegment(
        bytes32 id,
        uint8 index,
        ShardSlot storage slot,
        uint256 segments
    ) private view returns (uint64) {
        if (slot.challengeBlock == 0) revert NoChallenge();
        if (block.number <= slot.challengeBlock) revert ChallengeNotReady();
        bytes32 hash = blockhash(slot.challengeBlock);
        if (hash == bytes32(0)) revert ChallengeExpired();
        return BlobMerkle.challengeSegment(hash, id, index, segments);
    }

    /**
     * The holder of shard `index` let a challenge expire: it loses the slot
     * and its unclaimed rewards (a share goes to whoever reports it).  The
     * slot reopens, so another node can rebuild the shard from the others.
     * Every block is produced on Monad, so a window of at least one block
     * always allowed an answer.
     */
    function failChallenge(bytes32 id, uint8 index) external nonReentrant {
        Blob storage b = _existing(id);
        if (index >= b.totalShards) revert InvalidShardIndex();
        ShardSlot storage slot = b.slots[index];
        if (slot.holder == address(0)) revert SlotVacant();
        if (slot.challengeBlock == 0) revert NoChallenge();
        if (block.number <= slot.challengeDeadline) revert ChallengeStillOpen();

        address holder = slot.holder;
        uint256 until = block.timestamp < b.expiresAt ? block.timestamp : b.expiresAt;
        uint256 forfeited = _rewardBetween(b, slot.claimedUntil, until);
        uint256 bounty = (forfeited * _config.challengerBountyBps) / 10_000;
        if (bounty > b.escrow) bounty = b.escrow;

        delete b.slots[index];
        b.held--;
        b.escrow -= uint128(bounty);
        _refresh(id, b);
        if (bounty > 0) _send(msg.sender, bounty);
        emit ShardLost(id, index, holder, forfeited, bounty);
    }

    // ── rewards ─────────────────────────────────────────────────────────────

    /// Pay the holder of shard `index` what it earned up to its last storage
    /// proof (never past expiry)
    function claimShardRewards(bytes32 id, uint8 index) external nonReentrant {
        Blob storage b = _existing(id);
        if (index >= b.totalShards) revert InvalidShardIndex();
        ShardSlot storage slot = b.slots[index];
        if (slot.holder != msg.sender) revert NotHolder();

        uint40 until = slot.provenAt < b.expiresAt ? slot.provenAt : b.expiresAt;
        uint256 amount = _rewardBetween(b, slot.claimedUntil, until);
        if (amount == 0) revert NothingToClaim();
        if (amount > b.escrow) amount = b.escrow;

        slot.claimedUntil = until;
        b.escrow -= uint128(amount);
        _replicators[msg.sender].earned += uint128(amount);
        _send(msg.sender, amount);
        emit ShardRewardsClaimed(id, index, msg.sender, amount);
    }

    /// What the holder of shard `index` can claim now
    function claimableShardRewards(bytes32 id, uint8 index) external view returns (uint256) {
        Blob storage b = _blobs[id];
        if (b.state == BlobState.None || index >= b.totalShards) return 0;
        ShardSlot storage slot = b.slots[index];
        uint40 until = slot.provenAt < b.expiresAt ? slot.provenAt : b.expiresAt;
        uint256 amount = _rewardBetween(b, slot.claimedUntil, until);
        return amount > b.escrow ? b.escrow : amount;
    }

    function _rewardBetween(Blob storage b, uint256 from, uint256 to) private view returns (uint256) {
        if (to <= from) return 0;
        return (uint256(b.rewardPerShardEpoch) * (to - from)) / _config.epochSeconds;
    }

    // ── extend / close ──────────────────────────────────────────────────────

    /// Prepay more epochs at the blob's own reward rate; extra value is returned
    function extendBlob(bytes32 id, uint32 epochs, uint256 maxFee) external payable nonReentrant {
        uint256 fee = _extend(id, epochs);
        if (fee > maxFee) revert FeeAboveMax(fee, maxFee);
        _settle(fee, msg.sender);
    }

    /// Prepay `epochs` more epochs for several blobs (e.g. every blob of a file)
    function extendBlobs(bytes32[] calldata blobIds, uint32 epochs, uint256 maxFee) external payable nonReentrant {
        uint256 fee;
        for (uint256 i = 0; i < blobIds.length; i++) fee += _extend(blobIds[i], epochs);
        if (fee > maxFee) revert FeeAboveMax(fee, maxFee);
        _settle(fee, msg.sender);
    }

    function _extend(bytes32 id, uint32 epochs) private returns (uint256 fee) {
        Blob storage b = _existing(id);
        if (b.owner != msg.sender) revert NotOwner();
        if (epochs == 0 || uint256(b.epochs) + epochs > MAX_BLOB_EPOCHS) revert InvalidEpochs();
        if (block.timestamp >= b.expiresAt) revert BlobExpired();

        fee = quoteExtension(id, epochs);
        uint256 escrow = uint256(b.rewardPerShardEpoch) * b.totalShards * epochs;
        protocolFees += fee - escrow;

        b.epochs += epochs;
        b.escrow += uint128(escrow);
        b.expiresAt += uint40(uint256(epochs) * _config.epochSeconds);
        _refresh(id, b);
        emit BlobExtended(id, b.epochs, b.expiresAt, fee);
    }

    /// Price of `epochs` more epochs: the blob's escrow rate plus the protocol share
    function quoteExtension(bytes32 id, uint32 epochs) public view returns (uint256) {
        Blob storage b = _blobs[id];
        uint256 escrow = uint256(b.rewardPerShardEpoch) * b.totalShards * epochs;
        return escrow + (escrow * _config.protocolFeeBps) / (10_000 - _config.protocolFeeBps);
    }

    /**
     * Close the blob and recover the unspent escrow: one epoch after expiry
     * (holders' grace to claim), or when nobody holds a shard and the upload
     * is more than DIRECT_ABORT_DELAY old (a failed upload).
     */
    function closeBlob(bytes32 id) external nonReentrant {
        Blob storage b = _existing(id);
        if (b.owner != msg.sender) revert NotOwner();
        if (!_blobClosable(b)) revert BlobNotClosable();
        uint256 refund = b.escrow;
        _pendingBlobs.remove(id);
        _ownerBlobs[msg.sender].remove(id);
        delete _blobs[id];
        if (refund > 0) _send(msg.sender, refund);
        emit BlobClosed(id, msg.sender, refund);
    }

    function _blobClosable(Blob storage b) private view returns (bool) {
        bool expired = block.timestamp >= uint256(b.expiresAt) + _config.epochSeconds;
        bool abandoned = b.held == 0 && block.timestamp >= uint256(b.openedAt) + DIRECT_ABORT_DELAY;
        return expired || abandoned;
    }

    function _existing(bytes32 id) private view returns (Blob storage b) {
        b = _blobs[id];
        if (b.state == BlobState.None) revert BlobNotFound();
    }

    function _refresh(bytes32 id, Blob storage b) private {
        b.state = b.held >= b.dataShards ? BlobState.Cool : BlobState.Hot;
        bool needs = b.held < b.totalShards && block.timestamp < b.expiresAt;
        b.needsHolders = needs;
        if (needs) _pendingBlobs.add(id);
        else _pendingBlobs.remove(id);
    }

    // ── Views ───────────────────────────────────────────────────────────────

    function getBlob(bytes32 id) external view returns (Blob memory) {
        return _blobs[id];
    }

    function getBlobs(bytes32[] calldata ids) external view returns (Blob[] memory out) {
        out = new Blob[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) out[i] = _blobs[ids[i]];
    }

    function isBlobClosable(bytes32 id) external view returns (bool) {
        Blob storage b = _blobs[id];
        return b.state != BlobState.None && _blobClosable(b);
    }

    function pendingBlobCount() external view returns (uint256) {
        return _pendingBlobs.length();
    }

    /// The node work queue: blobs with a vacant shard slot (skip expired ones)
    function pendingBlobs(uint256 offset, uint256 limit) external view returns (bytes32[] memory) {
        return _page(_pendingBlobs, offset, limit);
    }

    function blobCountOf(address owner) external view returns (uint256) {
        return _ownerBlobs[owner].length();
    }

    function blobsOf(address owner, uint256 offset, uint256 limit) external view returns (bytes32[] memory) {
        return _page(_ownerBlobs[owner], offset, limit);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {MonaDBBase} from "./MonaDBBase.sol";
import {Chunk, ChunkArgs, ChunkState} from "../MonaDBTypes.sol";

/**
 * @title ChunkStorage
 * @notice Replicated chunks and their economics.
 *
 *  - A chunk is opened (and paid for) with the sha256 of its bytes.  The
 *    protocol share accrues to the treasury; the replica rewards stay
 *    escrowed in the contract, one per requested replica.
 *  - **Direct** chunks (`segmentSize == 0`) are Hot right away: the uploader
 *    sends the bytes to replicator nodes over HTTP, and a node only stores
 *    bytes that hash to a chunk somebody paid for.
 *  - **Ledger** chunks are written with `writeSegment`, whose bytes live only
 *    in the `SegmentWritten` event.  Each index is accepted once, so every
 *    node rebuilds the same bytes; the last write turns the chunk Hot.
 *  - `confirmReplication` pays the node its reward right away.  Once
 *    `replicationThresholdPct` of the replicas confirmed the chunk is Cool;
 *    the last confirmation deletes it (the data stays on the nodes).
 *  - Open work is kept in an on-chain set (`pendingChunks`), so nodes need no
 *    log cursor to find it.
 */
abstract contract ChunkStorage is MonaDBBase {
    using EnumerableSet for EnumerableSet.Bytes32Set;

    mapping(bytes32 id => Chunk) internal _chunks;
    /// Bit `i` of word `i / 256` is set once segment `i` is written
    mapping(bytes32 id => mapping(uint256 word => uint256 bits)) internal _segmentBits;
    /// Complete chunks still short of replicas
    EnumerableSet.Bytes32Set internal _pendingChunks;
    /// Open chunks per owner (to reclaim deposits of files that were deleted)
    mapping(address owner => EnumerableSet.Bytes32Set) internal _ownerChunks;

    function chunkId(address owner, bytes32 contentHash) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("chunk", owner, contentHash));
    }

    // ── open ────────────────────────────────────────────────────────────────

    /// Open and pay one chunk; extra value is returned.  `writer` (default:
    /// the caller) is the address allowed to write ledger segments.
    function openChunk(ChunkArgs calldata args, address writer) external payable nonReentrant returns (bytes32 id) {
        uint256 fee;
        (id, fee) = _openChunk(msg.sender, args, writer == address(0) ? msg.sender : writer);
        _settle(fee, msg.sender);
    }

    function _openChunk(address owner, ChunkArgs calldata args, address writer) internal returns (bytes32 id, uint256 fee) {
        _requireIdentity(owner);
        bool direct = args.segmentSize == 0;
        if (args.size == 0 || args.size > (direct ? MAX_DIRECT_CHUNK_SIZE : MAX_CHUNK_SIZE)) revert InvalidSize();
        if (!direct && (args.segmentSize < MIN_SEGMENT_SIZE || args.segmentSize > MAX_SEGMENT_SIZE)) {
            revert InvalidSegmentSize();
        }
        uint256 segments = direct ? 0 : _ceilDiv(args.size, args.segmentSize);
        if (segments > MAX_SEGMENTS) revert TooManySegments();
        if (args.replicas == 0 || args.replicas > MAX_REPLICAS) revert InvalidReplicas();

        id = chunkId(owner, args.contentHash);
        Chunk storage c = _chunks[id];
        if (c.state != ChunkState.None) revert ChunkExists();

        fee = quoteChunk(args.size, args.replicas);
        if (fee > args.maxFee) revert FeeAboveMax(fee, args.maxFee);
        (uint256 protocolFee, uint256 reward) = _splitFee(fee, args.replicas);
        protocolFees += protocolFee;

        c.owner = owner;
        c.state = direct ? ChunkState.Hot : ChunkState.Pending;
        c.requiredReplicas = args.replicas;
        c.size = args.size;
        c.contentHash = args.contentHash;
        c.writer = writer;
        c.segmentSize = args.segmentSize;
        c.segmentsTotal = uint32(segments);
        c.rewardPerReplica = uint128(reward);
        c.openedAt = uint40(block.timestamp);
        c.reclaimableAt = uint40(block.timestamp + _config.replicationWindow);
        c.openedBlock = uint64(block.number);
        _ownerChunks[owner].add(id);

        emit ChunkOpened(id, owner, args.contentHash, args.size, args.segmentSize, args.replicas, fee, protocolFee, reward);
        if (direct) {
            c.completedAt = uint40(block.timestamp);
            c.completedBlock = uint64(block.number);
            _setNeedsReplicas(id, c, true);
            emit ChunkCompleted(id, owner, args.size);
        }
    }

    // ── writeSegment ────────────────────────────────────────────────────────

    /**
     * Put segment `index` of a ledger chunk in the logs.  `data` is only
     * checked for its length and never stored: nodes read it back from the
     * `SegmentWritten` event.  Each index can be written once.
     */
    function writeSegment(bytes32 id, uint32 index, bytes calldata data) external {
        Chunk storage c = _chunks[id];
        if (c.state == ChunkState.None) revert ChunkNotFound();
        if (c.writer != msg.sender) revert NotWriter();
        if (c.state != ChunkState.Pending || c.reclaimed) revert ChunkNotPending();
        if (index >= c.segmentsTotal) revert InvalidSegmentIndex();
        uint256 word = index >> 8;
        uint256 bit = uint256(1) << (index & 255);
        uint256 bits = _segmentBits[id][word];
        if (bits & bit != 0) revert SegmentAlreadyWritten();
        uint256 start = uint256(index) * c.segmentSize;
        uint256 expected = c.size - start < c.segmentSize ? c.size - start : c.segmentSize;
        if (data.length != expected) revert InvalidSegmentLength();

        _segmentBits[id][word] = bits | bit;
        emit SegmentWritten(id, index, data);

        if (++c.segmentsWritten == c.segmentsTotal) {
            c.state = ChunkState.Hot;
            c.completedAt = uint40(block.timestamp);
            c.completedBlock = uint64(block.number);
            _setNeedsReplicas(id, c, true);
            emit ChunkCompleted(id, c.owner, c.size);
        }
    }

    // ── confirmReplication ──────────────────────────────────────────────────

    /// A replicator stored the chunk (and checked its sha256): it is paid its
    /// reward right away
    function confirmReplication(bytes32 id) external nonReentrant {
        _requireActiveReplicator(msg.sender);
        (, uint256 reward) = _confirm(id, true);
        _payReplicator(reward);
    }

    /**
     * Confirm many chunks in one transaction.  Chunks that no longer accept
     * this node (filled by others meanwhile, closed, already confirmed) are
     * skipped instead of reverting the batch.
     */
    function confirmReplications(bytes32[] calldata ids) external nonReentrant returns (uint256 confirmed) {
        _requireActiveReplicator(msg.sender);
        uint256 total;
        for (uint256 i = 0; i < ids.length; i++) {
            (bool ok, uint256 reward) = _confirm(ids[i], false);
            if (ok) {
                confirmed++;
                total += reward;
            }
        }
        _payReplicator(total);
    }

    function _confirm(bytes32 id, bool strict) private returns (bool, uint256) {
        Chunk storage c = _chunks[id];
        bytes4 problem;
        if (c.state == ChunkState.None) problem = ChunkNotFound.selector;
        else if (c.state == ChunkState.Pending) problem = ChunkIncomplete.selector;
        else if (c.reclaimed) problem = ReplicationClosed.selector;
        else if (c.confirmedReplicas >= c.requiredReplicas) problem = FullyReplicated.selector;
        else if (_hasConfirmed(c, msg.sender)) problem = AlreadyReplicated.selector;
        if (problem != bytes4(0)) {
            if (!strict) return (false, 0);
            assembly ("memory-safe") {
                mstore(0, problem)
                revert(0, 4)
            }
        }

        c.replicators.push(msg.sender);
        uint8 confirmedReplicas = ++c.confirmedReplicas;
        uint256 reward = c.rewardPerReplica;
        _replicators[msg.sender].confirmations++;
        emit ReplicationConfirmed(id, msg.sender, reward, confirmedReplicas, c.requiredReplicas);

        if (c.state == ChunkState.Hot && confirmedReplicas >= _coolThreshold(c.requiredReplicas)) {
            c.state = ChunkState.Cool;
            emit ChunkCooled(id, confirmedReplicas);
        }
        if (confirmedReplicas == c.requiredReplicas) {
            // every replica exists: nothing left in escrow, the entry goes away
            address owner = c.owner;
            _deleteChunk(id, c);
            emit ChunkClosed(id, owner, 0);
        }
        return (true, reward);
    }

    function _hasConfirmed(Chunk storage c, address node) private view returns (bool) {
        uint256 n = c.replicators.length;
        for (uint256 i = 0; i < n; i++) if (c.replicators[i] == node) return true;
        return false;
    }

    function _payReplicator(uint256 amount) private {
        if (amount == 0) return;
        _replicators[msg.sender].earned += uint128(amount);
        _send(msg.sender, amount);
    }

    // ── reclaim / close ─────────────────────────────────────────────────────

    /// After the replication window, recover the rewards of the replicas
    /// nobody confirmed.  Closes the chunk to further confirmations.
    function reclaimUnreplicated(bytes32 id) external nonReentrant {
        Chunk storage c = _chunks[id];
        if (c.state == ChunkState.None) revert ChunkNotFound();
        if (c.owner != msg.sender) revert NotOwner();
        if (block.timestamp < c.reclaimableAt) revert ReplicationWindowOpen();
        if (c.reclaimed) revert ReplicationClosed();
        uint256 amount = uint256(c.requiredReplicas - c.confirmedReplicas) * c.rewardPerReplica;
        if (amount == 0) revert NothingToClaim();

        c.reclaimed = true;
        _setNeedsReplicas(id, c, false);
        _send(msg.sender, amount);
        emit UnreplicatedReclaimed(id, msg.sender, amount);
    }

    /**
     * Close a chunk and get back any unspent escrow.  Allowed while the
     * upload is still Pending (abort), for a direct chunk no replica
     * confirmed within DIRECT_ABORT_DELAY (failed upload), or after the
     * replication window.  The data stays on the replicators; readers verify
     * it against the hash in their manifest.
     */
    function closeChunk(bytes32 id) external nonReentrant {
        Chunk storage c = _chunks[id];
        if (c.state == ChunkState.None) revert ChunkNotFound();
        if (c.owner != msg.sender) revert NotOwner();
        if (!_closable(c)) revert ChunkNotSettled();
        uint256 refund = c.reclaimed ? 0 : uint256(c.requiredReplicas - c.confirmedReplicas) * c.rewardPerReplica;
        _deleteChunk(id, c);
        if (refund > 0) _send(msg.sender, refund);
        emit ChunkClosed(id, msg.sender, refund);
    }

    function _closable(Chunk storage c) internal view returns (bool) {
        bool directFailed = c.segmentSize == 0 &&
            c.confirmedReplicas == 0 &&
            block.timestamp >= uint256(c.openedAt) + DIRECT_ABORT_DELAY;
        return c.state == ChunkState.Pending || directFailed || block.timestamp >= c.reclaimableAt;
    }

    function _setNeedsReplicas(bytes32 id, Chunk storage c, bool needs) private {
        c.needsReplicas = needs;
        if (needs) _pendingChunks.add(id);
        else _pendingChunks.remove(id);
    }

    function _deleteChunk(bytes32 id, Chunk storage c) private {
        uint256 words = (uint256(c.segmentsTotal) + 255) >> 8;
        for (uint256 w = 0; w < words; w++) delete _segmentBits[id][w];
        _pendingChunks.remove(id);
        _ownerChunks[c.owner].remove(id);
        delete _chunks[id];
    }

    // ── Views ───────────────────────────────────────────────────────────────

    function getChunk(bytes32 id) external view returns (Chunk memory) {
        return _chunks[id];
    }

    /// Several chunks at once (state None = closed or never opened)
    function getChunks(bytes32[] calldata ids) external view returns (Chunk[] memory out) {
        out = new Chunk[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) out[i] = _chunks[ids[i]];
    }

    function isSegmentWritten(bytes32 id, uint32 index) external view returns (bool) {
        return _segmentBits[id][index >> 8] & (uint256(1) << (index & 255)) != 0;
    }

    function isChunkClosable(bytes32 id) external view returns (bool) {
        Chunk storage c = _chunks[id];
        return c.state != ChunkState.None && _closable(c);
    }

    function pendingChunkCount() external view returns (uint256) {
        return _pendingChunks.length();
    }

    /// The node work queue: complete chunks still short of replicas
    function pendingChunks(uint256 offset, uint256 limit) external view returns (bytes32[] memory) {
        return _page(_pendingChunks, offset, limit);
    }

    function chunkCountOf(address owner) external view returns (uint256) {
        return _ownerChunks[owner].length();
    }

    /// Chunks of `owner` that still exist (not fully replicated, not closed)
    function chunksOf(address owner, uint256 offset, uint256 limit) external view returns (bytes32[] memory) {
        return _page(_ownerChunks[owner], offset, limit);
    }
}

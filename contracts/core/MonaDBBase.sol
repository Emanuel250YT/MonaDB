// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IMonaDBEvents} from "../IMonaDBEvents.sol";
import {ConfigParams, Identity, Replicator} from "../MonaDBTypes.sol";

/**
 * @title MonaDBBase
 * @notice Configuration, admin, identities, the replicator registry and the
 *         fee arithmetic shared by the storage, blob and record modules.
 */
abstract contract MonaDBBase is IMonaDBEvents, ReentrancyGuardTransient {
    using EnumerableSet for EnumerableSet.Bytes32Set;

    // ── Bounds ──────────────────────────────────────────────────────────────

    /// Replicas requested per chunk
    uint8 public constant MAX_REPLICAS = 16;
    /// Protocol share of an upload (30 %)
    uint16 public constant MAX_PROTOCOL_FEE_BPS = 3_000;
    uint32 public constant MIN_REPLICATION_WINDOW = 1 hours;
    uint32 public constant MAX_REPLICATION_WINDOW = 90 days;
    /// Largest chunk written to the ledger (event logs)
    uint32 public constant MAX_CHUNK_SIZE = 4 * 1024 * 1024;
    /// Largest direct chunk (bytes sent straight to replicators)
    uint32 public constant MAX_DIRECT_CHUNK_SIZE = 16 * 1024 * 1024;
    /// Seconds after which an unconfirmed direct chunk or unheld blob can be closed
    uint40 public constant DIRECT_ABORT_DELAY = 600;
    uint256 internal constant BYTES_PER_MIB = 1024 * 1024;
    /// Bytes carried by one `writeSegment`: calldata costs ~40 gas per byte
    /// on Monad, so 96 KiB is ~4M gas, well under the 30M transaction cap
    uint32 public constant MIN_SEGMENT_SIZE = 32;
    uint32 public constant MAX_SEGMENT_SIZE = 96 * 1024;
    uint32 public constant MAX_SEGMENTS = 4_096;
    uint256 public constant MAX_ENDPOINT_LEN = 128;
    uint256 public constant MAX_SCHEMA_LEN = 32;
    uint256 public constant MAX_RECORD_CONTENT = 2_048;

    // ── Blobs (docs/blob-protocol.md) ───────────────────────────────────────

    /// Bytes per Merkle leaf of a shard, and per storage-proof answer
    uint64 public constant SEGMENT_SIZE = 1_024;
    uint8 public constant MAX_SHARDS = 32;
    uint64 public constant MAX_SHARD_SIZE = uint64(1) << 40;
    uint32 public constant MAX_BLOB_EPOCHS = 1_200;
    /// A challenge's randomness is the hash of a block that does not exist yet
    uint64 public constant CHALLENGE_DELAY_BLOCKS = 2;
    /// Answers must land while BLOCKHASH still returns the challenge block (256 blocks)
    uint16 public constant MAX_CHALLENGE_WINDOW_BLOCKS = 240;
    uint32 public constant MIN_EPOCH_SECONDS = 60;
    uint32 public constant MAX_EPOCH_SECONDS = 366 days;

    // ── State ───────────────────────────────────────────────────────────────

    address public admin;
    ConfigParams internal _config;
    /// Protocol share accrued and not yet sent to the treasury
    uint256 public protocolFees;

    mapping(address user => Identity) internal _identities;
    mapping(address authority => Replicator) internal _replicators;
    address[] internal _replicatorList;

    constructor(ConfigParams memory params) {
        _validateConfig(params);
        admin = msg.sender;
        _config = params;
        _emitConfig();
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    // ── Admin ───────────────────────────────────────────────────────────────

    function updateConfig(ConfigParams calldata params) external onlyAdmin {
        _validateConfig(params);
        _config = params;
        _emitConfig();
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        admin = newAdmin;
        _emitConfig();
    }

    /// Approve a node wallet; any address can run a replicator
    function registerReplicator(address authority, string calldata endpoint) external onlyAdmin {
        if (authority == address(0)) revert ZeroAddress();
        _validateEndpoint(endpoint);
        Replicator storage r = _replicators[authority];
        if (r.registered) revert ReplicatorExists();
        r.registered = true;
        r.active = true;
        r.registeredAt = uint40(block.timestamp);
        r.endpoint = endpoint;
        _replicatorList.push(authority);
        emit ReplicatorUpdated(authority, true, endpoint);
    }

    function setReplicatorActive(address authority, bool active) external onlyAdmin {
        Replicator storage r = _replicators[authority];
        if (!r.registered) revert UnknownReplicator();
        r.active = active;
        emit ReplicatorUpdated(authority, active, r.endpoint);
    }

    /// A node publishes where it serves data
    function updateReplicatorEndpoint(string calldata endpoint) external {
        Replicator storage r = _replicators[msg.sender];
        if (!r.registered) revert UnknownReplicator();
        _validateEndpoint(endpoint);
        r.endpoint = endpoint;
        emit ReplicatorUpdated(msg.sender, r.active, endpoint);
    }

    /// Send the accrued protocol share to the treasury (anyone can call)
    function withdrawProtocolFees() external nonReentrant {
        uint256 amount = protocolFees;
        if (amount == 0) revert NothingToClaim();
        protocolFees = 0;
        _send(_config.treasury, amount);
        emit ProtocolFeesWithdrawn(_config.treasury, amount);
    }

    // ── Identity ────────────────────────────────────────────────────────────

    /**
     * Publish the caller's X25519 public key.  The transaction signature
     * already proves control of the wallet, and a wrong key only hurts its
     * owner (data sealed to a key they cannot open), so no proof of
     * possession is needed.
     */
    function registerIdentity(bytes32 encryptionKey) external {
        if (encryptionKey == bytes32(0)) revert InvalidEncryptionKey();
        Identity storage id = _identities[msg.sender];
        if (id.registeredAt != 0) revert AlreadyRegistered();
        id.encryptionKey = encryptionKey;
        id.registeredAt = uint40(block.timestamp);
        id.updatedAt = uint40(block.timestamp);
        emit IdentityRegistered(msg.sender, encryptionKey);
    }

    /// Rotate the caller's encryption key (records sealed to the old key must
    /// be re-sealed by their owners)
    function updateIdentity(bytes32 encryptionKey) external {
        if (encryptionKey == bytes32(0)) revert InvalidEncryptionKey();
        Identity storage id = _identities[msg.sender];
        if (id.registeredAt == 0) revert NotRegistered();
        id.encryptionKey = encryptionKey;
        id.updatedAt = uint40(block.timestamp);
        emit IdentityRegistered(msg.sender, encryptionKey);
    }

    // ── Views ───────────────────────────────────────────────────────────────

    function getConfig() external view returns (ConfigParams memory) {
        return _config;
    }

    function getIdentity(address user) external view returns (Identity memory) {
        return _identities[user];
    }

    function getReplicator(address authority) external view returns (Replicator memory) {
        return _replicators[authority];
    }

    function replicatorCount() external view returns (uint256) {
        return _replicatorList.length;
    }

    /// Registered replicators (active or not) in registration order
    function getReplicators(
        uint256 offset,
        uint256 limit
    ) external view returns (address[] memory authorities, Replicator[] memory replicators) {
        uint256 end = _pageEnd(offset, limit, _replicatorList.length);
        uint256 count = end > offset ? end - offset : 0;
        authorities = new address[](count);
        replicators = new Replicator[](count);
        for (uint256 i = 0; i < count; i++) {
            authorities[i] = _replicatorList[offset + i];
            replicators[i] = _replicators[authorities[i]];
        }
    }

    /// Upload price: `replicas × (baseFeePerReplica + ⌈size × pricePerMib / MiB⌉)`
    function quoteChunk(uint256 size, uint256 replicas) public view returns (uint256) {
        uint256 storagePart = _ceilDiv(size * _config.pricePerMib, BYTES_PER_MIB);
        return replicas * (_config.baseFeePerReplica + storagePart);
    }

    /// Blob price: `n × (baseFeePerReplica + ⌈shardSize × pricePerMibEpoch × epochs / MiB⌉)`
    function quoteBlob(uint256 shardSize, uint256 totalShards, uint256 epochs) public view returns (uint256) {
        uint256 storagePart = _ceilDiv(shardSize * _config.pricePerMibEpoch * epochs, BYTES_PER_MIB);
        return totalShards * (_config.baseFeePerReplica + storagePart);
    }

    // ── Internals ───────────────────────────────────────────────────────────

    /// Split a fee into (protocol share, reward per replica); rounding dust
    /// goes to the protocol
    function _splitFee(uint256 fee, uint256 replicas) internal view returns (uint256 protocol, uint256 perReplica) {
        protocol = (fee * _config.protocolFeeBps) / 10_000;
        perReplica = (fee - protocol) / replicas;
        protocol = fee - perReplica * replicas;
    }

    /// Confirmations needed to turn a chunk Cool (at least one)
    function _coolThreshold(uint8 requiredReplicas) internal view returns (uint8) {
        uint256 needed = (uint256(requiredReplicas) * _config.replicationThresholdPct) / 100;
        return needed == 0 ? 1 : uint8(needed);
    }

    function _requireIdentity(address user) internal view {
        if (_identities[user].registeredAt == 0) revert NotRegistered();
    }

    function _requireActiveReplicator(address authority) internal view {
        if (!_replicators[authority].active) revert ReplicatorInactive();
    }

    /// Check `msg.value` covers `spent` and send the rest to `restTo`
    function _settle(uint256 spent, address restTo) internal {
        if (msg.value < spent) revert InsufficientPayment(spent, msg.value);
        uint256 rest = msg.value - spent;
        if (rest > 0) _send(restTo, rest);
    }

    function _send(address to, uint256 amount) internal {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function _pageEnd(uint256 offset, uint256 limit, uint256 length) internal pure returns (uint256) {
        if (offset >= length) return offset;
        uint256 end = offset + limit;
        return end > length || end < offset ? length : end;
    }

    function _page(
        EnumerableSet.Bytes32Set storage set,
        uint256 offset,
        uint256 limit
    ) internal view returns (bytes32[] memory out) {
        uint256 length = set.length();
        uint256 end = _pageEnd(offset, limit, length);
        out = new bytes32[](end > offset ? end - offset : 0);
        for (uint256 i = 0; i < out.length; i++) out[i] = set.at(offset + i);
    }

    function _validateConfig(ConfigParams memory p) internal pure {
        if (p.treasury == address(0)) revert ZeroAddress();
        if (
            p.protocolFeeBps > MAX_PROTOCOL_FEE_BPS ||
            p.replicationThresholdPct == 0 ||
            p.replicationThresholdPct > 100 ||
            p.replicationWindow < MIN_REPLICATION_WINDOW ||
            p.replicationWindow > MAX_REPLICATION_WINDOW ||
            p.epochSeconds < MIN_EPOCH_SECONDS ||
            p.epochSeconds > MAX_EPOCH_SECONDS ||
            p.challengeWindowBlocks == 0 ||
            p.challengeWindowBlocks > MAX_CHALLENGE_WINDOW_BLOCKS ||
            p.challengerBountyBps > 10_000
        ) revert InvalidParameter();
    }

    function _validateEndpoint(string calldata endpoint) private pure {
        uint256 len = bytes(endpoint).length;
        if (len == 0 || len > MAX_ENDPOINT_LEN) revert InvalidEndpoint();
    }

    function _emitConfig() private {
        ConfigParams storage c = _config;
        emit ConfigUpdated(
            admin,
            c.treasury,
            c.baseFeePerReplica,
            c.pricePerMib,
            c.pricePerMibEpoch,
            c.protocolFeeBps,
            c.epochSeconds
        );
    }
}

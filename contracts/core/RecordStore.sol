// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {MonaDBBase} from "./MonaDBBase.sol";
import {Grant, Identity, Record} from "../MonaDBTypes.sol";

/**
 * @title RecordStore
 * @notice Sealed file manifests and per-reader grants.  The content of a
 *         record is sealed off-chain to the owner's X25519 key; each reader
 *         gets its own copy sealed to its published key.  The contract only
 *         enforces who may write.
 */
abstract contract RecordStore is MonaDBBase {
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using EnumerableSet for EnumerableSet.AddressSet;

    mapping(bytes32 id => Record) internal _records;
    mapping(bytes32 record => mapping(address viewer => Grant)) internal _grants;
    mapping(bytes32 record => EnumerableSet.AddressSet) internal _recordViewers;
    mapping(address viewer => EnumerableSet.Bytes32Set) internal _viewerGrants;

    function recordId(address owner, uint64 nonce) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("record", owner, nonce));
    }

    /// Store `content` (sealed off-chain to the owner's key) in a new record
    function createRecord(string calldata schema, bytes calldata content) external returns (bytes32) {
        return _createRecord(msg.sender, schema, content);
    }

    function _createRecord(address owner, string calldata schema, bytes calldata content) internal returns (bytes32 id) {
        if (bytes(schema).length > MAX_SCHEMA_LEN) revert InvalidSchema();
        _validateContent(content);
        Identity storage identity = _identities[owner];
        if (identity.registeredAt == 0) revert NotRegistered();
        uint64 nonce = identity.recordNonce++;

        id = recordId(owner, nonce);
        Record storage r = _records[id];
        r.owner = owner;
        r.nonce = nonce;
        r.createdAt = uint40(block.timestamp);
        r.updatedAt = uint40(block.timestamp);
        r.createdBlock = uint64(block.number);
        r.schema = schema;
        r.content = content;
        emit RecordCreated(id, owner, schema);
    }

    /// Replace the owner's sealed content (grants keep their own copies)
    function updateRecord(bytes32 id, bytes calldata content) external {
        Record storage r = _owned(id);
        _validateContent(content);
        r.content = content;
        r.updatedAt = uint40(block.timestamp);
        emit RecordUpdated(id, msg.sender);
    }

    /// Delete the record and every grant on it
    function deleteRecord(bytes32 id) external {
        _owned(id);
        EnumerableSet.AddressSet storage viewers = _recordViewers[id];
        while (viewers.length() > 0) _revoke(id, viewers.at(viewers.length() - 1));
        delete _records[id];
        emit RecordDeleted(id, msg.sender);
    }

    /// Give a registered user its own copy of the record (or replace it),
    /// sealed off-chain to the viewer's encryption key
    function grantAccess(bytes32 id, address viewer, bytes calldata content) external {
        _owned(id);
        _validateContent(content);
        if (viewer == msg.sender) revert CannotGrantSelf();
        _requireIdentity(viewer);

        Grant storage g = _grants[id][viewer];
        if (g.grantedAt == 0) {
            g.grantedAt = uint40(block.timestamp);
            _recordViewers[id].add(viewer);
            _viewerGrants[viewer].add(id);
        }
        g.updatedAt = uint40(block.timestamp);
        g.content = content;
        emit AccessGranted(id, msg.sender, viewer);
    }

    function revokeAccess(bytes32 id, address viewer) external {
        _owned(id);
        if (_grants[id][viewer].grantedAt == 0) revert GrantNotFound();
        _revoke(id, viewer);
    }

    function _revoke(bytes32 id, address viewer) private {
        delete _grants[id][viewer];
        _recordViewers[id].remove(viewer);
        _viewerGrants[viewer].remove(id);
        emit AccessRevoked(id, msg.sender, viewer);
    }

    function _owned(bytes32 id) private view returns (Record storage r) {
        r = _records[id];
        if (r.owner == address(0)) revert RecordNotFound();
        if (r.owner != msg.sender) revert NotOwner();
    }

    function _validateContent(bytes calldata content) private pure {
        if (content.length == 0 || content.length > MAX_RECORD_CONTENT) revert InvalidContent();
    }

    // ── Views ───────────────────────────────────────────────────────────────

    function getRecord(bytes32 id) external view returns (Record memory) {
        return _records[id];
    }

    function getGrant(bytes32 id, address viewer) external view returns (Grant memory) {
        return _grants[id][viewer];
    }

    function viewersOf(bytes32 id) external view returns (address[] memory) {
        return _recordViewers[id].values();
    }

    function grantCountTo(address viewer) external view returns (uint256) {
        return _viewerGrants[viewer].length();
    }

    /// Records shared with `viewer`
    function grantsTo(address viewer, uint256 offset, uint256 limit) external view returns (bytes32[] memory) {
        return _page(_viewerGrants[viewer], offset, limit);
    }

    /// Records `owner` created with nonces in [fromNonce, fromNonce + count)
    /// that still exist
    function recordsOf(address owner, uint64 fromNonce, uint64 count) external view returns (bytes32[] memory ids) {
        uint64 end = _identities[owner].recordNonce;
        if (fromNonce >= end) return new bytes32[](0);
        if (count < end - fromNonce) end = fromNonce + count;
        bytes32[] memory found = new bytes32[](end - fromNonce);
        uint256 n;
        for (uint64 nonce = fromNonce; nonce < end; nonce++) {
            bytes32 id = recordId(owner, nonce);
            if (_records[id].owner == owner) found[n++] = id;
        }
        ids = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) ids[i] = found[i];
    }
}

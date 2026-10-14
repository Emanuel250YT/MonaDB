// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Multicall} from "@openzeppelin/contracts/utils/Multicall.sol";
import {MonaDBBase} from "./core/MonaDBBase.sol";
import {ChunkStorage} from "./core/ChunkStorage.sol";
import {BlobStorage} from "./core/BlobStorage.sol";
import {RecordStore} from "./core/RecordStore.sol";
import {BlobArgs, ChunkArgs, ConfigParams} from "./MonaDBTypes.sol";

//  __  __                   ____  ____
// |  \/  | ___  _ __   __ _|  _ \| __ )
// | |\/| |/ _ \| '_ \ / _` | | | |  _ \
// | |  | | (_) | | | | (_| | |_| | |_) |
// |_|  |_|\___/|_| |_|\__,_|____/|____/
//
/**
 * @title MonaDB
 * @notice Private, replicated file storage on Monad.
 *
 *  - **Identity**: each wallet publishes the X25519 key others seal data to.
 *  - **Chunks**: encrypted chunks go straight to replicator nodes (*direct*)
 *    or through the event logs in segments (*ledger*).  Nodes check the
 *    chunk's sha256, store it and call `confirmReplication`, which pays them
 *    from the chunk's escrow.  Enough replicas turn a chunk Cool; the last
 *    one closes it.
 *  - **Blobs**: large payloads as `k + m` Reed-Solomon shards on `n` nodes,
 *    one entry per blob (a Merkle root), storage prepaid per epoch and
 *    unlocked by challenge/response storage proofs (docs/blob-protocol.md).
 *  - **Records**: the file manifest (chunk or blob list + data key) is sealed
 *    to the owner's key; each reader gets a sealed copy in a grant.
 *
 *  `multicall` (not payable) batches the owner's other calls, e.g. deleting
 *  a record and closing its chunks with one wallet signature.
 *
 *  Monad notes: the network charges the gas *limit*, so clients send an
 *  explicit limit from `eth_estimateGas`; Monad has no `eth_newFilter`, so the
 *  work queues (`pendingChunks`, `pendingBlobs`) live on-chain and nodes poll
 *  them with `eth_call`.
 */
contract MonaDB is ChunkStorage, BlobStorage, RecordStore, Multicall {
    string public constant VERSION = "1.0.0";

    constructor(ConfigParams memory params) MonaDBBase(params) {}

    /**
     * One wallet transaction per upload: open and pay every chunk and blob,
     * then create the record holding the sealed manifest (skipped when
     * `content` is empty).  Value above the fees goes to `writer` when it is
     * a session key (it pays the gas of the ledger segment writes), else back
     * to the caller.
     *
     * @param writer Address allowed to write ledger segments (0 = the caller)
     */
    function upload(
        ChunkArgs[] calldata chunks,
        BlobArgs[] calldata blobs,
        address writer,
        string calldata schema,
        bytes calldata content
    ) external payable nonReentrant returns (bytes32 record) {
        if (writer == address(0)) writer = msg.sender;
        uint256 spent;
        for (uint256 i = 0; i < chunks.length; i++) {
            (, uint256 fee) = _openChunk(msg.sender, chunks[i], writer);
            spent += fee;
        }
        for (uint256 i = 0; i < blobs.length; i++) {
            (, uint256 fee) = _openBlob(msg.sender, blobs[i]);
            spent += fee;
        }
        if (content.length > 0) record = _createRecord(msg.sender, schema, content);
        _settle(spent, writer);
    }
}

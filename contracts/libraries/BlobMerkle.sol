// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title BlobMerkle
 * @notice Merkle trees of docs/blob-protocol.md §2, with sha256 (precompile
 *         0x02) so the SDK, the node and the contract agree byte for byte:
 *         `leafHash(s) = sha256(0x00 ‖ s)`, `nodeHash(l, r) = sha256(0x01 ‖ l ‖ r)`.
 */
library BlobMerkle {
    function leafHash(bytes calldata segment) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(bytes1(0x00), segment));
    }

    function nodeHash(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(bytes1(0x01), left, right));
    }

    /// `ceil(log2(n))`, 0 for n ≤ 1
    function depth(uint256 n) internal pure returns (uint256 d) {
        if (n <= 1) return 0;
        n -= 1;
        while (n > 0) {
            d++;
            n >>= 1;
        }
    }

    /// Walk `proof` (siblings bottom-up) from `node` at `index`
    function fold(bytes32 node, uint256 index, bytes32[] calldata proof) internal pure returns (bytes32) {
        for (uint256 level = 0; level < proof.length; level++) {
            node = (index >> level) & 1 == 0 ? nodeHash(node, proof[level]) : nodeHash(proof[level], node);
        }
        return node;
    }

    /**
     * Segment a storage proof must answer with: `u64_le(sha256(H ‖ blob ‖
     * [index])[0..8]) mod segments`, where `H` is the hash of the challenge
     * block (docs/blob-protocol.md §5).
     */
    function challengeSegment(
        bytes32 blockHash,
        bytes32 blob,
        uint8 index,
        uint256 segments
    ) internal pure returns (uint64) {
        bytes32 seed = sha256(abi.encodePacked(blockHash, blob, index));
        uint64 le;
        for (uint256 i = 0; i < 8; i++) le |= uint64(uint8(seed[i])) << uint64(8 * i);
        return uint64(uint256(le) % segments);
    }
}

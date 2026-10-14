import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { getBytes, hexlify, solidityPackedKeccak256, Wallet, ZeroAddress, ZeroHash } from 'ethers';
import {
  assembleChunk,
  challengedSegment,
  challengeSegment,
  ChunkAccount,
  createMonadProvider,
  decodeBlob,
  decodeChunk,
  decodeManifest,
  decodeRecord,
  decryptBytes,
  deriveEncryptionKeyPair,
  DIRECT_ABORT_DELAY,
  encodeManifest,
  encryptBytes,
  FileManifest,
  gunzip,
  ids,
  isBlobClosable,
  isClosable,
  isDirect,
  KEY_DERIVATION_MESSAGE,
  keyPairFromSecret,
  maybeCompress,
  MONADB_ERRORS,
  monadbInterface,
  open,
  quoteBlob,
  quoteChunk,
  quoteExtension,
  randomKey,
  revertName,
  seal,
  sha256,
  splitBlobFee,
  splitFee,
} from '../src';

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) % 251);
const owner = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

test('ids follow the contract: keccak256(abi.encodePacked(tag, owner, …))', () => {
  const hash = bytes(32, 3);
  assert.equal(ids.chunk(owner, hash), solidityPackedKeccak256(['string', 'address', 'bytes32'], ['chunk', owner, hash]));
  assert.equal(ids.blob(owner, hexlify(hash)), solidityPackedKeccak256(['string', 'address', 'bytes32'], ['blob', owner, hash]));
  assert.equal(ids.record(owner, 7n), solidityPackedKeccak256(['string', 'address', 'uint64'], ['record', owner, 7]));
  assert.notEqual(ids.chunk(owner, hash), ids.blob(owner, hash));
});

test('view results decode: a chunk, a closed chunk, a blob with its used slots only', () => {
  const chunk = {
    owner,
    state: 2,
    needsReplicas: true,
    reclaimed: false,
    requiredReplicas: 3,
    confirmedReplicas: 1,
    size: 1000,
    contentHash: hexlify(bytes(32, 9)),
    writer: owner,
    segmentSize: 0,
    segmentsTotal: 0,
    segmentsWritten: 0,
    rewardPerReplica: 19_800n,
    openedAt: 10n,
    completedAt: 10n,
    reclaimableAt: 99n,
    openedBlock: 5n,
    completedBlock: 5n,
    replicators: [owner],
  };
  const encoded = monadbInterface.encodeFunctionResult('getChunk', [chunk]);
  const [raw] = monadbInterface.decodeFunctionResult('getChunk', encoded);
  const decoded = decodeChunk(raw, ZeroHash)!;
  assert.equal(decoded.state, 'Hot');
  assert.equal(decoded.requiredReplicas, 3);
  assert.deepEqual(decoded.contentHash, bytes(32, 9));
  assert.deepEqual(decoded.replicators, [owner]);
  assert.equal(decoded.rewardPerReplica, 19_800n);
  assert.equal(decodeChunk({ ...raw.toObject(), state: 0n }, ZeroHash), null);

  const slot = { holder: ZeroAddress, provenAt: 0, claimedUntil: 0, lastChallengeAt: 0, challengeBlock: 0, challengeDeadline: 0 };
  const blob = {
    owner,
    state: 1,
    needsHolders: true,
    dataShards: 2,
    totalShards: 3,
    held: 1,
    epochs: 12,
    root: hexlify(bytes(32, 4)),
    shardSize: 4096n,
    payloadSize: 8000n,
    openedAt: 1n,
    expiresAt: 2n,
    rewardPerShardEpoch: 5n,
    escrow: 180n,
    slots: Array.from({ length: 32 }, (_, i) => (i === 0 ? { ...slot, holder: owner, challengeBlock: 9 } : slot)),
  };
  const [rawBlob] = monadbInterface.decodeFunctionResult('getBlob', monadbInterface.encodeFunctionResult('getBlob', [blob]));
  const b = decodeBlob(rawBlob, ZeroHash)!;
  assert.equal(b.state, 'Hot');
  assert.equal(b.slots.length, 3);
  assert.equal(b.slots[0].holder, owner);
  assert.equal(b.slots[0].challengeBlock, 9n);
  assert.equal(b.escrow, 180n);

  const record = { owner: ZeroAddress, nonce: 0, createdAt: 0, updatedAt: 0, createdBlock: 0, schema: '', content: '0x' };
  const [rawRecord] = monadbInterface.decodeFunctionResult('getRecord', monadbInterface.encodeFunctionResult('getRecord', [record]));
  assert.equal(decodeRecord(rawRecord, ZeroHash), null);
});

test('fees match the contract', () => {
  // 2 wei per byte, expressed per MiB
  const config = { baseFeePerReplica: 20_000n, pricePerMib: 2_097_152n, protocolFeeBps: 1_000 };
  const fee = quoteChunk(config, 1_000, 3);
  assert.equal(fee, 66_000n);
  // pro rata per MiB, rounded up to the wei
  const cheap = { baseFeePerReplica: 7_000n, pricePerMib: 20_000n };
  assert.equal(quoteChunk(cheap, 1, 1), 7_001n);
  assert.equal(quoteChunk(cheap, 1_048_576, 2), 54_000n);
  assert.deepEqual(splitFee(config, fee, 3), { protocolFee: 6_600n, rewardPerReplica: 19_800n });
  // rounding dust goes to the protocol
  assert.deepEqual(splitFee(config, 100_001n, 3), { protocolFee: 10_001n, rewardPerReplica: 30_000n });

  const blobConfig = { baseFeePerReplica: 1_000n, pricePerMibEpoch: 200n, protocolFeeBps: 1_000 };
  const blobFee = quoteBlob(blobConfig, 1_048_576n, 3, 12);
  assert.equal(blobFee, 3n * (1_000n + 2_400n));
  const split = splitBlobFee(blobConfig, blobFee, 3, 12);
  assert.equal(split.rewardPerShardEpoch, (blobFee - blobFee / 10n) / 36n);
  assert.equal(quoteExtension(blobConfig, { rewardPerShardEpoch: 9n, totalShards: 2 }, 5), 90n + 10n);
});

test('manifest binary encoding round-trips (inline and index)', () => {
  const base: FileManifest = {
    v: 2,
    name: 'informe-2026.pdf',
    mime: 'application/pdf',
    size: 1_234_567,
    chunkSize: 262_144,
    sha256: bytes(32, 2),
    dek: bytes(32, 3),
    createdAt: 1_760_000_000,
    chunkCount: 5,
    chunks: [1, 2, 3, 4, 5].map((s) => bytes(32, s)),
  };
  assert.deepEqual(decodeManifest(encodeManifest(base)), base);
  const flagged: FileManifest = { ...base, direct: true, compression: 'gzip' };
  assert.deepEqual(decodeManifest(encodeManifest(flagged)), flagged);
  const indexed = { ...base, chunkCount: 40, chunks: [], index: bytes(32, 7) };
  const decoded = decodeManifest(encodeManifest(indexed));
  assert.equal(decoded.chunkCount, 40);
  assert.deepEqual(decoded.index, indexed.index);
  assert.deepEqual(decoded.chunks, []);
});

test('manifest names are truncated to fit', () => {
  const m = decodeManifest(
    encodeManifest({
      v: 2, name: 'á'.repeat(300), mime: 'x', size: 1, chunkSize: 1, sha256: bytes(32), dek: bytes(32),
      createdAt: 1, chunkCount: 1, chunks: [bytes(32)],
    }),
  );
  assert.ok(new TextEncoder().encode(m.name).length <= 200);
});

test('seal / open and chunk encryption', () => {
  const alice = keyPairFromSecret(bytes(32, 5));
  const bob = keyPairFromSecret(bytes(32, 6));
  const message = new TextEncoder().encode('manifest');
  assert.deepEqual(open(alice, seal(alice.publicKey, message)), message);
  assert.throws(() => open(bob, seal(alice.publicKey, message)));

  const dek = randomKey();
  const plain = bytes(5000);
  assert.deepEqual(decryptBytes(dek, encryptBytes(dek, plain)), plain);
});

test('the encryption key comes from a deterministic wallet signature', async () => {
  const wallet = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const sign = async (m: Uint8Array) => getBytes(await wallet.signMessage(m));
  const a = await deriveEncryptionKeyPair(sign);
  const b = await deriveEncryptionKeyPair(sign);
  assert.deepEqual(a.publicKey, b.publicKey);
  assert.equal(a.publicKey.length, 32);
  assert.match(KEY_DERIVATION_MESSAGE, /MonaDB/);
  await assert.rejects(deriveEncryptionKeyPair(async () => new Uint8Array(10)), /signature/);
});

test('ledger segments reassemble and are verified', () => {
  const data = bytes(10_000);
  const segments = [0, 1, 2].map((index) => ({
    index,
    data: data.subarray(index * 3800, (index + 1) * 3800),
    blockNumber: 1,
    transactionHash: `0x${index}`,
  }));
  assert.deepEqual(assembleChunk(segments, sha256(data)), data);
  assert.throws(() => assembleChunk(segments.slice(1), sha256(data)), /Missing/);
  assert.throws(() => assembleChunk(segments, sha256(bytes(10))), /chunk hash/);
});

test('custom errors are read from revert data and messages', () => {
  assert.equal(MONADB_ERRORS.SegmentAlreadyWritten, 'SegmentAlreadyWritten');
  const data = monadbInterface.encodeErrorResult('FeeAboveMax', [5n, 4n]);
  assert.equal(revertName({ data }), 'FeeAboveMax');
  assert.equal(revertName({ info: { error: { data } } }), 'FeeAboveMax');
  assert.equal(revertName({ revert: { name: 'NotOwner' } }), 'NotOwner');
  assert.equal(revertName(new Error("VM Exception: reverted with custom error 'ChunkExists()'")), 'ChunkExists');
  assert.equal(revertName(new Error('network down')), undefined);
});

test('the challenged segment matches the Merkle helper', () => {
  const hash = bytes(32, 8);
  const blob = hexlify(bytes(32, 9));
  assert.equal(Number(challengedSegment(hash, blob, 3, 64n)), challengeSegment(hash, getBytes(blob), 3, 64 * 1024));
});

test('direct chunks: closable after the abort delay without confirmations', () => {
  const base = {
    state: 'Hot',
    segmentSize: 0,
    confirmedReplicas: 0,
    requiredReplicas: 2,
    openedAt: 1_000n,
    reclaimableAt: 1_000n + 604_800n,
  } as unknown as ChunkAccount;
  assert.equal(isDirect(base), true);
  assert.equal(isClosable(base, 1_000n + DIRECT_ABORT_DELAY - 1n), false);
  assert.equal(isClosable(base, 1_000n + DIRECT_ABORT_DELAY), true);
  assert.equal(isClosable({ ...base, confirmedReplicas: 1 }, 1_000n + DIRECT_ABORT_DELAY), false);
  assert.equal(isClosable({ ...base, segmentSize: 48 * 1024 }, 1_000n + DIRECT_ABORT_DELAY), false);
  assert.equal(isClosable({ ...base, state: 'Pending', segmentSize: 1024 }, 1_000n), true);
  const blob = { expiresAt: 100n, openedAt: 0n, held: 1 } as never;
  assert.equal(isBlobClosable(blob, 50n, 149n), false);
  assert.equal(isBlobClosable(blob, 50n, 150n), true);
});

test('gzip is only kept when it saves at least 10 %', async () => {
  const text = new TextEncoder().encode('fecha,monto,concepto\n'.repeat(5_000));
  const packed = await maybeCompress(text);
  assert.ok(packed && packed.length < text.length / 10);
  assert.deepEqual(await gunzip(packed), text);
  const noise = crypto.getRandomValues(new Uint8Array(4_096));
  assert.equal(await maybeCompress(noise), null, 'incompressible data is sent as it is');
  assert.equal(await maybeCompress(new Uint8Array(100)), null, 'tiny files are not worth it');
});

test('the Monad provider refuses filters and retries rate-limited requests', async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls++;
      if (calls < 3) {
        res.writeHead(429).end('slow down');
        return;
      }
      const { id } = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result: '0x7b' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const provider = createMonadProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 10143);
    assert.equal(await provider.getBlockNumber(), 123);
    assert.ok(calls >= 3);
    await assert.rejects(provider.send('eth_newFilter', [{}]), /not supported on Monad/);
  } finally {
    server.close();
  }
});

import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gunzip } from '../src/shared/gunzip.js';

function seededBytes(length) {
  const bytes = Buffer.alloc(length);
  let state = 0x6d2b79f5;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

class BitWriter {
  constructor() {
    this.bytes = [];
    this.current = 0;
    this.used = 0;
  }

  bit(value) {
    this.current |= value << this.used;
    this.used += 1;
    if (this.used === 8) {
      this.bytes.push(this.current);
      this.current = 0;
      this.used = 0;
    }
  }

  bits(value, count) {
    for (let bit = 0; bit < count; bit += 1) this.bit((value >>> bit) & 1);
  }

  huffman(code, count) {
    for (let bit = count - 1; bit >= 0; bit -= 1) this.bit((code >>> bit) & 1);
  }

  finish() {
    if (this.used > 0) this.bytes.push(this.current);
    return Buffer.from(this.bytes);
  }
}

function gzipWithRawDeflate(raw) {
  return Buffer.concat([
    Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]),
    raw,
    Buffer.alloc(8),
  ]);
}

function invalidDistanceGzip() {
  const writer = new BitWriter();
  writer.bits(1, 1); // final block
  writer.bits(1, 2); // fixed Huffman block
  writer.huffman(1, 7); // length symbol 257 (three bytes)
  writer.bits(0, 5); // distance symbol 0, before any output
  writer.huffman(0, 7); // end of block
  return gzipWithRawDeflate(writer.finish());
}

const roundTripPayloads = [
  ['empty', Buffer.alloc(0)],
  ['one byte', Buffer.from([0xa5])],
  ['256 zero bytes', Buffer.alloc(256)],
  ['1 MB seeded data', seededBytes(1024 * 1024)],
  ['4 MB seeded data', seededBytes(4 * 1024 * 1024)],
];

test('gunzip round-trips stored, fixed, and dynamic DEFLATE payloads', () => {
  for (const [label, payload] of roundTripPayloads) {
    for (const level of [0, 1, 6, 9]) {
      const actual = gunzip(gzipSync(payload, { level }));
      assert.equal(Buffer.compare(actual, payload), 0, `${label}, compression level ${level}`);
    }
  }
});

test('gunzip skips optional RFC 1952 header fields', () => {
  const payload = Buffer.from('optional gzip metadata');
  const gzip = gzipSync(payload);
  const header = Buffer.from(gzip.subarray(0, 10));
  header[3] = 0x1f; // FTEXT, FHCRC, FEXTRA, FNAME, and FCOMMENT
  const extended = Buffer.concat([
    header,
    Buffer.from([3, 0, 0xaa, 0xbb, 0xcc]),
    Buffer.from('module.js\0'),
    Buffer.from('metadata test\0'),
    Buffer.from([0x34, 0x12]),
    gzip.subarray(10),
  ]);
  assert.equal(Buffer.compare(gunzip(extended), payload), 0);
});

const wasmPath = join(process.cwd(), 'vendor/pyodide/pyodide.asm.wasm');
const wasmGzipPath = join(process.cwd(), 'dist/scorm-template/pyodide/pyodide.asm.wasm.gz');
test('gunzip decodes the shipped Pyodide wasm artifact', {
  skip: existsSync(wasmPath) && existsSync(wasmGzipPath)
    ? false
    : 'vendored source or built dist gzip artifact is unavailable',
}, () => {
  assert.equal(Buffer.compare(gunzip(readFileSync(wasmGzipPath)), readFileSync(wasmPath)), 0);
});

test('gunzip rejects malformed headers and DEFLATE streams', () => {
  const ordinary = gzipSync(Buffer.from('payload'));
  const badMagic = Buffer.from(ordinary);
  badMagic[0] = 0;
  const unsupportedMethod = Buffer.from(ordinary);
  unsupportedMethod[2] = 7;
  const invalidBlockType = gzipWithRawDeflate(Buffer.from([0x07]));
  const truncated = ordinary.subarray(0, ordinary.length - 9);

  for (const malformed of [badMagic, unsupportedMethod, invalidBlockType, invalidDistanceGzip(), truncated]) {
    assert.throws(() => gunzip(malformed), /^Error: gunzip: /);
  }
  assert.throws(() => gunzip(invalidBlockType), /gunzip: invalid block type/);
  assert.throws(() => gunzip(invalidDistanceGzip()), /gunzip: invalid distance/);
});

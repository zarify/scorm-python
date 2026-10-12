const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129,
  193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097,
  6145, 8193, 12289, 16385, 24577,
];
const DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function fail(reason) {
  throw new Error(`gunzip: ${reason}`);
}

function readBits(state, count) {
  while (state.bitCount < count) {
    if (state.offset >= state.limit) fail('unexpected end of input');
    state.bitBuffer |= state.bytes[state.offset++] << state.bitCount;
    state.bitCount += 8;
  }
  const mask = (1 << count) - 1;
  const value = state.bitBuffer & mask;
  state.bitBuffer >>>= count;
  state.bitCount -= count;
  return value;
}

function buildHuffman(lengths, maxBits, label) {
  const counts = new Uint16Array(maxBits + 1);
  let symbolCount = 0;
  for (const length of lengths) {
    if (length > maxBits) fail(`invalid ${label} Huffman code`);
    if (length > 0) {
      counts[length] += 1;
      symbolCount += 1;
    }
  }
  if (symbolCount === 0) return null;

  let remaining = 1;
  for (let bits = 1; bits <= maxBits; bits += 1) {
    remaining = (remaining << 1) - counts[bits];
    if (remaining < 0) fail(`oversubscribed ${label} Huffman tree`);
  }

  const nextCode = new Uint16Array(maxBits + 1);
  let code = 0;
  for (let bits = 1; bits <= maxBits; bits += 1) {
    code = (code + counts[bits - 1]) << 1;
    nextCode[bits] = code;
  }

  const tables = new Array(maxBits + 1);
  for (let bits = 1; bits <= maxBits; bits += 1) {
    if (counts[bits] > 0) {
      tables[bits] = new Int16Array(1 << bits);
      tables[bits].fill(-1);
    }
  }

  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const bits = lengths[symbol];
    if (bits === 0) continue;
    const canonical = nextCode[bits]++;
    let reversed = 0;
    for (let bit = 0; bit < bits; bit += 1) {
      reversed = (reversed << 1) | ((canonical >>> bit) & 1);
    }
    tables[bits][reversed] = symbol;
  }
  return tables;
}

function decodeSymbol(state, tables, label) {
  if (!tables) fail(`missing ${label} Huffman tree`);
  let code = 0;
  for (let bits = 1; bits < tables.length; bits += 1) {
    code |= readBits(state, 1) << (bits - 1);
    const table = tables[bits];
    if (table && table[code] !== -1) return table[code];
  }
  fail(`invalid ${label} Huffman code`);
}

function fixedTrees() {
  const literalLengths = new Uint8Array(288);
  literalLengths.fill(8, 0, 144);
  literalLengths.fill(9, 144, 256);
  literalLengths.fill(7, 256, 280);
  literalLengths.fill(8, 280, 288);
  return {
    literal: buildHuffman(literalLengths, 15, 'literal/length'),
    distance: buildHuffman(new Uint8Array(32).fill(5), 15, 'distance'),
  };
}

function dynamicTrees(state) {
  const literalCount = readBits(state, 5) + 257;
  const distanceCount = readBits(state, 5) + 1;
  const codeLengthCount = readBits(state, 4) + 4;
  const codeLengthLengths = new Uint8Array(19);
  for (let index = 0; index < codeLengthCount; index += 1) {
    codeLengthLengths[CODE_LENGTH_ORDER[index]] = readBits(state, 3);
  }
  const codeLengthTree = buildHuffman(codeLengthLengths, 7, 'code-length');
  const lengths = new Uint8Array(literalCount + distanceCount);
  let index = 0;
  while (index < lengths.length) {
    const symbol = decodeSymbol(state, codeLengthTree, 'code-length');
    if (symbol <= 15) {
      lengths[index++] = symbol;
    } else if (symbol === 16) {
      if (index === 0) fail('repeat code has no previous length');
      const repeat = readBits(state, 2) + 3;
      if (index + repeat > lengths.length) fail('code-length repeat exceeds tree size');
      lengths.fill(lengths[index - 1], index, index + repeat);
      index += repeat;
    } else if (symbol === 17) {
      const repeat = readBits(state, 3) + 3;
      if (index + repeat > lengths.length) fail('code-length repeat exceeds tree size');
      index += repeat;
    } else if (symbol === 18) {
      const repeat = readBits(state, 7) + 11;
      if (index + repeat > lengths.length) fail('code-length repeat exceeds tree size');
      index += repeat;
    } else {
      fail('invalid code-length symbol');
    }
  }

  const literalLengths = lengths.subarray(0, literalCount);
  if (literalLengths[256] === 0) fail('literal/length tree has no end-of-block code');
  return {
    literal: buildHuffman(literalLengths, 15, 'literal/length'),
    distance: buildHuffman(lengths.subarray(literalCount), 15, 'distance'),
  };
}

function ensureCapacity(state, additional) {
  const needed = state.length + additional;
  if (needed <= state.output.length) return;
  let capacity = state.output.length;
  while (capacity < needed) capacity = Math.max(capacity * 2, 256);
  const expanded = new Uint8Array(capacity);
  expanded.set(state.output.subarray(0, state.length));
  state.output = expanded;
}

function inflateBlock(state, literalTree, distanceTree) {
  while (true) {
    const symbol = decodeSymbol(state, literalTree, 'literal/length');
    if (symbol < 256) {
      ensureCapacity(state, 1);
      state.output[state.length++] = symbol;
      continue;
    }
    if (symbol === 256) return;
    if (symbol < 257 || symbol > 285) fail('invalid length symbol');

    const lengthIndex = symbol - 257;
    const length = LENGTH_BASE[lengthIndex] + readBits(state, LENGTH_EXTRA[lengthIndex]);
    const distanceSymbol = decodeSymbol(state, distanceTree, 'distance');
    if (distanceSymbol > 29) fail('invalid distance symbol');
    const distance = DISTANCE_BASE[distanceSymbol] + readBits(state, DISTANCE_EXTRA[distanceSymbol]);
    if (distance > state.length) fail('invalid distance');

    ensureCapacity(state, length);
    for (let index = 0; index < length; index += 1) {
      state.output[state.length] = state.output[state.length - distance];
      state.length += 1;
    }
  }
}

function inflate(bytes, offset, limit) {
  const state = {
    bytes,
    offset,
    limit,
    bitBuffer: 0,
    bitCount: 0,
    output: new Uint8Array(32768),
    length: 0,
  };
  let finalBlock = false;
  while (!finalBlock) {
    finalBlock = readBits(state, 1) === 1;
    const type = readBits(state, 2);
    if (type === 0) {
      state.bitBuffer = 0;
      state.bitCount = 0;
      const length = readBits(state, 16);
      const complement = readBits(state, 16);
      if (((length ^ complement) & 0xffff) !== 0xffff) fail('invalid stored block length');
      if (state.offset + length > state.limit) fail('unexpected end of input');
      ensureCapacity(state, length);
      state.output.set(bytes.subarray(state.offset, state.offset + length), state.length);
      state.offset += length;
      state.length += length;
    } else if (type === 1 || type === 2) {
      const trees = type === 1 ? fixedTrees() : dynamicTrees(state);
      inflateBlock(state, trees.literal, trees.distance);
    } else {
      fail('invalid block type');
    }
  }
  return state.output.subarray(0, state.length);
}

function skipZeroTerminated(bytes, offset, limit) {
  while (offset < limit && bytes[offset] !== 0) offset += 1;
  if (offset >= limit) fail('unexpected end of input');
  return offset + 1;
}

export function gunzip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 18) fail('unexpected end of input');
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) fail('bad magic');
  if (bytes[2] !== 8) fail('unsupported compression method');

  const flags = bytes[3];
  if (flags & 0xe0) fail('reserved header flags are set');
  const limit = bytes.length - 8;
  let offset = 10;
  if (flags & 0x04) {
    if (offset + 2 > limit) fail('unexpected end of input');
    const extraLength = bytes[offset] | (bytes[offset + 1] << 8);
    offset += 2 + extraLength;
    if (offset > limit) fail('unexpected end of input');
  }
  if (flags & 0x08) offset = skipZeroTerminated(bytes, offset, limit);
  if (flags & 0x10) offset = skipZeroTerminated(bytes, offset, limit);
  if (flags & 0x02) {
    if (offset + 2 > limit) fail('unexpected end of input');
    offset += 2;
  }
  if (offset >= limit) fail('unexpected end of input');
  return inflate(bytes, offset, limit);
}

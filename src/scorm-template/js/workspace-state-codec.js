/**
 * Workspace State Codec — encodes the student's code state for SCORM 1.2
 * `cmi.suspend_data`, whose specification limit (SPM) is 4096 characters.
 *
 * Payload grammar (ASCII only, `|`-delimited):
 *
 *   BS1|<activity_id>|<format>|<saved_at base36>|<data>
 *
 * Formats:
 *   J — raw code-state JSON                      (used only when already ASCII)
 *   C — compact JSON; identical to J for a code payload, kept as a distinct
 *       format so payloads written before the Python port still decode
 *                                                  (used only when already ASCII)
 *   B — base64 of the UTF-8 compact JSON
 *   L — LZW-compressed compact JSON, base64 encoded
 *   I — reference: no state here, the newest state lives in this browser's IndexedDB
 *
 * SCORM 1.2 data model types are ISO 646 (ASCII), so non-ASCII field values are
 * never written verbatim: they take the `B`/`L` path, which is pure base64.
 */

const PAYLOAD_PREFIX = 'BS1|';
const FORMAT_JSON = 'J';
const FORMAT_COMPACT = 'C';
const FORMAT_BASE64 = 'B';
const FORMAT_LZW = 'L';
const FORMAT_REFERENCE = 'I';
const HEADER_SEPARATOR = '|';
const LZW_DICTIONARY_LIMIT = 65536;

export const SUSPEND_DATA_MAX_LENGTH = 4096;
export const SUSPEND_DATA_MIN_LENGTH = 512;

/**
 * Encode the student's code state for storage in suspend data.
 * @param {{
 *   activityId?: string,
 *   state: object,
 *   savedAt?: number,
 *   limit?: number,
 * }} options
 * @returns {string|null} Payload, or null when no encoding fits the limit
 */
export function encodeWorkspaceState({
  activityId = '',
  state,
  savedAt = Date.now(),
  limit = SUSPEND_DATA_MAX_LENGTH,
} = {}) {
  if (!state || typeof state !== 'object') return null;

  const rawJson = JSON.stringify(state);
  const compactJson = JSON.stringify(compactWorkspaceState(state));

  const candidates = [
    `${buildHeader(activityId, FORMAT_BASE64, savedAt)}${base64FromUtf8(compactJson)}`,
    `${buildHeader(activityId, FORMAT_LZW, savedAt)}${compressToBase64(compactJson)}`,
  ];
  if (isAscii(rawJson)) {
    candidates.push(`${buildHeader(activityId, FORMAT_JSON, savedAt)}${rawJson}`);
  }
  if (isAscii(compactJson)) {
    candidates.push(`${buildHeader(activityId, FORMAT_COMPACT, savedAt)}${compactJson}`);
  }

  const payload = candidates.reduce((shortest, candidate) => (
    candidate.length < shortest.length ? candidate : shortest
  ));

  return payload.length <= normalizeLimit(limit) ? payload : null;
}

/**
 * Encode a reference to state that only exists in this browser's IndexedDB.
 * @param {{ activityId?: string, savedAt?: number }} options
 * @returns {string}
 */
export function encodeWorkspaceReference({ activityId = '', savedAt = Date.now() } = {}) {
  return buildHeader(activityId, FORMAT_REFERENCE, savedAt);
}

/**
 * Decode a suspend data payload written by encodeWorkspaceState or
 * encodeWorkspaceReference.
 * @param {{ payload?: string, activityId?: string }} options
 * @returns {{
 *   kind: 'state'|'reference',
 *   format: string,
 *   savedAt: number,
 *   state: object|null,
 * }|null} Null when the payload is foreign, truncated, or unreadable
 */
export function decodeWorkspacePayload({ payload, activityId = '' } = {}) {
  if (typeof payload !== 'string' || !payload.startsWith(PAYLOAD_PREFIX)) return null;

  const header = parseHeader(payload);
  if (!header) return null;
  if (header.activityId !== sanitizeActivityId(activityId)) return null;

  if (header.format === FORMAT_REFERENCE) {
    return { kind: 'reference', format: header.format, savedAt: header.savedAt, state: null };
  }

  try {
    switch (header.format) {
      case FORMAT_JSON:
      case FORMAT_COMPACT:
        return buildDecodedState(header, JSON.parse(header.data));
      case FORMAT_BASE64:
        return buildDecodedState(header, JSON.parse(utf8FromBase64(header.data)));
      case FORMAT_LZW:
        return buildDecodedState(header, JSON.parse(decompressFromBase64(header.data)));
      default:
        return null;
    }
  } catch (err) {
    console.warn('[WorkspaceState] Ignoring unreadable suspend data:', err.message);
    return null;
  }
}

/**
 * Produce the compact form of the state the encoder writes. The state is the
 * student's code payload, which has no volatile geometry left to strip, so this
 * is a JSON clone — byte-identical to the raw JSON. It stays as the hook the
 * encoder calls (and as the place a future volatile field would be dropped).
 * @param {object} state
 * @returns {object}
 */
export function compactWorkspaceState(state) {
  return JSON.parse(JSON.stringify(state));
}

/**
 * Reduce an activity id to the ASCII subset used in the payload header, so it
 * can never collide with the `|` delimiter.
 * @param {string} value
 * @returns {string}
 */
export function sanitizeActivityId(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
}

function buildHeader(activityId, format, savedAt) {
  const stamp = Number.isFinite(savedAt) ? Math.trunc(savedAt) : Date.now();
  return `${PAYLOAD_PREFIX}${sanitizeActivityId(activityId)}${HEADER_SEPARATOR}${format}`
    + `${HEADER_SEPARATOR}${stamp.toString(36)}${HEADER_SEPARATOR}`;
}

function parseHeader(payload) {
  const segments = [];
  let index = PAYLOAD_PREFIX.length;

  // Three header fields, then the remainder is data (which may itself contain '|').
  for (let field = 0; field < 2; field += 1) {
    const separatorIndex = payload.indexOf(HEADER_SEPARATOR, index);
    if (separatorIndex === -1) return null;
    segments.push(payload.slice(index, separatorIndex));
    index = separatorIndex + 1;
  }

  const [activityId, format] = segments;
  const savedAtSeparatorIndex = payload.indexOf(HEADER_SEPARATOR, index);
  if (savedAtSeparatorIndex === -1) return null;

  const savedAt = parseInt(payload.slice(index, savedAtSeparatorIndex), 36);
  return {
    activityId,
    format,
    savedAt: Number.isFinite(savedAt) ? savedAt : 0,
    data: payload.slice(savedAtSeparatorIndex + 1),
  };
}

function buildDecodedState(header, state) {
  const normalized = normalizeDecodedState(state);
  return normalized
    ? { kind: 'state', format: header.format, savedAt: header.savedAt, state: normalized }
    : null;
}

function normalizeDecodedState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  if (typeof state.code !== 'string') return null;
  return state;
}

function normalizeLimit(limit) {
  const value = Number(limit);
  if (!Number.isFinite(value)) return SUSPEND_DATA_MAX_LENGTH;
  return Math.max(SUSPEND_DATA_MIN_LENGTH, Math.trunc(value));
}

function isAscii(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function base64FromUtf8(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}

function utf8FromBase64(base64) {
  return new TextDecoder().decode(base64ToBytes(base64));
}

function compressToBase64(text) {
  return codesToBase64(lzwEncode(new TextEncoder().encode(text)));
}

function decompressFromBase64(base64) {
  return new TextDecoder().decode(lzwDecode(base64ToCodes(base64)));
}

/**
 * LZW encode a byte array into 16-bit codes.
 * @param {Uint8Array} bytes
 * @returns {number[]}
 */
function lzwEncode(bytes) {
  const dictionary = new Map();
  for (let i = 0; i < 256; i++) {
    dictionary.set(String.fromCharCode(i), i);
  }

  let nextCode = 256;
  const codes = [];
  let current = '';

  for (const byte of bytes) {
    const combined = current + String.fromCharCode(byte);
    if (dictionary.has(combined)) {
      current = combined;
      continue;
    }

    codes.push(dictionary.get(current));
    if (nextCode < LZW_DICTIONARY_LIMIT) {
      dictionary.set(combined, nextCode);
      nextCode += 1;
    }
    current = String.fromCharCode(byte);
  }

  if (current !== '') {
    codes.push(dictionary.get(current));
  }
  return codes;
}

/**
 * LZW decode 16-bit codes back into bytes.
 * @param {number[]} codes
 * @returns {Uint8Array}
 */
function lzwDecode(codes) {
  if (codes.length === 0) return new Uint8Array();

  const dictionary = new Map();
  for (let i = 0; i < 256; i++) {
    dictionary.set(i, String.fromCharCode(i));
  }

  let nextCode = 256;
  let previous = String.fromCharCode(codes[0]);
  let output = previous;

  for (let i = 1; i < codes.length; i++) {
    const code = codes[i];
    let entry;
    if (dictionary.has(code)) {
      entry = dictionary.get(code);
    } else if (code === nextCode) {
      entry = previous + previous.charAt(0);
    } else {
      throw new Error(`Invalid LZW code ${code}`);
    }

    output += entry;
    if (nextCode < LZW_DICTIONARY_LIMIT) {
      dictionary.set(nextCode, previous + entry.charAt(0));
      nextCode += 1;
    }
    previous = entry;
  }

  const bytes = new Uint8Array(output.length);
  for (let i = 0; i < output.length; i++) {
    bytes[i] = output.charCodeAt(i);
  }
  return bytes;
}

function codesToBase64(codes) {
  const bytes = new Uint8Array(codes.length * 2);
  for (let i = 0; i < codes.length; i++) {
    bytes[i * 2] = codes[i] & 0xff;
    bytes[i * 2 + 1] = (codes[i] >> 8) & 0xff;
  }
  return bytesToBase64(bytes);
}

function base64ToCodes(base64) {
  const bytes = base64ToBytes(base64);
  const codes = new Array(bytes.length >> 1);
  for (let i = 0; i < codes.length; i++) {
    codes[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
  }
  return codes;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

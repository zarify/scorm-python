/**
 * Workspace state codec — the payload written to SCORM 1.2 `cmi.suspend_data`.
 *
 * The interesting edges are the fixed width of that field (4096 characters,
 * below which the codec would rather store nothing than store a truncated
 * program), the four encodings it chooses between, the ASCII-only data-model
 * type that pushes every non-ASCII value onto the base64/LZW path, and the
 * activity id baked into the header — a payload may only be restored by the
 * activity that wrote it.
 *
 * The state is the student's code payload (`{ code: string }`), so the encoder
 * only has one format to shrink per input and the compact format is
 * byte-identical to the raw JSON.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SUSPEND_DATA_MAX_LENGTH,
  SUSPEND_DATA_MIN_LENGTH,
  compactWorkspaceState,
  decodeWorkspacePayload,
  encodeWorkspaceReference,
  encodeWorkspaceState,
  sanitizeActivityId,
} from '../src/scorm-template/js/workspace-state-codec.js';

/** A fixed timestamp keeps every payload length in this file deterministic. */
const SAVED_AT = 1700000000000;
const SAVED_AT_BASE36 = 'loyw3v28';

const emptyCode = () => ({ code: '' });
const codeState = (code) => ({ code });

/** A deterministic, high-entropy ASCII string: LZW cannot shrink it. */
function noisyText(length, seed = 0x2545f491) {
  let state = seed >>> 0;
  const chars = [];
  for (let i = 0; i < length; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    chars.push(String.fromCharCode(33 + ((state >>> 0) % 94)));
  }
  return chars.join('');
}

/** 140 distinct CJK code points: not ASCII, and not compressible either. */
const uniqueCjk = () => Array.from({ length: 140 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('');

/** Repetitive code: LZW shrinks it well below the raw JSON. */
const repetitiveCode = () => Array.from({ length: 150 }, (_, i) => `print(line ${i % 5})`).join('\n');

const formatOf = (payload) => payload.split('|')[2];
const encode = (overrides) => encodeWorkspaceState({ activityId: 'act', savedAt: SAVED_AT, ...overrides });
const decode = (payload, activityId = 'act') => decodeWorkspacePayload({ payload, activityId });

test('the persisted payload is prefix, activity, format, base36 timestamp, data', () => {
  const payload = encode({ activityId: 'act-1', state: emptyCode() });

  assert.equal(payload, `BS1|act-1|J|${SAVED_AT_BASE36}|{"code":""}`);
  assert.equal(Number.parseInt(SAVED_AT_BASE36, 36), SAVED_AT);
});

test('an ASCII code payload takes the raw JSON format and comes back unchanged', () => {
  const state = codeState('print("hello")\n');

  const payload = encode({ state });

  assert.equal(formatOf(payload), 'J');
  assert.deepEqual(decode(payload), { kind: 'state', format: 'J', savedAt: SAVED_AT, state });
});

test('the compact form is byte-identical to the raw JSON, and the C format still decodes', () => {
  const state = codeState('print("hello")\n');
  const rawJson = JSON.stringify(state);

  // Nothing to strip from a code payload, so compacting cannot shrink it and
  // the C candidate can never beat the raw JSON one out of the encoder.
  assert.equal(JSON.stringify(compactWorkspaceState(state)), rawJson);
  assert.equal(formatOf(encode({ state })), 'J');

  // A payload written by another path in the compact format is still readable.
  assert.deepEqual(decode(`BS1|act|C|${SAVED_AT_BASE36}|${rawJson}`), {
    kind: 'state',
    format: 'C',
    savedAt: SAVED_AT,
    state,
  });
});

test('a non-ASCII program takes the base64 path and the payload stays printable ASCII', () => {
  const code = `${uniqueCjk()} 🚀`;
  const state = codeState(code);

  const payload = encode({ state });

  assert.equal(formatOf(payload), 'B');
  assert.match(payload, /^[\x20-\x7e]+$/);
  assert.equal(decode(payload).state.code, code);
});

test('a large repetitive program takes the LZW path and reloads the same code', () => {
  const state = codeState(repetitiveCode());

  const payload = encode({ state });

  assert.equal(formatOf(payload), 'L');
  assert.ok(payload.length <= SUSPEND_DATA_MAX_LENGTH, 'payload should still fit the SCORM field');
  assert.ok(payload.length < JSON.stringify(state).length, 'compression should beat the raw state');
  assert.equal(decode(payload).savedAt, SAVED_AT);
  assert.equal(decode(payload).state.code, state.code);
});

test('a program large enough to fill the LZW dictionary still round-trips', () => {
  // High-entropy noise fills the 16-bit dictionary, then a long repetition
  // exploits it; the noise alone would never be chosen for compression.
  const code = noisyText(120000) + 'abcdefghij'.repeat(20000);
  const state = codeState(code);

  const payload = encode({ state, limit: 1e6 });

  assert.equal(formatOf(payload), 'L');
  assert.equal(decode(payload).state.code, code);
});

test('a payload exactly at the limit is kept, one character over is refused', () => {
  const state = codeState(uniqueCjk());

  const payload = encode({ state });
  assert.ok(payload.length > SUSPEND_DATA_MIN_LENGTH, 'the exact-fit boundary must sit above the minimum');

  assert.equal(encode({ state, limit: payload.length }), payload);
  assert.equal(encode({ state, limit: payload.length - 1 }), null);
  assert.equal(encode({ state, limit: payload.length - 0.1 }), null);
});

test('the SCORM field width is the default limit, and an oversized program is refused', () => {
  const state = codeState(noisyText(6000));
  const payload = encode({ state, limit: 20000 });

  assert.equal(SUSPEND_DATA_MAX_LENGTH, 4096);
  assert.ok(payload.length > SUSPEND_DATA_MAX_LENGTH);
  assert.equal(decode(payload).state.code, state.code);
  assert.equal(encode({ state }), null);
});

test('a limit under the minimum is raised to the minimum, so only tiny payloads survive', () => {
  const tiny = encode({ state: emptyCode() });
  const overMinimum = encode({ state: codeState(uniqueCjk()) });

  assert.equal(SUSPEND_DATA_MIN_LENGTH, 512);
  assert.ok(tiny.length < SUSPEND_DATA_MIN_LENGTH);
  assert.ok(overMinimum.length > SUSPEND_DATA_MIN_LENGTH);

  for (const limit of [0, 1, -1000, SUSPEND_DATA_MIN_LENGTH - 1]) {
    assert.equal(encode({ state: emptyCode(), limit }), tiny, `limit ${limit} should still admit a tiny payload`);
    assert.equal(encode({ state: codeState(uniqueCjk()), limit }), null, `limit ${limit} should refuse an over-minimum payload`);
  }
  assert.equal(encode({ state: codeState(uniqueCjk()), limit: SUSPEND_DATA_MIN_LENGTH }), null);
});

test('a limit that is not a usable number falls back to the field width', () => {
  const state = codeState(uniqueCjk());
  const payload = encode({ state });

  for (const limit of [NaN, Infinity, -Infinity, 'many', {}, undefined]) {
    assert.equal(encode({ state, limit }), payload, `limit ${String(limit)} should fall back to the maximum`);
  }
  // Numeric strings and fractions are coerced towards the limit they carry.
  assert.equal(encode({ state, limit: '2000' }), payload);
  assert.equal(encode({ state, limit: payload.length + 0.9 }), payload);
  // ...while null coerces to zero and therefore floors at the minimum.
  assert.equal(encode({ state, limit: null }), null);
});

test('a payload is restored only by the activity id that wrote it', () => {
  const state = emptyCode();
  const forA = encode({ state, activityId: 'Act-1' });
  const forB = encode({ state, activityId: 'Act-2' });

  assert.equal(decode(forA, 'Act-1').kind, 'state');
  assert.equal(decode(forB, 'Act-2').kind, 'state');
  assert.equal(decode(forA, 'Act-2'), null);
  assert.equal(decode(forB, 'Act-1'), null);

  // Header ids are compared exactly, after sanitising, so case and stray
  // punctuation both separate two activities.
  assert.equal(decode(forA, 'act-1'), null);
  assert.equal(decode(forA, 'Act-1 '), null);
  assert.equal(decode(forA, ''), null);

  const forDefault = encode({ state, activityId: '' });
  assert.equal(decode(forDefault, 'Act-1'), null);
  assert.equal(decode(forDefault, '').kind, 'state');

  const reference = encodeWorkspaceReference({ activityId: 'Act-1', savedAt: SAVED_AT });
  assert.equal(decode(reference, 'Act-2'), null);
  assert.equal(decode(reference, 'Act-1').kind, 'reference');
});

test('an activity id containing the header delimiter cannot break the framing', () => {
  const state = codeState('print("hi")\n');

  const payload = encode({ state, activityId: 'course|1' });

  assert.equal(payload.split('|')[1], 'course_1');
  assert.equal(formatOf(payload), 'J');
  assert.deepEqual(decode(payload, 'course|1').state, state);
  // Scoping follows the sanitised id, so any id that sanitises to the same
  // string — here the literal 'course_1' — is treated as the same activity.
  assert.equal(decode(payload, 'course_1').kind, 'state');
});

test('an activity id is reduced to the ASCII subset the header can carry', () => {
  assert.equal(sanitizeActivityId('12345'), '12345');
  assert.equal(sanitizeActivityId('course-1.v2_x'), 'course-1.v2_x');
  assert.equal(sanitizeActivityId('a b'), 'a_b');
  assert.equal(sanitizeActivityId('a/b\\c'), 'a_b_c');
  assert.equal(sanitizeActivityId('id|1'), 'id_1');
  assert.equal(sanitizeActivityId('héllo'), 'h_llo');
  assert.equal(sanitizeActivityId('日本'), '__');
  assert.equal(sanitizeActivityId('a🚀b'), 'a__b');
  assert.equal(sanitizeActivityId(''), '');
  assert.equal(sanitizeActivityId(null), '');
  assert.equal(sanitizeActivityId(undefined), '');
  assert.equal(sanitizeActivityId(0), '0');
  assert.equal(sanitizeActivityId(42), '42');

  const long = sanitizeActivityId('x'.repeat(5000) + '€');
  assert.equal(long, `${'x'.repeat(5000)}_`);
});

test('a very long activity id costs payload room without changing the format', () => {
  const state = codeState('hello');
  const activityId = 'a'.repeat(1000);

  const short = encode({ state, activityId: 'a' });
  const long = encode({ state, activityId });

  assert.equal(formatOf(long), formatOf(short));
  assert.equal(long.length, short.length + activityId.length - 1);
  assert.equal(decode(long, activityId).kind, 'state');
  assert.equal(decode(long, 'a'), null);
});

test('a reference payload decodes as a reference that carries no state', () => {
  const reference = encodeWorkspaceReference({ activityId: 'act-1', savedAt: SAVED_AT });

  assert.equal(reference, `BS1|act-1|I|${SAVED_AT_BASE36}|`);
  assert.deepEqual(decodeWorkspacePayload({ payload: reference, activityId: 'act-1' }), {
    kind: 'reference',
    format: 'I',
    savedAt: SAVED_AT,
    state: null,
  });

  const bare = encodeWorkspaceReference({ savedAt: SAVED_AT });
  assert.equal(bare, `BS1||I|${SAVED_AT_BASE36}|`);
  assert.equal(decodeWorkspacePayload({ payload: bare }).kind, 'reference');
});

test('foreign or truncated payloads are refused instead of throwing', (t) => {
  t.mock.method(console, 'warn', () => {});

  const foreign = [
    undefined,
    null,
    '',
    42,
    {},
    [],
    'BS1',
    'BS1|',
    'BS2||J|loyw3v28|{"code":"x"}',
    'bs1||J|loyw3v28|{"code":"x"}',
    'BS1||J',
    'BS1||J|loyw3v28',
    'BS1||J|loyw3v28|',
    'BS1||J|loyw3v28|{oops}',
    'BS1||j|loyw3v28|{"code":"x"}',
    'BS1||X|loyw3v28|{"code":"x"}',
    'BS1||B|loyw3v28|!!!!',
    'BS1||B|loyw3v28|aGVsbG8=',
    'BS1||B|loyw3v28|W10=',
    'BS1||B|loyw3v28|eyJjb2RlIjoxfQ==',
    'BS1||L|loyw3v28|!!!!',
    'BS1||L|loyw3v28|AAAAA',
    'BS1||C|loyw3v28|{"code":1}',
  ];

  for (const payload of foreign) {
    assert.equal(decodeWorkspacePayload({ payload, activityId: '' }), null, `expected ${JSON.stringify(payload)} to be refused`);
  }
  assert.equal(decodeWorkspacePayload(), null);
});

test('a readable body that is not a code state is refused', (t) => {
  t.mock.method(console, 'warn', () => {});

  const bodies = [
    'null',
    '5',
    '"text"',
    '[]',
    '{}',
    '{"code":5}',
    '{"code":null}',
    '{"code":[]}',
    '{"code":{}}',
    '{"code":true}',
    // The old pre-Python shape is a block workspace, not a code payload.
    '{"blocks":5}',
    '{"blocks":{}}',
    '{"blocks":{"blocks":[]}}',
  ];

  for (const body of bodies) {
    assert.equal(decodeWorkspacePayload({ payload: `BS1||J|loyw3v28|${body}` }), null, body);
  }

  assert.deepEqual(decodeWorkspacePayload({ payload: 'BS1||J|loyw3v28|{"code":"x"}' }).state, { code: 'x' });
});

test('a block workspace payload encodes but is refused on decode', () => {
  // The encoder is shape-agnostic; the decoder is what pins the payload to a
  // code state, so a legacy block payload cannot come back as a code state.
  const payload = encode({ state: { blocks: { blocks: [] } } });

  assert.equal(formatOf(payload), 'J');
  assert.equal(decode(payload), null);
  assert.equal(decode(`BS1|act|J|${SAVED_AT_BASE36}|{"blocks":{"blocks":[]}}`), null);
});

test('a pipe inside a code value survives the header intact', () => {
  const state = codeState('print("a|b|c")\n');

  const payload = encode({ state });

  assert.equal(formatOf(payload), 'J');
  assert.equal(decode(payload).state.code, 'print("a|b|c")\n');
});

test('the timestamp survives every format', () => {
  const cases = [
    ['J', codeState('print("hello")\n')],
    ['B', codeState(uniqueCjk())],
    ['L', codeState(repetitiveCode())],
  ];

  for (const [format, state] of cases) {
    const payload = encode({ state });
    assert.equal(formatOf(payload), format);
    assert.equal(decode(payload).savedAt, SAVED_AT);
  }

  // The C format is never chosen by the encoder, but its header carries the
  // same timestamp as the others.
  assert.equal(decode(`BS1|act|C|${SAVED_AT_BASE36}|${JSON.stringify(codeState('x'))}`).savedAt, SAVED_AT);
});

test('a zero, fractional, negative or huge timestamp is kept as written', () => {
  const state = emptyCode();

  assert.equal(decode(encode({ state, savedAt: 0 })).savedAt, 0);
  assert.equal(decode(encode({ state, savedAt: 1000.9 })).savedAt, 1000);
  assert.equal(decode(encode({ state, savedAt: -5 })).savedAt, -5);
  assert.equal(decode(encode({ state, savedAt: Number.MAX_SAFE_INTEGER })).savedAt, Number.MAX_SAFE_INTEGER);
});

test('a missing or unusable timestamp falls back to the encode instant', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1700000000000 });

  for (const savedAt of [undefined, null, NaN, Infinity, '1234', {}]) {
    const payload = encodeWorkspaceState({ activityId: 'act', state: emptyCode(), savedAt });
    assert.equal(decode(payload).savedAt, 1700000000000, `savedAt ${String(savedAt)}`);
  }

  assert.equal(decode(encodeWorkspaceState({ activityId: 'act', state: emptyCode() })).savedAt, 1700000000000);
  assert.equal(
    decodeWorkspacePayload({ payload: encodeWorkspaceReference() }).savedAt,
    1700000000000,
  );
});

test('encoding without a code state produces no payload', () => {
  for (const state of [undefined, null, 'text', 7, true, () => {}]) {
    assert.equal(encodeWorkspaceState({ activityId: 'act', savedAt: SAVED_AT, state }), null, String(state));
  }
  assert.equal(encodeWorkspaceState(), null);
  assert.equal(encodeWorkspaceState({ savedAt: SAVED_AT }), null);
  assert.equal(encodeWorkspaceState({ state: null, limit: 1e6 }), null);
});

test('compacting returns a JSON clone of the code state and leaves the input alone', () => {
  const state = { code: 'print("hi")\n', unused: undefined, nested: { n: 1 } };
  const before = { code: 'print("hi")\n', unused: undefined, nested: { n: 1 } };

  const compact = compactWorkspaceState(state);

  assert.notEqual(compact, state);
  assert.deepEqual(state, before);
  // Nothing is stripped: properties JSON cannot carry are dropped, and that is
  // the only difference from the input.
  assert.deepEqual(compact, { code: 'print("hi")\n', nested: { n: 1 } });
  assert.equal(JSON.stringify(compact), `{"code":"print(\\"hi\\")\\n","nested":{"n":1}}`);
});

test('compacting tolerates partial and unrecognised shapes', () => {
  assert.deepEqual(compactWorkspaceState({}), {});
  assert.deepEqual(compactWorkspaceState({ code: '' }), { code: '' });
  assert.deepEqual(compactWorkspaceState({ code: 'x', blocks: { blocks: null } }), {
    code: 'x',
    blocks: { blocks: null },
  });
});

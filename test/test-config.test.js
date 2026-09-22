/**
 * Test case configuration helpers — the shapes the builder writes and the
 * runtime reads back.
 *
 * The interesting edges are the ones a hand-edited config can carry: points that
 * arrive as strings, prompt input text that came from a textarea (so strings,
 * blank lines, CRLF), assertion objects that only set a couple of fields,
 * execution contexts that name a function without declaring a scope, and
 * list/function/file assertion blocks that are partial or malformed.
 *
 * `test-config.js` keeps no mutable module state, so tests import it directly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatPromptInputs,
  getCodeStructureConditions,
  getFileStateContentAssertion,
  getFileStateCsvAssertions,
  getFileStatePath,
  getFunctionReturnAssertion,
  getPromptInputs,
  getStdoutExecutionContext,
  getStdoutOutputAssertion,
  getStdoutPromptAssertion,
  getTestPoints,
  getVariableListAssertions,
  hasEnabledListAssertion,
  hasEnabledStdoutAssertion,
  normalizeFileStateFormat,
  normalizeFunctionParameterCountEnabled,
  normalizeListExpectedTypes,
  normalizeListIndexChecks,
  normalizeListLengthComparison,
  normalizeListItemTypeMode,
  normalizeListValueMatchMode,
  normalizeRuntimeExecutionScope,
  normalizeRuntimeTextAssertion,
  normalizeRuntimeTextMatchMode,
  normalizeTestCase,
  normalizeTestConfig,
  normalizeVariableType,
  normalizeVariableValueAssertionEnabled,
  normalizeVariableValueComparison,
  parsePromptInputs,
  setTestPoints,
  shouldEnforcePromptInputCount,
} from '../src/shared/test-config.js';

/** A normalized runtime text assertion with the Python field set. */
function textAssertion(overrides = {}) {
  return {
    enabled: false,
    expected: '',
    match_mode: 'exact',
    show_expected: false,
    show_actual: false,
    success_message: '',
    failure_message: '',
    ...overrides,
  };
}

function listAssertions(overrides = {}) {
  return {
    length_enabled: false,
    length_value: 0,
    length_comparison: 'equals',
    values_enabled: false,
    values_match_mode: 'exact_order',
    expected_values: [],
    item_types_enabled: false,
    item_type_mode: 'all',
    expected_item_types: [],
    index_checks: [],
    ...overrides,
  };
}

function returnAssertion(overrides = {}) {
  return {
    enabled: false,
    arguments: [],
    expected_type: 'any',
    value_assertion_enabled: false,
    comparison: 'equals',
    show_coerced_value_hint: false,
    show_expected: false,
    show_actual: false,
    success_message: '',
    failure_message: '',
    list_assertions: listAssertions(),
    ...overrides,
  };
}

test('points are read as non-negative integers from the points field', () => {
  assert.equal(getTestPoints({ points: 5 }), 5);
  assert.equal(getTestPoints({ points: '12' }), 12);
  assert.equal(getTestPoints({ points: '  8  ' }), 8);
  assert.equal(getTestPoints({ points: 5.9 }), 5);
  assert.equal(getTestPoints({ points: -3 }), 0);
  assert.equal(getTestPoints({ points: '-2' }), 0);
  assert.equal(getTestPoints({ points: -0.5 }), 0);
  assert.equal(getTestPoints({ points: NaN }), 0);
  assert.equal(getTestPoints({ points: Infinity }), 0);
  assert.equal(getTestPoints({ points: 'abc' }), 0);
  assert.equal(getTestPoints({ points: true }), 1);
  assert.equal(getTestPoints({ points: {} }), 0);
  assert.equal(getTestPoints({}), 0);
  assert.equal(getTestPoints(null), 0);
  assert.equal(getTestPoints(undefined), 0);

  // The Blockly-era `weight` alias is not part of the Python config.
  assert.equal(getTestPoints({ weight: 7 }), 0);
});

test('setting points writes a non-negative integer', () => {
  const fractional = { points: 3 };
  setTestPoints(fractional, '4.7');
  assert.deepEqual(fractional, { points: 4 });

  const negative = { points: 1 };
  setTestPoints(negative, -4);
  assert.deepEqual(negative, { points: 0 });

  const junk = { points: 1 };
  setTestPoints(junk, 'abc');
  assert.deepEqual(junk, { points: 0 });

  const zero = { points: 3 };
  setTestPoints(zero, 0);
  assert.deepEqual(zero, { points: 0 });
});

test('prompt inputs are read as text, and a non-array reads as none', () => {
  assert.deepEqual(getPromptInputs({ prompt_inputs: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(getPromptInputs({ prompt_inputs: [] }), []);
  assert.deepEqual(getPromptInputs({ prompt_inputs: 'a\nb' }), []);
  assert.deepEqual(getPromptInputs({ prompt_inputs: null }), []);
  assert.deepEqual(getPromptInputs({}), []);
  assert.deepEqual(getPromptInputs(null), []);

  assert.deepEqual(
    getPromptInputs({ prompt_inputs: [1, null, undefined, true, { a: 1 }] }),
    ['1', 'null', 'undefined', 'true', '[object Object]'],
  );
});

test('prompt input text round-trips through parse and format', () => {
  assert.deepEqual(parsePromptInputs(''), []);
  assert.deepEqual(parsePromptInputs('a'), ['a']);
  assert.deepEqual(parsePromptInputs('a\nb'), ['a', 'b']);
  assert.deepEqual(parsePromptInputs('a\r\nb'), ['a', 'b']);
  assert.deepEqual(parsePromptInputs('a\n'), ['a', '']);
  assert.deepEqual(parsePromptInputs('\n'), ['', '']);
  assert.deepEqual(parsePromptInputs('  a  \n b'), ['  a  ', ' b']);

  // Quotes, numbers and JSON-ish text are learner input, not markup.
  assert.deepEqual(parsePromptInputs('"hi"\n42\n{"a":1}'), ['"hi"', '42', '{"a":1}']);

  for (const text of ['', 'a', 'a\nb', 'a\n', '{"a":1}\n  spaced  ', 'x\ny\nz']) {
    assert.equal(formatPromptInputs(parsePromptInputs(text)), text);
  }

  assert.equal(formatPromptInputs(['a', '', 1]), 'a\n\n1');
  assert.equal(formatPromptInputs('not-an-array'), '');
  assert.equal(formatPromptInputs(null), '');
});

test('only an explicit false turns off strict prompt input counting', () => {
  assert.equal(shouldEnforcePromptInputCount({}), true);
  assert.equal(shouldEnforcePromptInputCount(null), true);
  assert.equal(shouldEnforcePromptInputCount({ strict_prompt_inputs: true }), true);
  assert.equal(shouldEnforcePromptInputCount({ strict_prompt_inputs: false }), false);
  assert.equal(shouldEnforcePromptInputCount({ strict_prompt_inputs: 0 }), true);
  assert.equal(shouldEnforcePromptInputCount({ strict_prompt_inputs: null }), true);
  assert.equal(shouldEnforcePromptInputCount({ strict_prompt_inputs: 'false' }), true);
});

test('function tests never enforce a prompt input count', () => {
  assert.equal(shouldEnforcePromptInputCount({ type: 'function_state' }), false);
  assert.equal(shouldEnforcePromptInputCount({ type: 'function_state', strict_prompt_inputs: true }), false);
  assert.equal(shouldEnforcePromptInputCount({ type: 'function_state', strict_prompt_inputs: false }), false);
  assert.equal(shouldEnforcePromptInputCount({ type: 'stdout_match' }), true);
  assert.equal(shouldEnforcePromptInputCount({ type: 'file_state' }), true);
});

test('runtime text match modes accept exact, contains and regex only', () => {
  assert.equal(normalizeRuntimeTextMatchMode('exact'), 'exact');
  assert.equal(normalizeRuntimeTextMatchMode('contains'), 'contains');
  assert.equal(normalizeRuntimeTextMatchMode('regex'), 'regex');
  assert.equal(normalizeRuntimeTextMatchMode('regex_full'), 'exact');
  assert.equal(normalizeRuntimeTextMatchMode('full'), 'exact');
  assert.equal(normalizeRuntimeTextMatchMode(''), 'exact');
  assert.equal(normalizeRuntimeTextMatchMode(null), 'exact');
  assert.equal(normalizeRuntimeTextMatchMode(undefined), 'exact');
  assert.equal(normalizeRuntimeTextMatchMode('EXACT'), 'exact');
});

test('a runtime text assertion is normalized field by field', () => {
  assert.deepEqual(normalizeRuntimeTextAssertion(undefined), textAssertion());

  // A non-object assertion is ignored rather than rejected.
  assert.deepEqual(normalizeRuntimeTextAssertion('x'), normalizeRuntimeTextAssertion(undefined));
  assert.deepEqual(normalizeRuntimeTextAssertion([1, 2]), normalizeRuntimeTextAssertion(undefined));
  assert.deepEqual(normalizeRuntimeTextAssertion(null), normalizeRuntimeTextAssertion(undefined));

  // Values are coerced to the types the runtime reads.
  assert.deepEqual(
    normalizeRuntimeTextAssertion({
      enabled: 0,
      expected: 5,
      match_mode: 'nonsense',
      show_expected: 'yes',
      show_actual: null,
      success_message: 3,
      failure_message: undefined,
    }),
    textAssertion({
      expected: '5',
      show_expected: true,
      success_message: '3',
    }),
  );
});

test('assertion defaults fill gaps but never override an explicit value', () => {
  const defaults = textAssertion({
    enabled: true,
    expected: 'fallback',
    match_mode: 'contains',
    show_expected: true,
    show_actual: true,
    success_message: 'ok',
    failure_message: 'no',
  });

  assert.deepEqual(normalizeRuntimeTextAssertion(null, defaults), defaults);

  assert.deepEqual(
    normalizeRuntimeTextAssertion({ enabled: false, expected: '', match_mode: 'regex' }, defaults),
    { ...defaults, enabled: false, expected: '', match_mode: 'regex' },
  );
});

test('the output assertion is enabled by a configured block', () => {
  assert.equal(getStdoutOutputAssertion({}).enabled, false);
  assert.equal(getStdoutOutputAssertion(undefined).enabled, false);

  // A configured assertion defaults to enabled, even without the flag.
  const configured = getStdoutOutputAssertion({ output_assertion: { expected: 'x' } });
  assert.equal(configured.enabled, true);
  assert.equal(configured.expected, 'x');
  assert.equal(configured.match_mode, 'exact');

  assert.equal(
    getStdoutOutputAssertion({ output_assertion: { enabled: false, expected: 'x' } }).enabled,
    false,
  );

  // An explicit default overrides the derivation.
  assert.equal(getStdoutOutputAssertion({}, { defaultEnabled: true }).enabled, true);
  assert.equal(
    getStdoutOutputAssertion({ output_assertion: {} }, { defaultEnabled: false }).enabled,
    false,
  );

  // Python asserts on the joined transcript, so item matching is not a field.
  const withItemFlag = getStdoutOutputAssertion({ output_assertion: { expected: 'x', match_any_item: true } });
  assert.equal('match_any_item' in withItemFlag, false);

  // A malformed assertion object is ignored rather than rejected.
  assert.deepEqual(getStdoutOutputAssertion({ output_assertion: [1] }), getStdoutOutputAssertion({}));

  // The Blockly-era expected_output/match_mode aliases are ignored.
  const legacy = getStdoutOutputAssertion({ expected_output: 'hi\n', match_mode: 'contains' });
  assert.equal(legacy.enabled, false);
  assert.equal(legacy.expected, '');
});

test('the prompt assertion is enabled only when one is configured', () => {
  assert.equal(getStdoutPromptAssertion({}).enabled, false);
  assert.equal(getStdoutPromptAssertion({ prompt_assertion: null }).enabled, false);
  assert.equal(getStdoutPromptAssertion({ prompt_assertion: 'x' }).enabled, false);

  const configured = getStdoutPromptAssertion({ prompt_assertion: { expected: 'p' } });
  assert.equal(configured.enabled, true);
  assert.equal(configured.expected, 'p');
  assert.equal(configured.match_mode, 'exact');
  assert.equal(configured.match_any_item, false);

  const perItem = getStdoutPromptAssertion({
    prompt_assertion: { expected: 'p', match_mode: 'regex', match_any_item: 'yes' },
  });
  assert.equal(perItem.match_any_item, true);
  assert.equal(perItem.match_mode, 'regex');

  assert.equal(
    getStdoutPromptAssertion({ prompt_assertion: {} }, { defaultEnabled: false }).enabled,
    false,
  );
});

test('a stdout test counts as asserting when either side is enabled', () => {
  assert.equal(hasEnabledStdoutAssertion({}), false);
  assert.equal(hasEnabledStdoutAssertion({ output_assertion: { enabled: true } }), true);
  assert.equal(hasEnabledStdoutAssertion({ output_assertion: { enabled: false } }), false);
  assert.equal(hasEnabledStdoutAssertion({ prompt_assertion: { expected: 'p' } }), true);
  assert.equal(
    hasEnabledStdoutAssertion({
      output_assertion: { enabled: false },
      prompt_assertion: { enabled: false },
    }),
    false,
  );
});

test('an execution context defaults to main and carries the function details otherwise', () => {
  assert.deepEqual(getStdoutExecutionContext(undefined), { scope: 'main', function_name: '', arguments: [] });
  assert.deepEqual(getStdoutExecutionContext({ execution_context: { scope: 'main' } }), {
    scope: 'main',
    function_name: '',
    arguments: [],
  });

  // Naming a function or listing arguments is enough to select function scope.
  assert.deepEqual(getStdoutExecutionContext({ execution_context: { function_name: 'solve' } }), {
    scope: 'function',
    function_name: 'solve',
    arguments: [],
  });
  assert.deepEqual(getStdoutExecutionContext({ execution_context: { arguments: ['a'] } }), {
    scope: 'function',
    function_name: '',
    arguments: ['a'],
  });

  // An unrecognised scope wins over the function fields and drops them.
  assert.deepEqual(
    getStdoutExecutionContext({ execution_context: { scope: 'nonsense', function_name: 'solve' } }),
    { scope: 'main', function_name: '', arguments: [] },
  );
  assert.deepEqual(
    getStdoutExecutionContext({ execution_context: { scope: null, function_name: 'solve' } }),
    { scope: 'main', function_name: '', arguments: [] },
  );
  assert.deepEqual(
    getStdoutExecutionContext({ execution_context: { scope: 'main', function_name: 'solve' } }),
    { scope: 'main', function_name: '', arguments: [] },
  );

  // Malformed function fields are coerced, not rejected.
  assert.deepEqual(
    getStdoutExecutionContext({ execution_context: { scope: 'function', function_name: 7 } }),
    { scope: 'function', function_name: '7', arguments: [] },
  );
  assert.deepEqual(
    getStdoutExecutionContext({ execution_context: { scope: 'function', arguments: 'x' } }),
    { scope: 'function', function_name: '', arguments: [] },
  );
  assert.deepEqual(getStdoutExecutionContext({ execution_context: 'x' }), {
    scope: 'main',
    function_name: '',
    arguments: [],
  });

  assert.equal(normalizeRuntimeExecutionScope('function'), 'function');
  assert.equal(normalizeRuntimeExecutionScope('main'), 'main');
  assert.equal(normalizeRuntimeExecutionScope('jit'), 'main');
  assert.equal(normalizeRuntimeExecutionScope(undefined), 'main');
});

test('Python variable types are validated and junk falls back', () => {
  for (const type of ['any', 'int', 'float', 'bool', 'string', 'list', 'tuple', 'dict', 'null']) {
    assert.equal(normalizeVariableType(type), type);
  }

  assert.equal(normalizeVariableType('number'), 'any');
  assert.equal(normalizeVariableType('list<int>'), 'any');
  assert.equal(normalizeVariableType(''), 'any');
  assert.equal(normalizeVariableType(undefined), 'any');
  assert.equal(normalizeVariableType(null), 'any');
});

test('comparisons, list modes and file formats are validated, junk falls back', () => {
  assert.equal(normalizeVariableValueComparison('equals'), 'equals');
  assert.equal(normalizeVariableValueComparison('contains'), 'contains');
  assert.equal(normalizeVariableValueComparison('gte'), 'gte');
  assert.equal(normalizeVariableValueComparison('type'), 'equals');
  assert.equal(normalizeVariableValueComparison(undefined), 'equals');

  assert.equal(normalizeListLengthComparison('gt'), 'gt');
  assert.equal(normalizeListLengthComparison('lte'), 'lte');
  assert.equal(normalizeListLengthComparison('eq'), 'equals');
  assert.equal(normalizeListLengthComparison('contains'), 'equals');
  assert.equal(normalizeListLengthComparison(undefined), 'equals');

  assert.equal(normalizeListValueMatchMode('same_values_any_order'), 'same_values_any_order');
  assert.equal(normalizeListValueMatchMode('expected_subset_of_actual'), 'expected_subset_of_actual');
  assert.equal(normalizeListValueMatchMode('exact'), 'exact_order');
  assert.equal(normalizeListValueMatchMode(undefined), 'exact_order');

  assert.equal(normalizeListItemTypeMode('some'), 'some');
  assert.equal(normalizeListItemTypeMode('none'), 'none');
  assert.equal(normalizeListItemTypeMode('any'), 'all');
  assert.equal(normalizeListItemTypeMode(undefined), 'all');

  assert.equal(normalizeFileStateFormat('text'), 'text');
  assert.equal(normalizeFileStateFormat('csv'), 'csv');
  assert.equal(normalizeFileStateFormat('binary'), 'binary');
  assert.equal(normalizeFileStateFormat('JSON'), 'text');
  assert.equal(normalizeFileStateFormat(undefined), 'text');
});

test('expected item types drop "any" and anything that is not a list', () => {
  assert.deepEqual(
    normalizeListExpectedTypes(['int', 'any', 'tuple', 'nonsense', 5, null]),
    ['int', 'tuple'],
  );
  assert.deepEqual(normalizeListExpectedTypes(['bool', 'dict', 'null']), ['bool', 'dict', 'null']);
  // A missing entry must not read as the Python `null` type.
  assert.deepEqual(normalizeListExpectedTypes([null, undefined]), []);
  assert.deepEqual(normalizeListExpectedTypes([]), []);
  assert.deepEqual(normalizeListExpectedTypes('int'), []);
  assert.deepEqual(normalizeListExpectedTypes(undefined), []);
});

test('list index checks are clamped, type-normalized and keep explicit values', () => {
  assert.deepEqual(
    normalizeListIndexChecks([
      { index: '2.9', expected_type: 'int' },
      { index: -3 },
      { index: 'a', expected_value: 0 },
      { index: 1, expected_value: undefined },
      'not-an-object',
      null,
    ]),
    [
      { index: 2, expected_type: 'int' },
      { index: 0, expected_type: 'any' },
      { index: 0, expected_value: 0, expected_type: 'any' },
      { index: 1, expected_type: 'any' },
    ],
  );
  assert.deepEqual(normalizeListIndexChecks({ index: 0 }), []);
  assert.deepEqual(normalizeListIndexChecks(undefined), []);
});

test('list assertions normalize a partial or malformed block', () => {
  assert.deepEqual(getVariableListAssertions(undefined), listAssertions());

  assert.deepEqual(
    getVariableListAssertions({
      list_assertions: {
        length_enabled: 1,
        length_value: 'x',
        length_comparison: 'gt',
        values_enabled: 0,
        values_match_mode: 'nope',
        expected_values: 'not-an-array',
        item_types_enabled: 'y',
        item_type_mode: 'some',
        expected_item_types: ['int', 'any'],
        index_checks: [{ index: 1 }],
      },
    }),
    listAssertions({
      length_enabled: true,
      length_comparison: 'gt',
      item_types_enabled: true,
      item_type_mode: 'some',
      expected_item_types: ['int'],
      index_checks: [{ index: 1, expected_type: 'any' }],
    }),
  );

  const negative = getVariableListAssertions({ list_assertions: { length_value: -4 } });
  assert.equal(negative.length_value, 0);
  const fractional = getVariableListAssertions({ list_assertions: { length_value: '3.9' } });
  assert.equal(fractional.length_value, 3);

  // An array is not a valid assertion block, so the defaults apply.
  assert.deepEqual(getVariableListAssertions({ list_assertions: [1] }), getVariableListAssertions({}));
});

test('a return assertion normalizes partial input and derives its enabled flag', () => {
  assert.deepEqual(getFunctionReturnAssertion(undefined), returnAssertion());

  const partial = getFunctionReturnAssertion({
    return_assertion: { expected_type: 'int', comparison: 'nope', expected_value: 5 },
  });
  assert.equal(partial.enabled, true);
  assert.equal(partial.expected_type, 'int');
  assert.equal(partial.comparison, 'equals');
  assert.equal(partial.expected_value, 5);
  assert.equal(partial.value_assertion_enabled, true);

  // Any assertion-shaped field switches the assertion on.
  assert.equal(getFunctionReturnAssertion({ return_assertion: { arguments: [1] } }).enabled, true);
  assert.equal(getFunctionReturnAssertion({ return_assertion: { show_actual: true } }).enabled, true);
  assert.equal(
    getFunctionReturnAssertion({ return_assertion: { enabled: false, expected_value: 5 } }).enabled,
    false,
  );

  // A list assertion also counts as a reason to run the return assertion.
  const listOnly = getFunctionReturnAssertion({
    return_assertion: { list_assertions: { length_enabled: true, length_value: 2 } },
  });
  assert.equal(listOnly.enabled, true);
  assert.equal(listOnly.list_assertions.length_enabled, true);
  assert.equal(listOnly.list_assertions.length_value, 2);

  // Python comparisons include `contains` and have dropped `type`.
  assert.equal(
    getFunctionReturnAssertion({ return_assertion: { comparison: 'contains' } }).comparison,
    'contains',
  );
  assert.equal(getFunctionReturnAssertion({ return_assertion: { comparison: 'type' } }).comparison, 'equals');

  // A malformed assertion block behaves like a missing one.
  assert.deepEqual(getFunctionReturnAssertion({ return_assertion: 'x' }), getFunctionReturnAssertion({}));

  // expected_value is only carried when it was actually set.
  assert.equal('expected_value' in getFunctionReturnAssertion({}), false);
  assert.equal('expected_value' in getFunctionReturnAssertion({ return_assertion: { expected_value: null } }), true);
});

test('value assertion enablement falls back to the presence of an expected value', () => {
  assert.equal(normalizeVariableValueAssertionEnabled({}), false);
  assert.equal(normalizeVariableValueAssertionEnabled(null), false);
  assert.equal(normalizeVariableValueAssertionEnabled({}, { defaultEnabled: true }), true);
  assert.equal(normalizeVariableValueAssertionEnabled({}, { defaultEnabled: false }), false);
  assert.equal(normalizeVariableValueAssertionEnabled({ expected_value: 0 }), true);
  assert.equal(normalizeVariableValueAssertionEnabled({ expected_value: undefined }), false);
  assert.equal(normalizeVariableValueAssertionEnabled({ value_assertion_enabled: false, expected_value: 1 }), false);
  assert.equal(normalizeVariableValueAssertionEnabled({ value_assertion_enabled: 0 }), false);
  assert.equal(normalizeVariableValueAssertionEnabled({ value_assertion_enabled: 'yes' }), true);
});

test('parameter count enablement and list assertion presence are booleans', () => {
  assert.equal(normalizeFunctionParameterCountEnabled({}), false);
  assert.equal(normalizeFunctionParameterCountEnabled(null), false);
  assert.equal(normalizeFunctionParameterCountEnabled({ parameter_count_enabled: true }), true);
  assert.equal(normalizeFunctionParameterCountEnabled({ parameter_count_enabled: 'yes' }), true);
  assert.equal(normalizeFunctionParameterCountEnabled({ parameter_count_enabled: 0 }), false);

  assert.equal(hasEnabledListAssertion({}), false);
  assert.equal(hasEnabledListAssertion({ list_assertions: { length_enabled: true } }), true);
  assert.equal(hasEnabledListAssertion({ list_assertions: { values_enabled: true } }), true);
  assert.equal(hasEnabledListAssertion({ list_assertions: { item_types_enabled: true } }), true);
  assert.equal(hasEnabledListAssertion({ list_assertions: { index_checks: [{ index: 0 }] } }), true);
});

test('a stdout_match case gains the modern shape in place', () => {
  const testCase = {
    id: 't',
    type: 'stdout_match',
    prompt_inputs: ['a', 2],
    points: '8',
    output_assertion: { expected: 'hi\n', match_mode: 'regex' },
    prompt_assertion: { expected: 'Name\\?', match_mode: 'regex', match_any_item: true },
  };

  const result = normalizeTestCase(testCase);

  assert.equal(result, testCase, 'normalization is in place');
  assert.deepEqual(result, {
    id: 't',
    type: 'stdout_match',
    prompt_inputs: ['a', '2'],
    points: 8,
    strict_prompt_inputs: true,
    output_assertion: textAssertion({ enabled: true, expected: 'hi\n', match_mode: 'regex' }),
    prompt_assertion: {
      ...textAssertion({ enabled: true, expected: 'Name\\?', match_mode: 'regex' }),
      match_any_item: true,
    },
    execution_context: { scope: 'main', function_name: '', arguments: [] },
  });
});

test('a stdout_match case keeps its explicit strictness and function scope', () => {
  const result = normalizeTestCase({
    id: 't',
    type: 'stdout_match',
    strict_prompt_inputs: false,
    output_assertion: { enabled: false },
    execution_context: { scope: 'function', function_name: 'run', arguments: [1] },
  });

  assert.equal(result.strict_prompt_inputs, false);
  assert.equal(result.output_assertion.enabled, false);
  assert.deepEqual(result.execution_context, { scope: 'function', function_name: 'run', arguments: [1] });
});

test('a stdout_match case can be normalized twice without changing shape', () => {
  const once = normalizeTestCase({ type: 'stdout_match', output_assertion: { expected: 'x' }, points: 2 });
  const snapshot = structuredClone(once);
  assert.deepEqual(normalizeTestCase(once), snapshot);
});

test('a variable_state case gains defaults and normalizes its list assertions', () => {
  const result = normalizeTestCase({
    id: 'v',
    type: 'variable_state',
    variable_name: 'items',
    points: 3,
    list_assertions: { length_enabled: true, length_value: '2.5' },
  });

  assert.equal(result.points, 3);
  assert.equal(result.strict_prompt_inputs, true);
  assert.equal(result.expected_type, 'any');
  assert.equal(result.value_assertion_enabled, false);
  assert.equal(result.comparison, 'equals');
  assert.equal(result.show_coerced_value_hint, false);
  assert.equal(result.list_assertions.length_enabled, true);
  assert.equal(result.list_assertions.length_value, 2);

  // An explicit false survives normalization.
  const lenient = normalizeTestCase({ type: 'variable_state', strict_prompt_inputs: false });
  assert.equal(lenient.strict_prompt_inputs, false);

  // A configured expected value turns the value assertion on.
  const valued = normalizeTestCase({
    type: 'variable_state',
    variable_name: 'count',
    expected_type: 'int',
    expected_value: 3,
    comparison: 'gte',
  });
  assert.equal(valued.value_assertion_enabled, true);
  assert.equal(valued.expected_type, 'int');
  assert.equal(valued.comparison, 'gte');

  // Legacy comparisons fall back to equals.
  assert.equal(normalizeTestCase({ type: 'variable_state', comparison: 'type' }).comparison, 'equals');
});

test('a function_state case drops prompt input settings and clamps its counts', () => {
  const result = normalizeTestCase({
    id: 'f',
    type: 'function_state',
    function_name: 'solve',
    prompt_inputs: ['a'],
    strict_prompt_inputs: false,
    parameter_count: '2.7',
    parameter_count_enabled: 1,
    return_assertion: { expected_value: 'z' },
  });

  assert.equal('prompt_inputs' in result, false);
  assert.equal('strict_prompt_inputs' in result, false);
  assert.equal(result.parameter_count, 2);
  assert.equal(result.parameter_count_enabled, true);
  assert.equal(result.return_assertion.enabled, true);
  assert.equal(result.return_assertion.expected_value, 'z');

  const negative = normalizeTestCase({ type: 'function_state', parameter_count: -3 });
  assert.equal(negative.parameter_count, 0);
  const junk = normalizeTestCase({ type: 'function_state', parameter_count: 'abc' });
  assert.equal(junk.parameter_count, 0);
});

test('a code_structure case keeps its conditions and normalizes only points', () => {
  const conditions = { type: 'ast_pattern', pattern: 'print(...)' };
  const result = normalizeTestCase({
    id: 'c',
    type: 'code_structure',
    points: '2.7',
    conditions,
    feedback_on_fail: 'Print something.',
  });

  assert.deepEqual(result, {
    id: 'c',
    type: 'code_structure',
    points: 2,
    conditions,
    feedback_on_fail: 'Print something.',
  });
  assert.equal(getCodeStructureConditions(result), conditions);
  assert.equal(getCodeStructureConditions({}), undefined);
});

test('a file_state case gains path, format and assertion defaults', () => {
  const result = normalizeTestCase({ id: 'f', type: 'file_state', points: '2', path: 'result.txt' });

  assert.deepEqual(result, {
    id: 'f',
    type: 'file_state',
    points: 2,
    path: 'result.txt',
    exists: true,
    format: 'text',
    strict_prompt_inputs: true,
    content_assertion: textAssertion(),
    csv_assertions: { row_count: null, row_count_comparison: 'equals', header: null, cells: [] },
  });
});

test('a file_state case keeps its explicit settings', () => {
  const result = normalizeTestCase({
    id: 'f',
    type: 'file_state',
    path: 'out/result.csv',
    exists: false,
    format: 'csv',
    prompt_inputs: [1],
    strict_prompt_inputs: false,
    content_assertion: { enabled: true, expected: 'x', match_mode: 'regex', show_actual: true },
    csv_assertions: {
      row_count: '2',
      row_count_comparison: 'gte',
      header: ['name', 'score'],
      cells: [{ row: '1', column: '0', expected_value: '7', comparison: 'gt', expected_type: 'int' }],
    },
  });

  assert.equal(result.path, 'out/result.csv');
  assert.equal(result.exists, false);
  assert.equal(result.format, 'csv');
  assert.deepEqual(result.prompt_inputs, ['1']);
  assert.equal(result.strict_prompt_inputs, false);
  assert.deepEqual(result.content_assertion, textAssertion({
    enabled: true,
    expected: 'x',
    match_mode: 'regex',
    show_actual: true,
  }));
  assert.deepEqual(result.csv_assertions, {
    row_count: 2,
    row_count_comparison: 'gte',
    header: ['name', 'score'],
    cells: [{ row: 1, column: 0, expected_value: '7', comparison: 'gt', expected_type: 'int' }],
  });
});

test('the file_state getters default and coerce their inputs', () => {
  assert.equal(getFileStatePath({}), '');
  assert.equal(getFileStatePath(null), '');
  assert.equal(getFileStatePath({ path: null }), '');
  assert.equal(getFileStatePath({ path: 'out/result.csv' }), 'out/result.csv');
  assert.equal(getFileStatePath({ path: 5 }), '5');

  assert.deepEqual(getFileStateContentAssertion({}), textAssertion());
  assert.deepEqual(getFileStateContentAssertion(null), textAssertion());
  assert.deepEqual(
    getFileStateContentAssertion({ content_assertion: { enabled: true, expected: 'x', match_mode: 'nope' } }),
    textAssertion({ enabled: true, expected: 'x' }),
  );

  const csvDefaults = { row_count: null, row_count_comparison: 'equals', header: null, cells: [] };
  assert.deepEqual(getFileStateCsvAssertions({}), csvDefaults);
  assert.deepEqual(getFileStateCsvAssertions(null), csvDefaults);
  assert.deepEqual(getFileStateCsvAssertions({ csv_assertions: [1] }), csvDefaults);
  assert.deepEqual(
    getFileStateCsvAssertions({ csv_assertions: { row_count: 'abc', row_count_comparison: 'nope', header: 'x', cells: 'x' } }),
    csvDefaults,
  );
  // An empty row count means "not asserted", not "zero rows".
  assert.equal(getFileStateCsvAssertions({ csv_assertions: { row_count: '' } }).row_count, null);
  assert.equal(getFileStateCsvAssertions({ csv_assertions: { row_count: -2 } }).row_count, 0);

  assert.deepEqual(
    getFileStateCsvAssertions({
      csv_assertions: {
        row_count: 2.9,
        header: ['a', 1],
        cells: [
          { row: 1, column: 0, expected_type: 'int', comparison: 'gt', expected_value: '7' },
          'junk',
          null,
          { row: -1, column: '2.7' },
        ],
      },
    }),
    {
      row_count: 2,
      row_count_comparison: 'equals',
      header: ['a', '1'],
      cells: [
        { row: 1, column: 0, expected_value: '7', comparison: 'gt', expected_type: 'int' },
        { row: 0, column: 2, comparison: 'equals', expected_type: 'any' },
      ],
    },
  );
});

test('an unknown test type keeps its fields and only normalizes points and inputs', () => {
  const result = normalizeTestCase({
    id: 'b',
    type: 'widget_check',
    points: '5abc',
    prompt_inputs: 'stale',
    strict_prompt_inputs: false,
    custom_field: 1,
  });

  assert.deepEqual(result, {
    id: 'b',
    type: 'widget_check',
    prompt_inputs: [],
    strict_prompt_inputs: false,
    custom_field: 1,
    points: 0,
  });
});

test('normalizing a non-object test case returns it untouched', () => {
  assert.equal(normalizeTestCase(null), null);
  assert.equal(normalizeTestCase(undefined), undefined);
  assert.equal(normalizeTestCase('x'), 'x');
  assert.equal(normalizeTestCase(42), 42);
});

test('normalizeTestConfig rewrites every case and tolerates a missing list', () => {
  const config = {
    evaluation: {
      test_cases: [
        { id: 'a', type: 'code_structure', points: 2, conditions: { type: 'ast_pattern', pattern: 'print(...)' } },
        { id: 'b', type: 'stdout_match', output_assertion: { expected: 'x' } },
      ],
    },
  };

  const result = normalizeTestConfig(config);

  assert.equal(result, config, 'normalization is in place');
  assert.equal(result.evaluation.test_cases[0].points, 2);
  assert.equal(result.evaluation.test_cases[1].output_assertion.expected, 'x');

  const noEvaluation = {};
  assert.equal(normalizeTestConfig(noEvaluation), noEvaluation);
  const nullList = { evaluation: { test_cases: null } };
  assert.equal(normalizeTestConfig(nullList), nullList);
  const stringList = { evaluation: { test_cases: 'x' } };
  assert.equal(normalizeTestConfig(stringList), stringList);
  assert.equal(normalizeTestConfig(null), null);
  assert.deepEqual(normalizeTestConfig({ evaluation: { test_cases: [] } }), { evaluation: { test_cases: [] } });
});

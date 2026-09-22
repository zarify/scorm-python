/**
 * Config validation — the gate between an authored `activity_config` and every
 * consumer downstream of it (the builder's export path, the SCORM template, the
 * grader).
 *
 * The interesting edges are the ones a hand-edited, imported or Blockly-era
 * config carries: missing containers, ids outside the activity_id charset,
 * tests that award nothing, test types whose required sub-shape is absent,
 * legacy aliases the Python schema dropped (weight, expected_output, top-level
 * match_mode, the `type` comparison), condition trees with unknown or malformed
 * nodes, seeded-file paths that would escape the working directory, and hints
 * whose trigger is half-specified.
 *
 * Paths are asserted exactly — the builder highlights the offending field by
 * path — while messages are matched loosely wherever the wording is
 * user-facing (the `Must be one of: …` enumerations, prose sentences).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ACTIVITY_FILES,
  MAX_FILE_CONTENT_LENGTH,
  MAX_FILE_PATH_LENGTH,
  validateConfig,
  validateHintConfig,
  validateTestCaseConfig,
} from '../src/shared/config-validator.js';
import { activityConfig, codeStructureTestConfig, hint } from './helpers/config.js';

/** Every error path, in the order the validator produced them. */
const pathsOf = (result) => result.errors.map((error) => error.path);

/** The error(s) recorded against one JSON path. */
const errorsAt = (result, path) => result.errors.filter((error) => error.path === path);

/** Exactly one error at `path`, matching `pattern` when one is given. */
function assertOneErrorAt(result, path, pattern) {
  const matches = errorsAt(result, path);
  assert.equal(
    matches.length,
    1,
    `expected 1 error at "${path}", got ${JSON.stringify(result.errors)}`,
  );
  if (pattern) assert.match(matches[0].message, pattern);
  return matches[0];
}

function assertValid(result) {
  assert.deepEqual(result, { valid: true, errors: [] });
}

/** A stdout_match test that passes on its own. */
function stdoutTest(overrides = {}) {
  return {
    id: 'print',
    type: 'stdout_match',
    points: 10,
    output_assertion: { enabled: true, expected: 'Hello, World!\n' },
    ...overrides,
  };
}

/** A code_structure test wrapping `conditions`. */
function structureTest(conditions, overrides = {}) {
  return { id: 'shape', type: 'code_structure', points: 10, conditions, ...overrides };
}

/** One seeded file entry. */
const file = (overrides = {}) => ({ path: 'data.csv', content: 'name,score\n', ...overrides });

const TEST_PATH = 'evaluation.test_cases[0]';

test('a non-object config is rejected with one pathless error', () => {
  const expected = { valid: false, errors: [{ path: '', message: 'Config must be a non-null object' }] };

  for (const input of [null, undefined, NaN, 0, false, 1, true, '', 'activity', () => {}]) {
    assert.deepEqual(validateConfig(input), expected, `validation accepted ${String(input)}`);
  }
});

test('an array is an object to the validator, so it reports the missing containers instead', () => {
  const result = validateConfig([]);

  assert.equal(result.valid, false);
  assert.deepEqual(pathsOf(result), ['metadata', 'python_setup', 'evaluation']);
  assert.equal(errorsAt(result, '').length, 0);
});

test('every missing top-level container is reported once, at its own path', () => {
  const result = validateConfig({});

  assert.deepEqual(pathsOf(result), ['metadata', 'python_setup', 'evaluation']);
  assertOneErrorAt(result, 'metadata', /Required field is missing/);
  assertOneErrorAt(result, 'python_setup', /Required field is missing/);
  assertOneErrorAt(result, 'evaluation', /Required field is missing/);
});

test('a null container is reported as missing, not as the wrong type', () => {
  const result = validateConfig({ metadata: null, python_setup: null, evaluation: null });
  assert.deepEqual(pathsOf(result), ['metadata', 'python_setup', 'evaluation']);
  assertOneErrorAt(result, 'evaluation', /Required field is missing/);

  const nested = validateConfig(activityConfig({ evaluation: { test_cases: null } }));
  assert.deepEqual(pathsOf(nested), ['evaluation.test_cases']);

  const wrongType = validateConfig(activityConfig({ python_setup: 'setup' }));
  assert.deepEqual(pathsOf(wrongType), ['python_setup']);
  assertOneErrorAt(wrongType, 'python_setup', /Must be object, got string/);
});

test('the reference fixture and the code_structure fixture pass full validation', () => {
  assertValid(validateConfig(activityConfig()));
  assertValid(validateConfig(activityConfig({ hints: [] })));
  assertValid(validateConfig(activityConfig({ hints: [hint()] })));
  assertValid(validateConfig(codeStructureTestConfig({ type: 'source_empty' })));
  assertValid(validateConfig(codeStructureTestConfig({ type: 'ast_pattern', pattern: 'print(...)' })));
  assertValid(validateConfig(activityConfig({
    python_setup: { files: [file()], packages: ['pillow'], pyodide_base_url: 'https://cdn.example.com/pyodide/' },
  })));
});

test('unknown top-level sections are rejected, so Blockly-era configs fail loudly', () => {
  assertOneErrorAt(
    validateConfig(activityConfig({ blockly_setup: { toolbox: { categories: [] } } })),
    'blockly_setup',
    /Unknown property/,
  );
  assertOneErrorAt(
    validateConfig(activityConfig({ show_code_toggle: true })),
    'show_code_toggle',
    /Unknown property/,
  );
  assertOneErrorAt(
    validateConfig(activityConfig({ ui_settings: { show_code_toggle: true } })),
    'ui_settings.show_code_toggle',
    /Unknown property/,
  );
});

test('activity_id rejects anything outside lowercase letters, digits and underscores', () => {
  const rejected = [
    'Test_Activity', 'TEST', 'test-activity', 'test activity', 'activité',
    'Ünicode', 'test.activity', 'test/activity', 'test:1',
  ];
  for (const activity_id of rejected) {
    const result = validateConfig(activityConfig({ metadata: { activity_id } }));
    assert.equal(result.valid, false, `"${activity_id}" should be rejected`);
    assertOneErrorAt(result, 'metadata.activity_id', /lowercase alphanumeric/);
  }

  for (const activity_id of ['test_activity', 'test_activity_2', 'a', 'a1', '123']) {
    const result = validateConfig(activityConfig({ metadata: { activity_id } }));
    assert.equal(
      errorsAt(result, 'metadata.activity_id').length,
      0,
      `"${activity_id}" should be accepted`,
    );
  }
});

test('metadata fields are checked for presence and type before the charset rule', () => {
  const wrongTypes = validateConfig(activityConfig({
    metadata: { activity_id: 42, title: 7, version: 1, description: [] },
  }));
  assertOneErrorAt(wrongTypes, 'metadata.activity_id', /Must be string, got number/);
  assertOneErrorAt(wrongTypes, 'metadata.title', /Must be string, got number/);
  assertOneErrorAt(wrongTypes, 'metadata.version', /Must be a string/);
  assertOneErrorAt(wrongTypes, 'metadata.description', /Must be a string/);

  const empty = validateConfig(activityConfig({ metadata: { activity_id: undefined, title: undefined } }));
  assert.deepEqual(pathsOf(empty), ['metadata.activity_id', 'metadata.title']);
  assertOneErrorAt(empty, 'metadata.title', /Required field is missing/);
});

test('ui_settings carries only show_hint_panel and a suspend_data_limit of at least 512', () => {
  for (const suspend_data_limit of [511, 0, -1, -4096, 1.5, 512.5, '4096', 'lots', true, NaN, Infinity, []]) {
    const result = validateConfig(activityConfig({ ui_settings: { suspend_data_limit } }));
    assert.equal(result.valid, false, `${String(suspend_data_limit)} should be rejected`);
    assertOneErrorAt(result, 'ui_settings.suspend_data_limit', /integer of at least 512/);
  }

  for (const suspend_data_limit of [512, 513, 4096, 1000000, undefined, null]) {
    assertValid(validateConfig(activityConfig({ ui_settings: { suspend_data_limit } })));
  }

  assertOneErrorAt(
    validateConfig(activityConfig({ ui_settings: { show_hint_panel: 'yes' } })),
    'ui_settings.show_hint_panel',
    /Must be a boolean/,
  );

  // ui_settings is optional as a whole; only the limits inside it are checked.
  const withoutUiSettings = activityConfig();
  delete withoutUiSettings.ui_settings;
  assertValid(validateConfig(withoutUiSettings));

  assertOneErrorAt(
    validateConfig(activityConfig({ ui_settings: 'on' })),
    'ui_settings',
    /Must be an object/,
  );
});

test('instructions are optional but type-checked when present', () => {
  assertValid(validateConfig(activityConfig({ instructions: { main: 'Do it.', steps: ['One', 'Two'] } })));
  assertOneErrorAt(
    validateConfig(activityConfig({ instructions: { steps: 'One' } })),
    'instructions.steps',
    /Must be an array/,
  );
  assertOneErrorAt(
    validateConfig(activityConfig({ instructions: { steps: ['One', 2] } })),
    'instructions.steps',
    /array of strings/,
  );
  assertOneErrorAt(
    validateConfig(activityConfig({ instructions: { body: 'Do it.' } })),
    'instructions.body',
    /Unknown property/,
  );
});

test('python_setup.starter_code must be a string and unknown setup keys are rejected', () => {
  assertOneErrorAt(
    validateConfig(activityConfig({ python_setup: { starter_code: 7 } })),
    'python_setup.starter_code',
    /Must be a string/,
  );
  assertOneErrorAt(
    validateConfig(activityConfig({ python_setup: { toolbox: {} } })),
    'python_setup.toolbox',
    /Unknown property/,
  );
  assertValid(validateConfig(activityConfig({ python_setup: { starter_code: 'print("hi")\n' } })));
});

test('seeded file paths stay inside the working directory and inside the size budget', () => {
  assertValid(validateConfig(activityConfig({
    python_setup: { files: [file(), file({ path: 'pkg/util.py', content: 'x = 1\n' })] },
  })));
  assertValid(validateConfig(activityConfig({
    python_setup: { files: [file({ path: 'logo.png', content: undefined, content_base64: 'AAAA' })] },
  })));

  assertOneErrorAt(
    validateConfig(activityConfig({ python_setup: { files: [file({ path: '/data.csv' })] } })),
    'python_setup.files[0].path',
    /relative path/,
  );
  assertOneErrorAt(
    validateConfig(activityConfig({ python_setup: { files: [file({ path: '../data.csv' })] } })),
    'python_setup.files[0].path',
    /"\.\." segments/,
  );
  assertOneErrorAt(
    validateConfig(activityConfig({ python_setup: { files: [file({ path: 'nested/../../data.csv' })] } })),
    'python_setup.files[0].path',
    /"\.\." segments/,
  );
  assertOneErrorAt(
    validateConfig(activityConfig({ python_setup: { files: [file({ path: 'data file.csv' })] } })),
    'python_setup.files[0].path',
    /only letters, digits/,
  );
  assertOneErrorAt(
    validateConfig(activityConfig({ python_setup: { files: [file({ path: 'a'.repeat(MAX_FILE_PATH_LENGTH + 1) })] } })),
    'python_setup.files[0].path',
    new RegExp(`${MAX_FILE_PATH_LENGTH} characters or fewer`),
  );
  assertOneErrorAt(
    validateConfig(activityConfig({ python_setup: { files: [file({ path: '   ' })] } })),
    'python_setup.files[0].path',
    /Must not be empty/,
  );
  assertOneErrorAt(
    validateConfig(activityConfig({ python_setup: { files: [file({ path: 7 })] } })),
    'python_setup.files[0].path',
    /Must be string, got number/,
  );

  const many = Array.from({ length: MAX_ACTIVITY_FILES + 1 }, (unused, index) => file({ path: `f${index}.csv` }));
  assertOneErrorAt(
    validateConfig(activityConfig({ python_setup: { files: many } })),
    'python_setup.files',
    new RegExp(`at most ${MAX_ACTIVITY_FILES} files`),
  );
  assertValid(validateConfig(activityConfig({
    python_setup: { files: Array.from({ length: MAX_ACTIVITY_FILES }, (unused, index) => file({ path: `f${index}.csv` })) },
  })));

  assertOneErrorAt(
    validateConfig(activityConfig({ python_setup: { files: 'data.csv' } })),
    'python_setup.files',
    /Must be an array/,
  );
});

test('a seeded file provides exactly one of content or content_base64', () => {
  assertOneErrorAt(
    validateConfig(activityConfig({
      python_setup: { files: [{ path: 'data.csv', content: 'x', content_base64: 'eA==' }] },
    })),
    'python_setup.files[0]',
    /not both/,
  );
  assertOneErrorAt(
    validateConfig(activityConfig({ python_setup: { files: [{ path: 'data.csv' }] } })),
    'python_setup.files[0]',
    /Provide content or content_base64/,
  );
  assertOneErrorAt(
    validateConfig(activityConfig({ python_setup: { files: [file({ content: 42 })] } })),
    'python_setup.files[0].content',
    /Must be a string/,
  );
  assertOneErrorAt(
    validateConfig(activityConfig({
      python_setup: { files: [file({ content: 'x'.repeat(MAX_FILE_CONTENT_LENGTH + 1) })] },
    })),
    'python_setup.files[0].content',
    new RegExp(`${MAX_FILE_CONTENT_LENGTH} characters or fewer`),
  );
  assertOneErrorAt(
    validateConfig(activityConfig({ python_setup: { files: [{ path: 'data.csv', content: '', mime: 'text/csv' }] } })),
    'python_setup.files[0].mime',
    /Unknown property/,
  );
});

test('packages accepts only the bundled optional packages', () => {
  assertValid(validateConfig(activityConfig({ python_setup: { packages: [] } })));
  assertValid(validateConfig(activityConfig({ python_setup: { packages: ['pillow'] } })));

  assertOneErrorAt(
    validateConfig(activityConfig({ python_setup: { packages: ['numpy'] } })),
    'python_setup.packages[0]',
    /Must be one of: pillow/,
  );
  assertOneErrorAt(
    validateConfig(activityConfig({ python_setup: { packages: ['pillow', 'requests'] } })),
    'python_setup.packages[1]',
    /Must be one of: pillow/,
  );
  assertOneErrorAt(
    validateConfig(activityConfig({ python_setup: { packages: 'pillow' } })),
    'python_setup.packages',
    /Must be an array/,
  );
});

test('pyodide_base_url is empty or an absolute http(s) URL', () => {
  assertValid(validateConfig(activityConfig({ python_setup: { pyodide_base_url: '' } })));
  assertValid(validateConfig(activityConfig({
    python_setup: { pyodide_base_url: 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/' },
  })));
  assertValid(validateConfig(activityConfig({
    python_setup: { pyodide_base_url: 'http://localhost:8080/pyodide/' },
  })));

  for (const pyodide_base_url of ['cdn.example.com/pyodide/', '/pyodide/', 'not a url', 'ftp://example.com/pyodide/']) {
    const result = validateConfig(activityConfig({ python_setup: { pyodide_base_url } }));
    assert.equal(result.valid, false, `"${pyodide_base_url}" should be rejected`);
    assertOneErrorAt(result, 'python_setup.pyodide_base_url', /absolute http\(s\) URL/);
  }

  assertOneErrorAt(
    validateConfig(activityConfig({ python_setup: { pyodide_base_url: 42 } })),
    'python_setup.pyodide_base_url',
    /Must be a string/,
  );
});

test('test_cases must be a present, non-empty array', () => {
  const empty = validateConfig(activityConfig({ evaluation: { test_cases: [] } }));
  assertOneErrorAt(empty, 'evaluation.test_cases', /at least one test case/);

  const missing = validateConfig(activityConfig({ evaluation: { test_cases: undefined } }));
  assertOneErrorAt(missing, 'evaluation.test_cases', /Required field is missing/);

  for (const test_cases of ['x', {}, 42, true]) {
    const result = validateConfig(activityConfig({ evaluation: { test_cases } }));
    assert.deepEqual(pathsOf(result), ['evaluation.test_cases']);
    assertOneErrorAt(result, 'evaluation.test_cases', /Must be an array/);
  }

  assertOneErrorAt(
    validateConfig(activityConfig({ evaluation: { require_previous_test_pass: 'yes' } })),
    'evaluation.require_previous_test_pass',
    /Must be a boolean/,
  );
  assertOneErrorAt(
    validateConfig(activityConfig({ evaluation: { feedback_on_all_pass: 7 } })),
    'evaluation.feedback_on_all_pass',
    /Must be a string/,
  );
  assertOneErrorAt(
    validateConfig(activityConfig({ evaluation: { grading_mode: 'points' } })),
    'evaluation.grading_mode',
    /Unknown property/,
  );
});

test('at least one test must award more than zero points', () => {
  const allZero = validateConfig(activityConfig({
    evaluation: { test_cases: [stdoutTest({ points: 0 }), stdoutTest({ id: 'second', points: 0 })] },
  }));
  assertOneErrorAt(allZero, 'evaluation.test_cases', /at least one test must award more than 0 points/i);

  const mixed = validateConfig(activityConfig({
    evaluation: { test_cases: [stdoutTest({ points: 0 }), stdoutTest({ id: 'second', points: 5 })] },
  }));
  assertValid(mixed);
});

test('points are required non-negative integers, and the legacy weight alias is rejected', () => {
  assertValid(validateTestCaseConfig(stdoutTest({ points: 0 })));

  assertOneErrorAt(
    validateTestCaseConfig(stdoutTest({ points: -5 })),
    `${TEST_PATH}.points`,
    /greater than or equal to 0/,
  );
  assertOneErrorAt(
    validateTestCaseConfig(stdoutTest({ points: 1.5 })),
    `${TEST_PATH}.points`,
    /greater than or equal to 0/,
  );
  assertOneErrorAt(
    validateTestCaseConfig(stdoutTest({ points: '10' })),
    `${TEST_PATH}.points`,
    /greater than or equal to 0/,
  );
  assertOneErrorAt(
    validateTestCaseConfig(stdoutTest({ points: undefined })),
    `${TEST_PATH}.points`,
    /Required field is missing/,
  );

  // A negative score is reported per test first, then by the total.
  const aggregate = validateConfig(activityConfig({
    evaluation: { test_cases: [stdoutTest({ points: -5 })] },
  }));
  assert.deepEqual(pathsOf(aggregate), [`${TEST_PATH}.points`, 'evaluation.test_cases']);

  // `weight` was the Blockly-era alias; there is no alias in the Python schema.
  const weighted = validateTestCaseConfig(stdoutTest({ points: undefined, weight: 10 }));
  assertOneErrorAt(weighted, `${TEST_PATH}.weight`, /Unknown property/);
  assertOneErrorAt(weighted, `${TEST_PATH}.points`, /Required field is missing/);
});

test('a test case reports its own index in every path', () => {
  const blank = validateTestCaseConfig({}, 2);
  assert.deepEqual(pathsOf(blank), [
    'evaluation.test_cases[2].id',
    'evaluation.test_cases[2].type',
    'evaluation.test_cases[2].points',
  ]);
  assertOneErrorAt(blank, 'evaluation.test_cases[2].id', /Required field is missing/);

  assertOneErrorAt(
    validateTestCaseConfig(stdoutTest({ id: '   ' })),
    `${TEST_PATH}.id`,
    /Must not be empty/,
  );
  assertOneErrorAt(
    validateTestCaseConfig(stdoutTest({ id: 7 })),
    `${TEST_PATH}.id`,
    /Must be string, got number/,
  );
  assertOneErrorAt(
    validateTestCaseConfig(stdoutTest({ feedback_on_pass: 1 })),
    `${TEST_PATH}.feedback_on_pass`,
    /Must be a string/,
  );
  assertOneErrorAt(
    validateTestCaseConfig('not a test'),
    TEST_PATH,
    /Must be an object/,
  );

  // Without a type the field set is unknown, so unknown keys are still reported
  // instead of crashing the validator.
  const untyped = validateTestCaseConfig({ id: 'x', points: 5, output_assertion: { enabled: true } });
  assertOneErrorAt(untyped, `${TEST_PATH}.type`, /Required field is missing/);
  assertOneErrorAt(untyped, `${TEST_PATH}.output_assertion`, /Unknown property/);
});

test('an unknown test type is reported once and skips the type-specific rules', () => {
  const blocklyEra = validateTestCaseConfig({
    id: 'shape',
    type: 'block_structure',
    points: 5,
    conditions: { type: 'workspace_empty' },
  });
  assert.deepEqual(pathsOf(blocklyEra), [`${TEST_PATH}.type`]);
  assertOneErrorAt(blocklyEra, `${TEST_PATH}.type`, /Must be one of: stdout_match, code_structure/);

  const typo = validateTestCaseConfig(stdoutTest({ type: 'stdout_matcher' }));
  assert.deepEqual(pathsOf(typo), [`${TEST_PATH}.type`]);
});

test('stdout_match must enable an assertion, and legacy fields are rejected not honoured', () => {
  const noneEnabled = validateTestCaseConfig(stdoutTest({
    output_assertion: { enabled: false },
    prompt_assertion: { enabled: false },
  }));
  assert.deepEqual(pathsOf(noneEnabled), [TEST_PATH]);
  assertOneErrorAt(noneEnabled, TEST_PATH, /enable output_assertion, prompt_assertion, or both/);

  assertValid(validateTestCaseConfig(stdoutTest({
    output_assertion: { enabled: false },
    prompt_assertion: { enabled: true, expected: 'name' },
  })));

  // An assertion object present without `enabled` defaults to enabled, as the
  // runtime's getter does.
  assertValid(validateTestCaseConfig(stdoutTest({ output_assertion: { expected: 'hi\n' } })));

  // 1.0-era aliases: the Python schema has no such fields.
  const legacyOutput = validateTestCaseConfig({
    id: 'print', type: 'stdout_match', points: 5, expected_output: 'hi\n',
  });
  assertOneErrorAt(legacyOutput, `${TEST_PATH}.expected_output`, /Unknown property/);
  assertOneErrorAt(legacyOutput, TEST_PATH, /enable output_assertion/);

  const legacyMode = validateTestCaseConfig({
    id: 'print', type: 'stdout_match', points: 5, output_assertion: { enabled: true, expected: 'hi\n' }, match_mode: 'fuzzy',
  });
  assertOneErrorAt(legacyMode, `${TEST_PATH}.match_mode`, /Unknown property/);
});

test('stdout_match assertion fields are type-checked at their own path', () => {
  const badOutput = validateTestCaseConfig(stdoutTest({
    output_assertion: { enabled: true, expected: 42, match_mode: 'fuzzy', show_expected: 'yes', failure_message: 9 },
  }));
  assertOneErrorAt(badOutput, `${TEST_PATH}.output_assertion.expected`, /Must be a string/);
  assertOneErrorAt(badOutput, `${TEST_PATH}.output_assertion.match_mode`, /exact, contains, or regex/);
  assertOneErrorAt(badOutput, `${TEST_PATH}.output_assertion.show_expected`, /Must be a boolean/);
  assertOneErrorAt(badOutput, `${TEST_PATH}.output_assertion.failure_message`, /Must be a string/);

  const badPrompt = validateTestCaseConfig(stdoutTest({
    prompt_assertion: { enabled: true, expected: 7 },
  }));
  assertOneErrorAt(badPrompt, `${TEST_PATH}.prompt_assertion.expected`, /Must be a string/);

  const notAnObject = validateTestCaseConfig(stdoutTest({ output_assertion: 'hi\n' }));
  assert.deepEqual(pathsOf(notAnObject), [`${TEST_PATH}.output_assertion`, TEST_PATH]);
  assertOneErrorAt(notAnObject, `${TEST_PATH}.output_assertion`, /Must be an object/);
  assertOneErrorAt(notAnObject, TEST_PATH, /enable output_assertion, prompt_assertion/);
});

test('only the prompt assertion can match any captured item', () => {
  assertValid(validateTestCaseConfig(stdoutTest({
    prompt_assertion: { enabled: true, expected: 'name', match_any_item: true },
  })));

  assertOneErrorAt(
    validateTestCaseConfig(stdoutTest({
      output_assertion: { enabled: true, expected: 'hi\n', match_any_item: true },
    })),
    `${TEST_PATH}.output_assertion.match_any_item`,
    /Unknown property/,
  );
});

test('stdout_match execution context checks scope, arguments and function name', () => {
  assertOneErrorAt(
    validateTestCaseConfig(stdoutTest({ execution_context: { scope: 'sandbox' } })),
    `${TEST_PATH}.execution_context.scope`,
    /Must be one of/,
  );

  const functionScope = validateTestCaseConfig(stdoutTest({
    execution_context: { scope: 'function', function_name: 'greet' },
  }));
  assert.deepEqual(pathsOf(functionScope), [`${TEST_PATH}.execution_context.arguments`]);
  assertOneErrorAt(
    functionScope,
    `${TEST_PATH}.execution_context.arguments`,
    /Required when execution_context.scope is "function"/,
  );

  // Naming a function without a scope is enough to infer function scope.
  assertOneErrorAt(
    validateTestCaseConfig(stdoutTest({ execution_context: { function_name: 'greet' } })),
    `${TEST_PATH}.execution_context.arguments`,
    /Required when execution_context.scope is "function"/,
  );

  assertValid(validateTestCaseConfig(stdoutTest({ execution_context: { scope: 'main', function_name: 'greet' } })));

  assertOneErrorAt(
    validateTestCaseConfig(stdoutTest({
      execution_context: { scope: 'function', function_name: 'greet', arguments: 'Ada' },
    })),
    `${TEST_PATH}.execution_context.arguments`,
    /Must be an array/,
  );

  assertOneErrorAt(
    validateTestCaseConfig(stdoutTest({
      execution_context: { scope: 'function', function_name: 'greet', arguments: [], scope_note: 'x' },
    })),
    `${TEST_PATH}.execution_context.scope_note`,
    /Unknown property/,
  );

  assertValid(validateTestCaseConfig(stdoutTest({
    execution_context: { scope: 'function', function_name: 'greet', arguments: ['Ada'] },
  })));
});

test('prompt_inputs must be an array of strings', () => {
  assertValid(validateTestCaseConfig(stdoutTest({ prompt_inputs: ['Ada'], strict_prompt_inputs: true })));
  assertOneErrorAt(
    validateTestCaseConfig(stdoutTest({ prompt_inputs: 'Ada' })),
    `${TEST_PATH}.prompt_inputs`,
    /Must be an array of strings/,
  );
  assertOneErrorAt(
    validateTestCaseConfig(stdoutTest({ prompt_inputs: ['Ada', 7] })),
    `${TEST_PATH}.prompt_inputs`,
    /Must be an array of strings/,
  );
  assertOneErrorAt(
    validateTestCaseConfig(stdoutTest({ strict_prompt_inputs: 'yes' })),
    `${TEST_PATH}.strict_prompt_inputs`,
    /Must be a boolean/,
  );
});

test('code_structure requires a condition tree', () => {
  const missing = validateTestCaseConfig({ id: 'shape', type: 'code_structure', points: 5 });
  assert.deepEqual(pathsOf(missing), [`${TEST_PATH}.conditions`]);
  assertOneErrorAt(missing, `${TEST_PATH}.conditions`, /Required for code_structure/);

  assertValid(validateTestCaseConfig(structureTest({ type: 'source_empty' })));

  // code_structure does not execute, so seeded files are rejected there.
  assertOneErrorAt(
    validateTestCaseConfig(structureTest({ type: 'source_empty' }, { setup_files: [file()] })),
    `${TEST_PATH}.setup_files`,
    /Unknown property/,
  );
});

test('an unknown condition type is named in the error and stops the walk', () => {
  const unknown = validateTestCaseConfig(structureTest({ type: 'workspace_empty' }));
  assert.deepEqual(pathsOf(unknown), [`${TEST_PATH}.conditions.type`]);
  assert.equal(
    errorsAt(unknown, `${TEST_PATH}.conditions.type`)[0].message,
    "Unknown condition type 'workspace_empty'",
  );

  const missingType = validateTestCaseConfig(structureTest({}));
  assert.equal(
    errorsAt(missingType, `${TEST_PATH}.conditions.type`)[0].message,
    "Unknown condition type 'undefined'",
  );

  for (const conditions of ['workspace_empty', 42, true]) {
    const result = validateTestCaseConfig(structureTest(conditions));
    assert.deepEqual(pathsOf(result), [`${TEST_PATH}.conditions`]);
    assertOneErrorAt(result, `${TEST_PATH}.conditions`, /Condition must be an object/);
  }

  // An array is an object, so it reaches the type check with no type field.
  const emptyArray = validateTestCaseConfig(structureTest([]));
  assert.deepEqual(pathsOf(emptyArray), [`${TEST_PATH}.conditions.type`]);
});

test('ast_pattern needs a pattern and consistent count bounds', () => {
  assertOneErrorAt(
    validateTestCaseConfig(structureTest({ type: 'ast_pattern' })),
    `${TEST_PATH}.conditions.pattern`,
    /Required field is missing/,
  );
  assertOneErrorAt(
    validateTestCaseConfig(structureTest({ type: 'ast_pattern', pattern: '   ' })),
    `${TEST_PATH}.conditions.pattern`,
    /Must not be empty/,
  );
  assertOneErrorAt(
    validateTestCaseConfig(structureTest({ type: 'ast_pattern', pattern: 7 })),
    `${TEST_PATH}.conditions.pattern`,
    /Must be string, got number/,
  );

  for (const min_count of [1.5, -1, '2']) {
    assertOneErrorAt(
      validateTestCaseConfig(structureTest({ type: 'ast_pattern', pattern: 'print(...)', min_count })),
      `${TEST_PATH}.conditions.min_count`,
      /integer of at least 1/,
    );
  }

  assertOneErrorAt(
    validateTestCaseConfig(structureTest({
      type: 'ast_pattern', pattern: 'print(...)', min_count: 3, max_count: 2,
    })),
    `${TEST_PATH}.conditions.max_count`,
    /greater than or equal to min_count/,
  );
  assertOneErrorAt(
    validateTestCaseConfig(structureTest({ type: 'ast_pattern', pattern: 'print(...)', max_count: 0 })),
    `${TEST_PATH}.conditions.max_count`,
    /integer of at least 1/,
  );

  assertValid(validateTestCaseConfig(structureTest({ type: 'ast_pattern', pattern: 'print(...)' })));
  assertValid(validateTestCaseConfig(structureTest({
    type: 'ast_pattern', pattern: 'print(...)', min_count: 2, max_count: 2,
  })));
  assertValid(validateTestCaseConfig(structureTest({ type: 'ast_pattern', pattern: 'print(...)', max_count: 1 })));

  assertOneErrorAt(
    validateTestCaseConfig(structureTest({ type: 'ast_pattern', pattern: 'print(...)', expected: 'x' })),
    `${TEST_PATH}.conditions.expected`,
    /Unknown property/,
  );
});

test('source_regex flags accept only i, m and s, and case sensitivity is a boolean', () => {
  assertOneErrorAt(
    validateTestCaseConfig(structureTest({ type: 'source_regex' })),
    `${TEST_PATH}.conditions.pattern`,
    /Required field is missing/,
  );

  for (const regex_flags of ['iz', 'g', 'imx', 'ii', 'IMS']) {
    assertOneErrorAt(
      validateTestCaseConfig(structureTest({ type: 'source_regex', pattern: 'x', regex_flags })),
      `${TEST_PATH}.conditions.regex_flags`,
      /letters i, m and s/,
    );
  }
  assertOneErrorAt(
    validateTestCaseConfig(structureTest({ type: 'source_regex', pattern: 'x', regex_flags: 7 })),
    `${TEST_PATH}.conditions.regex_flags`,
    /Must be a string/,
  );
  assertOneErrorAt(
    validateTestCaseConfig(structureTest({ type: 'source_regex', pattern: 'x', case_sensitive: 'no' })),
    `${TEST_PATH}.conditions.case_sensitive`,
    /Must be a boolean/,
  );

  // The pattern itself is not compiled here: validation is a synchronous
  // structural gate, and an invalid regex is reported by the Python matcher.
  assertValid(validateTestCaseConfig(structureTest({ type: 'source_regex', pattern: 'a(' })));
  assertValid(validateTestCaseConfig(structureTest({
    type: 'source_regex', pattern: '^import csv$', case_sensitive: false, regex_flags: 'm',
  })));
  assertValid(validateTestCaseConfig(structureTest({ type: 'source_empty' })));
});

test('composite conditions need a non-empty conditions array', () => {
  for (const type of ['all', 'any', 'none']) {
    for (const conditions of [undefined, null, [], 'x', {}, 7]) {
      const node = { type };
      if (conditions !== undefined) node.conditions = conditions;
      assertOneErrorAt(
        validateTestCaseConfig(structureTest(node)),
        `${TEST_PATH}.conditions.conditions`,
        /non-empty conditions array/,
      );
    }
  }
});

test('an invalid condition nested in a composite is reported at its full path', () => {
  const result = validateTestCaseConfig(structureTest({
    type: 'any',
    conditions: [
      { type: 'source_empty' },
      { type: 'all', conditions: [{ type: 'ast_pattern' }, { type: 'block_exists' }] },
    ],
  }));

  assert.deepEqual(pathsOf(result), [
    `${TEST_PATH}.conditions.conditions[1].conditions[0].pattern`,
    `${TEST_PATH}.conditions.conditions[1].conditions[1].type`,
  ]);
  assertOneErrorAt(result, `${TEST_PATH}.conditions.conditions[1].conditions[0].pattern`, /Required field is missing/);
});

test('variable_state needs a variable name and a reason to check something', () => {
  const nameless = validateTestCaseConfig({ id: 'total', type: 'variable_state', points: 5 });
  assertOneErrorAt(nameless, `${TEST_PATH}.variable_name`, /Required field is missing/);
  assertOneErrorAt(nameless, TEST_PATH, /must enable a value assertion/);

  const bare = validateTestCaseConfig({
    id: 'total', type: 'variable_state', points: 5, variable_name: 'total',
  });
  assert.deepEqual(pathsOf(bare), [TEST_PATH]);
  assertOneErrorAt(bare, TEST_PATH, /must enable a value assertion/);

  assertValid(validateTestCaseConfig({
    id: 'total', type: 'variable_state', points: 5, variable_name: 'total', expected_type: 'int',
  }));
  assertValid(validateTestCaseConfig({
    id: 'total', type: 'variable_state', points: 5, variable_name: 'total', expected_value: 0,
  }));
  assertValid(validateTestCaseConfig({
    id: 'total', type: 'variable_state', points: 5, variable_name: 'total', list_assertions: { length_enabled: true },
  }));
});

test('variable_state types and comparisons use the Python enum', () => {
  for (const expected_type of ['int', 'float', 'bool', 'string', 'list', 'tuple', 'dict', 'null']) {
    assertValid(validateTestCaseConfig({
      id: 'total', type: 'variable_state', points: 5, variable_name: 'total', expected_type,
    }));
  }
  // `any` is a legal value, but on its own it asserts nothing.
  assertValid(validateTestCaseConfig({
    id: 'total', type: 'variable_state', points: 5, variable_name: 'total', expected_type: 'any', expected_value: 5,
  }));
  assertOneErrorAt(
    validateTestCaseConfig({
      id: 'total', type: 'variable_state', points: 5, variable_name: 'total', expected_type: 'any',
    }),
    TEST_PATH,
    /must enable a value assertion/,
  );
  assertOneErrorAt(
    validateTestCaseConfig({
      id: 'total', type: 'variable_state', points: 5, variable_name: 'total', expected_type: 'number',
    }),
    `${TEST_PATH}.expected_type`,
    /Must be one of/,
  );

  for (const comparison of ['equals', 'gt', 'lt', 'gte', 'lte', 'contains']) {
    assertValid(validateTestCaseConfig({
      id: 'total', type: 'variable_state', points: 5, variable_name: 'total', expected_value: 1, comparison,
    }));
  }
  assertOneErrorAt(
    validateTestCaseConfig({
      id: 'total', type: 'variable_state', points: 5, variable_name: 'total', expected_value: 1, comparison: 'type',
    }),
    `${TEST_PATH}.comparison`,
    /Invalid comparison operator/,
  );
  assertOneErrorAt(
    validateTestCaseConfig({
      id: 'total', type: 'variable_state', points: 5, variable_name: 'total', expected_value: 1, comparison: 'bogus',
    }),
    `${TEST_PATH}.comparison`,
    /Invalid comparison operator/,
  );
});

test('variable_state assertion options are checked against the allowed sets', () => {
  const onWithoutValue = validateTestCaseConfig({
    id: 'total', type: 'variable_state', points: 5, variable_name: 'total',
    value_assertion_enabled: true, expected_type: 'int',
  });
  assertOneErrorAt(onWithoutValue, `${TEST_PATH}.expected_value`, /Required when value_assertion_enabled/);

  const offAndTypeless = validateTestCaseConfig({
    id: 'total', type: 'variable_state', points: 5, variable_name: 'total',
    value_assertion_enabled: false, expected_value: 3,
  });
  assertOneErrorAt(offAndTypeless, TEST_PATH, /must enable a value assertion/);
  assert.equal(errorsAt(offAndTypeless, `${TEST_PATH}.expected_value`).length, 0);

  assertOneErrorAt(
    validateTestCaseConfig({
      id: 'total', type: 'variable_state', points: 5, variable_name: 'total',
      expected_value: 1, value_assertion_enabled: 'yes',
    }),
    `${TEST_PATH}.value_assertion_enabled`,
    /Must be a boolean/,
  );
  assertOneErrorAt(
    validateTestCaseConfig({
      id: 'total', type: 'variable_state', points: 5, variable_name: 'total',
      expected_type: 'int', show_coerced_value_hint: 'yes',
    }),
    `${TEST_PATH}.show_coerced_value_hint`,
    /Must be a boolean/,
  );
  assertOneErrorAt(
    validateTestCaseConfig({
      id: 'total', type: 'variable_state', points: 5, variable_name: 'total', expected_type: 'int', match_mode: 'exact',
    }),
    `${TEST_PATH}.match_mode`,
    /Unknown property/,
  );
});

test('variable_state list assertions are validated', () => {
  assertOneErrorAt(
    validateTestCaseConfig({
      id: 'items', type: 'variable_state', points: 5, variable_name: 'items',
      list_assertions: { values_enabled: true },
    }),
    `${TEST_PATH}.list_assertions.expected_values`,
    /at least one expected list value/,
  );
  assertOneErrorAt(
    validateTestCaseConfig({
      id: 'items', type: 'variable_state', points: 5, variable_name: 'items',
      list_assertions: { item_types_enabled: true },
    }),
    `${TEST_PATH}.list_assertions.expected_item_types`,
    /at least one expected item type/,
  );
  assertOneErrorAt(
    validateTestCaseConfig({
      id: 'items', type: 'variable_state', points: 5, variable_name: 'items',
      list_assertions: { item_types_enabled: true, expected_item_types: ['int', 'any'] },
    }),
    `${TEST_PATH}.list_assertions.expected_item_types`,
    /Entries must be one of/,
  );
  assertOneErrorAt(
    validateTestCaseConfig({
      id: 'items', type: 'variable_state', points: 5, variable_name: 'items',
      list_assertions: { length_enabled: true, length_comparison: 'bogus' },
    }),
    `${TEST_PATH}.list_assertions.length_comparison`,
    /Must be one of/,
  );
  assertOneErrorAt(
    validateTestCaseConfig({
      id: 'items', type: 'variable_state', points: 5, variable_name: 'items',
      list_assertions: { values_match_mode: 'bogus' },
    }),
    `${TEST_PATH}.list_assertions.values_match_mode`,
    /Must be one of/,
  );
  assertOneErrorAt(
    validateTestCaseConfig({
      id: 'items', type: 'variable_state', points: 5, variable_name: 'items',
      list_assertions: { index_checks: [{ index: 0 }] },
    }),
    `${TEST_PATH}.list_assertions.index_checks[0]`,
    /expected_value, expected_type, or both/,
  );
  assertOneErrorAt(
    validateTestCaseConfig({
      id: 'items', type: 'variable_state', points: 5, variable_name: 'items',
      list_assertions: { index_checks: [{ index: -1, expected_value: 1 }] },
    }),
    `${TEST_PATH}.list_assertions.index_checks[0].index`,
    /non-negative integer/,
  );
  assertOneErrorAt(
    validateTestCaseConfig({
      id: 'items', type: 'variable_state', points: 5, variable_name: 'items',
      list_assertions: { length_enabled: true, length: 3 },
    }),
    `${TEST_PATH}.list_assertions.length`,
    /Unknown property/,
  );

  assertValid(validateTestCaseConfig({
    id: 'items', type: 'variable_state', points: 5, variable_name: 'items',
    list_assertions: {
      values_enabled: true, expected_values: [1, 2],
      index_checks: [{ index: 0, expected_type: 'int' }],
    },
  }));
});

test('function_state needs a function name and something to check', () => {
  const nameless = validateTestCaseConfig({ id: 'call', type: 'function_state', points: 5 });
  assertOneErrorAt(nameless, `${TEST_PATH}.function_name`, /Required field is missing/);
  assertOneErrorAt(nameless, TEST_PATH, /must enable parameter_count or a return assertion/);

  const nameOnly = validateTestCaseConfig({
    id: 'call', type: 'function_state', points: 5, function_name: 'greet',
  });
  assert.deepEqual(pathsOf(nameOnly), [TEST_PATH]);
  assertOneErrorAt(nameOnly, TEST_PATH, /must enable parameter_count or a return assertion/);

  const counting = validateTestCaseConfig({
    id: 'call', type: 'function_state', points: 5, function_name: 'greet', parameter_count_enabled: true,
  });
  assert.deepEqual(pathsOf(counting), [`${TEST_PATH}.parameter_count`]);
  assertOneErrorAt(counting, `${TEST_PATH}.parameter_count`, /Required when parameter_count_enabled/);

  assertValid(validateTestCaseConfig({
    id: 'call', type: 'function_state', points: 5, function_name: 'greet',
    parameter_count_enabled: true, parameter_count: 1,
  }));

  assertOneErrorAt(
    validateTestCaseConfig({
      id: 'call', type: 'function_state', points: 5, function_name: 'greet', parameter_count: -1,
    }),
    `${TEST_PATH}.parameter_count`,
    /non-negative integer/,
  );
  assertOneErrorAt(
    validateTestCaseConfig({
      id: 'call', type: 'function_state', points: 5, function_name: 'greet', parameter_count_enabled: 'yes',
    }),
    `${TEST_PATH}.parameter_count_enabled`,
    /Must be a boolean/,
  );
});

test('function_state return assertions need a real assertion', () => {
  assertOneErrorAt(
    validateTestCaseConfig({
      id: 'call', type: 'function_state', points: 5, function_name: 'greet',
      return_assertion: { enabled: true },
    }),
    `${TEST_PATH}.return_assertion`,
    /must enable a value assertion/,
  );
  assertOneErrorAt(
    validateTestCaseConfig({
      id: 'call', type: 'function_state', points: 5, function_name: 'greet',
      return_assertion: { enabled: true, value_assertion_enabled: true, expected_type: 'string' },
    }),
    `${TEST_PATH}.return_assertion.expected_value`,
    /Required when value_assertion_enabled/,
  );
  assertOneErrorAt(
    validateTestCaseConfig({
      id: 'call', type: 'function_state', points: 5, function_name: 'greet',
      return_assertion: { enabled: true, expected_type: 'nope', expected_value: 1 },
    }),
    `${TEST_PATH}.return_assertion.expected_type`,
    /Must be one of/,
  );
  assertOneErrorAt(
    validateTestCaseConfig({
      id: 'call', type: 'function_state', points: 5, function_name: 'greet',
      return_assertion: { enabled: true, expected_type: 'string', expected_value: 'hi', comparison: 'type' },
    }),
    `${TEST_PATH}.return_assertion.comparison`,
    /Invalid comparison operator/,
  );
  assertOneErrorAt(
    validateTestCaseConfig({
      id: 'call', type: 'function_state', points: 5, function_name: 'greet',
      return_assertion: { enabled: true, expected_type: 'string', expected_value: 'hi', parameters: [] },
    }),
    `${TEST_PATH}.return_assertion.parameters`,
    /Unknown property/,
  );

  assertValid(validateTestCaseConfig({
    id: 'call', type: 'function_state', points: 5, function_name: 'greet',
    return_assertion: { enabled: true, arguments: ['Ada'], expected_type: 'string', expected_value: 'Hello, Ada!' },
  }));
  // A type-only return assertion is a complete check.
  assertValid(validateTestCaseConfig({
    id: 'call', type: 'function_state', points: 5, function_name: 'greet',
    return_assertion: { enabled: true, expected_type: 'list' },
  }));
});

test('function_state accepts prompt_inputs without the string-array rule', () => {
  // Ported behaviour: function tests default to no prompts and switch prompt
  // count strictness off, so the shared rule does not apply to them.
  const result = validateTestCaseConfig({
    id: 'call', type: 'function_state', points: 5, function_name: 'greet',
    return_assertion: { enabled: true, expected_type: 'string' },
    prompt_inputs: 'Ada',
  });
  assert.equal(result.valid, true);
  assert.equal(errorsAt(result, `${TEST_PATH}.prompt_inputs`).length, 0);
});

test('file_state needs a path and a reason to look at the file', () => {
  const missing = validateTestCaseConfig({ id: 'out', type: 'file_state', points: 5 });
  assert.deepEqual(pathsOf(missing), [`${TEST_PATH}.path`]);
  assertOneErrorAt(missing, `${TEST_PATH}.path`, /Required field is missing/);

  assertOneErrorAt(
    validateTestCaseConfig({ id: 'out', type: 'file_state', points: 5, path: '   ' }),
    `${TEST_PATH}.path`,
    /Must not be empty/,
  );

  assertValid(validateTestCaseConfig({
    id: 'out', type: 'file_state', points: 5, path: 'result.csv',
    content_assertion: { enabled: true, expected: 'total,9\n' },
  }));

  // `exists` is the whole check, so a bare presence assertion is valid.
  assertValid(validateTestCaseConfig({
    id: 'out', type: 'file_state', points: 5, path: 'result.csv', exists: false,
  }));
});

test('file_state fields are checked at their own path', () => {
  assertOneErrorAt(
    validateTestCaseConfig({ id: 'out', type: 'file_state', points: 5, path: 'out.txt', exists: 'yes' }),
    `${TEST_PATH}.exists`,
    /Must be a boolean/,
  );
  assertOneErrorAt(
    validateTestCaseConfig({ id: 'out', type: 'file_state', points: 5, path: 'out.csv', format: 'json' }),
    `${TEST_PATH}.format`,
    /Must be one of: text, csv, binary/,
  );
  assertOneErrorAt(
    validateTestCaseConfig({
      id: 'out', type: 'file_state', points: 5, path: 'out.csv', format: 'csv',
      content_assertion: { enabled: true, expected: 'a\n' },
    }),
    `${TEST_PATH}.content_assertion`,
    /Only supported when format is "text"/,
  );
  assertOneErrorAt(
    validateTestCaseConfig({
      id: 'out', type: 'file_state', points: 5, path: 'out.txt',
      content_assertion: { enabled: true, expected: 'a', match_mode: 'fuzzy' },
    }),
    `${TEST_PATH}.content_assertion.match_mode`,
    /exact, contains, or regex/,
  );
  assertOneErrorAt(
    validateTestCaseConfig({
      id: 'out', type: 'file_state', points: 5, path: 'out.txt',
      content_assertion: { enabled: true, expected: 'a', match_any_item: true },
    }),
    `${TEST_PATH}.content_assertion.match_any_item`,
    /Unknown property/,
  );
  // A disabled content assertion on a non-text format is harmless.
  assertValid(validateTestCaseConfig({
    id: 'out', type: 'file_state', points: 5, path: 'out.bin', format: 'binary',
    content_assertion: { enabled: false },
  }));
});

test('file_state csv assertions cover row count, header and cells', () => {
  const csvTest = (csv_assertions) => ({
    id: 'out', type: 'file_state', points: 5, path: 'result.csv', format: 'csv', csv_assertions,
  });

  assertValid(validateTestCaseConfig(csvTest({
    row_count: 1,
    row_count_comparison: 'equals',
    header: ['total'],
    cells: [{ row: 0, column: 0, expected_value: '7', comparison: 'equals' }],
  })));
  assertValid(validateTestCaseConfig(csvTest({
    cells: [{ row: 0, column: 0, expected_type: 'int' }],
  })));

  assertOneErrorAt(
    validateTestCaseConfig(csvTest({ row_count: -1 })),
    `${TEST_PATH}.csv_assertions.row_count`,
    /non-negative integer/,
  );
  assertOneErrorAt(
    validateTestCaseConfig(csvTest({ row_count_comparison: 'about' })),
    `${TEST_PATH}.csv_assertions.row_count_comparison`,
    /Must be one of/,
  );
  assertOneErrorAt(
    validateTestCaseConfig(csvTest({ header: 'total' })),
    `${TEST_PATH}.csv_assertions.header`,
    /Must be an array/,
  );
  assertOneErrorAt(
    validateTestCaseConfig(csvTest({ header: ['total', 7] })),
    `${TEST_PATH}.csv_assertions.header`,
    /array of strings/,
  );
  assertOneErrorAt(
    validateTestCaseConfig(csvTest({ cells: 'x' })),
    `${TEST_PATH}.csv_assertions.cells`,
    /Must be an array/,
  );
  assertOneErrorAt(
    validateTestCaseConfig(csvTest({ cells: [{ row: 0 }] })),
    `${TEST_PATH}.csv_assertions.cells[0].column`,
    /non-negative integer/,
  );
  assertOneErrorAt(
    validateTestCaseConfig(csvTest({ cells: [{ row: 0, column: 0 }] })),
    `${TEST_PATH}.csv_assertions.cells[0]`,
    /expected_value, expected_type, or both/,
  );
  assertOneErrorAt(
    validateTestCaseConfig(csvTest({ cells: [{ row: 0, column: 0, expected_value: '7', comparison: 'type' }] })),
    `${TEST_PATH}.csv_assertions.cells[0].comparison`,
    /Invalid comparison operator/,
  );
  assertOneErrorAt(
    validateTestCaseConfig(csvTest({ cells: [{ row: 0, column: 0, expected_type: 'nope' }] })),
    `${TEST_PATH}.csv_assertions.cells[0].expected_type`,
    /Must be one of/,
  );
  assertOneErrorAt(
    validateTestCaseConfig(csvTest({ cells: [{ row: 0, column: 0, expected_value: '7', column_name: 'a' }] })),
    `${TEST_PATH}.csv_assertions.cells[0].column_name`,
    /Unknown property/,
  );
  assertOneErrorAt(
    validateTestCaseConfig(csvTest({ delimiter: ',' })),
    `${TEST_PATH}.csv_assertions.delimiter`,
    /Unknown property/,
  );
});

test('setup_files on an executing test follow the seeded-file rules', () => {
  const withSetup = (setup_files) => ({
    id: 'out', type: 'file_state', points: 5, path: 'result.csv', exists: true, setup_files,
  });

  assertValid(validateTestCaseConfig(withSetup([file({ path: 'data/input.csv' })])));
  assertOneErrorAt(
    validateTestCaseConfig(withSetup([file({ path: '../input.csv' })])),
    `${TEST_PATH}.setup_files[0].path`,
    /"\.\." segments/,
  );
  assertOneErrorAt(
    validateTestCaseConfig(withSetup([{ path: 'input.csv', content: 'x', content_base64: 'eA==' }])),
    `${TEST_PATH}.setup_files[0]`,
    /not both/,
  );
  assertOneErrorAt(
    validateTestCaseConfig(withSetup('input.csv')),
    `${TEST_PATH}.setup_files`,
    /Must be an array/,
  );

  // There is no 50-file cap on per-test setup files.
  const many = Array.from({ length: MAX_ACTIVITY_FILES + 1 }, (unused, index) => file({ path: `f${index}.csv` }));
  assertValid(validateTestCaseConfig(withSetup(many)));
});

test('a hint needs a non-empty id, a non-empty message and a trigger object', () => {
  const empty = validateHintConfig({}, 2);
  assert.deepEqual(pathsOf(empty), ['hints[2].id', 'hints[2].message', 'hints[2].trigger']);
  assertOneErrorAt(empty, 'hints[2].id', /Required field is missing/);

  assertOneErrorAt(validateHintConfig(hint({ id: '   ' })), 'hints[0].id', /Must not be empty/);
  assertOneErrorAt(validateHintConfig(hint({ message: '' })), 'hints[0].message', /Must not be empty/);
  assertOneErrorAt(validateHintConfig(hint({ message: 42 })), 'hints[0].message', /Must be string, got number/);

  assertValid(validateHintConfig(hint()));
  assertValid(validateHintConfig({ id: 'h', message: 'm', trigger: { event: 'manual' } }));
});

test('a null hint trigger is reported once and skips the event check', () => {
  const result = validateHintConfig(hint({ trigger: null }));

  assert.deepEqual(pathsOf(result), ['hints[0].trigger']);
  assertOneErrorAt(result, 'hints[0].trigger', /Required field is missing/);
});

test('the hint trigger event is code_change, test_fail or manual', () => {
  // The Blockly-era event name is gone.
  assertOneErrorAt(
    validateHintConfig(hint({ trigger: { event: 'workspace_change' } })),
    'hints[0].trigger.event',
    /Must be one of/,
  );
  assertOneErrorAt(
    validateHintConfig({ id: 'h', message: 'm', trigger: {} }),
    'hints[0].trigger.event',
    /Must be one of/,
  );

  assertValid(validateHintConfig({ id: 'h', message: 'm', trigger: { event: 'test_fail' } }));
  assertValid(validateHintConfig({ id: 'h', message: 'm', trigger: { event: 'manual' } }));
  assertValid(validateHintConfig({
    id: 'h', message: 'm', trigger: { event: 'code_change', conditions: { type: 'source_empty' } },
  }));
});

test('code_change hints require conditions, and those conditions are validated', () => {
  assertOneErrorAt(
    validateHintConfig({ id: 'h', message: 'm', trigger: { event: 'code_change' } }),
    'hints[0].trigger.conditions',
    /Required for code_change/,
  );

  assertOneErrorAt(
    validateHintConfig({
      id: 'h', message: 'm', trigger: { event: 'code_change', conditions: { type: 'ast_pattern' } },
    }),
    'hints[0].trigger.conditions.pattern',
    /Required field is missing/,
  );
  assertOneErrorAt(
    validateHintConfig({
      id: 'h', message: 'm', trigger: { event: 'code_change', conditions: { type: 'none', conditions: [] } },
    }),
    'hints[0].trigger.conditions.conditions',
    /non-empty conditions array/,
  );
  assertOneErrorAt(
    validateHintConfig({
      id: 'h',
      message: 'm',
      trigger: { event: 'manual', conditions: { type: 'source_regex', pattern: 'x', regex_flags: 'z' } },
    }),
    'hints[0].trigger.conditions.regex_flags',
    /letters i, m and s/,
  );

  // Conditions are optional for the other events.
  assertValid(validateHintConfig({
    id: 'h', message: 'm', trigger: { event: 'test_fail', conditions: { type: 'source_empty' } },
  }));
});

test('the hint display mode must be triggered or checklist, and defaults when omitted', () => {
  assertOneErrorAt(validateHintConfig(hint({ display_mode: 'always' })), 'hints[0].display_mode', /Must be one of/);
  assertOneErrorAt(validateHintConfig(hint({ display_mode: 1 })), 'hints[0].display_mode', /Must be one of/);

  for (const display_mode of ['triggered', 'checklist']) {
    assertValid(validateHintConfig(hint({ display_mode })));
  }
  assertValid(validateHintConfig(hint({ display_mode: undefined })));
});

test('hint presentation fields are range- and type-checked', () => {
  assertOneErrorAt(validateHintConfig(hint({ priority: 0 })), 'hints[0].priority', /at least 1/);
  assertOneErrorAt(validateHintConfig(hint({ priority: 1.5 })), 'hints[0].priority', /at least 1/);
  assertOneErrorAt(validateHintConfig(hint({ delay_seconds: -1 })), 'hints[0].delay_seconds', /non-negative integer/);
  assertOneErrorAt(validateHintConfig(hint({ show_once: 'yes' })), 'hints[0].show_once', /Must be a boolean/);
  assertOneErrorAt(validateHintConfig(hint({ style: 'danger' })), 'hints[0].style', /Must be one of: success/);
  assertOneErrorAt(
    validateHintConfig(hint({ trigger: { after_attempts: -1 } })),
    'hints[0].trigger.after_attempts',
    /non-negative integer/,
  );
  assertOneErrorAt(
    validateHintConfig(hint({ trigger: { invalidate_on_condition_false: 'yes' } })),
    'hints[0].trigger.invalidate_on_condition_false',
    /Must be a boolean/,
  );

  assertValid(validateHintConfig(hint({ style: 'warning' })));
  assertValid(validateHintConfig(hint({ style: '' })));
  assertValid(validateHintConfig(hint({ priority: 5, delay_seconds: 3, show_once: true })));
  assertValid(validateHintConfig(hint({ trigger: { after_attempts: 2, invalidate_on_condition_false: true } })));
});

test('unknown hint fields are rejected', () => {
  assertOneErrorAt(validateHintConfig(hint({ html: '<b>hi</b>' })), 'hints[0].html', /Unknown property/);
  assertOneErrorAt(
    validateHintConfig(hint({ trigger: { condition: { type: 'source_empty' } } })),
    'hints[0].trigger.condition',
    /Unknown property/,
  );
  assertOneErrorAt(validateHintConfig('nope'), 'hints[0]', /Must be an object/);
});

test('hints are validated through the full config at their hints path', () => {
  const result = validateConfig(activityConfig({
    hints: [hint(), hint({ id: 'hint_2', trigger: { event: 'nope' } })],
  }));

  assert.equal(result.valid, false);
  assert.deepEqual(pathsOf(result), ['hints[1].trigger.event']);
  assertOneErrorAt(result, 'hints[1].trigger.event', /Must be one of/);

  assertValid(validateConfig(activityConfig({ hints: [hint()] })));
  assertOneErrorAt(validateConfig(activityConfig({ hints: 'x' })), 'hints', /Must be an array/);
});

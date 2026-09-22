/**
 * Config normalization — the boundary every activity config crosses twice:
 * once on the way in (a hand-written, legacy or half-edited config becoming a
 * builder draft) and once on the way out (that draft becoming the payload that
 * is exported to JSON and to a SCORM package).
 *
 * The interesting edges are the ones real configs arrive with: whole sections
 * missing, a section of the wrong type, keys written by an older schema,
 * assertion objects that were never filled in, and items too incomplete to
 * publish.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SUSPEND_DATA_DEFAULT_LIMIT,
  normalizeBuilderDraftConfig,
  normalizeConfig,
  sanitizeConfigForExport,
  sanitizeConfigForScorm,
} from '../src/shared/config-normalizer.js';
import { validateConfig } from '../src/shared/config-validator.js';
import { activityConfig, codeStructureTestConfig, hint } from './helpers/config.js';

/** The complete draft a config with nothing readable in it normalizes to. */
function emptyDraftSections() {
  return {
    metadata: { activity_id: '', title: '', version: '1.0', description: '' },
    instructions: { main: '', steps: [] },
    ui_settings: { show_hint_panel: true, suspend_data_limit: SUSPEND_DATA_DEFAULT_LIMIT },
    python_setup: { starter_code: '', files: [], packages: [], pyodide_base_url: '' },
    hints: [],
    evaluation: { feedback_on_all_pass: '', require_previous_test_pass: true, test_cases: [] },
  };
}

/** A config that reaches most branches of both normalizers. */
function richConfig() {
  return activityConfig({
    metadata: {
      activity_id: 'rich_activity',
      title: 'Rich',
      version: '2.1',
      description: 'd',
      unknown_meta: true,
    },
    instructions: { main: 'Do it', steps: ['one', 2, null] },
    ui_settings: { show_hint_panel: false, suspend_data_limit: 2048, unknown_ui: 1 },
    python_setup: {
      starter_code: 'print(1)\n',
      files: [{ path: 'data.csv', content: 'a,b\n' }],
      packages: ['pillow'],
      pyodide_base_url: 'https://cdn.example.com/pyodide/',
    },
    hints: [
      hint({
        id: 'hint_a',
        message: 'First',
        style: 'warning',
        trigger: {
          event: 'test_fail',
          conditions: {
            type: 'all',
            conditions: [{ type: 'ast_pattern', pattern: 'print(...)', min_count: 1, max_count: 3 }],
          },
          after_attempts: 2,
          invalidate_on_condition_false: true,
        },
      }),
    ],
    evaluation: {
      feedback_on_all_pass: 'nice',
      require_previous_test_pass: false,
      test_cases: [
        {
          id: 'test_stdout',
          type: 'stdout_match',
          points: 4,
          output_assertion: { enabled: true, expected: 'hi\n', match_mode: 'contains' },
          prompt_inputs: ['Ada'],
          strict_prompt_inputs: false,
          execution_context: { scope: 'function', function_name: 'greet', arguments: ['Ada'] },
          setup_files: [{ path: 'extra.txt', content: 'x' }],
        },
        {
          id: 'test_vars',
          type: 'variable_state',
          points: 6,
          variable_name: 'count',
          expected_type: 'int',
          expected_value: 3,
          comparison: 'gt',
          show_coerced_value_hint: true,
        },
        {
          id: 'test_func',
          type: 'function_state',
          points: 3,
          function_name: 'greet',
          parameter_count_enabled: true,
          parameter_count: 1,
          return_assertion: {
            enabled: true,
            arguments: ['Ada'],
            expected_type: 'string',
            expected_value: 'Hello, Ada!',
          },
        },
        {
          id: 'test_file',
          type: 'file_state',
          points: 2,
          path: 'result.csv',
          format: 'csv',
          csv_assertions: {
            row_count: 1,
            row_count_comparison: 'equals',
            header: ['average'],
            cells: [{ row: 1, column: 0, expected_value: '7', comparison: 'equals', expected_type: 'int' }],
          },
        },
        codeStructureTestConfig({ type: 'ast_pattern', pattern: 'print(...)' }, { id: 'test_structure', points: 5 })
          .evaluation.test_cases[0],
      ],
    },
  });
}

function draft(raw) {
  return normalizeBuilderDraftConfig(raw).config;
}

function draftHint(raw) {
  return draft({ hints: [raw] }).hints[0];
}

function draftTest(raw) {
  return draft({ evaluation: { test_cases: [raw] } }).evaluation.test_cases[0];
}

function publishHint(raw) {
  return sanitizeConfigForExport({ hints: [raw] }).config.hints[0];
}

function publishTest(raw) {
  return sanitizeConfigForExport({ evaluation: { test_cases: [raw] } }).config.evaluation
    .test_cases[0];
}

/** Draft-normalized condition for a one-test config. */
function draftCondition(raw) {
  return draftTest({ type: 'code_structure', conditions: raw }).conditions;
}

/** Export-normalized condition payload (and how many tests were dropped). */
function publishCondition(raw) {
  const { config, omissions } = sanitizeConfigForExport({
    evaluation: { test_cases: [{ id: 't', type: 'code_structure', points: 1, conditions: raw }] },
  });
  return { conditions: config.evaluation.test_cases[0]?.conditions, testOmissions: omissions.tests };
}

function keysOf(value) {
  return Object.keys(value).sort();
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

test('a config with no sections at all still produces a complete draft', () => {
  for (const raw of [undefined, null, 0, 'nope', true, [], () => {}]) {
    const { config } = normalizeBuilderDraftConfig(raw);
    const expected = emptyDraftSections();
    assert.deepEqual(config.metadata, expected.metadata);
    assert.deepEqual(config.instructions, expected.instructions);
    assert.deepEqual(config.ui_settings, expected.ui_settings);
    assert.deepEqual(config.python_setup, expected.python_setup);
    assert.deepEqual(config.hints, expected.hints);
    assert.deepEqual(config.evaluation, expected.evaluation);
  }
});

test('a section of the wrong type is replaced wholesale, not half-read', () => {
  const { config } = normalizeBuilderDraftConfig({
    metadata: 'text',
    instructions: [],
    ui_settings: 'text',
    python_setup: 5,
    hints: {},
    evaluation: null,
  });
  assert.deepEqual(config, emptyDraftSections());
});

test('readable fields inside a partly broken section survive', () => {
  const config = draft({
    metadata: { activity_id: 'a_1', title: 42, description: null },
    instructions: { main: 'go', steps: 'nope' },
    ui_settings: { show_hint_panel: false, suspend_data_limit: '2048' },
    python_setup: {
      starter_code: 7,
      files: [{ path: 'data.csv', content: 'a\n' }],
      packages: 'pillow',
      pyodide_base_url: 'https://example.com/pyodide',
    },
  });

  assert.deepEqual(config.metadata, {
    activity_id: 'a_1',
    title: '',
    version: '1.0',
    description: '',
  });
  assert.deepEqual(config.instructions, { main: 'go', steps: [] });
  assert.deepEqual(config.ui_settings, { show_hint_panel: false, suspend_data_limit: 2048 });
  assert.deepEqual(config.python_setup, {
    starter_code: '',
    files: [{ path: 'data.csv', content: 'a\n' }],
    packages: [],
    pyodide_base_url: 'https://example.com/pyodide',
  });
});

test('only known keys reach the draft, at every level', () => {
  const config = draft({
    metadata: { activity_id: 'a', title: 't', version: '2.0', description: 'd', created_at: 'x' },
    ui_settings: { theme: 'dark', hint_display_mode: 'checklist', traffic_light: true },
    python_setup: { starter_code: 'x', files: [], packages: [], pyodide_base_url: '', interpreter: 'cpython' },
    evaluation: {
      grading_mode: 'pass_fail',
      max_score: 50,
      test_cases: [
        {
          type: 'stdout_match',
          points: 1,
          output_assertion: { enabled: true, expected: 'x', mystery: 1 },
          surprise: true,
        },
      ],
    },
  });

  assert.deepEqual(keysOf(config.metadata), ['activity_id', 'description', 'title', 'version']);
  assert.deepEqual(keysOf(config.ui_settings), ['show_hint_panel', 'suspend_data_limit']);
  assert.deepEqual(keysOf(config.python_setup), [
    'files',
    'packages',
    'pyodide_base_url',
    'starter_code',
  ]);
  assert.deepEqual(keysOf(config.evaluation), [
    'feedback_on_all_pass',
    'require_previous_test_pass',
    'test_cases',
  ]);
  assert.deepEqual(keysOf(config.evaluation.test_cases[0].output_assertion), [
    'enabled',
    'expected',
    'failure_message',
    'match_mode',
    'show_actual',
    'show_expected',
    'success_message',
  ]);
});

test('the retired code-toggle setting is dropped from ui_settings', () => {
  const ui = (raw) => draft({ ui_settings: raw }).ui_settings;

  assert.equal('show_code_toggle' in ui({ show_code_toggle: true }), false);
  assert.deepEqual(
    keysOf(ui({ show_code_toggle: true, show_hint_panel: false, suspend_data_limit: 2048 })),
    ['show_hint_panel', 'suspend_data_limit'],
  );
});

test('ui_settings booleans only treat an explicit value as set', () => {
  const showHintPanel = (value) => draft({ ui_settings: { show_hint_panel: value } }).ui_settings
    .show_hint_panel;

  assert.equal(showHintPanel(false), false);
  assert.equal(showHintPanel(true), true);
  assert.equal(showHintPanel(undefined), true);
  assert.equal(showHintPanel('nope'), true);
});

test('suspend_data_limit falls back to the SCORM default when it cannot be read as a number', () => {
  const limit = (value) => draft({ ui_settings: { suspend_data_limit: value } }).ui_settings
    .suspend_data_limit;

  assert.equal(limit(undefined), SUSPEND_DATA_DEFAULT_LIMIT);
  assert.equal(limit(null), SUSPEND_DATA_DEFAULT_LIMIT);
  assert.equal(limit(''), SUSPEND_DATA_DEFAULT_LIMIT);
  assert.equal(limit('lots'), SUSPEND_DATA_DEFAULT_LIMIT);
  assert.equal(limit('2048'), 2048);
  assert.equal(limit(12.7), 12);
});

test('an out-of-range suspend_data_limit reaches the export validator untouched', () => {
  const raw = activityConfig({ ui_settings: { suspend_data_limit: 100 } });

  assert.equal(draft(raw).ui_settings.suspend_data_limit, 100);
  assert.equal(sanitizeConfigForExport(raw).config.ui_settings.suspend_data_limit, 100);
});

test('instruction steps drop nullish entries and stringify the rest', () => {
  const config = draft({ instructions: { steps: [1, null, undefined, 'x', true, ''] } });
  assert.deepEqual(config.instructions.steps, ['1', 'x', 'true', '']);
});

test('python_setup defaults land and activity files pass through', () => {
  const setup = (raw) => draft({ python_setup: raw }).python_setup;
  const files = [
    { path: 'data.csv', content: 'name,score\nAda,7\n' },
    { path: 'logo.png', content_base64: 'aGk=', unknown_file_key: 1 },
    { content: 'no path' },
  ];

  assert.deepEqual(setup(undefined), {
    starter_code: '',
    files: [],
    packages: [],
    pyodide_base_url: '',
  });
  assert.deepEqual(setup({ files }).files, [
    { path: 'data.csv', content: 'name,score\nAda,7\n' },
    { path: 'logo.png', content_base64: 'aGk=' },
    { path: '', content: 'no path' },
  ]);
  // The export keeps the same bytes: publishing never rewrites file contents.
  assert.deepEqual(sanitizeConfigForExport({ python_setup: { files } }).config.python_setup.files, [
    { path: 'data.csv', content: 'name,score\nAda,7\n' },
    { path: 'logo.png', content_base64: 'aGk=' },
    { path: '', content: 'no path' },
  ]);
});

test('only packages the runtime ships survive normalization', () => {
  const packages = (raw) => draft({ python_setup: { packages: raw } }).python_setup.packages;

  assert.deepEqual(packages(['pillow']), ['pillow']);
  assert.deepEqual(packages(['pillow', 'numpy', 'pillow']), ['pillow', 'pillow']);
  assert.deepEqual(packages(['numpy']), []);
  assert.deepEqual(packages('pillow'), []);
  assert.deepEqual(packages(undefined), []);
});

test('a section list that is not an array is treated as empty', () => {
  const draftConfig = draft({
    hints: null,
    evaluation: { test_cases: {} },
    python_setup: { files: 'text' },
  });
  assert.deepEqual(draftConfig.hints, []);
  assert.deepEqual(draftConfig.evaluation.test_cases, []);
  assert.deepEqual(draftConfig.python_setup.files, []);

  const { config, omissions } = sanitizeConfigForExport({
    hints: 'text',
    evaluation: { test_cases: 5 },
    python_setup: { files: null },
  });
  assert.deepEqual(config.hints, []);
  assert.deepEqual(config.evaluation.test_cases, []);
  assert.deepEqual(config.python_setup.files, []);
  assert.deepEqual(omissions, { hints: 0, tests: 0 });
});

test('a draft hint fills in a usable trigger and per-index defaults', () => {
  assert.deepEqual(draftHint(hint()), {
    id: 'hint_1',
    trigger: {
      event: 'code_change',
      conditions: { type: 'source_empty' },
      after_attempts: 0,
      invalidate_on_condition_false: false,
    },
    display_mode: 'triggered',
    message: 'Try something.',
    priority: 1,
    delay_seconds: 0,
    show_once: false,
  });

  const [first, second] = draft({ hints: [{}, { message: 'later' }] }).hints;
  assert.equal(first.id, 'hint_1');
  assert.equal(first.priority, 1);
  assert.equal(second.id, 'hint_2');
  assert.equal(second.priority, 2);
  assert.equal(second.message, 'later');
});

test('hint style and invalidation survive normalization, unknown hint keys do not', () => {
  const styled = hint({
    style: 'warning',
    trigger: { invalidate_on_condition_false: true },
    unknown_hint: 1,
  });

  const drafted = draftHint(styled);
  assert.equal(drafted.style, 'warning');
  assert.equal(drafted.trigger.invalidate_on_condition_false, true);
  assert.equal('unknown_hint' in drafted, false);

  const published = publishHint(styled);
  assert.equal(published.style, 'warning');
  assert.equal(published.trigger.invalidate_on_condition_false, true);
  assert.equal('unknown_hint' in published, false);

  // An empty style is dropped rather than published as a meaningless setting.
  assert.equal('style' in draftHint(hint({ style: '' })), false);
  assert.equal('style' in publishHint(hint({ style: '' })), false);
});

test('a retired hint event falls back to code_change, an unknown one is dropped on export', () => {
  const retired = {
    id: 'legacy_timed',
    message: 'Need help?',
    trigger: { event: 'timed' },
    delay_seconds: 60,
  };

  const drafted = draftHint(retired);
  assert.equal(drafted.trigger.event, 'code_change');
  assert.equal(drafted.trigger.conditions.type, 'source_empty');
  assert.equal(drafted.delay_seconds, 60);

  const { config, omissions } = sanitizeConfigForExport({ hints: [retired] });
  assert.deepEqual(config.hints, []);
  assert.equal(omissions.hints, 1);
});

test('legacy test keys are dropped rather than carried', () => {
  const drafted = draftTest({
    type: 'stdout_match',
    points: 4,
    weight: 99,
    expected_output: 'hi\n',
    match_mode: 'contains',
    prompt_inputs: ['Ada'],
  });

  assert.equal(drafted.points, 4);
  assert.equal('weight' in drafted, false);
  assert.equal('expected_output' in drafted, false);
  assert.equal('match_mode' in drafted, false);
  assert.deepEqual(drafted.prompt_inputs, ['Ada']);
  assert.deepEqual(keysOf(drafted), [
    'execution_context',
    'feedback_on_fail',
    'feedback_on_pass',
    'id',
    'output_assertion',
    'points',
    'prompt_assertion',
    'prompt_inputs',
    'setup_files',
    'strict_prompt_inputs',
    'type',
  ]);

  const published = publishTest({
    id: 't',
    type: 'stdout_match',
    points: 4,
    weight: 99,
    expected_output: 'hi\n',
    match_mode: 'contains',
    output_assertion: { enabled: true, expected: 'hi\n' },
  });
  assert.equal(published.points, 4);
  assert.equal('weight' in published, false);
  assert.equal('expected_output' in published, false);
  assert.equal('match_mode' in published, false);
  assert.equal(published.output_assertion.expected, 'hi\n');
});

test('a draft stdout test carries every assertion field the runtime reads', () => {
  const fresh = draftTest({ type: 'stdout_match' });

  assert.deepEqual(fresh.prompt_inputs, []);
  assert.equal(fresh.strict_prompt_inputs, true);
  assert.deepEqual(fresh.setup_files, []);
  assert.deepEqual(fresh.execution_context, { scope: 'main', function_name: '', arguments: [] });
  // Python asserts on the joined transcript, so only the prompt can match items.
  assert.deepEqual(fresh.output_assertion, {
    enabled: true,
    expected: '',
    match_mode: 'exact',
    show_expected: false,
    show_actual: false,
    success_message: '',
    failure_message: '',
  });
  assert.deepEqual(fresh.prompt_assertion, {
    enabled: false,
    expected: '',
    match_mode: 'exact',
    match_any_item: false,
    show_expected: false,
    show_actual: false,
    success_message: '',
    failure_message: '',
  });

  const written = draftTest({
    type: 'stdout_match',
    output_assertion: { enabled: false, expected: 'hi', match_mode: 'regex', match_any_item: true },
    prompt_assertion: { enabled: true, expected: 'Name\\?', match_mode: 'regex', match_any_item: true },
    strict_prompt_inputs: false,
  });
  assert.equal(written.output_assertion.enabled, false);
  assert.equal(written.output_assertion.match_mode, 'regex');
  assert.equal('match_any_item' in written.output_assertion, false);
  assert.equal(written.prompt_assertion.enabled, true);
  assert.equal(written.prompt_assertion.match_any_item, true);
  assert.equal(written.strict_prompt_inputs, false);
});

test('execution_context defaults to main scope with empty function fields', () => {
  assert.deepEqual(draftTest({ type: 'stdout_match' }).execution_context, {
    scope: 'main',
    function_name: '',
    arguments: [],
  });
  assert.deepEqual(
    draftTest({
      type: 'stdout_match',
      execution_context: { scope: 'function', function_name: 'greet', arguments: ['Ada'] },
    }).execution_context,
    { scope: 'function', function_name: 'greet', arguments: ['Ada'] },
  );
  // A function name alone is enough to mean "call this function".
  assert.deepEqual(
    draftTest({ type: 'stdout_match', execution_context: { function_name: 'greet' } }).execution_context,
    { scope: 'function', function_name: 'greet', arguments: [] },
  );
  assert.deepEqual(
    draftTest({ type: 'stdout_match', execution_context: { scope: 'bogus' } }).execution_context,
    { scope: 'main', function_name: '', arguments: [] },
  );

  // Publishing keeps a function scope and omits the main-scope default.
  assert.deepEqual(
    publishTest({
      id: 't',
      type: 'stdout_match',
      points: 1,
      output_assertion: { enabled: true, expected: 'x' },
      execution_context: { scope: 'function', function_name: 'greet' },
    }).execution_context,
    { scope: 'function', function_name: 'greet', arguments: [] },
  );
  assert.equal(
    'execution_context' in publishTest({
      id: 't',
      type: 'stdout_match',
      points: 1,
      output_assertion: { enabled: true, expected: 'x' },
    }),
    false,
  );
});

test('variable_state normalizes its type, comparison and list assertions', () => {
  const drafted = draftTest({
    type: 'variable_state',
    variable_name: 'total',
    expected_type: 'number',
    expected_value: 3,
    comparison: 'type',
    show_coerced_value_hint: true,
    list_assertions: {
      length_enabled: true,
      length_value: 2.7,
      length_comparison: 'wat',
      expected_values: ['a'],
      item_type_mode: 'bogus',
    },
  });

  assert.equal(drafted.variable_name, 'total');
  assert.equal(drafted.expected_type, 'any');
  assert.equal(drafted.comparison, 'equals');
  assert.equal(drafted.expected_value, 3);
  assert.equal(drafted.value_assertion_enabled, true);
  assert.equal(drafted.show_coerced_value_hint, true);
  assert.deepEqual(drafted.prompt_inputs, []);
  assert.equal(drafted.strict_prompt_inputs, true);
  assert.deepEqual(drafted.list_assertions, {
    length_enabled: true,
    length_value: 2,
    length_comparison: 'equals',
    values_enabled: false,
    values_match_mode: 'exact_order',
    expected_values: ['a'],
    item_types_enabled: false,
    item_type_mode: 'all',
    expected_item_types: [],
    index_checks: [],
  });
});

test('function_state normalizes its parameter count and return assertion', () => {
  const drafted = draftTest({
    type: 'function_state',
    function_name: 'greet',
    parameter_count_enabled: true,
    parameter_count: 2.9,
    return_assertion: {
      arguments: ['Ada'],
      expected_type: 'string',
      expected_value: 'Hello, Ada!',
    },
  });

  assert.equal(drafted.function_name, 'greet');
  assert.equal(drafted.parameter_count_enabled, true);
  assert.equal(drafted.parameter_count, 2);
  assert.equal(drafted.return_assertion.enabled, true);
  assert.equal(drafted.return_assertion.expected_type, 'string');
  assert.deepEqual(drafted.return_assertion.arguments, ['Ada']);
  assert.equal(drafted.return_assertion.expected_value, 'Hello, Ada!');
  assert.equal(drafted.return_assertion.value_assertion_enabled, true);
  assert.equal(drafted.return_assertion.comparison, 'equals');
  assert.deepEqual(keysOf(drafted), [
    'feedback_on_fail',
    'feedback_on_pass',
    'function_name',
    'id',
    'parameter_count',
    'parameter_count_enabled',
    'points',
    'return_assertion',
    'setup_files',
    'type',
  ]);
});

test('code_structure normalizes each of the six condition types', () => {
  assert.deepEqual(draftCondition({ type: 'ast_pattern', pattern: 'print(...)' }), {
    type: 'ast_pattern',
    pattern: 'print(...)',
    min_count: 1,
  });
  assert.deepEqual(
    draftCondition({ type: 'source_regex', pattern: 'print', case_sensitive: false, regex_flags: 'si' }),
    { type: 'source_regex', pattern: 'print', case_sensitive: false, regex_flags: 'is' },
  );
  assert.deepEqual(draftCondition({ type: 'source_empty' }), { type: 'source_empty' });
  assert.deepEqual(
    draftCondition({ type: 'all', conditions: [{ type: 'source_empty' }, 7, null] }),
    { type: 'all', conditions: [{ type: 'source_empty' }] },
  );
  assert.deepEqual(draftCondition({ type: 'any', conditions: [] }), {
    type: 'any',
    conditions: [{ type: 'source_empty' }],
  });
  assert.deepEqual(
    draftCondition({
      type: 'none',
      conditions: [{ type: 'all', conditions: [{ type: 'source_regex', pattern: 'x' }] }],
    }),
    {
      type: 'none',
      conditions: [
        {
          type: 'all',
          conditions: [{ type: 'source_regex', pattern: 'x', case_sensitive: true, regex_flags: '' }],
        },
      ],
    },
  );

  // A Blockly condition is no longer a Python one: the draft neutralises it.
  assert.deepEqual(draftCondition({ type: 'block_field_value', block_type: 'text' }), {
    type: 'source_empty',
  });
  assert.deepEqual(draftCondition({ type: 'block_count', block_type: 'text', min: 1 }), {
    type: 'source_empty',
  });
  assert.deepEqual(draftCondition(undefined), { type: 'source_empty' });
  assert.deepEqual(draftCondition('nope'), { type: 'source_empty' });
  assert.deepEqual(draftCondition({}), { type: 'source_empty' });

  // Drafting a source_regex condition twice changes nothing.
  assert.deepEqual(draftCondition(draftCondition({ type: 'source_regex', pattern: 'p', regex_flags: 'gsis' })), {
    type: 'source_regex',
    pattern: 'p',
    case_sensitive: true,
    regex_flags: 'is',
  });
});

test('an ast_pattern condition keeps its bounds in a publishable shape', () => {
  const fresh = publishCondition({ type: 'ast_pattern', pattern: 'print(...)' });
  assert.deepEqual(fresh.conditions, { type: 'ast_pattern', pattern: 'print(...)' });
  assert.equal(fresh.testOmissions, 0);

  const bounded = publishCondition({
    type: 'ast_pattern',
    pattern: 'for _ in _:\n    ...',
    min_count: '2',
    max_count: 4,
  });
  assert.deepEqual(bounded.conditions, {
    type: 'ast_pattern',
    pattern: 'for _ in _:\n    ...',
    min_count: 2,
    max_count: 4,
  });

  // A Blockly condition type is no longer a condition: the export validator
  // rejects the test, so nothing publishes and the omission is counted.
  const unknown = publishCondition({ type: 'block_count', block_type: 'text', min: 1 });
  assert.equal(unknown.conditions, undefined);
  assert.equal(unknown.testOmissions, 1);

  const missing = publishCondition(undefined);
  assert.equal(missing.conditions, undefined);
  assert.equal(missing.testOmissions, 1);
});

test('numeric condition bounds are clamped to their documented ranges', () => {
  const condition = (raw) => draftCondition({ type: 'ast_pattern', pattern: 'x', ...raw });

  assert.equal(condition({}).min_count, 1);
  assert.equal(condition({ min_count: 0 }).min_count, 1);
  assert.equal(condition({ min_count: '3' }).min_count, 3);
  assert.equal(condition({ min_count: 2.9 }).min_count, 2);
  assert.equal('max_count' in condition({}), false);
  assert.equal(condition({ min_count: 3, max_count: 1 }).max_count, 3);
  assert.equal(condition({ max_count: '4' }).max_count, 4);
  assert.equal('max_count' in condition({ max_count: 'lots' }), false);
});

test('source_regex case sensitivity and flags are normalized to a canonical shape', () => {
  const condition = (raw) => draftCondition({ type: 'source_regex', pattern: 'x', ...raw });

  assert.equal(condition({ regex_flags: 'gis' }).regex_flags, 'is');
  assert.equal(condition({ regex_flags: 'sis' }).regex_flags, 'is');
  assert.equal(condition({ regex_flags: 'IM' }).regex_flags, '');
  assert.equal(condition({ regex_flags: 7 }).regex_flags, '');
  assert.equal(condition({}).regex_flags, '');
  assert.equal(condition({}).case_sensitive, true);
  assert.equal(condition({ case_sensitive: false }).case_sensitive, false);
  assert.equal(condition({ case_sensitive: 'no' }).case_sensitive, true);
});

test('file_state fills every assertion default', () => {
  const fresh = draftTest({ type: 'file_state' });

  assert.deepEqual(keysOf(fresh), [
    'content_assertion',
    'csv_assertions',
    'exists',
    'feedback_on_fail',
    'feedback_on_pass',
    'format',
    'id',
    'path',
    'points',
    'prompt_inputs',
    'setup_files',
    'strict_prompt_inputs',
    'type',
  ]);
  assert.equal(fresh.path, '');
  assert.equal(fresh.exists, true);
  assert.equal(fresh.format, 'text');
  assert.equal(fresh.strict_prompt_inputs, true);
  assert.deepEqual(fresh.prompt_inputs, []);
  assert.deepEqual(fresh.setup_files, []);
  assert.deepEqual(fresh.content_assertion, {
    enabled: false,
    expected: '',
    match_mode: 'exact',
    show_expected: false,
    show_actual: false,
    success_message: '',
    failure_message: '',
  });
  assert.deepEqual(fresh.csv_assertions, {
    row_count: null,
    row_count_comparison: 'equals',
    header: null,
    cells: [],
  });
});

test('file_state keeps what the author wrote and drops what it does not know', () => {
  const written = draftTest({
    type: 'file_state',
    path: 'result.csv',
    exists: false,
    format: 'csv',
    content_assertion: { enabled: true, expected: 'a,b\n', match_mode: 'contains' },
    csv_assertions: {
      row_count: '2',
      row_count_comparison: 'gte',
      header: ['a', 'b'],
      cells: [{ row: 1, column: 0, expected_value: '7', comparison: 'gt' }],
    },
    prompt_inputs: ['Ada'],
    strict_prompt_inputs: false,
    setup_files: [{ path: 'data.csv', content: 'a,b\n' }],
    unknown_test: 1,
  });

  assert.equal(written.path, 'result.csv');
  assert.equal(written.exists, false);
  assert.equal(written.format, 'csv');
  assert.deepEqual(written.content_assertion, {
    enabled: true,
    expected: 'a,b\n',
    match_mode: 'contains',
    show_expected: false,
    show_actual: false,
    success_message: '',
    failure_message: '',
  });
  assert.deepEqual(written.csv_assertions, {
    row_count: 2,
    row_count_comparison: 'gte',
    header: ['a', 'b'],
    cells: [{ row: 1, column: 0, expected_value: '7', comparison: 'gt', expected_type: 'any' }],
  });
  assert.deepEqual(written.prompt_inputs, ['Ada']);
  assert.equal(written.strict_prompt_inputs, false);
  assert.deepEqual(written.setup_files, [{ path: 'data.csv', content: 'a,b\n' }]);
  assert.equal('unknown_test' in written, false);

  // An unknown format falls back to text; the two text formats survive as-is.
  assert.equal(draftTest({ type: 'file_state', format: 'xlsx' }).format, 'text');
  assert.equal(draftTest({ type: 'file_state', format: 'binary' }).format, 'binary');

  // The export keeps a setup file and the csv expectations it grades against.
  const published = publishTest({
    id: 't',
    type: 'file_state',
    points: 1,
    path: 'result.csv',
    format: 'csv',
    csv_assertions: { row_count: 1, cells: [{ row: 1, column: 0, expected_value: '7' }] },
    setup_files: [{ path: 'data.csv', content: 'a,b\n' }],
  });
  assert.deepEqual(published.setup_files, [{ path: 'data.csv', content: 'a,b\n' }]);
  assert.deepEqual(published.csv_assertions.cells, [
    { row: 1, column: 0, expected_value: '7', comparison: 'equals', expected_type: 'any' },
  ]);
});

test('csv cells normalize their coordinates, comparison and expected type', () => {
  const csv = (raw) => draftTest({ type: 'file_state', csv_assertions: raw }).csv_assertions;

  assert.deepEqual(
    csv({ cells: [7, null, { row: '1', column: -2, comparison: 'wat', expected_type: 'int' }] }).cells,
    [{ row: 1, column: 0, comparison: 'equals', expected_type: 'int' }],
  );
  assert.deepEqual(csv({ cells: [{ row: 0, column: 0, expected_value: 7 }] }).cells, [
    { row: 0, column: 0, expected_value: 7, comparison: 'equals', expected_type: 'any' },
  ]);
  assert.deepEqual(csv({ header: [1, true] }).header, ['1', 'true']);
  assert.equal(csv({ header: 'a,b' }).header, null);
  assert.equal(csv({ row_count: 'lots' }).row_count, null);
  assert.equal(csv({ row_count: -3 }).row_count, 0);
});

test('each incomplete hint and test is dropped once and counted', () => {
  const { config, omissions } = sanitizeConfigForExport(activityConfig({
    hints: [
      { id: 'hint_ok', message: 'kept', trigger: { event: 'code_change', conditions: { type: 'source_empty' } } },
      { id: '', message: 'no id', trigger: { event: 'manual' } },
      { id: 'no_message', message: '   ', trigger: { event: 'manual' } },
      { id: 'no_trigger', message: 'x' },
      { id: 'bad_event', message: 'x', trigger: { event: 'on_save' } },
      { id: 'no_conditions', message: 'x', trigger: { event: 'code_change' } },
    ],
    evaluation: {
      test_cases: [
        {
          id: 'test_ok',
          type: 'stdout_match',
          points: 5,
          output_assertion: { enabled: true, expected: 'hi\n' },
        },
        { id: '', type: 'stdout_match', points: 5, output_assertion: { enabled: true, expected: 'hi\n' } },
        { id: 'unknown_type', type: 'quiz', points: 5 },
        { id: 'no_assertion', type: 'stdout_match', points: 5 },
        { id: 'no_conditions', type: 'code_structure', points: 5 },
        { id: 'no_path', type: 'file_state', points: 5, format: 'text' },
      ],
    },
  }));

  assert.equal(omissions.hints, 5);
  assert.equal(omissions.tests, 5);
  assert.deepEqual(config.hints.map((entry) => entry.id), ['hint_ok']);
  assert.deepEqual(config.evaluation.test_cases.map((entry) => entry.id), ['test_ok']);

  // What survives the omissions is a config the export validator accepts.
  assert.equal(validateConfig(config).valid, true);
});

test('a valid activity exports unchanged and still validates', () => {
  const { config, omissions } = sanitizeConfigForExport(activityConfig());

  assert.deepEqual(omissions, { hints: 0, tests: 0 });
  assert.equal(validateConfig(config).valid, true);
  assert.deepEqual(keysOf(config.evaluation.test_cases[0]), [
    'id',
    'output_assertion',
    'points',
    'prompt_assertion',
    'prompt_inputs',
    'type',
  ]);
  assert.deepEqual(config.evaluation.test_cases[0].output_assertion, {
    enabled: true,
    expected: 'hi\n',
    match_mode: 'exact',
    show_expected: false,
    show_actual: false,
    success_message: '',
    failure_message: '',
  });
});

test('normalising an already normalised config changes nothing', () => {
  const once = draft(richConfig());
  assert.deepEqual(draft(once), once);
  assert.deepEqual(draft(draft(once)), once);

  const exported = sanitizeConfigForExport(richConfig());
  assert.deepEqual(exported.omissions, { hints: 0, tests: 0 });
  const again = sanitizeConfigForExport(exported.config);
  assert.deepEqual(again.config, exported.config);
  assert.deepEqual(again.omissions, { hints: 0, tests: 0 });
});

test('normalising never mutates or shares the caller config', () => {
  const raw = deepFreeze(richConfig());
  const snapshot = JSON.parse(JSON.stringify(raw));

  const drafted = draft(raw);
  assert.deepEqual(JSON.parse(JSON.stringify(raw)), snapshot);

  const exported = sanitizeConfigForExport(raw);
  assert.deepEqual(JSON.parse(JSON.stringify(raw)), snapshot);

  // The results are detached copies: writing to them cannot reach the input.
  drafted.metadata.title = 'changed';
  drafted.python_setup.files[0].content = 'changed';
  drafted.hints[0].trigger.conditions.conditions[0].pattern = 'changed';
  exported.config.ui_settings.show_hint_panel = 'changed';
  assert.deepEqual(JSON.parse(JSON.stringify(raw)), snapshot);
});

test('the SCORM alias produces exactly the export payload', () => {
  const viaExport = sanitizeConfigForExport(richConfig());
  const viaScorm = sanitizeConfigForScorm(richConfig());

  assert.deepEqual(viaScorm.config, viaExport.config);
  assert.deepEqual(viaScorm.omissions, viaExport.omissions);
  assert.deepEqual(sanitizeConfigForScorm({}).omissions, { hints: 0, tests: 0 });
});

test('normalizeConfig hands the runtime a complete config', () => {
  const raw = activityConfig({
    python_setup: { starter_code: 'print(1)\n', interpreter: 'cpython' },
    evaluation: { grading_mode: 'pass_fail' },
  });
  const config = normalizeConfig(raw);

  // Same shape the builder draft gets, handed over without the wrapper.
  assert.deepEqual(config, normalizeBuilderDraftConfig(raw).config);
  assert.equal(config.python_setup.starter_code, 'print(1)\n');
  assert.equal('interpreter' in config.python_setup, false);
  assert.equal('grading_mode' in config.evaluation, false);
  assert.deepEqual(config.metadata, raw.metadata);

  // A config that never saw the builder still gets every default.
  assert.deepEqual(normalizeConfig({}), emptyDraftSections());
  assert.deepEqual(normalizeConfig(null).evaluation.test_cases, []);
});

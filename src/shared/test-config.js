/**
 * Shared helpers for working with test case configuration.
 *
 * Python port of scorm-blockly's test-config: the shapes the builder writes and
 * the runtime reads back. The value and list assertions are ported verbatim;
 * the Blockly-only pieces (`block_structure` conditions, the `weight` alias and
 * the `expected_output`/`match_mode` legacy fields) are gone, and the variable
 * type enum now describes Python values.
 */

export const VALID_RUNTIME_TEXT_MATCH_MODES = ['exact', 'contains', 'regex'];
export const VALID_RUNTIME_EXECUTION_SCOPES = ['main', 'function'];
export const VALID_VARIABLE_TYPES = ['any', 'int', 'float', 'bool', 'string', 'list', 'tuple', 'dict', 'null'];
export const VALID_VARIABLE_VALUE_COMPARISONS = ['equals', 'gt', 'lt', 'gte', 'lte', 'contains'];
export const VALID_LIST_LENGTH_COMPARISONS = ['equals', 'gt', 'lt', 'gte', 'lte'];
export const VALID_LIST_VALUE_MATCH_MODES = [
  'exact_order',
  'same_values_any_order',
  'expected_subset_of_actual',
  'expected_superset_of_actual',
];
export const VALID_LIST_ITEM_TYPE_MODES = ['all', 'some', 'none'];
export const VALID_FILE_STATE_FORMATS = ['text', 'csv', 'binary'];

const DEFAULT_RUNTIME_TEXT_ASSERTION = Object.freeze({
  enabled: false,
  expected: '',
  match_mode: 'exact',
  show_expected: false,
  show_actual: false,
  success_message: '',
  failure_message: '',
});

const DEFAULT_RUNTIME_EXECUTION_CONTEXT = Object.freeze({
  scope: 'main',
  function_name: '',
  arguments: [],
});

const DEFAULT_LIST_ASSERTIONS = Object.freeze({
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
});

const DEFAULT_FUNCTION_RETURN_ASSERTION = Object.freeze({
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
  list_assertions: DEFAULT_LIST_ASSERTIONS,
});

const DEFAULT_FILE_STATE_CSV_ASSERTIONS = Object.freeze({
  row_count: null,
  row_count_comparison: 'equals',
  header: null,
  cells: [],
});

/** Test types that execute student code and therefore read `prompt_inputs`. */
const PROMPT_INPUT_TEST_TYPES = ['stdout_match', 'variable_state', 'file_state'];

/**
 * Get the point value for a test case.
 * @param {object} testCase
 * @returns {number}
 */
export function getTestPoints(testCase) {
  const numericValue = Number(testCase?.points ?? 0);
  return Number.isFinite(numericValue) ? Math.max(0, Math.trunc(numericValue)) : 0;
}

/**
 * Assign points to a test case.
 * @param {object} testCase
 * @param {number} points
 */
export function setTestPoints(testCase, points) {
  testCase.points = Math.max(0, Math.trunc(Number(points) || 0));
}

/**
 * Get the `input()` responses configured for a test case.
 * @param {object} testCase
 * @returns {string[]}
 */
export function getPromptInputs(testCase) {
  if (!Array.isArray(testCase?.prompt_inputs)) return [];
  return testCase.prompt_inputs.map((value) => String(value));
}

/**
 * Whether prompt input count mismatches should fail this test.
 *
 * Function tests call the function directly instead of driving the prompt
 * conversation, so their configured inputs are never a strict count.
 * @param {object} testCase
 * @returns {boolean}
 */
export function shouldEnforcePromptInputCount(testCase) {
  if (testCase?.type === 'function_state') return false;
  return testCase?.strict_prompt_inputs !== false;
}

/**
 * Format prompt inputs for editing in a textarea.
 * @param {string[]} promptInputs
 * @returns {string}
 */
export function formatPromptInputs(promptInputs) {
  return getPromptInputs({ prompt_inputs: promptInputs }).join('\n');
}

/**
 * Parse prompt inputs entered as one value per line.
 * @param {string} text
 * @returns {string[]}
 */
export function parsePromptInputs(text) {
  return text === '' ? [] : text.split(/\r?\n/);
}

/**
 * Normalize the comparison mode used by prompt/output/file-content assertions.
 * @param {string} matchMode
 * @returns {string}
 */
export function normalizeRuntimeTextMatchMode(matchMode) {
  return VALID_RUNTIME_TEXT_MATCH_MODES.includes(matchMode) ? matchMode : 'exact';
}

/**
 * Normalize an assertion object into a predictable shape.
 *
 * The item-matching flag is prompt-only, so it is added by the prompt getter
 * rather than carried here.
 * @param {object} assertion
 * @param {Partial<typeof DEFAULT_RUNTIME_TEXT_ASSERTION>} [defaults]
 * @returns {{ enabled: boolean, expected: string, match_mode: string, show_expected: boolean, show_actual: boolean, success_message: string, failure_message: string }}
 */
export function normalizeRuntimeTextAssertion(assertion, defaults = {}) {
  const source = isObjectLike(assertion) ? assertion : {};
  const fallback = { ...DEFAULT_RUNTIME_TEXT_ASSERTION, ...defaults };

  return {
    enabled: source.enabled !== undefined ? Boolean(source.enabled) : Boolean(fallback.enabled),
    expected: source.expected !== undefined ? String(source.expected) : String(fallback.expected ?? ''),
    match_mode: normalizeRuntimeTextMatchMode(source.match_mode ?? fallback.match_mode),
    show_expected: source.show_expected !== undefined ? Boolean(source.show_expected) : Boolean(fallback.show_expected),
    show_actual: source.show_actual !== undefined ? Boolean(source.show_actual) : Boolean(fallback.show_actual),
    success_message: source.success_message !== undefined ? String(source.success_message) : String(fallback.success_message ?? ''),
    failure_message: source.failure_message !== undefined ? String(source.failure_message) : String(fallback.failure_message ?? ''),
  };
}

/**
 * Get the normalized output assertion for a stdout_match test.
 *
 * Python asserts on the joined stdout transcript only, so there is no
 * per-item matching here.
 * @param {object} testCase
 * @param {{ defaultEnabled?: boolean }} [options]
 * @returns {{ enabled: boolean, expected: string, match_mode: string, show_expected: boolean, show_actual: boolean, success_message: string, failure_message: string }}
 */
export function getStdoutOutputAssertion(testCase, options = {}) {
  const rawAssertion = isObjectLike(testCase?.output_assertion) ? testCase.output_assertion : null;
  const defaultEnabled = options.defaultEnabled ?? Boolean(rawAssertion);

  return normalizeRuntimeTextAssertion(rawAssertion, { enabled: defaultEnabled });
}

/**
 * Get the normalized prompt-text assertion for a stdout_match test.
 * @param {object} testCase
 * @param {{ defaultEnabled?: boolean }} [options]
 * @returns {{ enabled: boolean, expected: string, match_mode: string, match_any_item: boolean, show_expected: boolean, show_actual: boolean, success_message: string, failure_message: string }}
 */
export function getStdoutPromptAssertion(testCase, options = {}) {
  const rawAssertion = isObjectLike(testCase?.prompt_assertion) ? testCase.prompt_assertion : null;
  const defaultEnabled = options.defaultEnabled ?? Boolean(rawAssertion);

  return {
    ...normalizeRuntimeTextAssertion(rawAssertion, { enabled: defaultEnabled }),
    match_any_item: Boolean(rawAssertion?.match_any_item),
  };
}

/**
 * Whether a stdout_match test enables at least one of its assertions.
 * @param {object} testCase
 * @returns {boolean}
 */
export function hasEnabledStdoutAssertion(testCase) {
  return getStdoutOutputAssertion(testCase).enabled || getStdoutPromptAssertion(testCase).enabled;
}

export function normalizeRuntimeExecutionScope(scope) {
  return VALID_RUNTIME_EXECUTION_SCOPES.includes(scope) ? scope : 'main';
}

/**
 * Get the normalized execution context for a stdout_match test.
 *
 * Naming a function is enough to select function scope; an explicit scope wins.
 * @param {object} testCase
 * @returns {{ scope: string, function_name: string, arguments: any[] }}
 */
export function getStdoutExecutionContext(testCase) {
  const source = isObjectLike(testCase?.execution_context) ? testCase.execution_context : {};
  const hasFunctionFields = source.function_name !== undefined || source.arguments !== undefined;
  const scope = source.scope !== undefined
    ? normalizeRuntimeExecutionScope(source.scope)
    : hasFunctionFields
      ? 'function'
      : DEFAULT_RUNTIME_EXECUTION_CONTEXT.scope;

  if (scope !== 'function') {
    return {
      scope,
      function_name: DEFAULT_RUNTIME_EXECUTION_CONTEXT.function_name,
      arguments: DEFAULT_RUNTIME_EXECUTION_CONTEXT.arguments,
    };
  }

  return {
    scope,
    function_name: source.function_name !== undefined
      ? String(source.function_name)
      : DEFAULT_RUNTIME_EXECUTION_CONTEXT.function_name,
    arguments: Array.isArray(source.arguments) ? source.arguments : DEFAULT_RUNTIME_EXECUTION_CONTEXT.arguments,
  };
}

export function normalizeVariableType(value) {
  return VALID_VARIABLE_TYPES.includes(value) ? value : 'any';
}

export function normalizeVariableValueComparison(value) {
  return VALID_VARIABLE_VALUE_COMPARISONS.includes(value) ? value : 'equals';
}

export function normalizeListLengthComparison(value) {
  return VALID_LIST_LENGTH_COMPARISONS.includes(value) ? value : 'equals';
}

export function normalizeListValueMatchMode(value) {
  return VALID_LIST_VALUE_MATCH_MODES.includes(value) ? value : 'exact_order';
}

export function normalizeListItemTypeMode(value) {
  return VALID_LIST_ITEM_TYPE_MODES.includes(value) ? value : 'all';
}

export function normalizeFileStateFormat(value) {
  return VALID_FILE_STATE_FORMATS.includes(value) ? value : 'text';
}

/**
 * Whether a value assertion should run for this test case.
 *
 * An explicit flag wins; otherwise a configured expected value implies one.
 * @param {object} testCase
 * @param {{ defaultEnabled?: boolean }} [options]
 * @returns {boolean}
 */
export function normalizeVariableValueAssertionEnabled(testCase, options = {}) {
  if (testCase?.value_assertion_enabled !== undefined) {
    return Boolean(testCase.value_assertion_enabled);
  }
  return options.defaultEnabled ?? testCase?.expected_value !== undefined;
}

export function normalizeFunctionParameterCountEnabled(testCase) {
  return Boolean(testCase?.parameter_count_enabled);
}

export function normalizeListExpectedTypes(value) {
  if (!Array.isArray(value)) return [];
  return value
    // `String(null)` would spell a real Python type, so absent entries are dropped rather than coerced.
    .filter((entry) => entry !== null && entry !== undefined)
    .map((entry) => String(entry))
    .filter((entry) => VALID_VARIABLE_TYPES.includes(entry) && entry !== 'any');
}

export function normalizeListIndexChecks(value) {
  if (!Array.isArray(value)) return [];

  return value
    .filter(isObjectLike)
    .map((entry) => ({
      index: asNonNegativeInteger(entry.index),
      ...(entry.expected_value !== undefined ? { expected_value: entry.expected_value } : {}),
      expected_type: normalizeVariableType(entry.expected_type),
    }));
}

export function getVariableListAssertions(testCase) {
  const source = isObjectLike(testCase?.list_assertions) ? testCase.list_assertions : {};

  return {
    length_enabled: Boolean(source.length_enabled),
    length_value: Math.max(0, Math.trunc(Number(source.length_value) || 0)),
    length_comparison: normalizeListLengthComparison(source.length_comparison),
    values_enabled: Boolean(source.values_enabled),
    values_match_mode: normalizeListValueMatchMode(source.values_match_mode),
    expected_values: Array.isArray(source.expected_values) ? source.expected_values : [],
    item_types_enabled: Boolean(source.item_types_enabled),
    item_type_mode: normalizeListItemTypeMode(source.item_type_mode),
    expected_item_types: normalizeListExpectedTypes(source.expected_item_types),
    index_checks: normalizeListIndexChecks(source.index_checks),
  };
}

export function getFunctionReturnAssertion(testCase) {
  const source = isObjectLike(testCase?.return_assertion) ? testCase.return_assertion : {};
  const hasAssertionFields = source.expected_value !== undefined
    || source.expected_type !== undefined
    || source.comparison !== undefined
    || source.show_coerced_value_hint !== undefined
    || source.show_expected !== undefined
    || source.show_actual !== undefined
    || source.success_message !== undefined
    || source.failure_message !== undefined
    || source.arguments !== undefined
    || source.value_assertion_enabled !== undefined
    || source.list_assertions !== undefined
    || hasEnabledListAssertion(source);

  return {
    enabled: source.enabled !== undefined
      ? Boolean(source.enabled)
      : hasAssertionFields,
    arguments: Array.isArray(source.arguments) ? source.arguments : [],
    expected_type: normalizeVariableType(source.expected_type),
    value_assertion_enabled: normalizeVariableValueAssertionEnabled(source),
    ...(source.expected_value !== undefined ? { expected_value: source.expected_value } : {}),
    comparison: normalizeVariableValueComparison(source.comparison),
    show_coerced_value_hint: source.show_coerced_value_hint !== undefined
      ? Boolean(source.show_coerced_value_hint)
      : Boolean(DEFAULT_FUNCTION_RETURN_ASSERTION.show_coerced_value_hint),
    show_expected: source.show_expected !== undefined
      ? Boolean(source.show_expected)
      : Boolean(DEFAULT_FUNCTION_RETURN_ASSERTION.show_expected),
    show_actual: source.show_actual !== undefined
      ? Boolean(source.show_actual)
      : Boolean(DEFAULT_FUNCTION_RETURN_ASSERTION.show_actual),
    success_message: source.success_message !== undefined
      ? String(source.success_message)
      : String(DEFAULT_FUNCTION_RETURN_ASSERTION.success_message),
    failure_message: source.failure_message !== undefined
      ? String(source.failure_message)
      : String(DEFAULT_FUNCTION_RETURN_ASSERTION.failure_message),
    list_assertions: getVariableListAssertions(source),
  };
}

export function hasEnabledListAssertion(testCase) {
  const assertions = getVariableListAssertions(testCase);
  return assertions.length_enabled
    || assertions.values_enabled
    || assertions.item_types_enabled
    || assertions.index_checks.length > 0;
}

/**
 * Get the AST condition a code_structure test asserts on.
 * @param {object} testCase
 * @returns {object|undefined}
 */
export function getCodeStructureConditions(testCase) {
  return testCase?.conditions;
}

/**
 * Get the path of the file a file_state test inspects.
 * @param {object} testCase
 * @returns {string}
 */
export function getFileStatePath(testCase) {
  const value = testCase?.path;
  return value === undefined || value === null ? '' : String(value);
}

/**
 * Get the normalized text-content assertion for a file_state test.
 * @param {object} testCase
 * @returns {{ enabled: boolean, expected: string, match_mode: string, show_expected: boolean, show_actual: boolean, success_message: string, failure_message: string }}
 */
export function getFileStateContentAssertion(testCase) {
  return normalizeRuntimeTextAssertion(testCase?.content_assertion);
}

/**
 * Get the normalized csv assertions for a file_state test.
 *
 * `row_count === null` and `header === null` mean "not asserted".
 * @param {object} testCase
 * @returns {{ row_count: number|null, row_count_comparison: string, header: string[]|null, cells: Array<{ row: number, column: number, expected_value?: any, comparison: string, expected_type: string }> }}
 */
export function getFileStateCsvAssertions(testCase) {
  const source = isObjectLike(testCase?.csv_assertions) ? testCase.csv_assertions : {};

  return {
    row_count: normalizeCsvRowCount(source.row_count),
    row_count_comparison: normalizeListLengthComparison(source.row_count_comparison),
    header: Array.isArray(source.header) ? source.header.map((entry) => String(entry)) : null,
    cells: normalizeCsvCells(source.cells),
  };
}

/**
 * Normalize a test case in place.
 * @param {object} testCase
 * @returns {object}
 */
export function normalizeTestCase(testCase) {
  if (!testCase || typeof testCase !== 'object') return testCase;

  setTestPoints(testCase, getTestPoints(testCase));

  if (testCase.prompt_inputs !== undefined) {
    testCase.prompt_inputs = getPromptInputs(testCase);
  }

  if (PROMPT_INPUT_TEST_TYPES.includes(testCase.type)) {
    testCase.strict_prompt_inputs = shouldEnforcePromptInputCount(testCase);
  }

  if (testCase.type === 'stdout_match') {
    testCase.output_assertion = getStdoutOutputAssertion(testCase);
    testCase.prompt_assertion = getStdoutPromptAssertion(testCase);
    testCase.execution_context = getStdoutExecutionContext(testCase);
  } else if (testCase.type === 'variable_state') {
    testCase.expected_type = normalizeVariableType(testCase.expected_type);
    testCase.value_assertion_enabled = normalizeVariableValueAssertionEnabled(testCase);
    testCase.comparison = normalizeVariableValueComparison(testCase.comparison);
    testCase.show_coerced_value_hint = Boolean(testCase.show_coerced_value_hint);
    testCase.list_assertions = getVariableListAssertions(testCase);
  } else if (testCase.type === 'function_state') {
    delete testCase.prompt_inputs;
    delete testCase.strict_prompt_inputs;
    testCase.parameter_count_enabled = normalizeFunctionParameterCountEnabled(testCase);
    testCase.parameter_count = asNonNegativeInteger(testCase.parameter_count);
    testCase.return_assertion = getFunctionReturnAssertion(testCase);
  } else if (testCase.type === 'file_state') {
    testCase.path = getFileStatePath(testCase);
    testCase.exists = testCase.exists !== false;
    testCase.format = normalizeFileStateFormat(testCase.format);
    testCase.content_assertion = getFileStateContentAssertion(testCase);
    testCase.csv_assertions = getFileStateCsvAssertions(testCase);
  }

  return testCase;
}

/**
 * Normalize all tests in an activity config in place.
 * @param {object} config
 * @returns {object}
 */
export function normalizeTestConfig(config) {
  if (!config?.evaluation?.test_cases || !Array.isArray(config.evaluation.test_cases)) {
    return config;
  }

  config.evaluation.test_cases.forEach(normalizeTestCase);
  return config;
}

function normalizeCsvRowCount(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : null;
}

function normalizeCsvCells(value) {
  if (!Array.isArray(value)) return [];

  return value
    .filter(isObjectLike)
    .map((entry) => ({
      row: asNonNegativeInteger(entry.row),
      column: asNonNegativeInteger(entry.column),
      ...(entry.expected_value !== undefined ? { expected_value: entry.expected_value } : {}),
      comparison: normalizeVariableValueComparison(entry.comparison),
      expected_type: normalizeVariableType(entry.expected_type),
    }));
}

function asNonNegativeInteger(value) {
  return Math.max(0, Math.trunc(Number(value) || 0));
}

function isObjectLike(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

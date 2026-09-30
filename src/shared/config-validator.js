/**
 * Config Validator — Validates activity_config objects for the Python activity
 * runtime.
 *
 * Hand-written, without a JSON Schema library dependency: it accumulates every
 * problem it finds (never throws) and reports each one as `{ path, message }`
 * so the builder can highlight the offending field by path. Structural rules
 * mirror activity-config.schema.json; the cross-field rules (a test that would
 * grade nothing, a condition tree that is not a tree) live only here.
 *
 * AST pattern *content* is not parsed: pattern validity needs the Python
 * matcher and is checked asynchronously by the builder before export.
 */

import {
  VALID_LIST_ITEM_TYPE_MODES,
  VALID_LIST_LENGTH_COMPARISONS,
  VALID_LIST_VALUE_MATCH_MODES,
  VALID_RUNTIME_EXECUTION_SCOPES,
  VALID_RUNTIME_TEXT_MATCH_MODES,
  VALID_VARIABLE_TYPES,
  getFunctionReturnAssertion,
  getStdoutExecutionContext,
  getStdoutOutputAssertion,
  getStdoutPromptAssertion,
  getTestPoints,
  getVariableListAssertions,
  hasEnabledListAssertion,
  hasEnabledStdoutAssertion,
  normalizeFunctionParameterCountEnabled,
  normalizeVariableType,
} from './test-config.js';

export const VALID_TEST_TYPES = [
  'stdout_match',
  'code_structure',
  'variable_state',
  'function_state',
  'file_state',
];
export const VALID_STDOUT_MATCH_MODES = VALID_RUNTIME_TEXT_MATCH_MODES;
export const VALID_VARIABLE_COMPARISONS = ['equals', 'gt', 'lt', 'gte', 'lte', 'contains'];
export const VALID_VARIABLE_TYPES_FOR_TESTS = VALID_VARIABLE_TYPES;
export const VALID_LIST_LENGTH_COMPARISONS_FOR_TESTS = VALID_LIST_LENGTH_COMPARISONS;
export const VALID_LIST_VALUE_MATCH_MODES_FOR_TESTS = VALID_LIST_VALUE_MATCH_MODES;
export const VALID_LIST_ITEM_TYPE_MODES_FOR_TESTS = VALID_LIST_ITEM_TYPE_MODES;
export const VALID_HINT_DISPLAY_MODES = ['triggered', 'checklist'];
export const VALID_HINT_STYLES = ['success', 'warning', 'error'];
export const VALID_CONDITION_TYPES = ['ast_pattern', 'source_regex', 'source_empty', 'all', 'any', 'none'];
export const VALID_HINT_EVENTS = ['code_change', 'test_fail', 'manual'];
export const VALID_PYTHON_PACKAGES = ['pillow'];
export const VALID_FILE_STATE_FORMATS = ['text', 'csv', 'binary'];
export const VALID_CSV_ROW_COUNT_COMPARISONS = VALID_LIST_LENGTH_COMPARISONS;
export const VALID_CSV_CELL_COMPARISONS = VALID_VARIABLE_COMPARISONS;
export const MAX_ACTIVITY_FILES = 50;
export const MAX_FILE_PATH_LENGTH = 256;
export const MAX_FILE_CONTENT_LENGTH = 262144;

const CONFIG_SECTIONS = ['metadata', 'instructions', 'ui_settings', 'python_setup', 'hints', 'evaluation'];
const METADATA_FIELDS = ['activity_id', 'title', 'version', 'description'];
const INSTRUCTIONS_FIELDS = ['main', 'steps'];
const UI_SETTINGS_FIELDS = ['show_hint_panel', 'suspend_data_limit'];
const PYTHON_SETUP_FIELDS = ['starter_code', 'files', 'packages', 'pyodide_base_url'];
const EVALUATION_FIELDS = ['feedback_on_all_pass', 'require_previous_test_pass', 'test_cases'];
const ACTIVITY_FILE_FIELDS = ['path', 'content', 'content_base64'];
const HINT_FIELDS = ['id', 'trigger', 'message', 'display_mode', 'priority', 'delay_seconds', 'show_once', 'style'];
const HINT_TRIGGER_FIELDS = ['event', 'conditions', 'after_attempts', 'invalidate_on_condition_false'];
const TEST_CASE_FIELDS = ['id', 'type', 'points', 'feedback_on_pass', 'feedback_on_fail'];
const PROMPT_INPUT_FIELDS = ['prompt_inputs', 'strict_prompt_inputs'];
const SETUP_FILE_FIELDS = ['setup_files'];
const TEXT_ASSERTION_FIELDS = [
  'enabled', 'expected', 'match_mode', 'show_expected', 'show_actual', 'success_message', 'failure_message',
];
const LIST_ASSERTION_FIELDS = [
  'length_enabled', 'length_value', 'length_comparison',
  'values_enabled', 'values_match_mode', 'expected_values',
  'item_types_enabled', 'item_type_mode', 'expected_item_types', 'index_checks',
];
const INDEX_CHECK_FIELDS = ['index', 'expected_value', 'expected_type'];
const RETURN_ASSERTION_FIELDS = [
  'enabled', 'arguments', 'expected_type', 'value_assertion_enabled', 'expected_value', 'comparison',
  'show_coerced_value_hint', 'show_expected', 'show_actual', 'success_message', 'failure_message',
  'list_assertions',
];
const CSV_ASSERTION_FIELDS = ['row_count', 'row_count_comparison', 'header', 'cells'];
const CSV_CELL_FIELDS = ['row', 'column', 'expected_value', 'comparison', 'expected_type'];
const EXECUTION_CONTEXT_FIELDS = ['scope', 'function_name', 'arguments'];

const TEST_CASE_FIELDS_BY_TYPE = {
  stdout_match: [
    ...TEST_CASE_FIELDS, ...PROMPT_INPUT_FIELDS,
    'output_assertion', 'prompt_assertion', 'execution_context', ...SETUP_FILE_FIELDS,
  ],
  code_structure: [...TEST_CASE_FIELDS, 'conditions'],
  variable_state: [
    ...TEST_CASE_FIELDS, ...PROMPT_INPUT_FIELDS, ...SETUP_FILE_FIELDS,
    'variable_name', 'expected_type', 'value_assertion_enabled', 'expected_value', 'comparison',
    'show_coerced_value_hint', 'list_assertions',
  ],
  function_state: [
    ...TEST_CASE_FIELDS, ...PROMPT_INPUT_FIELDS, ...SETUP_FILE_FIELDS,
    'function_name', 'parameter_count_enabled', 'parameter_count', 'return_assertion',
  ],
  file_state: [
    ...TEST_CASE_FIELDS, ...PROMPT_INPUT_FIELDS, ...SETUP_FILE_FIELDS,
    'path', 'exists', 'format', 'content_assertion', 'csv_assertions',
  ],
};

const CONDITION_FIELDS_BY_TYPE = {
  ast_pattern: ['type', 'pattern', 'min_count', 'max_count', 'strict'],
  source_regex: ['type', 'pattern', 'case_sensitive', 'regex_flags'],
  source_empty: ['type'],
  all: ['type', 'conditions'],
  any: ['type', 'conditions'],
  none: ['type', 'conditions'],
};

/**
 * @typedef {Object} ValidationError
 * @property {string} path - JSON path to the invalid field (e.g., "metadata.activity_id")
 * @property {string} message - Human-readable error description
 */

/**
 * Validate an activity config object.
 * @param {object} config - The config to validate
 * @returns {{ valid: boolean, errors: ValidationError[] }}
 */
export function validateConfig(config) {
  const errors = [];

  if (!config || typeof config !== 'object') {
    return { valid: false, errors: [{ path: '', message: 'Config must be a non-null object' }] };
  }

  rejectUnknownProperties(config, CONFIG_SECTIONS, '', errors);

  // metadata
  validateRequired(config, 'metadata', 'object', errors);
  if (config.metadata) {
    rejectUnknownProperties(config.metadata, METADATA_FIELDS, 'metadata', errors);
    validateRequired(config.metadata, 'activity_id', 'string', errors, 'metadata');
    validateRequired(config.metadata, 'title', 'string', errors, 'metadata');
    if (config.metadata.activity_id && !/^[a-z0-9_]+$/.test(config.metadata.activity_id)) {
      errors.push({
        path: 'metadata.activity_id',
        message: 'Must be lowercase alphanumeric with underscores only',
      });
    }
    if (config.metadata.version !== undefined && typeof config.metadata.version !== 'string') {
      errors.push({ path: 'metadata.version', message: 'Must be a string' });
    }
    if (config.metadata.description !== undefined && typeof config.metadata.description !== 'string') {
      errors.push({ path: 'metadata.description', message: 'Must be a string' });
    }
  }

  // instructions
  if (config.instructions !== undefined) {
    if (!isObjectLike(config.instructions)) {
      errors.push({ path: 'instructions', message: 'Must be an object' });
    } else {
      rejectUnknownProperties(config.instructions, INSTRUCTIONS_FIELDS, 'instructions', errors);
      if (config.instructions.main !== undefined && typeof config.instructions.main !== 'string') {
        errors.push({ path: 'instructions.main', message: 'Must be a string' });
      }
      if (config.instructions.steps !== undefined) {
        if (!Array.isArray(config.instructions.steps)) {
          errors.push({ path: 'instructions.steps', message: 'Must be an array' });
        } else if (config.instructions.steps.some((step) => typeof step !== 'string')) {
          errors.push({ path: 'instructions.steps', message: 'Must be an array of strings' });
        }
      }
    }
  }

  // ui_settings
  if (config.ui_settings !== undefined) {
    if (!isObjectLike(config.ui_settings)) {
      errors.push({ path: 'ui_settings', message: 'Must be an object' });
    } else {
      rejectUnknownProperties(config.ui_settings, UI_SETTINGS_FIELDS, 'ui_settings', errors);
      validateSuspendDataLimit(config.ui_settings.suspend_data_limit, 'ui_settings.suspend_data_limit', errors);
      if (config.ui_settings.show_hint_panel !== undefined && typeof config.ui_settings.show_hint_panel !== 'boolean') {
        errors.push({ path: 'ui_settings.show_hint_panel', message: 'Must be a boolean' });
      }
    }
  }

  // python_setup
  validateRequired(config, 'python_setup', 'object', errors);
  if (config.python_setup) {
    rejectUnknownProperties(config.python_setup, PYTHON_SETUP_FIELDS, 'python_setup', errors);
    if (config.python_setup.starter_code !== undefined && typeof config.python_setup.starter_code !== 'string') {
      errors.push({ path: 'python_setup.starter_code', message: 'Must be a string' });
    }
    if (config.python_setup.files !== undefined) {
      validateActivityFiles(
        config.python_setup.files,
        'python_setup.files',
        errors,
        { maxFiles: MAX_ACTIVITY_FILES },
      );
    }
    validatePackages(config.python_setup.packages, 'python_setup.packages', errors);
    validatePyodideBaseUrl(config.python_setup.pyodide_base_url, 'python_setup.pyodide_base_url', errors);
  }

  // evaluation
  validateRequired(config, 'evaluation', 'object', errors);
  if (config.evaluation) {
    rejectUnknownProperties(config.evaluation, EVALUATION_FIELDS, 'evaluation', errors);
    validateRequired(config.evaluation, 'test_cases', 'array', errors, 'evaluation');
    if (
      config.evaluation.feedback_on_all_pass !== undefined
      && typeof config.evaluation.feedback_on_all_pass !== 'string'
    ) {
      errors.push({
        path: 'evaluation.feedback_on_all_pass',
        message: 'Must be a string',
      });
    }
    if (
      config.evaluation.require_previous_test_pass !== undefined
      && typeof config.evaluation.require_previous_test_pass !== 'boolean'
    ) {
      errors.push({
        path: 'evaluation.require_previous_test_pass',
        message: 'Must be a boolean',
      });
    }
    if (Array.isArray(config.evaluation.test_cases)) {
      if (config.evaluation.test_cases.length === 0) {
        errors.push({ path: 'evaluation.test_cases', message: 'Must have at least one test case' });
      }
      config.evaluation.test_cases.forEach((tc, i) => {
        validateTestCase(tc, i, errors);
      });

      const totalPoints = config.evaluation.test_cases.reduce((sum, tc) => sum + getTestPoints(tc), 0);
      if (totalPoints <= 0 && config.evaluation.test_cases.length > 0) {
        errors.push({
          path: 'evaluation.test_cases',
          message: 'At least one test must award more than 0 points',
        });
      }
    }
  }

  // hints (optional but validate if present)
  if (config.hints !== undefined) {
    if (!Array.isArray(config.hints)) {
      errors.push({ path: 'hints', message: 'Must be an array' });
    } else {
      config.hints.forEach((hint, i) => {
        validateHint(hint, i, errors);
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate one test case.
 * @param {object} testCase
 * @param {number} [index]
 * @returns {{ valid: boolean, errors: ValidationError[] }}
 */
export function validateTestCaseConfig(testCase, index = 0) {
  const errors = [];
  validateTestCase(testCase, index, errors);
  return { valid: errors.length === 0, errors };
}

/**
 * Validate one hint.
 * @param {object} hint
 * @param {number} [index]
 * @returns {{ valid: boolean, errors: ValidationError[] }}
 */
export function validateHintConfig(hint, index = 0) {
  const errors = [];
  validateHint(hint, index, errors);
  return { valid: errors.length === 0, errors };
}

function validateRequired(obj, field, expectedType, errors, prefix = '') {
  const path = prefix ? `${prefix}.${field}` : field;
  if (obj[field] === undefined || obj[field] === null) {
    errors.push({ path, message: `Required field is missing` });
    return false;
  }
  if (expectedType === 'array') {
    if (!Array.isArray(obj[field])) {
      errors.push({ path, message: `Must be an array` });
      return false;
    }
  } else if (typeof obj[field] !== expectedType) {
    errors.push({ path, message: `Must be ${expectedType}, got ${typeof obj[field]}` });
    return false;
  }
  return true;
}

function validateRequiredString(obj, field, errors, prefix = '') {
  const path = prefix ? `${prefix}.${field}` : field;
  if (!validateRequired(obj, field, 'string', errors, prefix)) return false;
  if (obj[field].trim() === '') {
    errors.push({ path, message: 'Must not be empty' });
    return false;
  }
  return true;
}

function validateTestCase(tc, index, errors) {
  const prefix = `evaluation.test_cases[${index}]`;

  if (!isObjectLike(tc)) {
    errors.push({ path: prefix, message: 'Must be an object' });
    return;
  }

  validateRequiredString(tc, 'id', errors, prefix);
  validateRequiredString(tc, 'type', errors, prefix);

  if (tc.points === undefined || tc.points === null) {
    errors.push({ path: `${prefix}.points`, message: 'Required field is missing' });
  } else if (!Number.isInteger(tc.points) || tc.points < 0) {
    errors.push({ path: `${prefix}.points`, message: 'Must be an integer greater than or equal to 0' });
  }

  if (tc.feedback_on_pass !== undefined && typeof tc.feedback_on_pass !== 'string') {
    errors.push({ path: `${prefix}.feedback_on_pass`, message: 'Must be a string' });
  }
  if (tc.feedback_on_fail !== undefined && typeof tc.feedback_on_fail !== 'string') {
    errors.push({ path: `${prefix}.feedback_on_fail`, message: 'Must be a string' });
  }

  if (!tc.type) {
    // Without a type the type-specific field set is unknown, so only the
    // shared fields can be checked.
    rejectUnknownProperties(tc, TEST_CASE_FIELDS, prefix, errors);
    return;
  }
  if (!VALID_TEST_TYPES.includes(tc.type)) {
    errors.push({ path: `${prefix}.type`, message: `Must be one of: ${VALID_TEST_TYPES.join(', ')}` });
    // The type-specific field set is unknown, so nothing else can be checked.
    return;
  }

  rejectUnknownProperties(tc, TEST_CASE_FIELDS_BY_TYPE[tc.type], prefix, errors);

  // prompt queue shape; function_state keeps its own default and is not checked
  // against the plain string-array rule (ported from the Blockly validator).
  if (tc.type !== 'function_state' && tc.prompt_inputs !== undefined) {
    if (!Array.isArray(tc.prompt_inputs) || tc.prompt_inputs.some((value) => typeof value !== 'string')) {
      errors.push({ path: `${prefix}.prompt_inputs`, message: 'Must be an array of strings' });
    }
  }
  if (
    tc.type !== 'function_state'
    && tc.strict_prompt_inputs !== undefined
    && typeof tc.strict_prompt_inputs !== 'boolean'
  ) {
    errors.push({ path: `${prefix}.strict_prompt_inputs`, message: 'Must be a boolean' });
  }
  if (tc.setup_files !== undefined) {
    validateActivityFiles(tc.setup_files, `${prefix}.setup_files`, errors, { maxFiles: null });
  }

  if (tc.type === 'stdout_match') {
    validateTextAssertion(tc.output_assertion, `${prefix}.output_assertion`, errors, { allowMatchAnyItem: false });
    validateTextAssertion(tc.prompt_assertion, `${prefix}.prompt_assertion`, errors, { allowMatchAnyItem: true });
    validateRuntimeExecutionContext(tc.execution_context, `${prefix}.execution_context`, errors);

    if (!hasEnabledStdoutAssertion(tc)) {
      errors.push({
        path: prefix,
        message: 'stdout_match must enable output_assertion, prompt_assertion, or both',
      });
    }

    const outputAssertion = getStdoutOutputAssertion(tc);
    if (outputAssertion.enabled && typeof outputAssertion.expected !== 'string') {
      errors.push({ path: `${prefix}.output_assertion.expected`, message: 'Must be a string' });
    }

    const promptAssertion = getStdoutPromptAssertion(tc);
    if (promptAssertion.enabled && typeof promptAssertion.expected !== 'string') {
      errors.push({ path: `${prefix}.prompt_assertion.expected`, message: 'Must be a string' });
    }

    const executionContext = getStdoutExecutionContext(tc);
    if (executionContext.scope === 'function' && executionContext.function_name.trim() === '') {
      errors.push({
        path: `${prefix}.execution_context.function_name`,
        message: 'Required when execution_context.scope is "function"',
      });
    }
  } else if (tc.type === 'code_structure') {
    if (tc.conditions === undefined) {
      errors.push({ path: `${prefix}.conditions`, message: 'Required for code_structure test type' });
    } else {
      validateCondition(tc.conditions, `${prefix}.conditions`, errors);
    }
  } else if (tc.type === 'variable_state') {
    validateRequiredString(tc, 'variable_name', errors, prefix);
    if (
      tc.expected_type !== undefined
      && !VALID_VARIABLE_TYPES_FOR_TESTS.includes(String(tc.expected_type))
    ) {
      errors.push({
        path: `${prefix}.expected_type`,
        message: `Must be one of: ${VALID_VARIABLE_TYPES_FOR_TESTS.join(', ')}`,
      });
    }
    if (tc.value_assertion_enabled !== undefined && typeof tc.value_assertion_enabled !== 'boolean') {
      errors.push({ path: `${prefix}.value_assertion_enabled`, message: 'Must be a boolean' });
    }
    if (tc.show_coerced_value_hint !== undefined && typeof tc.show_coerced_value_hint !== 'boolean') {
      errors.push({ path: `${prefix}.show_coerced_value_hint`, message: 'Must be a boolean' });
    }
    if (tc.comparison && !VALID_VARIABLE_COMPARISONS.includes(tc.comparison)) {
      errors.push({ path: `${prefix}.comparison`, message: 'Invalid comparison operator' });
    }

    validateVariableListAssertions(tc.list_assertions, `${prefix}.list_assertions`, errors);

    const expectsListChecks = hasEnabledListAssertion(tc);
    const valueAssertionEnabled = tc.value_assertion_enabled === undefined
      ? tc.expected_value !== undefined
      : Boolean(tc.value_assertion_enabled);
    const typeAssertionEnabled = normalizeVariableType(tc.expected_type) !== 'any';

    if (valueAssertionEnabled && tc.expected_value === undefined) {
      errors.push({
        path: `${prefix}.expected_value`,
        message: 'Required when value_assertion_enabled is true',
      });
    }
    if (!valueAssertionEnabled && !typeAssertionEnabled && !expectsListChecks) {
      errors.push({
        path: prefix,
        message: 'variable_state must enable a value assertion, a type assertion, or a list assertion',
      });
    }
  } else if (tc.type === 'function_state') {
    validateRequiredString(tc, 'function_name', errors, prefix);
    if (tc.parameter_count_enabled !== undefined && typeof tc.parameter_count_enabled !== 'boolean') {
      errors.push({ path: `${prefix}.parameter_count_enabled`, message: 'Must be a boolean' });
    }
    if (tc.parameter_count !== undefined && (!Number.isInteger(tc.parameter_count) || tc.parameter_count < 0)) {
      errors.push({ path: `${prefix}.parameter_count`, message: 'Must be a non-negative integer' });
    }

    validateFunctionReturnAssertion(tc.return_assertion, `${prefix}.return_assertion`, errors);

    if (normalizeFunctionParameterCountEnabled(tc) && tc.parameter_count === undefined) {
      errors.push({
        path: `${prefix}.parameter_count`,
        message: 'Required when parameter_count_enabled is true',
      });
    }
    if (!normalizeFunctionParameterCountEnabled(tc) && !getFunctionReturnAssertion(tc).enabled) {
      errors.push({
        path: prefix,
        message: 'function_state must enable parameter_count or a return assertion',
      });
    }
  } else if (tc.type === 'file_state') {
    validateRequiredString(tc, 'path', errors, prefix);
    if (tc.exists !== undefined && typeof tc.exists !== 'boolean') {
      errors.push({ path: `${prefix}.exists`, message: 'Must be a boolean' });
    }
    if (tc.format !== undefined && !VALID_FILE_STATE_FORMATS.includes(tc.format)) {
      errors.push({
        path: `${prefix}.format`,
        message: `Must be one of: ${VALID_FILE_STATE_FORMATS.join(', ')}`,
      });
    }
    validateTextAssertion(tc.content_assertion, `${prefix}.content_assertion`, errors, { allowMatchAnyItem: false });
    validateCsvAssertions(tc.csv_assertions, `${prefix}.csv_assertions`, errors);

    const format = VALID_FILE_STATE_FORMATS.includes(tc.format) ? tc.format : 'text';
    if (format !== 'text' && isObjectLike(tc.content_assertion) && Boolean(tc.content_assertion.enabled)) {
      errors.push({
        path: `${prefix}.content_assertion`,
        message: 'Only supported when format is "text"',
      });
    }
  }
}

function validateTextAssertion(assertion, path, errors, { allowMatchAnyItem }) {
  if (assertion === undefined) return;

  if (!isObjectLike(assertion)) {
    errors.push({ path, message: 'Must be an object' });
    return;
  }

  rejectUnknownProperties(
    assertion,
    allowMatchAnyItem ? [...TEXT_ASSERTION_FIELDS, 'match_any_item'] : TEXT_ASSERTION_FIELDS,
    path,
    errors,
  );

  if (assertion.enabled !== undefined && typeof assertion.enabled !== 'boolean') {
    errors.push({ path: `${path}.enabled`, message: 'Must be a boolean' });
  }
  if (assertion.expected !== undefined && typeof assertion.expected !== 'string') {
    errors.push({ path: `${path}.expected`, message: 'Must be a string' });
  }
  if (
    assertion.match_mode !== undefined
    && !VALID_STDOUT_MATCH_MODES.includes(assertion.match_mode)
  ) {
    errors.push({
      path: `${path}.match_mode`,
      message: 'Must be exact, contains, or regex',
    });
  }
  if (assertion.match_any_item !== undefined && typeof assertion.match_any_item !== 'boolean') {
    errors.push({ path: `${path}.match_any_item`, message: 'Must be a boolean' });
  }
  if (assertion.show_expected !== undefined && typeof assertion.show_expected !== 'boolean') {
    errors.push({ path: `${path}.show_expected`, message: 'Must be a boolean' });
  }
  if (assertion.show_actual !== undefined && typeof assertion.show_actual !== 'boolean') {
    errors.push({ path: `${path}.show_actual`, message: 'Must be a boolean' });
  }
  if (assertion.success_message !== undefined && typeof assertion.success_message !== 'string') {
    errors.push({ path: `${path}.success_message`, message: 'Must be a string' });
  }
  if (assertion.failure_message !== undefined && typeof assertion.failure_message !== 'string') {
    errors.push({ path: `${path}.failure_message`, message: 'Must be a string' });
  }
}

function validateRuntimeExecutionContext(executionContext, path, errors) {
  if (executionContext === undefined) return;

  if (!isObjectLike(executionContext)) {
    errors.push({ path, message: 'Must be an object' });
    return;
  }

  rejectUnknownProperties(executionContext, EXECUTION_CONTEXT_FIELDS, path, errors);

  if (
    executionContext.scope !== undefined
    && !VALID_RUNTIME_EXECUTION_SCOPES.includes(executionContext.scope)
  ) {
    errors.push({
      path: `${path}.scope`,
      message: `Must be one of: ${VALID_RUNTIME_EXECUTION_SCOPES.join(', ')}`,
    });
  }

  const normalizedScope = getStdoutExecutionContext({ execution_context: executionContext }).scope;
  if (executionContext.function_name !== undefined && typeof executionContext.function_name !== 'string') {
    errors.push({ path: `${path}.function_name`, message: 'Must be a string' });
  }
  if (executionContext.arguments !== undefined && !Array.isArray(executionContext.arguments)) {
    errors.push({ path: `${path}.arguments`, message: 'Must be an array' });
  }
  if (normalizedScope === 'function' && executionContext.arguments === undefined) {
    errors.push({
      path: `${path}.arguments`,
      message: 'Required when execution_context.scope is "function"',
    });
  }
}

function validateVariableListAssertions(assertions, path, errors) {
  if (assertions === undefined) return;
  if (!isObjectLike(assertions)) {
    errors.push({ path, message: 'Must be an object' });
    return;
  }

  rejectUnknownProperties(assertions, LIST_ASSERTION_FIELDS, path, errors);

  if (assertions.length_enabled !== undefined && typeof assertions.length_enabled !== 'boolean') {
    errors.push({ path: `${path}.length_enabled`, message: 'Must be a boolean' });
  }
  if (assertions.length_value !== undefined && (!Number.isInteger(assertions.length_value) || assertions.length_value < 0)) {
    errors.push({ path: `${path}.length_value`, message: 'Must be a non-negative integer' });
  }
  if (
    assertions.length_comparison !== undefined
    && !VALID_LIST_LENGTH_COMPARISONS_FOR_TESTS.includes(assertions.length_comparison)
  ) {
    errors.push({
      path: `${path}.length_comparison`,
      message: `Must be one of: ${VALID_LIST_LENGTH_COMPARISONS_FOR_TESTS.join(', ')}`,
    });
  }
  if (assertions.values_enabled !== undefined && typeof assertions.values_enabled !== 'boolean') {
    errors.push({ path: `${path}.values_enabled`, message: 'Must be a boolean' });
  }
  if (
    assertions.values_match_mode !== undefined
    && !VALID_LIST_VALUE_MATCH_MODES_FOR_TESTS.includes(assertions.values_match_mode)
  ) {
    errors.push({
      path: `${path}.values_match_mode`,
      message: `Must be one of: ${VALID_LIST_VALUE_MATCH_MODES_FOR_TESTS.join(', ')}`,
    });
  }
  if (assertions.expected_values !== undefined && !Array.isArray(assertions.expected_values)) {
    errors.push({ path: `${path}.expected_values`, message: 'Must be an array' });
  }
  if (assertions.item_types_enabled !== undefined && typeof assertions.item_types_enabled !== 'boolean') {
    errors.push({ path: `${path}.item_types_enabled`, message: 'Must be a boolean' });
  }
  if (
    assertions.item_type_mode !== undefined
    && !VALID_LIST_ITEM_TYPE_MODES_FOR_TESTS.includes(assertions.item_type_mode)
  ) {
    errors.push({
      path: `${path}.item_type_mode`,
      message: `Must be one of: ${VALID_LIST_ITEM_TYPE_MODES_FOR_TESTS.join(', ')}`,
    });
  }
  if (assertions.expected_item_types !== undefined) {
    if (!Array.isArray(assertions.expected_item_types)) {
      errors.push({ path: `${path}.expected_item_types`, message: 'Must be an array' });
    } else if (assertions.expected_item_types.some((type) => (
      !VALID_VARIABLE_TYPES_FOR_TESTS.includes(String(type)) || String(type) === 'any'
    ))) {
      errors.push({
        path: `${path}.expected_item_types`,
        message: `Entries must be one of: ${VALID_VARIABLE_TYPES_FOR_TESTS.filter((type) => type !== 'any').join(', ')}`,
      });
    }
  }

  if (assertions.index_checks !== undefined) {
    if (!Array.isArray(assertions.index_checks)) {
      errors.push({ path: `${path}.index_checks`, message: 'Must be an array' });
    } else {
      assertions.index_checks.forEach((check, index) => {
        const checkPath = `${path}.index_checks[${index}]`;
        if (!isObjectLike(check)) {
          errors.push({ path: checkPath, message: 'Must be an object' });
          return;
        }
        rejectUnknownProperties(check, INDEX_CHECK_FIELDS, checkPath, errors);
        if (!Number.isInteger(check.index) || check.index < 0) {
          errors.push({ path: `${checkPath}.index`, message: 'Must be a non-negative integer' });
        }
        if (
          check.expected_type !== undefined
          && !VALID_VARIABLE_TYPES_FOR_TESTS.includes(String(check.expected_type))
        ) {
          errors.push({
            path: `${checkPath}.expected_type`,
            message: `Must be one of: ${VALID_VARIABLE_TYPES_FOR_TESTS.join(', ')}`,
          });
        }
        if (check.expected_value === undefined && normalizeVariableType(check.expected_type) === 'any') {
          errors.push({
            path: checkPath,
            message: 'Each index check must define expected_value, expected_type, or both',
          });
        }
      });
    }
  }

  const normalized = getVariableListAssertions({ list_assertions: assertions });
  if (normalized.values_enabled && normalized.expected_values.length === 0) {
    errors.push({
      path: `${path}.expected_values`,
      message: 'Provide at least one expected list value when values_enabled is true',
    });
  }
  if (normalized.item_types_enabled && normalized.expected_item_types.length === 0) {
    errors.push({
      path: `${path}.expected_item_types`,
      message: 'Provide at least one expected item type when item_types_enabled is true',
    });
  }
}

function validateFunctionReturnAssertion(assertion, path, errors) {
  if (assertion === undefined) return;

  if (!isObjectLike(assertion)) {
    errors.push({ path, message: 'Must be an object' });
    return;
  }

  rejectUnknownProperties(assertion, RETURN_ASSERTION_FIELDS, path, errors);

  if (assertion.enabled !== undefined && typeof assertion.enabled !== 'boolean') {
    errors.push({ path: `${path}.enabled`, message: 'Must be a boolean' });
  }
  if (assertion.arguments !== undefined && !Array.isArray(assertion.arguments)) {
    errors.push({ path: `${path}.arguments`, message: 'Must be an array' });
  }
  if (
    assertion.expected_type !== undefined
    && !VALID_VARIABLE_TYPES_FOR_TESTS.includes(String(assertion.expected_type))
  ) {
    errors.push({
      path: `${path}.expected_type`,
      message: `Must be one of: ${VALID_VARIABLE_TYPES_FOR_TESTS.join(', ')}`,
    });
  }
  if (assertion.value_assertion_enabled !== undefined && typeof assertion.value_assertion_enabled !== 'boolean') {
    errors.push({ path: `${path}.value_assertion_enabled`, message: 'Must be a boolean' });
  }
  if (assertion.show_coerced_value_hint !== undefined && typeof assertion.show_coerced_value_hint !== 'boolean') {
    errors.push({ path: `${path}.show_coerced_value_hint`, message: 'Must be a boolean' });
  }
  if (assertion.show_expected !== undefined && typeof assertion.show_expected !== 'boolean') {
    errors.push({ path: `${path}.show_expected`, message: 'Must be a boolean' });
  }
  if (assertion.show_actual !== undefined && typeof assertion.show_actual !== 'boolean') {
    errors.push({ path: `${path}.show_actual`, message: 'Must be a boolean' });
  }
  if (assertion.success_message !== undefined && typeof assertion.success_message !== 'string') {
    errors.push({ path: `${path}.success_message`, message: 'Must be a string' });
  }
  if (assertion.failure_message !== undefined && typeof assertion.failure_message !== 'string') {
    errors.push({ path: `${path}.failure_message`, message: 'Must be a string' });
  }
  if (assertion.comparison !== undefined && !VALID_VARIABLE_COMPARISONS.includes(assertion.comparison)) {
    errors.push({ path: `${path}.comparison`, message: 'Invalid comparison operator' });
  }

  validateVariableListAssertions(assertion.list_assertions, `${path}.list_assertions`, errors);

  const normalized = getFunctionReturnAssertion({ return_assertion: assertion });
  const expectsListChecks = hasEnabledListAssertion(normalized);
  const valueAssertionEnabled = normalized.value_assertion_enabled;
  const typeAssertionEnabled = normalizeVariableType(normalized.expected_type) !== 'any';

  if (normalized.enabled && valueAssertionEnabled && normalized.expected_value === undefined) {
    errors.push({
      path: `${path}.expected_value`,
      message: 'Required when value_assertion_enabled is true',
    });
  }
  if (normalized.enabled && !valueAssertionEnabled && !typeAssertionEnabled && !expectsListChecks) {
    errors.push({
      path,
      message: 'return_assertion must enable a value assertion, a type assertion, or a list assertion',
    });
  }
}

function validateCsvAssertions(csvAssertions, path, errors) {
  if (csvAssertions === undefined) return;

  if (!isObjectLike(csvAssertions)) {
    errors.push({ path, message: 'Must be an object' });
    return;
  }

  rejectUnknownProperties(csvAssertions, CSV_ASSERTION_FIELDS, path, errors);

  if (csvAssertions.row_count !== undefined && (!Number.isInteger(csvAssertions.row_count) || csvAssertions.row_count < 0)) {
    errors.push({ path: `${path}.row_count`, message: 'Must be a non-negative integer' });
  }
  if (
    csvAssertions.row_count_comparison !== undefined
    && !VALID_CSV_ROW_COUNT_COMPARISONS.includes(csvAssertions.row_count_comparison)
  ) {
    errors.push({
      path: `${path}.row_count_comparison`,
      message: `Must be one of: ${VALID_CSV_ROW_COUNT_COMPARISONS.join(', ')}`,
    });
  }
  if (csvAssertions.header !== undefined) {
    if (!Array.isArray(csvAssertions.header)) {
      errors.push({ path: `${path}.header`, message: 'Must be an array' });
    } else if (csvAssertions.header.some((cell) => typeof cell !== 'string')) {
      errors.push({ path: `${path}.header`, message: 'Must be an array of strings' });
    }
  }

  if (csvAssertions.cells !== undefined) {
    if (!Array.isArray(csvAssertions.cells)) {
      errors.push({ path: `${path}.cells`, message: 'Must be an array' });
      return;
    }
    csvAssertions.cells.forEach((cell, index) => {
      const cellPath = `${path}.cells[${index}]`;
      if (!isObjectLike(cell)) {
        errors.push({ path: cellPath, message: 'Must be an object' });
        return;
      }
      rejectUnknownProperties(cell, CSV_CELL_FIELDS, cellPath, errors);
      if (!Number.isInteger(cell.row) || cell.row < 0) {
        errors.push({ path: `${cellPath}.row`, message: 'Must be a non-negative integer' });
      }
      if (!Number.isInteger(cell.column) || cell.column < 0) {
        errors.push({ path: `${cellPath}.column`, message: 'Must be a non-negative integer' });
      }
      if (cell.comparison !== undefined && !VALID_CSV_CELL_COMPARISONS.includes(cell.comparison)) {
        errors.push({ path: `${cellPath}.comparison`, message: 'Invalid comparison operator' });
      }
      if (
        cell.expected_type !== undefined
        && !VALID_VARIABLE_TYPES_FOR_TESTS.includes(String(cell.expected_type))
      ) {
        errors.push({
          path: `${cellPath}.expected_type`,
          message: `Must be one of: ${VALID_VARIABLE_TYPES_FOR_TESTS.join(', ')}`,
        });
      }
      if (cell.expected_value === undefined && normalizeVariableType(cell.expected_type) === 'any') {
        errors.push({
          path: cellPath,
          message: 'Each cell check must define expected_value, expected_type, or both',
        });
      }
    });
  }
}

function validateCondition(condition, path, errors) {
  if (!condition || typeof condition !== 'object') {
    errors.push({ path, message: 'Condition must be an object' });
    return;
  }

  if (!VALID_CONDITION_TYPES.includes(condition.type)) {
    errors.push({ path: `${path}.type`, message: `Unknown condition type '${String(condition.type)}'` });
    return;
  }

  rejectUnknownProperties(condition, CONDITION_FIELDS_BY_TYPE[condition.type], path, errors);

  if (condition.type === 'ast_pattern') {
    validateRequiredString(condition, 'pattern', errors, path);
    if (condition.min_count !== undefined && (!Number.isInteger(condition.min_count) || condition.min_count < 1)) {
      errors.push({ path: `${path}.min_count`, message: 'Must be an integer of at least 1' });
    }
    if (condition.max_count !== undefined) {
      if (!Number.isInteger(condition.max_count) || condition.max_count < 1) {
        errors.push({ path: `${path}.max_count`, message: 'Must be an integer of at least 1' });
      } else {
        const minCount = Number.isInteger(condition.min_count) ? condition.min_count : 1;
        if (condition.max_count < minCount) {
          errors.push({ path: `${path}.max_count`, message: 'Must be greater than or equal to min_count' });
        }
      }
    }
    if (condition.strict !== undefined && typeof condition.strict !== 'boolean') {
      errors.push({ path: `${path}.strict`, message: 'Must be a boolean' });
    }
  } else if (condition.type === 'source_regex') {
    validateRequired(condition, 'pattern', 'string', errors, path);
    validateCaseSensitive(condition.case_sensitive, `${path}.case_sensitive`, errors);
    if (condition.regex_flags !== undefined) {
      if (typeof condition.regex_flags !== 'string') {
        errors.push({ path: `${path}.regex_flags`, message: 'Must be a string' });
      } else if (!isValidRegexFlags(condition.regex_flags)) {
        errors.push({ path: `${path}.regex_flags`, message: 'May only contain the letters i, m and s' });
      }
    }
  } else if (['all', 'any', 'none'].includes(condition.type)) {
    if (!Array.isArray(condition.conditions) || condition.conditions.length === 0) {
      errors.push({ path: `${path}.conditions`, message: 'Composite condition requires a non-empty conditions array' });
    } else {
      condition.conditions.forEach((child, i) => {
        validateCondition(child, `${path}.conditions[${i}]`, errors);
      });
    }
  }
}

function validateHint(hint, index, errors) {
  const prefix = `hints[${index}]`;

  if (!isObjectLike(hint)) {
    errors.push({ path: prefix, message: 'Must be an object' });
    return;
  }

  rejectUnknownProperties(hint, HINT_FIELDS, prefix, errors);

  validateRequiredString(hint, 'id', errors, prefix);
  validateRequiredString(hint, 'message', errors, prefix);
  validateRequired(hint, 'trigger', 'object', errors, prefix);

  if (hint.display_mode !== undefined && !VALID_HINT_DISPLAY_MODES.includes(hint.display_mode)) {
    errors.push({
      path: `${prefix}.display_mode`,
      message: `Must be one of: ${VALID_HINT_DISPLAY_MODES.join(', ')}`,
    });
  }
  if (hint.priority !== undefined && (!Number.isInteger(hint.priority) || hint.priority < 1)) {
    errors.push({ path: `${prefix}.priority`, message: 'Must be an integer of at least 1' });
  }
  if (hint.delay_seconds !== undefined && (!Number.isInteger(hint.delay_seconds) || hint.delay_seconds < 0)) {
    errors.push({ path: `${prefix}.delay_seconds`, message: 'Must be a non-negative integer' });
  }
  if (hint.show_once !== undefined && typeof hint.show_once !== 'boolean') {
    errors.push({ path: `${prefix}.show_once`, message: 'Must be a boolean' });
  }
  if (hint.style !== undefined && hint.style !== '' && !VALID_HINT_STYLES.includes(hint.style)) {
    errors.push({
      path: `${prefix}.style`,
      message: `Must be one of: ${VALID_HINT_STYLES.join(', ')}`,
    });
  }

  if (hint.trigger) {
    rejectUnknownProperties(hint.trigger, HINT_TRIGGER_FIELDS, `${prefix}.trigger`, errors);

    if (!VALID_HINT_EVENTS.includes(hint.trigger.event)) {
      errors.push({
        path: `${prefix}.trigger.event`,
        message: `Must be one of: ${VALID_HINT_EVENTS.join(', ')}`,
      });
    } else if (hint.trigger.event === 'code_change' && hint.trigger.conditions === undefined) {
      errors.push({
        path: `${prefix}.trigger.conditions`,
        message: 'Required for code_change hints',
      });
    }

    if (
      hint.trigger.after_attempts !== undefined
      && (!Number.isInteger(hint.trigger.after_attempts) || hint.trigger.after_attempts < 0)
    ) {
      errors.push({
        path: `${prefix}.trigger.after_attempts`,
        message: 'Must be a non-negative integer',
      });
    }
    if (
      hint.trigger.invalidate_on_condition_false !== undefined
      && typeof hint.trigger.invalidate_on_condition_false !== 'boolean'
    ) {
      errors.push({
        path: `${prefix}.trigger.invalidate_on_condition_false`,
        message: 'Must be a boolean',
      });
    }
    if (hint.trigger.conditions !== undefined) {
      validateCondition(hint.trigger.conditions, `${prefix}.trigger.conditions`, errors);
    }
  }
}

function validateActivityFiles(files, path, errors, { maxFiles }) {
  if (!Array.isArray(files)) {
    errors.push({ path, message: 'Must be an array' });
    return;
  }
  if (maxFiles !== null && files.length > maxFiles) {
    errors.push({ path, message: `Must contain at most ${maxFiles} files` });
  }
  files.forEach((file, index) => {
    validateActivityFile(file, `${path}[${index}]`, errors);
  });
}

function validateActivityFile(file, path, errors) {
  if (!isObjectLike(file)) {
    errors.push({ path, message: 'Must be an object' });
    return;
  }

  rejectUnknownProperties(file, ACTIVITY_FILE_FIELDS, path, errors);

  const hasContent = file.content !== undefined;
  const hasBase64 = file.content_base64 !== undefined;
  if (hasContent && hasBase64) {
    errors.push({ path, message: 'Provide either content or content_base64, not both' });
  } else if (!hasContent && !hasBase64) {
    errors.push({ path, message: 'Provide content or content_base64' });
  }

  if (file.path === undefined || file.path === null) {
    errors.push({ path: `${path}.path`, message: 'Required field is missing' });
  } else if (typeof file.path !== 'string') {
    errors.push({ path: `${path}.path`, message: `Must be string, got ${typeof file.path}` });
  } else if (file.path.trim() === '') {
    errors.push({ path: `${path}.path`, message: 'Must not be empty' });
  } else {
    validateFilePath(file.path, `${path}.path`, errors);
  }

  validateFileContent(file.content, `${path}.content`, errors);
  validateFileContent(file.content_base64, `${path}.content_base64`, errors);
}

function validateFilePath(filePath, path, errors) {
  if (filePath.length > MAX_FILE_PATH_LENGTH) {
    errors.push({ path, message: `Must be ${MAX_FILE_PATH_LENGTH} characters or fewer` });
  }
  if (!/^[A-Za-z0-9_./-]+$/.test(filePath)) {
    errors.push({ path, message: 'Must contain only letters, digits, "_", ".", "/" and "-"' });
  }
  if (filePath.startsWith('/')) {
    errors.push({ path, message: 'Must be a relative path (no leading "/")' });
  }
  if (filePath.split('/').includes('..')) {
    errors.push({ path, message: 'Must not contain ".." segments' });
  }
}

function validateFileContent(content, path, errors) {
  if (content === undefined) return;
  if (typeof content !== 'string') {
    errors.push({ path, message: 'Must be a string' });
    return;
  }
  if (content.length > MAX_FILE_CONTENT_LENGTH) {
    errors.push({ path, message: `Must be ${MAX_FILE_CONTENT_LENGTH} characters or fewer` });
  }
}

function validatePackages(packages, path, errors) {
  if (packages === undefined) return;
  if (!Array.isArray(packages)) {
    errors.push({ path, message: 'Must be an array' });
    return;
  }
  packages.forEach((name, index) => {
    if (!VALID_PYTHON_PACKAGES.includes(name)) {
      errors.push({
        path: `${path}[${index}]`,
        message: `Must be one of: ${VALID_PYTHON_PACKAGES.join(', ')}`,
      });
    }
  });
}

function validatePyodideBaseUrl(value, path, errors) {
  if (value === undefined) return;
  if (typeof value !== 'string') {
    errors.push({ path, message: 'Must be a string' });
    return;
  }
  if (value.trim() === '') return;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    errors.push({ path, message: 'Must be an absolute http(s) URL' });
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    errors.push({ path, message: 'Must be an absolute http(s) URL' });
  }
}

/**
 * Validate the optional suspend data character budget.
 * @param {*} value
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateSuspendDataLimit(value, path, errors) {
  if (value === undefined || value === null) return;

  if (!Number.isInteger(value) || value < 512) {
    errors.push({
      path,
      message: 'Must be an integer of at least 512 characters',
    });
  }
}

function validateCaseSensitive(value, path, errors) {
  if (value !== undefined && typeof value !== 'boolean') {
    errors.push({ path, message: 'Must be a boolean' });
  }
}

function isValidRegexFlags(flags) {
  return flags.split('').every((flag) => 'ims'.includes(flag))
    && new Set(flags.split('')).size === flags.length;
}

/**
 * Report every key the schema does not define.
 *
 * Legacy aliases (weight, expected_output, top-level match_mode, …) reach here
 * as unknown properties so a hand-edited or imported config fails loudly
 * instead of silently grading something else.
 * @param {object} value
 * @param {string[]} allowedKeys
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function rejectUnknownProperties(value, allowedKeys, path, errors) {
  if (!isObjectLike(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      errors.push({
        path: path ? `${path}.${key}` : key,
        message: `Unknown property "${key}"`,
      });
    }
  }
}

function isObjectLike(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Config normalization — the boundary every activity config crosses twice:
 * once on the way in (a hand-written, legacy or half-edited config becoming a
 * builder draft) and once on the way out (that draft becoming the payload
 * exported to JSON and to a SCORM package).
 *
 * Both directions rebuild the config from a whitelist of known fields, so a key
 * written by an older schema, or typed into the wrong section, disappears down
 * the same code path that fills in a missing default. The two directions differ
 * in how much they fill in: a draft is editable and therefore complete (every
 * field the builder or runtime reads has a value), while an export stays
 * minimal and drops items too incomplete to grade.
 *
 * Values the schema rejects — an out-of-range suspend_data_limit, an unknown
 * condition type, a malformed regex — are kept readable in the draft so the
 * author can see what they wrote; `validateConfig` reports them on export.
 */

import {
  VALID_CONDITION_TYPES,
  VALID_HINT_DISPLAY_MODES,
  VALID_HINT_EVENTS,
  VALID_PYTHON_PACKAGES,
  VALID_TEST_TYPES,
  VALID_VARIABLE_COMPARISONS,
  validateHintConfig,
  validateTestCaseConfig,
} from './config-validator.js';
import {
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
  normalizeFileStateFormat,
  normalizeFunctionParameterCountEnabled,
  normalizeVariableType,
  normalizeVariableValueAssertionEnabled,
  shouldEnforcePromptInputCount,
} from './test-config.js';

/** SCORM 1.2 specifies 4096 characters for cmi.suspend_data. */
export const SUSPEND_DATA_DEFAULT_LIMIT = 4096;

/** The only characters `source_regex.regex_flags` may carry, in canonical order. */
const VALID_REGEX_FLAGS = ['i', 'm', 's'];

/** A test or hint authored against a type this activity engine no longer knows. */
const DEFAULT_TEST_TYPE = 'stdout_match';
const DEFAULT_HINT_EVENT = 'code_change';
const DEFAULT_CONDITION = Object.freeze({ type: 'source_empty' });
const DEFAULT_VARIABLE_COMPARISON = 'equals';
const DEFAULT_HINT_DISPLAY_MODE = 'checklist';

/**
 * Normalize an arbitrary config object into a complete config: every documented
 * field is present with a usable value and every unknown key is gone. This is
 * the runtime's entry point — after it, no reader needs a fallback.
 * @param {object} rawConfig
 * @returns {object} The normalized config.
 */
export function normalizeConfig(rawConfig) {
  const source = cloneConfig(rawConfig);
  const config = createBaseConfig(source);

  config.hints = asObjectList(source.hints).map(normalizeDraftHint);
  config.evaluation.test_cases = asObjectList(source?.evaluation?.test_cases)
    .map(normalizeDraftTestCase);

  return config;
}

/**
 * Normalize an arbitrary config object into a builder-safe draft shape.
 * Missing or malformed nested values are replaced with editable defaults so a
 * partially edited draft can always be reopened in the builder.
 * @param {object} rawConfig
 * @returns {{ config: object }}
 */
export function normalizeBuilderDraftConfig(rawConfig) {
  return { config: normalizeConfig(rawConfig) };
}

/**
 * Prepare a config export payload by omitting incomplete optional items while
 * preserving valid data in a publishable shape.
 * @param {object} rawConfig
 * @returns {{ config: object, omissions: { hints: number, tests: number } }}
 */
export function sanitizeConfigForExport(rawConfig) {
  const source = cloneConfig(rawConfig);
  const config = createBaseConfig(source);
  const omissions = { hints: 0, tests: 0 };

  const publishHints = asObjectList(source.hints).map(normalizePublishHint);
  config.hints = publishHints.filter((hint, index) => {
    const valid = validateHintConfig(hint, index).valid;
    if (!valid) omissions.hints += 1;
    return valid;
  });

  const publishTests = asObjectList(source?.evaluation?.test_cases).map(normalizePublishTestCase);
  config.evaluation.test_cases = publishTests.filter((testCase, index) => {
    const valid = validateTestCaseConfig(testCase, index).valid;
    if (!valid) omissions.tests += 1;
    return valid;
  });

  return { config, omissions };
}

export const sanitizeConfigForScorm = sanitizeConfigForExport;

function createBaseConfig(source) {
  const metadata = isObjectLike(source.metadata) ? source.metadata : {};
  const instructions = isObjectLike(source.instructions) ? source.instructions : {};
  const uiSettings = isObjectLike(source.ui_settings) ? source.ui_settings : {};
  const pythonSetup = isObjectLike(source.python_setup) ? source.python_setup : {};
  const evaluation = isObjectLike(source.evaluation) ? source.evaluation : {};

  return {
    metadata: {
      activity_id: asStringOr(metadata.activity_id, ''),
      title: asStringOr(metadata.title, ''),
      version: asStringOr(metadata.version, '1.0'),
      description: asStringOr(metadata.description, ''),
    },
    instructions: {
      main: asStringOr(instructions.main, ''),
      steps: Array.isArray(instructions.steps)
        ? instructions.steps
          .filter((step) => step !== undefined && step !== null)
          .map((step) => String(step))
        : [],
    },
    ui_settings: {
      show_hint_panel: uiSettings.show_hint_panel !== false,
      // SCORM 1.2 specifies 4096 characters for cmi.suspend_data.
      suspend_data_limit: asOptionalInteger(uiSettings.suspend_data_limit, SUSPEND_DATA_DEFAULT_LIMIT)
        ?? SUSPEND_DATA_DEFAULT_LIMIT,
    },
    python_setup: {
      starter_code: asStringOr(pythonSetup.starter_code, ''),
      files: normalizeActivityFiles(pythonSetup.files),
      packages: Array.isArray(pythonSetup.packages)
        ? pythonSetup.packages.filter((name) => VALID_PYTHON_PACKAGES.includes(name))
        : [],
      pyodide_base_url: asStringOr(pythonSetup.pyodide_base_url, ''),
    },
    hints: [],
    evaluation: {
      feedback_on_all_pass: asStringOr(evaluation.feedback_on_all_pass, ''),
      require_previous_test_pass: evaluation.require_previous_test_pass !== false,
      test_cases: [],
    },
  };
}

function normalizeDraftHint(hint, index) {
  const trigger = isObjectLike(hint.trigger) ? hint.trigger : {};
  const style = asStringOr(hint.style, '');

  return {
    id: asStringOr(hint.id, `hint_${index + 1}`),
    trigger: {
      event: VALID_HINT_EVENTS.includes(trigger.event) ? trigger.event : DEFAULT_HINT_EVENT,
      conditions: normalizeDraftCondition(trigger.conditions),
      after_attempts: asNonNegativeInteger(trigger.after_attempts, 0),
      invalidate_on_condition_false: Boolean(trigger.invalidate_on_condition_false),
    },
    display_mode: normalizePerHintDisplayMode(hint.display_mode),
    message: asStringOr(hint.message, ''),
    priority: asPositiveInteger(hint.priority, index + 1),
    delay_seconds: asNonNegativeInteger(hint.delay_seconds, 0),
    show_once: Boolean(hint.show_once),
    ...(style === '' ? {} : { style }),
  };
}

function normalizePublishHint(hint) {
  const trigger = isObjectLike(hint.trigger) ? hint.trigger : null;
  const style = asStringOr(hint.style, '');

  return {
    id: asStringOr(hint.id, ''),
    trigger: trigger
      ? {
        event: asStringOr(trigger.event, ''),
        ...(trigger.conditions !== undefined
          ? { conditions: normalizePublishCondition(trigger.conditions) }
          : {}),
        ...(trigger.after_attempts !== undefined
          ? { after_attempts: asNonNegativeInteger(trigger.after_attempts, 0) }
          : {}),
        ...(trigger.invalidate_on_condition_false !== undefined
          ? { invalidate_on_condition_false: Boolean(trigger.invalidate_on_condition_false) }
          : {}),
      }
      : null,
    message: asStringOr(hint.message, ''),
    ...(hint.display_mode !== undefined
      ? { display_mode: normalizePerHintDisplayMode(hint.display_mode) }
      : {}),
    ...(hint.priority !== undefined ? { priority: asPositiveInteger(hint.priority, 1) } : {}),
    ...(hint.delay_seconds !== undefined
      ? { delay_seconds: asNonNegativeInteger(hint.delay_seconds, 0) }
      : {}),
    ...(hint.show_once !== undefined ? { show_once: Boolean(hint.show_once) } : {}),
    ...(style === '' ? {} : { style }),
  };
}

function normalizeDraftTestCase(testCase, index) {
  const type = VALID_TEST_TYPES.includes(testCase.type) ? testCase.type : DEFAULT_TEST_TYPE;
  const normalized = {
    id: asStringOr(testCase.id, `test_${index + 1}`),
    type,
    points: getTestPoints(testCase),
    feedback_on_pass: asStringOr(testCase.feedback_on_pass, ''),
    feedback_on_fail: asStringOr(testCase.feedback_on_fail, ''),
  };

  if (type === 'stdout_match') {
    normalized.prompt_inputs = getPromptInputs(testCase);
    normalized.strict_prompt_inputs = shouldEnforcePromptInputCount(testCase);
    normalized.output_assertion = getStdoutOutputAssertion(testCase, { defaultEnabled: true });
    normalized.prompt_assertion = getStdoutPromptAssertion(testCase);
    normalized.execution_context = getStdoutExecutionContext(testCase);
    normalized.setup_files = normalizeActivityFiles(testCase.setup_files);
  } else if (type === 'code_structure') {
    normalized.conditions = normalizeDraftCondition(getCodeStructureConditions(testCase));
  } else if (type === 'variable_state') {
    normalized.prompt_inputs = getPromptInputs(testCase);
    normalized.strict_prompt_inputs = shouldEnforcePromptInputCount(testCase);
    normalized.variable_name = asStringOr(testCase.variable_name, '');
    normalized.expected_type = normalizeVariableType(testCase.expected_type);
    normalized.value_assertion_enabled = normalizeVariableValueAssertionEnabled(testCase);
    if (testCase.expected_value !== undefined) {
      normalized.expected_value = testCase.expected_value;
    }
    normalized.comparison = VALID_VARIABLE_COMPARISONS.includes(testCase.comparison)
      ? testCase.comparison
      : DEFAULT_VARIABLE_COMPARISON;
    normalized.show_coerced_value_hint = Boolean(testCase.show_coerced_value_hint);
    normalized.list_assertions = getVariableListAssertions(testCase);
    normalized.setup_files = normalizeActivityFiles(testCase.setup_files);
  } else if (type === 'function_state') {
    normalized.function_name = asStringOr(testCase.function_name, '');
    normalized.parameter_count_enabled = normalizeFunctionParameterCountEnabled(testCase);
    normalized.parameter_count = asNonNegativeInteger(testCase.parameter_count, 0);
    normalized.return_assertion = getFunctionReturnAssertion(testCase);
    normalized.setup_files = normalizeActivityFiles(testCase.setup_files);
  } else if (type === 'file_state') {
    normalized.path = getFileStatePath(testCase);
    normalized.exists = testCase.exists !== false;
    normalized.format = normalizeFileStateFormat(testCase.format);
    normalized.content_assertion = getFileStateContentAssertion(testCase);
    normalized.csv_assertions = getFileStateCsvAssertions(testCase);
    normalized.prompt_inputs = getPromptInputs(testCase);
    normalized.strict_prompt_inputs = shouldEnforcePromptInputCount(testCase);
    normalized.setup_files = normalizeActivityFiles(testCase.setup_files);
  }

  return normalized;
}

function normalizePublishTestCase(testCase) {
  const type = asStringOr(testCase.type, '');
  const normalized = {
    id: asStringOr(testCase.id, ''),
    type,
    points: getTestPoints(testCase),
    ...(testCase.feedback_on_pass !== undefined
      ? { feedback_on_pass: asStringOr(testCase.feedback_on_pass, '') }
      : {}),
    ...(testCase.feedback_on_fail !== undefined
      ? { feedback_on_fail: asStringOr(testCase.feedback_on_fail, '') }
      : {}),
  };

  if (type === 'stdout_match') {
    normalized.prompt_inputs = getPromptInputs(testCase);
    if (testCase.strict_prompt_inputs !== undefined) {
      normalized.strict_prompt_inputs = shouldEnforcePromptInputCount(testCase);
    }
    normalized.output_assertion = getStdoutOutputAssertion(testCase);
    normalized.prompt_assertion = getStdoutPromptAssertion(testCase);
    const executionContext = getStdoutExecutionContext(testCase);
    if (executionContext.scope === 'function') {
      normalized.execution_context = executionContext;
    }
    if (hasSetupFiles(testCase)) {
      normalized.setup_files = normalizeActivityFiles(testCase.setup_files);
    }
  } else if (type === 'code_structure') {
    normalized.conditions = normalizePublishCondition(getCodeStructureConditions(testCase));
  } else if (type === 'variable_state') {
    normalized.prompt_inputs = getPromptInputs(testCase);
    if (testCase.strict_prompt_inputs !== undefined) {
      normalized.strict_prompt_inputs = shouldEnforcePromptInputCount(testCase);
    }
    normalized.variable_name = asStringOr(testCase.variable_name, '');
    if (testCase.expected_type !== undefined) {
      normalized.expected_type = normalizeVariableType(testCase.expected_type);
    }
    if (testCase.value_assertion_enabled !== undefined || testCase.expected_value !== undefined) {
      normalized.value_assertion_enabled = normalizeVariableValueAssertionEnabled(testCase);
    }
    if (testCase.expected_value !== undefined) {
      normalized.expected_value = testCase.expected_value;
    }
    if (testCase.comparison !== undefined) {
      normalized.comparison = asStringOr(testCase.comparison, '');
    }
    if (testCase.show_coerced_value_hint !== undefined) {
      normalized.show_coerced_value_hint = Boolean(testCase.show_coerced_value_hint);
    }
    if (testCase.list_assertions !== undefined) {
      normalized.list_assertions = getVariableListAssertions(testCase);
    }
    if (hasSetupFiles(testCase)) {
      normalized.setup_files = normalizeActivityFiles(testCase.setup_files);
    }
  } else if (type === 'function_state') {
    normalized.function_name = asStringOr(testCase.function_name, '');
    if (testCase.parameter_count_enabled !== undefined) {
      normalized.parameter_count_enabled = normalizeFunctionParameterCountEnabled(testCase);
    }
    if (testCase.parameter_count !== undefined) {
      normalized.parameter_count = asNonNegativeInteger(testCase.parameter_count, 0);
    }
    if (testCase.return_assertion !== undefined) {
      normalized.return_assertion = getFunctionReturnAssertion(testCase);
    }
    if (hasSetupFiles(testCase)) {
      normalized.setup_files = normalizeActivityFiles(testCase.setup_files);
    }
  } else if (type === 'file_state') {
    normalized.path = getFileStatePath(testCase);
    if (testCase.exists !== undefined) {
      normalized.exists = Boolean(testCase.exists);
    }
    if (testCase.format !== undefined) {
      normalized.format = normalizeFileStateFormat(testCase.format);
    }
    if (testCase.content_assertion !== undefined) {
      normalized.content_assertion = getFileStateContentAssertion(testCase);
    }
    if (testCase.csv_assertions !== undefined) {
      const csvAssertions = normalizePublishCsvAssertions(testCase);
      if (Object.keys(csvAssertions).length > 0) {
        normalized.csv_assertions = csvAssertions;
      }
    }
    normalized.prompt_inputs = getPromptInputs(testCase);
    if (testCase.strict_prompt_inputs !== undefined) {
      normalized.strict_prompt_inputs = shouldEnforcePromptInputCount(testCase);
    }
    if (hasSetupFiles(testCase)) {
      normalized.setup_files = normalizeActivityFiles(testCase.setup_files);
    }
  }

  return normalized;
}

/**
 * Publish only the csv expectations that are actually set. An unset assertion
 * is `null` in the shared shape, and the export validator has no null header —
 * so the field is dropped rather than exported as "assert everything".
 * @param {object} testCase
 * @returns {object}
 */
function normalizePublishCsvAssertions(testCase) {
  const assertions = getFileStateCsvAssertions(testCase);

  return {
    ...(assertions.row_count === null
      ? {}
      : { row_count: assertions.row_count, row_count_comparison: assertions.row_count_comparison }),
    ...(assertions.header === null ? {} : { header: assertions.header }),
    ...(assertions.cells.length === 0 ? {} : { cells: assertions.cells }),
  };
}

function normalizeDraftCondition(condition) {
  if (!isObjectLike(condition) || !VALID_CONDITION_TYPES.includes(condition.type)) {
    return { ...DEFAULT_CONDITION };
  }

  switch (condition.type) {
    case 'ast_pattern':
      return {
        type: condition.type,
        pattern: asStringOr(condition.pattern, ''),
        min_count: asPositiveInteger(condition.min_count, 1),
        ...normalizeMaxCount(condition),
        ...(condition.strict === true ? { strict: true } : {}),
      };
    case 'source_regex':
      return {
        type: condition.type,
        pattern: asStringOr(condition.pattern, ''),
        case_sensitive: normalizeCaseSensitive(condition.case_sensitive, true),
        regex_flags: getCanonicalRegexFlags(condition.regex_flags),
      };
    case 'source_empty':
      return { type: condition.type };
    case 'all':
    case 'any':
    case 'none': {
      const conditions = Array.isArray(condition.conditions)
        ? condition.conditions.filter(isObjectLike).map(normalizeDraftCondition)
        : [];
      return {
        type: condition.type,
        conditions: conditions.length > 0 ? conditions : [{ ...DEFAULT_CONDITION }],
      };
    }
    default:
      return { ...DEFAULT_CONDITION };
  }
}

function normalizePublishCondition(condition) {
  if (!isObjectLike(condition)) return null;

  const type = asStringOr(condition.type, '');
  if (!VALID_CONDITION_TYPES.includes(type)) {
    return { type };
  }

  switch (type) {
    case 'ast_pattern': {
      const maxCount = normalizeMaxCount(condition);
      return {
        type,
        pattern: asStringOr(condition.pattern, ''),
        ...(condition.min_count !== undefined
          ? { min_count: asPositiveInteger(condition.min_count, 1) }
          : {}),
        ...maxCount,
        ...(condition.strict === true ? { strict: true } : {}),
      };
    }
    case 'source_regex': {
      const regexFlags = getCanonicalRegexFlags(condition.regex_flags);
      return {
        type,
        pattern: asStringOr(condition.pattern, ''),
        ...(condition.case_sensitive !== undefined
          ? { case_sensitive: normalizeCaseSensitive(condition.case_sensitive, true) }
          : {}),
        ...(condition.regex_flags !== undefined || regexFlags !== ''
          ? { regex_flags: regexFlags }
          : {}),
      };
    }
    case 'source_empty':
      return { type };
    case 'all':
    case 'any':
    case 'none':
      return {
        type,
        conditions: Array.isArray(condition.conditions)
          ? condition.conditions.filter(isObjectLike).map(normalizePublishCondition)
          : [],
      };
    default:
      return { ...DEFAULT_CONDITION };
  }
}

/**
 * `max_count` is optional and never smaller than `min_count`; an unset or
 * unreadable bound produces no field at all.
 * @param {object} condition
 * @returns {object} Zero or one key to spread into the condition.
 */
function normalizeMaxCount(condition) {
  const maxCount = asOptionalInteger(condition.max_count, null);
  if (maxCount === null) return {};
  return { max_count: Math.max(asPositiveInteger(condition.min_count, 1), maxCount) };
}

/**
 * Keep only the flags the harness understands (`re.I`/`re.M`/`re.S`), in a
 * canonical order, so `"sis"` and `"is"` cannot describe the same semantics.
 * @param {string} regexFlags
 * @returns {string}
 */
function getCanonicalRegexFlags(regexFlags = '') {
  const flags = String(regexFlags ?? '');
  return VALID_REGEX_FLAGS.filter((flag) => flags.includes(flag)).join('');
}

function normalizeCaseSensitive(value, fallback) {
  if (value === true) return true;
  if (value === false) return false;
  return fallback;
}

function normalizePerHintDisplayMode(value) {
  return VALID_HINT_DISPLAY_MODES.includes(value) ? value : DEFAULT_HINT_DISPLAY_MODE;
}

/**
 * Normalize activity and test setup files: only `path` plus exactly one of
 * `content` (UTF-8) or `content_base64` survive; path and size rules are the
 * validator's job.
 * @param {unknown} value
 * @returns {{ path: string, content?: string, content_base64?: string }[]}
 */
function normalizeActivityFiles(value) {
  return asObjectList(value).map((file) => ({
    path: asStringOr(file.path, ''),
    ...(file.content !== undefined ? { content: asStringOr(file.content, '') } : {}),
    ...(file.content_base64 !== undefined
      ? { content_base64: asStringOr(file.content_base64, '') }
      : {}),
  }));
}

function hasSetupFiles(testCase) {
  return Array.isArray(testCase.setup_files) && testCase.setup_files.length > 0;
}

function cloneConfig(config) {
  if (!isObjectLike(config)) return {};
  return JSON.parse(JSON.stringify(config));
}

function asObjectList(value) {
  return Array.isArray(value) ? value.filter(isObjectLike) : [];
}

function isObjectLike(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asStringOr(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

function asOptionalInteger(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Math.trunc(numericValue) : fallback;
}

function asNonNegativeInteger(value, fallback) {
  const normalized = asOptionalInteger(value, fallback);
  if (normalized === null) return null;
  return normalized < 0 ? fallback : normalized;
}

function asPositiveInteger(value, fallback) {
  const normalized = asOptionalInteger(value, fallback);
  if (normalized === null) return fallback;
  return normalized < 1 ? fallback : normalized;
}

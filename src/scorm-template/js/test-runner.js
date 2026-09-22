/**
 * Test Runner — executes student Python through the engine and evaluates
 * configured test cases.
 *
 * Test types:
 * - stdout_match: runtime text assertions over the captured transcript and
 *   prompt log (optionally scoped to a function call's own stdout/prompts)
 * - code_structure: AST/regex conditions, batched into ONE engine.analyze call
 * - variable_state / function_state: post-execution captures
 * - file_state: files written by the student (text or csv content checks)
 *
 * Execution plans are deduplicated: every distinct
 * {promptInputs, files, variables, functions, functionCalls, scopedFunction,
 * readPaths} tuple runs once per Check, then all tests sharing it evaluate
 * against the same result. Assertion semantics, prompt diagnostics, score
 * assembly and require_previous_test_pass gating are ported from the
 * scorm-blockly runner; the data shapes come from harness.py (tagged values,
 * camelCase diagnostics, status codes).
 */

import {
  getFunctionReturnAssertion,
  getPromptInputs as getConfiguredPromptInputs,
  getStdoutExecutionContext,
  getStdoutOutputAssertion,
  getStdoutPromptAssertion,
  getVariableListAssertions,
  normalizeFunctionParameterCountEnabled,
  normalizeVariableType,
  normalizeVariableValueAssertionEnabled,
  shouldEnforcePromptInputCount,
} from '../../shared/test-config.js';

export const INTERACTIVE_RUN_CANCELLED_ERROR = 'Run cancelled.';

const COERCION_FAILED = Symbol('coercion-failed');

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Run all test cases against the student's source.
 * @param {{ testCases: Array, source: string, activityFiles?: Array,
 *           engine: object, requirePreviousTestPass?: boolean }} options
 * @returns {Promise<{ results: Array, totalScore: number, maxScore: number,
 *   lmsScore: number, hasBlockedTests: boolean, allPassed: boolean,
 *   analysis: { results: object, syntaxError: object|null } }>}
 */
export async function runTests({
  testCases,
  source,
  activityFiles = [],
  engine,
  requirePreviousTestPass = true,
}) {
  const structureEntries = testCases
    .filter((tc) => tc.type === 'code_structure')
    .map((tc) => ({ key: structureKey(tc), condition: tc.conditions }));

  let analysis = { results: {}, syntaxError: null };
  if (structureEntries.length > 0) {
    analysis = await engine.analyze({
      source,
      conditions: structureEntries.map(({ key, condition }) => ({ key, condition })),
    });
  }

  let syntaxDetail = analysis.syntaxError
    ? formatSyntaxDetail(analysis.syntaxError)
    : null;

  const plans = new Map();
  const executionResults = new Map();
  const results = [];

  for (let index = 0; index < testCases.length; index += 1) {
    const tc = testCases[index];
    if (requirePreviousTestPass && index > 0 && !results[index - 1].passed) {
      break;
    }

    if (tc.type === 'code_structure') {
      results.push(assertCodeStructure(tc, analysis, syntaxDetail));
      continue;
    }

    if (tc.type !== 'stdout_match' && tc.type !== 'variable_state'
      && tc.type !== 'function_state' && tc.type !== 'file_state') {
      results.push({
        id: tc.id,
        passed: false,
        points: getTestPoints(tc),
        score: 0,
        feedback: `Unknown test type: ${tc.type}`,
      });
      continue;
    }

    if (syntaxDetail) {
      results.push(syntaxFailure(tc, syntaxDetail));
      continue;
    }

    const key = planKeyFor(tc, activityFiles);
    if (!plans.has(key)) {
      plans.set(key, buildPlan(tc, activityFiles));
    }
    if (!executionResults.has(key)) {
      const plan = plans.get(key);
      const raw = await engine.run({
        source,
        mode: 'check',
        files: plan.files,
        promptInputs: plan.promptInputs,
        capture: plan.capture,
      });
      if (raw.syntaxError) {
        // Same source the analyzer already parsed — unreachable when
        // code_structure tests exist; defensive for stdout-only configs.
        syntaxDetail = formatSyntaxDetail(raw.syntaxError);
        results.push(syntaxFailure(tc, syntaxDetail));
        continue;
      }
      executionResults.set(key, toExecutionResult(raw));
    }
    results.push(assertByType(tc, executionResults.get(key)));
  }

  const totalScore = results.reduce((sum, r) => sum + r.score, 0);
  const maxScore = testCases.reduce((sum, tc) => sum + getTestPoints(tc), 0);
  const hasBlockedTests = requirePreviousTestPass && results.length < testCases.length;
  const allPassed = !hasBlockedTests
    && results.length === testCases.length
    && results.every((r) => r.passed);

  return {
    results,
    totalScore,
    maxScore,
    lmsScore: maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0,
    hasBlockedTests,
    allPassed,
    analysis,
  };
}

/**
 * Interactive Run: streams stdout, replays the program for each input answer,
 * and resolves with the harness result (or a cancelled result).
 * @param {{ source: string, activityFiles?: Array, engine: object,
 *           hooks: { onStdout?: Function, requestInput?: Function } }} options
 */
export async function executeInteractiveRun({
  source,
  activityFiles = [],
  engine,
  hooks = {},
}) {
  try {
    const result = await engine.run({
      source,
      mode: 'run',
      files: [...activityFiles],
      promptInputs: [],
      capture: {},
      hooks: {
        onStdout: hooks.onStdout,
        onInputNeeded: hooks.requestInput ?? hooks.onInputNeeded,
      },
    });
    return { ...result, cancelled: false };
  } catch (err) {
    if (err && err.cancelled) {
      return {
        status: 'cancelled',
        cancelled: true,
        success: false,
        error: INTERACTIVE_RUN_CANCELLED_ERROR,
      };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Execution plans
// ---------------------------------------------------------------------------

function mergeFiles(activityFiles, setupFiles) {
  const merged = [];
  const indexByPath = new Map();
  for (const entry of [...activityFiles, ...setupFiles]) {
    if (!entry || typeof entry.path !== 'string') continue;
    if (indexByPath.has(entry.path)) {
      merged[indexByPath.get(entry.path)] = entry; // setup file wins on collision
    } else {
      indexByPath.set(entry.path, merged.length);
      merged.push(entry);
    }
  }
  return merged;
}

function buildPlan(tc, activityFiles) {
  const promptInputs = tc.type === 'function_state'
    ? [] // scorm-blockly behavior: function tests never carry prompt inputs
    : getConfiguredPromptInputs(tc);
  const files = mergeFiles(activityFiles, Array.isArray(tc.setup_files) ? tc.setup_files : []);

  const variables = [];
  const functions = [];
  const functionCalls = [];
  const readPaths = [];
  let scopedFunction = null;

  if (tc.type === 'stdout_match') {
    const executionContext = getStdoutExecutionContext(tc);
    if (executionContext.scope === 'function') {
      scopedFunction = {
        name: executionContext.function_name,
        arguments: [...executionContext.arguments],
      };
    }
  } else if (tc.type === 'variable_state') {
    if (tc.variable_name) variables.push(tc.variable_name);
  } else if (tc.type === 'function_state') {
    if (tc.function_name) functions.push(tc.function_name);
    const returnAssertion = getFunctionReturnAssertion(tc);
    if (returnAssertion.enabled && tc.function_name) {
      functionCalls.push(createFunctionCallPlan(tc.function_name, returnAssertion.arguments));
    }
  } else if (tc.type === 'file_state') {
    if (typeof tc.path === 'string' && tc.path) readPaths.push(tc.path);
  }

  const capture = {
    variables,
    functions,
    functionCalls,
    read_paths: readPaths,
    scoped_function: scopedFunction,
  };

  return { promptInputs, files, capture };
}

function planKeyFor(tc, activityFiles) {
  const plan = buildPlan(tc, activityFiles);
  return JSON.stringify({
    promptInputs: plan.promptInputs,
    files: plan.files,
    variables: plan.capture.variables,
    functions: plan.capture.functions,
    functionCalls: plan.capture.functionCalls,
    scopedFunction: plan.capture.scoped_function,
    readPaths: plan.capture.read_paths,
  });
}

function createFunctionCallPlan(functionName, args = []) {
  return {
    key: getFunctionCallKey(functionName, args),
    name: functionName,
    arguments: Array.isArray(args) ? args : [],
  };
}

function getFunctionCallKey(functionName, args = []) {
  return JSON.stringify({
    functionName: String(functionName ?? ''),
    arguments: Array.isArray(args) ? args : [],
  });
}

function structureKey(tc) {
  return `code_structure:${tc.id}`;
}

// ---------------------------------------------------------------------------
// Harness result adaptation (tagged values → evaluation shapes)
// ---------------------------------------------------------------------------

function isTagged(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.t === 'string';
}

function pythonTypeOf(value) {
  if (isTagged(value)) return value.t;
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'boolean') return 'bool';
  if (value === null) return 'null';
  return typeof value;
}

function untag(value) {
  if (!isTagged(value)) return value;
  switch (value.t) {
    case 'null':
      return null;
    case 'bool':
      return value.v;
    case 'int':
      return typeof value.v === 'string' ? Number(value.v) : value.v;
    case 'float':
      if (value.v === 'nan') return NaN;
      if (value.v === 'inf') return Infinity;
      if (value.v === '-inf') return -Infinity;
      return value.v;
    case 'string':
      return value.v;
    case 'list':
    case 'tuple':
      return (value.v || []).map(untag);
    case 'dict': {
      const object = {};
      for (const pair of value.v || []) {
        object[String(untag(pair[0]))] = untag(pair[1]);
      }
      return object;
    }
    default:
      return value.v;
  }
}

function toExecutionResult(raw) {
  const functions = {};
  for (const [name, info] of Object.entries(raw.functions || {})) {
    functions[name] = {
      name,
      defined: Boolean(info.exists),
      isFunction: Boolean(info.is_callable),
      valueType: info.kind ?? 'undefined',
      parameterCount: info.param_count ?? null,
    };
  }

  const functionCalls = {};
  for (const entry of raw.functionCalls || []) {
    if (!entry || typeof entry.key !== 'string') continue;
    functionCalls[entry.key] = entry.ok
      ? { success: true, error: null, returnValue: entry.value }
      : {
        success: false,
        error: entry.error
          ? `${entry.error.type}: ${entry.error.message}`
            + (entry.error.line ? ` (line ${entry.error.line})` : '')
          : 'call failed',
        returnValue: undefined,
      };
  }

  return {
    success: raw.status === 'done',
    status: raw.status,
    stdout: raw.stdout || '',
    variables: raw.variables || {},
    functions,
    functionCalls,
    prompts: Array.isArray(raw.prompts) ? raw.prompts : [],
    promptDiagnostics: raw.promptDiagnostics ?? null,
    files: raw.files || {},
    scopedFunction: raw.scopedFunction || null,
    error: raw.error?.message || raw.friendly || null,
    raw,
  };
}

function formatSyntaxDetail(syntaxError) {
  return `SyntaxError: ${syntaxError.message} (line ${syntaxError.line})`;
}

function syntaxFailure(tc, syntaxDetail) {
  return {
    id: tc.id,
    passed: false,
    points: getTestPoints(tc),
    score: 0,
    feedback: tc.feedback_on_fail || 'Your program could not run because of a syntax error.',
    detail: syntaxDetail,
    student_detail: syntaxDetail,
  };
}

function assertByType(tc, executionResult) {
  switch (tc.type) {
    case 'stdout_match':
      return assertStdout(tc, executionResult);
    case 'variable_state':
      return assertVariableState(tc, executionResult);
    case 'function_state':
      return assertFunctionState(tc, executionResult);
    case 'file_state':
      return assertFileState(tc, executionResult);
    default:
      return {
        id: tc.id,
        passed: false,
        points: getTestPoints(tc),
        score: 0,
        feedback: `Unknown test type: ${tc.type}`,
      };
  }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assertCodeStructure(tc, analysis, syntaxDetail) {
  const points = getTestPoints(tc);
  if (syntaxDetail) {
    return syntaxFailure(tc, syntaxDetail);
  }
  const outcome = analysis.results[structureKey(tc)];
  const passed = Boolean(outcome && outcome.passed);
  return {
    id: tc.id,
    passed,
    points,
    score: passed ? points : 0,
    feedback: passed
      ? tc.feedback_on_pass || 'Code structure is correct!'
      : tc.feedback_on_fail || 'Required code structure not found.',
    detail: outcome ? outcome.detail : 'Condition was not evaluated.',
  };
}

function assertStdout(tc, executionResult) {
  const points = getTestPoints(tc);
  const promptMismatch = shouldEnforcePromptInputCount(tc)
    ? getPromptMismatch(executionResult)
    : null;

  if (promptMismatch) {
    return {
      id: tc.id,
      passed: false,
      points,
      score: 0,
      feedback: promptMismatch.feedback,
      detail: promptMismatch.detail,
      student_detail: promptMismatch.detail,
    };
  }

  if (!executionResult.success && !executionResult.stdout) {
    return {
      id: tc.id,
      passed: false,
      points,
      score: 0,
      feedback: tc.feedback_on_fail || `Code error: ${executionResult.error}`,
      detail: executionResult.error,
    };
  }

  const stdoutExecutionContext = getStdoutExecutionContext(tc);
  let actualStdout = executionResult.stdout;
  let actualPrompts = executionResult.prompts;

  if (stdoutExecutionContext.scope === 'function') {
    const scoped = executionResult.scopedFunction;
    if (!scoped) {
      return {
        id: tc.id,
        passed: false,
        points,
        score: 0,
        feedback: tc.feedback_on_fail
          || `Function "${stdoutExecutionContext.function_name}" could not be called.`,
        detail: 'The configured function call did not run.',
      };
    }
    if (!scoped.ok) {
      return {
        id: tc.id,
        passed: false,
        points,
        score: 0,
        feedback: tc.feedback_on_fail
          || `Function "${stdoutExecutionContext.function_name}" could not be called.`,
        detail: `Calling ${formatFunctionCall(stdoutExecutionContext.function_name, stdoutExecutionContext.arguments)} failed: ${scoped.error}`,
      };
    }
    actualStdout = scoped.stdout;
    actualPrompts = scoped.prompts;
  }

  const assertions = [];
  const outputAssertion = getStdoutOutputAssertion(tc);
  if (outputAssertion.enabled) {
    assertions.push(evaluateRuntimeTextAssertion({
      assertion: outputAssertion,
      actual: actualStdout,
      label: 'Output',
      defaultSuccessMessage: 'Output matches!',
      defaultFailureMessage: 'Expected output did not match.',
    }));
  }

  const promptAssertion = getStdoutPromptAssertion(tc);
  if (promptAssertion.enabled) {
    assertions.push(evaluateRuntimeTextAssertion({
      assertion: promptAssertion,
      actual: getPromptTranscript(actualPrompts),
      actualItems: getPromptMessages(actualPrompts),
      label: 'Prompt text',
      defaultSuccessMessage: 'Prompt text matches!',
      defaultFailureMessage: 'Expected prompt text did not match.',
    }));
  }

  const failedAssertions = assertions.filter((assertion) => !assertion.passed);
  const passed = failedAssertions.length === 0;

  return {
    id: tc.id,
    passed,
    points,
    score: passed ? points : 0,
    feedback: passed
      ? tc.feedback_on_pass || buildStdoutSuccessFeedback(assertions)
      : buildStdoutFailureFeedback(tc, failedAssertions),
    detail: passed ? null : failedAssertions.map((assertion) => assertion.detail).join('\n\n'),
    student_detail: passed ? null : buildStudentFacingAssertionDetail(failedAssertions),
  };
}

function assertVariableState(tc, executionResult) {
  const points = getTestPoints(tc);
  const promptMismatch = shouldEnforcePromptInputCount(tc)
    ? getPromptMismatch(executionResult)
    : null;

  if (promptMismatch) {
    return {
      id: tc.id,
      passed: false,
      points,
      score: 0,
      feedback: promptMismatch.feedback,
      detail: promptMismatch.detail,
      student_detail: promptMismatch.detail,
    };
  }

  if (!executionResult.success) {
    return {
      id: tc.id,
      passed: false,
      points,
      score: 0,
      feedback: tc.feedback_on_fail || `Code error: ${executionResult.error}`,
      detail: executionResult.error,
    };
  }

  const tagged = executionResult.variables[tc.variable_name];
  if (tagged === undefined) {
    return {
      id: tc.id,
      passed: false,
      points,
      score: 0,
      feedback: tc.feedback_on_fail || `Variable "${tc.variable_name}" not found after execution.`,
      detail: `Available variables: ${Object.keys(executionResult.variables).join(', ') || 'none'}`,
    };
  }

  const actual = untag(tagged);
  const checks = [];
  const studentHints = [];
  const actualType = pythonTypeOf(tagged);
  const expectedType = normalizeVariableType(tc.expected_type);

  if (expectedType !== 'any') {
    const passed = actualType === expectedType;
    checks.push({
      passed,
      detail: passed
        ? `Type matches expected ${expectedType}`
        : `Expected ${tc.variable_name} to be ${expectedType}, got ${actualType}`,
    });
  }

  const valueAssertionEnabled = normalizeVariableValueAssertionEnabled(tc);
  const comparison = tc.comparison || 'equals';
  const expected = tc.expected_value;

  if (valueAssertionEnabled) {
    const valuePassed = compareVariableValues(actual, expected, comparison);
    checks.push({
      passed: valuePassed,
      detail: valuePassed
        ? `Value comparison passed (${comparison})`
        : `Expected ${tc.variable_name} ${comparison} ${formatDebugValue(expected)}, got ${formatDebugValue(actual)}`,
    });

    if (tc.show_coerced_value_hint && expectedType !== 'any' && expectedType !== 'list') {
      const coercedActual = coerceValueForType(actual, expectedType);
      const coercedOk = coercedActual !== COERCION_FAILED
        && compareVariableValues(coercedActual, expected, comparison);
      if (!valuePassed && coercedOk) {
        studentHints.push(
          `The value is correct, but not the correct type. ${capitalizeIdentifier(tc.variable_name)} is ${withIndefiniteArticle(actualType)}, not ${withIndefiniteArticle(expectedType)}.`,
        );
      } else if (valuePassed && actualType !== expectedType && coercedOk) {
        studentHints.push(
          `The value is correct, but not the correct type. ${capitalizeIdentifier(tc.variable_name)} should be ${withIndefiniteArticle(expectedType)}, not ${withIndefiniteArticle(actualType)}.`,
        );
      }
    }
  }

  const listAssertions = getVariableListAssertions(tc);
  if (hasAnyListChecks(listAssertions)) {
    const isSequence = isTagged(tagged) && (tagged.t === 'list' || tagged.t === 'tuple');
    if (!isSequence) {
      checks.push({
        passed: false,
        detail: `Expected ${tc.variable_name} to be a list before applying list assertions, got ${actualType}`,
      });
    } else {
      checks.push(...evaluateListAssertions(tc.variable_name, tagged, listAssertions, tc.show_coerced_value_hint, studentHints));
    }
  }

  const failedChecks = checks.filter((check) => !check.passed);
  const passed = failedChecks.length === 0;

  return {
    id: tc.id,
    passed,
    points,
    score: passed ? points : 0,
    feedback: passed
      ? tc.feedback_on_pass || `Variable "${tc.variable_name}" has the correct value!`
      : tc.feedback_on_fail || `Variable "${tc.variable_name}" doesn't have the expected value.`,
    detail: passed ? null : failedChecks.map((check) => check.detail).join('\n\n'),
    student_detail: !passed && studentHints.length > 0 ? studentHints.join('\n\n') : null,
  };
}

function assertFunctionState(tc, executionResult) {
  const points = getTestPoints(tc);

  if (!executionResult.success) {
    return {
      id: tc.id,
      passed: false,
      points,
      score: 0,
      feedback: tc.feedback_on_fail || `Code error: ${executionResult.error}`,
      detail: executionResult.error,
    };
  }

  const functionInfo = executionResult.functions?.[tc.function_name];
  if (!functionInfo?.defined) {
    return {
      id: tc.id,
      passed: false,
      points,
      score: 0,
      feedback: tc.feedback_on_fail || `Function "${tc.function_name}" was not found after execution.`,
      detail: `Available functions: ${Object.keys(executionResult.functions || {})
        .filter((name) => executionResult.functions?.[name]?.isFunction)
        .join(', ') || 'none'}`,
    };
  }

  if (!functionInfo.isFunction) {
    return {
      id: tc.id,
      passed: false,
      points,
      score: 0,
      feedback: tc.feedback_on_fail || `Function "${tc.function_name}" is not callable.`,
      detail: `"${tc.function_name}" is defined, but it is ${withIndefiniteArticle(functionInfo.valueType)} instead of a function.`,
    };
  }

  const checks = [];
  const returnAssertion = getFunctionReturnAssertion(tc);

  if (normalizeFunctionParameterCountEnabled(tc)) {
    const expectedParameterCount = Math.max(0, Math.trunc(Number(tc.parameter_count) || 0));
    const parameterCountPassed = functionInfo.parameterCount === expectedParameterCount;
    checks.push({
      passed: parameterCountPassed,
      detail: parameterCountPassed
        ? `Function declares ${expectedParameterCount} parameter(s)`
        : `Expected ${tc.function_name} to declare ${expectedParameterCount} parameter(s), got ${functionInfo.parameterCount}`,
    });
  }

  if (returnAssertion.enabled) {
    const callKey = getFunctionCallKey(tc.function_name, returnAssertion.arguments);
    const callResult = executionResult.functionCalls?.[callKey];
    checks.push(evaluateFunctionReturnAssertion(tc.function_name, returnAssertion, callResult));
  }

  const failedChecks = checks.filter((check) => !check.passed);
  const passed = failedChecks.length === 0;
  const onlyFailedCheck = failedChecks.length === 1 ? failedChecks[0] : null;
  const returnAssertionUsed = returnAssertion.enabled;

  return {
    id: tc.id,
    passed,
    points,
    score: passed ? points : 0,
    feedback: passed
      ? tc.feedback_on_pass
        || (returnAssertionUsed && returnAssertion.success_message
          ? returnAssertion.success_message
          : buildFunctionSuccessFeedback(tc))
      : onlyFailedCheck?.customFailureMessage
        || tc.feedback_on_fail
        || buildFunctionFailureFeedback(tc, onlyFailedCheck),
    detail: passed ? null : failedChecks.map((check) => check.detail).join('\n\n'),
    student_detail: passed ? null : buildCombinedStudentDetail({
      note: failedChecks.map((check) => check.studentNote).filter(Boolean).join('\n\n') || null,
      sections: failedChecks.flatMap((check) => (Array.isArray(check.studentSections) ? check.studentSections : [])),
    }),
  };
}

function assertFileState(tc, executionResult) {
  const points = getTestPoints(tc);
  const promptMismatch = shouldEnforcePromptInputCount(tc)
    ? getPromptMismatch(executionResult)
    : null;

  if (promptMismatch) {
    return {
      id: tc.id,
      passed: false,
      points,
      score: 0,
      feedback: promptMismatch.feedback,
      detail: promptMismatch.detail,
      student_detail: promptMismatch.detail,
    };
  }

  if (!executionResult.success) {
    return {
      id: tc.id,
      passed: false,
      points,
      score: 0,
      feedback: tc.feedback_on_fail || `Code error: ${executionResult.error}`,
      detail: executionResult.error,
    };
  }

  const record = executionResult.files?.[tc.path];
  const shouldExist = tc.exists !== false;
  const checks = [];

  if (!shouldExist) {
    const absent = !record || record.exists !== true;
    checks.push({
      passed: absent,
      detail: absent
        ? `File "${tc.path}" is absent as expected`
        : `Expected file "${tc.path}" not to exist, but it was written.`,
    });
  } else if (!record || record.exists !== true) {
    return {
      id: tc.id,
      passed: false,
      points,
      score: 0,
      feedback: tc.feedback_on_fail || `File not found: ${tc.path}`,
      detail: `File not found: ${tc.path}`,
    };
  } else if (tc.format === 'csv') {
    checks.push(...evaluateCsvAssertions(tc, record));
  } else if (tc.format === 'binary' || !tc.format || tc.format === 'text') {
    if (tc.content_assertion?.enabled && tc.format !== 'binary') {
      if (record.decode_error || record.text === null) {
        return {
          id: tc.id,
          passed: false,
          points,
          score: 0,
          feedback: tc.feedback_on_fail || `File could not be decoded as UTF-8: ${tc.path}`,
          detail: `File could not be decoded as UTF-8: ${tc.path}`,
        };
      }
      checks.push(evaluateRuntimeTextAssertion({
        assertion: tc.content_assertion,
        actual: record.text,
        label: `Content of ${tc.path}`,
        defaultSuccessMessage: 'File content matches!',
        defaultFailureMessage: 'File content did not match.',
      }));
    }
  }

  if (checks.length === 0) {
    // exists-only check already passed above
    return {
      id: tc.id,
      passed: true,
      points,
      score: points,
      feedback: tc.feedback_on_pass || `File "${tc.path}" exists.`,
      detail: null,
    };
  }

  const failed = checks.filter((check) => !check.passed);
  const passed = failed.length === 0;

  const assertionSections = buildStudentFacingAssertionDetail(
    failed.map((check) => check.assertionOutcome).filter(Boolean),
  );
  const fallbackSections = assertionSections || (failed.length > 0
    ? (() => {
      const sections = failed
        .map((check) => ({ title: 'File check', value: check.studentFacing || check.detail }))
        .filter((section) => section.value);
      return sections.length > 0 ? { sections } : null;
    })()
    : null);

  return {
    id: tc.id,
    passed,
    points,
    score: passed ? points : 0,
    feedback: passed
      ? tc.feedback_on_pass || 'File checks passed.'
      : tc.feedback_on_fail || (failed[0].studentFacing || failed[0].detail),
    detail: passed ? null : failed.map((check) => check.detail).join('\n\n'),
    student_detail: passed ? null : fallbackSections,
  };
}

function evaluateCsvAssertions(tc, record) {
  const assertions = tc.csv_assertions || {};
  const checks = [];

  if (record.decode_error || record.text === null) {
    return [{
      passed: false,
      detail: `File could not be decoded as UTF-8: ${tc.path}`,
      studentFacing: `File could not be decoded as UTF-8: ${tc.path}`,
    }];
  }

  const rows = parseCsv(record.text);

  if (assertions.row_count !== undefined && assertions.row_count !== null) {
    const comparison = assertions.row_count_comparison || 'equals';
    const passed = compareVariableValues(rows.length, assertions.row_count, comparison);
    checks.push({
      passed,
      detail: passed
        ? `Row count ${comparison} ${assertions.row_count}`
        : `Expected row count ${comparison} ${assertions.row_count}, got ${rows.length}`,
    });
  }

  if (Array.isArray(assertions.header)) {
    const header = rows[0] || [];
    const passed = JSON.stringify(header) === JSON.stringify(assertions.header);
    checks.push({
      passed,
      detail: passed
        ? 'Header row matches'
        : `Expected header ${formatDebugValue(assertions.header)}, got ${formatDebugValue(header)}`,
    });
  }

  for (const cell of assertions.cells || []) {
    const row = rows[cell.row];
    const raw = row ? row[cell.column] : undefined;
    if (raw === undefined) {
      checks.push({
        passed: false,
        detail: `Expected cell [${cell.row}][${cell.column}] to exist`,
      });
      continue;
    }
    const cellType = inferCsvCellType(raw);
    const expectedType = normalizeVariableType(cell.expected_type);
    let entryFailed = false;
    const failures = [];

    if (expectedType !== 'any' && cellType !== expectedType) {
      entryFailed = true;
      failures.push(`Expected cell [${cell.row}][${cell.column}] to be ${expectedType}, got ${cellType}`);
    }

    // A cell may assert only its type (validator accepts missing expected_value).
    if (cell.expected_value !== undefined) {
      const comparison = cell.comparison || 'equals';
      const actualValue = coerceCsvCell(raw, expectedType, cell.expected_value);
      const valuePassed = compareVariableValues(actualValue, cell.expected_value, comparison);
      if (!valuePassed) {
        entryFailed = true;
        failures.push(
          `Expected cell [${cell.row}][${cell.column}] ${comparison} ${formatDebugValue(cell.expected_value)}, got ${formatDebugValue(raw)}`,
        );
      }
    }

    checks.push({
      passed: !entryFailed,
      detail: entryFailed ? failures.join('\n') : `Cell [${cell.row}][${cell.column}] matched`,
    });
  }

  return checks;
}

function inferCsvCellType(raw) {
  if (/^[+-]?\d+$/.test(raw)) return 'int';
  if (/^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw)) return 'float';
  return 'string';
}

function coerceCsvCell(raw, expectedType, expectedValue) {
  if (expectedType === 'int' || expectedType === 'float') return Number(raw);
  if (typeof expectedValue === 'number') return Number(raw);
  if (typeof expectedValue === 'boolean') return raw === 'true';
  return raw;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function evaluateFunctionReturnAssertion(functionName, returnAssertion, callResult) {
  if (!callResult) {
    return {
      passed: false,
      detail: `The configured call to ${formatFunctionCall(functionName, returnAssertion.arguments)} did not run.`,
      customFailureMessage: returnAssertion.failure_message || '',
      studentNote: null,
      studentSections: [],
    };
  }

  if (!callResult.success) {
    return {
      passed: false,
      detail: `Calling ${formatFunctionCall(functionName, returnAssertion.arguments)} failed: ${callResult.error}`,
      customFailureMessage: returnAssertion.failure_message || '',
      studentNote: null,
      studentSections: [],
    };
  }

  const tagged = callResult.returnValue;
  const actual = untag(tagged);
  const actualType = pythonTypeOf(tagged);
  const expectedType = normalizeVariableType(returnAssertion.expected_type);
  const checks = [];
  const studentHints = [];

  if (expectedType !== 'any') {
    const typePassed = actualType === expectedType;
    checks.push({
      passed: typePassed,
      detail: typePassed
        ? `Return type matches expected ${expectedType}`
        : `Expected ${formatFunctionCall(functionName, returnAssertion.arguments)} to return ${withIndefiniteArticle(expectedType)}, got ${withIndefiniteArticle(actualType)}`,
    });
  }

  if (returnAssertion.value_assertion_enabled) {
    const expectedValue = returnAssertion.expected_value;
    const comparison = returnAssertion.comparison || 'equals';
    const valuePassed = compareVariableValues(actual, expectedValue, comparison);
    checks.push({
      passed: valuePassed,
      detail: valuePassed
        ? `Return value comparison passed (${comparison})`
        : `Expected ${formatFunctionCall(functionName, returnAssertion.arguments)} ${comparison} ${formatDebugValue(expectedValue)}, got ${formatDebugValue(actual)}`,
    });

    if (
      returnAssertion.show_coerced_value_hint
      && expectedType !== 'any'
      && expectedType !== 'list'
    ) {
      const coercedActual = coerceValueForType(actual, expectedType);
      const coercedOk = coercedActual !== COERCION_FAILED
        && compareVariableValues(coercedActual, expectedValue, comparison);
      if (!valuePassed && coercedOk) {
        studentHints.push(
          `The returned value is correct, but not the correct type. ${capitalizeIdentifier(functionName)} should return ${withIndefiniteArticle(expectedType)}, not ${withIndefiniteArticle(actualType)}.`,
        );
      } else if (valuePassed && actualType !== expectedType && coercedOk) {
        studentHints.push(
          `The returned value is correct, but not the correct type. ${capitalizeIdentifier(functionName)} should return ${withIndefiniteArticle(expectedType)}, not ${withIndefiniteArticle(actualType)}.`,
        );
      }
    }
  }

  const listAssertions = getVariableListAssertions(returnAssertion);
  if (hasAnyListChecks(listAssertions)) {
    const isSequence = isTagged(tagged) && (tagged.t === 'list' || tagged.t === 'tuple');
    if (!isSequence) {
      checks.push({
        passed: false,
        detail: `Expected ${formatFunctionCall(functionName, returnAssertion.arguments)} to return a list before applying list assertions, got ${actualType}`,
      });
    } else {
      checks.push(...evaluateListAssertions('returned value', tagged, listAssertions, returnAssertion.show_coerced_value_hint, studentHints));
    }
  }

  const failedChecks = checks.filter((check) => !check.passed);
  const passed = failedChecks.length === 0;
  const studentDetail = !passed
    ? createStudentValueDetail({
      showExpected: returnAssertion.show_expected,
      showActual: returnAssertion.show_actual,
      expectedValue: returnAssertion.expected_value,
      actualValue: actual,
      label: 'return value',
      note: studentHints.join('\n\n') || null,
    })
    : null;

  return {
    passed,
    detail: passed
      ? `Return assertion passed for ${formatFunctionCall(functionName, returnAssertion.arguments)}`
      : failedChecks.map((check) => check.detail).join('\n'),
    customSuccessMessage: returnAssertion.success_message || '',
    customFailureMessage: returnAssertion.failure_message || '',
    studentNote: studentDetail?.note || null,
    studentSections: Array.isArray(studentDetail?.sections) ? studentDetail.sections : [],
  };
}

// ---------------------------------------------------------------------------
// Text assertions (ported verbatim)
// ---------------------------------------------------------------------------

function evaluateRuntimeTextAssertion({
  assertion,
  actual,
  actualItems = [],
  label,
  defaultSuccessMessage,
  defaultFailureMessage,
}) {
  const valuesToCheck = assertion.match_any_item ? actualItems : [actual];
  const passed = valuesToCheck.some((candidate) => doesRuntimeTextMatch(candidate, assertion.expected, assertion.match_mode));
  const actualForDisplay = assertion.match_any_item ? valuesToCheck : actual;
  const scopeLabel = assertion.match_any_item ? 'any single item' : 'combined transcript';

  const successMessage = assertion.success_message || defaultSuccessMessage;
  const failureMessage = assertion.failure_message || defaultFailureMessage;

  return {
    label,
    expected: assertion.expected,
    actual: actualForDisplay,
    passed,
    feedback: passed ? successMessage : failureMessage,
    usedCustomSuccessMessage: Boolean(assertion.success_message),
    usedCustomFailureMessage: Boolean(assertion.failure_message),
    detail: `${label} (${assertion.match_mode}, ${scopeLabel})\nExpected: ${JSON.stringify(assertion.expected)}\nGot: ${JSON.stringify(actualForDisplay)}`,
    studentDetail: passed ? null : createStudentAssertionDetail(label, assertion, actualForDisplay),
    assertionOutcome: passed ? null : createStudentAssertionDetail(label, assertion, actualForDisplay),
  };
}

function doesRuntimeTextMatch(actual, expected, matchMode) {
  switch (matchMode) {
    case 'exact':
      return actual === expected;
    case 'contains':
      return actual.includes(expected);
    case 'regex':
      try {
        return new RegExp(expected).test(actual);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

function getPromptTranscript(prompts) {
  if (!Array.isArray(prompts) || prompts.length === 0) return '';
  return prompts.map((entry) => String(entry?.message ?? '')).join('\n');
}

function getPromptMessages(prompts) {
  if (!Array.isArray(prompts) || prompts.length === 0) return [];
  return prompts.map((entry) => String(entry?.message ?? ''));
}

function getPromptMismatch(executionResult) {
  const diagnostics = executionResult?.promptDiagnostics;
  if (!diagnostics) return null;

  if (diagnostics.underflowCount > 0) {
    const expectedCount = diagnostics.configuredInputCount;
    const actualCount = diagnostics.promptCallCount;
    return {
      feedback: `Your program asked for ${formatCount(actualCount, 'input')}, but the test expected ${formatCount(expectedCount, 'input')}.`,
      detail: `Your program asked for ${actualCount} prompt input(s), but this test only provided ${expectedCount}. Add or remove input steps so they match exactly.`,
    };
  }

  if (diagnostics.unusedInputCount > 0) {
    const expectedCount = diagnostics.configuredInputCount;
    const actualCount = diagnostics.promptCallCount;
    return {
      feedback: `Your program asked for ${formatCount(actualCount, 'input')}, but the test expected ${formatCount(expectedCount, 'input')}.`,
      detail: `This test provided ${expectedCount} prompt input(s), but your program only used ${actualCount}. Add or remove input steps so they match exactly.`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Value / list evaluation (ported; 'type' comparison dropped, Python types)
// ---------------------------------------------------------------------------

function hasAnyListChecks(listAssertions) {
  return listAssertions.length_enabled
    || listAssertions.values_enabled
    || listAssertions.item_types_enabled
    || listAssertions.index_checks.length > 0;
}

function compareVariableValues(actual, expected, comparison) {
  switch (comparison) {
    case 'equals':
      return actual == expected; // eslint-disable-line eqeqeq
    case 'gt':
      return actual > expected;
    case 'lt':
      return actual < expected;
    case 'gte':
      return actual >= expected;
    case 'lte':
      return actual <= expected;
    case 'contains':
      return String(actual).includes(String(expected));
    default:
      return false;
  }
}

function coerceValueForType(value, expectedType) {
  switch (expectedType) {
    case 'int':
      if (typeof value === 'number') return Math.trunc(value);
      if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
        return Math.trunc(Number(value));
      }
      return COERCION_FAILED;
    case 'float':
      if (typeof value === 'number') return Number(value);
      if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
        return Number(value);
      }
      return COERCION_FAILED;
    case 'string':
      return String(value);
    default:
      return COERCION_FAILED;
  }
}

function evaluateListAssertions(variableName, taggedList, listAssertions, showCoercedValueHint, studentHints) {
  const checks = [];
  const actualList = untag(taggedList);
  const taggedItems = taggedList.v || [];

  if (listAssertions.length_enabled) {
    const actualLength = actualList.length;
    const expectedLength = listAssertions.length_value;
    const comparisonPassed = compareVariableValues(actualLength, expectedLength, listAssertions.length_comparison);
    checks.push({
      passed: comparisonPassed,
      detail: comparisonPassed
        ? `List length ${listAssertions.length_comparison} ${expectedLength}`
        : `Expected ${variableName} length ${listAssertions.length_comparison} ${expectedLength}, got ${actualLength}`,
    });
  }

  if (listAssertions.values_enabled) {
    const valuesPassed = compareListValues(actualList, listAssertions.expected_values, listAssertions.values_match_mode);
    checks.push({
      passed: valuesPassed,
      detail: valuesPassed
        ? `List values matched (${listAssertions.values_match_mode})`
        : `Expected ${variableName} values to match mode ${listAssertions.values_match_mode}. Expected ${formatDebugValue(listAssertions.expected_values)}, got ${formatDebugValue(actualList)}`,
    });
  }

  if (listAssertions.item_types_enabled) {
    const itemTypesPassed = compareListItemTypes(taggedItems, listAssertions.expected_item_types, listAssertions.item_type_mode);
    checks.push({
      passed: itemTypesPassed,
      detail: itemTypesPassed
        ? `List item types matched mode ${listAssertions.item_type_mode}`
        : `Expected ${variableName} item types to satisfy ${listAssertions.item_type_mode} ${listAssertions.expected_item_types.join(', ')}, got ${taggedItems.map(pythonTypeOf).join(', ') || 'empty list'}`,
    });
  }

  for (const check of listAssertions.index_checks) {
    const exists = check.index < taggedItems.length;
    if (!exists) {
      checks.push({
        passed: false,
        detail: `Expected ${variableName}[${check.index}] to exist, but the list length is ${taggedItems.length}`,
      });
      continue;
    }

    const taggedEntry = taggedItems[check.index];
    const entry = untag(taggedEntry);
    const entryChecks = [];
    const entryType = pythonTypeOf(taggedEntry);
    const expectedType = normalizeVariableType(check.expected_type);

    if (expectedType !== 'any') {
      entryChecks.push({
        passed: entryType === expectedType,
        detail: `Expected ${variableName}[${check.index}] to be ${expectedType}, got ${entryType}`,
      });
    }
    if (check.expected_value !== undefined) {
      const valuePassed = compareVariableValues(entry, check.expected_value, 'equals');
      entryChecks.push({
        passed: valuePassed,
        detail: `Expected ${variableName}[${check.index}] to equal ${formatDebugValue(check.expected_value)}, got ${formatDebugValue(entry)}`,
      });
      if (
        !valuePassed
        && showCoercedValueHint
        && expectedType !== 'any'
        && expectedType !== 'list'
      ) {
        const coercedEntry = coerceValueForType(entry, expectedType);
        if (coercedEntry !== COERCION_FAILED && compareVariableValues(coercedEntry, check.expected_value, 'equals')) {
          studentHints.push(
            `The value at ${variableName}[${check.index}] is correct, but not the correct type. It is ${withIndefiniteArticle(entryType)}, not ${withIndefiniteArticle(expectedType)}.`,
          );
        }
      }
    }

    const failedEntryChecks = entryChecks.filter((entryCheck) => !entryCheck.passed);
    checks.push({
      passed: failedEntryChecks.length === 0,
      detail: failedEntryChecks.length === 0
        ? `${variableName}[${check.index}] matched the expected index rule`
        : failedEntryChecks.map((entryCheck) => entryCheck.detail).join('\n'),
    });
  }

  return checks;
}

function compareListValues(actualList, expectedValues, matchMode) {
  switch (matchMode) {
    case 'exact_order':
      return deepEqual(actualList, expectedValues);
    case 'same_values_any_order':
      return multisetIncludes(actualList, expectedValues) && multisetIncludes(expectedValues, actualList);
    case 'expected_subset_of_actual':
      return multisetIncludes(actualList, expectedValues);
    case 'expected_superset_of_actual':
      return multisetIncludes(expectedValues, actualList);
    default:
      return false;
  }
}

function compareListItemTypes(taggedItems, expectedTypes, mode) {
  const matches = taggedItems.map((item) => expectedTypes.includes(pythonTypeOf(item)));
  switch (mode) {
    case 'all':
      return matches.every(Boolean);
    case 'some':
      return matches.some(Boolean);
    case 'none':
      return matches.every((match) => !match);
    default:
      return false;
  }
}

function multisetIncludes(containerValues, candidateValues) {
  const counts = new Map();
  for (const value of containerValues) {
    const key = serializeComparableValue(value);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const value of candidateValues) {
    const key = serializeComparableValue(value);
    const remaining = counts.get(key) || 0;
    if (remaining <= 0) return false;
    counts.set(key, remaining - 1);
  }
  return true;
}

function deepEqual(left, right) {
  return serializeComparableValue(left) === serializeComparableValue(right);
}

function serializeComparableValue(value) {
  return JSON.stringify(value);
}

function formatDebugValue(value) {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

function formatStudentFacingValue(value) {
  if (value === undefined) {
    return 'undefined';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => `[${index}] ${formatStudentFacingValue(item)}`).join('\n');
  }
  return JSON.stringify(value, null, 2);
}

// ---------------------------------------------------------------------------
// Feedback / student-facing detail (ported)
// ---------------------------------------------------------------------------

function buildStdoutSuccessFeedback(assertions) {
  const customMessages = assertions
    .filter((assertion) => assertion.usedCustomSuccessMessage)
    .map((assertion) => assertion.feedback);

  if (customMessages.length > 0) {
    return customMessages.join(' ');
  }

  if (assertions.length === 1) {
    return assertions[0].feedback;
  }

  return 'Prompt text and output match!';
}

function buildStdoutFailureFeedback(testCase, failedAssertions) {
  if (failedAssertions.some((assertion) => assertion.usedCustomFailureMessage)) {
    return failedAssertions.map((assertion) => assertion.feedback).join(' ');
  }

  if (testCase.feedback_on_fail) {
    return testCase.feedback_on_fail;
  }

  if (failedAssertions.length === 1) {
    return failedAssertions[0].feedback;
  }

  return 'Prompt text and output did not match.';
}

function buildFunctionSuccessFeedback(testCase) {
  const functionName = String(testCase?.function_name ?? '');
  if (normalizeFunctionParameterCountEnabled(testCase) && getFunctionReturnAssertion(testCase).enabled) {
    return `Function "${functionName}" has the correct definition and return value!`;
  }
  if (normalizeFunctionParameterCountEnabled(testCase)) {
    return `Function "${functionName}" exists and has the correct parameter count!`;
  }
  if (getFunctionReturnAssertion(testCase).enabled) {
    return `Function "${functionName}" returns the expected value!`;
  }
  return `Function "${functionName}" exists and is callable!`;
}

function buildFunctionFailureFeedback(testCase, failedCheck = null) {
  const functionName = String(testCase?.function_name ?? '');
  if (failedCheck?.detail?.startsWith(`Calling ${functionName}(`)) {
    return `Calling function "${functionName}" caused an error.`;
  }
  if (failedCheck?.detail?.includes('parameter(s)')) {
    return `Function "${functionName}" does not have the expected number of parameters.`;
  }
  if (getFunctionReturnAssertion(testCase).enabled) {
    return `Function "${functionName}" did not meet the expected return checks.`;
  }
  return `Function "${functionName}" did not meet the expected checks.`;
}

function buildStudentFacingAssertionDetail(failedAssertions) {
  const sections = failedAssertions
    .map((assertion) => assertion.studentDetail)
    .filter(Boolean)
    .flatMap((detail) => (Array.isArray(detail.sections) ? detail.sections : []));

  return sections.length > 0 ? { sections } : null;
}

function createStudentAssertionDetail(label, assertion, actual) {
  const sections = [];
  if (assertion.show_expected) {
    sections.push({
      title: `Expected ${label.toLowerCase()}`,
      value: formatStudentFacingValue(assertion.expected),
    });
  }
  if (assertion.show_actual) {
    sections.push({
      title: `Actual ${label.toLowerCase()}`,
      value: formatStudentFacingValue(actual),
    });
  }
  return sections.length > 0 ? { sections } : null;
}

function createStudentValueDetail({
  showExpected = false,
  showActual = false,
  expectedValue = undefined,
  actualValue = undefined,
  label = 'value',
  note = null,
} = {}) {
  const sections = [];
  if (showExpected && expectedValue !== undefined) {
    sections.push({
      title: `Expected ${label}`,
      value: formatStudentFacingValue(expectedValue),
    });
  }
  if (showActual) {
    sections.push({
      title: `Actual ${label}`,
      value: formatStudentFacingValue(actualValue),
    });
  }
  return buildCombinedStudentDetail({ note, sections });
}

function buildCombinedStudentDetail({ note = null, sections = [] } = {}) {
  const normalizedSections = Array.isArray(sections) ? sections.filter(Boolean) : [];
  const normalizedNote = typeof note === 'string' && note.trim() ? note : null;

  if (!normalizedNote && normalizedSections.length === 0) {
    return null;
  }
  return {
    ...(normalizedNote ? { note: normalizedNote } : {}),
    ...(normalizedSections.length > 0 ? { sections: normalizedSections } : {}),
  };
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function withIndefiniteArticle(typeName) {
  if (typeof typeName !== 'string' || typeName === '') return String(typeName);
  return /^[aeiou]/i.test(typeName) ? `an ${typeName}` : `a ${typeName}`;
}

function capitalizeIdentifier(name) {
  const text = String(name ?? '');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'The variable';
}

function formatFunctionCall(functionName, args = []) {
  const formattedArgs = (Array.isArray(args) ? args : [])
    .map((arg) => formatDebugValue(arg))
    .join(', ');
  return `${String(functionName ?? '')}(${formattedArgs})`;
}

function formatCount(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function getTestPoints(testCase) {
  const numericValue = Number(testCase?.points ?? 0);
  return Number.isFinite(numericValue) ? Math.max(0, Math.trunc(numericValue)) : 0;
}

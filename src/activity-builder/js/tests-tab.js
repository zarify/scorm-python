/**
 * Tests Tab — test case builder for the five Python check types.
 *
 * The shared chrome (list selection, add / duplicate / remove, drag reorder,
 * points, feedback, points readout) mirrors the Blockly builder. The per-type
 * editors are Python-specific:
 *   - `code_structure` reuses the shared condition builder (AST patterns and
 *     source regexes) instead of Blockly block conditions;
 *   - `stdout_match` checks the console transcript and the `input()` prompts;
 *   - `variable_state` / `function_state` capture values from a real run;
 *   - `file_state` (new) asserts on a file the program wrote.
 *
 * Every edit mutates the central config in place and calls notifyChange();
 * the resulting notification re-renders this tab unless it came from the
 * editor render itself (`suppressSelectedTestEditorSync`).
 */

import { getConfig, getPythonEngine, notifyChange, onConfigChange } from './builder-app.js';
import {
  MAX_ACTIVITY_FILES,
  MAX_FILE_CONTENT_LENGTH,
  MAX_FILE_PATH_LENGTH,
  VALID_CSV_CELL_COMPARISONS,
  VALID_CSV_ROW_COUNT_COMPARISONS,
  VALID_FILE_STATE_FORMATS,
  VALID_LIST_ITEM_TYPE_MODES_FOR_TESTS,
  VALID_LIST_LENGTH_COMPARISONS_FOR_TESTS,
  VALID_LIST_VALUE_MATCH_MODES_FOR_TESTS,
  VALID_STDOUT_MATCH_MODES,
  VALID_VARIABLE_COMPARISONS,
  VALID_VARIABLE_TYPES_FOR_TESTS,
} from '../../shared/config-validator.js';
import { createDefaultCondition, renderConditionEditor } from './condition-builder.js';
import { enableListReordering, getSelectionIndexAfterMove, moveListItem } from './list-reorder.js';
import {
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
  normalizeListIndexChecks,
  normalizeRuntimeTextAssertion,
  normalizeVariableType,
  normalizeVariableValueAssertionEnabled,
  setTestPoints,
} from '../../shared/test-config.js';

let selectedTestIndex = -1;
let suppressSelectedTestEditorSync = false;
let isSyncingTestEditor = false;
/** The config object last rendered — a new reference means the whole config was replaced (import). */
let lastConfigRef = null;

const TEST_TYPES = [
  { value: 'stdout_match', label: 'Console output / prompt text check' },
  { value: 'code_structure', label: 'Code structure check (AST / regex)' },
  { value: 'variable_state', label: 'Variable state check' },
  { value: 'function_state', label: 'Function definition / return check' },
  { value: 'file_state', label: 'File content check' },
];

const TYPE_LABELS = Object.fromEntries(TEST_TYPES.map((entry) => [entry.value, entry.label]));

const MATCH_MODES = toOptions(VALID_STDOUT_MATCH_MODES, {
  exact: 'Exact match',
  contains: 'Contains',
  regex: 'Regex',
});

const COMPARISONS = toOptions(VALID_VARIABLE_COMPARISONS, {
  equals: 'Equals (==)',
  gt: 'Greater than (>)',
  lt: 'Less than (<)',
  gte: 'Greater or equal (>=)',
  lte: 'Less or equal (<=)',
  contains: 'Contains (substring)',
});

const VARIABLE_TYPES = toOptions(VALID_VARIABLE_TYPES_FOR_TESTS, {
  any: 'Any / do not check type',
  int: 'Integer',
  float: 'Float',
  bool: 'Boolean',
  string: 'String',
  list: 'List',
  tuple: 'Tuple',
  dict: 'Dictionary',
  null: 'None (null)',
});

const LIST_LENGTH_COMPARISONS = toOptions(VALID_LIST_LENGTH_COMPARISONS_FOR_TESTS, {
  equals: 'Length equals',
  gt: 'Length greater than',
  lt: 'Length less than',
  gte: 'Length greater or equal',
  lte: 'Length less or equal',
});

const LIST_VALUE_MATCH_MODES = toOptions(VALID_LIST_VALUE_MATCH_MODES_FOR_TESTS, {
  exact_order: 'Exact values in exact order',
  same_values_any_order: 'Exact values in any order',
  expected_subset_of_actual: 'Expected values are a subset of the student list',
  expected_superset_of_actual: 'Expected values are a superset of the student list',
});

const LIST_ITEM_TYPE_MODES = toOptions(VALID_LIST_ITEM_TYPE_MODES_FOR_TESTS, {
  all: 'All items match one of these types',
  some: 'At least one item matches one of these types',
  none: 'No items match any of these types',
});

const CSV_ROW_COUNT_COMPARISONS = toOptions(VALID_CSV_ROW_COUNT_COMPARISONS, {
  equals: 'Row count equals',
  gt: 'Row count greater than',
  lt: 'Row count less than',
  gte: 'Row count greater or equal',
  lte: 'Row count less or equal',
});

const CSV_CELL_COMPARISONS = toOptions(VALID_CSV_CELL_COMPARISONS, {
  equals: 'Equals (==)',
  gt: 'Greater than (>)',
  lt: 'Less than (<)',
  gte: 'Greater or equal (>=)',
  lte: 'Less or equal (<=)',
  contains: 'Contains (substring)',
});

const FILE_STATE_FORMATS = toOptions(VALID_FILE_STATE_FORMATS, {
  text: 'Text (UTF-8 content)',
  csv: 'CSV table',
  binary: 'Binary (existence only)',
});

const ITEM_TYPE_CHOICES = VALID_VARIABLE_TYPES_FOR_TESTS.filter((type) => type !== 'any');
const ITEM_TYPE_HELP = ITEM_TYPE_CHOICES.join(', ');

/** Test types that drive the interactive prompt queue. */
const PROMPT_INPUT_TYPES = ['stdout_match', 'variable_state', 'file_state'];
/** Test types that seed per-test setup files. */
const SETUP_FILE_TYPES = ['stdout_match', 'variable_state', 'function_state', 'file_state'];

const PATH_PATTERN = /^[A-Za-z0-9_./-]+$/;
const PATH_HELP = 'Use letters, digits, _ . / - only; no leading / and no .. segments (max 256 chars)';
const INVALID_COLOR = '#c62828';

export function initTestsTab() {
  lastConfigRef = getConfig();

  document.getElementById('btn-add-test')?.addEventListener('click', addTest);

  onConfigChange(handleConfigChange);

  window.addEventListener('tab-activated', (event) => {
    if (event.detail?.tab === 'tests') renderTestsTab();
  });

  renderTestList();
  updatePointsIndicator();
}

/**
 * React to a config change.
 *
 * Our own edits notify in place (same object), so the list and the points
 * readout refresh while the editor render is suppressed — re-rendering the
 * editor mid-edit would steal focus. A replaced config (import) refreshes
 * everything, even while the tab is hidden.
 */
function handleConfigChange(newConfig) {
  if (isSyncingTestEditor) return;

  if (newConfig !== lastConfigRef) {
    lastConfigRef = newConfig;
    clampSelection();
    renderTestsTab();
    return;
  }

  // A hidden tab is refreshed when it becomes visible.
  if (!isTestsTabVisible()) return;

  isSyncingTestEditor = true;
  try {
    renderTestsTab();
  } finally {
    isSyncingTestEditor = false;
  }
}

function isTestsTabVisible() {
  return document.getElementById('tab-tests')?.classList.contains('active') === true;
}

function tests() {
  const config = getConfig();
  if (!Array.isArray(config.evaluation.test_cases)) config.evaluation.test_cases = [];
  return config.evaluation.test_cases;
}

function clampSelection() {
  const count = tests().length;
  if (selectedTestIndex >= count) selectedTestIndex = count - 1;
}

function renderTestsTab() {
  renderTestList();
  updatePointsIndicator();
  if (selectedTestIndex >= 0 && !suppressSelectedTestEditorSync) renderTestEditor();
}

// — List panel —

function addTest() {
  const list = tests();
  const testCase = {
    id: createTestId(list),
    type: 'stdout_match',
    points: 1,
    feedback_on_pass: '',
    feedback_on_fail: '',
  };
  applyTestType(testCase, 'stdout_match');
  list.push(testCase);

  selectedTestIndex = list.length - 1;
  emitLocalTestChange();
  renderTestList();
  renderTestEditor();
  updatePointsIndicator();
}

function duplicateTest(index) {
  const list = tests();
  const source = list[index];
  if (!source) return;

  const copy = deepClone(source);
  copy.id = createTestId(list);
  list.splice(index + 1, 0, copy);

  selectedTestIndex = index + 1;
  emitLocalTestChange();
  renderTestList();
  renderTestEditor();
  updatePointsIndicator();
}

function removeTest(index) {
  const list = tests();
  if (index < 0 || index >= list.length) return;

  list.splice(index, 1);
  if (selectedTestIndex >= list.length) selectedTestIndex = list.length - 1;

  emitLocalTestChange();
  renderTestList();
  renderTestEditor();
  updatePointsIndicator();
}

function renderTestList() {
  const container = document.getElementById('test-list');
  if (!container) return;
  const list = tests();

  container.innerHTML = list.map((testCase, index) => `
    <div class="list-item test-list-item list-item-reorderable ${index === selectedTestIndex ? 'selected' : ''}" data-index="${index}" draggable="true">
      <span class="list-item-title">
        <strong>${escapeHtml(TYPE_LABELS[testCase.type] || testCase.type)}</strong> — ${escapeHtml(testCase.id)} (${formatPointsLabel(getTestPoints(testCase))})
      </span>
      <button class="btn btn-small btn-secondary list-item-duplicate" data-index="${index}" title="Duplicate test">⧉</button>
      <button class="list-item-remove" data-index="${index}" title="Remove test">✕</button>
    </div>
  `).join('');

  container.querySelectorAll('.list-item').forEach((el) => {
    el.addEventListener('click', (event) => {
      if (event.target.tagName === 'BUTTON') return;
      selectedTestIndex = parseInt(el.dataset.index, 10);
      renderTestList();
      renderTestEditor();
    });
  });

  enableListReordering(container, {
    itemSelector: '.test-list-item',
    onMove: moveTest,
  });

  container.querySelectorAll('.list-item-duplicate').forEach((el) => {
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      duplicateTest(parseInt(el.dataset.index, 10));
    });
  });

  container.querySelectorAll('.list-item-remove').forEach((el) => {
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      removeTest(parseInt(el.dataset.index, 10));
    });
  });
}

function moveTest(fromIndex, targetIndex, position) {
  const moved = moveListItem(tests(), fromIndex, targetIndex, position);
  if (!moved) return;
  if (!moved.changed) {
    renderTestList();
    return;
  }

  selectedTestIndex = getSelectionIndexAfterMove(selectedTestIndex, moved.fromIndex, moved.insertIndex);

  emitLocalTestChange();
  renderTestList();
  renderTestEditor();
}

// — Editor —

function renderTestEditor() {
  const container = document.getElementById('test-editor-content');
  if (!container) return;
  const list = tests();

  if (selectedTestIndex < 0 || selectedTestIndex >= list.length) {
    container.innerHTML = '<p class="placeholder-text">Select a test case to edit, or add a new one.</p>';
    return;
  }

  const testCase = list[selectedTestIndex];
  const usesAssertionLevelMessages = testCase.type === 'stdout_match' || testCase.type === 'function_state';
  const successHelp = testCase.type === 'stdout_match'
    ? '<small>Shown when the whole test passes. For console output and prompt checks, this overrides the assertion success messages.</small>'
    : testCase.type === 'function_state'
      ? '<small>Shown when the whole test passes. For function return checks, this overrides the return assertion success message.</small>'
      : '';
  const failureLabel = usesAssertionLevelMessages ? 'Fallback feedback on fail' : 'Feedback on fail';
  const failureHelp = testCase.type === 'stdout_match'
    ? '<small>Shown only when the enabled output and prompt checks do not provide their own failure message.</small>'
    : testCase.type === 'function_state'
      ? '<small>Shown when the failure is not covered by a return assertion failure message, or when several function checks fail.</small>'
      : '';

  container.innerHTML = `
    <div class="form-group">
      <label>Test ID</label>
      <input type="text" id="test-id" value="${escapeAttr(testCase.id)}">
    </div>
    <div class="form-group">
      <label>Type</label>
      <select id="test-type">
        ${TEST_TYPES.map((entry) => `<option value="${entry.value}" ${testCase.type === entry.value ? 'selected' : ''}>${escapeHtml(entry.label)}</option>`).join('')}
      </select>
    </div>
    <div id="test-type-fields"></div>
    <div class="form-group">
      <label>Points</label>
      <input type="number" id="test-points" min="0" step="1" value="${getTestPoints(testCase)}">
      <small>Integer points awarded when this test passes.</small>
    </div>
    <div class="form-group">
      <label>Feedback on pass</label>
      <textarea id="test-feedback-pass" rows="2" placeholder="Message shown to the student when this test passes">${escapeHtml(testCase.feedback_on_pass || '')}</textarea>
      ${successHelp}
    </div>
    <div class="form-group">
      <label>${failureLabel}</label>
      <textarea id="test-feedback" rows="2" placeholder="Message shown to the student when this test fails">${escapeHtml(testCase.feedback_on_fail || '')}</textarea>
      ${failureHelp}
    </div>
  `;

  renderTestTypeFields(testCase);

  bindField('test-id', (value) => { testCase.id = value; });
  bindField('test-type', (value) => {
    applyTestType(testCase, value);
    emitLocalTestChange();
    renderTestEditor();
    renderTestList();
    updatePointsIndicator();
  });

  const pointsInput = document.getElementById('test-points');
  pointsInput.addEventListener('input', (event) => {
    setTestPoints(testCase, event.target.value);
    emitLocalTestChange();
    updatePointsIndicator();
    renderTestList();
  });

  bindField('test-feedback-pass', (value) => { testCase.feedback_on_pass = value; });
  bindField('test-feedback', (value) => { testCase.feedback_on_fail = value; });
}

/**
 * Convert a test case to another type in place, keeping only the fields the
 * new type defines so no stale keys survive in the exported config.
 */
function applyTestType(testCase, type) {
  const next = {
    id: testCase.id,
    type,
    points: getTestPoints(testCase),
    feedback_on_pass: typeof testCase.feedback_on_pass === 'string' ? testCase.feedback_on_pass : '',
    feedback_on_fail: typeof testCase.feedback_on_fail === 'string' ? testCase.feedback_on_fail : '',
  };

  if (PROMPT_INPUT_TYPES.includes(type)) {
    next.prompt_inputs = getPromptInputs(testCase);
    next.strict_prompt_inputs = typeof testCase.strict_prompt_inputs === 'boolean'
      ? testCase.strict_prompt_inputs
      : true;
  }
  if (SETUP_FILE_TYPES.includes(type) && Array.isArray(testCase.setup_files) && testCase.setup_files.length > 0) {
    next.setup_files = testCase.setup_files;
  }

  switch (type) {
    case 'code_structure':
      next.conditions = createDefaultCondition('ast_pattern');
      break;
    case 'variable_state':
      next.variable_name = '';
      next.expected_type = 'any';
      next.value_assertion_enabled = true;
      next.expected_value = '';
      next.comparison = 'equals';
      next.show_coerced_value_hint = false;
      next.list_assertions = getVariableListAssertions({});
      break;
    case 'function_state':
      next.function_name = '';
      next.parameter_count_enabled = false;
      next.parameter_count = 0;
      next.return_assertion = getFunctionReturnAssertion({});
      break;
    case 'file_state':
      next.path = '';
      next.exists = true;
      next.format = 'text';
      next.content_assertion = createTextAssertion({ enabled: false });
      next.csv_assertions = createCsvAssertions();
      break;
    case 'stdout_match':
    default:
      next.output_assertion = createTextAssertion({ enabled: true });
      next.prompt_assertion = createTextAssertion({ enabled: false });
      next.execution_context = { scope: 'main' };
      break;
  }

  for (const key of Object.keys(testCase)) {
    if (!(key in next)) delete testCase[key];
  }
  Object.assign(testCase, next);
}

function renderTestTypeFields(testCase) {
  const container = document.getElementById('test-type-fields');
  let html = '';

  switch (testCase.type) {
    case 'stdout_match': {
      testCase.output_assertion = getStdoutOutputAssertion(testCase, { defaultEnabled: true });
      testCase.prompt_assertion = getStdoutPromptAssertion(testCase);
      testCase.execution_context = getStdoutExecutionContext(testCase);

      html = `
        ${renderPromptInputsBlock(testCase, 'Responses handed to successive input() calls in order. Use the option below to decide whether extra or missing inputs should fail the test.')}
        <div class="form-group">
          <label>Execution scope</label>
          <select id="test-execution-scope">
            <option value="main" ${testCase.execution_context.scope === 'main' ? 'selected' : ''}>Main program</option>
            <option value="function" ${testCase.execution_context.scope === 'function' ? 'selected' : ''}>Specific function call</option>
          </select>
          <small>Check all console output from the top-level run, or only what happens during one function call after the program finishes.</small>
        </div>
        ${testCase.execution_context.scope === 'function' ? `
        <div class="form-group">
          <label>Function name</label>
          <input type="text" id="test-execution-function-name" value="${escapeAttr(testCase.execution_context.function_name || '')}" placeholder="e.g. greet">
        </div>
        <div class="form-group">
          <label>Function arguments</label>
          <input type="text" id="test-execution-function-arguments" class="mono" value="${escapeAttr(formatJsonArray(testCase.execution_context.arguments))}" placeholder='e.g. ["Ada"]'>
          <small>A JSON array with one entry per argument: numbers, strings, booleans, null, lists, or objects.</small>
        </div>
        ` : ''}
        ${renderTextAssertionEditor({
          prefix: 'test-output',
          title: 'Console output',
          assertion: testCase.output_assertion,
          expectedLabel: 'Expected output',
          expectedPlaceholder: 'Expected console output',
          helpText: 'Matches the whole stdout transcript. Use actual newlines — one line of expected output per line; print() adds the trailing newline itself.',
          showExpectedLabel: 'Show expected output when this check fails',
          showActualLabel: 'Show actual output when this check fails',
        })}
        ${renderTextAssertionEditor({
          prefix: 'test-prompt',
          title: 'Prompt text',
          assertion: testCase.prompt_assertion,
          expectedLabel: 'Expected prompt text',
          expectedPlaceholder: 'One prompt message per line',
          helpText: 'Matches the prompt text passed to input() in order, joined with newlines. A single <code>input("Knock knock")</code> is entered as <code>Knock knock</code>.',
          matchAnyItemLabel: 'Match any single prompt instead of the combined prompt transcript',
          showExpectedLabel: 'Show expected prompt text when this check fails',
          showActualLabel: 'Show actual prompt text when this check fails',
        })}
        ${renderSetupFilesBlock()}
      `;
      break;
    }

    case 'code_structure':
      html = `
        <div class="form-group">
          <label>Condition</label>
          <div id="test-condition-builder"></div>
          <small>AST patterns are Python source with wildcards; <code>_</code> matches any expression, <code>_name</code> binds the same expression everywhere it appears, and <code>...</code> matches any statements or call arguments.</small>
        </div>
      `;
      break;

    case 'variable_state':
      testCase.expected_type = normalizeVariableType(testCase.expected_type);
      testCase.value_assertion_enabled = normalizeVariableValueAssertionEnabled(testCase);
      testCase.show_coerced_value_hint = Boolean(testCase.show_coerced_value_hint);
      testCase.list_assertions = getVariableListAssertions(testCase);

      html = `
        ${renderPromptInputsBlock(testCase, 'Responses handed to successive input() calls in order before the variable assertions run. Use the option below to decide whether extra or missing inputs should fail the test.')}
        <div class="form-group">
          <label>Variable name</label>
          <input type="text" id="test-var-name" value="${escapeAttr(testCase.variable_name || '')}" placeholder="e.g. count">
          <small>The variable must exist in the module scope after the program runs.</small>
        </div>
        <div class="form-group">
          <label>Expected type</label>
          <select id="test-var-type">
            ${renderOptions(VARIABLE_TYPES, testCase.expected_type)}
          </select>
          <small>Use this for explicit type checks such as integer vs string, float, list, or dict.</small>
        </div>
        ${testCase.expected_type !== 'list' ? `
        <div class="form-group">
          <label class="checkbox-label">
            <input type="checkbox" id="test-var-value-enabled" ${testCase.value_assertion_enabled ? 'checked' : ''}>
            Verify the variable value
          </label>
        </div>
        <fieldset id="test-var-value-fields" ${testCase.value_assertion_enabled ? '' : 'disabled'} style="border:1px solid #ddd;border-radius:6px;padding:12px;margin:0 0 12px">
          <legend style="padding:0 6px;font-weight:600">Scalar value assertion</legend>
          <div class="form-group">
            <label>Expected value</label>
            <input type="text" id="test-var-expected" value="${escapeAttr(formatScalarExpectedValue(testCase.expected_value))}" placeholder="${escapeAttr(getScalarValuePlaceholder(testCase.expected_type, testCase.comparison))}">
            <small>${getScalarValueHelpText(testCase.expected_type, testCase.comparison)}</small>
          </div>
          <div class="form-group">
            <label>Comparison</label>
            <select id="test-var-comparison">
              ${renderOptions(COMPARISONS, testCase.comparison || 'equals')}
            </select>
          </div>
          <div class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" id="test-var-coercion-hint" ${testCase.show_coerced_value_hint ? 'checked' : ''}>
              Show a hint when the coerced value matches but the type is wrong
            </label>
          </div>
        </fieldset>
        ` : `
        <div class="form-group">
          <small>List variables can be checked by length, contents, item types, and specific index checks. Leave every list assertion disabled if you only want to assert that the variable is a list.</small>
        </div>
        ${renderListAssertionEditor('test', testCase.list_assertions)}
        `}
        ${renderSetupFilesBlock()}
      `;
      break;

    case 'function_state':
      testCase.parameter_count_enabled = normalizeFunctionParameterCountEnabled(testCase);
      testCase.return_assertion = getFunctionReturnAssertion(testCase);

      html = `
        <div class="form-group">
          <label>Function name</label>
          <input type="text" id="test-function-name" value="${escapeAttr(testCase.function_name || '')}" placeholder="e.g. greet">
          <small>The test always checks that this name resolves to a callable function after the program runs. Any input() calls the program makes are ignored for prompt-count matching in this test type.</small>
        </div>
        <div class="form-group">
          <label class="checkbox-label">
            <input type="checkbox" id="test-function-parameter-count-enabled" ${testCase.parameter_count_enabled ? 'checked' : ''}>
            Verify the number of parameters in the definition
          </label>
          <input type="number" id="test-function-parameter-count" min="0" value="${Math.max(0, parseInt(testCase.parameter_count, 10) || 0)}" ${testCase.parameter_count_enabled ? '' : 'disabled'} style="margin-top:8px">
          <small><code>*args</code> and <code>**kwargs</code> are not counted.</small>
        </div>
        ${renderReturnAssertionEditor('test-function-return', testCase.return_assertion)}
        ${renderSetupFilesBlock()}
      `;
      break;

    case 'file_state': {
      testCase.path = getFileStatePath(testCase);
      testCase.exists = testCase.exists !== false;
      testCase.format = normalizeFileStateFormat(testCase.format);
      if (!isObjectLike(testCase.content_assertion)) {
        testCase.content_assertion = createTextAssertion({ enabled: false });
      }
      const csv = csvAssertionsOf(testCase);

      html = `
        ${renderPromptInputsBlock(testCase, 'Responses handed to successive input() calls in order before the file check runs. Use the option below to decide whether extra or missing inputs should fail the test.')}
        <div class="form-group">
          <label>File path</label>
          <input type="text" id="test-file-path" class="mono" maxlength="${MAX_FILE_PATH_LENGTH}" value="${escapeAttr(testCase.path)}" placeholder="result.csv">
          <small>Relative to the working directory: letters, digits, <code>_ . / -</code>, no leading <code>/</code>, no <code>..</code> segments.</small>
        </div>
        <div class="form-group">
          <label class="checkbox-label">
            <input type="checkbox" id="test-file-exists" ${testCase.exists ? 'checked' : ''}>
            The file must exist
          </label>
          <small>Uncheck when the test should pass only if the program did <em>not</em> write this file.</small>
        </div>
        <div class="form-group">
          <label>Format</label>
          <select id="test-file-format">
            ${renderOptions(FILE_STATE_FORMATS, testCase.format)}
          </select>
        </div>
        ${testCase.format === 'text' ? renderTextAssertionEditor({
          prefix: 'test-file-content',
          title: 'File content',
          assertion: testCase.content_assertion,
          expectedLabel: 'Expected content',
          expectedPlaceholder: 'Expected file content',
          helpText: 'Matches the decoded UTF-8 text of the file. Use actual newlines, one expected line per line.',
          showExpectedLabel: 'Show expected content when this check fails',
          showActualLabel: 'Show actual content when this check fails',
        }) : ''}
        ${testCase.format === 'csv' ? renderCsvAssertionsBlock(csv) : ''}
        ${renderSetupFilesBlock()}
      `;
      break;
    }

    default:
      break;
  }

  container.innerHTML = html;

  switch (testCase.type) {
    case 'stdout_match':
      bindPromptInputs(testCase);
      bindField('test-execution-scope', (value) => {
        // The render below re-normalizes the context through
        // getStdoutExecutionContext: `main` scope blanks the function fields,
        // `function` scope materializes them.
        testCase.execution_context.scope = value;
        renderTestEditor();
      });
      bindField('test-execution-function-name', (value) => {
        testCase.execution_context.function_name = value;
      });
      bindParsedField('test-execution-function-arguments', parseJsonArray, (values) => {
        testCase.execution_context.arguments = values;
      });
      bindTextAssertionFields('test-output', testCase.output_assertion);
      bindTextAssertionFields('test-prompt', testCase.prompt_assertion);
      bindSetupFiles(testCase);
      break;

    case 'code_structure': {
      const mount = document.getElementById('test-condition-builder');
      if (mount) {
        if (!isObjectLike(testCase.conditions)) {
          testCase.conditions = createDefaultCondition('ast_pattern');
        }
        renderConditionEditor({
          container: mount,
          condition: testCase.conditions,
          onChange: (nextCondition) => {
            testCase.conditions = nextCondition;
            emitLocalTestChange();
          },
          validatePattern: validateTestPattern,
        });
      }
      break;
    }

    case 'variable_state':
      bindPromptInputs(testCase);
      bindField('test-var-name', (value) => { testCase.variable_name = value; });
      bindField('test-var-type', (value) => {
        testCase.expected_type = value;
        if (value === 'list') testCase.value_assertion_enabled = false;
        renderTestEditor();
      });
      if (testCase.expected_type !== 'list') {
        bindCheckedField('test-var-value-enabled', (checked) => {
          testCase.value_assertion_enabled = checked;
          toggleDisabledState('test-var-value-fields', !checked);
        });
        bindField('test-var-expected', (value) => {
          testCase.expected_value = parseScalarExpectedValue(value, testCase.expected_type, testCase.comparison);
        });
        bindField('test-var-comparison', (value) => {
          testCase.comparison = value;
          renderTestEditor();
        });
        bindCheckedField('test-var-coercion-hint', (checked) => {
          testCase.show_coerced_value_hint = checked;
        });
      } else {
        bindListAssertionFields('test', testCase.list_assertions);
      }
      bindSetupFiles(testCase);
      break;

    case 'function_state':
      bindField('test-function-name', (value) => { testCase.function_name = value; });
      bindCheckedField('test-function-parameter-count-enabled', (checked) => {
        testCase.parameter_count_enabled = checked;
        toggleDisabledState('test-function-parameter-count', !checked);
      });
      bindField('test-function-parameter-count', (value) => {
        testCase.parameter_count = Math.max(0, parseInt(value, 10) || 0);
      });
      bindReturnAssertionFields('test-function-return', testCase.return_assertion, renderTestEditor);
      bindSetupFiles(testCase);
      break;

    case 'file_state':
      bindPromptInputs(testCase);
      bindFileNameFields(testCase);
      bindCheckedField('test-file-exists', (checked) => { testCase.exists = checked; });
      bindField('test-file-format', (value) => {
        testCase.format = normalizeFileStateFormat(value);
        // Content assertions only run for text files, so a stale enabled flag
        // would make the exported config invalid.
        if (testCase.format !== 'text' && testCase.content_assertion?.enabled) {
          testCase.content_assertion.enabled = false;
        }
        renderTestEditor();
      });
      if (testCase.format === 'text') {
        bindTextAssertionFields('test-file-content', testCase.content_assertion);
      }
      if (testCase.format === 'csv') {
        bindCsvAssertionFields(testCase);
      }
      bindSetupFiles(testCase);
      break;

    default:
      break;
  }
}

function validateTestPattern(pattern) {
  const engine = getPythonEngine();
  if (!engine) {
    return 'Pattern validation requires HTTP — serve this folder with npm run dev.';
  }
  return engine
    .validatePatterns({ patterns: [{ key: 'pattern', pattern: String(pattern ?? '') }] })
    .then((errors) => errors?.pattern ?? null);
}

// — Shared field blocks —

function renderPromptInputsBlock(testCase, helpText) {
  return `
    <div class="form-group">
      <label>Prompt inputs</label>
      <div id="test-prompt-inputs"></div>
      <div style="margin-top:6px">
        <button type="button" id="test-add-prompt-input" class="btn btn-small btn-secondary">+ Add input</button>
      </div>
      <small>${helpText}</small>
    </div>
    <div class="form-group">
      <label class="checkbox-label">
        <input type="checkbox" id="test-strict-prompt-inputs" ${testCase.strict_prompt_inputs !== false ? 'checked' : ''}>
        Fail if the number of prompt inputs used does not match exactly
      </label>
      <small>Turn this off when you want to check console text in isolation without depending on the program's full input() structure.</small>
    </div>
  `;
}

function bindPromptInputs(testCase) {
  const container = document.getElementById('test-prompt-inputs');
  const addButton = document.getElementById('test-add-prompt-input');
  if (!container || !addButton) return;

  const renderRows = () => {
    const inputs = ensurePromptInputs(testCase);
    container.innerHTML = '';

    if (inputs.length === 0) {
      const note = document.createElement('p');
      note.className = 'placeholder-text';
      note.textContent = 'No inputs yet — add one row per input() call the program makes.';
      container.appendChild(note);
    }

    inputs.forEach((value, index) => {
      const row = document.createElement('div');
      row.className = 'form-row';
      row.style.alignItems = 'center';
      row.style.gap = '8px';

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'mono';
      input.value = value;
      input.placeholder = `Response ${index + 1}`;
      input.title = `Response given to input() call ${index + 1}`;
      input.style.flex = '1';
      input.addEventListener('input', () => {
        inputs[index] = input.value;
        emitLocalTestChange();
      });

      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'step-remove';
      removeButton.title = 'Remove this input';
      removeButton.textContent = '✕';
      removeButton.addEventListener('click', () => {
        ensurePromptInputs(testCase).splice(index, 1);
        renderRows();
        emitLocalTestChange();
      });

      row.append(input, removeButton);
      container.appendChild(row);
    });
  };

  addButton.addEventListener('click', () => {
    ensurePromptInputs(testCase).push('');
    renderRows();
    emitLocalTestChange();
  });

  renderRows();
  bindCheckedField('test-strict-prompt-inputs', (checked) => {
    testCase.strict_prompt_inputs = checked;
  });
}

function renderSetupFilesBlock() {
  return `
    <div class="form-group">
      <label>Setup files</label>
      <div id="test-setup-files"></div>
      <div style="margin-top:6px">
        <button type="button" id="test-add-setup-file" class="btn btn-small btn-secondary">+ Add setup file</button>
      </div>
      <small>Seeded into the working directory before this test's check runs. A path here overrides the activity file with the same path (max ${MAX_ACTIVITY_FILES} files).</small>
    </div>
  `;
}

function bindSetupFiles(testCase) {
  const container = document.getElementById('test-setup-files');
  const addButton = document.getElementById('test-add-setup-file');
  if (!container || !addButton) return;

  const renderRows = () => {
    const files = setupFilesOf(testCase);
    container.innerHTML = '';
    files.forEach((entry, index) => {
      container.appendChild(buildSetupFileRow(testCase, entry, index, renderRows));
    });
    addButton.disabled = files.length >= MAX_ACTIVITY_FILES;

    enableListReordering(container, {
      itemSelector: '.activity-file-row',
      onMove: (fromIndex, targetIndex, position) => {
        const moved = moveListItem(setupFilesOf(testCase), fromIndex, targetIndex, position);
        if (!moved?.changed) return;
        renderRows();
        emitLocalTestChange();
      },
    });
  };

  addButton.addEventListener('click', () => {
    const files = setupFilesOf(testCase);
    if (files.length >= MAX_ACTIVITY_FILES) return;
    files.push({ path: `setup${files.length + 1}.txt`, content: '' });
    renderRows();
    emitLocalTestChange();
  });

  renderRows();
}

function buildSetupFileRow(testCase, entry, index, rerender) {
  const row = document.createElement('div');
  row.className = 'activity-file-row list-item-reorderable';
  row.dataset.index = String(index);
  row.style.display = 'grid';
  row.style.gap = '6px';
  row.style.marginBottom = '10px';

  const isBase64 = typeof entry.content_base64 === 'string';

  const pathInput = document.createElement('input');
  pathInput.type = 'text';
  pathInput.className = 'file-path-input mono';
  pathInput.placeholder = 'setup.csv';
  pathInput.maxLength = MAX_FILE_PATH_LENGTH;
  pathInput.value = entry.path || '';
  pathInput.addEventListener('input', () => {
    const valid = isValidActivityPath(pathInput.value);
    markValidity(pathInput, valid, PATH_HELP);
    if (!valid) return;
    entry.path = pathInput.value;
    emitLocalTestChange();
  });
  markValidity(pathInput, isValidActivityPath(pathInput.value), PATH_HELP);

  const actions = document.createElement('div');
  actions.className = 'file-row-buttons';

  const modeButton = document.createElement('button');
  modeButton.type = 'button';
  modeButton.className = 'btn btn-small btn-secondary';
  modeButton.textContent = isBase64 ? 'To text' : 'Upload binary';
  modeButton.title = isBase64
    ? 'Replace with editable text content'
    : 'Read a local file as base64 content';

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'step-remove';
  removeButton.title = 'Remove setup file';
  removeButton.textContent = '✕';
  removeButton.addEventListener('click', () => {
    setupFilesOf(testCase).splice(index, 1);
    rerender();
    emitLocalTestChange();
  });

  actions.append(modeButton, removeButton);
  row.append(pathInput, actions);

  if (isBase64) {
    const badge = document.createElement('span');
    badge.className = 'file-binary-badge';
    badge.textContent = `binary (${Math.ceil((entry.content_base64.length * 3) / 4)} bytes)`;
    row.appendChild(badge);

    modeButton.addEventListener('click', () => {
      delete entry.content_base64;
      entry.content = '';
      rerender();
      emitLocalTestChange();
    });
  } else {
    const contentArea = document.createElement('textarea');
    contentArea.className = 'file-content-input';
    contentArea.rows = 3;
    contentArea.spellcheck = false;
    contentArea.maxLength = MAX_FILE_CONTENT_LENGTH;
    contentArea.placeholder = 'File content (text)';
    contentArea.value = entry.content ?? '';
    contentArea.addEventListener('input', () => {
      entry.content = contentArea.value;
      delete entry.content_base64;
      emitLocalTestChange();
    });
    row.appendChild(contentArea);

    modeButton.addEventListener('click', () => pickBinarySetupFile(entry, rerender));
  }

  return row;
}

function pickBinarySetupFile(entry, rerender) {
  const input = document.createElement('input');
  input.type = 'file';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const comma = dataUrl.indexOf(',');
      const base64 = comma === -1 ? '' : dataUrl.slice(comma + 1);
      if (base64.length > MAX_FILE_CONTENT_LENGTH) {
        window.alert('File is too large — base64 content must stay under 262144 characters.');
        return;
      }
      delete entry.content;
      entry.content_base64 = base64;
      rerender();
      emitLocalTestChange();
    };
    reader.readAsDataURL(file);
  });
  input.click();
}

function renderTextAssertionEditor({
  prefix,
  title,
  assertion,
  expectedLabel,
  expectedPlaceholder,
  helpText,
  matchAnyItemLabel,
  showExpectedLabel,
  showActualLabel,
}) {
  return `
    <div class="form-group">
      <label class="checkbox-label">
        <input type="checkbox" id="${prefix}-enabled" ${assertion.enabled ? 'checked' : ''}>
        Verify ${escapeHtml(title.toLowerCase())}
      </label>
    </div>
    <fieldset id="${prefix}-fields" ${assertion.enabled ? '' : 'disabled'} style="border:1px solid #ddd;border-radius:6px;padding:12px;margin:0 0 12px">
      <legend style="padding:0 6px;font-weight:600">${escapeHtml(title)}</legend>
      <div class="form-group">
        <label>${expectedLabel}</label>
        <textarea id="${prefix}-expected" rows="3" placeholder="${escapeAttr(expectedPlaceholder)}">${escapeHtml(assertion.expected || '')}</textarea>
        <small>${helpText}</small>
      </div>
      <div class="form-group">
        <label>Match mode</label>
        <select id="${prefix}-match-mode">
          ${renderOptions(MATCH_MODES, assertion.match_mode)}
        </select>
      </div>
      ${matchAnyItemLabel ? `
      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" id="${prefix}-match-any-item" ${assertion.match_any_item ? 'checked' : ''}>
          ${matchAnyItemLabel}
        </label>
      </div>
      ` : ''}
      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" id="${prefix}-show-expected" ${assertion.show_expected ? 'checked' : ''}>
          ${showExpectedLabel}
        </label>
        <label class="checkbox-label">
          <input type="checkbox" id="${prefix}-show-actual" ${assertion.show_actual ? 'checked' : ''}>
          ${showActualLabel}
        </label>
      </div>
      <div class="form-group">
        <label>Success message</label>
        <textarea id="${prefix}-success-message" rows="2" placeholder="Optional message shown when this check passes">${escapeHtml(assertion.success_message || '')}</textarea>
      </div>
      <div class="form-group">
        <label>Failure message</label>
        <textarea id="${prefix}-failure-message" rows="2" placeholder="Optional message shown when this check fails">${escapeHtml(assertion.failure_message || '')}</textarea>
      </div>
    </fieldset>
  `;
}

function bindTextAssertionFields(prefix, assertion) {
  bindCheckedField(`${prefix}-enabled`, (checked) => {
    assertion.enabled = checked;
    toggleDisabledState(`${prefix}-fields`, !checked);
  });
  bindField(`${prefix}-expected`, (value) => { assertion.expected = value; });
  bindField(`${prefix}-match-mode`, (value) => { assertion.match_mode = value; });
  bindCheckedField(`${prefix}-match-any-item`, (checked) => { assertion.match_any_item = checked; });
  bindCheckedField(`${prefix}-show-expected`, (checked) => { assertion.show_expected = checked; });
  bindCheckedField(`${prefix}-show-actual`, (checked) => { assertion.show_actual = checked; });
  bindField(`${prefix}-success-message`, (value) => { assertion.success_message = value; });
  bindField(`${prefix}-failure-message`, (value) => { assertion.failure_message = value; });
}

/**
 * List assertion fieldset, shared by the variable editor and the function
 * return assertion. `prefix` is the field-group base, so the rendered ids are
 * `<prefix>-list-length-enabled`, `<prefix>-list-values`, … — the variable
 * editor passes `test`, the return editor `test-function-return`.
 */
function renderListAssertionEditor(prefix, listAssertions) {
  return `
    <fieldset style="border:1px solid #ddd;border-radius:6px;padding:12px;margin:0 0 12px">
      <legend style="padding:0 6px;font-weight:600">List assertions</legend>
      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" id="${prefix}-list-length-enabled" ${listAssertions.length_enabled ? 'checked' : ''}>
          Verify list length
        </label>
        <div style="display:flex;gap:8px;margin-top:8px">
          <select id="${prefix}-list-length-comparison" ${listAssertions.length_enabled ? '' : 'disabled'} style="flex:1">
            ${renderOptions(LIST_LENGTH_COMPARISONS, listAssertions.length_comparison)}
          </select>
          <input type="number" id="${prefix}-list-length-value" min="0" value="${listAssertions.length_value}" ${listAssertions.length_enabled ? '' : 'disabled'} style="flex:1">
        </div>
      </div>
      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" id="${prefix}-list-values-enabled" ${listAssertions.values_enabled ? 'checked' : ''}>
          Verify list values
        </label>
        <select id="${prefix}-list-values-mode" ${listAssertions.values_enabled ? '' : 'disabled'} style="margin-top:8px">
          ${renderOptions(LIST_VALUE_MATCH_MODES, listAssertions.values_match_mode)}
        </select>
        <textarea id="${prefix}-list-values" rows="4" placeholder='One expected list item per line. Use JSON for numbers, strings, booleans, nested lists, or objects.' ${listAssertions.values_enabled ? '' : 'disabled'}>${escapeHtml(formatStructuredValueList(listAssertions.expected_values))}</textarea>
        <small>Examples: <code>1</code>, <code>"cow"</code>, <code>[1,2]</code>. Plain unquoted text is treated as a string.</small>
      </div>
      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" id="${prefix}-list-item-types-enabled" ${listAssertions.item_types_enabled ? 'checked' : ''}>
          Verify item types
        </label>
        <select id="${prefix}-list-item-types-mode" ${listAssertions.item_types_enabled ? '' : 'disabled'} style="margin-top:8px">
          ${renderOptions(LIST_ITEM_TYPE_MODES, listAssertions.item_type_mode)}
        </select>
        <input type="text" id="${prefix}-list-item-types" value="${escapeAttr(formatTypeList(listAssertions.expected_item_types))}" placeholder="int, string" ${listAssertions.item_types_enabled ? '' : 'disabled'}>
        <small>Allowed item types: ${ITEM_TYPE_HELP}.</small>
      </div>
      <div class="form-group">
        <label>Specific index checks</label>
        <textarea id="${prefix}-list-index-checks" rows="4" placeholder='One JSON object per line, e.g. {"index":0,"expected_value":"cow"} or {"index":1,"expected_type":"int"}'>${escapeHtml(formatIndexChecks(listAssertions.index_checks))}</textarea>
        <small>Asserts a value or type at one index of the list. Leave blank to skip index-based checks.</small>
      </div>
    </fieldset>
  `;
}

function bindListAssertionFields(prefix, listAssertions) {
  bindCheckedField(`${prefix}-list-length-enabled`, (checked) => {
    listAssertions.length_enabled = checked;
    toggleDisabledState(`${prefix}-list-length-comparison`, !checked);
    toggleDisabledState(`${prefix}-list-length-value`, !checked);
  });
  bindField(`${prefix}-list-length-comparison`, (value) => { listAssertions.length_comparison = value; });
  bindField(`${prefix}-list-length-value`, (value) => {
    listAssertions.length_value = Math.max(0, parseInt(value, 10) || 0);
  });
  bindCheckedField(`${prefix}-list-values-enabled`, (checked) => {
    listAssertions.values_enabled = checked;
    toggleDisabledState(`${prefix}-list-values-mode`, !checked);
    toggleDisabledState(`${prefix}-list-values`, !checked);
  });
  bindField(`${prefix}-list-values-mode`, (value) => { listAssertions.values_match_mode = value; });
  bindParsedField(`${prefix}-list-values`, parseStructuredValueList, (values) => {
    listAssertions.expected_values = values;
  });
  bindCheckedField(`${prefix}-list-item-types-enabled`, (checked) => {
    listAssertions.item_types_enabled = checked;
    toggleDisabledState(`${prefix}-list-item-types-mode`, !checked);
    toggleDisabledState(`${prefix}-list-item-types`, !checked);
  });
  bindField(`${prefix}-list-item-types-mode`, (value) => { listAssertions.item_type_mode = value; });
  bindParsedField(`${prefix}-list-item-types`, parseTypeList, (types) => {
    listAssertions.expected_item_types = types;
  });
  bindParsedField(`${prefix}-list-index-checks`, parseIndexChecks, (checks) => {
    listAssertions.index_checks = checks;
  });
}

function renderReturnAssertionEditor(prefix, assertion) {
  const expectedType = normalizeVariableType(assertion.expected_type);
  const comparison = assertion.comparison || 'equals';
  const listAssertions = getVariableListAssertions(assertion);

  return `
    <div class="form-group">
      <label class="checkbox-label">
        <input type="checkbox" id="${prefix}-enabled" ${assertion.enabled ? 'checked' : ''}>
        Call the function and verify its return value or type
      </label>
    </div>
    <fieldset id="${prefix}-fields" ${assertion.enabled ? '' : 'disabled'} style="border:1px solid #ddd;border-radius:6px;padding:12px;margin:0 0 12px">
      <legend style="padding:0 6px;font-weight:600">Return assertion</legend>
      <div class="form-group">
        <label>Arguments</label>
        <input type="text" id="${prefix}-arguments" class="mono" value="${escapeAttr(formatJsonArray(assertion.arguments))}" placeholder='e.g. [1, "cow"]'>
        <small>A JSON array with one entry per argument: numbers, strings, booleans, null, lists, or objects.</small>
      </div>
      <div class="form-group">
        <label>Expected return type</label>
        <select id="${prefix}-type">
          ${renderOptions(VARIABLE_TYPES, expectedType)}
        </select>
      </div>
      ${expectedType !== 'list' ? `
      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" id="${prefix}-value-enabled" ${assertion.value_assertion_enabled ? 'checked' : ''}>
          Verify the return value
        </label>
      </div>
      <fieldset id="${prefix}-value-fields" ${assertion.value_assertion_enabled ? '' : 'disabled'} style="border:1px solid #ddd;border-radius:6px;padding:12px;margin:0 0 12px">
        <legend style="padding:0 6px;font-weight:600">Scalar return-value assertion</legend>
        <div class="form-group">
          <label>Expected value</label>
          <input type="text" id="${prefix}-expected" value="${escapeAttr(formatScalarExpectedValue(assertion.expected_value))}" placeholder="${escapeAttr(getScalarValuePlaceholder(expectedType, comparison))}">
          <small>${getScalarValueHelpText(expectedType, comparison)}</small>
        </div>
        <div class="form-group">
          <label>Comparison</label>
          <select id="${prefix}-comparison">
            ${renderOptions(COMPARISONS, comparison)}
          </select>
        </div>
        <div class="form-group">
          <label class="checkbox-label">
            <input type="checkbox" id="${prefix}-coercion-hint" ${assertion.show_coerced_value_hint ? 'checked' : ''}>
            Show a hint when the coerced return value matches but the type is wrong
          </label>
        </div>
      </fieldset>
      ` : `
      <div class="form-group">
        <small>List return values can be checked by length, contents, item types, and specific index checks. Leave every list assertion disabled if you only want to assert that the function returns a list.</small>
      </div>
      ${renderListAssertionEditor(prefix, listAssertions)}
      `}
      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" id="${prefix}-show-expected" ${assertion.show_expected ? 'checked' : ''}>
          Show expected return value when this check fails
        </label>
        <label class="checkbox-label">
          <input type="checkbox" id="${prefix}-show-actual" ${assertion.show_actual ? 'checked' : ''}>
          Show actual return value when this check fails
        </label>
      </div>
      <div class="form-group">
        <label>Success message</label>
        <textarea id="${prefix}-success-message" rows="2" placeholder="Optional message shown when the return assertion passes">${escapeHtml(assertion.success_message || '')}</textarea>
      </div>
      <div class="form-group">
        <label>Failure message</label>
        <textarea id="${prefix}-failure-message" rows="2" placeholder="Optional message shown when the return assertion fails">${escapeHtml(assertion.failure_message || '')}</textarea>
      </div>
    </fieldset>
  `;
}

function bindReturnAssertionFields(prefix, assertion, rerender) {
  bindCheckedField(`${prefix}-enabled`, (checked) => {
    assertion.enabled = checked;
    toggleDisabledState(`${prefix}-fields`, !checked);
  });
  bindParsedField(`${prefix}-arguments`, parseJsonArray, (values) => {
    assertion.arguments = values;
  });
  bindField(`${prefix}-type`, (value) => {
    assertion.expected_type = value;
    if (value === 'list') assertion.value_assertion_enabled = false;
    rerender();
  });

  if (normalizeVariableType(assertion.expected_type) !== 'list') {
    bindCheckedField(`${prefix}-value-enabled`, (checked) => {
      assertion.value_assertion_enabled = checked;
      toggleDisabledState(`${prefix}-value-fields`, !checked);
    });
    bindField(`${prefix}-expected`, (value) => {
      assertion.expected_value = parseScalarExpectedValue(value, assertion.expected_type, assertion.comparison);
    });
    bindField(`${prefix}-comparison`, (value) => {
      assertion.comparison = value;
      rerender();
    });
    bindCheckedField(`${prefix}-coercion-hint`, (checked) => {
      assertion.show_coerced_value_hint = checked;
    });
  } else {
    bindListAssertionFields(prefix, assertion.list_assertions);
  }

  bindCheckedField(`${prefix}-show-expected`, (checked) => { assertion.show_expected = checked; });
  bindCheckedField(`${prefix}-show-actual`, (checked) => { assertion.show_actual = checked; });
  bindField(`${prefix}-success-message`, (value) => { assertion.success_message = value; });
  bindField(`${prefix}-failure-message`, (value) => { assertion.failure_message = value; });
}

// — file_state fields —

function bindFileNameFields(testCase) {
  const pathInput = document.getElementById('test-file-path');
  if (!pathInput) return;

  const applyPathValidity = () => markValidity(pathInput, isValidActivityPath(pathInput.value), PATH_HELP);
  applyPathValidity();

  pathInput.addEventListener('input', () => {
    applyPathValidity();
    // An unusable path never reaches the config; the input keeps the typo.
    if (!isValidActivityPath(pathInput.value)) return;
    testCase.path = pathInput.value;
    emitLocalTestChange();
  });
}

function renderCsvAssertionsBlock(csvAssertions) {
  const rowCount = csvAssertions.row_count === null || csvAssertions.row_count === undefined
    ? ''
    : String(csvAssertions.row_count);

  return `
    <fieldset style="border:1px solid #ddd;border-radius:6px;padding:12px;margin:0 0 12px">
      <legend style="padding:0 6px;font-weight:600">CSV assertions</legend>
      <div class="form-group">
        <label>Row count</label>
        <div style="display:flex;gap:8px">
          <select id="test-csv-row-count-comparison" style="flex:1">
            ${renderOptions(CSV_ROW_COUNT_COMPARISONS, csvAssertions.row_count_comparison || 'equals')}
          </select>
          <input type="number" id="test-csv-row-count" min="0" style="flex:1" placeholder="not checked" value="${escapeAttr(rowCount)}">
        </div>
        <small>Leave the number empty to skip the row-count check. Header and data rows both count.</small>
      </div>
      <div class="form-group">
        <label>Header row</label>
        <textarea id="test-csv-header" rows="3" placeholder="One header value per line">${escapeHtml(formatHeaderList(csvAssertions.header))}</textarea>
        <small>One column value per line, compared against the first row. Empty means the header is not checked.</small>
      </div>
      <div class="form-group">
        <label>Cell checks</label>
        <div id="test-csv-cells"></div>
        <div style="margin-top:6px">
          <button type="button" id="test-csv-add-cell" class="btn btn-small btn-secondary">+ Add cell check</button>
        </div>
        <small>Rows and columns are zero-based; the header row is row 0.</small>
      </div>
    </fieldset>
  `;
}

function bindCsvAssertionFields(testCase) {
  const csvAssertions = csvAssertionsOf(testCase);

  bindField('test-csv-row-count', (value) => {
    if (String(value).trim() === '') {
      delete csvAssertions.row_count;
      return;
    }
    csvAssertions.row_count = Math.max(0, Math.trunc(Number(value) || 0));
  });
  bindField('test-csv-row-count-comparison', (value) => {
    csvAssertions.row_count_comparison = value;
  });
  bindParsedField('test-csv-header', parseHeaderList, (headers) => {
    if (headers.length === 0) delete csvAssertions.header;
    else csvAssertions.header = headers;
  });

  const container = document.getElementById('test-csv-cells');
  const addButton = document.getElementById('test-csv-add-cell');
  if (!container || !addButton) return;

  const renderRows = () => {
    container.innerHTML = '';
    csvAssertions.cells.forEach((cell, index) => {
      container.appendChild(buildCsvCellRow(csvAssertions, cell, index, renderRows));
    });
  };

  addButton.addEventListener('click', () => {
    csvAssertions.cells.push({ row: 0, column: 0, comparison: 'equals', expected_type: 'any' });
    renderRows();
    emitLocalTestChange();
  });

  renderRows();
}

function buildCsvCellRow(csvAssertions, cell, index, rerender) {
  const row = document.createElement('div');
  row.className = 'form-row';
  row.style.alignItems = 'center';
  row.style.gap = '8px';

  const rowInput = createNumberInput(cell.row, { title: 'Row (zero-based, header row is 0)' });
  rowInput.addEventListener('input', () => {
    cell.row = Math.max(0, Math.trunc(Number(rowInput.value) || 0));
    emitLocalTestChange();
  });

  const columnInput = createNumberInput(cell.column, { title: 'Column (zero-based)' });
  columnInput.addEventListener('input', () => {
    cell.column = Math.max(0, Math.trunc(Number(columnInput.value) || 0));
    emitLocalTestChange();
  });

  const valueInput = document.createElement('input');
  valueInput.type = 'text';
  valueInput.placeholder = 'Expected value';
  valueInput.title = 'Expected cell value';
  valueInput.style.flex = '1';
  valueInput.value = cell.expected_value === undefined ? '' : formatCellExpectedValue(cell.expected_value);
  const refreshValidity = () => {
    // A cell check needs a value, a type, or both (the validator's rule); the
    // runtime compares the cell value only when one is configured.
    const missing = cell.expected_value === undefined
      && normalizeVariableType(cell.expected_type) === 'any';
    markValidity(valueInput, !missing, 'Set an expected value, an expected type, or both');
  };
  valueInput.addEventListener('input', () => {
    if (valueInput.value === '') delete cell.expected_value;
    else cell.expected_value = parseStructuredValueLine(valueInput.value);
    refreshValidity();
    emitLocalTestChange();
  });
  refreshValidity();

  const comparisonSelect = createSelect(CSV_CELL_COMPARISONS, cell.comparison || 'equals', 'Comparison');
  comparisonSelect.addEventListener('change', () => {
    cell.comparison = comparisonSelect.value;
    emitLocalTestChange();
  });

  const typeSelect = createSelect(VARIABLE_TYPES, normalizeVariableType(cell.expected_type), 'Expected cell type');
  typeSelect.addEventListener('change', () => {
    cell.expected_type = normalizeVariableType(typeSelect.value);
    refreshValidity();
    emitLocalTestChange();
  });

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'step-remove';
  removeButton.title = 'Remove this cell check';
  removeButton.textContent = '✕';
  removeButton.addEventListener('click', () => {
    csvAssertions.cells.splice(index, 1);
    rerender();
    emitLocalTestChange();
  });

  row.append(rowInput, columnInput, valueInput, comparisonSelect, typeSelect, removeButton);
  return row;
}

// — Small DOM helpers —

function bindField(id, setter) {
  const el = document.getElementById(id);
  if (!el) return;
  const event = el.tagName === 'SELECT' ? 'change' : 'input';
  el.addEventListener(event, (domEvent) => {
    setter(domEvent.target.value);
    emitLocalTestChange();
  });
}

function bindParsedField(id, parser, setter) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', (event) => {
    try {
      const parsed = parser(event.target.value);
      event.target.setCustomValidity('');
      setter(parsed);
      emitLocalTestChange();
    } catch (err) {
      event.target.setCustomValidity(err instanceof Error ? err.message : String(err));
    }
  });
}

function bindCheckedField(id, setter) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('change', (event) => {
    setter(event.target.checked);
    emitLocalTestChange();
  });
}

function toggleDisabledState(id, disabled) {
  const el = document.getElementById(id);
  if (el) el.disabled = disabled;
}

function createNumberInput(value, { min = 0, width = '72px', title = '' } = {}) {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min);
  input.value = String(Math.max(0, Math.trunc(Number(value) || 0)));
  input.style.width = width;
  if (title) input.title = title;
  return input;
}

function createSelect(options, selected, title = '') {
  const select = document.createElement('select');
  if (title) select.title = title;
  for (const option of options) {
    const el = document.createElement('option');
    el.value = option.value;
    el.textContent = option.label;
    el.selected = option.value === selected;
    select.appendChild(el);
  }
  return select;
}

/** Toggle the invalid look on an input. `.field-invalid` has no stylesheet rule, so the border is set inline. */
function markValidity(input, valid, message) {
  input.classList.toggle('field-invalid', !valid);
  input.style.borderColor = valid ? '' : INVALID_COLOR;
  if (valid) input.removeAttribute('title');
  else if (message) input.setAttribute('title', message);
}

// — Config helpers —

function emitLocalTestChange() {
  suppressSelectedTestEditorSync = true;
  try {
    notifyChange();
  } finally {
    suppressSelectedTestEditorSync = false;
  }
}

function updatePointsIndicator() {
  const el = document.getElementById('weight-indicator');
  if (!el) return;

  const list = tests();
  const total = list.reduce((sum, testCase) => sum + getTestPoints(testCase), 0);

  if (list.length === 0) {
    el.className = '';
    el.textContent = 'No test cases yet.';
  } else if (total > 0) {
    el.className = 'weight-ok';
    el.textContent = `✓ Total available points: ${total}`;
  } else {
    el.className = 'weight-error';
    el.textContent = '✗ All tests are worth 0 points — no score possible';
  }
}

function formatPointsLabel(points) {
  return `${points} point${points === 1 ? '' : 's'}`;
}

function createTestId(list) {
  const base = `test_${Date.now().toString(36)}`;
  let id = base;
  let counter = 1;
  while (list.some((testCase) => testCase.id === id)) {
    counter += 1;
    id = `${base}_${counter}`;
  }
  return id;
}

function createTextAssertion(overrides = {}) {
  return normalizeRuntimeTextAssertion({}, overrides);
}

function createCsvAssertions() {
  // `row_count` and `header` are omitted until the author sets them: null is
  // how the shared shape says "not asserted", but it is not valid config.
  return { row_count_comparison: 'equals', cells: [] };
}

function csvAssertionsOf(testCase) {
  if (!isObjectLike(testCase.csv_assertions)) testCase.csv_assertions = createCsvAssertions();
  const csvAssertions = testCase.csv_assertions;
  if (!Array.isArray(csvAssertions.cells)) csvAssertions.cells = [];
  return csvAssertions;
}

function setupFilesOf(testCase) {
  if (!Array.isArray(testCase.setup_files)) testCase.setup_files = [];
  return testCase.setup_files;
}

function ensurePromptInputs(testCase) {
  testCase.prompt_inputs = getPromptInputs(testCase);
  return testCase.prompt_inputs;
}

function isValidActivityPath(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (value.length > MAX_FILE_PATH_LENGTH) return false;
  if (value.startsWith('/') || value.includes('\\')) return false;
  if (!PATH_PATTERN.test(value)) return false;
  if (value.split('/').includes('..')) return false;
  return true;
}

function isObjectLike(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepClone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

// — Value formatting / parsing —

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function renderOptions(options, selected) {
  return options
    .map((option) => `<option value="${escapeAttr(option.value)}" ${option.value === selected ? 'selected' : ''}>${escapeHtml(option.label)}</option>`)
    .join('');
}

function toOptions(values, labels) {
  return values.map((value) => ({ value, label: labels[value] || value }));
}

function formatScalarExpectedValue(value) {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseScalarExpectedValue(value, expectedType, comparison) {
  if (comparison === 'contains') return value;

  switch (normalizeVariableType(expectedType)) {
    case 'string':
      return value;
    case 'int':
    case 'float': {
      if (value.trim() === '') return value;
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : value;
    }
    case 'bool': {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
      return value;
    }
    case 'null': {
      const normalized = value.trim().toLowerCase();
      return normalized === '' || normalized === 'null' || normalized === 'none' ? null : value;
    }
    case 'list':
    case 'tuple':
    case 'dict':
      return parseStructuredValueLine(value);
    default:
      return parseStructuredValueLine(value);
  }
}

function getScalarValuePlaceholder(expectedType, comparison) {
  if (comparison === 'contains') return 'e.g. ow';
  switch (normalizeVariableType(expectedType)) {
    case 'string':
      return 'e.g. cow';
    case 'int':
      return 'e.g. 3';
    case 'float':
      return 'e.g. 3.14';
    case 'bool':
      return 'e.g. true';
    case 'null':
      return 'e.g. null';
    case 'list':
    case 'tuple':
      return 'e.g. [1, 2, 3]';
    case 'dict':
      return 'e.g. {"a": 1}';
    default:
      return 'e.g. 3 or cow';
  }
}

function getScalarValueHelpText(expectedType, comparison) {
  if (comparison === 'contains') {
    return 'Passes when the expected text appears anywhere in the value.';
  }
  switch (normalizeVariableType(expectedType)) {
    case 'string':
      return 'Entered text is compared as a string.';
    case 'int':
    case 'float':
      return 'Entered text is parsed as a number for numeric comparisons.';
    case 'bool':
      return '<code>true</code> and <code>false</code> become a boolean; anything else stays text.';
    case 'null':
      return 'Empty, <code>null</code>, or <code>none</code> become Python <code>None</code>.';
    case 'list':
    case 'tuple':
    case 'dict':
      return 'Enter a JSON value, e.g. <code>[1, 2]</code> or <code>{"a": 1}</code>.';
    default:
      return 'Numbers, <code>true</code>/<code>false</code>, <code>null</code>, and JSON lists or objects are parsed; everything else is treated as text.';
  }
}

function formatStructuredValueList(values) {
  if (!Array.isArray(values) || values.length === 0) return '';
  return values.map((value) => formatStructuredValue(value)).join('\n');
}

function parseStructuredValueList(text) {
  if (text.trim() === '') return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map(parseStructuredValueLine);
}

function formatStructuredValue(value) {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? String(value) : encoded;
}

/** JSON when the line parses, otherwise the plain string the author typed. */
function parseStructuredValueLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return line;
  }
}

function formatCellExpectedValue(value) {
  return typeof value === 'string' ? value : formatStructuredValue(value);
}

function formatTypeList(types) {
  return Array.isArray(types) ? types.join(', ') : '';
}

function parseTypeList(text) {
  if (text.trim() === '') return [];
  return text
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter((part) => part !== '' && part !== 'any')
    .map((part) => {
      if (!ITEM_TYPE_CHOICES.includes(part)) {
        throw new Error(`Unknown item type "${part}". Allowed: ${ITEM_TYPE_HELP}.`);
      }
      return part;
    });
}

function formatIndexChecks(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return '';
  return checks.map((check) => JSON.stringify(check)).join('\n');
}

function parseIndexChecks(text) {
  if (text.trim() === '') return [];

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error('Each index check line must be valid JSON.');
      }
      if (!isObjectLike(parsed)) {
        throw new Error('Each index check line must be a JSON object.');
      }
      if (!Number.isInteger(parsed.index) || parsed.index < 0) {
        throw new Error('Each index check needs a non-negative integer "index".');
      }
      const [check] = normalizeListIndexChecks([parsed]);
      if (check.expected_value === undefined && normalizeVariableType(check.expected_type) === 'any') {
        throw new Error('Each index check must define expected_value, expected_type, or both.');
      }
      return check;
    });
}

function formatJsonArray(values) {
  return JSON.stringify(Array.isArray(values) ? values : []);
}

function parseJsonArray(text) {
  if (text.trim() === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Arguments must be a JSON array, e.g. ["Ada", 1].');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Arguments must be a JSON array, e.g. ["Ada", 1].');
  }
  return parsed;
}

function formatHeaderList(header) {
  return Array.isArray(header) ? header.join('\n') : '';
}

function parseHeaderList(text) {
  if (text.trim() === '') return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

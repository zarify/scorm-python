/**
 * App Controller — main orchestrator for the Python SCORM activity.
 *
 * Flow: init SCORM → load/validate/normalize config → render UI → mount the
 * CodeMirror editor → restore persisted code → start the Python engine →
 * hints → interact (Run/Check/Reset) → report score.
 *
 * Console replay semantics: the UI keeps one buffer per attempt. When an
 * interactive run replays after an input answer, the attempt counter advances
 * and the buffer is replaced, so the latest attempt always displays as one
 * coherent transcript.
 */

import * as scorm from './scorm-wrapper.js';
import { createWorkspacePersistence } from './workspace-persistence.js';
import { SUSPEND_DATA_MAX_LENGTH } from './workspace-state-codec.js';
import { executeInteractiveRun, runTests } from './test-runner.js';
import { initHintEngine, onTestFail, requestManualHint, notifyCodeChange } from './hint-engine.js';
import { createPythonEngine } from './python-engine.js';
import { renderInlineMarkdown } from '../../shared/inline-markdown.js';
import { validateConfig } from '../../shared/config-validator.js';
import { normalizeConfig } from '../../shared/config-normalizer.js';
import { basicSetup } from 'codemirror';
import { EditorView } from '@codemirror/view';
import { python } from '@codemirror/lang-python';

let config = null;
let attemptCount = 0;
let engine = null;
let editor = null;
let persistence = null;
let activeInteractiveRun = null;
let isResultsModalCloseLocked = false;
let codeSaveTimer = null;
let interactiveConsoleState = null;
let lastFiles = {};
let consoleAttempt = null;
let consoleBuffer = '';
let consolePaintHandle = null;
const CODE_SAVE_DEBOUNCE_MS = 1000;
const PREVIEW_CONFIG_GLOBAL = '__BLOCKLY_SCORM_PREVIEW_CONFIG__';
const PREVIEW_MODE_GLOBAL = '__BLOCKLY_SCORM_PREVIEW_MODE__';

async function init() {
  // 1. SCORM session
  const lmsConnected = scorm.init();
  const embeddedPreview = isEmbeddedPreview();
  if (!lmsConnected) {
    showStatus(
      embeddedPreview
        ? 'Author preview mode — testing the real student runtime without Moodle.'
        : 'Running in preview mode (not connected to LMS)',
      'info',
    );
  }

  // 2. Config: load → validate (console warning only) → normalize
  try {
    const raw = await loadConfig();
    config = normalizeConfig(raw);
    const validation = validateConfig(config);
    if (!validation.valid) {
      console.warn('[App] Activity config has validation issues:', validation.errors);
    }
  } catch (err) {
    showStatus(`Failed to load activity config: ${err.message}`, 'error');
    return;
  }

  // 3. Static UI
  renderInstructions(config);
  renderUISettings(config);

  // 4. Python engine
  engine = createPythonEngine({
    onStatus: handleEngineStatus,
    pythonSetup: config.python_setup || {},
  });

  persistence = createWorkspacePersistence({
    activityId: config.metadata?.activity_id || '',
    studentId: scorm.getStudentId(),
    limit: config.ui_settings?.suspend_data_limit ?? SUSPEND_DATA_MAX_LENGTH,
    onWarning: (message) => showStatus(message, 'warning'),
  });

  createEditor(document.getElementById('editor'), config.python_setup?.starter_code ?? '');
  const restoreResult = await restoreSavedCode();
  watchCodeChanges();
  persistence.markCurrent(currentCodeState());

  // 5. Modal, tabs, controls, lifecycle
  setupResultsModal();
  document.getElementById('btn-run').addEventListener('click', handleRun);
  document.getElementById('btn-stop').addEventListener('click', handleStop);
  document.getElementById('btn-check').addEventListener('click', handleCheck);
  document.getElementById('btn-reset').addEventListener('click', handleReset);
  configureHintRequestButton(config);

  window.addEventListener('pagehide', (event) => {
    flushCodeSave();
    if (event.persisted) {
      scorm.flushPendingWrites();
      return;
    }
    scorm.terminate();
  });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted || scorm.isPreviewMode() || scorm.resume()) return;
    showStatus('Lost the connection to the LMS. Reload the page to keep saving progress.', 'warning');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    flushCodeSave();
    scorm.flushPendingWrites();
  });

  // 6. Python runtime — hints start once the runtime can analyze conditions.
  try {
    await engine.ready();
  } catch {
    // handleEngineStatus already showed the failure banner.
  }

  initHintEngine({
    hints: config.hints || [],
    engine,
    ui: {
      panel: document.getElementById('hint-panel'),
      enabled: areHintsEnabled(config),
      getSource: () => editorValue(),
      onRequestAvailabilityChange: updateHintRequestButtonState,
    },
  });

  if (restoreResult.restored) {
    showStatus('Welcome back — your saved code has been restored.', 'info');
    return;
  }
  if (restoreResult.notice) {
    showStatus(restoreResult.notice, 'warning');
    return;
  }
  showStatus(
    embeddedPreview
      ? 'Preview ready. Write code, run it, check tests, and request hints.'
      : 'Activity loaded. Write your program, then click "Run" or "Check".',
    'info',
  );
}

function handleEngineStatus(state, detail) {
  if (state === 'loading') {
    showStatus('Loading Python runtime…', 'info');
  } else if (state === 'error') {
    showStatus(
      `Python runtime failed to load — check your connection and reload${detail ? ` (${detail})` : ''}`,
      'error',
    );
  }
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

function createEditor(container, initialValue) {
  editor = new EditorView({
    doc: initialValue || '',
    parent: container,
    extensions: [
      basicSetup,
      python(),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          handleCodeChanged();
        }
      }),
    ],
  });
}

function editorValue() {
  return editor ? editor.state.doc.toString() : '';
}

function setEditorValue(text) {
  if (!editor) return;
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: text ?? '' },
  });
}

function handleCodeChanged() {
  notifyCodeChange();
  scheduleCodeSave();
}

// ---------------------------------------------------------------------------
// Two-layer persistence (suspend_data + IndexedDB), payload {code}
// ---------------------------------------------------------------------------

function currentCodeState() {
  return { code: editorValue() };
}

async function restoreSavedCode() {
  const restored = await persistence.restore();
  if (!restored.state || typeof restored.state.code !== 'string') {
    return { restored: false, notice: restored.notice };
  }
  try {
    setEditorValue(restored.state.code);
    return { restored: true, notice: null };
  } catch (err) {
    console.warn('[App] Could not restore saved code:', err.message);
    return { restored: false, notice: null };
  }
}

function watchCodeChanges() {
  if (scorm.isPreviewMode()) return;
  // handleCodeChanged (from the editor listener) already debounces saves.
}

function scheduleCodeSave() {
  if (!persistence || scorm.isPreviewMode()) return;
  clearTimeout(codeSaveTimer);
  codeSaveTimer = setTimeout(() => {
    codeSaveTimer = null;
    saveCode();
  }, CODE_SAVE_DEBOUNCE_MS);
}

function saveCode() {
  if (!persistence) return;
  persistence.persist(currentCodeState()).catch((err) => {
    console.warn('[App] Could not save code:', err.message);
  });
}

function flushCodeSave() {
  clearTimeout(codeSaveTimer);
  codeSaveTimer = null;
  persistence?.persistNow(currentCodeState());
}

function discardSavedCode() {
  clearTimeout(codeSaveTimer);
  codeSaveTimer = null;
  persistence?.discard(currentCodeState()).catch((err) => {
    console.warn('[App] Could not discard saved code:', err.message);
  });
}

// ---------------------------------------------------------------------------
// Config loading + rendering
// ---------------------------------------------------------------------------

async function loadConfig() {
  const previewConfig = window[PREVIEW_CONFIG_GLOBAL];
  if (previewConfig) {
    return cloneConfig(previewConfig);
  }

  const resp = await fetch('config/activity_config.json');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function renderInstructions(cfg) {
  const panel = document.getElementById('instructions-panel');
  if (!panel) return;
  const hintPanel = panel.querySelector('#hint-panel');
  hintPanel?.remove();

  let html = '';
  if (cfg.metadata?.title) {
    html += `<h2 class="formatted-text">${renderInlineMarkdown(cfg.metadata.title)}</h2>`;
  }
  if (cfg.instructions?.main) {
    html += `<p class="instruction-main formatted-text">${renderInlineMarkdown(cfg.instructions.main)}</p>`;
  }
  if (cfg.instructions?.steps?.length > 0) {
    html += '<ol class="instruction-steps">';
    for (const step of cfg.instructions.steps) {
      html += `<li class="formatted-text">${renderInlineMarkdown(step)}</li>`;
    }
    html += '</ol>';
  }
  panel.innerHTML = html;
  if (hintPanel) {
    panel.appendChild(hintPanel);
  }
}

function renderUISettings(cfg) {
  const hintPanel = document.getElementById('hint-panel');
  if (hintPanel) {
    hintPanel.style.display = areHintsEnabled(cfg) ? '' : 'none';
  }
}

function activityFiles() {
  return Array.isArray(config?.python_setup?.files) ? config.python_setup.files : [];
}

function areHintsEnabled(cfg) {
  return cfg.ui_settings?.show_hint_panel !== false;
}

function shouldRequirePreviousTestPass(cfg) {
  return cfg?.evaluation?.require_previous_test_pass !== false;
}

// ---------------------------------------------------------------------------
// Run (interactive, replay-per-answer)
// ---------------------------------------------------------------------------

async function handleRun() {
  setExecutionButtonState({ running: true });

  try {
    document.activeElement?.blur?.();
    setResultsModalTitle('Run console');
    renderInteractiveConsole();
    setActiveResultsTab('console');
    openResultsModal();
    await waitForNextPaint();

    const runControl = {
      cancelled: false,
      cancel() {
        if (this.cancelled) return;
        this.cancelled = true;
        engine.cancel();
      },
    };
    activeInteractiveRun = runControl;

    const execution = await executeInteractiveRun({
      source: editorValue(),
      activityFiles: activityFiles(),
      engine,
      hooks: {
        onStdout: handleRunStdout,
        requestInput: requestConsoleInput,
      },
    });

    finalizeInteractiveConsole(execution);
    renderFilesPanel(execution.files || {});

    if (execution.cancelled || execution.status === 'cancelled') {
      showStatus('Run stopped.', 'info');
    } else if (execution.status === 'done') {
      showStatus('Program finished.', 'info');
    } else {
      showStatus(`Program stopped: ${describeRunFailure(execution)}`, 'error');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finalizeInteractiveConsole({
      status: 'error',
      cancelled: false,
      error: { message, traceback: null },
      files: {},
    });
    renderFilesPanel({});
    showStatus(`Error: ${message}`, 'error');
  } finally {
    activeInteractiveRun = null;
    setResultsModalClosable(true);
    setExecutionButtonState();
  }
}

function handleStop() {
  activeInteractiveRun?.cancel();
}

function describeRunFailure(execution) {
  if (execution.status === 'syntax_error' && execution.syntaxError) {
    return `SyntaxError: ${execution.syntaxError.message} (line ${execution.syntaxError.line})`;
  }
  return execution.error?.message || execution.friendly || 'Program stopped.';
}

// ---------------------------------------------------------------------------
// Interactive console
// ---------------------------------------------------------------------------

function renderInteractiveConsole() {
  const panel = document.getElementById('output-panel');
  if (!panel) return;

  panel.innerHTML = `
    <div class="console-shell">
      <div class="console-transcript" data-console-transcript aria-live="polite" aria-label="Program console output"></div>
    </div>
  `;

  interactiveConsoleState = {
    transcriptEl: panel.querySelector('[data-console-transcript]'),
    isRunning: true,
  };
  consoleAttempt = null;
  consoleBuffer = '';
  cancelConsolePaint();
}

function handleRunStdout(text, attempt) {
  if (!interactiveConsoleState?.transcriptEl) return;
  // A new attempt replaces the buffer: replays show one coherent transcript.
  if (consoleAttempt === null || attempt !== consoleAttempt) {
    consoleAttempt = attempt;
    consoleBuffer = '';
  }
  consoleBuffer += text;
  queueConsolePaint();
}

function cancelConsolePaint() {
  if (consolePaintHandle !== null) {
    cancelAnimationFrame(consolePaintHandle);
    consolePaintHandle = null;
  }
}

function queueConsolePaint() {
  if (consolePaintHandle !== null) return;
  consolePaintHandle = requestAnimationFrame(() => {
    consolePaintHandle = null;
    paintConsole();
  });
}

function paintConsole() {
  const el = interactiveConsoleState?.transcriptEl;
  if (!el) return;
  el.textContent = consoleBuffer;
  el.scrollTop = el.scrollHeight;
}

function flushConsolePaint() {
  cancelConsolePaint();
  paintConsole();
}

function appendConsoleRow(type, text, badge) {
  const state = interactiveConsoleState;
  if (!state?.transcriptEl) return;

  // Any queued full-buffer paint would wipe rows appended below.
  flushConsolePaint();

  const row = document.createElement('div');
  row.className = `console-entry console-entry-${type}`;

  const badgeEl = document.createElement('span');
  badgeEl.className = 'console-entry-badge';
  badgeEl.textContent = badge || getConsoleBadge(type);

  const valueEl = document.createElement('span');
  valueEl.className = 'console-entry-value';
  valueEl.textContent = text == null || text === '' ? ' ' : String(text);

  row.append(badgeEl, valueEl);
  state.transcriptEl.appendChild(row);
  state.transcriptEl.scrollTop = state.transcriptEl.scrollHeight;
}

function appendTraceback(traceback) {
  const state = interactiveConsoleState;
  if (!state?.transcriptEl) return;
  const pre = document.createElement('pre');
  pre.className = 'output-console';
  pre.textContent = traceback;
  state.transcriptEl.appendChild(pre);
  state.transcriptEl.scrollTop = state.transcriptEl.scrollHeight;
}

function getConsoleBadge(type) {
  switch (type) {
    case 'error':
      return 'err';
    case 'status':
      return 'sys';
    case 'output':
    default:
      return 'out';
  }
}

function finalizeInteractiveConsole(execution) {
  // Stop (or a cancel) can kill a run while its dialog is parked.
  closeInputDialog();
  if (!interactiveConsoleState) return;
  interactiveConsoleState.isRunning = false;

  const status = execution.status
    || (execution.cancelled ? 'cancelled' : 'error');

  if (execution.cancelled || status === 'cancelled') {
    appendConsoleRow('status', 'Run stopped.', 'done');
  } else if (status === 'done') {
    if (!consoleBuffer) {
      appendConsoleRow('status', 'Program finished with no output.', 'done');
    } else {
      appendConsoleRow('status', 'Program finished.', 'done');
    }
  } else {
    appendConsoleRow('error', describeRunFailure(execution), 'error');
    if (execution.error?.traceback) {
      appendTraceback(execution.error.traceback);
    }
  }
}

function closeInputDialog() {
  const dialog = document.getElementById('input-dialog');
  if (!dialog) return;
  dialog.classList.add('hidden');
  dialog.setAttribute('aria-hidden', 'true');
}

async function requestConsoleInput(message) {
  return new Promise((resolve) => {
    const dialog = document.getElementById('input-dialog');
    const promptEl = document.getElementById('input-dialog-label');
    const field = document.getElementById('input-dialog-field');
    const okBtn = document.getElementById('btn-input-ok');
    const cancelBtn = document.getElementById('btn-input-cancel');
    if (!dialog || !promptEl || !field || !okBtn || !cancelBtn) {
      resolve(null);
      return;
    }

    promptEl.textContent = message || 'Input';
    field.value = '';

    const close = () => {
      dialog.classList.add('hidden');
      dialog.setAttribute('aria-hidden', 'true');
    };
    const done = (value) => {
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      field.onkeydown = null;
      close();
      resolve(value);
    };

    okBtn.onclick = () => done(field.value);
    cancelBtn.onclick = () => done(null);
    field.onkeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        done(field.value);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        done(null);
      }
    };

    dialog.classList.remove('hidden');
    dialog.setAttribute('aria-hidden', 'false');
    field.focus();
  });
}

// ---------------------------------------------------------------------------
// Files panel
// ---------------------------------------------------------------------------

function renderFilesPanel(files) {
  const panel = document.getElementById('files-panel');
  if (!panel) return;
  lastFiles = files || {};

  const entries = Object.entries(lastFiles).filter(([, record]) => record && record.exists);
  if (entries.length === 0) {
    panel.innerHTML = '<p class="output-placeholder">Run your program to see the files it produced.</p>';
    return;
  }

  panel.innerHTML = `<ul class="file-list">${entries.map(([path, record]) => `
    <li class="file-item">
      <button type="button" class="file-item-header" data-file-path="${escapeAttr(path)}">
        <span>${escapeHtml(path)}</span>
        ${record.text === null || record.text === undefined ? '<span class="file-item-binary">binary</span>' : ''}
        <span class="file-item-size">${formatBytes(record.size || 0)}</span>
      </button>
      <div class="file-item-body hidden" data-file-body></div>
    </li>`).join('')}</ul>`;

  panel.querySelectorAll('.file-item-header').forEach((button) => {
    button.addEventListener('click', () => toggleFileEntry(button));
  });
}

function toggleFileEntry(button) {
  const body = button.parentElement?.querySelector('[data-file-body]');
  if (!body) return;

  if (!body.classList.contains('hidden')) {
    body.classList.add('hidden');
    return;
  }

  const record = lastFiles[button.dataset.filePath] || {};
  if (typeof record.text === 'string') {
    body.innerHTML = `<pre>${escapeHtml(record.text)}</pre>`;
  } else {
    const label = record.decode_error ? 'Could not be decoded as UTF-8 — binary' : 'binary';
    body.innerHTML = `<pre>${escapeHtml(label)} (${record.size || 0} bytes)</pre>`;
  }
  body.classList.remove('hidden');
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  return `${(size / 1024).toFixed(1)} KB`;
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

async function handleCheck() {
  setExecutionButtonState({ checking: true });
  setResultsModalClosable(false);

  try {
    document.activeElement?.blur?.();
    flushCodeSave();

    const outcome = await runTests({
      testCases: config.evaluation?.test_cases || [],
      source: editorValue(),
      activityFiles: activityFiles(),
      engine,
      requirePreviousTestPass: shouldRequirePreviousTestPass(config),
    });

    setResultsModalTitle('Check results');
    renderCheckOutput(outcome.results, outcome.totalScore, outcome.maxScore, outcome.hasBlockedTests);
    setActiveResultsTab('console');
    openResultsModal();

    // reportScore's second parameter is a pass threshold (the wrapper keeps
    // the best score and a sticky pass). allPassed maps onto it directly:
    // 0 lets every score pass, 101 fails until an all-pass session happened.
    scorm.reportScore(outcome.lmsScore, outcome.allPassed ? 0 : 101);

    if (outcome.results.some((result) => !result.passed)) {
      attemptCount += 1;
      onTestFail(attemptCount);
    }
  } catch (err) {
    showStatus(`Error: ${err.message || err}`, 'error');
  } finally {
    setExecutionButtonState();
    setResultsModalClosable(true);
  }
}

function renderCheckOutput(results, totalScore, maxScore, hasBlockedTests = false) {
  const panel = document.getElementById('output-panel');
  if (!panel) return;
  interactiveConsoleState = null;
  setResultsModalClosable(true);

  if (!results.length) {
    panel.innerHTML = '<p class="output-empty">No automated checks are configured for this activity.</p>';
    return;
  }

  panel.innerHTML = buildCheckResultsHtml(results, totalScore, maxScore, hasBlockedTests);
}

function buildCheckResultsHtml(results, totalScore, maxScore, hasBlockedTests = false) {
  const percent = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;
  const allPassed = !hasBlockedTests && results.every((result) => result.passed);
  const allPassSubtitle = allPassed ? String(config?.evaluation?.feedback_on_all_pass || '').trim() : '';

  let html = '<div class="results-section">';
  html += `<div class="results-header ${allPassed ? 'results-pass' : 'results-fail'}">`;
  html += '<div class="results-title">';
  html += `<strong>${allPassed ? '✅ All automated checks passed!' : '❌ Some automated checks failed'}</strong>`;
  html += ` — Score: ${percent}%`;
  html += '</div>';
  if (allPassSubtitle) {
    html += `<div class="results-subtitle formatted-text">${renderInlineMarkdown(allPassSubtitle)}</div>`;
  }
  html += '</div>';
  html += '<ul class="results-list">';
  for (const result of results) {
    html += `<li class="${result.passed ? 'result-pass' : 'result-fail'} formatted-text">`;
    html += `<span class="result-icon">${result.passed ? '✓' : '✗'}</span> `;
    html += renderInlineMarkdown(result.feedback || '');
    if (result.student_detail) {
      html += renderStudentDetailHtml(result.student_detail);
    }
    html += '</li>';
  }
  if (hasBlockedTests) {
    html += '<li class="result-fail formatted-text"><span class="result-icon">…</span>Other tests remain unpassed.</li>';
  }
  html += '</ul></div>';
  return html;
}

function renderStudentDetailHtml(studentDetail) {
  if (typeof studentDetail === 'string') {
    return `<div class="result-detail-note formatted-text">${renderInlineMarkdown(studentDetail)}</div>`;
  }

  if (studentDetail && typeof studentDetail === 'object') {
    let html = '';
    if (typeof studentDetail.note === 'string' && studentDetail.note.trim()) {
      html += `<div class="result-detail-note formatted-text">${renderInlineMarkdown(studentDetail.note)}</div>`;
    }
    if (Array.isArray(studentDetail.sections)) {
      html += studentDetail.sections.map((section) => `
      <div class="result-detail-section">
        <div class="result-detail-title">${escapeHtml(section.title || '')}</div>
        <pre class="result-detail-value">${escapeHtml(section.value || '')}</pre>
      </div>
      `).join('');
    }
    return html;
  }

  return '';
}

// ---------------------------------------------------------------------------
// Reset + hints
// ---------------------------------------------------------------------------

function handleReset() {
  setEditorValue(config.python_setup?.starter_code ?? '');
  discardSavedCode();
  renderFilesPanel({});
  setOutputPlaceholder();
  closeResultsModal();
  showStatus('Editor reset to starter code.', 'info');
}

function handleHintRequest() {
  requestManualHint();
}

function configureHintRequestButton(cfg) {
  const hintButton = document.getElementById('btn-request-hint');
  if (!hintButton) return;

  if (!areHintsEnabled(cfg)) {
    hintButton.onclick = null;
    updateHintRequestButtonState();
    return;
  }

  hintButton.onclick = handleHintRequest;
}

function updateHintRequestButtonState({ hasManualHints = false, canRequest = false } = {}) {
  const hintButton = document.getElementById('btn-request-hint');
  if (!hintButton) return;

  if (!areHintsEnabled(config) || !hasManualHints) {
    hintButton.style.display = 'none';
    hintButton.disabled = true;
    hintButton.removeAttribute('title');
    return;
  }

  hintButton.style.display = 'inline-flex';
  hintButton.disabled = !canRequest;
  hintButton.title = canRequest
    ? 'Request a hint.'
    : 'Hints are configured, but their conditions are not met yet.';
}

// ---------------------------------------------------------------------------
// Results modal + tabs
// ---------------------------------------------------------------------------

function setupResultsModal() {
  document.getElementById('btn-close-results-modal')?.addEventListener('click', () => {
    closeResultsModal();
  });
  document.getElementById('results-modal-backdrop')?.addEventListener('click', () => {
    closeResultsModal();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeResultsModal();
    }
  });
  document.getElementById('btn-tab-console')?.addEventListener('click', () => {
    setActiveResultsTab('console');
  });
  document.getElementById('btn-tab-files')?.addEventListener('click', () => {
    setActiveResultsTab('files');
  });
  setResultsModalTitle('Run output');
  setResultsModalClosable(true);
  setOutputPlaceholder();
  renderFilesPanel({});
}

function setActiveResultsTab(which) {
  const consoleTab = document.getElementById('btn-tab-console');
  const filesTab = document.getElementById('btn-tab-files');
  const outputPanel = document.getElementById('output-panel');
  const filesPanel = document.getElementById('files-panel');
  const consoleActive = which !== 'files';

  consoleTab?.classList.toggle('active', consoleActive);
  filesTab?.classList.toggle('active', !consoleActive);
  consoleTab?.setAttribute('aria-selected', String(consoleActive));
  filesTab?.setAttribute('aria-selected', String(!consoleActive));
  outputPanel?.classList.toggle('hidden', !consoleActive);
  filesPanel?.classList.toggle('hidden', consoleActive);
}

function openResultsModal() {
  const modal = document.getElementById('results-modal');
  if (!modal) return;

  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
}

function closeResultsModal() {
  const modal = document.getElementById('results-modal');
  if (!modal) return;

  // Locked while a Check is in flight: closing would throw away the results.
  if (isResultsModalCloseLocked) return;

  if (activeInteractiveRun) {
    activeInteractiveRun.cancel();
  }

  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
}

function setOutputPlaceholder() {
  const outputPanel = document.getElementById('output-panel');
  if (!outputPanel) return;
  interactiveConsoleState = null;
  setResultsModalClosable(true);
  outputPanel.innerHTML =
    '<p class="output-placeholder">Run your code or check your solution to open the console, prompts, and feedback here.</p>';
}

function setResultsModalTitle(title) {
  const titleElement = document.getElementById('results-modal-title');
  if (titleElement) {
    titleElement.textContent = title;
  }
}

function setResultsModalClosable(closable) {
  isResultsModalCloseLocked = !closable;

  const closeButton = document.getElementById('btn-close-results-modal');
  const backdrop = document.getElementById('results-modal-backdrop');
  if (closeButton) {
    closeButton.disabled = !closable;
  }
  if (backdrop) {
    backdrop.disabled = !closable;
  }
}

// ---------------------------------------------------------------------------
// Status + buttons
// ---------------------------------------------------------------------------

function showStatus(message, type) {
  const el = document.getElementById('status-bar');
  if (!el) return;
  el.className = `status-bar status-${type}`;
  el.textContent = message;
}

function setExecutionButtonState({ running = false, checking = false } = {}) {
  const runBtn = document.getElementById('btn-run');
  const stopBtn = document.getElementById('btn-stop');
  const checkBtn = document.getElementById('btn-check');
  const resetBtn = document.getElementById('btn-reset');
  const busy = running || checking;

  if (runBtn) {
    runBtn.disabled = busy;
    runBtn.textContent = running ? 'Running...' : '▶ Run';
  }

  if (stopBtn) {
    stopBtn.classList.toggle('hidden', !running);
  }

  if (checkBtn) {
    checkBtn.disabled = busy;
    checkBtn.textContent = checking ? 'Checking...' : '✓ Check';
  }

  if (resetBtn) {
    resetBtn.disabled = busy;
  }
}

function waitForNextPaint() {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(() => requestAnimationFrame(done));
    // Compositor-less environments (some headless builds) never fire rAF;
    // the console is already mounted, so a short timer is a safe fallback.
    setTimeout(done, 150);
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

function cloneConfig(value) {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function isEmbeddedPreview() {
  return window[PREVIEW_MODE_GLOBAL] === true;
}

window.PythonScorm = { requestHint: handleHintRequest };

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

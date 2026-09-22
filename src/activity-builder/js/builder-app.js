/**
 * Builder App — main controller for the Python Activity Builder.
 *
 * Manages tab navigation, central config state, the builder's own Python
 * engine (pattern validation), and coordinates all tab modules.
 *
 * file:// mode: config editing, JSON export, and pattern-free SCORM export
 * still work; Python preview and AST-pattern validation need HTTP
 * (`npm run dev`), so the engine is not created at all and a banner says so.
 */

import { validateConfig } from '../../shared/config-validator.js';
import { normalizeBuilderDraftConfig, sanitizeConfigForExport } from '../../shared/config-normalizer.js';
import { createPythonEngine } from '../../scorm-template/js/python-engine.js';
import { initConfigTab } from './config-tab.js';
import { initCodeTab } from './code-tab.js';
import { initHintsTab } from './hints-tab.js';
import { initTestsTab } from './tests-tab.js';
import { initPreviewTab } from './preview-tab.js';
import { exportJSON, exportSCORM, importConfig } from './export.js';

// Central config state — this is the config being built.
const state = {
  config: createDefaultConfig(),
  activeTab: 'config',
  /** @type {function[]} */
  changeListeners: [],
};

let engine = null;
const fileMode = typeof location !== 'undefined' && location.protocol === 'file:';

function createDefaultConfig() {
  return normalizeBuilderDraftConfig({
    metadata: {
      activity_id: '',
      title: '',
      version: '1.0',
      description: '',
    },
    instructions: { main: '', steps: [] },
    ui_settings: { show_hint_panel: true, suspend_data_limit: 4096 },
    python_setup: { starter_code: '', files: [], packages: [], pyodide_base_url: '' },
    hints: [],
    evaluation: {
      feedback_on_all_pass: '',
      require_previous_test_pass: true,
      test_cases: [],
    },
  }).config;
}

/** Get current config (returns reference — tab modules modify in place). */
export function getConfig() {
  return state.config;
}

/** Replace entire config (used by import). */
export function setConfig(newConfig) {
  state.config = normalizeBuilderDraftConfig(newConfig).config;
  notifyChange();
}

/** Notify all listeners that config changed. */
export function notifyChange() {
  for (const listener of state.changeListeners) {
    listener(state.config);
  }
}

/** Register a change listener. */
export function onConfigChange(fn) {
  state.changeListeners.push(fn);
}

/** Show a toast notification. */
export function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast toast-${type}`;
  setTimeout(() => toast.classList.add('hidden'), 3000);
}

/** file:// mode — no Python engine, no preview. */
export function isFileMode() {
  return fileMode;
}

/**
 * The builder's own Python engine (lazy). Returns null in file:// mode.
 * Recreated after resetPythonEngine() so a changed pyodide base URL applies.
 */
export function getPythonEngine() {
  if (fileMode) return null;
  if (!engine) {
    const setup = getConfig().python_setup || {};
    engine = createPythonEngine({ onStatus: () => {}, pythonSetup: setup });
  }
  return engine;
}

/** Drop the engine (called when the Pyodide base URL changes). */
export function resetPythonEngine() {
  if (engine) {
    engine.dispose();
    engine = null;
  }
}

// — Initialization —

function init() {
  setupTabs();
  setupHeaderActions();
  showFileModeBanner();

  initConfigTab();
  initCodeTab();
  initHintsTab();
  initTestsTab();
  initPreviewTab();
}

function showFileModeBanner() {
  if (!fileMode) return;
  const banner = document.getElementById('file-mode-banner');
  if (banner) banner.classList.remove('hidden');
}

function setupTabs() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');

  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;
      state.activeTab = tabId;

      tabBtns.forEach((b) => b.classList.remove('active'));
      tabPanels.forEach((p) => p.classList.remove('active'));

      btn.classList.add('active');
      document.getElementById(`tab-${tabId}`).classList.add('active');

      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new CustomEvent('tab-activated', { detail: { tab: tabId } }));
    });
  });
}

function setupHeaderActions() {
  document.getElementById('btn-export-json').addEventListener('click', handleJsonExport);
  document.getElementById('btn-export-json-tab')?.addEventListener('click', handleJsonExport);
  document.getElementById('btn-export-scorm').addEventListener('click', handleScormExportFromButton);
  document.getElementById('btn-export-scorm-tab')?.addEventListener('click', handleScormExportFromButton);

  document.getElementById('btn-import').addEventListener('click', () => {
    document.getElementById('file-import').click();
  });

  document.getElementById('file-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const config = await importConfig(file);
      setConfig(config);
      showToast('Config imported successfully', 'success');
    } catch (err) {
      showToast(`Import failed: ${err.message}`, 'error');
    }
    e.target.value = ''; // Reset file input
  });
}

async function handleScormExportFromButton() {
  try {
    await handleScormExport();
  } catch (err) {
    showToast(err.message || String(err), 'error');
  }
}

function handleJsonExport() {
  const { config: exportConfig, omissions } = sanitizeConfigForExport(state.config);
  const omittedSummary = formatExportOmissions(omissions);
  if (omittedSummary) {
    const confirmed = window.confirm(
      `This JSON export will omit ${omittedSummary} from the saved file.\n\nContinue exporting?`,
    );
    if (!confirmed) {
      showToast('JSON export cancelled.', 'info');
      return;
    }
  }
  exportJSON(exportConfig);
  showToast(
    omittedSummary ? `JSON exported — omitted ${omittedSummary}` : 'Config exported as JSON',
    'success',
  );
}

async function handleScormExport() {
  const { config: exportConfig, omissions } = sanitizeConfigForExport(state.config);

  const validation = validateConfig(exportConfig);
  if (!validation.valid) {
    const lines = validation.errors
      .slice(0, 5)
      .map((error) => `${error.path || 'config'}: ${error.message}`);
    const more = validation.errors.length > 5 ? `\n…and ${validation.errors.length - 5} more` : '';
    showToast(`Fix ${validation.errors.length} error(s) before exporting SCORM — ${lines.join('; ')}${more}`, 'error');
    return;
  }

  // AST pattern validity is async (it runs in Pyodide) — checked here, after
  // structural validation passes.
  const patterns = collectAstPatterns(exportConfig);
  if (patterns.length > 0) {
    const engineInstance = getPythonEngine();
    if (!engineInstance) {
      showToast('Pattern validation requires HTTP — serve this folder with npm run dev.', 'error');
      return;
    }
    let errors;
    try {
      errors = await engineInstance.validatePatterns({ patterns });
    } catch {
      showToast('Pattern validation failed — is the Python runtime reachable?', 'error');
      return;
    }
    const invalid = Object.entries(errors).filter(([, message]) => message);
    if (invalid.length > 0) {
      const first = invalid[0];
      showToast(
        `${invalid.length} invalid AST pattern(s) — ${first[0]}: ${first[1]}`,
        'error',
      );
      return;
    }
  }

  const omittedSummary = formatExportOmissions(omissions);
  if (omittedSummary) {
    const confirmed = window.confirm(
      `This SCORM export will omit ${omittedSummary} from the package.\n\nContinue exporting?`,
    );
    if (!confirmed) {
      showToast('SCORM export cancelled.', 'info');
      return;
    }
  }

  await exportSCORM(exportConfig);
  showToast(
    omittedSummary ? `SCORM exported — omitted ${omittedSummary}` : 'SCORM package exported!',
    'success',
  );
}

/** Every ast_pattern across hints and code_structure tests, keyed for reporting. */
export function collectAstPatterns(config) {
  const patterns = [];
  const pushCondition = (condition, key) => {
    if (!condition || typeof condition !== 'object') return;
    if (condition.type === 'ast_pattern') {
      patterns.push({ key, pattern: String(condition.pattern ?? '') });
    }
    if (Array.isArray(condition.conditions)) {
      condition.conditions.forEach((child, index) => pushCondition(child, `${key}.${index}`));
    }
  };

  (config.hints || []).forEach((hint, index) => {
    pushCondition(hint?.trigger?.conditions, `hints[${index}]`);
  });
  (config.evaluation?.test_cases || []).forEach((tc, index) => {
    if (tc?.type === 'code_structure') {
      pushCondition(tc.conditions, `tests[${index}] (${tc.id})`);
    }
  });
  return patterns;
}

function formatExportOmissions(omissions) {
  const parts = [];
  if (omissions.hints > 0) {
    parts.push(`${omissions.hints} incomplete hint${omissions.hints === 1 ? '' : 's'}`);
  }
  if (omissions.tests > 0) {
    parts.push(`${omissions.tests} incomplete test${omissions.tests === 1 ? '' : 's'}`);
  }
  return parts.join(', ');
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

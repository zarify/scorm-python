/**
 * Code Tab — starter code, activity files, packages, and the Pyodide base URL.
 *
 * Starter code lives in a CodeMirror editor; activity files are list rows with
 * either text content or base64 content (from a file input). Path and size
 * limits are enforced inline while typing — invalid paths never reach the
 * config object.
 */

import { getConfig, notifyChange, onConfigChange, resetPythonEngine } from './builder-app.js';
import {
  MAX_ACTIVITY_FILES,
  MAX_FILE_PATH_LENGTH,
} from '../../shared/config-validator.js';
import { enableListReordering } from './list-reorder.js';
import { basicSetup } from 'codemirror';
import { EditorView } from '@codemirror/view';
import { python } from '@codemirror/lang-python';

const PATH_PATTERN = /^[A-Za-z0-9_./-]+$/;
const MAX_CONTENT_CHARS = 262144;
const PYODIDE_URL_STORAGE_KEY = 'pyodideBaseUrl';

let editor = null;
let lastConfigRef = null;

export function initCodeTab() {
  lastConfigRef = getConfig();
  createStarterEditor(getConfig().python_setup.starter_code || '');
  renderActivityFiles();
  renderPackages();
  bindPyodideUrl();

  document.getElementById('btn-add-activity-file')?.addEventListener('click', () => {
    if (files().length >= MAX_ACTIVITY_FILES) return;
    files().push({ path: `file${files().length + 1}.txt`, content: '' });
    renderActivityFiles();
    notifyChange();
  });

  onConfigChange((newCfg) => {
    if (newCfg === lastConfigRef) return;
    setEditorValue(newCfg.python_setup?.starter_code || '');
    renderActivityFiles();
    renderPackages();
    populatePyodideUrl(newCfg);
    lastConfigRef = newCfg;
  });
}

// — Starter code —

function createStarterEditor(value) {
  editor = new EditorView({
    doc: value,
    parent: document.getElementById('starter-code-editor'),
    extensions: [
      basicSetup,
      python(),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          getConfig().python_setup.starter_code = editor.state.doc.toString();
          notifyChange();
        }
      }),
    ],
  });
}

function setEditorValue(text) {
  if (!editor) return;
  const current = editor.state.doc.toString();
  if (current === text) return;
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
}

// — Activity files —

function files() {
  const cfg = getConfig();
  if (!Array.isArray(cfg.python_setup.files)) cfg.python_setup.files = [];
  return cfg.python_setup.files;
}

function renderActivityFiles() {
  const container = document.getElementById('activity-files-list');
  container.innerHTML = '';
  const entries = files();

  entries.forEach((entry, index) => {
    container.appendChild(buildFileRow(entry, index));
  });

  const addButton = document.getElementById('btn-add-activity-file');
  addButton.disabled = entries.length >= MAX_ACTIVITY_FILES;

  enableListReordering(container, {
    itemSelector: '.activity-file-row',
    onMove: (fromIndex, targetIndex, position) => {
      const list = files();
      const insertIndex = position === 'before' ? targetIndex : targetIndex + 1;
      const adjusted = fromIndex < insertIndex ? insertIndex - 1 : insertIndex;
      const [moved] = list.splice(fromIndex, 1);
      list.splice(adjusted, 0, moved);
      renderActivityFiles();
      notifyChange();
    },
  });
}

function buildFileRow(entry, index) {
  const row = document.createElement('div');
  row.className = 'activity-file-row list-item-reorderable';
  row.dataset.index = String(index);

  const isBase64 = typeof entry.content_base64 === 'string';

  const pathInput = document.createElement('input');
  pathInput.type = 'text';
  pathInput.className = 'file-path-input mono';
  pathInput.placeholder = 'data/input.csv';
  pathInput.maxLength = MAX_FILE_PATH_LENGTH;
  pathInput.value = entry.path || '';
  pathInput.addEventListener('input', () => {
    const value = pathInput.value;
    if (isValidPath(value)) {
      pathInput.classList.remove('field-invalid');
      pathInput.removeAttribute('title');
      entry.path = value;
      notifyChange();
    } else {
      pathInput.classList.add('field-invalid');
      pathInput.title = 'Use letters, digits, _ . / - only; no leading / and no .. segments (max 256 chars)';
    }
  });

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
  removeButton.title = 'Remove file';
  removeButton.textContent = '✕';

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
      renderActivityFiles();
      notifyChange();
    });
  } else {
    const contentArea = document.createElement('textarea');
    contentArea.className = 'file-content-input';
    contentArea.rows = 3;
    contentArea.spellcheck = false;
    contentArea.maxLength = MAX_CONTENT_CHARS;
    contentArea.placeholder = 'File content (text)';
    contentArea.value = entry.content ?? '';
    contentArea.addEventListener('input', () => {
      entry.content = contentArea.value;
      delete entry.content_base64;
      notifyChange();
    });
    row.appendChild(contentArea);

    modeButton.addEventListener('click', () => {
      pickBinaryFile(entry);
    });
  }

  removeButton.addEventListener('click', () => {
    files().splice(index, 1);
    renderActivityFiles();
    notifyChange();
  });

  return row;
}

function pickBinaryFile(entry) {
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
      if (base64.length > MAX_CONTENT_CHARS) {
        window.alert('File is too large — base64 content must stay under 262144 characters.');
        return;
      }
      delete entry.content;
      entry.content_base64 = base64;
      renderActivityFiles();
      notifyChange();
    };
    reader.readAsDataURL(file);
  });
  input.click();
}

function isValidPath(value) {
  if (typeof value !== 'string' || !value) return false;
  if (value.length > MAX_FILE_PATH_LENGTH) return false;
  if (value.startsWith('/') || value.includes('\\')) return false;
  if (!PATH_PATTERN.test(value)) return false;
  if (value.split('/').includes('..')) return false;
  return true;
}

// — Packages —

const PACKAGE_LABELS = { pillow: 'Pillow (optional image library)' };

function renderPackages() {
  const container = document.getElementById('packages-list');
  container.innerHTML = '';
  const selected = new Set(getConfig().python_setup.packages || []);

  for (const name of Object.keys(PACKAGE_LABELS)) {
    const label = document.createElement('label');
    label.className = 'checkbox-label';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = selected.has(name);
    box.addEventListener('change', () => {
      const packages = new Set(getConfig().python_setup.packages || []);
      if (box.checked) packages.add(name); else packages.delete(name);
      getConfig().python_setup.packages = ['pillow'].filter((p) => packages.has(p));
      notifyChange();
    });
    label.append(box, ` ${PACKAGE_LABELS[name]}`);
    container.appendChild(label);
  }
}

// — Pyodide base URL —

function bindPyodideUrl() {
  const input = document.getElementById('pyodide-base-url');
  populatePyodideUrl(getConfig());

  input.addEventListener('input', () => {
    const value = input.value.trim();
    getConfig().python_setup.pyodide_base_url = value;
    try {
      localStorage.setItem(PYODIDE_URL_STORAGE_KEY, value);
    } catch {
      // Storage may be unavailable (private mode) — config still holds the value.
    }
    resetPythonEngine();
    notifyChange();
  });
}

function populatePyodideUrl(cfg) {
  const input = document.getElementById('pyodide-base-url');
  if (!input) return;
  const fromConfig = String(cfg.python_setup?.pyodide_base_url || '').trim();
  if (fromConfig) {
    input.value = fromConfig;
    return;
  }
  let stored = '';
  try {
    stored = localStorage.getItem(PYODIDE_URL_STORAGE_KEY) || '';
  } catch {
    stored = '';
  }
  input.value = stored;
}

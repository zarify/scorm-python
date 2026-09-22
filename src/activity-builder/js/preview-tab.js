/**
 * Preview Tab — interactive student-runtime preview.
 *
 * Builds an iframe document that bootstraps the real student app bundle with
 * the current in-memory config injected inline. Over file:// the iframe is
 * replaced by a notice (the worker and Pyodide need HTTP).
 */

import { getConfig, onConfigChange, isFileMode } from './builder-app.js';

export function initPreviewTab() {
  document.getElementById('btn-refresh-preview').addEventListener('click', refreshPreview);
  onConfigChange(() => {
    if (isPreviewActive()) {
      refreshPreview();
    }
  });

  window.addEventListener('tab-activated', (e) => {
    if (e.detail.tab === 'preview') {
      refreshPreview();
    }
  });

  if (isFileMode()) {
    document.getElementById('preview-iframe')?.classList.add('hidden');
    document.getElementById('preview-file-notice')?.classList.remove('hidden');
  }
}

function refreshPreview() {
  const iframe = document.getElementById('preview-iframe');
  if (!iframe) return;

  if (isFileMode()) {
    iframe.classList.add('hidden');
    document.getElementById('preview-file-notice')?.classList.remove('hidden');
    iframe.removeAttribute('srcdoc');
    return;
  }

  document.getElementById('preview-file-notice')?.classList.add('hidden');
  iframe.classList.remove('hidden');
  iframe.srcdoc = buildPreviewHtml(getConfig());
}

function buildPreviewHtml(config) {
  const previewBaseHref = new URL('./preview/', window.location.href).href;
  const title = escapeHtml(config.metadata?.title || 'Python Activity Preview');
  const inlineConfig = serializeForInlineScript(config);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <base href="${escapeAttr(previewBaseHref)}">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="app">
    <header id="status-bar" class="status-bar status-info">Loading interactive preview...</header>

    <div id="main-layout">
      <aside id="left-panel">
        <div id="instructions-panel" class="panel">
          <h2>Instructions</h2>
          <p>Loading...</p>
          <div id="hint-panel" class="hints-inline">
            <h3>💡 Hints</h3>
            <p class="hint-empty">No hints available right now.</p>
          </div>
        </div>
      </aside>

      <main id="workspace-area">
        <div id="editor"></div>
        <div id="controls">
          <button id="btn-run" class="btn btn-primary">▶ Run</button>
          <button id="btn-stop" class="btn btn-danger hidden">■ Stop</button>
          <button id="btn-check" class="btn btn-secondary">✓ Check</button>
          <button id="btn-reset" class="btn btn-secondary">↺ Reset</button>
          <button id="btn-request-hint" class="btn btn-secondary">💡 Get Hint</button>
        </div>
      </main>
    </div>
  </div>
  <div id="results-modal" class="results-modal hidden" aria-hidden="true">
    <button id="results-modal-backdrop" class="results-modal-backdrop" type="button" aria-label="Close results"></button>
    <section class="results-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="results-modal-title">
      <header class="results-modal-header">
        <h2 id="results-modal-title">Run output</h2>
        <div class="results-modal-tabs" role="tablist">
          <button id="btn-tab-console" class="results-tab active" type="button" role="tab" aria-selected="true">Console</button>
          <button id="btn-tab-files" class="results-tab" type="button" role="tab" aria-selected="false">Files</button>
        </div>
        <button id="btn-close-results-modal" class="btn btn-secondary results-modal-close" type="button" aria-label="Close results">✕</button>
      </header>
      <div class="results-modal-body">
        <div id="output-panel" class="panel">
          <p class="output-placeholder">Run your code or check your solution to open the console, prompts, and feedback here.</p>
        </div>
        <div id="files-panel" class="panel hidden">
          <p class="output-placeholder">Run your program to see the files it produced.</p>
        </div>
      </div>
    </section>
  </div>
  <div id="input-dialog" class="input-dialog hidden" aria-hidden="true">
    <div class="input-dialog-backdrop"></div>
    <section class="input-dialog-dialog" role="dialog" aria-modal="true" aria-labelledby="input-dialog-label">
      <label id="input-dialog-label" class="input-dialog-prompt" for="input-dialog-field">Input</label>
      <input id="input-dialog-field" class="input-dialog-field" type="text" autocomplete="off" spellcheck="false">
      <div class="input-dialog-actions">
        <button id="btn-input-ok" class="btn btn-primary" type="button">OK</button>
        <button id="btn-input-cancel" class="btn btn-secondary" type="button">Cancel</button>
      </div>
    </section>
  </div>
  <script>
    window.__BLOCKLY_SCORM_PREVIEW_MODE__ = true;
    window.__BLOCKLY_SCORM_PREVIEW_CONFIG__ = ${inlineConfig};
  </script>
  <script src="app.bundle.js"></script>
</body>
</html>`;
}

function isPreviewActive() {
  return document.getElementById('tab-preview')?.classList.contains('active');
}

function serializeForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/'/g, '&#39;');
}

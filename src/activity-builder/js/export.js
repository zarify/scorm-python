/**
 * Export Module — JSON and SCORM package export, config import.
 *
 * SCORM export assembles the package from builder-carried assets:
 * - embedded (runtime-assets.js): student bundle, stylesheet, the module
 *   worker, and both Python sources — these keep JSON/SCORM export working
 *   even from file://;
 * - generated: imsmanifest.xml and index.html (title injected);
 * - fetched over HTTP: the bundled Pyodide runtime, listed in
 *   pyodide-manifest.json — omitted from the zip whenever the config sets
 *   `python_setup.pyodide_base_url` (same skip rule as scripts/export-scorm.js).
 */

import JSZip from 'jszip';
import { normalizeBuilderDraftConfig } from '../../shared/config-normalizer.js';
import { validateConfig } from '../../shared/config-validator.js';

const BUILDER_RUNTIME_ASSETS_GLOBAL = '__SCORM_BUILDER_ASSETS__';

/**
 * Export the config as a JSON file download.
 * @param {object} config
 */
export function exportJSON(config) {
  const json = JSON.stringify(config, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  downloadBlob(blob, `${config.metadata?.activity_id || 'activity_config'}.json`);
}

/**
 * Export a complete SCORM package as a .zip download.
 * @param {object} config
 */
export async function exportSCORM(config) {
  const assets = await loadBuilderAssets();
  const zip = new JSZip();

  zip.file('config/activity_config.json', JSON.stringify(config, null, 2));
  zip.file('imsmanifest.xml', generateManifest(config));
  zip.file('index.html', generateIndexHtml(config));
  zip.file('css/style.css', assets.styleCss);
  zip.file('js/app.bundle.js', withoutSourceMapReference(assets.appBundleJs));
  zip.file('js/python-worker.js', assets.workerJs);
  zip.file('python/astmatch.py', assets.astmatchPy);
  zip.file('python/harness.py', assets.harnessPy);

  const baseUrl = String(config.python_setup?.pyodide_base_url || '').trim();
  if (baseUrl === '') {
    await addBundledPyodide(zip);
  }

  const content = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });

  downloadBlob(content, `${config.metadata?.activity_id || 'python-scorm-activity'}.zip`);
}

async function addBundledPyodide(zip) {
  let names;
  try {
    const response = await fetch(new URL('pyodide-manifest.json', window.location.href));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    names = await response.json();
  } catch {
    throw new Error(
      'Bundled Python runtime unavailable — serve the builder over HTTP (npm run dev), '
      + 'or set a Pyodide base URL on the Code tab to export without it.',
    );
  }
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error('pyodide-manifest.json is empty — run `node scripts/fetch-pyodide.js` and rebuild.');
  }

  for (const name of names) {
    const response = await fetch(new URL(`pyodide/${name}`, window.location.href));
    if (!response.ok) {
      throw new Error(`Failed to fetch pyodide/${name} (HTTP ${response.status})`);
    }
    zip.file(`pyodide/${name}`, await response.arrayBuffer());
  }
}

async function loadBuilderAssets() {
  const embedded = globalThis[BUILDER_RUNTIME_ASSETS_GLOBAL];
  if (hasRuntimeAssets(embedded)) {
    return embedded;
  }
  throw new Error(
    'SCORM runtime assets are unavailable. Rebuild the activity builder or run it with "npm run dev", then try exporting again.',
  );
}

/**
 * Drop the trailing `sourceMappingURL` comment esbuild adds to development
 * bundles: the package ships no map, so the comment only produces a 404 in the
 * LMS console.
 * @param {string} js
 * @returns {string}
 */
function withoutSourceMapReference(js) {
  return js.replace(/\n?\/\/# sourceMappingURL=\S*[ \t]*\n?$/, '\n');
}

function hasRuntimeAssets(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof value.appBundleJs === 'string'
    && value.appBundleJs.length > 0
    && typeof value.styleCss === 'string'
    && value.styleCss.length > 0
    && typeof value.workerJs === 'string'
    && typeof value.astmatchPy === 'string'
    && typeof value.harnessPy === 'string',
  );
}

/**
 * Import a config from a JSON file.
 * @param {File} file
 * @returns {Promise<object>}
 */
export async function importConfig(file) {
  const text = await file.text();
  let rawConfig;
  try {
    rawConfig = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON file');
  }

  const { config } = normalizeBuilderDraftConfig(rawConfig);
  const validation = validateConfig(config);
  if (!validation.valid) {
    const firstErrors = validation.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`);
    throw new Error(`Imported draft is missing required sections:\n${firstErrors.join('\n')}`);
  }

  return config;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function generateManifest(config) {
  const title = escapeXml(config.metadata?.title || 'Python Coding Activity');
  const activityId = escapeXml(config.metadata?.activity_id || 'activity');
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="python_scorm_${activityId}"
         version="1.0"
         xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
         xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd
                             http://www.imsglobal.org/xsd/imsmd_rootv1p2p1 imsmd_rootv1p2p1.xsd
                             http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="python_org">
    <organization identifier="python_org">
      <title>${title}</title>
      <item identifier="python_item" identifierref="python_resource" isvisible="true">
        <title>${title}</title>
        <adlcp:masteryscore>50</adlcp:masteryscore>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="python_resource" type="webcontent" adlcp:scormtype="sco" href="index.html">
      <file href="index.html"/>
      <file href="css/style.css"/>
      <file href="js/app.bundle.js"/>
      <file href="config/activity_config.json"/>
    </resource>
  </resources>
</manifest>`;
}

function generateIndexHtml(config) {
  const title = escapeHtml(config.metadata?.title || 'Python Activity');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="stylesheet" href="css/style.css">
</head>
<body>
  <div id="app">
    <header id="status-bar" class="status-bar status-info">Loading activity...</header>
    <div id="main-layout">
      <aside id="left-panel">
        <div id="instructions-panel" class="panel"><h2>Instructions</h2><p>Loading...</p>
          <div id="hint-panel" class="hints-inline"><h3>💡 Hints</h3><p class="hint-empty">No hints available right now.</p></div>
        </div>
      </aside>
      <main id="workspace-area">
        <div id="file-tabs" class="file-tabs" role="tablist" aria-label="Program files"></div>
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
        <div id="output-panel" class="panel"><p class="output-placeholder">Run your code or check your solution to open the console, prompts, and feedback here.</p></div>
        <div id="files-panel" class="panel hidden"><p class="output-placeholder">Run your program to see the files it produced.</p></div>
      </div>
    </section>
  </div>
  <script src="js/app.bundle.js"></script>
</body>
</html>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeXml(str) {
  return escapeHtml(str);
}

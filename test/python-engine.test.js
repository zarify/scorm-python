import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshModule } from './helpers/fresh.js';

const ENGINE = new URL('../src/scorm-template/js/python-engine.js', import.meta.url).href;

function installDocument({ currentScriptSrc = '', baseURI, scripts = [] }) {
  const previousDocument = globalThis.document;
  const previousPreviewMode = globalThis.__BLOCKLY_SCORM_PREVIEW_MODE__;

  globalThis.document = {
    currentScript: currentScriptSrc ? { src: currentScriptSrc } : null,
    baseURI,
    scripts: scripts.map((src) => ({ src })),
  };

  return {
    restore() {
      globalThis.document = previousDocument;
      if (previousPreviewMode === undefined) {
        delete globalThis.__BLOCKLY_SCORM_PREVIEW_MODE__;
      } else {
        globalThis.__BLOCKLY_SCORM_PREVIEW_MODE__ = previousPreviewMode;
      }
    },
  };
}

test('a blob-backed bundle falls back to the package base in an exported SCO', async (t) => {
  const env = installDocument({
    currentScriptSrc: 'blob:null/d08cb602-2b06-461c-a10f-de5c31d7bce7',
    baseURI: 'https://example.com/mod/scorm/content/42/index.html',
  });
  t.after(() => env.restore());

  const { createPythonEngine } = await freshModule(ENGINE);
  assert.doesNotThrow(() => createPythonEngine());
});

test('an explicit package base makes blob-backed exported SCOs independent of script hosting', async (t) => {
  const env = installDocument({
    currentScriptSrc: 'blob:null/e09ecd50-7980-49d2-87ec-e17cb458dff4',
    baseURI: '',
  });
  t.after(() => env.restore());

  const { createPythonEngine } = await freshModule(ENGINE);
  assert.doesNotThrow(() => createPythonEngine({
    assetBaseUrl: 'https://example.com/mod/scorm/content/42/',
  }));
});

test('preview mode falls back to the preview base when currentScript is unusable', async (t) => {
  globalThis.__BLOCKLY_SCORM_PREVIEW_MODE__ = true;
  const env = installDocument({
    currentScriptSrc: 'blob:null/preview-app-bundle',
    baseURI: 'https://example.com/dist/activity-builder/preview/',
  });
  t.after(() => env.restore());

  const { createPythonEngine } = await freshModule(ENGINE);
  assert.doesNotThrow(() => createPythonEngine());
});

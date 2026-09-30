/**
 * Activity Builder in a real browser.
 *
 * Covers what the Node suite cannot: tab rendering, the Code tab's
 * persistence, AST-pattern validation through the builder's own Python
 * engine, both SCORM export modes (bundled vs external Pyodide URL), and the
 * srcdoc preview running the real student app.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

import { importConfigIntoBuilder, launchBrowser, newPage, openTab, startStaticServer } from './helpers/harness.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const EXAMPLES = join(REPO_ROOT, 'examples');

let server;
let browser;
let skipReason = null;

before(async () => {
  browser = await launchBrowser();
  if (!browser) {
    skipReason = 'no Chrome or Chromium available (see README: npx playwright install chromium)';
    return;
  }
  server = await startStaticServer(join(REPO_ROOT, 'dist'));
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function builderPage() {
  const handle = await newPage(browser, { url: `${server.origin}/activity-builder/` });
  await handle.page.waitForSelector('#cfg-title');
  return handle;
}

test('all six tabs render and activate', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, errors, close } = await builderPage();
  t.after(close);

  const tabs = await page.evaluate(() => [...document.querySelectorAll('.tab-btn')]
    .map((button) => button.dataset.tab));
  assert.deepEqual(tabs, ['config', 'code', 'hints', 'tests', 'preview', 'export']);

  for (const tab of tabs) {
    await openTab(page, tab);
    assert.equal(
      await page.locator(`#tab-${tab}`).evaluate((el) => el.classList.contains('active')),
      true,
      `tab ${tab} became active`,
    );
  }

  await openTab(page, 'code');
  assert.ok(
    await page.locator('#starter-code-editor .cm-content').count(),
    'the starter-code editor mounted',
  );
  assert.deepEqual(errors, []);
});

test('the Code tab persists starter code into the config and the URL into localStorage', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, errors, close } = await builderPage();
  t.after(close);

  await openTab(page, 'code');
  await page.click('#starter-code-editor .cm-content');
  await page.keyboard.type('x = 1');

  const configCode = await page.evaluate(() => window.ActivityBuilder.getConfig().python_setup.starter_code);
  assert.equal(configCode, 'x = 1', 'the editor wrote through to python_setup.starter_code');

  await page.fill('#pyodide-base-url', 'https://example.com/pyodide/');
  const stored = await page.evaluate(() => localStorage.getItem('pyodideBaseUrl'));
  assert.equal(stored, 'https://example.com/pyodide/', 'the URL landed in localStorage');
  assert.equal(
    await page.evaluate(() => window.ActivityBuilder.getConfig().python_setup.pyodide_base_url),
    'https://example.com/pyodide/',
    'and in the config',
  );

  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#cfg-title');
  await openTab(page, 'code');
  assert.equal(
    await page.inputValue('#pyodide-base-url'),
    'https://example.com/pyodide/',
    'a reload prefills the remembered URL',
  );
  assert.deepEqual(errors, []);
});

test('an invalid ast_pattern fails Validate and a fixed one clears', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, errors, close } = await builderPage();
  t.after(close);

  await importConfigIntoBuilder(page, join(EXAMPLES, 'hello-world.json'));
  await openTab(page, 'tests');
  await page.click('.test-list-item[data-index="1"]'); // the code_structure test
  await page.waitForSelector('#test-condition-builder .cond-pattern .cm-content', { timeout: 10_000 });

  await setPattern(page, 'value = ...');
  await page.click('#test-condition-builder .cond-validate');
  await page.waitForSelector('#test-condition-builder .cond-validate-result.is-error', { timeout: 30_000 });
  const errorText = await page.textContent('#test-condition-builder .cond-validate-result');
  assert.match(errorText, /\.\.\. is only allowed/, 'the parse/misuse error is shown inline');

  await setPattern(page, 'print(...)');
  await page.click('#test-condition-builder .cond-validate');
  await page.waitForSelector('#test-condition-builder .cond-validate-result.is-ok', { timeout: 30_000 });
  assert.match(
    await page.textContent('#test-condition-builder .cond-validate-result'),
    /Pattern is valid/,
  );
  assert.deepEqual(errors, []);
});

/** Replace the CodeMirror-backed AST pattern through its document API. */
async function setPattern(page, text) {
  await page.evaluate((pattern) => {
    const view = document.querySelector('#test-condition-builder .cond-pattern')?.condPatternView;
    if (!view) throw new Error('pattern editor not mounted');
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: pattern } });
  }, text);
}

test('the strict clause-matching checkbox round-trips into the config', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, errors, close } = await builderPage();
  t.after(close);

  await importConfigIntoBuilder(page, join(EXAMPLES, 'hello-world.json'));
  await openTab(page, 'tests');
  await page.click('.test-list-item[data-index="1"]'); // the code_structure test
  await page.waitForSelector('#test-condition-builder .cond-strict');

  const conditionsOf = () => page.evaluate(
    () => window.ActivityBuilder.getConfig().evaluation.test_cases.find(
      (testCase) => testCase.type === 'code_structure',
    ).conditions,
  );

  assert.equal((await conditionsOf()).strict, undefined, 'the flag starts absent (variant mode)');

  await page.check('#test-condition-builder .cond-strict');
  assert.equal((await conditionsOf()).strict, true, 'checking the box wrote strict: true');

  await page.uncheck('#test-condition-builder .cond-strict');
  assert.equal((await conditionsOf()).strict, false, 'unchecking wrote strict: false');

  await page.check('#test-condition-builder .cond-strict');
  assert.equal((await conditionsOf()).strict, true, 're-checking restores strict: true');
  assert.deepEqual(errors, []);
});

async function exportZip(page) {
  const directory = await mkdtemp(join(tmpdir(), 'scorm-export-'));
  const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
  await page.click('#btn-export-scorm');
  const download = await downloadPromise;
  const zipPath = join(directory, download.suggestedFilename());
  await download.saveAs(zipPath);
  return JSZip.loadAsync(await readFile(zipPath));
}

test('Export SCORM honors the Pyodide skip rule', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, errors, close } = await builderPage();
  t.after(close);

  await importConfigIntoBuilder(page, join(EXAMPLES, 'hello-world.json'));
  await openTab(page, 'code');

  // Bundled mode: URL empty → the runtime rides along.
  await page.fill('#pyodide-base-url', '');
  const bundled = await exportZip(page);
  const bundledNames = Object.keys(bundled.files);
  assert.ok(bundledNames.includes('pyodide/pyodide.asm.wasm'), 'bundled zip carries the wasm runtime');
  assert.ok(bundledNames.includes('pyodide/pyodide.mjs'), 'bundled zip carries the loader');
  assert.ok(bundledNames.includes('python/harness.py'), 'bundled zip carries the harness');
  assert.ok(bundledNames.includes('js/python-worker.js'), 'bundled zip carries the worker');
  assert.ok(bundledNames.includes('imsmanifest.xml'), 'the manifest is present');
  assert.ok(bundledNames.includes('js/app.bundle.js'), 'the student bundle is present');

  // External mode: URL set → pyodide/ omitted, everything else stays.
  await page.fill('#pyodide-base-url', 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/');
  const external = await exportZip(page);
  const externalNames = Object.keys(external.files);
  assert.equal(
    externalNames.filter((name) => name.startsWith('pyodide/')).length,
    0,
    'external-mode zip omits the bundled runtime',
  );
  assert.ok(externalNames.includes('python/harness.py'));
  assert.ok(externalNames.includes('imsmanifest.xml'));
  assert.ok(externalNames.includes('config/activity_config.json'));
  assert.deepEqual(errors, []);
});

test('the preview iframe runs the real student app', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, errors, close } = await builderPage();
  t.after(close);

  await importConfigIntoBuilder(page, join(EXAMPLES, 'hello-world.json'));
  await openTab(page, 'code');
  await page.click('#starter-code-editor .cm-content');
  await page.keyboard.type('print("preview ok")');
  // The preview refreshes on config change; make sure it sees the final code.
  await openTab(page, 'preview');
  await page.click('#btn-refresh-preview');

  const frame = page.frameLocator('#preview-iframe');
  await frame.locator('#status-bar').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('preview-iframe');
    try {
      return /Activity loaded|Preview ready/.test(el.contentDocument?.getElementById('status-bar')?.textContent ?? '');
    } catch {
      return false;
    }
  }, undefined, { timeout: 60_000 });

  await frame.locator('#btn-run').click();
  await frame.locator('[data-console-transcript]').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => {
    try {
      const doc = document.getElementById('preview-iframe').contentDocument;
      return /Program finished/.test(doc?.getElementById('status-bar')?.textContent ?? '');
    } catch {
      return false;
    }
  }, undefined, { timeout: 60_000 });

  const transcript = await frame.locator('[data-console-transcript]').textContent();
  assert.match(transcript, /preview ok/, 'the previewed program ran');
  assert.match(transcript, /Program finished/);
  assert.deepEqual(errors, []);
});

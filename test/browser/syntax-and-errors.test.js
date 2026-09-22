/**
 * Syntax errors and runtime errors in the browser.
 *
 * A syntax error must fail every test without crashing the page (the analyzer
 * short-circuits), and a runtime error must show only student frames — the
 * harness never leaks its own tracebacks into the UI.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchBrowser, newPage, serveRuntimeWithConfig } from './helpers/harness.js';
import { MOCK_SCORM_INIT } from './helpers/mock-lms.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const HELLO_WORLD = JSON.parse(readFileSync(join(REPO_ROOT, 'examples/hello-world.json'), 'utf8'));

let browser;
let skipReason = null;

before(async () => {
  browser = await launchBrowser();
  if (!browser) {
    skipReason = 'no Chrome or Chromium available (see README: npx playwright install chromium)';
  }
});

after(async () => {
  await browser?.close();
});

async function runtimePage(starterCode) {
  const server = await serveRuntimeWithConfig({
    ...HELLO_WORLD,
    python_setup: { ...HELLO_WORLD.python_setup, starter_code: starterCode },
  });
  const handle = await newPage(browser, {
    url: `${server.origin}/index.html`,
    initScripts: [
      { fn: MOCK_SCORM_INIT, arg: { seedModel: { 'cmi.core.student_id': 'student-42' } } },
    ],
  });
  return {
    ...handle,
    close: async () => {
      await handle.close();
      await server.close();
    },
  };
}

async function waitUntilLoaded(page) {
  await page.waitForFunction(
    () => /Activity loaded/.test(document.getElementById('status-bar')?.textContent ?? ''),
    undefined,
    { timeout: 30_000 },
  );
}

test('a syntax error fails every test with a line-numbered SyntaxError detail', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, errors, close } = await runtimePage('');
  t.after(close);
  await waitUntilLoaded(page);

  await page.click('.cm-content');
  await page.keyboard.type('def (:');

  await page.click('#btn-check');
  await page.waitForSelector('#results-modal:not(.hidden)', { timeout: 30_000 });
  await page.waitForFunction(
    () => !document.getElementById('btn-check').disabled,
    undefined,
    { timeout: 30_000 },
  );

  const results = await page.textContent('#results-modal');
  assert.match(results, /Some automated checks failed/);
  assert.match(results, /SyntaxError: .+ \(line 1\)/, 'the line-numbered syntax detail is shown');
  assert.match(results, /Other tests remain unpassed\./, 'every test failed coherently');
  // No page crash: the analyzer failed gracefully instead of wedging.
  assert.deepEqual(errors, []);
});

test('a runtime error shows only student frames with the failing line', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, errors, close } = await runtimePage('print("x")\n1 / 0\n');
  t.after(close);
  await waitUntilLoaded(page);

  await page.click('#btn-run');
  await page.waitForFunction(
    () => /Program stopped/.test(document.getElementById('status-bar')?.textContent ?? ''),
    undefined,
    { timeout: 30_000 },
  );

  const consoleState = await page.evaluate(() => ({
    transcript: document.querySelector('[data-console-transcript]')?.textContent ?? '',
    tracebackBlocks: [...document.querySelectorAll('[data-console-transcript] pre')]
      .map((pre) => pre.textContent),
  }));

  assert.match(consoleState.transcript, /division by zero/, 'the error message reached the console');
  assert.equal(consoleState.tracebackBlocks.length, 1, 'the filtered traceback is rendered');
  const traceback = consoleState.tracebackBlocks[0];
  assert.match(traceback, /File "<student\.py>", line 2/, 'the student frame and line are named');
  assert.match(traceback, /ZeroDivisionError/, 'the exception type is shown');
  assert.doesNotMatch(traceback, /harness\.py/, 'harness frames are never shown');
  assert.doesNotMatch(traceback, /astmatch/, 'matcher frames are never shown');
  assert.equal(
    (traceback.match(/File "/g) || []).length,
    1,
    'only one frame — only student frames survive the filter',
  );
  assert.deepEqual(errors, []);
});

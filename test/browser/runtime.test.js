/**
 * Student runtime in a real browser, against a mock SCORM 1.2 runtime.
 *
 * The flow a student gets: the package boots, the Python runtime reaches
 * ready, the student types a program, Check grades it, and the score reaches
 * the LMS.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchBrowser, newPage, serveRuntimeWithConfig } from './helpers/harness.js';
import { MOCK_SCORM_INIT, readLmsModel } from './helpers/mock-lms.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const HELLO_WORLD = JSON.parse(
  readFileSync(join(REPO_ROOT, 'examples/hello-world.json'), 'utf8'),
);

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

async function runtimePage(config) {
  const server = await serveRuntimeWithConfig(config);
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

async function editorText(page) {
  return page.evaluate(() => [...document.querySelectorAll('.cm-line')]
    .map((line) => line.textContent)
    .join('\n'));
}

async function typeIntoEditor(page, text) {
  await page.click('.cm-content');
  await page.keyboard.type(text);
}

test('the activity loads, grades a typed program, and reports 100 to the LMS', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, errors, close } = await runtimePage(HELLO_WORLD);
  t.after(close);

  // Readiness: the status bar only shows this after the Pyodide worker is ready.
  await page.waitForFunction(
    () => /Activity loaded/.test(document.getElementById('status-bar')?.textContent ?? ''),
    undefined,
    { timeout: 30_000 },
  );
  assert.match(await page.textContent('#status-bar'), /Activity loaded/);
  assert.match(await page.textContent('#status-bar'), /Python is ready/);
  assert.equal(await page.isDisabled('#btn-run'), false);
  assert.equal(await page.isDisabled('#btn-check'), false);

  await typeIntoEditor(page, 'print("Hello, World!")');
  assert.match(await editorText(page), /print\("Hello, World!"\)/, 'the editor accepted the program');

  await page.click('#btn-check');
  await page.waitForSelector('#results-modal:not(.hidden)', { timeout: 30_000 });

  const results = await page.textContent('#results-modal');
  assert.match(results, /All automated checks passed/, 'both tests passed');
  assert.match(results, /Your program prints exactly the expected text\./);
  assert.match(results, /You used a print statement\./);
  assert.match(results, /Score: 100%/);

  const model = await readLmsModel(page);
  assert.equal(model['cmi.core.score.raw'], '100');
  assert.equal(model['cmi.core.score.min'], '0');
  assert.equal(model['cmi.core.score.max'], '100');
  assert.equal(model['cmi.core.lesson_status'], 'passed');
  assert.ok(model.__commits >= 1, 'the score reached the LMS through a commit');
  assert.equal(model.__lastCommit['cmi.core.score.raw'], '100', 'the commit carried the score');
  assert.deepEqual(errors, []);
});

test('empty code scores zero and the LMS records a failed attempt', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, errors, close } = await runtimePage({
    ...HELLO_WORLD,
    python_setup: { ...HELLO_WORLD.python_setup, starter_code: '' },
  });
  t.after(close);

  await page.waitForFunction(
    () => /Activity loaded/.test(document.getElementById('status-bar')?.textContent ?? ''),
    undefined,
    { timeout: 30_000 },
  );

  await page.click('#btn-check');
  await page.waitForSelector('#results-modal:not(.hidden)', { timeout: 30_000 });

  const model = await readLmsModel(page);
  assert.equal(model['cmi.core.score.raw'], '0');
  assert.equal(model['cmi.core.lesson_status'], 'failed');
  assert.deepEqual(errors, []);
});

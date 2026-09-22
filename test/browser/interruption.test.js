/**
 * Interruption: budget watchdogs, the Stop button, and C-level hangs.
 *
 * Layered design under test — Python trace budget/soft wall for Python-level
 * loops, the JS silence watchdog for C-level hangs, and terminate + lazy
 * respawn for Stop.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchBrowser, newPage, serveRuntimeWithConfig } from './helpers/harness.js';
import { MOCK_SCORM_INIT } from './helpers/mock-lms.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const BASE = JSON.parse(readFileSync(join(REPO_ROOT, 'examples/hello-world.json'), 'utf8'));

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
    ...BASE,
    python_setup: { ...BASE.python_setup, starter_code: starterCode },
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

test('an infinite Python loop stops with a friendly budget message', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, errors, close } = await runtimePage('while True:\n    pass');
  t.after(close);
  await waitUntilLoaded(page);

  await page.click('#btn-run');
  await page.waitForSelector('#results-modal:not(.hidden)', { timeout: 10_000 });

  // Both watchdog messages call it "ran too long"; the test names which fired.
  await page.waitForFunction(
    () => /Your program ran too long/.test(document.getElementById('status-bar')?.textContent ?? ''),
    undefined,
    { timeout: 20_000 },
  );

  const state = await page.evaluate(() => ({
    runEnabled: !document.getElementById('btn-run').disabled,
    stopHidden: document.getElementById('btn-stop').classList.contains('hidden'),
    transcript: document.querySelector('[data-console-transcript]')?.textContent ?? '',
  }));
  assert.equal(state.runEnabled, true, 'the run button came back');
  assert.equal(state.stopHidden, true, 'the stop button is hidden again');
  assert.match(state.transcript, /ran too long/, 'the friendly message is in the console');
  assert.deepEqual(errors, []);

  // The page is still responsive after the budget stop — close the results
  // modal first (its backdrop covers the controls), then reset.
  await page.click('#btn-close-results-modal');
  await page.click('#btn-reset');
  await page.waitForFunction(
    () => /Editor reset/.test(document.getElementById('status-bar')?.textContent ?? ''),
    undefined,
    { timeout: 5_000 },
  );
});

test('Stop during a run terminates it and the next Run succeeds', async (t) => {
  if (skipReason) return t.skip(skipReason);
  // A parked dialog is stopped by its own Cancel (covered in
  // interactive-input.test.js); this exercises the Stop BUTTON, which must be
  // reachable above the open results modal during a running program.
  const { page, errors, close } = await runtimePage('while True:\n    pass');
  t.after(close);
  await waitUntilLoaded(page);

  await page.click('#btn-run');
  await page.waitForSelector('#results-modal:not(.hidden)', { timeout: 10_000 });
  await page.click('#btn-stop');
  await page.waitForFunction(
    () => /Run stopped/.test(document.getElementById('status-bar')?.textContent ?? ''),
    undefined,
    { timeout: 15_000 },
  );

  const stopped = await page.evaluate(() => ({
    transcript: document.querySelector('[data-console-transcript]')?.textContent ?? '',
    runEnabled: !document.getElementById('btn-run').disabled,
    stopHidden: document.getElementById('btn-stop').classList.contains('hidden'),
  }));
  assert.match(stopped.transcript, /Run stopped\./);
  assert.equal(stopped.runEnabled, true, 'the run button is back');
  assert.equal(stopped.stopHidden, true, 'the stop button is hidden again');

  // Worker respawn proof: close the console (standard flow), then run again —
  // the budget watchdog firing proves the new worker is alive and tracing.
  await page.click('#btn-close-results-modal');
  await page.click('#btn-run');
  await page.waitForFunction(
    () => /Your program ran too long/.test(document.getElementById('status-bar')?.textContent ?? ''),
    undefined,
    { timeout: 25_000 },
  );
  assert.deepEqual(errors, []);
});

test('a C-level hang is terminated by the silence watchdog with the timeout message', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, errors, close } = await runtimePage('print("go")\nsum(range(10 ** 12))');
  t.after(close);
  await waitUntilLoaded(page);

  await page.click('#btn-run');
  await page.waitForSelector('#results-modal:not(.hidden)', { timeout: 10_000 });

  // No Python trace events fire inside sum(), so only the JS silence watchdog
  // (20 s with no output) can stop this.
  await page.waitForFunction(
    () => /Execution timed out/.test(document.getElementById('status-bar')?.textContent ?? ''),
    undefined,
    { timeout: 35_000 },
  );

  const state = await page.evaluate(() => ({
    transcript: document.querySelector('[data-console-transcript]')?.textContent ?? '',
    runEnabled: !document.getElementById('btn-run').disabled,
  }));
  assert.match(state.transcript, /go/, 'output before the hang is preserved');
  assert.match(state.transcript, /Execution timed out/, 'the timeout message reached the console');
  assert.equal(state.runEnabled, true, 'the page recovered');
  assert.deepEqual(errors, []);
});

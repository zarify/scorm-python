/**
 * Interactive input in a real browser: the dialog round-trip and its replay.
 *
 * The test injects the completed two-line program (the shipped starter is the
 * commented scaffold) so the dialog flow can be driven end to end: prompt
 * streams into the console, the dialog collects the answer, the program
 * replays, and the final console equals one single attempt — no duplicated
 * preamble. Cancel stops the run.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchBrowser, newPage, serveRuntimeWithConfig } from './helpers/harness.js';
import { MOCK_SCORM_INIT } from './helpers/mock-lms.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const GREET = JSON.parse(readFileSync(join(REPO_ROOT, 'examples/greet-input.json'), 'utf8'));

const PROGRAM = 'name = input("What is your name?")\nprint("Hello, " + name + "!")';

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

async function greetPage() {
  const server = await serveRuntimeWithConfig({
    ...GREET,
    python_setup: { ...GREET.python_setup, starter_code: PROGRAM },
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

test('the dialog round-trip yields one coherent transcript', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, errors, close } = await greetPage();
  t.after(close);
  await waitUntilLoaded(page);

  await page.click('#btn-run');
  await page.waitForSelector('#input-dialog:not(.hidden)', { timeout: 30_000 });

  const promptVisible = await page.evaluate(() => {
    const transcript = document.querySelector('[data-console-transcript]');
    const transcriptBox = transcript?.getBoundingClientRect();
    const dialogBox = document.getElementById('input-dialog')?.getBoundingClientRect();
    return {
      console: transcript?.textContent ?? '',
      promptLabel: document.getElementById('input-dialog-label')?.textContent ?? '',
      dockedBelow: Boolean(transcriptBox && dialogBox && dialogBox.top >= transcriptBox.bottom - 1),
    };
  });
  assert.match(promptVisible.console, /What is your name\?/, 'the prompt streamed into the console');
  assert.equal(promptVisible.promptLabel, 'What is your name?', 'the dialog carries the prompt text');
  assert.equal(promptVisible.dockedBelow, true, 'the input bar docks below the transcript, never over it');

  await page.fill('#input-dialog-field', 'Ada');
  await page.click('#btn-input-ok');

  await page.waitForFunction(
    () => /Program finished/.test(document.getElementById('status-bar')?.textContent ?? ''),
    undefined,
    { timeout: 30_000 },
  );

  // Exactly one attempt's worth of rows: the prompt line now carries the
  // answer (a replay bug would duplicate the prompt), the greeting follows as
  // an output row, and every row shares the same chip gutter.
  const rows = await page.evaluate(
    () => [...document.querySelectorAll('[data-console-transcript] .console-entry')].map((el) => ({
      type: ([...el.classList].find((name) => name.startsWith('console-entry-') && name !== 'console-entry') ?? '')
        .replace('console-entry-', ''),
      badge: el.querySelector('.console-entry-badge')?.textContent ?? '',
      text: el.querySelector('.console-entry-value')?.textContent ?? '',
    })),
  );
  assert.deepEqual(rows, [
    { type: 'input', badge: 'in', text: 'What is your name? Ada' },
    { type: 'output', badge: 'out', text: 'Hello, Ada!' },
    { type: 'status', badge: 'done', text: 'Program finished.' },
  ]);
  assert.deepEqual(errors, []);
});

test('cancelling at the dialog stops the run', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, errors, close } = await greetPage();
  t.after(close);
  await waitUntilLoaded(page);

  await page.click('#btn-run');
  await page.waitForSelector('#input-dialog:not(.hidden)', { timeout: 30_000 });

  await page.click('#btn-input-cancel');

  await page.waitForFunction(
    () => /Run stopped/.test(document.getElementById('status-bar')?.textContent ?? ''),
    undefined,
    { timeout: 20_000 },
  );

  const state = await page.evaluate(() => ({
    dialogHidden: document.getElementById('input-dialog').classList.contains('hidden'),
    transcript: document.querySelector('[data-console-transcript]')?.textContent ?? '',
    runEnabled: !document.getElementById('btn-run').disabled,
    stopHidden: document.getElementById('btn-stop').classList.contains('hidden'),
  }));
  assert.equal(state.dialogHidden, true, 'the dialog closed');
  assert.match(state.transcript, /Run stopped\./);
  assert.equal(state.runEnabled, true, 'the run button is back');
  assert.equal(state.stopHidden, true, 'the stop button is hidden again');
  assert.deepEqual(errors, []);
});

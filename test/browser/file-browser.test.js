/**
 * Editor file tabs and the modal Files panel against the real runtime.
 *
 * csv-average seeds data.csv from the config, so the tab strip proves seeds
 * are browsable before any run; a run writing out.txt proves the harness
 * workspaceFiles snapshot reaches both the tab strip and the Files panel.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchBrowser, newPage, serveRuntimeWithConfig } from './helpers/harness.js';
import { MOCK_SCORM_INIT } from './helpers/mock-lms.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CSV_AVERAGE = JSON.parse(readFileSync(join(REPO_ROOT, 'examples/csv-average.json'), 'utf8'));

const WRITE_PROGRAM = [
  'with open("out.txt", "w") as f:',
  '    f.write("hello browser")',
  'print("done")',
  '',
].join('\n');

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

function withStarter(source) {
  return {
    ...CSV_AVERAGE,
    python_setup: { ...CSV_AVERAGE.python_setup, starter_code: source },
  };
}

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

async function waitUntilLoaded(page) {
  await page.waitForFunction(
    () => /Activity loaded/.test(document.getElementById('status-bar')?.textContent ?? ''),
    undefined,
    { timeout: 30_000 },
  );
}

async function editorText(page) {
  return page.evaluate(() => [...document.querySelectorAll('.cm-line')]
    .map((line) => line.textContent)
    .join('\n'));
}

test('seeded files are browsable before any run', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, errors, close } = await runtimePage(withStarter(''));
  t.after(close);
  await waitUntilLoaded(page);

  assert.ok(await page.$('#file-tabs .file-tab[data-file-id="main.py"]'), 'main tab exists');
  assert.ok(await page.$('#file-tabs .file-tab[data-file-id="data.csv"]'), 'seed tab exists');
  assert.equal(
    await page.getAttribute('#file-tabs .file-tab[data-file-id="main.py"]', 'class'),
    'file-tab active',
    'main is the active tab',
  );

  await page.click('#file-tabs .file-tab[data-file-id="data.csv"]');
  assert.equal(await page.getAttribute('.cm-content', 'contenteditable'), 'false', 'file tab is read-only');
  assert.match(await editorText(page), /name,score/, 'the seeded CSV content is shown');

  await page.click('#file-tabs .file-tab[data-file-id="main.py"]');
  assert.equal(await page.getAttribute('.cm-content', 'contenteditable'), 'true', 'main.py is editable again');
  assert.deepEqual(errors, []);
});

test('files written by a run appear as tabs and in the modal Files panel', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, errors, close } = await runtimePage(withStarter(WRITE_PROGRAM));
  t.after(close);
  await waitUntilLoaded(page);

  await page.click('#btn-run');
  await page.waitForFunction(
    () => /Program finished\./.test(document.getElementById('status-bar')?.textContent ?? ''),
    undefined,
    { timeout: 30_000 },
  );

  await page.click('#btn-tab-files');
  const filesPanel = await page.textContent('#files-panel');
  assert.match(filesPanel, /out\.txt/, 'the written file is listed');
  assert.match(filesPanel, /data\.csv/, 'the seed file is listed');
  assert.match(filesPanel, /changed/, 'the written file carries the changed badge');
  await page.click('#btn-close-results-modal');

  assert.ok(await page.$('[data-file-id="out.txt"]'), 'the run-written tab exists');
  assert.ok(
    await page.$('[data-file-id="out.txt"] .file-tab-dot'),
    'the run-written tab carries the modified dot',
  );

  await page.click('[data-file-id="out.txt"]');
  assert.equal(await page.getAttribute('.cm-content', 'contenteditable'), 'false', 'file tab is read-only');
  assert.match(await editorText(page), /hello browser/, 'the written file content is shown');

  await page.click('[data-file-id="main.py"]');
  assert.match(await editorText(page), /with open\("out\.txt", "w"\)/, 'back to the student program');
  assert.deepEqual(errors, []);
});

test('reset drops run-written tabs back to the seeds', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, errors, close } = await runtimePage(withStarter(WRITE_PROGRAM));
  t.after(close);
  await waitUntilLoaded(page);

  await page.click('#btn-run');
  await page.waitForFunction(
    () => /Program finished\./.test(document.getElementById('status-bar')?.textContent ?? ''),
    undefined,
    { timeout: 30_000 },
  );
  await page.click('#btn-close-results-modal');
  assert.ok(await page.$('[data-file-id="out.txt"]'), 'the run-written tab exists before reset');

  await page.click('#btn-reset');
  assert.equal(await page.$('[data-file-id="out.txt"]'), null, 'the run-written tab is gone');
  assert.ok(await page.$('[data-file-id="data.csv"]'), 'the seed tab is still present');
  assert.equal(
    await page.getAttribute('#file-tabs .file-tab[data-file-id="main.py"]', 'class'),
    'file-tab active',
    'main.py is the active tab after reset',
  );
  assert.equal(await page.getAttribute('.cm-content', 'contenteditable'), 'true', 'the editor is editable');
  assert.deepEqual(errors, []);
});

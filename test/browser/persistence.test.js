/**
 * Two-layer persistence against a mock LMS: suspend_data round-trip, and the
 * truncated-write fallback to IndexedDB.
 *
 * The payload is `{code}` (the Python port's state shape), so these tests span
 * the codec, both persistence layers, and the CodeMirror editor.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchBrowser, newPage, serveRuntimeWithConfig } from './helpers/harness.js';
import { MOCK_SCORM_INIT, readLmsModel } from './helpers/mock-lms.js';

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

async function runtimePage(seedModel) {
  const server = await serveRuntimeWithConfig(HELLO_WORLD);
  const handle = await newPage(browser, {
    url: `${server.origin}/index.html`,
    initScripts: [
      { fn: MOCK_SCORM_INIT, arg: { seedModel: { 'cmi.core.student_id': 'student-42', ...seedModel } } },
    ],
  });
  return {
    ...handle,
    page: handle.page,
    reload: () => handle.page.reload({ waitUntil: 'load' }),
    close: async () => {
      await handle.close();
      await server.close();
    },
  };
}

async function waitUntilLoaded(page) {
  await page.waitForFunction(
    () => /Activity loaded|Welcome back/.test(document.getElementById('status-bar')?.textContent ?? ''),
    undefined,
    { timeout: 30_000 },
  );
}

async function editorText(page) {
  return page.evaluate(() => [...document.querySelectorAll('.cm-line')]
    .map((line) => line.textContent)
    .join('\n'));
}

async function readIndexedDbRecords(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('python-scorm', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise((resolve, reject) => {
      const request = db.transaction('workspace_state', 'readonly')
        .objectStore('workspace_state')
        .getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  });
}

test('edited code survives a reload through cmi.suspend_data', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const session = await runtimePage({});
  const { page, errors } = session;
  t.after(session.close);
  await waitUntilLoaded(page);

  await page.click('.cm-content');
  await page.keyboard.type('print("persisted")');

  // Debounced save (1 s) + verified LMS write.
  await page.waitForFunction(() => {
    const raw = localStorage.getItem('mock-scorm-model');
    if (!raw) return false;
    const model = JSON.parse(raw);
    return typeof model['cmi.suspend_data'] === 'string'
      && model['cmi.suspend_data'].includes('persisted');
  }, undefined, { timeout: 15_000 });

  const beforeReload = await readLmsModel(page);
  assert.ok(beforeReload['cmi.suspend_data'].startsWith('BS1|'), 'the codec payload was written');

  await session.reload();
  await page.waitForFunction(
    () => /Welcome back .* your saved code has been restored/.test(
      document.getElementById('status-bar')?.textContent ?? '',
    ),
    undefined,
    { timeout: 30_000 },
  );

  const restored = await editorText(page);
  assert.match(restored, /print\("persisted"\)/, 'the code came back from suspend_data');
  assert.deepEqual(errors, []);
});

test('local autosave reaches IndexedDB before suspend_data is synced to the LMS copy', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const session = await runtimePage({});
  const { page, errors } = session;
  t.after(session.close);
  await waitUntilLoaded(page);

  await page.click('.cm-content');
  await page.keyboard.type('print("staged locally first")');
  await page.waitForTimeout(2500);

  const earlyModel = await readLmsModel(page);
  assert.equal(
    earlyModel['cmi.suspend_data'] ?? '',
    '',
    'the portable LMS copy is deferred while the local autosave lands first',
  );

  const records = await readIndexedDbRecords(page);
  assert.ok(
    records.some((record) => record?.state?.code?.includes('staged locally first')),
    'the local IndexedDB autosave already captured the edit',
  );

  await page.waitForFunction(() => {
    const raw = localStorage.getItem('mock-scorm-model');
    if (!raw) return false;
    const model = JSON.parse(raw);
    return typeof model['cmi.suspend_data'] === 'string'
      && model['cmi.suspend_data'].includes('staged locally first');
  }, undefined, { timeout: 15_000 });

  assert.deepEqual(errors, []);
});

test('a truncated suspend_data write falls back to IndexedDB and still restores', async (t) => {
  if (skipReason) return t.skip(skipReason);

  // The LMS truncates suspend_data to 120 chars; the typed program pushes the
  // payload well past that, so layer 1 rejects the write, layer 2 keeps the
  // full snapshot, and layer 1 ends up holding a small reference payload.
  const session = await runtimePage({ __suspendDataLimit: 120 });
  const { page, errors } = session;
  t.after(session.close);
  await waitUntilLoaded(page);

  const longLine = `print("${'a'.repeat(240)}")`;
  await page.click('.cm-content');
  await page.keyboard.type(longLine);

  await page.waitForFunction(() => {
    const raw = localStorage.getItem('mock-scorm-model');
    if (!raw) return false;
    const model = JSON.parse(raw);
    const payload = model['cmi.suspend_data'] || '';
    const segments = payload.split('|');
    // BS1|<activity>|<format>|<saved_at>|<data> — format 'I' is the reference.
    return payload.startsWith('BS1|') && segments[2] === 'I';
  }, undefined, { timeout: 15_000 });

  const truncated = await readLmsModel(page);
  assert.ok(
    truncated['cmi.suspend_data'].length <= 140,
    `reference payload stays small (${truncated['cmi.suspend_data'].length} chars)`,
  );

  await session.reload();
  await page.waitForFunction(
    () => /Welcome back .* your saved code has been restored/.test(
      document.getElementById('status-bar')?.textContent ?? '',
    ),
    undefined,
    { timeout: 30_000 },
  );

  const restored = await editorText(page);
  assert.match(restored, /a{50}/, 'the full program came back from IndexedDB');
  assert.deepEqual(errors, []);
});

import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { loadCorpus } from '../curriculum/corpus.js';
import { launchBrowser, newPage, serveRuntimeWithConfig } from './helpers/harness.js';
import { MOCK_SCORM_INIT } from './helpers/mock-lms.js';

const corpus = new Map((await loadCorpus()).map((activity) => [activity.slug, activity]));
let browser;
let skipReason = null;

before(async () => {
  browser = await launchBrowser();
  if (!browser) skipReason = 'no Chromium available (see README: npx playwright install chromium)';
});

after(async () => {
  await browser?.close();
});

async function openActivity(t, activity, source) {
  const config = {
    ...activity.config,
    python_setup: { ...activity.config.python_setup, starter_code: source },
  };
  const server = await serveRuntimeWithConfig(config);
  const handle = await newPage(browser, {
    url: `${server.origin}/index.html`,
    initScripts: [
      { fn: MOCK_SCORM_INIT, arg: { seedModel: { 'cmi.core.student_id': 'curriculum-smoke' } } },
    ],
  });
  t.after(async () => {
    await handle.close();
    await server.close();
  });
  await handle.page.waitForFunction(
    () => /Activity loaded/.test(document.getElementById('status-bar')?.textContent ?? '')
      && /Python is ready/.test(document.getElementById('status-bar')?.textContent ?? ''),
    undefined,
    { timeout: 60_000 },
  );
  return handle;
}

async function checkAndReadResults(page) {
  await page.click('#btn-check');
  await page.waitForSelector('#results-modal:not(.hidden)', { timeout: 60_000 });
  return page.locator('#results-modal').textContent();
}

async function typeMisconceptionAndCheckHint(page, activity, misconception) {
  await page.locator('.cm-content').fill(misconception.source);
  const hintId = misconception.hints[0];
  const hint = page.locator(`#hint-panel [data-hint-id="${hintId}"]`);
  await hint.waitFor({ state: 'visible', timeout: 15_000 });
  const hintText = await hint.textContent();
  const configuredHint = activity.config.hints.find((entry) => entry.id === hintId);
  assert.ok(configuredHint, `${activity.slug}: configured hint ${hintId} exists`);
  assert.ok(hintText.includes(renderedMarkdownText(configuredHint.message)), `${activity.slug}: authored H2 message is visible while editing`);
  return hintId;
}

function renderedMarkdownText(markdown) {
  return markdown.replace(/`([^`]+)`/g, '$1');
}

test('29-csv-average reference scores 100 in the student runtime', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const activity = corpus.get('29-csv-average');
  const { page, errors } = await openActivity(t, activity, activity.reference);
  const results = await checkAndReadResults(page);

  assert.match(results, /Score: 100%/);
  assert.deepEqual(errors, []);
});

test('29-csv-average misconception shows its feedback and H2 hint', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const activity = corpus.get('29-csv-average');
  const misconception = activity.misconceptions.find((entry) => entry.hints.includes('hint-header'));
  const { page, errors } = await openActivity(t, activity, '');
  await typeMisconceptionAndCheckHint(page, activity, misconception);
  const results = await checkAndReadResults(page);
  const failedTest = activity.config.evaluation.test_cases.find((entry) => misconception.fails.includes(entry.id));

  assert.ok(failedTest.feedback_on_fail);
  assert.ok(results.includes(renderedMarkdownText(failedTest.feedback_on_fail)), 'the authored failure feedback is visible');
  assert.match(results, /Some automated checks failed/);
  assert.deepEqual(errors, []);
});

test('35-class-definition reference scores 100 in the student runtime', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const activity = corpus.get('35-class-definition');
  const { page, errors } = await openActivity(t, activity, activity.reference);
  const results = await checkAndReadResults(page);

  assert.match(results, /Score: 100%/);
  assert.deepEqual(errors, []);
});

test('35-class-definition misconception shows its feedback and H2 hint', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const activity = corpus.get('35-class-definition');
  const misconception = activity.misconceptions.find((entry) => entry.hints.includes('hint-init'));
  const { page, errors } = await openActivity(t, activity, '');
  await typeMisconceptionAndCheckHint(page, activity, misconception);
  const results = await checkAndReadResults(page);
  const failedTest = activity.config.evaluation.test_cases.find((entry) => misconception.fails.includes(entry.id));

  assert.ok(failedTest.feedback_on_fail);
  assert.ok(results.includes(renderedMarkdownText(failedTest.feedback_on_fail)), 'the authored failure feedback is visible');
  assert.match(results, /Some automated checks failed/);
  assert.deepEqual(errors, []);
});

test('36-modular-program imports its seeded helper in the real Pyodide worker', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const activity = corpus.get('36-modular-program');
  const { page, errors } = await openActivity(t, activity, activity.reference);
  const results = await checkAndReadResults(page);

  assert.match(results, /Score: 100%/, 'the seeded helper.py module imported and its function ran');
  assert.deepEqual(errors, []);
});

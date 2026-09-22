/**
 * AST structure tests and file_state against the real runtime.
 *
 * csv-average seeds data.csv from the config, so a passing run proves the
 * whole chain: seeded files visible to the program, a student-written
 * result.csv read back, and csv assertions evaluated — plus the AST gate and
 * the exists:false polarity.
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

const CORRECT_SOLUTION = [
  'import csv',
  'total = 0',
  'count = 0',
  'with open("data.csv") as f:',
  '    reader = csv.reader(f)',
  '    next(reader)',
  '    for row in reader:',
  '        total += int(row[1])',
  '        count += 1',
  'average = total / count',
  'print(average)',
  'with open("result.csv", "w") as f:',
  '    f.write(str(int(average)))',
  '',
].join('\n');

const WRONG_FILE_SOLUTION = CORRECT_SOLUTION.replace(
  'f.write(str(int(average)))',
  'f.write("8")',
);

const WHILE_ONLY_SOLUTION = 'while True:\n    break\nprint(7)\n';

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

async function runCheck(config) {
  const server = await serveRuntimeWithConfig(config);
  const handle = await newPage(browser, {
    url: `${server.origin}/index.html`,
    initScripts: [
      { fn: MOCK_SCORM_INIT, arg: { seedModel: { 'cmi.core.student_id': 'student-42' } } },
    ],
  });
  const { page } = handle;
  try {
    await page.waitForFunction(
      () => /Activity loaded/.test(document.getElementById('status-bar')?.textContent ?? ''),
      undefined,
      { timeout: 30_000 },
    );
    await page.click('#btn-check');
    await page.waitForSelector('#results-modal:not(.hidden)', { timeout: 30_000 });
    await page.waitForFunction(
      () => !document.getElementById('btn-check').disabled,
      undefined,
      { timeout: 60_000 },
    );
    const results = await page.textContent('#results-modal');
    const status = await page.textContent('#status-bar');
    return { results, status, errors: handle.errors };
  } finally {
    await handle.close();
    await server.close();
  }
}

function withStarter(source, extraTests) {
  const config = {
    ...CSV_AVERAGE,
    python_setup: { ...CSV_AVERAGE.python_setup, starter_code: source },
  };
  if (extraTests) {
    config.evaluation = { ...config.evaluation, test_cases: extraTests };
  }
  return config;
}

test('a while-only solution fails the AST structure gate and locks the rest', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { results, errors } = await runCheck(withStarter(WHILE_ONLY_SOLUTION));

  assert.match(results, /Some automated checks failed/);
  // Inline markdown renders `for` as <code>, so backticks are gone from textContent.
  assert.match(results, /Use a for loop to walk through data\.csv\./, 'the code_structure feedback is shown');
  assert.match(results, /Other tests remain unpassed\./, 'require_previous_test_pass locked the rest');
  assert.deepEqual(errors, []);
});

test('the correct solution passes every check including the csv file_state', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { results, errors } = await runCheck(withStarter(CORRECT_SOLUTION));

  assert.match(results, /All automated checks passed/, results);
  assert.match(results, /You loop over the data\./);
  assert.match(results, /The printed average is correct\./);
  assert.match(results, /result\.csv contains the average\./);
  assert.match(results, /Score: 100%/);
  assert.deepEqual(errors, []);
});

test('a wrong result.csv fails with the csv cell detail', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { results, errors } = await runCheck(withStarter(WRONG_FILE_SOLUTION));

  assert.match(results, /Some automated checks failed/);
  assert.match(results, /Write the average to result\.csv/, 'the configured feedback shows');
  assert.match(results, /Expected cell \[0\]\[0\] equals "7"/, 'the cell detail is student-visible');
  assert.match(results, /got "8"/);
  assert.deepEqual(errors, []);
});

test('exists:false passes only while the file is absent', async (t) => {
  if (skipReason) return t.skip(skipReason);

  const existsTest = {
    id: 'test_no_never',
    type: 'file_state',
    points: 10,
    feedback_on_pass: 'never.txt was correctly not created.',
    feedback_on_fail: 'never.txt must not be created.',
    path: 'never.txt',
    exists: false,
    format: 'text',
    prompt_inputs: [],
    strict_prompt_inputs: true,
  };

  const absent = await runCheck(withStarter('print("ok")\n', [existsTest]));
  assert.match(absent.results, /All automated checks passed/, absent.results);
  assert.match(absent.results, /never\.txt was correctly not created\./);
  assert.deepEqual(absent.errors, []);

  const present = await runCheck(withStarter('open("never.txt", "w").write("x")\n', [existsTest]));
  assert.match(present.results, /Some automated checks failed/);
  assert.match(present.results, /never\.txt must not be created\./);
  assert.match(present.results, /not to exist/, 'the polarity detail reaches the student');
  assert.deepEqual(present.errors, []);
});

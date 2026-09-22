/**
 * Hint conditions against a real browser while the student types.
 *
 * The reported flow: a `for` header with an empty body is an IndentationError,
 * yet the `source_regex` condition is already in the source. Text-only
 * conditions must evaluate anyway (the regex hint ticks immediately), while an
 * `ast_pattern` waits for parseable code — then ticks once the body holds a
 * `pass` (the statement-position `_` wildcard).
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

// No display_mode on purpose: hints must default to the visible checklist mode.
const CONFIG = {
  ...HELLO_WORLD,
  python_setup: { ...HELLO_WORLD.python_setup, starter_code: '' },
  hints: [
    {
      id: 'hint_regex',
      trigger: {
        event: 'code_change',
        conditions: { type: 'source_regex', pattern: 'for \\w+ in range\\(len\\(\\w+\\)\\):' },
      },
      message: 'Loop with for q in range(len(questions)).',
    },
    {
      id: 'hint_ast',
      trigger: {
        event: 'code_change',
        conditions: { type: 'ast_pattern', pattern: 'for _ in range(_):\n    _' },
      },
      message: 'The loop body needs a statement.',
    },
  ],
};

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

test('a regex hint ticks while the code is unparsed; the AST hint waits for a body', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const server = await serveRuntimeWithConfig(CONFIG);
  const handle = await newPage(browser, {
    url: `${server.origin}/index.html`,
    initScripts: [
      { fn: MOCK_SCORM_INIT, arg: { seedModel: { 'cmi.core.student_id': 'student-42' } } },
    ],
  });
  t.after(async () => {
    await handle.close();
    await server.close();
  });
  const { page, errors } = handle;

  await page.waitForFunction(
    () => /Activity loaded/.test(document.getElementById('status-bar')?.textContent ?? ''),
    undefined,
    { timeout: 30_000 },
  );

  // Both checklist items exist and are unticked before any code is typed.
  const initial = await page.evaluate(
    () => document.querySelectorAll('.hint-checklist-item').length,
  );
  assert.equal(initial, 2, 'hints default to visible checklist items from load');

  await page.click('.cm-content');
  await page.keyboard.type('for q in range(len(questions)):');

  // Debounced code_change (500 ms) + one batched analyze.
  await page.waitForSelector('.hint-checklist-item.is-complete', { timeout: 20_000 });
  const midTyping = await page.evaluate(() => [...document.querySelectorAll('.hint-checklist-item')]
    .map((el) => ({
      complete: el.classList.contains('is-complete'),
      text: el.querySelector('.hint-checklist-message')?.textContent ?? '',
    })));
  assert.match(midTyping[0].text, /range\(len\(questions\)\)/, 'regex hint listed first');
  assert.equal(midTyping[0].complete, true, 'the regex condition matches the raw text even though the file does not parse');
  assert.equal(midTyping[1].complete, false, 'the AST condition cannot pass while the file does not parse');

  await page.keyboard.type('\n    pass');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.hint-checklist-item')]
      .every((el) => el.classList.contains('is-complete')),
    undefined,
    { timeout: 20_000 },
  );
  assert.deepEqual(errors, []);
});

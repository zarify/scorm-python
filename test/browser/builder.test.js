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

test('all tabs render and activate', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, errors, close } = await builderPage();
  t.after(close);

  const tabs = await page.evaluate(() => [...document.querySelectorAll('.tab-btn')]
    .map((button) => button.dataset.tab));
  assert.deepEqual(tabs, ['config', 'code', 'hints', 'tests', 'preview']);

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

test('condition nodes are containers with collapsible boolean groups', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, errors, close } = await builderPage();
  t.after(close);

  await importConfigIntoBuilder(page, join(EXAMPLES, 'hello-world.json'));
  await openTab(page, 'hints');
  await page.click('.hint-list-item[data-index="0"]');
  await page.waitForSelector('#hint-condition-host > .condition-node');

  const rootSelector = '#hint-condition-host > .condition-node';
  const rootSelect = `${rootSelector} .cond-type-select`;
  const rootAdd = `${rootSelector} > .condition-node-body > .condition-fields > .add-sub-condition`;
  const childrenSelector = `${rootSelector} > .condition-node-body > .condition-fields > .condition-children > .condition-card > [data-condition-host] > .condition-node`;
  await page.selectOption(rootSelect, 'all');
  const initialCount = await page.evaluate(() => window.ActivityBuilder.getConfig().hints[0].trigger.conditions.conditions.length);
  await page.click(rootAdd);
  assert.equal(
    await page.evaluate(() => window.ActivityBuilder.getConfig().hints[0].trigger.conditions.conditions.length),
    initialCount + 1,
  );
  assert.equal(await page.locator(childrenSelector).count(), initialCount + 1, 'each child renders as a condition node');
  assert.equal(
    await page.locator(rootAdd).evaluate((button) => button.closest('.condition-node-body') !== null),
    true,
    'the add button stays inside its owning group body',
  );

  await page.locator(childrenSelector).first().locator('.cond-type-select').selectOption('any');
  const anyGroup = page.locator('#hint-condition-host .condition-node--any').first();
  await anyGroup.locator('.add-sub-condition').click();
  assert.ok(
    await page.locator('#hint-condition-host .condition-node--all .condition-node--any .condition-node').count(),
    'nested boolean groups contain child condition nodes',
  );

  const headerColors = await page.evaluate(() => {
    const host = document.getElementById('hint-condition-host');
    const root = host.querySelector(':scope > .condition-node');
    const any = host.querySelector('.condition-node--any');
    const leaf = any.querySelector(':scope > .condition-node-body > .condition-fields > .condition-children > .condition-card > [data-condition-host] > .condition-node');
    return {
      root: getComputedStyle(root.querySelector(':scope > .condition-node-header')).backgroundColor,
      any: getComputedStyle(any.querySelector(':scope > .condition-node-header')).backgroundColor,
      leaf: getComputedStyle(leaf.querySelector(':scope > .condition-node-header')).backgroundColor,
      leafTitle: getComputedStyle(leaf.querySelector(':scope > .condition-node-header > .condition-node-title')).color,
    };
  });
  assert.deepEqual(headerColors, {
    root: 'rgb(232, 240, 251)',
    any: 'rgb(233, 245, 236)',
    leaf: 'rgb(246, 248, 250)',
    leafTitle: 'rgb(51, 51, 51)',
  });
  assert.equal(await page.locator(`${rootSelector}.condition-node--all`).count(), 1, 'the root exposes the AND tint hook');
  assert.equal(
    await page.locator('#hint-condition-host .condition-node-title').evaluateAll((titles) => titles.every((title) => title.textContent.trim())),
    true,
    'every condition node has a static heading',
  );

  const root = page.locator(rootSelector);
  const rootToggle = page.locator(`${rootSelector} > .condition-node-header > .condition-node-toggle`);
  const rootBody = page.locator(`${rootSelector} > .condition-node-body`);
  const rootSummary = page.locator(`${rootSelector} > .condition-node-header > .condition-node-summary`);
  await rootToggle.click();
  assert.equal(await root.evaluate((node) => node.classList.contains('is-collapsed')), true);
  assert.equal(await rootBody.isHidden(), true);
  assert.equal(await rootToggle.getAttribute('aria-expanded'), 'false');
  assert.match(await rootSummary.textContent(), /sub-condition/);
  assert.equal(await rootSummary.isVisible(), true);
  await rootToggle.click();
  await page.locator('#hint-condition-host .condition-node--any > .condition-node-header > .condition-node-toggle').click();
  await page.locator(rootAdd).click();
  assert.equal(
    await page.locator('#hint-condition-host .condition-node--any').first().evaluate((node) => node.classList.contains('is-collapsed')),
    true,
    'collapsed state survives a parent child-list re-render',
  );

  const indent = await page.evaluate(() => {
    const host = document.getElementById('hint-condition-host');
    return {
      children: [...host.querySelectorAll('.condition-children')].every((node) => {
        const style = getComputedStyle(node);
        return style.marginLeft === '0px' && style.paddingLeft === '0px';
      }),
      bodies: [...host.querySelectorAll('.condition-node-body')]
        .every((node) => getComputedStyle(node).paddingLeft === '12px'),
    };
  });
  assert.deepEqual(indent, { children: true, bodies: true }, 'nesting indent is exactly the node body padding at each level');
  assert.deepEqual(errors, []);
});

test('the tab-nav cannot scroll vertically', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, close } = await builderPage();
  t.after(close);

  const overflow = await page.evaluate(() => {
    const nav = document.getElementById('tab-nav');
    return nav.scrollHeight - nav.clientHeight;
  });
  assert.ok(overflow <= 0, `tab-nav vertical overflow was ${overflow}px`);
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

test('Export SCORM ships gzip runtime assets and includes Pillow only when selected', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, errors, close } = await builderPage();
  t.after(close);

  await importConfigIntoBuilder(page, join(EXAMPLES, 'hello-world.json'));
  // Keep this export-contract test independent of runtime/network validation.
  await page.evaluate(() => {
    const config = window.ActivityBuilder.getConfig();
    config.hints = [];
    config.evaluation.test_cases = config.evaluation.test_cases
      .filter((testCase) => testCase.type !== 'code_structure');
  });
  await openTab(page, 'code');

  // Bundled mode: URL empty → compressed runtime rides along.
  await page.fill('#pyodide-base-url', '');
  const bundled = await exportZip(page);
  const bundledNames = Object.keys(bundled.files);
  for (const name of [
    'pyodide/pyodide.asm.wasm.gz',
    'pyodide/pyodide.asm.js.gz',
    'pyodide/pyodide-lock.json.gz',
    'pyodide/pyodide.js',
    'js/gunzip.js',
  ]) {
    assert.ok(bundledNames.includes(name), `bundled zip carries ${name}`);
  }
  for (const name of [
    'pyodide/pyodide.asm.wasm',
    'pyodide/pyodide.asm.js',
    'pyodide/pyodide-lock.json',
  ]) {
    assert.ok(!bundledNames.includes(name), `bundled zip omits raw ${name}`);
  }
  assert.ok(!bundledNames.some((name) => name.endsWith('.mjs')),
    'bundled zip ships no .mjs files (SCORM hosts serve them with a MIME type browsers reject)');
  assert.ok(bundledNames.includes('python/harness.py'), 'bundled zip carries the harness');
  assert.ok(bundledNames.includes('js/python-worker.js'), 'bundled zip carries the worker');
  assert.ok(bundledNames.includes('imsmanifest.xml'), 'the manifest is present');
  assert.ok(bundledNames.includes('js/app.bundle.js'), 'the student bundle is present');
  assert.ok(!bundledNames.some((name) => /^pyodide\/pillow-.*\.whl$/.test(name)),
    'default packages omit the Pillow wheel');


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
  await page.fill('#pyodide-base-url', '');
  await page.check('#packages-list input[type="checkbox"]');
  const withPillow = await exportZip(page);
  assert.ok(Object.keys(withPillow.files).some((name) => /^pyodide\/pillow-.*\.whl$/.test(name)),
    'selecting Pillow includes its wheel');
  await page.uncheck('#packages-list input[type="checkbox"]');
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

test('function_state can be configured to expect an exception type', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { page, errors, close } = await builderPage();
  t.after(close);

  const configPath = join(REPO_ROOT, 'curriculum/activities/32-raise-error/activity.json');
  await importConfigIntoBuilder(page, configPath);
  await openTab(page, 'tests');
  await page.click('.test-list-item[data-index="0"]');

  const errorType = page.locator('#test-function-return-expected-error-type');
  await errorType.waitFor({ state: 'visible' });
  assert.equal(await errorType.inputValue(), 'ValueError');
  await errorType.fill('TypeError');
  await page.waitForFunction(
    () => window.ActivityBuilder.getConfig().evaluation.test_cases[0].return_assertion.expected_error_type === 'TypeError',
  );
  assert.deepEqual(errors, []);
});

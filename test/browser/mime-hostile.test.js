/**
 * The student runtime under a Moodle-like MIME map.
 *
 * SCORM hosts (Moodle's pluginfile.php among them) only map the common
 * document types and serve everything else as application/octet-stream. A
 * package relying on `.mjs` files never boots there — browsers reject module
 * imports with a non-JavaScript MIME type (Firefox reports
 * NS_ERROR_CORRUPTED_CONTENT on the loader request). This serves the built
 * runtime with only .html/.js/.css/.xml typed and asserts Python still reaches ready,
 * exercising gzip decoding, blob-based asm import, the asset fetch shim, and the
 * stripped standard library under that hostile MIME map.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchBrowser, newPage, serveRuntimeWithConfig } from './helpers/harness.js';
import { MOCK_SCORM_INIT } from './helpers/mock-lms.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const HELLO_WORLD = JSON.parse(
  readFileSync(join(REPO_ROOT, 'examples/hello-world.json'), 'utf8'),
);

// What a Moodle-like host knows: the common document types. Everything
// else — .wasm, .gz, .json, .zip, .whl, .mjs — goes out as application/octet-stream.
const MOODLE_CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.xml': 'application/xml',
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

test('the runtime reaches ready when the host serves unknown extensions as octet-stream', async (t) => {
  if (skipReason) return t.skip(skipReason);

  const server = await serveRuntimeWithConfig(HELLO_WORLD, { contentTypes: MOODLE_CONTENT_TYPES });
  const { page, errors, close } = await newPage(browser, {
    url: `${server.origin}/index.html`,
    initScripts: [
      { fn: MOCK_SCORM_INIT, arg: { seedModel: { 'cmi.core.student_id': 'student-42' } } },
    ],
  });
  t.after(async () => {
    await close();
    await server.close();
  });

  await page.waitForFunction(
    () => /Python is ready/.test(document.getElementById('status-bar')?.textContent ?? ''),
    undefined,
    { timeout: 60_000 },
  );

  assert.match(await page.textContent('#status-bar'), /Python is ready/);
  assert.ok(
    server.requests.some((url) => url.endsWith('/pyodide/pyodide.asm.wasm.gz')),
    'the worker fetches the precompressed wasm asset',
  );
  assert.ok(
    !server.requests.some((url) => url.endsWith('/pyodide/pyodide.asm.wasm')),
    'the worker never requests the raw wasm asset',
  );
  assert.deepEqual(errors, []);
});

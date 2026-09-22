/**
 * Browser test harness.
 *
 * The Node suite covers everything that does not need a DOM. What is left —
 * `Blockly.inject`, the builder's tab rendering, export/import, and the student
 * runtime against a real SCORM API — only exists in a browser, so these tests
 * serve `dist/` and drive it with Playwright.
 *
 * The browser is the Chrome already on the machine (`channel: 'chrome'`), which
 * needs no download. CI without Chrome can run `npx playwright install
 * chromium` and set `PLAYWRIGHT_CHANNEL=chromium` (or leave it unset — the
 * bundled Chromium is the fallback). When neither is available the browser
 * tests skip instead of failing, so `npm test` stays usable everywhere.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
export const DIST = join(REPO_ROOT, 'dist');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.wasm': 'application/wasm',
};

/** Serve a directory over http on an ephemeral port. */
export async function startStaticServer(rootDirectory = DIST) {
  const root = resolve(rootDirectory);

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const requested = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
      let filePath = join(root, requested);

      const stats = await stat(filePath).catch(() => null);
      if (stats?.isDirectory()) {
        filePath = join(filePath, 'index.html');
      }

      const body = await readFile(filePath);
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    }
  });

  await new Promise((resolve_) => server.listen(0, '127.0.0.1', resolve_));
  const { port } = server.address();

  return {
    origin: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve_) => server.close(resolve_));
    },
  };
}

/**
 * Launch a browser, or return null when none is available.
 *
 * Tries, in order: the channel named by `PLAYWRIGHT_CHANNEL`, Playwright's own
 * Chromium (`npx playwright install chromium`), the Chrome already installed on
 * the machine, and finally any Chromium build left in Playwright's cache under
 * a different revision. The last one matters in sandboxes where the installed
 * Chrome refuses to start but a cached Chrome for Testing does not.
 * @returns {Promise<import('playwright').Browser|null>}
 */
export async function launchBrowser() {
  const { chromium } = await import('playwright');
  const candidates = [];

  if (process.env.PLAYWRIGHT_CHANNEL) {
    candidates.push({ channel: process.env.PLAYWRIGHT_CHANNEL });
  }
  candidates.push({});
  candidates.push({ channel: 'chrome' });
  for (const executablePath of await findCachedChromiumExecutables()) {
    candidates.push({ executablePath });
  }

  for (const options of candidates) {
    try {
      return await chromium.launch(options);
    } catch {
      // Try the next candidate; the caller skips when none launches.
    }
  }

  return null;
}

/** Chromium builds sitting in Playwright's browser cache, newest revision first. */
async function findCachedChromiumExecutables() {
  const { readdir } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { homedir } = await import('node:os');

  const cacheRoots = [
    join(homedir(), 'Library/Caches/ms-playwright'),
    join(homedir(), '.cache/ms-playwright'),
    join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData/Local'), 'ms-playwright'),
  ];

  const relativeExecutables = [
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'chrome-linux/chrome',
    'chrome-win/chrome.exe',
  ];

  const found = [];
  for (const root of cacheRoots) {
    const entries = await readdir(root).catch(() => []);
    const revisions = entries
      .filter((entry) => /^chromium-\d+$/.test(entry))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));

    for (const revision of revisions) {
      for (const relative of relativeExecutables) {
        const candidate = join(root, revision, relative);
        if (existsSync(candidate)) {
          found.push(candidate);
          break;
        }
      }
    }
  }

  return found;
}

/**
 * Serve the built student runtime with a config of the test's choosing.
 * The package's own `config/activity_config.json` is replaced in a copy, so the
 * real bundle and HTML are exercised.
 */
export async function serveRuntimeWithConfig(config) {
  const { mkdtemp, cp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');

  const directory = await mkdtemp(join(tmpdir(), 'scorm-runtime-'));
  await cp(join(DIST, 'scorm-template'), directory, { recursive: true });
  await writeFile(join(directory, 'config/activity_config.json'), JSON.stringify(config, null, 2));

  return startStaticServer(directory);
}

/** A page plus a recorder for the errors the browser reports. */
export async function newPage(browser, { url, initScript, initScripts = [] } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];

  page.on('pageerror', (error) => errors.push(`pageerror: ${String(error).split('\n')[0]}`));
  page.on('console', (message) => {
    // HTTP failures are reported below with their URL; the console only says
    // "failed to load resource", which is useless for a missing asset.
    if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) {
      errors.push(`console: ${message.text().split('\n')[0]}`);
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
      errors.push(`http ${response.status()}: ${response.url()}`);
    }
  });

  for (const script of initScript ? [initScript, ...initScripts] : initScripts) {
    if (typeof script === 'function') {
      await page.addInitScript(script);
    } else {
      await page.addInitScript(script.fn, script.arg);
    }
  }

  if (url) await page.goto(url, { waitUntil: 'load' });

  return {
    page,
    errors,
    async close() {
      await context.close();
    },
  };
}

/**
 * Import an activity config through the builder's own file input.
 * The input is hidden, so `setInputFiles` is the only way in.
 */
export async function importConfigIntoBuilder(page, configPath) {
  await page.setInputFiles('#file-import', configPath);
  await page.waitForFunction(
    () => document.getElementById('toast')?.textContent?.length > 0,
    undefined,
    { timeout: 10_000 },
  );
  return page.evaluate(() => document.getElementById('toast').textContent);
}

/** Click a tab and wait for its panel to become active. */
export async function openTab(page, tab) {
  await page.click(`.tab-btn[data-tab="${tab}"]`);
  await page.waitForSelector(`#tab-${tab}.active`, { timeout: 10_000 });
}

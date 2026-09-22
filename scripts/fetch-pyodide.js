/**
 * Fetch the pinned Pyodide runtime into vendor/pyodide/.
 *
 * Files are skipped when already present, so the cache survives rebuilds.
 * The package set is small on purpose: Pillow is the only optional wheel and
 * it has no pyodide dependencies, so its wheel is resolved straight from the
 * lock file. On failure the exact missing filenames are printed so the cache
 * can be populated by hand from the matching pyodide-core release archive.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { basename, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const VENDOR_DIR = resolve(ROOT, 'vendor', 'pyodide');

export const PYODIDE_VERSION = '314.0.7';
export const CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

const CORE_FILES = [
  'pyodide.js',
  'pyodide.mjs',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
];

const OPTIONAL_PACKAGES = ['pillow'];

function isCached(path) {
  try {
    return existsSync(path) && statSync(path).size > 0;
  } catch {
    return false;
  }
}

async function download(url, destPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(destPath, bytes);
}

function resolvePackageWheels(lock) {
  const wheels = [];
  for (const name of OPTIONAL_PACKAGES) {
    const entry = lock?.packages?.[name];
    if (!entry || typeof entry.file_name !== 'string' || entry.file_name.length === 0) {
      throw new Error(`Package '${name}' not found in pyodide-lock.json (required optional package)`);
    }
    wheels.push(basename(entry.file_name));
  }
  return wheels;
}

function directoryTotals(dir) {
  const names = readdirSync(dir);
  let bytes = 0;
  for (const name of names) {
    const path = resolve(dir, name);
    if (statSync(path).isFile()) bytes += statSync(path).size;
  }
  return { count: names.length, bytes };
}

/**
 * Ensure every runtime file exists in vendor/pyodide/, fetching what is
 * missing. Throws with the exact missing filenames when anything is absent.
 */
export async function ensurePyodide() {
  mkdirSync(VENDOR_DIR, { recursive: true });

  const missing = [];
  let fetched = 0;
  let skipped = 0;

  const wanted = [...CORE_FILES];

  for (const name of CORE_FILES) {
    const dest = resolve(VENDOR_DIR, name);
    if (isCached(dest)) {
      skipped += 1;
      continue;
    }
    try {
      await download(CDN + name, dest);
      fetched += 1;
    } catch (err) {
      missing.push(`${name} — ${err.message}`);
    }
  }

  const lockPath = resolve(VENDOR_DIR, 'pyodide-lock.json');
  if (isCached(lockPath)) {
    let wheels;
    try {
      wheels = resolvePackageWheels(JSON.parse(readFileSync(lockPath, 'utf8')));
    } catch (err) {
      throw new Error(`Could not resolve optional packages from pyodide-lock.json — ${err.message}`);
    }
    wanted.push(...wheels);
    for (const name of wheels) {
      const dest = resolve(VENDOR_DIR, name);
      if (isCached(dest)) {
        skipped += 1;
        continue;
      }
      try {
        await download(CDN + name, dest);
        fetched += 1;
      } catch (err) {
        missing.push(`${name} — ${err.message}`);
      }
    }
  } else if (!missing.some((entry) => entry.startsWith('pyodide-lock.json'))) {
    missing.push('pyodide-lock.json — required to resolve optional package wheels');
  }

  if (missing.length > 0) {
    const cachedCount = wanted.filter((name) => isCached(resolve(VENDOR_DIR, name))).length;
    const lines = [
      `Pyodide fetch failed: ${missing.length} file(s) missing from vendor/pyodide/ (cache holds ${cachedCount}/${wanted.length}):`,
      ...missing.map((entry) => `  - ${entry}`),
      '',
      'Populate vendor/pyodide/ manually with these filenames from the matching',
      `pyodide-core-${PYODIDE_VERSION} release archive, then rebuild.`,
    ];
    throw new Error(lines.join('\n'));
  }

  const totals = directoryTotals(VENDOR_DIR);
  if (!ensurePyodide.quiet) {
    console.log(
      `✅ Pyodide ${PYODIDE_VERSION} ready — ${totals.count} files, `
      + `${(totals.bytes / (1024 * 1024)).toFixed(1)} MB in vendor/pyodide/ `
      + `(${fetched} fetched, ${skipped} cached)`,
    );
  }
  return totals;
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  ensurePyodide().catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}

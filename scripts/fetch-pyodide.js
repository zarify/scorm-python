/**
 * Fetch the pinned Pyodide runtime into vendor/pyodide/.
 *
 * Files are skipped when already present, so the cache survives rebuilds.
 * The package set is small on purpose: Pillow is the only optional wheel and
 * it has no pyodide dependencies, so its wheel is resolved straight from the
 * lock file. On failure the exact missing filenames are printed so the cache
 * can be populated by hand from the matching pyodide-core release archive.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const VENDOR_DIR = resolve(ROOT, 'vendor', 'pyodide');

export const PYODIDE_VERSION = '314.0.7';
export const CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

// Upstream ships its ESM entry points as `pyodide.mjs` / `pyodide.asm.mjs`,
// but SCORM hosts (Moodle's pluginfile.php among them) serve unknown
// extensions as application/octet-stream, which browsers reject for module
// imports (Firefox: NS_ERROR_CORRUPTED_CONTENT). The runtime therefore lands
// in vendor/pyodide/ under `.js` names, with Pyodide's internal
// `pyodide.asm.mjs` import patched to match — see normalizeVendorLayout().
// The worker imports `pyodide.js` first and falls back to the upstream name,
// so `pyodide_base_url` hosts serving the stock layout (jsDelivr) keep working.
const CORE_FILES = [
  { upstream: 'pyodide.mjs', shipped: 'pyodide.js' },
  { upstream: 'pyodide.asm.mjs', shipped: 'pyodide.asm.js' },
  { upstream: 'pyodide.asm.wasm', shipped: 'pyodide.asm.wasm' },
  { upstream: 'python_stdlib.zip', shipped: 'python_stdlib.zip' },
  { upstream: 'pyodide-lock.json', shipped: 'pyodide-lock.json' },
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
 * Move the runtime entry points onto `.js` names and patch Pyodide's internal
 * `pyodide.asm.mjs` import to match (see CORE_FILES). Idempotent — it also
 * migrates a vendor/ tree fetched before this rule existed. Throws when the
 * patch no longer applies: a Pyodide bump changed the internal import and this
 * function needs updating.
 */
export function normalizeVendorLayout(dir = VENDOR_DIR) {
  const renames = [
    {
      legacy: 'pyodide.mjs',
      shipped: 'pyodide.js',
      replacements: [['pyodide.asm.mjs', 'pyodide.asm.js']],
    },
    { legacy: 'pyodide.asm.mjs', shipped: 'pyodide.asm.js', replacements: [] },
  ];

  for (const { legacy, shipped, replacements } of renames) {
    const legacyPath = resolve(dir, legacy);
    const shippedPath = resolve(dir, shipped);
    const inputPath = isCached(legacyPath) ? legacyPath : (isCached(shippedPath) ? shippedPath : null);
    if (!inputPath) continue;
    const original = readFileSync(inputPath, 'utf8');
    let source = original;
    for (const [from, to] of replacements) source = source.split(from).join(to);
    if (inputPath !== shippedPath) {
      writeFileSync(shippedPath, source);
      rmSync(legacyPath);
    } else if (source !== original) {
      writeFileSync(shippedPath, source);
    }
  }

  const loader = isCached(resolve(dir, 'pyodide.js'))
    ? readFileSync(resolve(dir, 'pyodide.js'), 'utf8')
    : '';
  if (!isCached(resolve(dir, 'pyodide.asm.js'))
    || !loader.includes('pyodide.asm.js')
    || loader.includes('pyodide.asm.mjs')) {
    throw new Error(
      'vendor/pyodide entry points could not be normalized to .js names. '
      + 'If this follows a Pyodide version bump, the loader no longer imports '
      + "'pyodide.asm.mjs' by that name — update normalizeVendorLayout() in "
      + 'scripts/fetch-pyodide.js. Otherwise delete vendor/pyodide/ and re-fetch.',
    );
  }
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

  for (const { upstream, shipped } of CORE_FILES) {
    const legacyPath = upstream === shipped ? null : resolve(VENDOR_DIR, upstream);
    if (isCached(resolve(VENDOR_DIR, shipped)) || (legacyPath && isCached(legacyPath))) {
      skipped += 1;
      continue;
    }
    try {
      await download(CDN + upstream, resolve(VENDOR_DIR, upstream));
      fetched += 1;
    } catch (err) {
      missing.push(`${upstream} — ${err.message}`);
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
    wanted.push(...wheels.map((name) => ({ upstream: name, shipped: name })));
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
    const cachedCount = wanted
      .filter(({ upstream, shipped }) => isCached(resolve(VENDOR_DIR, shipped))
        || isCached(resolve(VENDOR_DIR, upstream)))
      .length;
    const lines = [
      `Pyodide fetch failed: ${missing.length} file(s) missing from vendor/pyodide/ (cache holds ${cachedCount}/${wanted.length}):`,
      ...missing.map((entry) => `  - ${entry}`),
      '',
      'Populate vendor/pyodide/ manually with these filenames from the matching',
      `pyodide-core-${PYODIDE_VERSION} release archive, then rebuild.`,
    ];
    throw new Error(lines.join('\n'));
  }

  normalizeVendorLayout();

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

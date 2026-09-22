/**
 * Build the SCORM package and/or the activity builder into dist/.
 *
 * Layout contract (both dist trees share it):
 *   dist/<tree>/js/app.bundle.js        esbuild IIFE bundle
 *   dist/<tree>/js/python-worker.js     module worker (sibling of the bundle)
 *   dist/<tree>/python/{astmatch,harness}.py
 *   dist/<tree>/pyodide/…               pinned Pyodide runtime
 *
 * The worker resolves its Python sources and Pyodide runtime relative to its
 * own URL (`../python/`, `../pyodide/`), so it must live exactly one level
 * below the tree root — as `js/python-worker.js` or `preview/python-worker.js`.
 */

import esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ensurePyodide } from './fetch-pyodide.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'src');
const DIST = resolve(ROOT, 'dist');
const BUILDER_DIST = resolve(DIST, 'activity-builder');
const VENDOR_PYODIDE = resolve(ROOT, 'vendor', 'pyodide');

const target = process.argv.find((a) => a.startsWith('--target='))?.split('=')[1] || 'all';

function getProductionBundleOptions() {
  return {
    target: ['es2020'],
    define: {
      'process.env.NODE_ENV': '"production"',
    },
    minify: true,
    sourcemap: false,
  };
}

async function bundleScormApp(outfile) {
  await esbuild.build({
    entryPoints: [resolve(SRC, 'scorm-template/js/app.js')],
    bundle: true,
    outfile,
    format: 'iife',
    globalName: 'PythonScorm',
    ...getProductionBundleOptions(),
  });
}

function copyIfExists(src, dest) {
  if (existsSync(src)) {
    cpSync(src, dest, { recursive: true });
  }
}

function copyPythonRuntime(outDir) {
  mkdirSync(resolve(outDir, 'js'), { recursive: true });
  copyIfExists(resolve(SRC, 'shared/python-worker.js'), resolve(outDir, 'js/python-worker.js'));
  copyIfExists(resolve(SRC, 'shared/python'), resolve(outDir, 'python'));
  copyIfExists(VENDOR_PYODIDE, resolve(outDir, 'pyodide'));
}

function copyBuilderStaticAssets(outDir) {
  copyIfExists(resolve(SRC, 'activity-builder/index.html'), resolve(outDir, 'index.html'));
  copyIfExists(resolve(SRC, 'activity-builder/css'), resolve(outDir, 'css'));
}

function copyPreviewStyle(outDir) {
  copyIfExists(resolve(SRC, 'scorm-template/css/style.css'), resolve(outDir, 'preview/style.css'));
}

function writeBuilderRuntimeAssets(outDir) {
  const previewBundlePath = resolve(outDir, 'preview/app.bundle.js');
  const previewStylePath = resolve(outDir, 'preview/style.css');
  if (!existsSync(previewBundlePath) || !existsSync(previewStylePath)) {
    return;
  }

  const appBundleJs = readFileSync(previewBundlePath, 'utf8');
  const styleCss = readFileSync(previewStylePath, 'utf8');
  // The worker and the Python sources ride along so SCORM export works even
  // from file:// (only the 14 MB Pyodide runtime still needs HTTP).
  const workerJs = readFileSync(resolve(SRC, 'shared/python-worker.js'), 'utf8');
  const astmatchPy = readFileSync(resolve(SRC, 'shared/python/astmatch.py'), 'utf8');
  const harnessPy = readFileSync(resolve(SRC, 'shared/python/harness.py'), 'utf8');
  const script = `globalThis.__SCORM_BUILDER_ASSETS__ = ${JSON.stringify({
    appBundleJs,
    styleCss,
    workerJs,
    astmatchPy,
    harnessPy,
  })};\n`;
  writeFileSync(resolve(outDir, 'runtime-assets.js'), script);
}

function writePyodideManifest() {
  if (!existsSync(VENDOR_PYODIDE)) return;
  const names = readdirSync(VENDOR_PYODIDE).filter((name) => {
    return statSync(resolve(VENDOR_PYODIDE, name)).isFile();
  });
  writeFileSync(resolve(BUILDER_DIST, 'pyodide-manifest.json'), `${JSON.stringify(names, null, 2)}\n`);
}

async function buildScorm() {
  const outDir = resolve(DIST, 'scorm-template');
  mkdirSync(outDir, { recursive: true });

  await bundleScormApp(resolve(outDir, 'js/app.bundle.js'));

  copyIfExists(resolve(SRC, 'scorm-template/index.html'), resolve(outDir, 'index.html'));
  copyIfExists(resolve(SRC, 'scorm-template/css'), resolve(outDir, 'css'));
  copyIfExists(resolve(SRC, 'scorm-template/imsmanifest.xml'), resolve(outDir, 'imsmanifest.xml'));
  copyIfExists(resolve(SRC, 'scorm-template/config'), resolve(outDir, 'config'));
  copyPythonRuntime(outDir);

  console.log('✅ SCORM template built → dist/scorm-template/');
}

async function buildBuilder() {
  const outDir = resolve(DIST, 'activity-builder');
  mkdirSync(resolve(outDir, 'preview'), { recursive: true });

  await esbuild.build({
    entryPoints: [resolve(SRC, 'activity-builder/js/builder-app.js')],
    bundle: true,
    outfile: resolve(outDir, 'js/builder.bundle.js'),
    format: 'iife',
    globalName: 'ActivityBuilder',
    ...getProductionBundleOptions(),
  });

  copyBuilderStaticAssets(outDir);
  await bundleScormApp(resolve(outDir, 'preview/app.bundle.js'));
  copyPreviewStyle(outDir);
  writeBuilderRuntimeAssets(outDir);
  writePyodideManifest();

  // Runtime copies: js/ for the builder page's own engine, plus a preview/
  // worker so the srcdoc iframe resolves `../pyodide/` and `../python/` to
  // the builder tree root.
  copyPythonRuntime(outDir);
  copyIfExists(
    resolve(SRC, 'shared/python-worker.js'),
    resolve(outDir, 'preview/python-worker.js'),
  );

  console.log('✅ Activity builder built → dist/activity-builder/');
}

async function main() {
  mkdirSync(DIST, { recursive: true });

  try {
    await ensurePyodide();
    if (target === 'all' || target === 'scorm') {
      await buildScorm();
    }
    if (target === 'all' || target === 'builder') {
      await buildBuilder();
    }
    console.log('\n🔨 Build complete.');
  } catch (err) {
    console.error(`❌ Build failed: ${err.message}`);
    process.exit(1);
  }
}

main();

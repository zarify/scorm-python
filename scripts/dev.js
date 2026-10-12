import esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { basename, resolve, dirname, sep } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'src');
const DIST = resolve(ROOT, 'dist');
const BUILDER_DIST = resolve(DIST, 'activity-builder');

async function bundleScormApp(outfile) {
  await esbuild.build({
    entryPoints: [resolve(SRC, 'scorm-template/js/app.js')],
    bundle: true,
    outfile,
    format: 'iife',
    globalName: 'PythonScorm',
    sourcemap: true,
    target: ['es2020'],
  });
}

function copyIfExists(src, dest, options = {}) {
  if (existsSync(src)) {
    cpSync(src, dest, { recursive: true, ...options });
  }
}

function copyPythonRuntime(outDir) {
  mkdirSync(resolve(outDir, 'js'), { recursive: true });
  copyIfExists(resolve(SRC, 'shared/python-worker.js'), resolve(outDir, 'js/python-worker.js'));
  copyIfExists(resolve(SRC, 'shared/gunzip.js'), resolve(outDir, 'js/gunzip.js'));
  rmSync(resolve(outDir, 'python'), { recursive: true, force: true });
  copyIfExists(resolve(SRC, 'shared/python'), resolve(outDir, 'python'), {
    filter: (source) => !source.split(sep).includes('__pycache__'),
  });
  // Mirror vendor/pyodide exactly except for source assets replaced by gzip.
  // Clear first so files renamed or dropped cannot linger in dist or exports.
  rmSync(resolve(outDir, 'pyodide'), { recursive: true, force: true });
  copyIfExists(resolve(ROOT, 'vendor/pyodide'), resolve(outDir, 'pyodide'), {
    filter: (source) => !['pyodide.asm.wasm', 'pyodide.asm.js', 'pyodide-lock.json']
      .includes(basename(source)),
  });
}

function copyBuilderStaticAssets() {
  mkdirSync(BUILDER_DIST, { recursive: true });
  copyIfExists(resolve(SRC, 'activity-builder/index.html'), resolve(BUILDER_DIST, 'index.html'));
  copyIfExists(resolve(SRC, 'activity-builder/css'), resolve(BUILDER_DIST, 'css'));
}

function copyPreviewStyle() {
  mkdirSync(resolve(BUILDER_DIST, 'preview'), { recursive: true });
  copyIfExists(resolve(SRC, 'scorm-template/css/style.css'), resolve(BUILDER_DIST, 'preview/style.css'));
}

function writeBuilderRuntimeAssets() {
  const previewBundlePath = resolve(BUILDER_DIST, 'preview/app.bundle.js');
  const previewStylePath = resolve(BUILDER_DIST, 'preview/style.css');
  if (!existsSync(previewBundlePath) || !existsSync(previewStylePath)) {
    return;
  }

  const appBundleJs = readFileSync(previewBundlePath, 'utf8');
  const styleCss = readFileSync(previewStylePath, 'utf8');
  // Keep in sync with scripts/build.js: worker and Python sources support file:// exports.
  const workerJs = readFileSync(resolve(SRC, 'shared/python-worker.js'), 'utf8');
  const astmatchPy = readFileSync(resolve(SRC, 'shared/python/astmatch.py'), 'utf8');
  const harnessPy = readFileSync(resolve(SRC, 'shared/python/harness.py'), 'utf8');
  const gunzipJs = readFileSync(resolve(SRC, 'shared/gunzip.js'), 'utf8');
  const script = `globalThis.__SCORM_BUILDER_ASSETS__ = ${JSON.stringify({
    appBundleJs,
    styleCss,
    workerJs,
    astmatchPy,
    harnessPy,
    gunzipJs,
  })};\n`;
  writeFileSync(resolve(BUILDER_DIST, 'runtime-assets.js'), script);
}

async function dev() {
  copyBuilderStaticAssets();
  copyPreviewStyle();
  copyPythonRuntime(BUILDER_DIST);
  copyIfExists(resolve(SRC, 'shared/python-worker.js'), resolve(BUILDER_DIST, 'preview/python-worker.js'));
  copyIfExists(resolve(SRC, 'shared/gunzip.js'), resolve(BUILDER_DIST, 'preview/gunzip.js'));

  const builderCtx = await esbuild.context({
    entryPoints: [resolve(SRC, 'activity-builder/js/builder-app.js')],
    bundle: true,
    outfile: resolve(BUILDER_DIST, 'js/builder.bundle.js'),
    format: 'iife',
    globalName: 'ActivityBuilder',
    sourcemap: true,
    target: ['es2020'],
  });

  const previewCtx = await esbuild.context({
    entryPoints: [resolve(SRC, 'scorm-template/js/app.js')],
    bundle: true,
    outfile: resolve(BUILDER_DIST, 'preview/app.bundle.js'),
    format: 'iife',
    globalName: 'PythonScorm',
    sourcemap: true,
    target: ['es2020'],
    plugins: [
      {
        name: 'refresh-runtime-assets',
        setup(build) {
          build.onEnd(() => {
            copyPreviewStyle();
            writeBuilderRuntimeAssets();
          });
        },
      },
    ],
  });

  await Promise.all([builderCtx.watch(), previewCtx.watch()]);
  await bundleScormApp(resolve(BUILDER_DIST, 'preview/app.bundle.js'));
  copyPreviewStyle();
  copyPythonRuntime(BUILDER_DIST);
  copyIfExists(resolve(SRC, 'shared/python-worker.js'), resolve(BUILDER_DIST, 'preview/python-worker.js'));
  copyIfExists(resolve(SRC, 'shared/gunzip.js'), resolve(BUILDER_DIST, 'preview/gunzip.js'));
  writeBuilderRuntimeAssets();

  const { host, port } = await builderCtx.serve({
    servedir: BUILDER_DIST,
    port: 3000,
  });

  console.log(`🚀 Dev server running at http://${host}:${port}`);
  console.log('   Watching builder and SCORM runtime changes...');
}

dev().catch((err) => {
  console.error('Dev server failed:', err);
  process.exit(1);
});

/**
 * Zip dist/scorm-template/ into a Moodle-uploadable SCORM package.
 *
 * When the activity config sets `python_setup.pyodide_base_url`, the bundled
 * runtime is dropped from the zip (the LMS package stays ~1 MB and the runtime
 * is loaded from that URL instead); otherwise the runtime ships inside the zip
 * so offline LMS deployments work with zero configuration.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST_SCORM = resolve(ROOT, 'dist/scorm-template');
const OUTPUT = resolve(ROOT, 'dist');

async function exportScorm() {
  if (!existsSync(DIST_SCORM)) {
    console.error('❌ dist/scorm-template/ not found. Run `npm run build` first.');
    process.exit(1);
  }

  let config = null;
  const configPath = resolve(DIST_SCORM, 'config/activity_config.json');
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      // Fall back to defaults below.
    }
  }

  const baseUrl = String(config?.python_setup?.pyodide_base_url ?? '').trim();
  const externalPyodide = baseUrl !== '';
  let filename = 'python-scorm-activity.zip';
  if (config?.metadata?.activity_id) {
    filename = `${config.metadata.activity_id}.zip`;
  }

  const zip = new JSZip();
  addDirectoryToZip(zip, DIST_SCORM, '', externalPyodide);

  const outputPath = resolve(OUTPUT, filename);
  const content = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });

  writeFileSync(outputPath, content);

  const sizeMb = (content.length / (1024 * 1024)).toFixed(2);
  const mode = externalPyodide
    ? `external Pyodide URL (${baseUrl}) — bundled pyodide/ omitted`
    : 'bundled Pyodide runtime included';
  console.log(`✅ SCORM package exported → dist/${filename}`);
  console.log(`   Mode: ${mode}`);
  console.log(`   Size: ${sizeMb} MB`);
}

function addDirectoryToZip(zip, dirPath, zipPath, skipPyodide) {
  const entries = readdirSync(dirPath);
  for (const entry of entries) {
    const fullPath = resolve(dirPath, entry);
    const entryZipPath = zipPath ? `${zipPath}/${entry}` : entry;
    if (skipPyodide && (entryZipPath === 'pyodide' || entryZipPath.startsWith('pyodide/'))) {
      continue;
    }
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      addDirectoryToZip(zip, fullPath, entryZipPath, skipPyodide);
    } else {
      zip.file(entryZipPath, readFileSync(fullPath));
    }
  }
}

exportScorm();

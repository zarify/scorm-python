import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CURRICULUM_DIR = path.join(REPO_ROOT, 'curriculum');

async function readRequired(filePath) {
  const relativePath = path.relative(REPO_ROOT, filePath);
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read ${relativePath}: ${error.message}`, { cause: error });
  }
}

async function readJsonRequired(filePath) {
  const text = await readRequired(filePath);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Unable to parse ${path.relative(REPO_ROOT, filePath)}: ${error.message}`, { cause: error });
  }
}

export async function loadManifest() {
  return readJsonRequired(path.join(CURRICULUM_DIR, 'manifest.json'));
}

export async function loadCorpus() {
  const manifest = await loadManifest();
  if (!Array.isArray(manifest.activities)) {
    throw new Error('curriculum/manifest.json: activities must be an array');
  }

  const corpus = [];
  for (const manifestEntry of manifest.activities) {
    const activityDir = path.join(CURRICULUM_DIR, 'activities', manifestEntry.slug);
    const configPath = path.join(activityDir, 'activity.json');
    const referencePath = path.join(activityDir, manifestEntry.reference);
    const config = await readJsonRequired(configPath);
    const reference = await readRequired(referencePath);
    const misconceptions = [];

    for (const entry of manifestEntry.misconceptions || []) {
      const source = await readRequired(path.join(activityDir, entry.file));
      misconceptions.push({
        id: path.basename(entry.file, path.extname(entry.file)),
        source,
        fails: entry.fails,
        hints: entry.hints,
      });
    }

    corpus.push({ slug: manifestEntry.slug, manifestEntry, config, reference, misconceptions });
  }
  return corpus;
}

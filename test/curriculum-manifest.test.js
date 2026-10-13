import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadCorpus, loadManifest } from './curriculum/corpus.js';

const curriculumDir = fileURLToPath(new URL('../curriculum/', import.meta.url));
const activitiesDir = path.join(curriculumDir, 'activities');

test('curriculum manifest matches every activity directory and config', async () => {
  const manifest = await loadManifest();
  assert.equal(manifest.activities.length, 36, 'curriculum must contain exactly 36 activities');
  const corpus = await loadCorpus();
  const directories = (await readdir(activitiesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const slugs = manifest.activities.map((activity) => activity.slug);

  assert.equal(new Set(slugs).size, slugs.length, 'manifest activity slugs must be unique');
  assert.deepEqual([...slugs].sort(), directories, 'manifest and activity directories must match exactly');
  assert.equal(corpus.length, directories.length);
  const families = Object.entries(manifest.families);
  assert.deepEqual(families.map(([family]) => family), ['A', 'B', 'C', 'D', 'E', 'F']);
  for (const [family, entry] of families) {
    assert.ok(typeof entry.label === 'string' && entry.label.length > 0, `${family}: family label is required`);
  }
  const familySlugs = families.flatMap(([, entry]) => entry.activities);
  assert.equal(new Set(familySlugs).size, familySlugs.length, 'each activity must belong to one family');
  assert.deepEqual([...familySlugs].sort(), [...slugs].sort(), 'families must cover every activity');

  const conceptIds = new Set(Object.keys(manifest.concepts));
  const caveatIds = new Set(Object.keys(manifest.caveats));
  const usedConcepts = new Set();
  const audienceIds = new Set(Object.keys(manifest.audiences));
  for (const [conceptId, concept] of Object.entries(manifest.concepts)) {
    assert.ok(typeof concept.label === 'string' && concept.label.length > 0, `${conceptId}: concept label is required`);
    assert.ok(Array.isArray(concept.audiences) && concept.audiences.length > 0, `${conceptId}: concept audiences are required`);
    for (const audience of concept.audiences) {
      assert.ok(audienceIds.has(audience), `${conceptId}: undeclared audience ${audience}`);
    }
  }

  for (const activity of manifest.activities) {
    for (const concept of activity.concepts) {
      assert.ok(conceptIds.has(concept), `${activity.slug}: undeclared concept ${concept}`);
      usedConcepts.add(concept);
    }
    for (const caveat of activity.caveats || []) {
      assert.ok(caveatIds.has(caveat), `${activity.slug}: undeclared caveat ${caveat}`);
    }
    for (const audience of activity.audiences) {
      assert.ok(audienceIds.has(audience), `${activity.slug}: undeclared audience ${audience}`);
    }
  }

  assert.deepEqual([...usedConcepts].sort(), [...conceptIds].sort(), 'every declared concept must be used');
  assert.ok(Array.isArray(manifest.gaps) && manifest.gaps.length > 0, 'gap analysis must be non-empty');

  for (const { slug, config } of corpus) {
    const points = config.evaluation.test_cases.reduce((sum, testCase) => sum + testCase.points, 0);
    assert.equal(points, 100, `${slug}: test points must sum to 100`);
  }
});

test('curriculum exercises every supported hint event in multiple activities', async () => {
  const manifest = await loadManifest();
  const counts = new Map([['code_change', 0], ['test_fail', 0], ['manual', 0]]);
  for (const { config } of await loadCorpus()) {
    const events = new Set((config.hints || []).map((hint) => hint.trigger.event));
    for (const event of counts.keys()) {
      if (events.has(event)) counts.set(event, counts.get(event) + 1);
    }
  }
  for (const [event, count] of counts) {
    assert.ok(count >= 3, `${event} hints must appear in at least three activities (found ${count})`);
  }
  assert.ok(manifest.activities.length > 0, 'manifest must contain activities');
});

test('curriculum README renders manifest coverage, caveats, and gaps', async () => {
  const manifest = await loadManifest();
  const readme = await readFile(path.join(curriculumDir, 'README.md'), 'utf8');

  for (const value of [manifest.purpose, manifest.usage, manifest.curriculum_mapping_note]) {
    assert.ok(readme.includes(value), `README is missing manifest text: ${value}`);
  }
  for (const [familyId, family] of Object.entries(manifest.families)) {
    assert.ok(readme.includes(`### Family ${familyId}: ${family.label}`));
  }
  for (const activity of manifest.activities) {
    assert.ok(readme.includes(`\`${activity.slug}\``), `${activity.slug}: missing from README`);
    for (const conceptId of activity.concepts) {
      assert.ok(readme.includes(`\`${conceptId}\``), `${conceptId}: missing from README`);
    }
    for (const feature of activity.authoring_features) {
      assert.ok(readme.includes(feature), `${activity.slug}: missing feature ${feature}`);
    }
  }
  for (const [id, text] of Object.entries(manifest.caveats)) {
    assert.ok(readme.includes(`**\`${id}\`** — ${text}`), `${id}: caveat is not rendered verbatim`);
  }
  for (const { concept, reason, author_alternative: alternative } of manifest.gaps) {
    assert.ok(readme.includes(`| ${concept} | ${reason} | ${alternative} |`), `${concept}: gap is not rendered`);
  }
});

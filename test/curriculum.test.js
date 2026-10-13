import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { validateConfig } from '../src/shared/config-validator.js';
import { createHintState, evaluateHints } from '../src/shared/hint-evaluator.js';
import { runTests } from '../src/scorm-template/js/test-runner.js';
import { createHarnessEngine } from './curriculum/harness-bridge.js';
import { loadCorpus } from './curriculum/corpus.js';

const corpus = await loadCorpus();
const engine = createHarnessEngine();
after(() => engine.close());

function collectPatternSources(condition, output = []) {
  if (!condition || typeof condition !== 'object') return output;
  if (condition.type === 'ast_pattern') output.push(condition.pattern);
  if (Array.isArray(condition.conditions)) {
    for (const child of condition.conditions) collectPatternSources(child, output);
  }
  return output;
}

function patternsFor(config) {
  const patterns = [];
  for (const hint of config.hints || []) {
    collectPatternSources(hint.trigger?.conditions, patterns);
  }
  for (const testCase of config.evaluation.test_cases || []) {
    collectPatternSources(testCase.conditions, patterns);
  }
  return patterns;
}

async function visibleCodeChangeHintIds(config, source) {
  const conditionKeys = new Map();
  const entries = [];
  for (const hint of config.hints || []) {
    const condition = hint.trigger?.conditions;
    if (hint.trigger?.event !== 'code_change' || !condition) continue;
    if (!conditionKeys.has(condition)) {
      const key = `hint-condition-${entries.length}`;
      conditionKeys.set(condition, key);
      entries.push({ key, condition });
    }
  }

  const analysis = entries.length
    ? await engine.analyze({ source, conditions: entries })
    : { results: {} };
  const outcomes = new Map(entries.map(({ key, condition }) => [condition, analysis.results[key]]));
  const { visibleHints } = await evaluateHints(
    config.hints || [],
    createHintState(),
    { type: 'code_change', code: source },
    async (condition) => outcomes.get(condition) || { passed: false, detail: 'Condition was not analyzed.' },
  );
  return visibleHints.map((hint) => hint.id).sort();
}

async function grade(config, source, requirePreviousTestPass) {
  return runTests({
    testCases: config.evaluation.test_cases,
    source,
    activityFiles: config.python_setup?.files || [],
    engine,
    requirePreviousTestPass,
  });
}

for (const activity of corpus) {
  test(`curriculum activity ${activity.slug}`, async () => {
    const { config, reference, misconceptions } = activity;
    const validation = validateConfig(config);
    assert.deepEqual(validation.errors, [], `${activity.slug}: config validation`);

    for (const pattern of patternsFor(config)) {
      const validationResult = await engine.validatePatterns([pattern]);
      assert.equal(
        validationResult.errors[pattern],
        '',
        `${activity.slug}: invalid AST pattern ${JSON.stringify(pattern)}`,
      );
    }

    assert.ok(misconceptions.length > 0, `${activity.slug}: needs a misconception program`);
    assert.ok(config.hints.length > 0, `${activity.slug}: needs at least one hint`);
    assert.ok(
      config.hints.some((hint) => hint.display_mode === 'checklist'),
      `${activity.slug}: needs a checklist hint`,
    );
    assert.ok(
      config.hints.some((hint) => hint.display_mode === 'triggered'),
      `${activity.slug}: needs a triggered hint`,
    );

    const referenceResult = await grade(config, reference, false);
    assert.ok(
      referenceResult.results.every((result) => result.passed),
      `${activity.slug}: reference failures ${JSON.stringify(referenceResult.results.filter((result) => !result.passed))}`,
    );
    assert.equal(referenceResult.lmsScore, 100, `${activity.slug}: reference score`);
    const referenceHints = await visibleCodeChangeHintIds(config, reference);

    for (const misconception of misconceptions) {
      const result = await grade(config, misconception.source, false);
      const failingIds = result.results.filter((entry) => !entry.passed).map((entry) => entry.id).sort();
      assert.deepEqual(
        failingIds,
        [...misconception.fails].sort(),
        `${activity.slug}/${misconception.id}: unexpected failing test set`,
      );

      const gated = await grade(config, misconception.source, config.evaluation.require_previous_test_pass);
      assert.equal(
        gated.allPassed,
        false,
        `${activity.slug}/${misconception.id}: previous-test gate should fail`,
      );

      const visibleHints = await visibleCodeChangeHintIds(config, misconception.source);
      assert.deepEqual(
        visibleHints,
        [...misconception.hints].sort(),
        `${activity.slug}/${misconception.id}: visible hint set`,
      );
      assert.equal(
        misconception.hints.some((id) => referenceHints.includes(id)),
        false,
        `${activity.slug}/${misconception.id}: misconception hint also appears for reference`,
      );
    }

  });
}

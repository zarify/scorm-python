/**
 * Hint Engine — monitors the editor and renders hint state.
 *
 * Conditions are Python-side: every debounced evaluation batches the
 * conditions of all candidate hints (event match, running delay, active hints
 * that can invalidate, and every manual hint that gates the button) into ONE
 * engine.analyze call, then resolves the batch in a single evaluateHints pass.
 * A syntax error mid-typing fails the batch gracefully: AST-dependent hints
 * don't fire while the source doesn't parse, while text-only conditions
 * (source_regex / source_empty) still evaluate against the raw source.
 */

import {
  evaluateHints,
  createHintState,
  getManualHintRequestState,
} from '../../shared/hint-evaluator.js';
import { renderInlineMarkdown } from '../../shared/inline-markdown.js';

let hintState = null;
let hintConfigs = [];
let hintPanel = null;
let engine = null;
let ui = {
  enabled: true,
  getSource: () => '',
  onRequestAvailabilityChange: null,
};
let debounceTimer = null;
let pendingEvaluationTimer = null;
let evaluateQueue = Promise.resolve();
const DEFAULT_DEBOUNCE_MS = 500;
let debounceMs = DEFAULT_DEBOUNCE_MS;

/**
 * Initialize the hint engine. Call once the Python engine is ready (the first
 * code_change batch runs immediately).
 * @param {{ hints: Array, engine: object,
 *           ui: { panel?: HTMLElement, enabled?: boolean, debounceMs?: number,
 *                 getSource?: () => string,
 *                 onRequestAvailabilityChange?: Function } }} options
 */
export function initHintEngine({ hints, engine: pythonEngine, ui: uiOptions = {} }) {
  hintConfigs = Array.isArray(hints) ? hints : [];
  engine = pythonEngine;
  hintPanel = uiOptions.panel || document.getElementById('hint-panel');
  ui = {
    enabled: uiOptions.enabled !== false,
    getSource: typeof uiOptions.getSource === 'function' ? uiOptions.getSource : () => '',
    onRequestAvailabilityChange: typeof uiOptions.onRequestAvailabilityChange === 'function'
      ? uiOptions.onRequestAvailabilityChange
      : null,
  };
  debounceMs = typeof uiOptions.debounceMs === 'number' ? uiOptions.debounceMs : DEFAULT_DEBOUNCE_MS;
  hintState = createHintState();
  clearTimeout(debounceTimer);
  clearScheduledEvaluation();
  evaluateQueue = Promise.resolve();

  if (!ui.enabled || hintConfigs.length === 0 || !engine) {
    if (hintPanel) {
      hintPanel.style.display = 'none';
      hintPanel.innerHTML = '';
    }
    notifyHintRequestAvailability();
    return;
  }

  enqueueEvaluate('code_change');
}

/** Called (debounced by the app's editor listener) on every code change. */
export function notifyCodeChange() {
  if (!hintState) return;
  clearTimeout(debounceTimer);
  clearScheduledEvaluation();
  debounceTimer = setTimeout(() => enqueueEvaluate('code_change'), debounceMs);
}

/** Notify the hint engine of a test failure. */
export function onTestFail(attemptNumber) {
  if (!hintState) return;
  hintState.attemptCount = attemptNumber;
  enqueueEvaluate('test_fail');
}

/** Manually request hints (student clicks "Get Hint"). */
export function requestManualHint() {
  if (!hintState) return;
  clearTimeout(debounceTimer);
  clearScheduledEvaluation();
  enqueueEvaluate('manual');
}

function enqueueEvaluate(eventType) {
  evaluateQueue = evaluateQueue
    .then(() => evaluate(eventType))
    .catch((err) => {
      console.warn('[HintEngine] Evaluation failed:', err?.message || err);
    });
}

function clearScheduledEvaluation() {
  if (pendingEvaluationTimer) {
    clearTimeout(pendingEvaluationTimer);
    pendingEvaluationTimer = null;
  }
}

async function evaluate(eventType) {
  if (!engine || !hintState) return;

  clearScheduledEvaluation();
  const source = ui.getSource();
  const conditionResults = await batchEvaluateConditions(eventType, source);
  lastConditionOutcomes.clear();
  for (const [condition, outcome] of conditionResults) {
    lastConditionOutcomes.set(condition, outcome);
  }
  const resolveCondition = async (condition) => conditionResults.get(condition)
    || { passed: false, detail: 'Condition was not evaluated.' };

  const { visibleHints, nextEvaluationDelayMs } = await evaluateHints(
    hintConfigs,
    hintState,
    { type: eventType, code: source },
    resolveCondition,
  );
  syncActiveHints(visibleHints, eventType);
  renderHints();
  await notifyHintRequestAvailability(resolveCondition);

  if (nextEvaluationDelayMs !== null) {
    pendingEvaluationTimer = setTimeout(
      () => enqueueEvaluate(eventType),
      nextEvaluationDelayMs,
    );
  }
}

async function batchEvaluateConditions(eventType, source) {
  const results = new Map();
  const entries = [];

  for (const hint of hintConfigs) {
    const trigger = hint.trigger;
    if (!trigger?.conditions) continue;
    if (hintState.consumed.has(hint.id)) continue;
    if (trigger.after_attempts && hintState.attemptCount < trigger.after_attempts) continue;

    const delay = hint.delay_seconds || 0;
    const eventMatches = trigger.event === eventType;
    const delaying = delay > 0 && hintState.firstTriggered.has(hint.id);
    const activeInvalidatable = hintState.active.has(hint.id)
      && trigger.invalidate_on_condition_false;
    const manualGate = trigger.event === 'manual';
    if (!eventMatches && !delaying && !activeInvalidatable && !manualGate) continue;

    entries.push({ key: `hint:${entries.length}`, condition: trigger.conditions });
  }

  if (entries.length === 0) return results;

  try {
    const analysis = await engine.analyze({
      source,
      conditions: entries.map(({ key, condition }) => ({ key, condition })),
    });
    for (const { key, condition } of entries) {
      // The analyzer already fills every key — including text-only conditions
      // it evaluated despite a syntax error. Fall back to a syntax-error
      // failure only for keys it could not report at all.
      const outcome = analysis.results[key];
      if (outcome) {
        results.set(condition, outcome);
      } else if (analysis.syntaxError) {
        results.set(condition, {
          passed: false,
          detail: `SyntaxError: ${analysis.syntaxError.message} (line ${analysis.syntaxError.line})`,
        });
      } else {
        results.set(condition, { passed: false, detail: 'Condition was not evaluated.' });
      }
    }
  } catch (err) {
    // Engine unavailable (load failure/cancel) — don't fire hints, don't crash.
    for (const { condition } of entries) {
      results.set(condition, { passed: false, detail: 'Condition analysis unavailable.' });
    }
  }
  return results;
}

function syncActiveHints(visibleHints, eventType) {
  const firedHintIds = new Set(visibleHints.map((hint) => hint.id));

  hintConfigs.forEach((hint) => {
    if (getHintDisplayMode(hint) === 'checklist') {
      return;
    }

    if (firedHintIds.has(hint.id)) {
      hintState.active.add(hint.id);
      if (hint.show_once && eventType === 'manual' && hint.trigger?.event === 'manual') {
        hintState.consumed.add(hint.id);
      }
      return;
    }

    const invalidated = shouldAutoInvalidateHint(hint);
    if (invalidated === null) {
      return; // not eligible for auto-invalidation
    }

    // The condition outcome for active invalidatable hints was batched in this
    // pass; a failing resolve means the condition is false now.
    if (!invalidated) {
      hintState.active.delete(hint.id);
      hintState.firstTriggered.delete(hint.id);
      if (hint.show_once) {
        hintState.consumed.add(hint.id);
      }
    }
  });
}

/**
 * @returns {boolean|null} null when the hint is not auto-invalidatable;
 *  otherwise whether its condition still passes.
 */
function shouldAutoInvalidateHint(hint) {
  if (!hintState?.active.has(hint.id)) {
    return null;
  }
  if (!hint.trigger?.invalidate_on_condition_false || !hint.trigger.conditions) {
    return null;
  }
  const outcome = lastConditionOutcomes.get(hint.trigger.conditions);
  if (!outcome) {
    return null; // condition was not part of this batch
  }
  return outcome.passed === true;
}

/** Filled by evaluate() before syncActiveHints runs (same synchronous pass). */
const lastConditionOutcomes = new Map();

function renderHints() {
  if (!hintPanel) return;

  const checklistHints = hintConfigs.filter((hint) => getHintDisplayMode(hint) === 'checklist');
  const activeHints = hintConfigs.filter(
    (hint) => getHintDisplayMode(hint) !== 'checklist' && hintState?.active.has(hint.id),
  );
  if (checklistHints.length === 0 && activeHints.length === 0) {
    hintPanel.style.display = 'none';
    hintPanel.innerHTML = '';
    return;
  }

  hintPanel.style.display = '';
  const sections = ['<section class="hint-section"><h3>💡 Hints</h3>'];
  if (activeHints.length > 0) {
    sections.push(
      activeHints
        .map((hint) => {
          const styleClass = hint.style ? ` hint-${hint.style}` : '';
          return `
            <div class="hint-card${styleClass}" data-hint-id="${hint.id}">
              <div class="hint-message formatted-text">${renderInlineMarkdown(hint.message)}</div>
            </div>
          `;
        })
        .join(''),
    );
  }
  if (checklistHints.length > 0) {
    sections.push(renderChecklistHints(checklistHints));
  }
  sections.push('</section>');
  hintPanel.innerHTML = sections.join('');
}

function renderChecklistHints(checklistHints) {
  return `
    <ul class="hint-checklist">
      ${checklistHints
      .map((hint) => {
        const completed = hintState?.triggered.has(hint.id);
        return `
          <li class="hint-checklist-item ${completed ? 'is-complete' : ''}">
            <span class="hint-checklist-icon" aria-hidden="true">${completed ? '☑' : '☐'}</span>
            <span class="hint-checklist-message formatted-text">${renderInlineMarkdown(hint.message)}</span>
          </li>
        `;
      })
      .join('')}
    </ul>
  `;
}

function getHintDisplayMode(hint) {
  if (hint?.display_mode === 'triggered') {
    return 'triggered';
  }
  return 'checklist';
}

async function notifyHintRequestAvailability(resolveCondition) {
  if (typeof ui.onRequestAvailabilityChange !== 'function') {
    return;
  }
  const resolver = resolveCondition
    || (async (condition) => {
      const results = await batchEvaluateConditions('manual', ui.getSource());
      return results.get(condition) || { passed: false };
    });
  ui.onRequestAvailabilityChange(
    await getManualHintRequestState(hintConfigs, hintState, resolver),
  );
}

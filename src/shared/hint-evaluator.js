/**
 * Hint Evaluator — determines which hints should be visible given the current
 * event and hint state.
 *
 * Pure logic module: no UI, no side effects beyond the caller-owned state.
 * Conditions are evaluated through an INJECTED async evaluator
 * (`evaluateCondition(condition) -> Promise<{passed, detail}>`) so the caller
 * can batch every triggered hint's conditions into a single engine.analyze
 * call and resolve the batch in one evaluateHints pass.
 */

/**
 * @typedef {Object} HintState
 * @property {Set<string>} active - Non-checklist hints currently visible
 * @property {Set<string>} consumed - show_once hints already used up
 * @property {Map<string, number>} firstTriggered - Hint ID → timestamp when condition first became true
 * @property {Set<string>} triggered - Hint IDs that have been triggered at least once
 * @property {number} attemptCount - Number of failed test runs so far
 */

/**
 * Create a fresh HintState.
 * @returns {HintState}
 */
export function createHintState() {
  return {
    active: new Set(),
    consumed: new Set(),
    firstTriggered: new Map(),
    triggered: new Set(),
    attemptCount: 0,
  };
}

/**
 * Evaluate all hints and return those that should be visible.
 * @param {Array} hints - Hint config objects from activity_config.json
 * @param {HintState} state - Current hint state (mutated: delay bookkeeping)
 * @param {{ type: 'code_change'|'test_fail'|'manual', code?: string,
 *           failedCheckCount?: number, attemptCount?: number }} event
 * @param {(condition: object) => Promise<{passed: boolean, detail?: string}>} evaluateCondition
 * @returns {Promise<{ visibleHints: Array<{ id: string, message: string,
 *   priority: number, display_mode: string, style: string|null }>,
 *   nextEvaluationDelayMs: number|null }>}
 */
export async function evaluateHints(hints, state, event, evaluateCondition) {
  const visibleHints = [];
  let nextEvaluationDelayMs = null;

  for (const hint of hints) {
    const evaluation = await evaluateHint(hint, state, event, evaluateCondition);
    if (evaluation.visible) {
      visibleHints.push({
        id: hint.id,
        message: hint.message,
        priority: hint.priority || 1,
        display_mode: hint.display_mode || 'triggered',
        style: hint.style || null,
      });
    }

    if (evaluation.pendingDelayMs !== null) {
      nextEvaluationDelayMs = nextEvaluationDelayMs === null
        ? evaluation.pendingDelayMs
        : Math.min(nextEvaluationDelayMs, evaluation.pendingDelayMs);
    }
  }

  visibleHints.sort((a, b) => b.priority - a.priority);
  return { visibleHints, nextEvaluationDelayMs };
}

async function evaluateHint(hint, state, event, evaluateCondition) {
  const trigger = hint.trigger;
  const eventType = event?.type;
  const delay = hint.delay_seconds || 0;
  const delayAlreadyStarted = state.firstTriggered.has(hint.id);

  if (state.consumed.has(hint.id)) {
    return { visible: false, pendingDelayMs: null };
  }

  // Event must match unless the hint is already waiting for its delay timer
  // to finish from a prior matching event.
  if (trigger.event !== eventType && !(delay > 0 && delayAlreadyStarted)) {
    return { visible: false, pendingDelayMs: null };
  }

  if (trigger.after_attempts && state.attemptCount < trigger.after_attempts) {
    return { visible: false, pendingDelayMs: null };
  }

  if (trigger.conditions) {
    const result = await evaluateCondition(trigger.conditions);
    if (!result.passed) {
      // Condition not met — clear the firstTriggered timestamp.
      state.firstTriggered.delete(hint.id);

      if (trigger.invalidate_on_condition_false) {
        // Also clear any triggered/completed mark so checklist items un-check.
        state.triggered.delete(hint.id);
      }

      return { visible: false, pendingDelayMs: null };
    }
  }

  // Condition must have been true for delay_seconds before showing.
  if (delay > 0) {
    const now = Date.now();
    if (!state.firstTriggered.has(hint.id)) {
      state.firstTriggered.set(hint.id, now);
      return { visible: false, pendingDelayMs: delay * 1000 };
    }
    const elapsedMs = now - state.firstTriggered.get(hint.id);
    const requiredDelayMs = delay * 1000;
    if (elapsedMs < requiredDelayMs) {
      return { visible: false, pendingDelayMs: requiredDelayMs - elapsedMs };
    }
  }

  state.triggered.add(hint.id);
  return { visible: true, pendingDelayMs: null };
}

/**
 * Manual-hint button state. Asynchronous because eligibility depends on the
 * hint's conditions.
 * @param {Array} hints
 * @param {HintState} state
 * @param {(condition: object) => Promise<{passed: boolean}>} evaluateCondition
 * @returns {Promise<{ hasManualHints: boolean, canRequest: boolean }>}
 */
export async function getManualHintRequestState(hints, state, evaluateCondition) {
  const manualHints = Array.isArray(hints)
    ? hints.filter((hint) => hint?.trigger?.event === 'manual')
    : [];

  if (manualHints.length === 0) {
    return { hasManualHints: false, canRequest: false };
  }

  for (const hint of manualHints) {
    if (await isManualHintEligible(hint, state, evaluateCondition)) {
      return { hasManualHints: true, canRequest: true };
    }
  }
  return { hasManualHints: true, canRequest: false };
}

async function isManualHintEligible(hint, state, evaluateCondition) {
  if (!hint?.trigger || !state) {
    return false;
  }

  if (state.consumed.has(hint.id)) {
    return false;
  }

  if (hint.trigger.after_attempts && state.attemptCount < hint.trigger.after_attempts) {
    return false;
  }

  if (!hint.trigger.conditions) {
    return true;
  }

  const result = await evaluateCondition(hint.trigger.conditions);
  return result.passed;
}

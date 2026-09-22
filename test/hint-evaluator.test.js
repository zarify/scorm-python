/**
 * Hint evaluator — decides which hints a student should see for one trigger
 * event, and when the caller should evaluate again.
 *
 * The Python port differs from the Blockly original in two ways this suite
 * pins down: conditions travel through an INJECTED async evaluator
 * (`evaluateCondition(condition) -> Promise<{passed, detail}>`) instead of a
 * synchronous workspace inspector imported by the module, and the event is an
 * object (`{type, code, failedCheckCount, attemptCount}`) instead of a bare
 * string. Everything else — event lanes, delay bookkeeping, attempt
 * thresholds, show_once consumption, checklist invalidation — is unchanged.
 *
 * No timers run for real: delay bookkeeping is driven by seeding
 * `state.firstTriggered` with `Date.now()` offsets, so the suite never sleeps.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createHintState,
  evaluateHints,
  getManualHintRequestState,
} from '../src/shared/hint-evaluator.js';
import { hint } from './helpers/config.js';

// --- fixtures -------------------------------------------------------------

/**
 * Async stand-in for the engine's `evaluateCondition`. It records every call
 * so tests can prove which hints reached evaluation, in what order, and that
 * the module awaited each one before starting the next (`maxInFlight`).
 *
 * @param {{ byType?: object, fallback?: object | ((condition: object) => object) }} [options]
 */
function fakeEvaluator({ byType = {}, fallback = { passed: true } } = {}) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;

  async function evaluateCondition(condition) {
    calls.push(condition);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve(); // yield: a Promise.all fan-out would overlap here
    inFlight -= 1;
    if (typeof fallback === 'function') {
      return fallback(condition);
    }
    return Object.prototype.hasOwnProperty.call(byType, condition?.type)
      ? byType[condition.type]
      : fallback;
  }

  return { evaluateCondition, calls, maxInFlight: () => maxInFlight };
}

/** An evaluator that must never be reached. */
function neverEvaluated() {
  return () => {
    throw new Error('evaluateCondition must not be called');
  };
}

const CODE_CHANGE = { type: 'code_change' };
const TEST_FAIL = { type: 'test_fail' };

function visibleIds(result) {
  return result.visibleHints.map((visible) => visible.id);
}

/** Pretend the hint's condition first held `ms` milliseconds ago. */
function startedAgoMs(state, id, ms) {
  state.firstTriggered.set(id, Date.now() - ms);
}

/**
 * Pending waits are recomputed from a live `Date.now()`, so the value floats a
 * little below the seeded expectation. Bound it instead of pinning it.
 */
function assertPendingNear(actual, expected, toleranceMs = 100) {
  assert.ok(
    actual !== null && actual > expected - toleranceMs && actual <= expected,
    `expected ~${expected}ms of pending delay, got ${actual}`,
  );
}

// --- state and pipeline ---------------------------------------------------

test('a fresh hint state is empty and shares nothing with the next one', () => {
  const state = createHintState();
  assert.deepEqual([...state.active], []);
  assert.deepEqual([...state.consumed], []);
  assert.deepEqual([...state.firstTriggered.keys()], []);
  assert.deepEqual([...state.triggered], []);
  assert.equal(state.attemptCount, 0);

  state.active.add('a');
  state.consumed.add('b');
  state.firstTriggered.set('c', 1);
  state.triggered.add('d');
  state.attemptCount = 3;

  const fresh = createHintState();
  assert.deepEqual([...fresh.active], []);
  assert.deepEqual([...fresh.consumed], []);
  assert.deepEqual([...fresh.firstTriggered.keys()], []);
  assert.deepEqual([...fresh.triggered], []);
  assert.equal(fresh.attemptCount, 0);
});

test('no hints means nothing to show, nothing to schedule, nothing to evaluate', async () => {
  const evaluator = fakeEvaluator();
  assert.deepEqual(
    await evaluateHints([], createHintState(), CODE_CHANGE, evaluator.evaluateCondition),
    { visibleHints: [], nextEvaluationDelayMs: null },
  );
  assert.equal(evaluator.calls.length, 0);
});

test('a visible hint carries the fields the panel renders', async () => {
  const hints = [
    hint({
      id: 'hint_1',
      message: 'Look at the input function.',
      priority: 7,
      display_mode: 'checklist',
      style: 'warning',
      trigger: { conditions: null },
    }),
  ];

  const { visibleHints } = await evaluateHints(
    hints,
    createHintState(),
    CODE_CHANGE,
    fakeEvaluator().evaluateCondition,
  );
  assert.deepEqual(visibleHints, [
    {
      id: 'hint_1',
      message: 'Look at the input function.',
      priority: 7,
      display_mode: 'checklist',
      style: 'warning',
    },
  ]);
});

test('a hint without priority, display mode or style falls back to 1/triggered/null', async () => {
  const bare = hint({ id: 'hint_1', trigger: { conditions: null } });
  delete bare.priority;

  const { visibleHints } = await evaluateHints(
    [bare],
    createHintState(),
    CODE_CHANGE,
    fakeEvaluator().evaluateCondition,
  );
  assert.deepEqual(visibleHints, [
    { id: 'hint_1', message: 'Try something.', priority: 1, display_mode: 'triggered', style: null },
  ]);
});

test('visible hints come back highest priority first', async () => {
  const hints = [
    hint({ id: 'low', priority: 1, trigger: { conditions: null } }),
    hint({ id: 'high', priority: 5, trigger: { conditions: null } }),
    hint({ id: 'mid', priority: 3, trigger: { conditions: null } }),
  ];

  const { visibleHints } = await evaluateHints(
    hints,
    createHintState(),
    CODE_CHANGE,
    fakeEvaluator().evaluateCondition,
  );
  assert.deepEqual(visibleHints.map((visible) => visible.id), ['high', 'mid', 'low']);
  // Sorting is the evaluator's whole contribution: a lower priority hint is
  // still visible, it is the panel that decides what to hide behind it.
  assert.deepEqual(visibleHints.map((visible) => visible.priority), [5, 3, 1]);
});

test('a missing or zero priority counts as priority 1 and keeps config order', async () => {
  const noPriority = hint({ id: 'nop', trigger: { conditions: null } });
  delete noPriority.priority;
  const hints = [
    hint({ id: 'first', priority: 1, trigger: { conditions: null } }),
    noPriority,
    hint({ id: 'zero', priority: 0, trigger: { conditions: null } }),
  ];

  const { visibleHints } = await evaluateHints(
    hints,
    createHintState(),
    CODE_CHANGE,
    fakeEvaluator().evaluateCondition,
  );
  assert.deepEqual(visibleHints.map((visible) => visible.id), ['first', 'nop', 'zero']);
  assert.deepEqual(visibleHints.map((visible) => visible.priority), [1, 1, 1]);
});

// --- event gating ---------------------------------------------------------

test('a hint only fires for the event it was configured for', async () => {
  const hints = [hint({ id: 'hint_1', trigger: { event: 'test_fail', conditions: null } })];
  const state = createHintState();
  const evaluator = fakeEvaluator();

  assert.deepEqual(visibleIds(await evaluateHints(hints, state, CODE_CHANGE, evaluator.evaluateCondition)), []);
  assert.deepEqual(visibleIds(await evaluateHints(hints, state, { type: 'manual' }, evaluator.evaluateCondition)), []);
  assert.deepEqual(visibleIds(await evaluateHints(hints, state, TEST_FAIL, evaluator.evaluateCondition)), ['hint_1']);
});

test('code_change, test_fail and manual hints stay in their own lanes', async () => {
  const hints = [
    hint({ id: 'on_change', trigger: { event: 'code_change', conditions: null } }),
    hint({ id: 'on_fail', trigger: { event: 'test_fail', conditions: null } }),
    hint({ id: 'on_ask', trigger: { event: 'manual', conditions: null } }),
  ];
  const state = createHintState();
  const evaluator = fakeEvaluator();

  assert.deepEqual(visibleIds(await evaluateHints(hints, state, CODE_CHANGE, evaluator.evaluateCondition)), ['on_change']);
  assert.deepEqual(visibleIds(await evaluateHints(hints, state, TEST_FAIL, evaluator.evaluateCondition)), ['on_fail']);
  assert.deepEqual(visibleIds(await evaluateHints(hints, state, { type: 'manual' }, evaluator.evaluateCondition)), ['on_ask']);
  // An event the runtime never fires, or a missing type, shows nothing.
  assert.deepEqual(visibleIds(await evaluateHints(hints, state, { type: 'timed' }, evaluator.evaluateCondition)), []);
  assert.deepEqual(visibleIds(await evaluateHints(hints, state, {}, evaluator.evaluateCondition)), []);
});

test('a real event payload is read only for its type', async () => {
  const hints = [
    hint({ id: 'on_change', trigger: { event: 'code_change' } }),
    hint({ id: 'on_fail', trigger: { event: 'test_fail' } }),
  ];
  const state = createHintState();
  const evaluator = fakeEvaluator();

  const change = await evaluateHints(
    hints,
    state,
    { type: 'code_change', code: 'print(1)', failedCheckCount: 0, attemptCount: 0 },
    evaluator.evaluateCondition,
  );
  assert.deepEqual(visibleIds(change), ['on_change']);

  const failed = await evaluateHints(
    hints,
    state,
    { type: 'test_fail', code: 'print(1)', failedCheckCount: 2, attemptCount: 2 },
    evaluator.evaluateCondition,
  );
  assert.deepEqual(visibleIds(failed), ['on_fail']);
  // Only the two lane-matching hints were handed to the evaluator, with the
  // configured condition — the event's code/counters are never forwarded.
  assert.deepEqual(evaluator.calls.map((condition) => condition.type), ['source_empty', 'source_empty']);
});

// --- conditions -----------------------------------------------------------

test('the configured condition object reaches the evaluator verbatim', async () => {
  const evaluator = fakeEvaluator();
  const hints = [
    hint({
      id: 'hint_1',
      trigger: { conditions: { type: 'source_regex', pattern: 'print\\(', case_sensitive: true } },
    }),
  ];

  await evaluateHints(hints, createHintState(), CODE_CHANGE, evaluator.evaluateCondition);
  assert.equal(evaluator.calls.length, 1);
  // The hint's own condition object — not a copy, not a wrapper around it.
  assert.equal(evaluator.calls[0], hints[0].trigger.conditions);
  assert.deepEqual(evaluator.calls[0], { type: 'source_regex', pattern: 'print\\(', case_sensitive: true });
});

test('a failing condition clears the first-trigger timestamp and schedules nothing', async () => {
  const evaluator = fakeEvaluator({ byType: { source_empty: { passed: false, detail: 'source is not empty' } } });
  const state = createHintState();
  startedAgoMs(state, 'hint_1', 1000);

  const result = await evaluateHints(
    [hint({ id: 'hint_1', delay_seconds: 5 })],
    state,
    CODE_CHANGE,
    evaluator.evaluateCondition,
  );
  assert.deepEqual(result.visibleHints, []);
  assert.equal(result.nextEvaluationDelayMs, null);
  assert.equal(state.firstTriggered.has('hint_1'), false);
});

test('an unmatched event never starts a delayed hint counting', async () => {
  const evaluator = fakeEvaluator();
  const hints = [hint({ id: 'hint_1', delay_seconds: 5, trigger: { event: 'test_fail', conditions: null } })];
  const state = createHintState();

  const result = await evaluateHints(hints, state, CODE_CHANGE, evaluator.evaluateCondition);
  assert.deepEqual(result.visibleHints, []);
  assert.equal(result.nextEvaluationDelayMs, null);
  assert.equal(state.firstTriggered.has('hint_1'), false);
  assert.equal(evaluator.calls.length, 0);
});

test('a running delay keeps evaluating across a different trigger event', async () => {
  const evaluator = fakeEvaluator();
  const hints = [hint({ id: 'hint_1', delay_seconds: 3, trigger: { event: 'test_fail' } })];
  const state = createHintState();

  await evaluateHints(hints, state, TEST_FAIL, evaluator.evaluateCondition);
  assert.equal(state.firstTriggered.has('hint_1'), true);

  startedAgoMs(state, 'hint_1', 3000);
  assert.deepEqual(visibleIds(await evaluateHints(hints, state, CODE_CHANGE, evaluator.evaluateCondition)), ['hint_1']);
});

test('that delay escape closes once the condition stops holding', async () => {
  const verdict = { passed: true };
  const evaluator = fakeEvaluator({ fallback: () => verdict });
  const hints = [hint({ id: 'hint_1', delay_seconds: 3, trigger: { event: 'test_fail' } })];
  const state = createHintState();

  await evaluateHints(hints, state, TEST_FAIL, evaluator.evaluateCondition);
  assert.equal(state.firstTriggered.has('hint_1'), true);

  verdict.passed = false;
  await evaluateHints(hints, state, TEST_FAIL, evaluator.evaluateCondition);
  assert.equal(state.firstTriggered.has('hint_1'), false);

  startedAgoMs(state, 'hint_1', 3000);
  assert.deepEqual(visibleIds(await evaluateHints(hints, state, CODE_CHANGE, evaluator.evaluateCondition)), []);
});

// --- show_once / consumed -------------------------------------------------

test('a consumed hint is hidden even while its condition still holds', async () => {
  const evaluator = fakeEvaluator();
  const hints = [hint({ id: 'hint_1' })];
  const state = createHintState();

  assert.deepEqual(visibleIds(await evaluateHints(hints, state, CODE_CHANGE, evaluator.evaluateCondition)), ['hint_1']);
  assert.equal(evaluator.calls.length, 1);

  state.consumed.add('hint_1');
  const consumed = await evaluateHints(hints, state, CODE_CHANGE, evaluator.evaluateCondition);
  assert.deepEqual(consumed.visibleHints, []);
  assert.equal(consumed.nextEvaluationDelayMs, null);
  assert.equal(evaluator.calls.length, 1); // a consumed hint is never re-evaluated

  // A consumed hint's pending delay is dropped too: no timer gets rescheduled.
  const delayed = [hint({ id: 'slow', delay_seconds: 9, trigger: { conditions: null } })];
  const delayedState = createHintState();
  startedAgoMs(delayedState, 'slow', 1000);
  delayedState.consumed.add('slow');
  assert.equal(
    (await evaluateHints(delayed, delayedState, CODE_CHANGE, evaluator.evaluateCondition)).nextEvaluationDelayMs,
    null,
  );
});

test("consuming a hint is the caller's job: the evaluator never marks one used", async () => {
  const evaluator = fakeEvaluator();
  const state = createHintState();
  const hints = [hint({ id: 'hint_1', show_once: true })];

  await evaluateHints(hints, state, CODE_CHANGE, evaluator.evaluateCondition);
  await evaluateHints(hints, state, CODE_CHANGE, evaluator.evaluateCondition);
  assert.equal(state.consumed.size, 0);
  // The engine consumes a manual show_once hint when the student asks for it.
  assert.deepEqual(visibleIds(await evaluateHints(hints, state, CODE_CHANGE, evaluator.evaluateCondition)), ['hint_1']);
});

// --- after_attempts -------------------------------------------------------

test('after_attempts holds a hint back until the state count reaches it', async () => {
  const evaluator = fakeEvaluator();
  const hints = [hint({ id: 'hint_1', trigger: { conditions: null, after_attempts: 2 } })];
  const state = createHintState();

  assert.deepEqual(visibleIds(await evaluateHints(hints, state, CODE_CHANGE, evaluator.evaluateCondition)), []);
  state.attemptCount = 1;
  assert.deepEqual(visibleIds(await evaluateHints(hints, state, CODE_CHANGE, evaluator.evaluateCondition)), []);
  state.attemptCount = 2;
  assert.deepEqual(visibleIds(await evaluateHints(hints, state, CODE_CHANGE, evaluator.evaluateCondition)), ['hint_1']);
});

test('an attempt threshold of 0 means no threshold at all', async () => {
  const hints = [hint({ id: 'hint_1', trigger: { conditions: null, after_attempts: 0 } })];
  assert.deepEqual(
    visibleIds(await evaluateHints(hints, createHintState(), CODE_CHANGE, fakeEvaluator().evaluateCondition)),
    ['hint_1'],
  );
});

test('a hint gated by after_attempts is not evaluated and keeps its pending delay', async () => {
  const evaluator = fakeEvaluator();
  const hints = [hint({ id: 'hint_1', trigger: { after_attempts: 3 } })];
  const state = createHintState();
  startedAgoMs(state, 'hint_1', 1000);

  const result = await evaluateHints(hints, state, CODE_CHANGE, evaluator.evaluateCondition);
  assert.deepEqual(result.visibleHints, []);
  assert.equal(result.nextEvaluationDelayMs, null);
  assert.equal(evaluator.calls.length, 0);
  assert.equal(state.firstTriggered.has('hint_1'), true); // untouched by the gate
});

test('the attempt threshold reads state.attemptCount, not the event copy', async () => {
  const evaluator = fakeEvaluator();
  const hints = [hint({ id: 'hint_1', trigger: { conditions: null, after_attempts: 2 } })];
  const state = createHintState();

  const eventSaysDone = await evaluateHints(
    hints,
    state,
    { type: 'code_change', attemptCount: 5 },
    evaluator.evaluateCondition,
  );
  assert.deepEqual(eventSaysDone.visibleHints, []);

  state.attemptCount = 2;
  const stateSaysDone = await evaluateHints(
    hints,
    state,
    { type: 'code_change', attemptCount: 0 },
    evaluator.evaluateCondition,
  );
  assert.deepEqual(visibleIds(stateSaysDone), ['hint_1']);
});

// --- delay_seconds --------------------------------------------------------

test('the first evaluation of a delay starts the clock and reports the full wait', async () => {
  const hints = [hint({ id: 'hint_1', delay_seconds: 4, trigger: { conditions: null } })];
  const state = createHintState();
  const before = Date.now();

  const first = await evaluateHints(hints, state, CODE_CHANGE, fakeEvaluator().evaluateCondition);
  assert.deepEqual(first.visibleHints, []);
  assert.equal(first.nextEvaluationDelayMs, 4000);
  const startedAt = state.firstTriggered.get('hint_1');
  assert.ok(startedAt >= before && startedAt <= Date.now(), 'firstTriggered holds a Date.now() timestamp');
  assert.equal(state.triggered.has('hint_1'), false);
});

test('a seeded firstTriggered decides whether the delay has elapsed', async () => {
  const evaluator = fakeEvaluator();
  const hints = [hint({ id: 'hint_1', delay_seconds: 4, trigger: { conditions: null } })];

  const waiting = createHintState();
  startedAgoMs(waiting, 'hint_1', 1000);
  const pending = await evaluateHints(hints, waiting, CODE_CHANGE, evaluator.evaluateCondition);
  assert.deepEqual(pending.visibleHints, []);
  assertPendingNear(pending.nextEvaluationDelayMs, 3000);
  assert.equal(waiting.triggered.has('hint_1'), false);

  const due = createHintState();
  startedAgoMs(due, 'hint_1', 4000);
  const shown = await evaluateHints(hints, due, CODE_CHANGE, evaluator.evaluateCondition);
  assert.deepEqual(visibleIds(shown), ['hint_1']);
  assert.equal(shown.nextEvaluationDelayMs, null);
  assert.equal(due.triggered.has('hint_1'), true);
});

test('the reported wait is the soonest of the pending hints', async () => {
  const evaluator = fakeEvaluator();
  const hints = [
    hint({ id: 'slow', delay_seconds: 30, trigger: { conditions: null } }),
    hint({ id: 'fast', delay_seconds: 5, trigger: { conditions: null } }),
  ];
  const state = createHintState();
  startedAgoMs(state, 'slow', 10000);
  startedAgoMs(state, 'fast', 4000);

  const bothWaiting = await evaluateHints(hints, state, CODE_CHANGE, evaluator.evaluateCondition);
  assert.deepEqual(bothWaiting.visibleHints, []);
  assertPendingNear(bothWaiting.nextEvaluationDelayMs, 1000);

  startedAgoMs(state, 'fast', 5000);
  const fastOnly = await evaluateHints(hints, state, CODE_CHANGE, evaluator.evaluateCondition);
  assert.deepEqual(visibleIds(fastOnly), ['fast']);
  assertPendingNear(fastOnly.nextEvaluationDelayMs, 20000);

  startedAgoMs(state, 'slow', 30000);
  assert.deepEqual(visibleIds(await evaluateHints(hints, state, CODE_CHANGE, evaluator.evaluateCondition)), ['slow', 'fast']);
});

test('a delay of zero shows the hint straight away', async () => {
  const hints = [hint({ id: 'hint_1', delay_seconds: 0, trigger: { conditions: null } })];
  const state = createHintState();
  const result = await evaluateHints(hints, state, CODE_CHANGE, fakeEvaluator().evaluateCondition);

  assert.deepEqual(visibleIds(result), ['hint_1']);
  assert.equal(result.nextEvaluationDelayMs, null);
  assert.equal(state.firstTriggered.has('hint_1'), false);
});

// --- checklist vs triggered / style ---------------------------------------

test('display mode and style pass through to the panel untranslated', async () => {
  const hints = [
    hint({ id: 'step_1', display_mode: 'checklist', style: 'warning', trigger: { conditions: null } }),
    hint({ id: 'nudge', display_mode: 'triggered', style: 'info', trigger: { conditions: null } }),
  ];

  const { visibleHints } = await evaluateHints(
    hints,
    createHintState(),
    CODE_CHANGE,
    fakeEvaluator().evaluateCondition,
  );
  assert.deepEqual(
    visibleHints.map((visible) => [visible.id, visible.display_mode, visible.style]),
    [
      ['step_1', 'checklist', 'warning'],
      ['nudge', 'triggered', 'info'],
    ],
  );
});

test('a triggered hint is marked once its condition holds, and an off-lane hint never is', async () => {
  const evaluator = fakeEvaluator();
  const state = createHintState();

  await evaluateHints([hint({ id: 'hint_1' })], state, CODE_CHANGE, evaluator.evaluateCondition);
  assert.equal(state.triggered.has('hint_1'), true);

  await evaluateHints(
    [hint({ id: 'hint_2', trigger: { event: 'test_fail', conditions: null } })],
    state,
    CODE_CHANGE,
    evaluator.evaluateCondition,
  );
  assert.equal(state.triggered.has('hint_2'), false);
});

test('a failed checklist condition un-ticks only when invalidation is asked for', async () => {
  const keeping = [
    hint({ id: 'keep', display_mode: 'checklist', trigger: { conditions: { type: 'source_empty' } } }),
  ];
  const clearing = [
    hint({
      id: 'clear',
      display_mode: 'checklist',
      trigger: { conditions: { type: 'source_regex' }, invalidate_on_condition_false: true },
    }),
  ];
  const holds = fakeEvaluator();
  const fails = fakeEvaluator({ byType: { source_empty: { passed: false }, source_regex: { passed: false } } });
  const state = createHintState();

  await evaluateHints(keeping, state, CODE_CHANGE, holds.evaluateCondition);
  await evaluateHints(clearing, state, CODE_CHANGE, holds.evaluateCondition);
  assert.deepEqual([...state.triggered].sort(), ['clear', 'keep']);

  await evaluateHints(keeping, state, CODE_CHANGE, fails.evaluateCondition);
  await evaluateHints(clearing, state, CODE_CHANGE, fails.evaluateCondition);
  assert.deepEqual([...state.triggered], ['keep']);
  // Both are hidden again regardless, because the condition no longer holds.
  assert.deepEqual(visibleIds(await evaluateHints(keeping, state, CODE_CHANGE, fails.evaluateCondition)), []);
  assert.deepEqual(visibleIds(await evaluateHints(clearing, state, CODE_CHANGE, fails.evaluateCondition)), []);
});

// --- async batching -------------------------------------------------------

test('one pass evaluates each reachable hint once, in config order, one await at a time', async () => {
  const evaluator = fakeEvaluator();
  const hints = [
    hint({ id: 'first', trigger: { conditions: { type: 'source_empty' } } }),
    hint({ id: 'gated', trigger: { conditions: { type: 'source_regex' }, after_attempts: 3 } }),
    hint({ id: 'second', trigger: { conditions: { type: 'source_regex' } } }),
    hint({ id: 'other_lane', trigger: { event: 'test_fail', conditions: { type: 'source_empty' } } }),
    hint({ id: 'unconditional', trigger: { conditions: null } }),
    hint({ id: 'used', trigger: { conditions: { type: 'source_empty' } } }),
  ];
  const state = createHintState();
  state.consumed.add('used');

  const result = await evaluateHints(hints, state, CODE_CHANGE, evaluator.evaluateCondition);

  // Exactly one call per hint that both matched the event and passed its
  // gates, in config order; gated, off-lane, condition-free and consumed hints
  // never reach the evaluator.
  assert.deepEqual(
    evaluator.calls.map((condition) => condition.type),
    ['source_empty', 'source_regex'],
  );
  // Sequential awaits: a parallel fan-out would have overlapped here.
  assert.equal(evaluator.maxInFlight(), 1);
  // The unconditional hint shows without ever being handed to the evaluator.
  assert.deepEqual(visibleIds(result), ['first', 'second', 'unconditional']);
});

test('a pass applies every condition result before it returns', async () => {
  const evaluator = fakeEvaluator({
    byType: { source_empty: { passed: true }, source_regex: { passed: false, detail: 'no match' } },
  });
  const hints = [
    hint({ id: 'ok', trigger: { conditions: { type: 'source_empty' } } }),
    hint({ id: 'not_yet', trigger: { conditions: { type: 'source_regex' } } }),
  ];
  const state = createHintState();

  const result = await evaluateHints(hints, state, CODE_CHANGE, evaluator.evaluateCondition);
  assert.deepEqual(visibleIds(result), ['ok']);
  assert.deepEqual([...state.triggered], ['ok']);
  assert.equal(state.firstTriggered.size, 0);
});

test('the returned promise settles only after the injected evaluator resolves', async () => {
  let passed = false;
  const calls = [];
  const evaluateCondition = async (condition) => {
    calls.push(condition);
    return { passed };
  };
  const hints = [hint({ id: 'hint_1' })];
  const state = createHintState();

  const pending = evaluateHints(hints, state, CODE_CHANGE, evaluateCondition);
  assert.ok(pending instanceof Promise);
  assert.deepEqual(visibleIds(await pending), []);
  assert.equal(state.triggered.size, 0);

  passed = true;
  assert.deepEqual(visibleIds(await evaluateHints(hints, state, CODE_CHANGE, evaluateCondition)), ['hint_1']);
  assert.equal(calls.length, 2);
});

// --- manual requests ------------------------------------------------------

test('manual request state says whether the activity has manual hints at all', async () => {
  const state = createHintState();
  const never = neverEvaluated();

  assert.ok(getManualHintRequestState([], state, never) instanceof Promise);
  assert.deepEqual(await getManualHintRequestState([], state, never), { hasManualHints: false, canRequest: false });
  assert.deepEqual(
    await getManualHintRequestState([hint({ trigger: { event: 'code_change' } })], state, never),
    { hasManualHints: false, canRequest: false },
  );
  assert.deepEqual(await getManualHintRequestState(null, state, never), { hasManualHints: false, canRequest: false });
  assert.deepEqual(await getManualHintRequestState('nope', state, never), { hasManualHints: false, canRequest: false });
  assert.deepEqual(
    await getManualHintRequestState([null, undefined, {}], state, never),
    { hasManualHints: false, canRequest: false },
  );
});

test('a manual hint is requestable while its condition holds, and not once consumed', async () => {
  const manual = hint({ id: 'help', trigger: { event: 'manual', conditions: { type: 'source_regex' } } });
  const holds = fakeEvaluator({ byType: { source_regex: { passed: true } } });
  const fails = fakeEvaluator({ byType: { source_regex: { passed: false } } });
  const state = createHintState();

  assert.deepEqual(
    await getManualHintRequestState([manual], state, holds.evaluateCondition),
    { hasManualHints: true, canRequest: true },
  );
  assert.deepEqual(
    await getManualHintRequestState([manual], state, fails.evaluateCondition),
    { hasManualHints: true, canRequest: false },
  );

  state.consumed.add('help');
  assert.equal((await getManualHintRequestState([manual], state, holds.evaluateCondition)).canRequest, false);
  assert.equal(holds.calls.length, 1); // a consumed hint never reaches the evaluator
});

test('a manual hint without conditions is requestable once its attempt threshold is met', async () => {
  const manual = hint({ id: 'help', trigger: { event: 'manual', conditions: null, after_attempts: 2 } });
  const state = createHintState();
  const never = neverEvaluated();

  assert.equal((await getManualHintRequestState([manual], state, never)).canRequest, false);
  state.attemptCount = 2;
  assert.equal((await getManualHintRequestState([manual], state, never)).canRequest, true);

  // A delay is not consulted on an explicit request: the student asked, so it shows.
  const delayed = hint({ id: 'slow', delay_seconds: 60, trigger: { event: 'manual', conditions: null } });
  assert.equal((await getManualHintRequestState([delayed], createHintState(), never)).canRequest, true);
});

test('one eligible manual hint is enough to allow a request', async () => {
  const first = hint({ id: 'a', trigger: { event: 'manual', conditions: null } });
  const second = hint({ id: 'b', trigger: { event: 'manual', conditions: null } });
  const state = createHintState();
  const evaluator = fakeEvaluator();

  assert.equal((await getManualHintRequestState([first, second], state, evaluator.evaluateCondition)).canRequest, true);
  state.consumed.add('a');
  assert.equal((await getManualHintRequestState([first, second], state, evaluator.evaluateCondition)).canRequest, true);
  state.consumed.add('b');
  assert.deepEqual(
    await getManualHintRequestState([first, second], state, evaluator.evaluateCondition),
    { hasManualHints: true, canRequest: false },
  );
  // Without state nothing can be checked, so nothing may be requested.
  assert.equal((await getManualHintRequestState([first], null, evaluator.evaluateCondition)).canRequest, false);
  assert.equal(evaluator.calls.length, 0);
});

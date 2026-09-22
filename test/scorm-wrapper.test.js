/**
 * SCORM 1.2 API wrapper — discovery, session lifecycle and write coalescing.
 *
 * The wrapper hides a Moodle-shaped runtime: `LMSSetValue` only changes the
 * runtime's in-memory model, while `LMSCommit` is a blocking server round-trip
 * that freezes the tab. So the interesting edges are which write earns a commit
 * and when that commit is deferred, what the wrapper refuses to overwrite (a
 * returning student's tracked attempt), and how the session behaves when there
 * is no LMS at all or when it has already been finished.
 *
 * Every test loads its own module instance: the session lives at module scope.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshModule } from './helpers/fresh.js';
import { installLms, installNoLms } from './helpers/lms.js';

const WRAPPER = new URL('../src/scorm-template/js/scorm-wrapper.js', import.meta.url).href;

/** A fresh wrapper instance — the SCORM session is module-level state. */
function loadWrapper() {
  return freshModule(WRAPPER);
}

/** Install the fake runtime as the frame the wrapper searches from. */
function lmsFor(t, options = {}) {
  const lms = installLms(options);
  t.after(() => lms.restore());
  return lms;
}

/**
 * Seed the runtime's data model, the way a returning student's LMS would hold
 * it. Written straight into the model so seeding is not itself an API call.
 */
function seed(lms, key, value) {
  lms.model.set(key, value);
}

/** The wrapper narrates preview mode and rejections on the console. */
function quiet(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
}

/** A session with a status the LMS already tracks, so init claims nothing. */
async function startedSession(t, options = {}) {
  const lms = lmsFor(t, options);
  seed(lms, 'cmi.core.lesson_status', 'incomplete');
  const wrapper = await loadWrapper();
  wrapper.init();
  return { lms, wrapper };
}

test('the API is found through up to seven parent frames', async (t) => {
  quiet(t);
  for (let depth = 0; depth <= 7; depth += 1) {
    const lms = lmsFor(t, { depth });
    const wrapper = await loadWrapper();

    assert.equal(wrapper.init(), true, `depth ${depth} should reach the API`);
    assert.equal(wrapper.isPreviewMode(), false, `depth ${depth}`);
    assert.equal(wrapper.isSessionActive(), true, `depth ${depth}`);
    assert.equal(lms.callsOf('LMSInitialize').length, 1, `depth ${depth}`);
  }
});

test('an API beyond seven parent frames is out of reach, so preview mode follows', async (t) => {
  quiet(t);
  const lms = lmsFor(t, { depth: 8 });
  const wrapper = await loadWrapper();

  assert.equal(wrapper.init(), false);
  assert.equal(wrapper.isPreviewMode(), true);
  assert.equal(wrapper.isSessionActive(), false);
  assert.equal(lms.calls.length, 0);
});

test('window.opener is searched when no parent frame exposes the API', async (t) => {
  quiet(t);
  const lms = lmsFor(t, { depth: 8 });
  const opener = { API: lms.api, parent: null, opener: null };
  opener.parent = opener;
  lms.window.opener = opener;

  const wrapper = await loadWrapper();

  assert.equal(wrapper.init(), true);
  assert.equal(wrapper.isPreviewMode(), false);
  assert.equal(wrapper.isSessionActive(), true);
});

test('an opener that has no API leaves the page in preview mode instead of recursing', async (t) => {
  quiet(t);
  // A non-SCORM page that opened the package in a new tab: the opener exists,
  // its own chain has no API, and neither does this page's ancestors.
  const lms = lmsFor(t, { depth: 8 });
  const opener = { API: null, parent: null, opener: null };
  opener.parent = opener;
  lms.window.opener = opener;

  const wrapper = await loadWrapper();

  assert.equal(wrapper.init(), false);
  assert.equal(wrapper.isPreviewMode(), true);
  assert.equal(wrapper.isSessionActive(), false);
  assert.equal(lms.calls.length, 0);
});

test('with no reachable LMS at all the page runs in preview mode', async (t) => {
  quiet(t);
  const noLms = installNoLms();
  t.after(() => noLms.restore());
  const wrapper = await loadWrapper();

  assert.equal(wrapper.init(), false);
  assert.equal(wrapper.isPreviewMode(), true);
  assert.equal(wrapper.isSessionActive(), false);
  assert.equal(wrapper.getStudentId(), '');
  assert.equal(wrapper.getSuspendData(), '');

  wrapper.setStatus('passed');
  wrapper.reportScore(90, 50);
  assert.equal(wrapper.setSuspendData('anything'), false);
  assert.equal(wrapper.clearSuspendData(), false);
  wrapper.flushPendingWrites();
  wrapper.terminate();
  assert.equal(wrapper.resume(), false);
});

test('a first entry claims the attempt by writing incomplete, and commits it', async (t) => {
  quiet(t);
  const lms = lmsFor(t);
  const wrapper = await loadWrapper();

  assert.equal(wrapper.init(), true);
  assert.equal(lms.valueOf('cmi.core.lesson_status'), 'incomplete');
  assert.deepEqual(lms.commits, [{ 'cmi.core.lesson_status': 'incomplete' }]);
  assert.equal(lms.calls[0].method, 'LMSInitialize');
  // init also reads the previous score and status to adopt the best result.
  assert.equal(lms.callsOf('LMSCommit').length, 1);
});

test('empty, not attempted and browsed are the only statuses treated as a fresh attempt', async (t) => {
  quiet(t);
  for (const status of ['', 'not attempted', 'browsed']) {
    const lms = lmsFor(t);
    if (status !== '') seed(lms, 'cmi.core.lesson_status', status);
    const wrapper = await loadWrapper();

    assert.equal(wrapper.init(), true, status || '(empty)');
    assert.equal(lms.valueOf('cmi.core.lesson_status'), 'incomplete', status || '(empty)');
  }
});

test('an attempt the LMS already tracks is never overwritten on re-entry', async (t) => {
  quiet(t);
  const tracked = ['passed', 'failed', 'completed', 'incomplete', 'Not Attempted', ' not attempted '];

  for (const status of tracked) {
    const lms = lmsFor(t);
    seed(lms, 'cmi.core.lesson_status', status);
    const wrapper = await loadWrapper();

    assert.equal(wrapper.init(), true, status);
    assert.equal(lms.valueOf('cmi.core.lesson_status'), status, status);
    assert.equal(lms.callsOf('LMSSetValue').length, 0, status);
    assert.equal(lms.commits.length, 0, status);
  }
});

test('LMSInitialize saying no drops the page into preview mode', async (t) => {
  quiet(t);
  const lms = lmsFor(t, { initializeResult: 'false' });
  const wrapper = await loadWrapper();

  assert.equal(wrapper.init(), false);
  assert.equal(wrapper.isPreviewMode(), true);
  assert.equal(wrapper.isSessionActive(), false);
  assert.equal(lms.callsOf('LMSInitialize').length, 1);
  assert.equal(lms.callsOf('LMSSetValue').length, 0);
  assert.equal(lms.commits.length, 0);
});

test('a boolean true from LMSInitialize counts as success', async (t) => {
  quiet(t);
  const lms = lmsFor(t, { initializeResult: true });
  const wrapper = await loadWrapper();

  assert.equal(wrapper.init(), true);
  assert.equal(wrapper.isPreviewMode(), false);
  assert.equal(lms.valueOf('cmi.core.lesson_status'), 'incomplete');
});

test('reportScore clamps to 0-100 with rounding, and always writes min and max', async (t) => {
  const cases = [
    [-5, '0'],
    [-0.4, '0'],
    [0, '0'],
    [49.4, '49'],
    [49.5, '50'],
    [99.5, '100'],
    [100, '100'],
    [100.6, '100'],
    [150, '100'],
    [Infinity, '100'],
    [-Infinity, '0'],
  ];

  // One session per value: the session keeps its best score, which would
  // otherwise mask a clamp on the way down.
  for (const [input, expected] of cases) {
    const { lms, wrapper } = await startedSession(t);
    wrapper.reportScore(input, 0);
    assert.equal(lms.valueOf('cmi.core.score.raw'), expected, `reportScore(${input})`);
    assert.equal(lms.valueOf('cmi.core.score.min'), '0', `reportScore(${input})`);
    assert.equal(lms.valueOf('cmi.core.score.max'), '100', `reportScore(${input})`);
  }
});

test('a score that is not a number is clamped to 0, never written as NaN', async (t) => {
  const { lms, wrapper } = await startedSession(t);

  // Math.max/Math.min propagate NaN, so without an explicit guard the LMS
  // receives the text "NaN", which it cannot parse.
  wrapper.reportScore(NaN, 50);
  assert.equal(lms.valueOf('cmi.core.score.raw'), '0');
  assert.equal(lms.valueOf('cmi.core.lesson_status'), 'failed');

  wrapper.reportScore('not a number', 50);
  assert.equal(lms.valueOf('cmi.core.score.raw'), '0');
});

test('the session keeps its best result, so a later failed Check cannot take a pass away', async (t) => {
  const { lms, wrapper } = await startedSession(t);

  wrapper.reportScore(80, 50);
  assert.equal(lms.valueOf('cmi.core.score.raw'), '80');
  assert.equal(lms.valueOf('cmi.core.lesson_status'), 'passed');

  // The student keeps experimenting and breaks their program.
  wrapper.reportScore(0, 50);
  assert.equal(lms.valueOf('cmi.core.score.raw'), '80', 'the best score of the session is kept');
  assert.equal(lms.valueOf('cmi.core.lesson_status'), 'passed', 'the pass survives');

  // A better score still wins.
  wrapper.reportScore(95, 50);
  assert.equal(lms.valueOf('cmi.core.score.raw'), '95');
  assert.equal(lms.valueOf('cmi.core.lesson_status'), 'passed');
});

test('a pass and a score from an earlier session are adopted, not downgraded', async (t) => {
  const lms = lmsFor(t);
  seed(lms, 'cmi.core.lesson_status', 'passed');
  seed(lms, 'cmi.core.score.raw', '70');
  const wrapper = await loadWrapper();
  wrapper.init();

  wrapper.reportScore(10, 50);
  assert.equal(lms.valueOf('cmi.core.score.raw'), '70');
  assert.equal(lms.valueOf('cmi.core.lesson_status'), 'passed');

  // A failed first Check in a fresh session, with no previous pass, still fails.
  const fresh = lmsFor(t);
  seed(fresh, 'cmi.core.lesson_status', 'incomplete');
  const freshWrapper = await loadWrapper();
  freshWrapper.init();
  freshWrapper.reportScore(10, 50);
  assert.equal(fresh.valueOf('cmi.core.score.raw'), '10');
  assert.equal(fresh.valueOf('cmi.core.lesson_status'), 'failed');
});

test('reportScore passes at exactly the passing score and fails just below it', async (t) => {
  const { lms, wrapper } = await startedSession(t);

  wrapper.reportScore(50, 50);
  assert.equal(lms.valueOf('cmi.core.lesson_status'), 'passed');

  // A fresh session: the first one keeps its 50, so a later 49 would pass there.
  const missed = await startedSession(t);
  missed.wrapper.reportScore(49, 50);
  assert.equal(missed.lms.valueOf('cmi.core.lesson_status'), 'failed');
});

test('the rounded score is what the pass threshold sees', async (t) => {
  const { lms, wrapper } = await startedSession(t);

  wrapper.reportScore(60.4, 60.5);
  assert.equal(lms.valueOf('cmi.core.score.raw'), '60');
  assert.equal(lms.valueOf('cmi.core.lesson_status'), 'failed');

  wrapper.reportScore(60.6, 60.5);
  assert.equal(lms.valueOf('cmi.core.score.raw'), '61');
  assert.equal(lms.valueOf('cmi.core.lesson_status'), 'passed');
});

test('the clamped score decides pass or fail at the extremes', async (t) => {
  const belowThreshold = await startedSession(t);
  belowThreshold.wrapper.reportScore(-1, 0);
  assert.equal(belowThreshold.lms.valueOf('cmi.core.score.raw'), '0');
  assert.equal(belowThreshold.lms.valueOf('cmi.core.lesson_status'), 'passed');

  // A fresh session, because a session keeps the best result it has seen.
  const justMissed = await startedSession(t);
  justMissed.wrapper.reportScore(-1, 1);
  assert.equal(justMissed.lms.valueOf('cmi.core.lesson_status'), 'failed');

  const aboveMax = await startedSession(t);
  aboveMax.wrapper.reportScore(150, 100);
  assert.equal(aboveMax.lms.valueOf('cmi.core.score.raw'), '100');
  assert.equal(aboveMax.lms.valueOf('cmi.core.lesson_status'), 'passed');
});

test('a reported score and the status that follows it share one commit', async (t) => {
  const { lms, wrapper } = await startedSession(t);

  wrapper.reportScore(70, 50);

  assert.equal(lms.callsOf('LMSCommit').length, 1);
  assert.deepEqual(lms.commits, [{
    'cmi.core.lesson_status': 'passed',
    'cmi.core.score.raw': '70',
    'cmi.core.score.min': '0',
    'cmi.core.score.max': '100',
  }]);
});

test('setStatus writes the status and commits it right away', async (t) => {
  const { lms, wrapper } = await startedSession(t);

  wrapper.setStatus('completed');

  assert.equal(lms.valueOf('cmi.core.lesson_status'), 'completed');
  assert.equal(lms.commits.length, 1);
});

test('background writes inside the commit interval are coalesced into one commit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { lms, wrapper } = await startedSession(t);
  assert.equal(lms.commits.length, 0);

  assert.equal(wrapper.setSuspendData('one'), true);
  assert.equal(wrapper.setSuspendData('two'), true);

  // the runtime's model is current immediately, but the server leg is deferred
  assert.equal(lms.valueOf('cmi.suspend_data'), 'two');
  assert.equal(lms.callsOf('LMSCommit').length, 0);

  t.mock.timers.tick(9999);
  assert.equal(lms.commits.length, 0);

  t.mock.timers.tick(1);
  assert.equal(lms.commits.length, 1);
  assert.equal(lms.commits[0]['cmi.suspend_data'], 'two');

  // no second timer was left behind to commit the same data again
  t.mock.timers.tick(60000);
  assert.equal(lms.commits.length, 1);
});

test('a forced write pushes the deferred value out at once and cancels its timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { lms, wrapper } = await startedSession(t);

  wrapper.setSuspendData('draft');
  assert.equal(lms.commits.length, 0);

  wrapper.setStatus('completed');

  assert.equal(lms.commits.length, 1);
  assert.equal(lms.commits[0]['cmi.suspend_data'], 'draft');
  assert.equal(lms.commits[0]['cmi.core.lesson_status'], 'completed');

  t.mock.timers.tick(60000);
  assert.equal(lms.commits.length, 1);
});

test('the commit interval is measured from the last commit, not the last write', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { lms, wrapper } = await startedSession(t);

  wrapper.reportScore(10, 5);
  assert.equal(lms.commits.length, 1);

  // a background write straight after a commit waits out the whole interval
  wrapper.setSuspendData('later');
  assert.equal(lms.commits.length, 1);

  t.mock.timers.tick(9999);
  assert.equal(lms.commits.length, 1);

  t.mock.timers.tick(1);
  assert.equal(lms.commits.length, 2);
  assert.equal(lms.commits[1]['cmi.suspend_data'], 'later');
});

test('flushPendingWrites sends the deferred value now, and is a no-op with nothing pending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { lms, wrapper } = await startedSession(t);

  wrapper.flushPendingWrites();
  assert.equal(lms.commits.length, 0);

  wrapper.setSuspendData('checkpoint');
  assert.equal(lms.commits.length, 0);

  wrapper.flushPendingWrites();
  assert.equal(lms.commits.length, 1);
  assert.equal(lms.commits[0]['cmi.suspend_data'], 'checkpoint');

  t.mock.timers.tick(60000);
  assert.equal(lms.commits.length, 1);
});

test('a refused suspend write is reported and leaves nothing to commit', async (t) => {
  quiet(t);
  const lms = lmsFor(t, { rejectSuspendData: true });
  seed(lms, 'cmi.core.lesson_status', 'incomplete');
  const wrapper = await loadWrapper();
  wrapper.init();

  assert.equal(wrapper.setSuspendData('nope'), false);
  assert.equal(lms.valueOf('cmi.suspend_data'), '');
  assert.equal(lms.rejected.length, 1);
  assert.equal(lms.commits.length, 0);

  wrapper.flushPendingWrites();
  assert.equal(lms.commits.length, 0);
});

test('clearSuspendData empties the stored value when the LMS accepts it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const lms = lmsFor(t);
  seed(lms, 'cmi.core.lesson_status', 'incomplete');
  seed(lms, 'cmi.suspend_data', '{"step":3}');
  const wrapper = await loadWrapper();
  wrapper.init();

  assert.equal(wrapper.getSuspendData(), '{"step":3}');
  assert.equal(wrapper.clearSuspendData(), true);
  assert.equal(lms.valueOf('cmi.suspend_data'), '');
  assert.equal(wrapper.getSuspendData(), '');
});

test('clearSuspendData fails and changes nothing when the LMS refuses', async (t) => {
  quiet(t);
  const lms = lmsFor(t, { rejectAllWrites: true });
  seed(lms, 'cmi.core.lesson_status', 'incomplete');
  seed(lms, 'cmi.suspend_data', '{"step":3}');
  const wrapper = await loadWrapper();
  wrapper.init();

  assert.equal(wrapper.clearSuspendData(), false);
  assert.equal(lms.valueOf('cmi.suspend_data'), '{"step":3}');
});

test('a numeric suspend payload is stored as its text form', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { lms, wrapper } = await startedSession(t);

  // 0 is falsy, so a truthiness check would drop it before the LMS ever saw it
  assert.equal(wrapper.setSuspendData(0), true);
  assert.equal(lms.valueOf('cmi.suspend_data'), '0');

  assert.equal(wrapper.setSuspendData(''), true);
  assert.equal(lms.valueOf('cmi.suspend_data'), '');
  assert.equal(wrapper.getSuspendData(), '');
});

test('a long suspend payload survives the round trip unmodified', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { wrapper, lms } = await startedSession(t);
  const payload = 'x'.repeat(200_000);

  assert.equal(wrapper.setSuspendData(payload), true);
  assert.equal(wrapper.getSuspendData(), payload);
  assert.equal(lms.valueOf('cmi.suspend_data').length, payload.length);
});

test('terminate flushes uncommitted writes before it finishes the session', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { lms, wrapper } = await startedSession(t);

  wrapper.setSuspendData('final');
  assert.equal(lms.commits.length, 0);

  wrapper.terminate();

  assert.equal(lms.commits.length, 1);
  assert.equal(lms.commits[0]['cmi.suspend_data'], 'final');
  assert.equal(lms.callsOf('LMSFinish').length, 1);

  const commitAt = lms.calls.findIndex((call) => call.method === 'LMSCommit');
  const finishAt = lms.calls.findIndex((call) => call.method === 'LMSFinish');
  assert.ok(commitAt !== -1 && commitAt < finishAt, 'the pending write must land before LMSFinish');

  // the deferred timer is gone, so nothing commits after the session ended
  t.mock.timers.tick(60000);
  assert.equal(lms.commits.length, 1);
});

test('after terminate nothing else reaches the LMS, and terminating again is a no-op', async (t) => {
  quiet(t);
  const lms = lmsFor(t);
  seed(lms, 'cmi.core.lesson_status', 'incomplete');
  const wrapper = await loadWrapper();
  wrapper.init();
  wrapper.setStatus('completed');
  wrapper.terminate();

  assert.equal(wrapper.isSessionActive(), false);

  const callsAtFinish = lms.calls.length;
  wrapper.setStatus('failed');
  wrapper.reportScore(99, 50);
  assert.equal(wrapper.setSuspendData('after'), false);
  assert.equal(wrapper.clearSuspendData(), false);
  wrapper.flushPendingWrites();
  wrapper.terminate();

  assert.equal(lms.calls.length, callsAtFinish);
  assert.equal(lms.callsOf('LMSFinish').length, 1);
  assert.equal(lms.valueOf('cmi.core.lesson_status'), 'completed');
  assert.equal(lms.valueOf('cmi.core.score.raw'), '');
  assert.equal(wrapper.getStudentId(), '');
  assert.equal(wrapper.getSuspendData(), '');
});

test('resume re-opens a finished session so writes land again', async (t) => {
  quiet(t);
  const lms = lmsFor(t);
  seed(lms, 'cmi.core.lesson_status', 'incomplete');
  const wrapper = await loadWrapper();
  wrapper.init();
  wrapper.terminate();
  assert.equal(wrapper.isSessionActive(), false);

  assert.equal(wrapper.resume(), true);
  assert.equal(wrapper.isSessionActive(), true);

  wrapper.setStatus('completed');
  assert.equal(lms.valueOf('cmi.core.lesson_status'), 'completed');
  assert.equal(lms.callsOf('LMSInitialize').length, 2);
});

test('resume on a live session is not a second initialize', async (t) => {
  quiet(t);
  const { lms, wrapper } = await startedSession(t);

  assert.equal(wrapper.resume(), true);
  assert.equal(lms.callsOf('LMSInitialize').length, 1);
});

test('resume before init finds no session to re-open', async (t) => {
  quiet(t);
  const lms = lmsFor(t);
  const wrapper = await loadWrapper();

  assert.equal(wrapper.resume(), false);
  assert.equal(lms.callsOf('LMSInitialize').length, 0);
});

test('resume in preview mode stays in preview mode', async (t) => {
  quiet(t);
  const lms = lmsFor(t, { initializeResult: 'false' });
  const wrapper = await loadWrapper();
  assert.equal(wrapper.init(), false);

  assert.equal(wrapper.resume(), false);
  assert.equal(wrapper.isPreviewMode(), true);
  assert.equal(lms.callsOf('LMSInitialize').length, 1);
});

test('resume reports failure when the LMS will not re-open the session', async (t) => {
  quiet(t);
  const lms = lmsFor(t);
  seed(lms, 'cmi.core.lesson_status', 'incomplete');
  const wrapper = await loadWrapper();
  wrapper.init();
  wrapper.terminate();

  // a runtime that finalized the session refuses the second initialize
  lms.api.LMSInitialize = () => 'false';

  assert.equal(wrapper.resume(), false);
  assert.equal(wrapper.isSessionActive(), false);
  wrapper.setStatus('passed');
  assert.equal(lms.valueOf('cmi.core.lesson_status'), 'incomplete');
});

test('getStudentId is trimmed, and empty without a live session', async (t) => {
  const lms = lmsFor(t);
  seed(lms, 'cmi.core.lesson_status', 'incomplete');
  seed(lms, 'cmi.core.student_id', '  s 42  ');
  const wrapper = await loadWrapper();

  assert.equal(wrapper.getStudentId(), '');
  wrapper.init();
  assert.equal(wrapper.getStudentId(), 's 42');
});

test('getStudentId ignores an id the LMS answers with a non-string', async (t) => {
  const lms = lmsFor(t);
  seed(lms, 'cmi.core.lesson_status', 'incomplete');
  seed(lms, 'cmi.core.student_id', 4217);
  const wrapper = await loadWrapper();
  wrapper.init();

  assert.equal(wrapper.getStudentId(), '');
});

test('getSuspendData is empty when unset, when the LMS answers oddly, or when offline', async (t) => {
  const lms = lmsFor(t);
  seed(lms, 'cmi.core.lesson_status', 'incomplete');
  const wrapper = await loadWrapper();

  assert.equal(wrapper.getSuspendData(), '');

  wrapper.init();
  assert.equal(wrapper.getSuspendData(), '');

  seed(lms, 'cmi.suspend_data', 42);
  assert.equal(wrapper.getSuspendData(), '');

  wrapper.terminate();
  seed(lms, 'cmi.suspend_data', 'stored');
  assert.equal(wrapper.getSuspendData(), '');
});

test('preview mode makes every setter a no-op, and the runtime sees no writes', async (t) => {
  quiet(t);
  const lms = lmsFor(t, { initializeResult: 'false' });
  const wrapper = await loadWrapper();
  assert.equal(wrapper.init(), false);

  wrapper.setStatus('passed');
  wrapper.reportScore(90, 50);
  assert.equal(wrapper.setSuspendData('x'), false);
  assert.equal(wrapper.clearSuspendData(), false);
  wrapper.flushPendingWrites();
  wrapper.terminate();

  assert.equal(lms.callsOf('LMSSetValue').length, 0);
  assert.equal(lms.callsOf('LMSCommit').length, 0);
  assert.equal(lms.callsOf('LMSFinish').length, 0);
  assert.equal(lms.model.size, 0);
  assert.equal(wrapper.isSessionActive(), false);
  assert.equal(wrapper.getStudentId(), '');
  assert.equal(wrapper.getSuspendData(), '');
});

test('setters called before init do nothing at all', async (t) => {
  quiet(t);
  const lms = lmsFor(t);
  const wrapper = await loadWrapper();

  wrapper.setStatus('passed');
  wrapper.reportScore(50, 50);
  wrapper.flushPendingWrites();
  wrapper.terminate();

  assert.equal(lms.calls.length, 0);
  assert.equal(lms.commits.length, 0);
});

/**
 * SCORM 1.2 API Wrapper
 *
 * Locates the SCORM API in parent frames, provides methods for init, score
 * reporting, status setting, and termination. Falls back to no-op mode when
 * not running inside an LMS (e.g., preview/testing).
 *
 * Every `LMSSetValue` only changes the LMS-side data model in memory: the
 * write reaches the server on `LMSCommit`. LMS runtimes are free to implement
 * that commit with a blocking request, and Moodle does exactly that
 * (mod/scorm/request.js posts with a synchronous XHR), so background writes
 * are coalesced and deliberate ones are flushed immediately.
 */

/**
 * Shortest gap between two commits. A commit freezes the tab for the length of
 * the server round-trip, so background saves from editing are throttled to at
 * most one per interval; Check, tab hide and leaving the page bypass this.
 */
const COMMIT_MIN_INTERVAL_MS = 10000;

let api = null;
let initialized = false;
let previewMode = false;
let hasUncommittedWrites = false;
let lastCommitAt = 0;
let commitTimer = null;
/** Best score reported this session (null until the first Check). */
let bestScore = null;
/** True once the student has passed, here or in an earlier session. */
let hasPassed = false;

/**
 * Search for the SCORM API object in parent frames.
 * SCORM spec says search up to 7 parent levels + window.opener.
 */
function findAPI(win) {
  const api = findAPIInFrameChain(win);
  if (api) return api;

  // SCORM also allows the API to live on the window that opened this one.
  // Follow exactly one opener: recursing through the opener's own opener would
  // loop forever whenever the opener has no API either, which is what any
  // non-SCORM page that opened the package in a new tab looks like.
  const opener = win?.opener;
  return opener && opener !== win ? findAPIInFrameChain(opener) : null;
}

/**
 * Walk up to seven parent frames looking for the API object.
 * @param {Window|object|null} win
 * @returns {object|null}
 */
function findAPIInFrameChain(win) {
  let current = win;
  let attempts = 0;

  while (current && !current.API && attempts < 7) {
    if (current.parent === current) break;
    current = current.parent;
    attempts++;
  }

  return current?.API ?? null;
}

/**
 * Whether a live LMS session is available for reads and writes.
 * @returns {boolean}
 */
function isConnected() {
  return initialized && !previewMode && Boolean(api);
}

/**
 * Send everything the LMS has not stored yet.
 * @param {{force?: boolean}} [options] - force skips the commit interval
 */
function commit({ force = false } = {}) {
  if (!isConnected() || !hasUncommittedWrites) return;

  const waitMs = COMMIT_MIN_INTERVAL_MS - (Date.now() - lastCommitAt);
  if (!force && waitMs > 0) {
    // The data model already holds the value; only the server leg is deferred.
    commitTimer ??= setTimeout(() => {
      commitTimer = null;
      commit();
    }, waitMs);
    return;
  }

  if (commitTimer) {
    clearTimeout(commitTimer);
    commitTimer = null;
  }
  api.LMSCommit('');
  lastCommitAt = Date.now();
  hasUncommittedWrites = false;
}

/**
 * Send pending writes to the LMS now instead of waiting for the commit
 * interval. Used when the page is going away and the write cannot wait.
 */
export function flushPendingWrites() {
  commit({ force: true });
}

/**
 * Write the raw score fields and mark the data model dirty.
 * @param {number} score - an already clamped 0-100 score
 * @returns {number} the score that was written
 */
function writeScore(score) {
  api.LMSSetValue('cmi.core.score.raw', String(score));
  api.LMSSetValue('cmi.core.score.min', '0');
  api.LMSSetValue('cmi.core.score.max', '100');
  hasUncommittedWrites = true;
  return score;
}

/**
 * A non-numeric score (NaN) would survive Math.max/Math.min and reach the LMS as
 * the text "NaN", which the runtime cannot parse. Infinities still clamp to the
 * nearest bound.
 * @param {number} score
 * @returns {number}
 */
function clampScore(score) {
  const numeric = Number(score);
  return Math.max(0, Math.min(100, Math.round(Number.isNaN(numeric) ? 0 : numeric)));
}

/**
 * Initialize the SCORM session.
 * @returns {boolean} true if connected to LMS, false if in preview mode
 */
export function init() {
  api = findAPI(window);

  if (!api) {
    console.warn('[SCORM] No LMS API found — running in preview mode');
    previewMode = true;
    initialized = true;
    return false;
  }

  const result = api.LMSInitialize('');
  if (result === 'true' || result === true) {
    initialized = true;
    hasUncommittedWrites = false;
    // Only claim the attempt while it has not started; re-entry must not wipe a
    // completed/passed status that the LMS is tracking for this student.
    const currentStatus = api.LMSGetValue('cmi.core.lesson_status');
    if (!currentStatus || currentStatus === 'not attempted' || currentStatus === 'browsed') {
      api.LMSSetValue('cmi.core.lesson_status', 'incomplete');
      hasUncommittedWrites = true;
      commit({ force: true });
    }
    adoptPreviousResult(currentStatus);
    return true;
  }

  console.error('[SCORM] LMSInitialize failed:', api.LMSGetLastError());
  previewMode = true;
  initialized = true;
  return false;
}

/**
 * Take over the result the LMS already holds, so a returning student cannot
 * have a pass or a best score downgraded by a later failed Check.
 * @param {string} status
 */
function adoptPreviousResult(status) {
  const raw = api.LMSGetValue('cmi.core.score.raw');
  const parsed = Number(raw);
  if (String(raw ?? '').trim() !== '' && Number.isFinite(parsed)) {
    bestScore = clampScore(parsed);
  }
  if (status === 'passed' || status === 'completed') {
    hasPassed = true;
  }
}

/**
 * Re-open the SCORM session after the browser restored this page from the
 * back/forward cache. The page instance survives that trip, but its session
 * may already have been finished, in which case the LMS silently ignores every
 * later write.
 * @returns {boolean} true when a live session is available
 */
export function resume() {
  if (isConnected()) return true;
  if (previewMode || !api) return false;

  const result = api.LMSInitialize('');
  if (result !== 'true' && result !== true) {
    console.warn('[SCORM] Could not resume the LMS session:', api.LMSGetLastError());
    return false;
  }

  initialized = true;
  hasUncommittedWrites = false;
  return true;
}

/**
 * Set the lesson status.
 * @param {'passed'|'failed'|'completed'|'incomplete'} status
 */
export function setStatus(status) {
  if (!initialized) return;

  if (previewMode) {
    console.log(`[SCORM Preview] Status: ${status}`);
    return;
  }

  api.LMSSetValue('cmi.core.lesson_status', status);
  hasUncommittedWrites = true;
  commit({ force: true });
}

/**
 * Persist the result of a Check and set status based on the pass threshold.
 * Both values are sent in a single commit, which is pushed out immediately:
 * a Check is a deliberate action and each commit is one blocking round-trip.
 *
 * The session keeps its best result. A student who passes and then keeps
 * experimenting must not lose the pass - or the grade - because a later Check
 * failed, which is also how Moodle's recommended "highest grade" method reads
 * the data. The best score of earlier sessions is adopted on init.
 *
 * @param {number} score - 0-100
 * @param {number} passingScore - Minimum score to pass (default 50)
 */
export function reportScore(score, passingScore = 50) {
  if (!initialized) return;

  if (previewMode) {
    const clamped = clampScore(score);
    console.log(`[SCORM Preview] Score: ${clamped} → ${clamped >= passingScore ? 'passed' : 'failed'}`);
    return;
  }

  const clamped = clampScore(score);
  const effective = bestScore === null ? clamped : Math.max(bestScore, clamped);
  bestScore = effective;

  const passed = effective >= passingScore || hasPassed;
  if (passed) {
    hasPassed = true;
  }

  writeScore(effective);
  api.LMSSetValue('cmi.core.lesson_status', passed ? 'passed' : 'failed');
  commit({ force: true });
}

/**
 * Check whether the SCORM session is live and can accept writes.
 * @returns {boolean}
 */
export function isSessionActive() {
  return isConnected();
}

/**
 * Read the LMS user id for the current student.
 * Used to scope browser-side storage to one student per device.
 * @returns {string}
 */
export function getStudentId() {
  if (!isConnected()) return '';

  const value = api.LMSGetValue('cmi.core.student_id');
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Read the suspend data string saved by a previous session.
 * @returns {string} Empty string when nothing is stored or no LMS is connected
 */
export function getSuspendData() {
  if (!isConnected()) return '';

  const value = api.LMSGetValue('cmi.suspend_data');
  return typeof value === 'string' ? value : '';
}

/**
 * Store suspend data for the next session.
 * The value is visible to the LMS immediately; the server write is coalesced
 * so that editing does not commit on every pause.
 * @param {string} value
 * @returns {boolean} true when the LMS accepted the value
 */
export function setSuspendData(value) {
  if (!isConnected()) {
    console.log('[SCORM Preview] Suspend data not stored (no LMS)');
    return false;
  }

  const result = api.LMSSetValue('cmi.suspend_data', String(value));
  const accepted = result === 'true' || result === true;
  if (accepted) {
    hasUncommittedWrites = true;
    commit();
  } else {
    console.warn('[SCORM] LMS rejected suspend data:', api.LMSGetLastError());
  }
  return accepted;
}

/**
 * Discard stored suspend data so the next session starts clean.
 * @returns {boolean} true when the LMS accepted the empty value
 */
export function clearSuspendData() {
  if (!isConnected()) return false;

  const result = api.LMSSetValue('cmi.suspend_data', '');
  const accepted = result === 'true' || result === true;
  if (accepted) {
    hasUncommittedWrites = true;
    commit();
  }
  return accepted;
}

/**
 * Save and end the SCORM session.
 * Pending writes are flushed first; `LMSFinish` stores the whole data model
 * itself, but not every runtime can be relied on to do that.
 */
export function terminate() {
  if (!initialized) return;

  if (previewMode) {
    console.log('[SCORM Preview] Session terminated');
    return;
  }

  commit({ force: true });
  api.LMSFinish('');
  initialized = false;
  hasUncommittedWrites = false;
}

/**
 * Check if running in preview mode (no LMS).
 * @returns {boolean}
 */
export function isPreviewMode() {
  return previewMode;
}

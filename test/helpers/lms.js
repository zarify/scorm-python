/**
 * A fake SCORM 1.2 runtime shaped like Moodle's.
 *
 * Two properties of the real thing drive most of the edge cases we care about:
 * `LMSSetValue` only changes the in-memory data model (so a value can be read
 * back before it reaches the server), and `LMSCommit` is the server round-trip,
 * which Moodle performs with a synchronous XHR — every commit freezes the tab.
 *
 * `LMSSetValue` can be told to fail or to truncate, which is how a real LMS
 * behaves when a value exceeds the field limit (SCORM 1.2 suspend_data is
 * 4096 characters).
 */

const SUSPEND_DATA_KEY = 'cmi.suspend_data';

export function createLms({
  initializeResult = 'true',
  suspendDataLimit = null,
  rejectSuspendData = false,
  rejectAllWrites = false,
} = {}) {
  const model = new Map();
  const calls = [];
  const commits = [];
  const rejected = [];

  const record = (method, args) => {
    calls.push({ method, args });
  };

  const api = {
    LMSInitialize() {
      record('LMSInitialize', []);
      return initializeResult;
    },
    LMSGetValue(key) {
      record('LMSGetValue', [key]);
      return model.has(key) ? model.get(key) : '';
    },
    LMSSetValue(key, value) {
      record('LMSSetValue', [key, value]);
      const rejectedWrite = rejectAllWrites
        || (key === SUSPEND_DATA_KEY && rejectSuspendData);
      if (rejectedWrite) {
        rejected.push({ key, value });
        return 'false';
      }
      const text = String(value);
      model.set(
        key,
        key === SUSPEND_DATA_KEY && suspendDataLimit !== null
          ? text.slice(0, suspendDataLimit)
          : text,
      );
      return 'true';
    },
    LMSCommit() {
      record('LMSCommit', []);
      commits.push(Object.fromEntries(model));
      return 'true';
    },
    LMSFinish() {
      record('LMSFinish', []);
      return 'true';
    },
    LMSGetLastError() {
      return '0';
    },
    LMSGetErrorString() {
      return 'No error';
    },
    LMSGetDiagnostic() {
      return '';
    },
  };

  return {
    api,
    /** Current LMS-side data model. */
    model,
    /** Every API call in order, for asserting on write and commit behaviour. */
    calls,
    /** Data model snapshots, one per commit. */
    commits,
    /** Writes the fake LMS refused. */
    rejected,
    callsOf(method) {
      return calls.filter((call) => call.method === method);
    },
    valueOf(key) {
      return model.get(key) ?? '';
    },
  };
}

/**
 * Install a fake LMS as the frame the wrapper searches from.
 *
 * `findAPI` walks `window.parent` up to seven levels and then `window.opener`,
 * so a top-level frame with `API` on it is the closest thing to Moodle's SCORM
 * player from the package's point of view. `depth` nests the API that many
 * frames above the page, which is what an iframe-embedded package looks like.
 */
export function installLms({ depth = 0, ...options } = {}) {
  const lms = createLms(options);
  const previousWindow = globalThis.window;

  let top = { API: lms.api, parent: null, opener: null };
  top.parent = top;

  let current = top;
  for (let level = 0; level < depth; level += 1) {
    current = { API: null, parent: current, opener: null };
  }
  globalThis.window = current;

  return {
    ...lms,
    window: current,
    restore() {
      globalThis.window = previousWindow;
    },
  };
}

/** Install a window with no LMS reachable, which puts the runtime in preview mode. */
export function installNoLms() {
  const previousWindow = globalThis.window;
  const fakeWindow = { parent: null, opener: null };
  fakeWindow.parent = fakeWindow;
  globalThis.window = fakeWindow;
  return {
    window: fakeWindow,
    restore() {
      globalThis.window = previousWindow;
    },
  };
}

/**
 * Python Engine — owns the Pyodide worker lifecycle and the watchdog layers.
 *
 * Layered interruption (Moodle gives us no COOP/COEP for SharedArrayBuffer):
 *   1. Python watchdog (trace event budget + soft wall clock) — fast, precise,
 *      sees only Python-level execution;
 *   2. JS hard deadlines — check mode: absolute deadline from the run post
 *      (covers C-level hangs no trace can see, e.g. `sum(range(10**12))`);
 *      run mode: a silence watchdog that resets on every stdout/stderr message
 *      and while an input dialog is parked;
 *   3. `terminate()` + lazy respawn — the Stop button always terminates
 *      unconditionally; after any terminate the next ready()/run/analyze
 *      spawns a fresh worker and re-inits (status: loading → ready).
 *
 * Asset resolution is anchored on the script that loaded this bundle
 * (`document.currentScript` captured at module evaluation — app.bundle.js or
 * builder.bundle.js). Some SCORM viewers re-host the bundle through a blob URL,
 * which cannot serve as the base for relative URLs; in that case we fall back
 * to the document's real package base and reconstruct the bundle URL there.
 * The worker sits next to the bundle as `python-worker.js` and the default
 * Pyodide runtime one level up at `../pyodide/`, which resolves identically in
 * the SCORM dist, the builder dist, and the builder's srcdoc preview iframe.
 */

export const CHECK_PY_SOFT_MS = 3000;
export const CHECK_JS_DEADLINE_MS = 5000;
export const RUN_PY_SOFT_MS = 15000;
export const RUN_JS_SILENCE_MS = 20000;
export const MAX_TRACE_EVENTS = 10_000_000;
export const MAX_OUTPUT_CHARS = 1_000_000;
export const RECURSION_LIMIT = 500;
export const MAX_INPUT_ATTEMPTS = 100;

const TIMEOUT_MESSAGE = 'Execution timed out (possible infinite loop)';

const APP_SCRIPT_BASE = resolveBundleUrl();

function resolveBundleUrl() {
  if (typeof document === 'undefined') return '';

  const candidates = [];
  if (document.currentScript?.src) {
    candidates.push(document.currentScript.src);
  }

  for (const script of Array.from(document.scripts || [])) {
    if (typeof script?.src === 'string' && script.src) {
      candidates.push(script.src);
    }
  }

  const bundlePattern = /(?:^|\/)(?:app|builder)\.bundle\.js(?:[?#].*)?$/;
  const preferred = candidates.find((candidate) => bundlePattern.test(candidate) && canResolveRelative(candidate));
  if (preferred) return preferred;

  const anyUsable = candidates.find(canResolveRelative);
  if (anyUsable) return anyUsable;

  const base = typeof document.baseURI === 'string' ? document.baseURI : '';
  if (canResolveRelative(base)) {
    const previewMode = globalThis.__BLOCKLY_SCORM_PREVIEW_MODE__ === true;
    const bundlePath = previewMode ? 'app.bundle.js' : 'js/app.bundle.js';
    return new URL(bundlePath, base).href;
  }

  return '';
}

function canResolveRelative(candidate) {
  if (!candidate) return false;
  try {
    new URL('.', candidate);
    return true;
  } catch {
    return false;
  }
}

function normalizeBaseUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.endsWith('/') ? text : `${text}/`;
}

function timeoutResult(attempt) {
  return {
    status: 'timeout',
    attempt,
    stdout: '',
    prompts: [],
    promptDiagnostics: null,
    variables: {},
    functions: {},
    functionCalls: [],
    files: {},
    scopedFunction: null,
    error: { type: 'TimeoutError', message: TIMEOUT_MESSAGE, traceback: '', line: null },
    syntaxError: null,
    seed: 0,
    friendly: TIMEOUT_MESSAGE,
  };
}

function inputLimitResult(attempt) {
  const message = 'Your program asked for input too many times and was stopped.';
  return {
    status: 'error',
    attempt,
    stdout: '',
    prompts: [],
    promptDiagnostics: null,
    variables: {},
    functions: {},
    functionCalls: [],
    files: {},
    scopedFunction: null,
    error: { type: 'RuntimeError', message, traceback: '', line: null },
    syntaxError: null,
    seed: 0,
    friendly: message,
  };
}

/**
 * Create an engine bound to one activity configuration.
 * @param {{ onStatus?: (state: 'loading'|'ready'|'error', detail?: string) => void,
 *           pythonSetup?: { pyodide_base_url?: string, packages?: string[] },
 *           assetBaseUrl?: string }} options
 */
export function createPythonEngine({ onStatus = () => {}, pythonSetup = {}, assetBaseUrl = '' } = {}) {
  const previewMode = globalThis.__BLOCKLY_SCORM_PREVIEW_MODE__ === true;
  const runtimeBaseUrl = normalizeBaseUrl(assetBaseUrl);
  const indexURL = normalizeBaseUrl(pythonSetup.pyodide_base_url)
    || resolveDefaultPyodideUrl({ previewMode, runtimeBaseUrl });
  const workerUrl = resolveWorkerUrl({ previewMode, runtimeBaseUrl });
  const packages = Array.isArray(pythonSetup.packages) ? pythonSetup.packages : [];

  let worker = null;
  let ready = false;
  let initWaiters = null;
  let nextId = 0;
  const ops = new Map();
  let activeRun = null;

  function onWorkerFailure(message) {
    const text = message || 'Python worker error';
    onStatus('error', text);
    const waiters = initWaiters;
    initWaiters = null;
    ready = false;
    destroyWorker();
    if (waiters) {
      waiters.reject(new Error(text));
    }
  }

  function destroyWorker() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
    ready = false;
    // Every pending op must settle — a dead worker answers nothing.
    for (const op of [...ops.values()]) {
      ops.delete(op.id);
      op.onDestroyed?.();
    }
  }

  function handleMessage(event) {
    const message = event.data || {};

    if (message.kind === 'ready') {
      ready = true;
      onStatus('ready');
      const waiters = initWaiters;
      initWaiters = null;
      waiters?.resolve();
      return;
    }
    if (message.kind === 'load-error') {
      onWorkerFailure(message.message);
      return;
    }

    const op = ops.get(message.id);
    if (!op) return; // stale id — cancelled or already settled

    switch (message.kind) {
      case 'stdout':
      case 'stderr':
        op.onStream?.(message.text);
        return;
      case 'result':
        op.deliver?.({ type: 'result', result: message.result });
        return;
      case 'need-input':
        op.deliver?.({ type: 'need-input', prompt: message.prompt, seed: message.seed });
        return;
      case 'analysis':
        op.deliver?.({ type: 'analysis', results: message.results, syntaxError: message.syntaxError });
        return;
      case 'validated':
        op.deliver?.({ type: 'validated', errors: message.errors });
        return;
      default:
    }
  }

  function ensureLoaded() {
    if (ready) return Promise.resolve();
    if (initWaiters) return initWaiters.promise;
    onStatus('loading');
    const waiters = {};
    waiters.promise = new Promise((resolve, reject) => {
      waiters.resolve = resolve;
      waiters.reject = reject;
    });
    initWaiters = waiters;
    try {
      worker = new Worker(workerUrl, { type: 'module' });
    } catch (err) {
      initWaiters = null;
      onWorkerFailure(err instanceof Error ? err.message : String(err));
      return waiters.promise;
    }

    worker.onmessage = handleMessage;
    worker.onerror = (event) => onWorkerFailure(event?.message || 'Python worker failed to load');
    worker.postMessage({ kind: 'init', indexURL, packages });
    return waiters.promise;
  }

  function registerOp(op) {
    ops.set(op.id, op);
    return () => {
      ops.delete(op.id);
    };
  }

  async function run({ source, files = [], promptInputs = [], capture = {}, mode, hooks = {} }) {
    await ensureLoaded();

    const softWallMs = mode === 'check' ? CHECK_PY_SOFT_MS : RUN_PY_SOFT_MS;
    const specBase = {
      source,
      mode,
      files,
      capture,
      limits: {
        max_trace_events: MAX_TRACE_EVENTS,
        soft_wall_ms: softWallMs,
        recursion_limit: RECURSION_LIMIT,
        max_output_chars: MAX_OUTPUT_CHARS,
      },
    };

    const id = ++nextId;
    const op = { id, destroyed: false };
    const unregister = registerOp(op);
    let rejectOuter;
    const outer = new Promise((resolve, reject) => {
      rejectOuter = reject;
      op.finish = (value) => {
        if (op.settled) return;
        op.settled = true;
        unregister();
        activeRun = null;
        resolve(value);
      };
      op.fail = (err) => {
        if (op.settled) return;
        op.settled = true;
        unregister();
        activeRun = null;
        reject(err);
      };
    });
    activeRun = op;

    let checkTimer = null;
    let silenceTimer = null;
    const clearTimers = () => {
      if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    };
    op.onDestroyed = () => {
      clearTimers();
      op.pendingResolve?.({ type: 'destroyed' });
      if (!op.terminating) op.fail({ cancelled: true });
    };
    op.deliver = (outcome) => op.pendingResolve?.(outcome);

    const runLoop = (async () => {
      let inputs = [...promptInputs];
      let seed;

      for (let attempt = 1; attempt <= MAX_INPUT_ATTEMPTS; attempt += 1) {
        if (op.settled) return undefined;
        const spec = { ...specBase, prompt_inputs: inputs, attempt };
        if (seed !== undefined) spec.seed = seed;

        const outcome = await new Promise((resolve) => {
          const settle = (value) => {
            op.pendingResolve = null;
            clearTimers();
            resolve(value);
          };
          op.pendingResolve = settle;
          op.onStream = (text) => {
            if (mode === 'run') {
              if (silenceTimer) clearTimeout(silenceTimer);
              silenceTimer = setTimeout(onSilence, RUN_JS_SILENCE_MS);
            }
            hooks.onStdout?.(text, attempt);
          };

          const onSilence = () => {
            // Terminate only after this outcome is delivered, and skip the
            // cancellation path in onDestroyed — the run finishes with the
            // timeout result instead.
            op.terminating = true;
            settle({ type: 'timeout', result: timeoutResult(attempt) });
            destroyWorker();
          };

          if (mode === 'check') {
            checkTimer = setTimeout(onSilence, CHECK_JS_DEADLINE_MS);
          } else if (mode === 'run') {
            silenceTimer = setTimeout(onSilence, RUN_JS_SILENCE_MS);
          }

          worker.postMessage({ kind: 'run', id, attempt, spec });
        });

        if (op.settled) return undefined;

        if (outcome.type === 'destroyed') {
          return undefined; // cancelled or terminated; outer already settled
        }
        if (outcome.type === 'timeout') {
          op.finish(outcome.result);
          return undefined;
        }
        if (outcome.type === 'need-input') {
          if (mode !== 'run') {
            op.fail(new Error('Unexpected need-input in check mode'));
            return undefined;
          }
          // Ask the page (dialog), then replay the whole program with the
          // accumulated answers. Timers are already cleared by settle().
          const answer = await hooks.onInputNeeded?.(outcome.prompt);
          if (answer === null || answer === undefined) {
            cancel();
            op.fail({ cancelled: true });
            return undefined;
          }
          if (op.settled) return undefined;
          worker.postMessage({
            kind: 'input-response', id, attempt, value: String(answer),
          });
          inputs = [...inputs, String(answer)];
          if (seed === undefined && typeof outcome.seed === 'number') {
            seed = outcome.seed; // keep the session's RNG stable across replays
          }
          continue;
        }
        if (outcome.type === 'result') {
          op.finish(outcome.result);
          return undefined;
        }
        // Unreachable protocol state — fail loudly rather than spin.
        op.fail(new Error(`Unexpected worker outcome: ${outcome.type}`));
        return undefined;
      }

      const result = inputLimitResult(MAX_INPUT_ATTEMPTS);
      op.finish(result);
      return undefined;
    })();

    runLoop.catch((err) => op.fail(err));
    return outer;
  }

  async function analyze({ source, conditions }) {
    await ensureLoaded();
    const id = ++nextId;
    const op = { id };
    const unregister = registerOp(op);
    const promise = new Promise((resolve, reject) => {
      op.deliver = (outcome) => {
        unregister();
        if (outcome.type === 'analysis') {
          resolve({ results: outcome.results, syntaxError: outcome.syntaxError });
        } else {
          reject(new Error('Analysis interrupted'));
        }
      };
      op.onDestroyed = () => {
        unregister();
        reject({ cancelled: true });
      };
    });
    if (!worker) {
      unregister();
      throw new Error('Python worker unavailable');
    }
    worker.postMessage({ kind: 'analyze', id, spec: { source, conditions } });
    return promise;
  }

  async function validatePatterns({ patterns }) {
    await ensureLoaded();
    const id = ++nextId;
    const op = { id };
    const unregister = registerOp(op);
    const promise = new Promise((resolve, reject) => {
      op.deliver = (outcome) => {
        unregister();
        if (outcome.type === 'validated') {
          resolve(outcome.errors);
        } else {
          reject(new Error('Pattern validation interrupted'));
        }
      };
      op.onDestroyed = () => {
        unregister();
        reject({ cancelled: true });
      };
    });
    if (!worker) {
      unregister();
      throw new Error('Python worker unavailable');
    }
    worker.postMessage({ kind: 'validate', id, spec: { patterns } });
    return promise;
  }

  function cancel() {
    if (activeRun && worker && ops.has(activeRun.id)) {
      worker.postMessage({ kind: 'cancel', id: activeRun.id });
    }
    // The Stop button terminates unconditionally — a worker parked in Python
    // cannot receive the cancel message until its current run returns.
    destroyWorker();
  }

  function dispose() {
    destroyWorker();
    const waiters = initWaiters;
    initWaiters = null;
    waiters?.reject({ cancelled: true });
  }

  return {
    ready: () => ensureLoaded(),
    run,
    analyze,
    validatePatterns,
    cancel,
    dispose,
  };
}

function resolveDefaultPyodideUrl({ previewMode, runtimeBaseUrl }) {
  if (runtimeBaseUrl) {
    const relative = previewMode ? '../pyodide/' : 'pyodide/';
    return new URL(relative, runtimeBaseUrl).href;
  }
  return new URL('../pyodide/', APP_SCRIPT_BASE).href;
}

function resolveWorkerUrl({ previewMode, runtimeBaseUrl }) {
  if (runtimeBaseUrl) {
    const relative = previewMode ? 'python-worker.js' : 'js/python-worker.js';
    return new URL(relative, runtimeBaseUrl).href;
  }
  return new URL('python-worker.js', APP_SCRIPT_BASE).href;
}

/**
 * Pyodide module worker — owns the Python runtime and speaks a correlated
 * message protocol with python-engine.js.
 *
 * No module-scope Pyodide import: `indexURL` arrives in the `init` message so
 * the bundled runtime (`pyodide/` next to this file's parent directory) and an
 * author-supplied `pyodide_base_url` both work. The Python sources
 * (`../python/astmatch.py`, `../python/harness.py`) are fetched relative to
 * `import.meta.url`, which keeps this file portable across the SCORM dist, the
 * builder dist, and the builder's srcdoc preview.
 *
 * Main → worker: {kind:"init", indexURL, packages} |
 *   {kind:"run", id, attempt, spec} | {kind:"analyze", id, spec} |
 *   {kind:"validate", id, spec} | {kind:"input-response", id, attempt, value} |
 *   {kind:"cancel", id}
 * Worker → main: {kind:"ready"} | {kind:"load-error", message} |
 *   {kind:"stdout"|"stderr", id, attempt, text} |
 *   {kind:"result", id, attempt, result} |
 *   {kind:"need-input", id, attempt, prompt} |
 *   {kind:"analysis", id, results, syntaxError} |
 *   {kind:"validated", id, errors}
 *
 * The worker never auto-replays: after `need-input` it waits for the engine to
 * post a fresh `run` (attempt + 1) carrying the full accumulated prompt queue.
 */

let pyodideInstance = null;
let harnessModule = null;
let initPromise = null;
let initError = null;

/** Op currently executing — stdout/stderr callbacks tag messages with it. */
let currentOp = null;
/** Open need-input exchange, awaiting the engine's next `run` or an ack. */
let awaitingInput = null;
/** Ids the engine cancelled; results for them are dropped as stale. */
const cancelledIds = new Set();

function post(message) {
  self.postMessage(message);
}

function failLoad(err) {
  initError = err instanceof Error ? err.message : String(err);
  post({ kind: 'load-error', message: initError });
}

function installWasmStreamingFallback() {
  if (self.__PYODIDE_WASM_STREAMING_FALLBACK__) return;
  self.__PYODIDE_WASM_STREAMING_FALLBACK__ = true;

  const originalInstantiateStreaming = WebAssembly.instantiateStreaming?.bind(WebAssembly);
  if (originalInstantiateStreaming) {
    WebAssembly.instantiateStreaming = async (source, imports) => {
      try {
        return await originalInstantiateStreaming(source, imports);
      } catch (err) {
        const response = await Promise.resolve(source);
        if (!(response instanceof Response)) throw err;
        const bytes = await response.arrayBuffer();
        return WebAssembly.instantiate(bytes, imports);
      }
    };
  }

  const originalCompileStreaming = WebAssembly.compileStreaming?.bind(WebAssembly);
  if (originalCompileStreaming) {
    WebAssembly.compileStreaming = async (source) => {
      try {
        return await originalCompileStreaming(source);
      } catch (err) {
        const response = await Promise.resolve(source);
        if (!(response instanceof Response)) throw err;
        const bytes = await response.arrayBuffer();
        return WebAssembly.compile(bytes);
      }
    };
  }
}

function ensureInitialized(indexURL, packages) {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // Some SCORM viewers serve .wasm as application/octet-stream. Pyodide
    // prefers streaming compilation, but we can fall back to bytes cleanly.
    installWasmStreamingFallback();
    const module = await import(`${indexURL}pyodide.mjs`);
    const py = await module.loadPyodide({ indexURL });

    if (Array.isArray(packages) && packages.length > 0) {
      await py.loadPackage(packages);
    }

    py.FS.mkdir('/app');
    const sources = ['astmatch.py', 'harness.py'];
    await Promise.all(sources.map(async (name) => {
      const response = await fetch(new URL(`../python/${name}`, import.meta.url));
      if (!response.ok) {
        throw new Error(`Failed to fetch ../python/${name} (HTTP ${response.status})`);
      }
      py.FS.writeFile(`/app/${name}`, await response.text());
    }));
    py.runPython('import sys; sys.path.insert(0, "/app")');
    py.runPython('import harness');

    // Pyodide's stream callbacks may deliver str or Uint8Array bytes (314
    // delivers bytes) — normalize before posting. write() MUST return the
    // number of bytes consumed or pyodide warns and re-delivers the chunk.
    const toText = (chunk) => {
      if (typeof chunk === 'string') return chunk;
      if (chunk instanceof Uint8Array) return new TextDecoder().decode(chunk);
      return String(chunk);
    };
    const encoder = new TextEncoder();

    py.setStdout({
      write(chunk) {
        if (currentOp) {
          post({
            kind: 'stdout',
            id: currentOp.id,
            attempt: currentOp.attempt,
            text: toText(chunk),
          });
        }
        return typeof chunk === 'string' ? encoder.encode(chunk).length : chunk.byteLength ?? 0;
      },
    });
    py.setStderr({
      write(chunk) {
        if (currentOp) {
          post({
            kind: 'stderr',
            id: currentOp.id,
            attempt: currentOp.attempt,
            text: toText(chunk),
          });
        }
        return typeof chunk === 'string' ? encoder.encode(chunk).length : chunk.byteLength ?? 0;
      },
    });

    pyodideInstance = py;
    harnessModule = py.pyimport('harness');
    post({ kind: 'ready' });
  })().catch((err) => {
    failLoad(err);
    throw err;
  });
  return initPromise;
}

function isStale(id) {
  return cancelledIds.has(id);
}

function runOp(id, attempt, spec) {
  if (isStale(id)) return;
  currentOp = { id, attempt };
  try {
    const result = JSON.parse(
      harnessModule.run(JSON.stringify({ ...spec, attempt })),
    );
    if (isStale(id)) return;
    if (result.status === 'need-input') {
      const prompts = Array.isArray(result.prompts) ? result.prompts : [];
      const lastPrompt = prompts.length > 0 ? prompts[prompts.length - 1] : null;
      awaitingInput = { id, attempt };
      post({
        kind: 'need-input',
        id,
        attempt,
        prompt: lastPrompt ? lastPrompt.message : '',
        seed: result.seed,
      });
      return;
    }
    post({ kind: 'result', id, attempt, result });
  } catch (err) {
    // harness.run never raises by contract; if the runtime itself broke,
    // surface a synthetic error result instead of hanging the engine.
    post({
      kind: 'result',
      id,
      attempt,
      result: {
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
        error: {
          type: 'RuntimeError',
          message: err instanceof Error ? err.message : String(err),
          traceback: '',
          line: null,
        },
        syntaxError: null,
        seed: 0,
      },
    });
  } finally {
    currentOp = null;
  }
}

self.onmessage = (event) => {
  const message = event.data || {};

  switch (message.kind) {
    case 'init': {
      if (initError) {
        post({ kind: 'load-error', message: initError });
        return;
      }
      ensureInitialized(message.indexURL, Array.isArray(message.packages) ? message.packages : [])
        .catch(() => {}); // failure already reported via load-error
      return;
    }

    case 'run': {
      const { id, attempt, spec } = message;
      (async () => {
        await ensureInitialized('', []);
        runOp(id, attempt, spec);
      })().catch(() => {});
      return;
    }

    case 'analyze': {
      const { id, spec } = message;
      (async () => {
        await ensureInitialized('', []);
        if (isStale(id)) return;
        const parsed = JSON.parse(harnessModule.analyze(JSON.stringify(spec)));
        post({
          kind: 'analysis',
          id,
          results: parsed.results || {},
          syntaxError: parsed.syntaxError || null,
        });
      })().catch((err) => {
        post({
          kind: 'analysis',
          id,
          results: {},
          syntaxError: { message: err instanceof Error ? err.message : String(err), line: null },
        });
      });
      return;
    }

    case 'validate': {
      const { id, spec } = message;
      (async () => {
        await ensureInitialized('', []);
        if (isStale(id)) return;
        const parsed = JSON.parse(harnessModule.validate_patterns(JSON.stringify(spec)));
        post({ kind: 'validated', id, errors: parsed.errors || {} });
      })().catch(() => {
        post({ kind: 'validated', id, errors: {} });
      });
      return;
    }

    case 'input-response': {
      // Acknowledgement only — replay is driven by the engine's next `run`.
      if (awaitingInput && awaitingInput.id === message.id) {
        awaitingInput = null;
      }
      return;
    }

    case 'cancel': {
      cancelledIds.add(message.id);
      if (awaitingInput && awaitingInput.id === message.id) {
        awaitingInput = null;
      }
      return;
    }

    default:
      return;
  }
};

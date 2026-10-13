import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const DRIVER_PATH = fileURLToPath(new URL('./harness-driver.py', import.meta.url));
const MAX_TRACE_EVENTS = 10_000_000;
const MAX_OUTPUT_CHARS = 1_000_000;
const RECURSION_LIMIT = 500;

export function createHarnessEngine() {
  const child = spawn('python3', ['-u', DRIVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  let stderr = '';
  let closed = false;

  function rejectPending(error) {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }

  lines.on('line', (line) => {
    let response;
    try {
      response = JSON.parse(line);
    } catch (error) {
      rejectPending(new Error(`Invalid harness response: ${line}`, { cause: error }));
      return;
    }
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if (response.error) request.reject(new Error(response.error));
    else request.resolve(response.result);
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8192);
  });
  child.once('error', (error) => rejectPending(error));
  child.once('exit', (code, signal) => {
    if (pending.size > 0) {
      rejectPending(new Error(
        `Harness process exited (${signal || code})${stderr ? `: ${stderr}` : ''}`,
      ));
    }
  });

  function request(op, spec) {
    if (closed) return Promise.reject(new Error('Harness engine is closed'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, op, spec })}\n`, (error) => {
        if (!error) return;
        pending.delete(id);
        reject(error);
      });
    });
  }

  return {
    async run({ source, mode = 'check', files = [], promptInputs = [], capture = {} }) {
      return request('run', {
        source,
        mode,
        attempt: 1,
        files,
        prompt_inputs: promptInputs,
        capture,
        limits: {
          max_trace_events: MAX_TRACE_EVENTS,
          soft_wall_ms: mode === 'check' ? 3_000 : 15_000,
          recursion_limit: RECURSION_LIMIT,
          max_output_chars: MAX_OUTPUT_CHARS,
        },
      });
    },

    analyze({ source, conditions }) {
      return request('analyze', { source, conditions });
    },

    async validatePatterns(patterns) {
      const entries = patterns.map((pattern) => ({ key: pattern, pattern }));
      const result = await request('validate_patterns', { patterns: entries });
      const errors = {};
      for (const pattern of patterns) errors[pattern] = result.errors?.[pattern] || '';
      return { errors };
    },

    close() {
      if (closed) return;
      closed = true;
      rejectPending(new Error('Harness engine was closed'));
      lines.close();
      child.kill();
    },
  };
}

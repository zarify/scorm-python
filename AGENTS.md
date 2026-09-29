# Repository Guidelines

## Project Overview

`scorm-python` is a config-driven **SCORM 1.2 activity engine for Python** on Moodle plus a
browser-based **Activity Builder**. Students write Python in a CodeMirror 6 editor; their code
runs client-side in **Pyodide 314.0.7 (CPython 3.14)** inside a module Web Worker with layered
watchdogs (trace budget, wall clock, JS deadlines, worker terminate + lazy respawn), captured
stdio, `input()` via a bottom-docked prompt bar + whole-program replay, and file I/O in
Pyodide's in-memory filesystem. Authors define starter code, seeded files, hints, and
points-based tests in one
`activity_config.json`; structural checks are **AST patterns** (Python source with wildcards)
and regexes, graded client-side and reported through SCORM 1.2.

This directory is the **project root** for all future work — run every command from
`scorm-python/`. It is a port of the sibling `../scorm-blockly` project (Blockly → source
code); when a ported file's behavior is unclear, read the reference there first.

## Architecture & Data Flow

```
activity_config.json → validateConfig → normalizeConfig → student app (app.js)
  ├─ CodeMirror editor ─ debounced {code} → suspend_data (BS1| codec) + IndexedDB
  ├─ Run   → executeInteractiveRun → engine.run(mode:'run') → worker → harness.run →
  │          stdout stream / need-input dialog / replay with accumulated prompt_inputs
  ├─ Check → runTests → engine.run(mode:'check') (deduped plans)
  │          + ONE engine.analyze per Check (code_structure + syntax short-circuit)
  │          → scores → scormWrapper.reportScore(lmsScore, allPassed)
  └─ Hints → hint-engine batches triggered conditions into ONE engine.analyze →
             evaluateHints(hints, state, event, evaluateCondition)
```

Four layers:

1. **Shared config layer** — `src/shared/`: `activity-config.schema.json`,
   `config-validator.js` (accumulates `{path, message}`, never throws), `config-normalizer.js`
   (defaults, drops unknown keys), `test-config.js` (getter defaults the runner depends on),
   `hint-evaluator.js` (pure, async condition injection), `inline-markdown.js`.
2. **Python worker** — `src/shared/python-worker.js` (protocol endpoint) +
   `src/shared/python/astmatch.py` (pattern matcher) + `src/shared/python/harness.py`
   (execution, captures, watchdog). Runs inside Pyodide **and** under local `python3`.
3. **Student runtime** — `src/scorm-template/`: `app.js` (orchestration),
   `python-engine.js` (worker lifecycle, watchdogs, replay loop), `test-runner.js`
   (assertions, plan dedupe, score assembly), `hint-engine.js`, `scorm-wrapper.js`,
   two-layer persistence (`workspace-persistence.js` + `workspace-state-codec.js`).
4. **Activity Builder** — `src/activity-builder/`: `builder-app.js` (state, tabs, export
   gate), `config/code/hints/tests/preview/export` tabs, shared `condition-builder.js`,
   `list-reorder.js`.

Build/serve: `scripts/build.js` (esbuild IIFE bundles + asset copies),
`scripts/dev.js` (watch + serve :3000), `scripts/export-scorm.js` (zip), 
`scripts/fetch-pyodide.js` (vendored runtime).

### Core patterns (must follow)

- **Worker↔engine protocol** (`python-worker.js` header documents both directions): every
  message carries `id` correlation; `need-input` carries `prompt` **and `seed`**; the worker
  **never auto-replays** — the engine re-posts `run` with attempt+1 and the full accumulated
  `prompt_inputs`; `cancel` marks ids stale; after any `terminate()` the next operation
  respawns and re-inits (status `loading → ready`).
- **Harness JSON in / JSON out** — no PyProxy ever crosses the boundary. Result keys are the
  plan's contract: `status ∈ {done, need-input, syntax_error, forbidden_import, loop_budget,
  timeout, output_limit, error}`, `promptDiagnostics.{configuredInputCount,promptCallCount,
  usedProvidedCount,underflowCount,unusedInputCount}`, tagged values `{t, v}`.
- **Asset layout**: each dist tree is `<root>/js/…` with siblings `<root>/python/` and
  `<root>/pyodide/`. The worker resolves `../python/` and `../pyodide/` relative to
  `import.meta.url`; the engine anchors the worker URL and default indexURL on
  `document.currentScript` captured at bundle evaluation — **do not switch to
  `document.baseURI`**, it breaks the srcdoc preview (and the SCORM page).
- **Bundles are classic IIFE scripts** (`globalName: PythonScorm` / `ActivityBuilder`): the
  currentScript capture and top-level `var` global both depend on synchronous classic-script
  evaluation. Don't change `format: 'iife'` or add `type="module"` to the script tags.
- **`runtime-assets.js` carries five keys** (`appBundleJs`, `styleCss`, `workerJs`,
  `astmatchPy`, `harnessPy`) so SCORM export works from `file://`. `scripts/build.js` and
  `scripts/dev.js` both write it — keep them identical; a stale two-key version breaks export
  with "SCORM runtime assets are unavailable".
- **suspend_data payload is `{code: string}`** (format `BS1|<activity>|<format>|<ts>|<data>`),
  never a Blockly workspace. The validator rejects legacy keys (`weight`, `expected_output`,
  top-level `match_mode`, `type` comparison) and unknown condition types — don't reintroduce
  aliases.
- **Conditions are exactly six types**: `ast_pattern`, `source_regex` (Python `re`),
  `source_empty`, `all`/`any`/`none`. AST patterns are parsed by `astmatch.py`;
  `...` is only valid as a statement or a call argument; `def name(...)` (stub-style
  params) is rewritten before parsing — CPython rejects `...` as a parameter list;
  a bare `_` matches any expression in expression position and any statement in
  statement position (so a `_` loop body matches `pass`).
- **Syntax errors narrow, not blank, the analyzer**: text-only conditions
  (`source_regex`/`source_empty`, or composites of only those) evaluate against the
  raw source while the file does not parse; conditions containing an `ast_pattern`
  report the SyntaxError until it parses. Graded `code_structure` tests still fail
  on unparseable code (`assertCodeStructure` short-circuits on `syntaxError`).
- **Input replay**: `input()` with an empty queue in run mode raises `need-input`; the whole
  program re-runs. The session seed arrives via `need-input.seed` and is passed back as
  `spec.seed` so `random` stays stable across attempts. `input()` prompts go to the **console
  stream and the prompts log, never the asserted stdout transcript** — exact `stdout_match`
  assertions stay prompt-free (scorm-blockly parity).
- **Watchdog constants live once** in `python-engine.js` (`CHECK_PY_SOFT_MS`,
  `CHECK_JS_DEADLINE_MS`, `RUN_PY_SOFT_MS`, `RUN_JS_SILENCE_MS`, `MAX_TRACE_EVENTS`,
  `MAX_OUTPUT_CHARS`, `RECURSION_LIMIT`) and reach Python via `spec.limits` — mirror, don't
  duplicate, in the harness.
- **Pyodide pin**: `PYODIDE_VERSION` in `scripts/fetch-pyodide.js` only. Never bump without
  re-running `test-py/` and the browser suite (314 stream callbacks deliver `Uint8Array`, and
  `setStdout.write` must return the **byte count** or Pyodide warns and re-delivers chunks).
- **The test static server must serve `.mjs` as `text/javascript` and `.wasm` as
  `application/wasm`** (`test/browser/helpers/harness.js`) — module scripts and streaming
  compilation reject wrong MIME types.

## Key Directories

| Path | Purpose |
|---|---|
| `src/shared/` | Config layer + worker + the two Python sources (`python/astmatch.py`, `python/harness.py`) |
| `src/scorm-template/` | Student runtime (bundled to `dist/scorm-template/`) |
| `src/activity-builder/` | Activity Builder (bundled to `dist/activity-builder/`) |
| `scripts/` | `build.js`, `dev.js`, `export-scorm.js`, `fetch-pyodide.js` |
| `examples/` | `hello-world.json`, `greet-input.json`, `csv-average.json` — all must pass `validateConfig` |
| `test/` | Node suites (`node --test "test/*.test.js"`) + `test/browser/` Playwright scenarios |
| `test/browser/helpers/` | Static server (MIME-aware), browser launcher with skip-when-no-Chrome, mock SCORM API |
| `test-py/` | Python unittest suites for matcher + harness |
| `vendor/pyodide/` | Pinned runtime (gitignored; produced by `fetch-pyodide.js`) |
| `dist/` | Build output (gitignored): `scorm-template/`, `activity-builder/` |

## Development Commands

```bash
npm install                      # Node ≥ 20 (approve esbuild's install script if prompted)
node scripts/fetch-pyodide.js    # one networked fetch of the pinned runtime (also runs on build)
npm run build                    # both dist trees + runtime-assets + pyodide-manifest
npm run build:scorm              # student package only
npm run build:builder            # builder only
npm run export                   # dist/scorm-template → dist/<activity_id>.zip (honors pyodide_base_url skip rule)
npm run dev                      # watch + serve the builder at http://localhost:3000
npm test                         # Node suite
npm run test:python              # Python suite (needs python3 ≥ 3.11)
npm run test:browser             # full build + browser scenarios (needs Chrome/Chromium)
node --test test/<file>.test.js  # one suite
```

## Code Conventions

- ESM everywhere (`"type": "module"`); esbuild IIFE bundles, `target: es2020`, minified for
  production builds; sourcemaps only in dev.
- No linters, formatters, typecheckers, or CI are configured — don't add tooling ad hoc;
  verify with the four suites above.
- Deps are intentionally minimal: runtime `codemirror`, `@codemirror/lang-python`,
  `@codemirror/view`; dev `esbuild`, `jszip`, `playwright`. No npm `pyodide` package.
- Ports preserve scorm-blockly's structure, error-message wording, and CSS class names unless
  the plan changed the field — diffs against the reference should be explainable.
- Snake_case in Python, camelCase in JS config payloads (schema keys are snake_case; engine
  messages and diagnostics are camelCase — both are contracts, don't rename either side).
- DOM ids referenced by tests are contracts (`#cfg-title`, `#starter-code-editor`,
   `#hint-condition-host .cond-pattern`, `#test-output-expected`, `#input-dialog`, …) —
  renaming one means updating `test/browser/`.

## Important Files

- `package.json` — all scripts; the entry points above.
- `src/scorm-template/js/python-engine.js` — worker lifecycle, watchdogs, replay loop,
  timeout-result synthesis. The most invariant-dense file.
- `src/shared/python-worker.js` — protocol endpoint; init/ready/load-error, run/analyze/
  validate, stdout byte normalization.
- `src/shared/python/harness.py` — run/analyze/validate_patterns JSON APIs, FS reset per
  attempt, forbidden imports, trace watchdog, tagged encoding.
- `src/shared/python/astmatch.py` — the AST pattern language (module docstring is the spec).
- `src/scorm-template/js/test-runner.js` — assertions, deduped execution plans, CSV/file
  evaluation, score/feedback assembly.
- `src/shared/config-validator.js` + `config-normalizer.js` + `test-config.js` — the config
  contract the builder and runtime share.
- `scripts/build.js` / `scripts/dev.js` — must stay in sync on runtime-assets and copies.
- `README.md` — canonical reference: config field tables, AST pattern language, architecture,
  limitations. Update it when behavior or sizes change (bundled zip ~7 MB, external ~0.2 MB).

## Testing & QA

- Three suites plus browser scenarios; **all four must be green** before handing work back:
  `npm test` (230), `npm run test:python` (84), `npm run build && npm run export` (both modes),
  `npm run test:browser` (25 across 9 files).
- Browser tests **skip** (not fail) when no Chrome/Chromium launches; `PLAYWRIGHT_CHANNEL`
  overrides the channel. They drive the real Pyodide runtime against a mock LMS
  (`test/browser/helpers/mock-lms.js`, localStorage-backed `window.API`).
- Convention: Node tests are `test/<module>.test.js` using `node:test` + `node:assert/strict`;
  Python tests are `unittest` classes in `test-py/` that `sys.path.insert` the shared python
  dir. Fixtures come from `test/helpers/config.js` (`activityConfig()`, `deepMerge`).
- `examples/*.json` are acceptance fixtures — they must validate clean and stay loadable by
  the browser suite; edit them only alongside the tests that consume them.
- Reference sibling: `../scorm-blockly/test/` holds the original suites a port came from —
  when behavior is in doubt, compare against them rather than inventing new semantics.

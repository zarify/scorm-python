# scorm-python

A config-driven **SCORM 1.2 activity engine for Python** on Moodle, with a browser-based
Activity Builder. Students write Python in a CodeMirror 6 editor; their code runs
client-side in **Pyodide 314.0.7 (CPython 3.14)** inside a module Web Worker with
interruptible loops, captured stdio, `input()` support, and file I/O in Pyodide's
in-memory filesystem. Authors define starter code, files, hints, and points-based tests
in a JSON config — no programming required on the authoring side.

A sibling project (`scorm-blockly`) provides the same engine for Blockly; this port
replaces block dragging with source code and structural **AST pattern checks**.

## Quick Start

```bash
npm install                    # Node ≥ 20
node scripts/fetch-pyodide.js  # one networked fetch of the pinned runtime (also runs on build)
npm run build                  # dist/scorm-template + dist/activity-builder
npm run dev                    # builder at http://localhost:3000
```

Then open the builder, write an activity, hit **Preview**, and **Export SCORM** for a
Moodle-uploadable `.zip`. Requirements: Node ≥ 20, Python ≥ 3.11 for the local test
suite, network for the first Pyodide fetch (cached in `vendor/pyodide/`).

## Commands

| Command | What it does |
| --- | --- |
| `npm run build` | Build the SCORM package and the activity builder into `dist/` |
| `npm run build:scorm` | Build only `dist/scorm-template/` |
| `npm run build:builder` | Build only `dist/activity-builder/` |
| `npm run export` | Zip `dist/scorm-template/` → `dist/<activity_id>.zip` |
| `npm run dev` | Watch + serve the builder on port 3000 |
| `npm test` | Node test suite (validator, normalizer, test-config, hint evaluator, codec, SCORM wrapper, inline markdown) |
| `npm run test:python` | Python unittest suite for the AST matcher and execution harness (`test-py/`) |
| `npm run test:browser` | Full build + nine Playwright end-to-end scenarios driving the real Pyodide runtime |

## Workflow

The builder has six tabs:

1. **Config** — metadata (title auto-generates the activity ID), instructions, UI
   settings (`show_hint_panel`, `suspend_data_limit`), results behavior.
2. **Code** — starter code (CodeMirror), activity files seeded into the student's
   working directory (text or base64 binary), the optional Pillow package, and the
   Pyodide base URL (remembered in this browser).
3. **Hints** — trigger-based hints (`code_change` / `test_fail` / `manual`) with
   delay, priority, checklist/triggered display, and a condition editor.
4. **Tests** — five test types (below), points, feedback, per-test setup files.
5. **Preview** — the real student runtime in an iframe (requires HTTP).
6. **Export** — validation + JSON / SCORM export (SCORM validates every AST pattern
   first).

## Project Structure

```
src/shared/               schema, validator, normalizer, test-config, hint evaluator,
                          inline markdown, the module worker, and the Python sources
                          (python/astmatch.py, python/harness.py)
src/scorm-template/       the student runtime: index.html, style.css, app.js,
                          python-engine.js, test-runner.js, hint-engine.js,
                          scorm-wrapper.js, two-layer persistence
src/activity-builder/     the authoring tool: config/code/hints/tests/preview/export tabs,
                          condition-builder.js
scripts/                  build.js, dev.js, export-scorm.js, fetch-pyodide.js
examples/                 hello-world.json, greet-input.json, csv-average.json
test/                     Node test suites (+ test/browser/ Playwright scenarios)
test-py/                  Python unittest suites
vendor/pyodide/           pinned runtime (gitignored, produced by fetch-pyodide.js)
```

## Activity Config reference

Top level: `metadata`*, `instructions`, `ui_settings`, `python_setup`*, `hints`,
`evaluation`* (*required).

### metadata
`activity_id` (`^[a-z0-9_]+$`), `title`*, `version`, `description`.

### ui_settings
| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `show_hint_panel` | bool | `true` | Show the student hint panel |
| `suspend_data_limit` | int ≥ 512 | `4096` | `cmi.suspend_data` budget; larger code falls back to IndexedDB |

### python_setup
| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `starter_code` | string | `""` | Editor value on open/reset |
| `files` | array | `[]` | `{path, content}` or `{path, content_base64}`; path `^[A-Za-z0-9_./-]+$`, no leading `/`, no `..`, ≤ 256 chars, ≤ 50 files, ≤ 262144 chars each |
| `packages` | array | `[]` | Only `"pillow"` ships |
| `pyodide_base_url` | string | `""` | Empty = runtime bundled in the export; non-empty = absolute `http(s)` URL serving the pinned file set with CORS |

### hints[]
`id`, `message`, `display_mode` (`triggered`\|`checklist`), `priority` (≥1, higher wins),
`delay_seconds`, `show_once`, `style` (`success`\|`warning`\|`error`), and
`trigger`: `event` (`code_change`\|`test_fail`\|`manual`; `conditions` required for
`code_change`), `after_attempts`, `invalidate_on_condition_false`.

### Conditions (six types)

| Type | Fields | Meaning |
| --- | --- | --- |
| `ast_pattern` | `pattern`, `min_count` (≥1, default 1), `max_count` (optional, ≥ min) | Count AST matches of a Python-source pattern |
| `source_regex` | `pattern`, `case_sensitive` (default true), `regex_flags` (chars from `ims`) | `re.search` over the raw source |
| `source_empty` | — | Passes when the editor is empty/whitespace |
| `all` / `any` / `none` | `conditions` (≥1 child) | AND / OR / NOT over child conditions |

Unknown condition types are rejected with `Unknown condition type '<x>'`.

### evaluation
`require_previous_test_pass` (default `true` — later tests lock until earlier ones
pass), `feedback_on_all_pass`, `test_cases`* (≥1). Score is always the points ratio:
`lmsScore = round(total / max × 100)`.

Common test fields: `id`, `type`, `points` ≥ 0, `feedback_on_pass`, `feedback_on_fail`.

| Type | Key fields |
| --- | --- |
| `stdout_match` | `output_assertion` `{enabled, expected, match_mode exact\|contains\|regex, show_expected, show_actual, success_message, failure_message}`, `prompt_assertion` (same + `match_any_item`), `prompt_inputs`, `strict_prompt_inputs`, `execution_context` `{scope main\|function, function_name, arguments}`, `setup_files` |
| `code_structure` | `conditions` (one condition object; evaluated without executing) |
| `variable_state` | `variable_name`, `expected_type` (`any\|int\|float\|bool\|string\|list\|tuple\|dict\|null`), value assertion (`comparison: equals\|gt\|lt\|gte\|lte\|contains`), `list_assertions` (length/values/item types/index checks), `prompt_inputs`, `strict_prompt_inputs`, `setup_files` |
| `function_state` | `function_name`, `parameter_count` + `parameter_count_enabled`, `return_assertion` (arguments, expected type/value, list assertions, show flags, messages), `setup_files` |
| `file_state` | `path`, `exists` (default true), `format` (`text\|csv\|binary`), `content_assertion` (text), `csv_assertions` `{row_count, row_count_comparison, header, cells[{row, column, expected_value, comparison, expected_type}]}`, `prompt_inputs`, `strict_prompt_inputs`, `setup_files` |

`setup_files` merge over `python_setup.files` per test (test entry wins on path
collision). Every executing test type shares one deduplicated execution plan per
`{promptInputs, files, captures}` tuple; `code_structure` and hint conditions batch
into a single `analyze` call per Check.

## AST Pattern Language

A pattern is **Python source** parsed with `ast.parse` (module mode) that must contain
at least one statement.

**Wildcards**

- `_` (bare underscore name in expression position) matches **any single expression**;
  it never binds.
- `_name` (e.g. `_x`, `_total` — `^_[A-Za-z0-9][A-Za-z0-9_]*$`) is a **named
  wildcard**: first occurrence binds the matched subtree; every later occurrence in the
  same match attempt must be equal. A student `Name` binds its **identifier**, so
  `_x = ...` + `print(_x)` enforces *same variable*. Bindings are scoped to one match
  attempt.
- `...` (Ellipsis) **as a statement** matches **zero or more statements**; **in a call's
  argument list** it matches **zero or more mixed positional/keyword arguments**.
  Anywhere else it is an invalid pattern.

**Matching**: all other nodes must match the same AST class recursively; source
positions and `ctx` are ignored; constants compare with value **and** exact type
(`1` does not match `1.0`). Function/class definition names accept `_`/`_name`
wildcards, and the stub-style header `def _(...): ...` matches any parameter list
(rewritten before parsing — plain CPython rejects `...` as parameters).

**Modes**: a single bare expression statement (e.g. `print(...)`) matches **every
expression node** in the student's tree; anything else matches **statement sequences**
at every offset of every statement list (module body and all `body`/`orelse`/`finalbody`
lists), non-overlapping leftmost-first, summed.

Worked examples:

```python
for _ in _: ...                 # any for-loop (any target, any iterable, any body)
_x = input(...)                 # some variable read via input()
...\nprint(_x)                  # print of the SAME variable read earlier (with the
                                # assignment pattern + ... between them)
print(...)                      # a print call anywhere — x = print(1) included
for _ in _:\n    ...\nprint(...)\n    ...   # loops that contain a print
def _(...): ...                 # any function definition
```

Invalid patterns (bad syntax, `...` outside statement/call-arg position) raise a
`PatternError` with line/column text and are reported by the builder's **✓ Validate**
button before export.

## Architecture

- **Config-driven runtime** — `activity_config.json` fully describes the activity;
  the student page fetches, validates, and normalizes it at boot.
- **Module-worker protocol** — `python-engine.js` owns one Web Worker; messages are
  `{kind, id, …}`-correlated (`init/run/analyze/validate/input-response/cancel` →
  `ready/load-error/stdout/stderr/result/need-input/analysis/validated`). Python runs
  synchronously inside the worker; `pyodide.setStdout/setStderr` callbacks stream
  output back with the current attempt number.
- **Replay input** — `input()` with an exhausted queue in run mode raises `need-input`;
  the page shows a dialog and the **whole program re-runs** with the accumulated
  answers, reseeding `random` from the first attempt's seed. Caveat: wall-clock-driven
  code (`time.time()`, `datetime.now()`) can diverge between attempts — avoid
  time-dependent logic in interactive activities.
- **Watchdogs (layered interruption)** — Python: `sys.settrace` event budget
  (`max_trace_events`) + soft wall clock (`soft_wall_ms`, 3 s check / 15 s run).
  JS: a 5 s hard deadline in check mode (catches C-level hangs) and a 20 s silence
  watchdog in run mode (suspended while an input dialog is open). Stop terminates the
  worker outright; the next operation lazily respawns and re-inits. SharedArrayBuffer
  interrupts are unavailable on Moodle (no COOP/COEP control), hence this design.
- **Two-layer persistence** — `cmi.suspend_data` (4096 chars by default, ASCII-safe
  `BS1|…` codec with base64/LZW paths) holds the newest `{code}` snapshot that fits;
  IndexedDB keeps the full-fidelity copy. Restores pick the newest complete snapshot.
- **SCORM 1.2** — score (`cmi.core.score.raw`), lesson status, and suspend data with
  write verification and automatic limit fallback.
- **Export modes** — *bundled*: the zip carries `pyodide/` (~7 MB) and works
  offline with zero configuration; *external URL*: set `python_setup.pyodide_base_url`
  and the zip drops `pyodide/` (~1 MB), loading the pinned runtime from that URL
  instead (must serve these exact files with CORS headers; jsDelivr does).

## Limitations

- **Client-side grading** — tests run in the student's browser; a determined student
  can edit them. Suitable for formative practice, not proctored assessment.
- **No true sandbox** — Pyodide blocks network access and the harness rejects
  dangerous imports (`socket`, `js`, `subprocess`, …), but this is a guardrail, not a
  security boundary.
- **Replay determinism** — interactive input replays the program; `random` is reseeded
  per session, but wall-clock-dependent behavior may differ between attempts.
- **Builder needs HTTP** — Python preview and AST-pattern validation require
  `npm run dev`; from `file://` you can still edit config, export JSON, and export
  SCORM for pattern-free activities.
- **Bundled export size** — the default bundled zip is ~7 MB (0.2 MB with an external URL); Moodle's `maxbytes` must
  allow uploads that large.
- **Timeouts are wall-clock** — a program busy-waiting on `time.sleep`-style behavior
  or pure computation is stopped by the watchdogs above; C-level hangs can only be
  stopped by the JS deadline or the Stop button.
- **`os.write(1, …)` bypasses the transcript** — assertions see `print`/`sys.stdout`
  output only; raw fd writes reach the console but are not asserted.
- **CSV files are read as UTF-8** — undecodable files fail `file_state` content checks
  with an explicit decode error rather than a mismatch.

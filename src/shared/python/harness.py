"""Execution harness for student Python programs.

Runs inside Pyodide (CPython 3.14) in the activity's module Web Worker, and
under local CPython for the unit-test suite. Every public entry point takes a
JSON string and returns a JSON string — no PyProxy ever crosses the boundary.

Public API
----------
``run(spec_json) -> str``
    Execute student source under limits, with file seeding, a prompt-input
    queue, stdio capture, and post-run captures. Result JSON:

    ``{status, attempt, stdout, prompts, promptDiagnostics, variables,
    functions, functionCalls, files, scopedFunction, error, syntaxError, seed}``

    where ``status ∈ {done, need-input, syntax_error, forbidden_import,
    loop_budget, timeout, output_limit, error}``.

``analyze(spec_json) -> str``
    Parse once and evaluate ``{key, condition}`` entries via astmatch;
    a syntax error fails every key instead of crashing mid-typing.

``validate_patterns(spec_json) -> str``
    ``{patterns: [{key, pattern}]}`` → ``{errors: {key: message | null}}``.

Execution sequence: reset the filesystem and seed files (per attempt, so
replays never accumulate files) → forbidden-import check → syntax check →
limits (recursion cap, seeded RNG, trace watchdog) → stdio wrappers →
``input()`` override → ``exec`` → captures.

Watchdog: ``sys.settrace`` counts events only in ``<student.py>`` frames and
raises past ``limits.max_trace_events`` or ``limits.soft_wall_ms`` (wall clock
checked every 1024 student events). C-level hangs are the JavaScript
watchdogs' job — Python cannot see them.

stdio: stdout and stderr writes go to one per-attempt transcript (byte-for-byte
what CPython would produce — ``print("Hi")`` appends ``"Hi\\n"``) and pass
through to the original streams so the worker can stream them to the console.
``os.write(1, …)`` bypasses the wrapper: visible on the console, not in the
transcript. ``input()`` prompts go to the original stdout and the prompts log —
not the transcript — keeping stdout assertions prompt-free (scorm-blockly
parity).
"""

import ast
import base64
import builtins
import inspect
import io
import json
import linecache
import os
import random
import shutil
import sys
import tempfile
import time
import traceback
import warnings
import zlib

import astmatch

__all__ = ["run", "analyze", "validate_patterns"]

STUDENT_FILENAME = "<student.py>"
WORKDIR_DEFAULT = "/home/pyodide/work"
WORKDIR_ENV = "SCORM_HARNESS_WORKDIR"

FORBIDDEN_IMPORTS = frozenset({
    "pyodide", "js", "_pyodide_base", "pyodide_http",
    "socket", "ssl", "urllib", "http", "requests", "httpx", "aiohttp",
    "subprocess", "multiprocessing", "ctypes", "webbrowser",
})

MAX_OUTPUT_CHARS = 1_000_000
RECURSION_LIMIT = 500
DEFAULT_MAX_TRACE_EVENTS = 10_000_000
SOFT_WALL_MS_CHECK = 3_000
SOFT_WALL_MS_RUN = 15_000

MAX_SAFE_INT = 2**53 - 1
STRING_CAP = 100_000
SEQUENCE_CAP = 1000
REPR_CAP = 500


class NeedInput(Exception):
    """Raised by input() in run mode when the queue is empty."""

    def __init__(self, message=""):
        super().__init__(message)
        self.message = message


class BudgetExceeded(Exception):
    def __init__(self, kind):
        super().__init__(kind)
        self.kind = kind  # 'events' | 'wall'


class OutputLimit(Exception):
    pass


class SpecError(Exception):
    """Invalid run spec (bad file path, bad mode, …)."""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def run(spec_json):
    try:
        spec = json.loads(spec_json)
        if not isinstance(spec, dict):
            raise SpecError("run spec must be a JSON object")
    except (json.JSONDecodeError, SpecError) as exc:
        return json.dumps(_error_result("error", "ValueError", str(exc), 1, 0))

    try:
        result = _run_spec(spec)
    except SpecError as exc:
        result = _error_result(
            "error", "ValueError", str(exc),
            _spec_int(spec, "attempt", 1), _derive_seed(spec),
        )
    except Exception as exc:  # harness bug or environment failure — never hang the worker
        result = _error_result(
            "error", type(exc).__name__, str(exc),
            _spec_int(spec, "attempt", 1), _derive_seed(spec),
        )
    return json.dumps(result, ensure_ascii=False)


def analyze(spec_json):
    try:
        spec = json.loads(spec_json)
        if not isinstance(spec, dict):
            raise ValueError("analyze spec must be a JSON object")
        return json.dumps(_analyze_spec(spec), ensure_ascii=False)
    except (json.JSONDecodeError, ValueError) as exc:
        return json.dumps({
            "syntaxError": {"message": f"invalid analyze spec: {exc}", "line": None},
            "results": {},
        }, ensure_ascii=False)


def validate_patterns(spec_json):
    try:
        spec = json.loads(spec_json)
        patterns = spec.get("patterns") if isinstance(spec, dict) else None
        if not isinstance(patterns, list):
            raise ValueError("validate spec must contain a patterns list")
    except (json.JSONDecodeError, ValueError, AttributeError) as exc:
        return json.dumps({"errors": {}, "invalid": str(exc)}, ensure_ascii=False)

    errors = {}
    for entry in patterns:
        key = str(entry.get("key", ""))
        try:
            astmatch.validate(entry.get("pattern"))
            errors[key] = None
        except astmatch.PatternError as exc:
            errors[key] = str(exc)
        except Exception as exc:
            errors[key] = f"{type(exc).__name__}: {exc}"
    return json.dumps({"errors": errors}, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Run pipeline
# ---------------------------------------------------------------------------

def _run_spec(spec):
    source = spec.get("source")
    if not isinstance(source, str):
        raise SpecError("run spec.source must be a string")
    mode = spec.get("mode", "run")
    if mode not in ("run", "check"):
        raise SpecError("run spec.mode must be 'run' or 'check'")
    files = spec.get("files") or []
    prompt_inputs = [str(value) for value in spec.get("prompt_inputs") or []]
    capture = spec.get("capture") if isinstance(spec.get("capture"), dict) else {}
    limits = spec.get("limits") if isinstance(spec.get("limits"), dict) else {}
    attempt = _spec_int(spec, "attempt", 1)
    seed = spec["seed"] if isinstance(spec.get("seed"), int) and not isinstance(spec.get("seed"), bool) else _derive_seed(source, prompt_inputs)

    # 1. Filesystem: fresh workdir + seeded files, every attempt.
    reset_fs(files)

    # 2/3. Parse once: syntax errors beat everything; then the import blocklist.
    try:
        tree = ast.parse(source, filename=STUDENT_FILENAME)
    except SyntaxError as exc:
        return _empty_result(
            status="syntax_error",
            attempt=attempt,
            seed=seed,
            prompt_inputs=prompt_inputs,
            syntax_error={
                "message": exc.msg,
                "line": exc.lineno,
                "offset": exc.offset,
            },
        )

    offender = _find_forbidden_import(tree)
    if offender is not None:
        module, lineno = offender
        return _empty_result(
            status="forbidden_import",
            attempt=attempt,
            seed=seed,
            prompt_inputs=prompt_inputs,
            error={
                "type": "ImportError",
                "message": f"Import of '{module}' is not allowed in this activity",
                "traceback": "",
                "line": lineno,
            },
        )

    return _execute(source, tree, mode, prompt_inputs, capture, limits, attempt, seed)


def _execute(source, tree, mode, prompt_inputs, capture, limits, attempt, seed):
    soft_wall_ms = _spec_int(limits, "soft_wall_ms", SOFT_WALL_MS_CHECK if mode == "check" else SOFT_WALL_MS_RUN)
    max_events = _spec_int(limits, "max_trace_events", DEFAULT_MAX_TRACE_EVENTS)

    state = _RunState(mode=mode, queue=list(prompt_inputs), soft_wall_ms=soft_wall_ms, max_events=max_events)
    globals_dict = {"__name__": "__main__"}
    status = "done"
    error = None
    syntax_error = None

    _cache_student_source(source)
    prev_cwd = os.getcwd()
    orig_out, orig_err, orig_in = sys.stdout, sys.stderr, sys.stdin
    orig_input = builtins.input
    prev_trace = sys.gettrace()
    prev_recursion = sys.getrecursionlimit()
    prev_warning_filters = warnings.filters[:]

    # Unclosed files are idiomatic in beginner code; ambient warning config
    # (unittest, dev mode) must not leak ResourceWarnings into the transcript.
    warnings.filterwarnings("ignore", category=ResourceWarning)
    sys.setrecursionlimit(RECURSION_LIMIT)
    random.seed(seed)
    builtins.input = _make_input(state, orig_out)

    try:
        sys.stdout = _TranscriptStream(state, orig_out, "stdout")
        sys.stderr = _TranscriptStream(state, orig_err, "stderr")
        sys.stdin = _QueueStdin(state)
        sys.settrace(_make_tracer(state))
        state.started = time.monotonic()
        try:
            exec(compile(source, STUDENT_FILENAME, "exec"), globals_dict)
        except NeedInput:
            # The unanswered call was logged by next_response; the replay
            # re-runs the whole program with the answer appended.
            status = "need-input"
        except BudgetExceeded as exc:
            if exc.kind == "events":
                status = "loop_budget"
                friendly = "Your program ran too long (possible infinite loop) and was stopped."
            else:
                status = "timeout"
                friendly = "Your program ran too long and was stopped."
            error = {"type": "RuntimeError", "message": friendly, "traceback": "", "line": None}
        except OutputLimit:
            status = "output_limit"
            error = {
                "type": "RuntimeError",
                "message": "Your program printed too much output and was stopped.",
                "traceback": "",
                "line": None,
            }
        except SystemExit:
            status = "done"
        except SyntaxError as exc:
            status = "syntax_error"
            syntax_error = {"message": exc.msg, "line": exc.lineno, "offset": exc.offset}
        except Exception as exc:
            status = "error"
            error = _runtime_error(exc, state)
        finally:
            sys.settrace(prev_trace)

        # Captures run while the working directory is still the seeded workdir.
        captures = _capture(capture, globals_dict, state, status)
    finally:
        sys.stdout = orig_out
        sys.stderr = orig_err
        sys.stdin = orig_in
        builtins.input = orig_input
        sys.setrecursionlimit(prev_recursion)
        sys.settrace(prev_trace)
        warnings.filters[:] = prev_warning_filters
        try:
            os.chdir(prev_cwd)
        except OSError:
            pass

    return {
        "status": status,
        "attempt": attempt,
        "stdout": state.stdout_text(),
        "prompts": [dict(entry) for entry in state.prompts],
        "promptDiagnostics": state.diagnostics(len(prompt_inputs)),
        "variables": captures["variables"],
        "functions": captures["functions"],
        "functionCalls": captures["functionCalls"],
        "files": captures["files"],
        "scopedFunction": captures["scopedFunction"],
        "error": error,
        "syntaxError": syntax_error,
        "seed": seed,
    }


# ---------------------------------------------------------------------------
# Filesystem
# ---------------------------------------------------------------------------

_fallback_workdir = None


def _workdir():
    override = os.environ.get(WORKDIR_ENV)
    if override:
        return override
    global _fallback_workdir
    try:
        os.makedirs(WORKDIR_DEFAULT, exist_ok=True)
        probe = os.path.join(WORKDIR_DEFAULT, ".write-probe")
        with open(probe, "wb") as handle:
            handle.write(b"x")
        os.remove(probe)
        return WORKDIR_DEFAULT
    except OSError:
        if _fallback_workdir is None:
            _fallback_workdir = tempfile.mkdtemp(prefix="scorm-harness-")
        return _fallback_workdir


def _validate_relative_path(path):
    if not isinstance(path, str) or not path or path.startswith("/") or os.path.isabs(path):
        raise SpecError(f"Invalid file path (must be relative): {path!r}")
    if ".." in path.split("/"):
        raise SpecError(f"Invalid file path (no '..' segments): {path!r}")
    if "\x00" in path:
        raise SpecError("Invalid file path (null byte)")


def reset_fs(files):
    workdir = _workdir()
    if os.path.islink(workdir):
        os.unlink(workdir)
    elif os.path.isdir(workdir):
        shutil.rmtree(workdir, ignore_errors=True)
    os.makedirs(workdir, exist_ok=True)
    os.chdir(workdir)

    for entry in files:
        path = entry.get("path")
        _validate_relative_path(path)
        target = os.path.join(workdir, path)
        parent = os.path.dirname(target)
        if parent:
            os.makedirs(parent, exist_ok=True)
        if isinstance(entry.get("content"), str):
            data = entry["content"].encode("utf-8")
        elif isinstance(entry.get("content_base64"), str):
            try:
                data = base64.b64decode(entry["content_base64"], validate=True)
            except Exception as exc:
                raise SpecError(f"Invalid base64 content for {path}: {exc}") from exc
        else:
            data = b""
        with open(target, "wb") as handle:
            handle.write(data)
    _snapshot_seeded_files()


def _read_paths(read_paths):
    files = {}
    for path in read_paths:
        try:
            _validate_relative_path(path)
        except SpecError as exc:
            files[str(path)] = {
                "exists": False, "size": 0, "text": None,
                "decode_error": str(exc), "modified": False,
            }
            continue
        record = {"exists": False, "size": 0, "text": None, "decode_error": None, "modified": False}
        if os.path.isfile(path):
            record["exists"] = True
            try:
                with open(path, "rb") as handle:
                    data = handle.read()
            except OSError as exc:
                record["decode_error"] = f"{type(exc).__name__}: {exc}"
                files[path] = record
                continue
            record["size"] = len(data)
            try:
                record["text"] = data.decode("utf-8")
            except UnicodeDecodeError as exc:
                record["decode_error"] = f"{type(exc).__name__}: {exc}"
            stat = os.stat(path)
            seeded = _SEEDED_SNAPSHOT.get(os.path.abspath(path))
            record["modified"] = seeded is None or seeded != (stat.st_size, stat.st_mtime_ns)
        files[path] = record
    return files


_SEEDED_SNAPSHOT = {}


def _snapshot_seeded_files():
    _SEEDED_SNAPSHOT.clear()
    for root, _dirs, names in os.walk(os.getcwd()):
        for name in names:
            path = os.path.abspath(os.path.join(root, name))
            try:
                stat = os.stat(path)
            except OSError:
                continue
            _SEEDED_SNAPSHOT[path] = (stat.st_size, stat.st_mtime_ns)


# ---------------------------------------------------------------------------
# Imports, limits, watchdog
# ---------------------------------------------------------------------------

def _find_forbidden_import(tree):
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".")[0]
                if top in FORBIDDEN_IMPORTS:
                    return top, node.lineno
        elif isinstance(node, ast.ImportFrom):
            # Relative and absolute imports are checked the same way.
            name = node.module or ""
            top = name.split(".")[0] if name else ""
            if top in FORBIDDEN_IMPORTS:
                return top, node.lineno
    return None


def _make_tracer(state):
    def tracer(frame, event, arg):
        if frame.f_code.co_filename != STUDENT_FILENAME:
            return None
        state.events += 1
        if state.events > state.max_events:
            raise BudgetExceeded("events")
        if state.events % 1024 == 0 and (
            time.monotonic() - state.started
        ) * 1000.0 > state.soft_wall_ms:
            raise BudgetExceeded("wall")
        return tracer

    return tracer


def _cache_student_source(source):
    linecache.cache[STUDENT_FILENAME] = (
        len(source), None, source.splitlines(True), STUDENT_FILENAME
    )


def _runtime_error(exc, state):
    frames = [
        frame for frame in traceback.extract_tb(exc.__traceback__)
        if frame.filename == STUDENT_FILENAME
    ]
    lines = []
    for frame in frames:
        lines.append(f'  File "{STUDENT_FILENAME}", line {frame.lineno}, in {frame.name}')
        if frame.line:
            lines.append(f"    {frame.line.rstrip()}")
    lines.append(f"{type(exc).__name__}: {exc}")
    return {
        "type": type(exc).__name__,
        "message": str(exc),
        "traceback": "\n".join(lines),
        "line": frames[-1].lineno if frames else None,
    }


# ---------------------------------------------------------------------------
# State, stdio, input
# ---------------------------------------------------------------------------

class _RunState:
    def __init__(self, mode, queue, soft_wall_ms, max_events):
        self.mode = mode
        self.queue = list(queue)
        self.soft_wall_ms = soft_wall_ms
        self.max_events = max_events
        self.started = time.monotonic()
        self.events = 0
        self.transcript = []
        self.output_chars = 0
        self.prompts = []
        self.prompt_calls = 0
        self.used_provided = 0

    def append_output(self, text):
        if not text:
            return
        self.transcript.append(text)
        self.output_chars += len(text)
        if self.output_chars > MAX_OUTPUT_CHARS:
            raise OutputLimit()

    def stdout_text(self):
        return "".join(self.transcript)

    def log_prompt(self, message, response, used_provided):
        self.prompts.append({
            "message": message,
            "response": response,
            "usedProvided": used_provided,
        })

    def next_response(self, message):
        self.prompt_calls += 1
        if self.queue:
            response = self.queue.pop(0)
            self.log_prompt(message, response, True)
            self.used_provided += 1
            return response
        if self.mode == "run":
            # Logged as an unanswered call; the replay answers it next attempt.
            self.log_prompt(message, "", False)
            raise NeedInput(message)
        self.log_prompt(message, "", False)
        return ""

    def diagnostics(self, configured):
        underflow = max(0, self.prompt_calls - self.used_provided)
        return {
            "configuredInputCount": max(0, configured),
            "promptCallCount": max(0, self.prompt_calls),
            "usedProvidedCount": max(0, self.used_provided),
            "underflowCount": underflow,
            "unusedInputCount": max(0, configured - self.used_provided),
        }


class _TranscriptStream(io.TextIOBase):
    def __init__(self, state, original, name):
        self._state = state
        self._original = original
        self._name = name

    @property
    def name(self):
        return self._name

    @property
    def encoding(self):
        return "utf-8"

    def writable(self):
        return True

    def write(self, text):
        if not isinstance(text, str):
            text = str(text)
        self._state.append_output(text)
        try:
            self._original.write(text)
            self._original.flush()
        except Exception:
            pass
        return len(text)

    def writelines(self, lines):
        for line in lines:
            self.write(line)

    def flush(self):
        try:
            self._original.flush()
        except Exception:
            pass

    def isatty(self):
        return False


class _QueueStdin(io.TextIOBase):
    def __init__(self, state):
        self._state = state

    @property
    def encoding(self):
        return "utf-8"

    def readable(self):
        return True

    def isatty(self):
        return False

    def readline(self, size=-1):
        response = self._state.next_response("")
        if size is not None and size >= 0:
            return response[:size]
        return response + "\n"


def _make_input(state, original_stdout):
    def input(prompt=""):
        text = "" if prompt is None else str(prompt)
        if text:
            # Console-only: prompts never enter the stdout transcript.
            try:
                original_stdout.write(text)
                original_stdout.flush()
            except Exception:
                pass
        return state.next_response(text)

    return input


# ---------------------------------------------------------------------------
# Captures
# ---------------------------------------------------------------------------

def _capture(capture, globals_dict, state, status):
    variables = {}
    for name in capture.get("variables") or []:
        if isinstance(name, str) and name in globals_dict:
            variables[name] = _tag(globals_dict[name])

    functions = {}
    for name in capture.get("functions") or []:
        if not isinstance(name, str):
            continue
        exists = name in globals_dict
        functions[name] = _describe_value(globals_dict[name]) if exists else {
            "exists": False, "is_callable": False, "param_count": None, "kind": None,
        }

    function_calls = []
    scoped_function = None
    if status == "done":
        for call in capture.get("function_calls") or []:
            function_calls.append(_invoke_call(globals_dict, call))
        scoped_spec = capture.get("scoped_function")
        if isinstance(scoped_spec, dict) and scoped_spec.get("name"):
            scoped_function = _invoke_scoped(globals_dict, scoped_spec, state)

    files = _read_paths(capture.get("read_paths") or [])

    return {
        "variables": variables,
        "functions": functions,
        "functionCalls": function_calls,
        "files": files,
        "scopedFunction": scoped_function,
    }


def _describe_value(value):
    callable_ = callable(value)
    kind = _kind_of(value)
    param_count = None
    if callable_:
        try:
            sig = inspect.signature(value)
            param_count = sum(
                1 for param in sig.parameters.values()
                if param.kind in (
                    inspect.Parameter.POSITIONAL_ONLY,
                    inspect.Parameter.POSITIONAL_OR_KEYWORD,
                    inspect.Parameter.KEYWORD_ONLY,
                )
            )
        except (TypeError, ValueError):
            param_count = None
    return {
        "exists": True,
        "is_callable": callable_,
        "param_count": param_count,
        "kind": kind,
    }


def _kind_of(value):
    if inspect.iscoroutinefunction(value):
        return "async"
    if inspect.isgeneratorfunction(value):
        return "generator"
    if inspect.isclass(value):
        return "class"
    if inspect.isfunction(value):
        return "function"
    if inspect.ismethod(value):
        return "method"
    if inspect.isbuiltin(value):
        return "builtin"
    return "other"


def _invoke_call(globals_dict, call):
    key = call.get("key")
    name = call.get("name")
    args = call.get("arguments") if isinstance(call.get("arguments"), list) else []
    failure = _callable_target_error(globals_dict, name)
    if failure is not None:
        return {"key": key, "ok": False, "error": failure}
    fn = globals_dict[name]
    try:
        value = fn(*args)
    except Exception as exc:
        return {
            "key": key, "ok": False,
            "error": {
                "type": type(exc).__name__,
                "message": str(exc),
                "line": _student_line(exc) or _definition_line(fn),
            },
        }
    return {"key": key, "ok": True, "value": _tag(value)}


def _callable_target_error(globals_dict, name):
    if not isinstance(name, str) or name not in globals_dict:
        return {
            "type": "NameError",
            "message": f"name {name!r} is not defined",
            "line": None,
        }
    value = globals_dict[name]
    if inspect.iscoroutinefunction(value):
        return {
            "type": "TypeError",
            "message": "function must be a regular function, not async",
            "line": _definition_line(value),
        }
    if not callable(value):
        return {
            "type": "TypeError",
            "message": f"'{type(value).__name__}' object is not callable",
            "line": None,
        }
    return None


def _invoke_scoped(globals_dict, spec, state):
    name = spec.get("name")
    args = spec.get("arguments") if isinstance(spec.get("arguments"), list) else []
    before_output = len(state.transcript)
    before_prompts = len(state.prompts)

    failure = _callable_target_error(globals_dict, name)
    error = None
    if failure is not None:
        ok = False
        error = f"{failure['type']}: {failure['message']}"
    else:
        ok = True
        try:
            globals_dict[name](*args)
        except Exception as exc:
            ok = False
            error = f"{type(exc).__name__}: {exc}"

    return {
        "ok": ok,
        "error": error,
        "stdout": "".join(state.transcript[before_output:]),
        "prompts": [dict(entry) for entry in state.prompts[before_prompts:]],
    }


def _student_line(exc):
    frames = [
        frame for frame in traceback.extract_tb(exc.__traceback__)
        if frame.filename == STUDENT_FILENAME
    ]
    return frames[-1].lineno if frames else None


def _definition_line(fn):
    code = getattr(fn, "__code__", None)
    return getattr(code, "co_firstlineno", None)


# ---------------------------------------------------------------------------
# Tagged value encoding
# ---------------------------------------------------------------------------

def _tag(value):
    if value is None:
        return {"t": "null"}
    if isinstance(value, bool):
        return {"t": "bool", "v": value}
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INT:
            return {"t": "int", "v": str(value)}
        return {"t": "int", "v": value}
    if isinstance(value, float):
        if value != value:
            return {"t": "float", "v": "nan"}
        if value == float("inf"):
            return {"t": "float", "v": "inf"}
        if value == float("-inf"):
            return {"t": "float", "v": "-inf"}
        return {"t": "float", "v": value}
    if isinstance(value, str):
        if len(value) > STRING_CAP:
            return {"t": "string", "v": value[:STRING_CAP], "truncated": True}
        return {"t": "string", "v": value}
    if isinstance(value, (list, tuple)):
        tag = "list" if isinstance(value, list) else "tuple"
        items = value[:SEQUENCE_CAP]
        encoded = {"t": tag, "v": [_tag(item) for item in items]}
        if len(value) > SEQUENCE_CAP:
            encoded["truncated"] = True
        return encoded
    if isinstance(value, dict):
        items = list(value.items())[:SEQUENCE_CAP]
        encoded = {
            "t": "dict",
            "v": [[_tag(key), _tag(val)] for key, val in items],
        }
        if len(value) > SEQUENCE_CAP:
            encoded["truncated"] = True
        return encoded
    try:
        text = repr(value)
    except Exception:
        text = f"<unreprable {type(value).__name__}>"
    return {"t": "other", "v": text[:REPR_CAP]}


# ---------------------------------------------------------------------------
# Result assembly helpers
# ---------------------------------------------------------------------------

def _spec_int(spec, key, default):
    value = spec.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return default
    return value


def _derive_seed(spec_or_source, prompt_inputs=None):
    if isinstance(spec_or_source, dict):
        spec = spec_or_source
        source = spec.get("source") if isinstance(spec.get("source"), str) else ""
        inputs = [str(v) for v in spec.get("prompt_inputs") or []]
    else:
        source = spec_or_source
        inputs = prompt_inputs or []
    payload = json.dumps([source, inputs], ensure_ascii=False).encode("utf-8")
    return zlib.crc32(payload)


def _empty_result(*, status, attempt, seed, prompt_inputs, error=None, syntax_error=None):
    configured = len(prompt_inputs)
    return {
        "status": status,
        "attempt": attempt,
        "stdout": "",
        "prompts": [],
        "promptDiagnostics": {
            "configuredInputCount": configured,
            "promptCallCount": 0,
            "usedProvidedCount": 0,
            "underflowCount": 0,
            "unusedInputCount": configured,
        },
        "variables": {},
        "functions": {},
        "functionCalls": [],
        "files": {},
        "scopedFunction": None,
        "error": error,
        "syntaxError": syntax_error,
        "seed": seed,
    }


def _error_result(status, error_type, message, attempt, seed):
    return _empty_result(
        status=status,
        attempt=attempt,
        seed=seed,
        prompt_inputs=[],
        error={
            "type": error_type,
            "message": message,
            "traceback": "",
            "line": None,
        },
    )


# ---------------------------------------------------------------------------
# analyze / validate
# ---------------------------------------------------------------------------

def _analyze_spec(spec):
    source = spec.get("source")
    if not isinstance(source, str):
        raise ValueError("analyze spec.source must be a string")
    conditions = spec.get("conditions")
    if not isinstance(conditions, list):
        raise ValueError("analyze spec.conditions must be a list")

    try:
        tree = ast.parse(source, filename=STUDENT_FILENAME)
    except SyntaxError as exc:
        detail = f"SyntaxError: {exc.msg} (line {exc.lineno})"
        results = {}
        for entry in conditions:
            key = str(entry.get("key", ""))
            condition = entry.get("condition")
            condition = condition if isinstance(condition, dict) else {}
            if astmatch.condition_needs_ast(condition):
                results[key] = {"passed": False, "detail": detail}
            else:
                # Text-only conditions (regex / empty checks) never touch the
                # AST — evaluate them so text hints can tick while mid-typing.
                results[key] = astmatch.evaluate_condition(None, condition, source)
        return {
            "syntaxError": {"message": exc.msg, "line": exc.lineno},
            "results": results,
        }

    results = {}
    for entry in conditions:
        key = str(entry.get("key", ""))
        condition = entry.get("condition")
        results[key] = astmatch.evaluate_condition(
            tree, condition if isinstance(condition, dict) else {}, source
        )
    return {"syntaxError": None, "results": results}

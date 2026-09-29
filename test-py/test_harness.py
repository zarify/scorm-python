"""Contract tests for the execution harness (plan Step 3)."""

import base64
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(
    0,
    os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "src", "shared", "python",
    ),
)

import harness  # noqa: E402

_WORKDIR = None


def setUpModule():
    global _WORKDIR
    _WORKDIR = tempfile.mkdtemp(prefix="scorm-harness-test-")
    os.environ["SCORM_HARNESS_WORKDIR"] = _WORKDIR


def tearDownModule():
    os.environ.pop("SCORM_HARNESS_WORKDIR", None)
    if _WORKDIR:
        shutil.rmtree(_WORKDIR, ignore_errors=True)


def run_source(source, **spec):
    payload = {"source": source, "mode": "check", **spec}
    return json.loads(harness.run(json.dumps(payload)))


class PromptDiagnosticsTests(unittest.TestCase):
    DIAGNOSTIC_KEYS = {
        "configuredInputCount", "promptCallCount", "usedProvidedCount",
        "underflowCount", "unusedInputCount",
    }

    def test_unused_inputs_are_reported(self):
        result = run_source(
            "input()",
            prompt_inputs=["a", "b"],
        )
        self.assertEqual(result["status"], "done")
        diagnostics = result["promptDiagnostics"]
        self.assertEqual(set(diagnostics), self.DIAGNOSTIC_KEYS)
        self.assertEqual(diagnostics["configuredInputCount"], 2)
        self.assertEqual(diagnostics["promptCallCount"], 1)
        self.assertEqual(diagnostics["usedProvidedCount"], 1)
        self.assertEqual(diagnostics["underflowCount"], 0)
        self.assertEqual(diagnostics["unusedInputCount"], 1)

    def test_underflow_returns_empty_string_and_counts(self):
        result = run_source(
            "first = input()\nsecond = input()\nprint(repr(first), repr(second))",
            prompt_inputs=["a"],
        )
        self.assertEqual(result["status"], "done")
        diagnostics = result["promptDiagnostics"]
        self.assertEqual(diagnostics["promptCallCount"], 2)
        self.assertEqual(diagnostics["usedProvidedCount"], 1)
        self.assertEqual(diagnostics["underflowCount"], 1)
        self.assertEqual(diagnostics["unusedInputCount"], 0)
        self.assertEqual(result["stdout"], "'a' ''\n")
        self.assertEqual(
            result["prompts"],
            [
                {"message": "", "response": "a", "usedProvided": True},
                {"message": "", "response": "", "usedProvided": False},
            ],
        )


class InteractiveInputTests(unittest.TestCase):
    def test_run_mode_raises_need_input_without_echoing_prompt(self):
        result = run_source(
            'name = input("Who? ")\nprint("hi " + name)',
            mode="run",
            prompt_inputs=[],
        )
        self.assertEqual(result["status"], "need-input")
        # The prompt goes to the console, never into the asserted transcript.
        self.assertEqual(result["stdout"], "")
        self.assertEqual(
            result["prompts"],
            [{"message": "Who? ", "response": "", "usedProvided": False}],
        )
        self.assertEqual(result["promptDiagnostics"]["underflowCount"], 1)

    def test_replay_with_answer_completes(self):
        result = run_source(
            'name = input("Who? ")\nprint("hi " + name)',
            mode="run",
            prompt_inputs=["Bob"],
        )
        self.assertEqual(result["status"], "done")
        self.assertEqual(result["stdout"], "hi Bob\n")
        self.assertEqual(
            result["prompts"],
            [{"message": "Who? ", "response": "Bob", "usedProvided": True}],
        )


class ForbiddenImportTests(unittest.TestCase):
    def test_socket_import_is_rejected(self):
        result = run_source("import socket")
        self.assertEqual(result["status"], "forbidden_import")
        self.assertEqual(
            result["error"]["message"],
            "Import of 'socket' is not allowed in this activity",
        )
        self.assertEqual(result["error"]["line"], 1)

    def test_relative_import_of_forbidden_module_is_rejected(self):
        result = run_source("from . import socket")
        self.assertNotEqual(result["status"], "done")

    def test_stdlib_activity_imports_are_allowed(self):
        result = run_source("import csv\nimport sqlite3\nimport ast\nprint('ok')")
        self.assertEqual(result["status"], "done")
        self.assertEqual(result["stdout"], "ok\n")


class SyntaxAndRuntimeErrorTests(unittest.TestCase):
    def test_syntax_error_carries_student_line(self):
        result = run_source("x = 1\ndef foo(:\n")
        self.assertEqual(result["status"], "syntax_error")
        self.assertIsNone(result["error"])
        self.assertEqual(result["syntaxError"]["line"], 2)
        self.assertTrue(result["syntaxError"]["message"])

    def test_runtime_traceback_contains_only_student_frames(self):
        result = run_source("def inner():\n    1 / 0\ninner()")
        self.assertEqual(result["status"], "error")
        error = result["error"]
        self.assertEqual(error["type"], "ZeroDivisionError")
        self.assertEqual(error["line"], 2)
        self.assertIn('File "<student.py>", line 2, in inner', error["traceback"])
        self.assertNotIn("harness.py", error["traceback"])
        self.assertIn("ZeroDivisionError:", error["traceback"])


class BudgetTests(unittest.TestCase):
    def test_event_budget_stops_infinite_loop(self):
        result = run_source(
            "while True:\n    pass",
            limits={"max_trace_events": 5000},
        )
        self.assertEqual(result["status"], "loop_budget")
        self.assertEqual(
            result["error"]["message"],
            "Your program ran too long (possible infinite loop) and was stopped.",
        )

    def test_wall_budget_stops_slow_program(self):
        result = run_source(
            "while True:\n    pass",
            limits={"soft_wall_ms": 1, "max_trace_events": 10**9},
        )
        self.assertEqual(result["status"], "timeout")
        self.assertEqual(
            result["error"]["message"],
            "Your program ran too long and was stopped.",
        )

    def test_output_limit_stops_print_flood(self):
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            result = run_source(
                'for i in range(200000):\n    print("x" * 100)',
                limits={"max_trace_events": 10**9},
            )
        self.assertEqual(result["status"], "output_limit")
        self.assertEqual(
            result["error"]["message"],
            "Your program printed too much output and was stopped.",
        )


class FileTests(unittest.TestCase):
    def test_seeding_text_and_base64_round_trip(self):
        encoded = base64.b64encode("ünïcode ✓".encode("utf-8")).decode("ascii")
        result = run_source(
            'print(open("data.txt", encoding="utf-8").read())',
            files=[
                {"path": "data.txt", "content": "héllo"},
                {"path": "b64.txt", "content_base64": encoded},
            ],
            capture={"read_paths": ["data.txt", "b64.txt"]},
        )
        self.assertEqual(result["status"], "done")
        self.assertEqual(result["stdout"], "héllo\n")
        self.assertEqual(result["files"]["data.txt"]["text"], "héllo")
        self.assertEqual(result["files"]["b64.txt"]["text"], "ünïcode ✓")
        self.assertFalse(result["files"]["data.txt"]["modified"])

    def test_undecodable_file_reports_decode_error(self):
        encoded = base64.b64encode(b"\xff\xfe\x00binary").decode("ascii")
        result = run_source(
            "pass",
            files=[{"path": "blob.bin", "content_base64": encoded}],
            capture={"read_paths": ["blob.bin"]},
        )
        record = result["files"]["blob.bin"]
        self.assertTrue(record["exists"])
        self.assertIsNone(record["text"])
        self.assertTrue(record["decode_error"])
        self.assertFalse(record["modified"])

    def test_modified_flag_covers_change_create_and_absence(self):
        result = run_source(
            'open("seed.txt", "w").write("much longer content")\n'
            'open("created.txt", "w").write("new")',
            files=[
                {"path": "seed.txt", "content": "short"},
                {"path": "untouched.txt", "content": "keep"},
            ],
            capture={"read_paths": ["seed.txt", "untouched.txt", "created.txt", "missing.txt"]},
        )
        self.assertEqual(result["status"], "done")
        files = result["files"]
        self.assertTrue(files["seed.txt"]["modified"])
        self.assertFalse(files["untouched.txt"]["modified"])
        self.assertTrue(files["created.txt"]["exists"])
        self.assertTrue(files["created.txt"]["modified"])
        self.assertFalse(files["missing.txt"]["exists"])
        self.assertFalse(files["missing.txt"]["modified"])

    def test_parent_traversal_is_rejected(self):
        result = run_source(
            "pass",
            files=[{"path": "../escape.txt", "content": "x"}],
        )
        self.assertEqual(result["status"], "error")
        self.assertIn("..", result["error"]["message"])


class WorkspaceSnapshotTests(unittest.TestCase):
    def test_run_mode_snapshot_lists_seeded_and_written_files(self):
        result = run_source(
            'open("created.txt", "w").write("new")',
            files=[{"path": "seed.txt", "content": "short"}],
            mode="run",
        )
        self.assertEqual(result["status"], "done")
        workspace = result["workspaceFiles"]
        self.assertEqual(set(workspace), {"seed.txt", "created.txt"})
        created = workspace["created.txt"]
        self.assertEqual(created["text"], "new")
        self.assertTrue(created["modified"])
        self.assertEqual(created["size"], 3)
        seed = workspace["seed.txt"]
        self.assertEqual(seed["text"], "short")
        self.assertFalse(seed["modified"])
        self.assertEqual(seed["size"], 5)
        self.assertFalse(seed["truncated"])

    def test_check_mode_snapshot_is_empty(self):
        result = run_source(
            'open("created.txt", "w").write("new")',
            files=[{"path": "seed.txt", "content": "short"}],
            capture={"read_paths": ["seed.txt"]},
        )
        self.assertEqual(result["status"], "done")
        self.assertEqual(result["workspaceFiles"], {})
        self.assertEqual(result["files"]["seed.txt"]["text"], "short")

    def test_need_input_attempt_has_no_snapshot(self):
        result = run_source("input()", mode="run")
        self.assertEqual(result["status"], "need-input")
        self.assertEqual(result["workspaceFiles"], {})

    def test_nested_paths_use_forward_slashes(self):
        result = run_source(
            'import os\nos.makedirs("sub")\nopen("sub/deep.txt", "w").write("x")',
            mode="run",
        )
        self.assertEqual(result["status"], "done")
        record = result["workspaceFiles"]["sub/deep.txt"]
        self.assertEqual(record["text"], "x")

    def test_binary_snapshot_reports_decode_error(self):
        encoded = base64.b64encode(b"\xff\xfe\x00binary").decode("ascii")
        result = run_source(
            "pass",
            files=[{"path": "blob.bin", "content_base64": encoded}],
            mode="run",
        )
        record = result["workspaceFiles"]["blob.bin"]
        self.assertTrue(record["exists"])
        self.assertIsNone(record["text"])
        self.assertTrue(record["decode_error"])
        self.assertEqual(record["size"], 9)

    def test_oversize_text_is_truncated(self):
        result = run_source(
            'open("big.txt", "w").write("x" * 100500)',
            mode="run",
        )
        record = result["workspaceFiles"]["big.txt"]
        self.assertEqual(len(record["text"]), harness.STRING_CAP)
        self.assertTrue(record["truncated"])
        self.assertEqual(record["size"], 100500)

    def test_deleted_seed_is_absent_from_snapshot(self):
        result = run_source(
            'import os\nos.remove("gone.txt")',
            files=[{"path": "gone.txt", "content": "bye"}],
            mode="run",
        )
        self.assertEqual(result["status"], "done")
        self.assertNotIn("gone.txt", result["workspaceFiles"])

    def test_syntax_error_result_carries_empty_snapshot(self):
        result = run_source("def foo(:", mode="run")
        self.assertEqual(result["status"], "syntax_error")
        self.assertEqual(result["workspaceFiles"], {})


class TaggedValueTests(unittest.TestCase):
    def test_tagged_types(self):
        source = (
            "flag = True\n"
            "small = 5\n"
            "big = 2 ** 60\n"
            "ratio = 1.5\n"
            "text = 'x' * 100001\n"
            "seq = (1, 2)\n"
            "lst = [1, 2]\n"
            "mapping = {'a': 1}\n"
            "nothing = None\n"
        )
        result = run_source(
            source,
            capture={
                "variables": [
                    "flag", "small", "big", "ratio", "text",
                    "seq", "lst", "mapping", "nothing", "missing_var",
                ],
            },
        )
        variables = result["variables"]

        self.assertEqual(variables["flag"], {"t": "bool", "v": True})
        self.assertEqual(variables["small"], {"t": "int", "v": 5})
        self.assertEqual(variables["big"], {"t": "int", "v": str(2 ** 60)})
        self.assertEqual(variables["ratio"], {"t": "float", "v": 1.5})
        self.assertEqual(variables["nothing"], {"t": "null"})
        self.assertEqual(variables["seq"]["t"], "tuple")
        self.assertEqual(variables["lst"]["t"], "list")
        self.assertEqual(variables["mapping"]["t"], "dict")
        self.assertEqual(
            variables["mapping"]["v"],
            [[{"t": "string", "v": "a"}, {"t": "int", "v": 1}]],
        )
        self.assertTrue(variables["text"]["truncated"])
        self.assertEqual(len(variables["text"]["v"]), 100000)
        # Missing variables are absent, not null — the runner distinguishes
        # "undefined name" from "value is None".
        self.assertNotIn("missing_var", variables)

    def test_non_finite_floats_become_strings(self):
        result = run_source(
            "pos = float('inf')\nneg = float('-inf')\nnothing = float('nan')",
            capture={"variables": ["pos", "neg", "nothing"]},
        )
        variables = result["variables"]
        self.assertEqual(variables["pos"], {"t": "float", "v": "inf"})
        self.assertEqual(variables["neg"], {"t": "float", "v": "-inf"})
        self.assertEqual(variables["nothing"], {"t": "float", "v": "nan"})

    def test_sequence_truncation_flag(self):
        result = run_source(
            "items = list(range(1500))",
            capture={"variables": ["items"]},
        )
        encoded = result["variables"]["items"]
        self.assertTrue(encoded["truncated"])
        self.assertEqual(len(encoded["v"]), 1000)


class FunctionCaptureTests(unittest.TestCase):
    def test_param_count_excludes_varargs(self):
        result = run_source(
            "def f(a, b, *args, **kwargs):\n    return 1\n"
            "def g(a, *, option=2):\n    return 2\n"
            "def missing():\n    pass",
            capture={"functions": ["f", "g", "absent"]},
        )
        functions = result["functions"]
        self.assertEqual(functions["f"]["param_count"], 2)
        self.assertEqual(functions["g"]["param_count"], 2)
        self.assertTrue(functions["f"]["is_callable"])
        self.assertEqual(functions["f"]["kind"], "function")
        self.assertFalse(functions["absent"]["exists"])
        self.assertIsNone(functions["absent"]["param_count"])

    def test_sync_call_returns_tagged_value(self):
        result = run_source(
            "def double(x):\n    return x * 2",
            capture={
                "function_calls": [
                    {"key": "k1", "name": "double", "arguments": [21]},
                ],
            },
        )
        self.assertEqual(
            result["functionCalls"],
            [{"key": "k1", "ok": True, "value": {"t": "int", "v": 42}}],
        )

    def test_async_function_call_errors(self):
        result = run_source(
            "async def fetch():\n    return 1",
            capture={
                "function_calls": [
                    {"key": "k1", "name": "fetch", "arguments": []},
                ],
            },
        )
        entry = result["functionCalls"][0]
        self.assertFalse(entry["ok"])
        self.assertEqual(entry["error"]["type"], "TypeError")
        self.assertEqual(
            entry["error"]["message"],
            "function must be a regular function, not async",
        )

    def test_error_inside_called_function_reports_student_line(self):
        result = run_source(
            "def boom():\n    return 1 / 0",
            capture={
                "function_calls": [
                    {"key": "k1", "name": "boom", "arguments": []},
                ],
            },
        )
        entry = result["functionCalls"][0]
        self.assertFalse(entry["ok"])
        self.assertEqual(entry["error"]["type"], "ZeroDivisionError")
        self.assertEqual(entry["error"]["line"], 2)

    def test_function_calls_skipped_on_failure_status(self):
        result = run_source(
            "def hit():\n    return 1\nwhile True:\n    pass",
            limits={"max_trace_events": 5000},
            capture={
                "function_calls": [
                    {"key": "k1", "name": "hit", "arguments": []},
                ],
            },
        )
        self.assertEqual(result["status"], "loop_budget")
        self.assertEqual(result["functionCalls"], [])


class ScopedFunctionTests(unittest.TestCase):
    def test_scoped_stdout_slicing(self):
        result = run_source(
            'print("main")\ndef helper():\n    print("inside")\n    return 5',
            capture={"scoped_function": {"name": "helper", "arguments": []}},
        )
        self.assertEqual(result["status"], "done")
        scoped = result["scopedFunction"]
        self.assertTrue(scoped["ok"])
        self.assertEqual(scoped["stdout"], "inside\n")
        self.assertEqual(scoped["prompts"], [])
        self.assertEqual(result["stdout"], "main\ninside\n")

    def test_scoped_missing_function_fails_cleanly(self):
        result = run_source(
            "pass",
            capture={"scoped_function": {"name": "absent", "arguments": []}},
        )
        self.assertFalse(result["scopedFunction"]["ok"])
        self.assertIn("absent", result["scopedFunction"]["error"])


class StdioTests(unittest.TestCase):
    def test_transcript_is_byte_identical_to_cpython(self):
        result = run_source(
            'print("Hi")\nimport sys\nsys.stdout.write("abc")\nprint()'
        )
        self.assertEqual(result["stdout"], "Hi\nabc\n")

    def test_seed_is_stable_for_identical_specs(self):
        source = "import random\nprint(random.randint(0, 10**9))"
        first = run_source(source, prompt_inputs=[])
        second = run_source(source, prompt_inputs=[])
        self.assertEqual(first["seed"], second["seed"])
        self.assertEqual(first["stdout"], second["stdout"])

    def test_program_runs_after_syntax_error_in_prior_call(self):
        self.assertEqual(run_source("def foo(:")["status"], "syntax_error")
        self.assertEqual(run_source("print('ok')")["status"], "done")


class AnalyzeTests(unittest.TestCase):
    def analyze(self, source, conditions):
        return json.loads(
            harness.analyze(json.dumps({"source": source, "conditions": conditions}))
        )

    def test_evaluates_conditions(self):
        result = self.analyze(
            'print("hi")',
            [{"key": "c1", "condition": {"type": "ast_pattern", "pattern": "print(...)"}}],
        )
        self.assertIsNone(result["syntaxError"])
        self.assertTrue(result["results"]["c1"]["passed"])

    def test_syntax_error_fails_ast_keys_but_evaluates_text_only_ones(self):
        result = self.analyze(
            "def (:",
            [
                {"key": "c1", "condition": {"type": "ast_pattern", "pattern": "print(...)"}},
                {"key": "c2", "condition": {"type": "source_empty"}},
                {"key": "c3", "condition": {"type": "source_regex", "pattern": "def"}},
            ],
        )
        self.assertIsNotNone(result["syntaxError"])
        self.assertEqual(set(result["results"]), {"c1", "c2", "c3"})
        self.assertFalse(result["results"]["c1"]["passed"])
        self.assertIn("SyntaxError:", result["results"]["c1"]["detail"])
        self.assertIn("(line 1)", result["results"]["c1"]["detail"])
        # Text-only conditions never touch the AST: evaluated for real even
        # though the file does not parse.
        self.assertFalse(result["results"]["c2"]["passed"])
        self.assertEqual(result["results"]["c2"]["detail"], "source is not empty")
        self.assertTrue(result["results"]["c3"]["passed"])

    def test_regex_condition_matches_before_an_empty_for_body_parses(self):
        # The reported flow: the header line alone is an IndentationError, but
        # the regex is already in the source and must tick.
        source = "for q in range(len(questions)):"
        result = self.analyze(
            source,
            [{
                "key": "h",
                "condition": {
                    "type": "source_regex",
                    "pattern": r"for \w+ in range\(len\(\w+\)\):",
                },
            }],
        )
        self.assertIsNotNone(result["syntaxError"])
        self.assertTrue(result["results"]["h"]["passed"])

    def test_composite_of_text_only_conditions_evaluates_while_unparsed(self):
        result = self.analyze(
            "for q in range(3):",
            [{
                "key": "h",
                "condition": {
                    "type": "any",
                    "conditions": [
                        {"type": "source_regex", "pattern": "while"},
                        {"type": "source_regex", "pattern": r"for \w+"},
                    ],
                },
            }],
        )
        self.assertTrue(result["results"]["h"]["passed"])

    def test_composite_containing_an_ast_pattern_still_waits_for_a_parse(self):
        result = self.analyze(
            "for q in range(3):",
            [{
                "key": "h",
                "condition": {
                    "type": "all",
                    "conditions": [
                        {"type": "source_regex", "pattern": "for"},
                        {"type": "ast_pattern", "pattern": "for _ in _:\n    _"},
                    ],
                },
            }],
        )
        self.assertFalse(result["results"]["h"]["passed"])
        self.assertIn("SyntaxError:", result["results"]["h"]["detail"])


class ValidatePatternsTests(unittest.TestCase):
    def validate(self, patterns):
        return json.loads(harness.validate_patterns(json.dumps({"patterns": patterns})))

    def test_valid_and_invalid_patterns(self):
        result = self.validate([
            {"key": "ok", "pattern": "print(...)"},
            {"key": "bad", "pattern": "value = ..."},
        ])
        self.assertIsNone(result["errors"]["ok"])
        self.assertIsInstance(result["errors"]["bad"], str)


if __name__ == "__main__":
    unittest.main()

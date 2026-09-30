"""Contract tests for the AST pattern matcher (plan Step 3)."""

import ast
import os
import sys
import unittest

sys.path.insert(
    0,
    os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "src", "shared", "python",
    ),
)

import astmatch  # noqa: E402


def count(student_source, pattern, strict=False):
    return astmatch.count_matches(ast.parse(student_source), pattern, strict)


class StatementSequenceModeTests(unittest.TestCase):
    def test_for_wildcard_matches_for_statement(self):
        self.assertEqual(count("for i in x:\n    pass", "for _ in _: ..."), 1)

    def test_for_wildcard_fails_bare_while(self):
        self.assertEqual(count("while True:\n    pass", "for _ in _: ..."), 0)

    def test_ellipsis_matches_zero_statements(self):
        self.assertEqual(count("print(1)", "...\nprint(...)"), 1)

    def test_leading_ellipsis_skips_intervening_statements(self):
        self.assertEqual(count("x = 1\nprint(1)", "...\nprint(...)"), 1)

    def test_loop_body_requires_print(self):
        pattern = "for _ in _:\n    ...\n    print(...)\n    ..."
        self.assertEqual(count("for i in range(3):\n    print(i)", pattern), 1)
        self.assertEqual(count("for i in range(3):\n    x = i", pattern), 0)

    def test_loop_body_counts_each_matching_loop(self):
        pattern = "for _ in _:\n    ...\n    print(...)\n    ..."
        source = "for i in r:\n    print(i)\nfor j in r:\n    print(j)"
        self.assertEqual(count(source, pattern), 2)

    def test_matches_nested_statement_lists(self):
        source = "def f():\n    print(1)"
        self.assertEqual(count(source, "print(...)"), 1)

    def test_int_does_not_match_float(self):
        self.assertEqual(count("x = 1", "x = 1"), 1)
        self.assertEqual(count("x = 1.0", "x = 1"), 0)


class WildcardTests(unittest.TestCase):
    SAME_VAR = "_x = input(...)\n...\nprint(_x)"

    def test_named_wildcard_matches_same_variable(self):
        source = 'name = input("?")\nprint(name)'
        self.assertEqual(count(source, self.SAME_VAR), 1)

    def test_named_wildcard_matches_across_gap(self):
        source = 'name = input("?")\nx = 1\nprint(name)'
        self.assertEqual(count(source, self.SAME_VAR), 1)

    def test_named_wildcard_rejects_different_printed_name(self):
        source = 'name = input("?")\nprint(other)'
        self.assertEqual(count(source, self.SAME_VAR), 0)

    def test_consistent_wildcard_fails_on_different_identifiers(self):
        # The binding made by `a = input()` must not match print(b).
        source = "a = input()\nprint(b)"
        self.assertEqual(count(source, self.SAME_VAR), 0)

    def test_bare_underscore_never_binds(self):
        pattern = "_ = _\n...\n_ = _"
        source = "x = 1\ny = 2\nz = 3"
        self.assertEqual(count(source, pattern), 1)

    def test_underscore_statement_matches_pass_body(self):
        # The reported gap: `pass` is a statement with no expression inside,
        # so an expression-only wildcard would never match it.
        pattern = "for _ in range(_):\n    _"
        self.assertEqual(count("for i in range(3):\n    pass", pattern), 1)

    def test_underscore_statement_matches_expression_bodies(self):
        pattern = "for _ in range(_):\n    _"
        self.assertEqual(count("for i in range(3):\n    print(i)", pattern), 1)

    def test_underscore_statement_matches_any_single_statement(self):
        pattern = "for _ in range(_):\n    _"
        for body in ("break", "x = i", "i += 1", "while True:\n        pass"):
            source = f"for i in range(3):\n    {body}"
            with self.subTest(body=body):
                self.assertEqual(count(source, pattern), 1)

    def test_underscore_statement_requires_the_same_structure_around_it(self):
        pattern = "for _ in range(_):\n    _"
        self.assertEqual(count("while True:\n    pass", pattern), 0)
        # The body wildcard is still one statement: two-statement bodies need `...`.
        self.assertEqual(count("for i in range(3):\n    print(i)\n    pass", pattern), 0)


class ExpressionModeTests(unittest.TestCase):
    def test_print_matches_inside_assignment(self):
        self.assertEqual(count("x = print(1)", "print(...)"), 1)

    def test_range_matches_inside_for(self):
        self.assertEqual(count("for i in range(5):\n    pass", "range(...)"), 1)

    def test_count_is_number_of_matching_nodes(self):
        source = "print(1)\nx = print(2)\nprint(3)"
        self.assertEqual(count(source, "print(...)"), 3)

    def test_call_with_zero_arguments_matches(self):
        self.assertEqual(count("print()", "print(...)"), 1)


class AnyParamsRewriteTests(unittest.TestCase):
    def test_stub_style_params_match_any_function(self):
        self.assertEqual(count("def greet(name):\n    return name", "def _(...): ..."), 1)
        self.assertEqual(count("def greet():\n    pass", "def _(...): ..."), 1)
        self.assertEqual(count("x = 1", "def _(...): ..."), 0)

    def test_async_def_header_also_rewrites(self):
        source = "async def fetch(url):\n    return url"
        self.assertEqual(count(source, "async def _(...): ..."), 1)


class ValidationTests(unittest.TestCase):
    def test_valid_pattern_returns_none(self):
        self.assertIsNone(astmatch_validate("print(...)"))

    def test_bad_syntax_raises_pattern_error(self):
        with self.assertRaises(astmatch.PatternError) as ctx:
            astmatch.validate("def (:")
        self.assertIn("line", str(ctx.exception))

    def test_empty_pattern_raises(self):
        with self.assertRaises(astmatch.PatternError):
            astmatch.validate("")

    def test_ellipsis_as_assignment_value_is_misuse(self):
        with self.assertRaises(astmatch.PatternError):
            astmatch.validate("value = ...")

    def test_ellipsis_as_keyword_argument_is_misuse(self):
        with self.assertRaises(astmatch.PatternError):
            astmatch.validate("f(x=...)")

    def test_ellipsis_inside_list_literal_is_misuse(self):
        with self.assertRaises(astmatch.PatternError):
            astmatch.validate("[...]")

    def test_ellipsis_as_call_positional_argument_is_valid(self):
        astmatch.validate("print(...)")


class ClauseVariantTests(unittest.TestCase):
    """Variant (default) vs strict counts for every clause-list semantic.

    The strict column was pinned against the pre-change matcher and must
    stay bit-for-bit identical; the variant column is the new default.
    """

    MATRIX = [
        # (pattern, student source, variant count, strict count)
        ("if _:\n    _", "if x:\n    a\nelse:\n    b", 1, 0),
        ("if _:\n    _", "if x:\n    a\nelif y:\n    b\nelse:\n    c", 2, 0),
        ("for _ in _:\n    _", "for i in r:\n    a\nelse:\n    b", 1, 0),
        ("try:\n    _\nexcept Exception:\n    _",
         "try:\n    a\nexcept Exception:\n    b\nfinally:\n    c", 1, 0),
        ("try:\n    _\nfinally:\n    _",
         "try:\n    a\nexcept Exception:\n    b\nfinally:\n    c", 1, 0),
        ("try:\n    _\nexcept Exception:\n    _",
         "try:\n    a\nexcept Exception:\n    b\nexcept ValueError:\n    c", 1, 0),
        ("try:\n    _\nexcept Exception:\n    _\nexcept ValueError:\n    _",
         "try:\n    a\nexcept ValueError:\n    b\nexcept Exception:\n    c", 0, 0),
        ("match _:\n    case _:\n        _",
         "match x:\n    case 0:\n        a\n    case _:\n        b", 1, 0),
        ("if x:\n    _\nelse:\n    print(_)",
         "if x:\n    a\nelif y:\n    b\nelse:\n    print(c)", 1, 0),
        ("if x:\n    _\nelse:\n    print(_)",
         "if x:\n    a\nelse:\n        if y:\n            b\n        else:\n            print(c)", 1, 0),
        ("try:\n    _\nexcept ValueError:\n    _",
         "try:\n    a\nexcept ValueError as e:\n    b", 1, 0),
        ("try:\n    _\nexcept ValueError as e:\n    _",
         "try:\n    a\nexcept ValueError as e:\n    b", 1, 1),
        ("try:\n    _\nexcept ValueError:\n    _",
         "try:\n    a\nexcept:\n    b", 0, 0),
        ("try:\n    _\nexcept:\n    _",
         "try:\n    a\nexcept:\n    b\nelse:\n    c\nfinally:\n    d", 1, 0),
        ("match _:\n    case _:\n        _", "match x:\n    case y if g:\n        b", 1, 0),
        ("with _:\n    _", "with a, b:\n    c", 0, 0),
        ("def _(...):\n    ...", "@dec\ndef f():\n    pass", 0, 0),
        ("if _:\n    _", "if x:\n    a\nelif y:\n    b", 2, 1),
    ]

    def test_variant_and_strict_counts(self):
        for index, (pattern, student, variant, strict) in enumerate(self.MATRIX, 1):
            with self.subTest(row=index, pattern=pattern, student=student):
                self.assertEqual(count(student, pattern), variant)
                self.assertEqual(count(student, pattern, strict=True), strict)


def astmatch_validate(pattern):
    return astmatch.validate(pattern)


class EvaluateConditionTests(unittest.TestCase):
    TREE = ast.parse("print(1)\nprint(2)")
    SOURCE = "print(1)\nprint(2)"

    def evaluate(self, condition, source=None):
        return astmatch.evaluate_condition(
            self.TREE, condition, self.SOURCE if source is None else source
        )

    def test_min_count_boundary(self):
        base = {"type": "ast_pattern", "pattern": "print(...)"}
        self.assertTrue(self.evaluate({**base, "min_count": 2})["passed"])
        failure = self.evaluate({**base, "min_count": 3})
        self.assertFalse(failure["passed"])
        self.assertEqual(failure["detail"], "ast_pattern matched 2/required 3")

    def test_max_count_boundary(self):
        condition = {
            "type": "ast_pattern", "pattern": "print(...)",
            "min_count": 1, "max_count": 1,
        }
        failure = self.evaluate(condition)
        self.assertFalse(failure["passed"])
        self.assertEqual(failure["detail"], "ast_pattern matched 2/max 1")

    def test_default_min_count_is_one(self):
        self.assertTrue(self.evaluate({"type": "ast_pattern", "pattern": "print(...)"})["passed"])
        self.assertFalse(self.evaluate({"type": "ast_pattern", "pattern": "input(...)"})["passed"])

    def test_invalid_pattern_condition_fails_with_detail(self):
        result = self.evaluate({"type": "ast_pattern", "pattern": "value = ..."})
        self.assertFalse(result["passed"])
        self.assertIn("invalid ast_pattern", result["detail"])

    def test_variant_default_passes_an_if_else(self):
        source = "if x:\n    a\nelse:\n    b"
        result = astmatch.evaluate_condition(
            ast.parse(source),
            {"type": "ast_pattern", "pattern": "if _:\n    _"},
            source,
        )
        self.assertTrue(result["passed"])
        self.assertEqual(result["detail"], "ast_pattern matched 1/required 1")

    def test_strict_condition_rejects_an_if_else(self):
        source = "if x:\n    a\nelse:\n    b"
        result = astmatch.evaluate_condition(
            ast.parse(source),
            {"type": "ast_pattern", "pattern": "if _:\n    _", "strict": True},
            source,
        )
        self.assertFalse(result["passed"])
        self.assertEqual(result["detail"], "ast_pattern matched 0/required 1")

    def test_source_regex(self):
        result = self.evaluate({"type": "source_regex", "pattern": "PRINT", "case_sensitive": False})
        self.assertTrue(result["passed"])
        strict = self.evaluate({"type": "source_regex", "pattern": "PRINT"})
        self.assertFalse(strict["passed"])

    def test_source_regex_flags(self):
        lines = "print(1)\ninput()\n"
        tree = ast.parse(lines)
        result = astmatch.evaluate_condition(
            tree,
            {"type": "source_regex", "pattern": "^input", "regex_flags": "m"},
            lines,
        )
        self.assertTrue(result["passed"])

    def test_invalid_regex_reports_error(self):
        result = self.evaluate({"type": "source_regex", "pattern": "("})
        self.assertFalse(result["passed"])
        self.assertIn("invalid regex", result["detail"])

    def test_source_empty(self):
        empty_tree = ast.parse("")
        self.assertTrue(
            astmatch.evaluate_condition(empty_tree, {"type": "source_empty"}, "")["passed"]
        )
        self.assertFalse(self.evaluate({"type": "source_empty"})["passed"])

    def test_composites(self):
        children = [
            {"type": "source_empty"},
            {"type": "ast_pattern", "pattern": "print(...)"},
        ]
        all_result = self.evaluate({"type": "all", "conditions": children})
        self.assertFalse(all_result["passed"])
        self.assertIn("all: 1/2", all_result["detail"])

        any_result = self.evaluate({"type": "any", "conditions": children})
        self.assertTrue(any_result["passed"])

        none_result = self.evaluate(
            {"type": "none", "conditions": [{"type": "source_empty"}]}
        )
        self.assertTrue(none_result["passed"])
        self.assertFalse(none_result["detail"].endswith("bogus"))

    def test_unknown_type_reports_unknown(self):
        result = self.evaluate({"type": "mystery"})
        self.assertFalse(result["passed"])
        self.assertEqual(result["detail"], "Unknown condition type 'mystery'")

    def test_every_condition_returns_a_detail(self):
        conditions = [
            {"type": "ast_pattern", "pattern": "print(...)"},
            {"type": "source_regex", "pattern": "print"},
            {"type": "source_empty"},
            {"type": "all", "conditions": [{"type": "source_empty"}]},
            {"type": "any", "conditions": [{"type": "source_empty"}]},
            {"type": "none", "conditions": [{"type": "source_empty"}]},
            {"type": "mystery"},
        ]
        for condition in conditions:
            result = self.evaluate(condition)
            self.assertIsInstance(result["detail"], str)
            self.assertTrue(result["detail"])


if __name__ == "__main__":
    unittest.main()

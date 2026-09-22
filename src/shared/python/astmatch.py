"""AST pattern matcher for Python activity conditions.

A pattern is a Python source string parsed with :func:`ast.parse` (module
mode). It must contain at least one statement, else it is invalid.

Wildcards
---------
``_``
    A bare underscore ``Name`` in expression position matches **any single
    expression node**; it never binds.

``_name`` (e.g. ``_x``, ``_total`` — matching ``^_[A-Za-z0-9][A-Za-z0-9_]*$``)
    A **named wildcard**: on its first occurrence it binds to the matched
    subtree; every later occurrence in the same match attempt must be equal to
    the binding. A student ``Name`` node binds its identifier, so
    ``_x = ...`` + ``print(_x)`` enforces "same variable"; any other
    expression binds ``ast.dump(node, include_attributes=False)``. Bindings
    are scoped to one candidate match, never program-global.

``...``
    An ``Ellipsis`` constant **in statement position** (a bare ``...``
    statement) matches **zero or more statements** inside a statement
    sequence; in a ``Call``'s argument list it matches **zero or more mixed
    positional/keyword arguments**. Anywhere else it is an invalid pattern.

All other pattern nodes must match the same ``ast`` class with every child
matched recursively. Ignored: ``lineno``/``col_offset``/``end_*`` attributes
and ``ctx``. Constants compare with ``pattern.value == student.value`` and
``type(pattern.value) is type(student.value)`` (so ``1`` does not match
``1.0``). Function/class definition names accept ``_``/``_name`` wildcards in
the name field, and a stub-style parameter list ``def name(...):`` matches any
parameter list (rewritten to a sentinel before parsing — plain CPython rejects
``...`` as a parameter list).

Matching modes
--------------
1. **Statement-sequence mode** when the pattern module is not a single bare
   expression statement: the pattern statement list (with its ``...`` markers)
   is matched against every statement list in the student AST (module body and
   every ``body``/``orelse``/``finalbody`` list), at every start offset, with
   backtracking; the count is the number of non-overlapping, leftmost-first
   matches per statement list, summed.
2. **Expression mode** when the pattern module is exactly one expression
   statement: the inner expression is matched against every expression node
   in the student tree; the count is the number of matching nodes.

Public API: :class:`PatternError`, ``validate(pattern_source) -> None``,
``count_matches(student_ast, pattern_source) -> int``, and
``evaluate_condition(source_ast, condition, raw_source=None) -> {passed, detail}``
handling ``ast_pattern`` (``min_count``/``max_count``), ``source_regex``,
``source_empty``, and recursive ``all``/``any``/``none``.
"""

import ast
import re

__all__ = ["PatternError", "validate", "count_matches", "evaluate_condition"]


class PatternError(ValueError):
    """Raised when a pattern source is syntactically or structurally invalid."""


_NAMED_WILDCARD_RE = re.compile(r"^_[A-Za-z0-9][A-Za-z0-9_]*$")
_ANY_PARAMS_SENTINEL = "__scorm_any_params__"
# Stub-style headers ("def name(...)") do not parse under exec-mode CPython;
# rewrite them to a sentinel keyword-only-free parameter before ast.parse.
_ANY_PARAMS_REWRITE_RE = re.compile(
    r"(?m)^([ \t]*(?:async[ \t]+)?def[ \t]+[A-Za-z_][A-Za-z0-9_]*[ \t]*\([ \t]*)"
    r"\.\.\.([ \t]*\))"
)
_SEQUENCE_FIELDS = ("body", "orelse", "finalbody")
_REGEX_FLAG_CHARS = {"i": re.I, "m": re.M, "s": re.S}
_DEFINITION_TYPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)


# ---------------------------------------------------------------------------
# Parsing and validation
# ---------------------------------------------------------------------------

def validate(pattern_source):
    """Validate a pattern. Returns None; raises PatternError on failure."""
    _parse_pattern(pattern_source)
    return None


def _parse_pattern(pattern_source):
    if not isinstance(pattern_source, str):
        raise PatternError("pattern must be a string")
    rewritten = _ANY_PARAMS_REWRITE_RE.sub(
        r"\1" + _ANY_PARAMS_SENTINEL + r"\2", pattern_source
    )
    try:
        tree = ast.parse(rewritten)
    except SyntaxError as exc:
        line = exc.lineno if exc.lineno is not None else "?"
        col = exc.offset if exc.offset is not None else "?"
        raise PatternError(
            f"invalid pattern at line {line}, column {col}: {exc.msg}"
        ) from exc
    if not tree.body:
        raise PatternError("pattern must contain at least one statement")
    _check_ellipsis_usage(tree)
    return tree


def _check_ellipsis_usage(tree):
    for node, parent in _iter_with_parents(tree):
        if not (isinstance(node, ast.Constant) and node.value is ...):
            continue
        if isinstance(parent, ast.Expr) and parent.value is node:
            continue  # statement position
        if isinstance(parent, ast.Call) and any(arg is node for arg in parent.args):
            continue  # call argument position
        raise PatternError(
            "... is only allowed as a statement or as a call argument"
        )


def _iter_with_parents(node, parent=None):
    yield node, parent
    for child in ast.iter_child_nodes(node):
        yield from _iter_with_parents(child, node)


def _is_ellipsis_stmt(node):
    return (
        isinstance(node, ast.Expr)
        and isinstance(node.value, ast.Constant)
        and node.value.value is ...
    )


def _is_arg_marker(node):
    return isinstance(node, ast.Constant) and node.value is ...


def _is_expression_pattern(tree):
    """True when the pattern is a single bare expression statement."""
    if len(tree.body) != 1:
        return False
    stmt = tree.body[0]
    return isinstance(stmt, ast.Expr) and not _is_ellipsis_stmt(stmt)


# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------

def _bind(pattern_name, target, env):
    """Bind pattern_name to target's identity key; None on contradiction."""
    if isinstance(target, str):
        key = target
    elif isinstance(target, ast.Name):
        key = target.id
    else:
        key = ast.dump(target, include_attributes=False)
    if pattern_name in env:
        return env if env[pattern_name] == key else None
    bound = dict(env)
    bound[pattern_name] = key
    return bound


def _match_node(pat, stu, env):
    """Match one pattern node against one student node. Returns env or None."""
    if not isinstance(pat, ast.AST):
        # Scalar fields (strings inside lists such as Global.names, keyword
        # names, …) compare exactly, type-strictly.
        if type(pat) is type(stu) and pat == stu:
            return env
        return None

    # Wildcards live on the pattern side and match before class equality.
    if isinstance(pat, ast.Name):
        if pat.id == "_":
            return env if isinstance(stu, ast.expr) else None
        if _NAMED_WILDCARD_RE.match(pat.id):
            if not isinstance(stu, ast.expr):
                return None
            return _bind(pat.id, stu, env)

    if type(pat) is not type(stu):
        return None

    if isinstance(pat, ast.Constant):
        if pat.value is ...:
            return None  # unreachable after validation; stay safe
        if type(pat.value) is not type(stu.value):
            return None
        return env if pat.value == stu.value else None

    if isinstance(pat, ast.Call):
        return _match_call(pat, stu, env)

    return _match_fields(pat, stu, env)


def _match_call(pat, stu, env):
    stepped = _match_node(pat.func, stu.func, env)
    if stepped is None:
        return None
    pat_items = list(pat.args) + list(pat.keywords)
    stu_items = list(stu.args) + list(stu.keywords)
    result = _match_sequence(pat_items, stu_items, _is_arg_marker, stepped, True)
    if result is None:
        return None
    return result[1]


def _is_any_params_pattern(node):
    """True for the rewritten stub-style `def name(...)` parameter list."""
    if not isinstance(node, ast.arguments):
        return False
    return (
        not node.posonlyargs
        and len(node.args) == 1
        and node.args[0].arg == _ANY_PARAMS_SENTINEL
        and node.vararg is None
        and not node.kwonlyargs
        and node.kwarg is None
        and not node.defaults
        and not node.kw_defaults
    )


def _match_fields(pat, stu, env):
    for field in pat._fields:
        if field == "ctx":
            continue
        pv = getattr(pat, field, None)
        sv = getattr(stu, field, None)

        if (
            field == "name"
            and isinstance(pat, _DEFINITION_TYPES)
            and isinstance(pv, str)
        ):
            if pv == "_":
                continue
            if _NAMED_WILDCARD_RE.match(pv):
                if not isinstance(sv, str):
                    return None
                bound = _bind(pv, sv, env)
                if bound is None:
                    return None
                env = bound
            elif pv != sv:
                return None
            continue

        if (
            field == "args"
            and isinstance(pat, (ast.FunctionDef, ast.AsyncFunctionDef))
            and _is_any_params_pattern(pv)
        ):
            if not isinstance(sv, ast.arguments):
                return None
            continue

        stepped = _match_field_value(field, pv, sv, env)
        if stepped is None:
            return None
        env = stepped
    return env


def _match_field_value(field, pv, sv, env):
    if isinstance(pv, ast.AST):
        if not isinstance(sv, ast.AST):
            return None
        return _match_node(pv, sv, env)

    if isinstance(pv, list):
        if not isinstance(sv, list):
            return None
        if field in _SEQUENCE_FIELDS:
            # Nested statement lists (function bodies, branches, …) are matched
            # entirely; offsets are the outer scan's concern.
            result = _match_sequence(pv, sv, _is_ellipsis_stmt, env, True)
            return result[1] if result is not None else None
        if len(pv) != len(sv):
            return None
        stepped = env
        for pat_item, stu_item in zip(pv, sv):
            stepped = _match_node(pat_item, stu_item, stepped)
            if stepped is None:
                return None
        return stepped

    if type(pv) is type(sv) and pv == sv:
        return env
    return None


def _match_sequence(pat_items, stu_items, is_marker, env, must_consume, pi=0, si=0):
    """Match pat_items[pi:] against stu_items[si:], markers reluctant.

    Returns (end_index, env) for the first (leftmost, shortest-marker-expansion)
    successful match, or None. With must_consume, a match only succeeds once
    every student item is consumed, so trailing markers keep expanding.
    """
    if pi == len(pat_items):
        if must_consume and si != len(stu_items):
            return None
        return si, env
    if is_marker(pat_items[pi]):
        taken = 0
        while si + taken <= len(stu_items):
            result = _match_sequence(
                pat_items, stu_items, is_marker, env, must_consume,
                pi + 1, si + taken,
            )
            if result is not None:
                return result
            taken += 1
        return None
    if si >= len(stu_items):
        return None
    stepped = _match_node(pat_items[pi], stu_items[si], env)
    if stepped is None:
        return None
    return _match_sequence(
        pat_items, stu_items, is_marker, stepped, must_consume, pi + 1, si + 1
    )


def _collect_statement_lists(tree):
    """Module body plus every body/orelse/finalbody list in the tree."""
    lists = []
    for node in ast.walk(tree):
        for field in _SEQUENCE_FIELDS:
            value = getattr(node, field, None)
            if isinstance(value, list):
                lists.append(value)
    return lists


def _count_in_list(pat_stmts, stu_stmts):
    count = 0
    pos = 0
    while pos <= len(stu_stmts):
        result = _match_sequence_at(pat_stmts, stu_stmts, pos)
        if result is None:
            pos += 1
            continue
        end, _env = result
        consumed = end - pos
        count += 1
        if consumed == 0:
            break  # matches everywhere; count once per statement list
        pos = end
    return count


def _match_sequence_at(pat_stmts, stu_stmts, pos):
    return _match_sequence(pat_stmts, stu_stmts, _is_ellipsis_stmt, {}, False, 0, pos)


def count_matches(student_ast, pattern_source):
    """Count pattern matches in a student AST. Validates first."""
    tree = _parse_pattern(pattern_source)

    if _is_expression_pattern(tree):
        target = tree.body[0].value
        count = 0
        for node in ast.walk(student_ast):
            if _match_node(target, node, {}) is not None:
                count += 1
        return count

    total = 0
    for stmt_list in _collect_statement_lists(student_ast):
        total += _count_in_list(tree.body, stmt_list)
    return total


# ---------------------------------------------------------------------------
# Condition evaluation
# ---------------------------------------------------------------------------

def _as_int(value, default):
    if isinstance(value, bool) or not isinstance(value, int):
        return default
    return value


def evaluate_condition(source_ast, condition, raw_source=None):
    """Evaluate one config condition. Always returns {passed, detail}."""
    if not isinstance(condition, dict):
        return {"passed": False, "detail": "condition must be an object"}

    ctype = condition.get("type")

    if ctype == "ast_pattern":
        pattern = condition.get("pattern")
        if not isinstance(pattern, str) or not pattern.strip():
            return {"passed": False, "detail": "ast_pattern has no pattern"}
        try:
            count = count_matches(source_ast, pattern)
        except PatternError as exc:
            return {"passed": False, "detail": f"invalid ast_pattern: {exc}"}
        min_count = _as_int(condition.get("min_count"), 1)
        if min_count < 1:
            min_count = 1
        max_count = None
        if condition.get("max_count") is not None:
            max_count = _as_int(condition.get("max_count"), None)
        if count < min_count:
            return {
                "passed": False,
                "detail": f"ast_pattern matched {count}/required {min_count}",
            }
        if max_count is not None and count > max_count:
            return {
                "passed": False,
                "detail": f"ast_pattern matched {count}/max {max_count}",
            }
        return {
            "passed": True,
            "detail": f"ast_pattern matched {count}/required {min_count}",
        }

    if ctype == "source_regex":
        pattern = condition.get("pattern")
        if not isinstance(pattern, str):
            return {"passed": False, "detail": "source_regex has no pattern"}
        if not isinstance(raw_source, str):
            return {"passed": False, "detail": "source_regex needs the source text"}
        flags = 0
        if condition.get("case_sensitive") is False:
            flags |= re.I
        for char in condition.get("regex_flags") or "":
            flags |= _REGEX_FLAG_CHARS.get(char, 0)
        try:
            found = re.search(pattern, raw_source, flags) is not None
        except re.error as exc:
            return {"passed": False, "detail": f"invalid regex: {exc}"}
        return {
            "passed": found,
            "detail": "source_regex matched" if found else "source_regex did not match",
        }

    if ctype == "source_empty":
        empty = isinstance(raw_source, str) and raw_source.strip() == ""
        return {
            "passed": empty,
            "detail": "source is empty" if empty else "source is not empty",
        }

    if ctype in ("all", "any", "none"):
        children = condition.get("conditions")
        if not isinstance(children, list) or not children:
            return {"passed": False, "detail": f"{ctype} condition has no children"}
        results = [evaluate_condition(source_ast, child, raw_source) for child in children]
        flags = [result["passed"] for result in results]
        total = len(results)
        passed_count = sum(flags)
        if ctype == "all":
            label = f"all: {passed_count}/{total} conditions passed"
            if all(flags):
                return {"passed": True, "detail": label}
            first_failure = next(r for r in results if not r["passed"])
            return {
                "passed": False,
                "detail": f"{label}; first failure: {first_failure['detail']}",
            }
        if ctype == "any":
            label = f"any: {passed_count}/{total} conditions passed"
            if any(flags):
                first_match = next(r for r in results if r["passed"])
                return {
                    "passed": True,
                    "detail": f"{label}; matched: {first_match['detail']}",
                }
            return {"passed": False, "detail": label}
        label = f"none: {passed_count}/{total} conditions passed"
        if any(flags):
            return {"passed": False, "detail": label}
        return {"passed": True, "detail": f"{label} (0 required)"}

    return {"passed": False, "detail": f"Unknown condition type '{ctype}'"}

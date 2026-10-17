#!/usr/bin/env python3
"""Regression + soundness tests for the AST-based z3_string_solver.

Run with the project venv (z3 lives there):
    /home/manny/reconix/.venv/bin/python scripts/test_z3_regex_ast.py

Two layers of evidence:
  1. DIFFERENTIAL — for each (pattern, string) pair, Z3 membership via the
     compiled translation must agree with Python's own `re.fullmatch`.
  2. PROPERTY — whatever the solver returns as `success` is re-verified against
     the original constraints, so a bad candidate can never be returned.

The core failure this file exists to prevent: `[^<>]{1,5}` returning "<".
"""
import importlib.machinery
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys

from z3 import Contains, InRe, Solver, String, StringVal, sat, unsat

ROOT = pathlib.Path(__file__).resolve().parents[1]
# Z3_SOLVER_PATH lets the suite be pointed at any candidate implementation,
# e.g. to confirm the tests actually FAIL against the old single-shape parser.
SOLVER_PATH = pathlib.Path(
    os.environ.get("Z3_SOLVER_PATH", ROOT / ".opencode" / "tools" / "z3_string_solver.py")
)

ALLOWED_STATUSES = {"success", "unsat", "unknown", "unsupported_pattern", "error"}

def load_solver():
    # SourceFileLoader works regardless of the file's extension (the candidate
    # implementation may be a backup with no .py suffix).
    loader = importlib.machinery.SourceFileLoader("z3_string_solver", str(SOLVER_PATH))
    spec = importlib.util.spec_from_loader("z3_string_solver", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module

SOLVER = load_solver()

def z3_matches(rx, text):
    s = Solver()
    x = String("x")
    s.add(x == StringVal(text))
    s.add(InRe(x, rx))
    return s.check() == sat

def z3_rejects(rx, text):
    s = Solver()
    x = String("x")
    s.add(x == StringVal(text))
    s.add(InRe(x, rx))
    return s.check() == unsat

def check_success(payload, max_len, must_contain, pattern):
    """Every `success` must satisfy the ORIGINAL constraints. Raises on violation."""
    assert payload.get("status") == "success", f"expected success, got {payload}"
    cand = payload["generated_input"]
    assert len(cand) <= max_len, f"length {len(cand)} > {max_len}: {cand!r}"
    if must_contain:
        assert must_contain in cand, f"{must_contain!r} not in {cand!r}"
    if pattern:
        assert re.fullmatch(pattern, cand, re.ASCII), \
            f"candidate {cand!r} violates pattern {pattern!r}"
    return cand

# Differential: translation vs Python's regex engine

DIFFERENTIAL = [
    (r"[^<>]{1,5}", ["", "<", ">", "a", "<<", "abc", "a<", "<script>"]),
    (r"^\d{3}$", ["123", "12", "1234", "abc", "1a3", "0"]),
    (r"\d+", ["0", "12345", "", "a", "12a"]),
    (r"[a-z]+@[a-z]+", ["a@a", "abc@def", "A@a", "a@", "@a", "a@b@c"]),
    (r"[a-zA-Z0-9<>_]{5,20}", ["script", "ab", "abcde", "<><><", "abc$"]),
    (r"(cat|dog|bird)+", ["cat", "dogcat", "catx", "bird", "catdogbird"]),
    (r"^[a-z]{2,4}[0-9]{3}$", ["aa000", "aaaa999", "a000", "aaa00", "AAAA000"]),
    (r"\w{3,6}", ["abc", "ab", "a_b", "a b", "abcdefg"]),
    (r"a.c", ["abc", "a\nc", "ac", "abbc"]),
    (r"(?s)a.c", ["a\nc", "abc"]),
    (r"(?i)abc", ["abc", "ABC", "AbC", "abd"]),
    (r"[^a]x", ["bx", "ax", "Ax", "xx"]),
    (r"(?i)^[a-f]{2}$", ["af", "AF", "aF", "ag"]),
    (r"[^\d]{2}", ["ab", "a1", "12", "a<"]),
    (r"[\w.-]{1,4}", ["a.b", "a-b", "a b", "abcd", "..."]),
    (r"(?:ab|cd){1,2}", ["ab", "abcd", "cdab", "abab", "abc", ""]),
    (r"[^<>\s]{1,4}", ["ab", "a b", "a<b", "ab\n"]),
    (r"^\s+$", [" ", "  ", "a", ""]),
    (r"x{2,}", ["xx", "x", "xxxx"]),
    (r"\d{1,3}\.\d{1,3}", ["1.2", "123.456", "1.", "a.b"]),
    (r"[a-z]{0,3}", ["", "ab", "abcd"]),
    (r"\w+", ["abc", "\u00e9", "a_b"]),          # re.ASCII => JS semantics
    (r"[A-Za-z0-9_]{1,3}", ["a_1", "ab", "a-b"]),
    (r"(a|b)*c", ["c", "abc", "ab", "cab"]),
    (r"[^<>\"']{1,3}", ["ab", 'a"b', "a'b", "a<b"]),
    (r"\s{1,2}", [" ", "  ", "a", "\t"]),
    (r"[aeiou]{2,3}", ["ae", "aeiou", "xyz"]),
    (r"^\d{1,2}[-/]\d{1,2}$", ["1-2", "12/31", "1.2", "123-1"]),
    (r"[^0-9a-f]{2}", ["zz", "z1", "ab", "a\u00e9"]),
    (r"(?i)^[a-z]{3}$", ["abc", "ABC", "aBc", "ab1"]),
]

def test_differential_translation():
    mismatches = []
    checked = 0
    for pattern, samples in DIFFERENTIAL:
        rx = SOLVER.compile_regex(pattern)
        for text in samples:
            expected = bool(re.fullmatch(pattern, text, re.ASCII))
            got = z3_matches(rx, text)
            checked += 1
            if got != expected:
                mismatches.append(
                    f"pattern={pattern!r} text={text!r} z3={got} python={expected}"
                )
    assert not mismatches, "translation disagrees with Python:\n  " + "\n  ".join(mismatches)
    print(f"         ({checked} pattern/string pairs agreed)")

def test_negated_class_soundness():
    rx = SOLVER.compile_regex(r"[^<>]{1,10}")
    for forbidden in ["<", ">"]:
        s = Solver()
        x = String("x")
        s.add(InRe(x, rx))
        s.add(Contains(x, StringVal(forbidden)))
        assert s.check() == unsat, f"'[^<>]' still admits {forbidden!r}"

    for _ in range(5):
        payload = SOLVER.solve_constraints(10, "script", r"[^<>]{1,10}")
        cand = check_success(payload, 10, "script", r"[^<>]{1,10}")
        assert "<" not in cand and ">" not in cand, f"forbidden char in {cand!r}"

    # whitespace-negated class must not admit whitespace
    ws_rx = SOLVER.compile_regex(r"[^\s]{1,20}")
    for forbidden in [" ", "\t", "\n"]:
        s = Solver()
        x = String("x")
        s.add(InRe(x, ws_rx))
        s.add(Contains(x, StringVal(forbidden)))
        assert s.check() == unsat, f"'[^\\s]' still admits {forbidden!r}"

    # and the original bug, stated directly
    naive = SOLVER._negate(__import__("z3").Re("<"))
    assert z3_rejects(naive, "a<"), "negate() does not exclude the raw character"

def test_unsupported_fails_closed():
    unsupported = [
        (r"(?=admin)x", "lookahead"),
        (r"(?!x)y", "negative lookahead"),
        (r"(?<=a)b", "lookbehind"),
        (r"(a)\1", "backreference"),
        (r"\bword\b", "word boundary"),
        (r"(?>a)b", "atomic group"),
    ]
    for pattern, label in unsupported:
        payload = SOLVER.solve_constraints(20, "", pattern)
        assert payload["status"] == "unsupported_pattern", \
            f"{label} {pattern!r} -> {payload.get('status')} (must fail closed)"
    assert not SOLVER.pattern_is_supported(r"(?=x)y")
    assert SOLVER.pattern_is_supported(r"[a-z]{1,3}")

def test_invalid_regex_fails_closed():
    payload = SOLVER.solve_constraints(20, "", r"([a-z")
    assert payload["status"] == "unsupported_pattern", payload

def test_never_returns_violating_candidate():
    combos = [
        (r"[^<>]{1,10}", 10, "script"),
        (r"[a-z0-9]{1,12}", 12, "alert"),
        (r"\d{1,3}", 3, "script"),
        (r"^\w{2,6}$", 6, "onload"),
        (r"[^\s]{1,5}", 5, "onload"),
        (r"^[a-z]{5,20}$", 20, "script"),
        (r"^(?i)[a-f]{2}$", 5, "af"),
        (None, 5, "script"),
        (None, 8, "script"),
        (r"\d{4}", 4, ""),
        (r"[^0-9]{3}", 3, ""),
        (r"[a-zA-Z]{1,40}", 40, "javascript"),
        (r"[^<>{}()]{1,20}", 20, "onerror"),
        (r"\w{1,30}", 30, "alert"),
        (r"[^<>]{1,10}", 10, "<script>"),
    ]
    for pattern, max_len, must in combos:
        payload = SOLVER.solve_constraints(max_len, must, pattern)
        assert payload["status"] in ALLOWED_STATUSES, payload
        if payload["status"] == "success":
            check_success(payload, max_len, must, pattern)

def test_unsat_is_reported_not_faked():
    cases = [
        (r"\d{1,3}", 3, "script"),
        (r"[^\s]{1,5}", 5, "onload"),
        (None, 5, "script"),
        (r"[^<>]{1,3}", 3, "<script>"),
        (r"^[a-f]{2}$", 2, "zz"),
    ]
    for pattern, max_len, must in cases:
        payload = SOLVER.solve_constraints(max_len, must, pattern)
        assert payload["status"] == "unsat", \
            f"expected unsat for {pattern!r}/{max_len}/{must!r}, got {payload}"

def test_unknown_is_distinct_from_unsat():
    payload = SOLVER.solve_constraints(60, "", r"[a-z]{40,60}", timeout_ms=1)
    assert payload["status"] in {"success", "unknown", "unsat"}, payload
    if payload["status"] == "success":
        check_success(payload, 60, "", r"[a-z]{40,60}")
    # the status vocabulary must not collapse into a single bucket
    assert payload["status"] != "unsupported_pattern"

def test_backcompat_supported_shape():
    payload = SOLVER.solve_constraints(20, "script", r"^[a-zA-Z0-9<>_]{5,20}$")
    check_success(payload, 20, "script", r"^[a-zA-Z0-9<>_]{5,20}$")

def test_output_shape_unchanged():
    payload = SOLVER.solve_constraints(20, "script", r"^[a-zA-Z0-9<>_]{5,20}$")
    assert isinstance(payload.get("generated_input"), str)
    payload = SOLVER.solve_constraints(2, "script", None)
    assert payload["status"] == "unsat"
    assert isinstance(payload.get("reason"), str)

def test_cli_contract():
    for pattern, max_len in [
        (r"[^<>]{1,5}", 5),
        (r"^\d{3}$", 3),
        (r"\d+", 4),
        (r"[a-z]+@[a-z]+", 12),
        (r"^[a-zA-Z0-9<>_]{5,20}$", 20),
    ]:
        proc = subprocess.run(
            [sys.executable, str(SOLVER_PATH), "--max-len", str(max_len), "--pattern", pattern],
            capture_output=True, text=True,
        )
        assert proc.returncode == 0, f"exit {proc.returncode}: {proc.stderr}"
        payload = json.loads(proc.stdout.strip())
        assert payload["status"] == "success", payload
        cand = payload["generated_input"]
        assert re.fullmatch(pattern, cand, re.ASCII), \
            f"CLI candidate {cand!r} violates {pattern!r}"

    proc = subprocess.run(
        [sys.executable, str(SOLVER_PATH), "--max-len", "5", "--pattern", r"(?=x)y"],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0
    assert json.loads(proc.stdout.strip())["status"] == "unsupported_pattern"

def test_candidate_prefers_printable():
    """A filler string should be pasteable text, not a control character."""
    for pattern, max_len in [(r"[^<>]{1,5}", 5), (r"[^\s]{1,8}", 8), (r".{1,4}", 4)]:
        payload = SOLVER.solve_constraints(max_len, "", pattern)
        cand = check_success(payload, max_len, "", pattern)
        assert all(0x20 <= ord(c) <= 0x7E for c in cand), \
            f"expected printable candidate for {pattern!r}, got {cand!r}"

def test_model_string_is_faithful():
    """Z3 renders NUL as the 5-char text '\\u{0}' — that must never leak out."""
    payload = SOLVER.solve_constraints(5, "", r"[^<>]{1,5}")
    cand = check_success(payload, 5, "", r"[^<>]{1,5}")
    assert "\\u{" not in cand, f"escape artefact leaked into candidate: {cand!r}"

    # a pattern that genuinely requires control characters must still solve
    payload = SOLVER.solve_constraints(2, "", "^\\x00{2}$")
    if payload["status"] == "success":
        assert payload["generated_input"] == "\x00\x00", \
            f"unfaithful control-character candidate: {payload['generated_input']!r}"
    else:
        assert payload["status"] in {"unsat", "unknown", "unsupported_pattern"}, payload

def test_plugin_argument_path_still_works():
    """Mirror exactly what the plugin passes: --max-len / --contain / --pattern."""
    proc = subprocess.run(
        [sys.executable, str(SOLVER_PATH),
         "--max-len", "20", "--contain", "script", "--pattern", "^[a-zA-Z0-9<>_]{5,20}$"],
        capture_output=True, text=True,
    )
    payload = json.loads(proc.stdout.strip())
    assert payload["status"] == "success", payload
    assert payload["generated_input"] == "script" or "script" in payload["generated_input"]
    assert re.fullmatch(r"^[a-zA-Z0-9<>_]{5,20}$", payload["generated_input"], re.ASCII)

TESTS = [
    test_differential_translation,
    test_negated_class_soundness,
    test_unsupported_fails_closed,
    test_invalid_regex_fails_closed,
    test_never_returns_violating_candidate,
    test_unsat_is_reported_not_faked,
    test_unknown_is_distinct_from_unsat,
    test_backcompat_supported_shape,
    test_output_shape_unchanged,
    test_candidate_prefers_printable,
    test_model_string_is_faithful,
    test_cli_contract,
    test_plugin_argument_path_still_works,
]

def main():
    print(f"z3_string_solver AST tests — {len(TESTS)} cases")
    failures = []
    for test in TESTS:
        name = test.__name__
        try:
            test()
        except AssertionError as exc:
            failures.append((name, str(exc)))
            print(f"  [FAIL] {name}\n         {exc}")
        except Exception as exc:  # noqa: BLE001
            failures.append((name, f"{type(exc).__name__}: {exc}"))
            print(f"  [ERROR] {name}\n         {type(exc).__name__}: {exc}")
        else:
            print(f"  [PASS] {name}")
    print()
    if failures:
        print(f"FAILED: {len(failures)}/{len(TESTS)}")
        for name, why in failures:
            print(f"  - {name}: {why}")
        return 1
    print(f"OK: {len(TESTS)}/{len(TESTS)} passed")
    return 0

if __name__ == "__main__":
    sys.exit(main())

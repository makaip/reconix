"""Z3 String Constraint Solver for Web Inputs.

Solves for the shortest/any string satisfying a length bound, an optional
required substring, and an optional regex pattern — used to bypass strict
client-side input validation.

Design notes (why this file looks the way it does):

1. The regex is parsed into a real AST (`re._parser.parse`) and walked into Z3
   regex terms. The previous implementation matched exactly one pattern shape
   with a hand-rolled `re.match` and silently DROPPED the constraint for
   anything else, returning `status: success` with a candidate that violated
   the requested pattern.
2. Unsupported constructs fail CLOSED. Anything outside the regular languages
   Z3 can express (backreferences, lookaround, word boundaries, atomic groups)
   produces `status: unsupported_pattern` — never a silently weaker solve.
3. Negated character classes are NOT translated with bare `Complement`.
   Z3's `Complement` is over the *string* sort, so `Complement({<,>})` means
   "all strings except exactly '<' and '>'" — it admits '', '<<', 'abc',
   '<script>'. A negated class is therefore built as
   `Intersect(Complement(chars), ANY_CHAR)` where ANY_CHAR is the set of all
   single BMP characters.
4. Every candidate is re-verified against the original pattern with Python's
   own `re.fullmatch` before being returned. If verification fails the
   candidate is blocked and the solver retries; if nothing survives, the tool
   reports an error rather than returning a violating string.
5. The pattern is parsed with `re.ASCII` so `\\d`, `\\w`, `\\s` match
   JavaScript's ASCII semantics rather than Python's Unicode defaults.
6. `InRe` (fullmatch) is used, not `Contains`, matching the fact that the HTML
   `pattern` attribute is implicitly anchored.
7. Candidates prefer printable ASCII (solved in a second pass if a pattern
   genuinely requires control characters), and model strings are extracted
   faithfully: Z3 renders NUL as the five-character text '\\u{0}', which would
   otherwise be returned as a bogus candidate.
"""
import argparse
import json
import re
import sys
from re import _parser as sre_parse

from z3 import (
    Complement,
    Concat,
    Contains,
    InRe,
    Intersect,
    Length,
    Loop,
    Plus,
    Range,
    Re,
    Solver,
    Star,
    String,
    StringVal,
    Union,
    sat,
    unknown as Z3_UNKNOWN,
)

ASCII_FLAGS = re.ASCII
DEFAULT_TIMEOUT_MS = 10_000
MAX_ATTEMPTS = 8

class UnsupportedPattern(Exception):
    """Raised for regex constructs Z3's regex theory cannot express."""

def _any_char():
    """The set of all single BMP characters.

    NOTE: `Range('\\x00', '\\U0010ffff')` is SILENTLY BROKEN in Z3 5.3.1 — it
    does not even contain 'a'. Bounding at BMP works. Astral-plane characters
    are therefore not representable, which is fine for web form inputs.
    """
    return Loop(Range("\x00", "\uffff"), 1, 1)

ANY_CHAR = _any_char()

def _negate(rx):
    """Complement a character class *within single characters*."""
    return Intersect(Complement(rx), ANY_CHAR)

_CATEGORY_POSITIVE = {}
_CATEGORY_NEGATED = {}

def _init_categories():
    digit = Range("0", "9")
    word = Union(Range("a", "z"), Range("A", "Z"), Range("0", "9"), Re("_"))
    space = Union(*(Re(c) for c in " \t\n\r\f\v"))
    pairs = [
        ("CATEGORY_DIGIT", digit),
        ("CATEGORY_WORD", word),
        ("CATEGORY_SPACE", space),
    ]
    for name, rx in pairs:
        op = getattr(sre_parse, name, None)
        if op is not None:
            _CATEGORY_POSITIVE[op] = rx
            neg = getattr(sre_parse, name.replace("CATEGORY_", "CATEGORY_NOT_"), None)
            if neg is not None:
                _CATEGORY_NEGATED[neg] = _negate(rx)


_init_categories()

def _name(op):
    return str(op)

def _literal(ch, ignore_case):
    if ignore_case and ch.isalpha() and ch.lower() != ch.upper():
        return Union(Re(ch.lower()), Re(ch.upper()))
    return Re(ch)

def _range(lo, hi, ignore_case):
    rx = Range(lo, hi)
    if ignore_case:
        lo2, hi2 = lo.swapcase(), hi.swapcase()
        if len(lo2) == 1 and len(hi2) == 1 and lo2 <= hi2:
            rx = Union(rx, Range(lo2, hi2))
    return rx

def _category(item):
    if item in _CATEGORY_POSITIVE:
        return _CATEGORY_POSITIVE[item]
    if item in _CATEGORY_NEGATED:
        return _CATEGORY_NEGATED[item]
    raise UnsupportedPattern(f"character category {_name(item)}")

def _walk_in(items, ignore_case):
    negated = False
    alts = []
    for op, item in items:
        if op is sre_parse.NEGATE:
            negated = True
        elif op is sre_parse.LITERAL:
            alts.append(_literal(chr(item), ignore_case))
        elif op is sre_parse.RANGE:
            alts.append(_range(chr(item[0]), chr(item[1]), ignore_case))
        elif op is sre_parse.CATEGORY:
            alts.append(_category(item))
        elif op is sre_parse.IN:
            alts.append(_walk_in(item, ignore_case))
        else:
            raise UnsupportedPattern(f"character-class item {_name(op)}")
    if not alts:
        raise UnsupportedPattern("empty character class")
    union = alts[0] if len(alts) == 1 else Union(*alts)
    return _negate(union) if negated else union

# Anchors that become implicit once the whole string must match (InRe).
_PURE_ANCHORS = {
    getattr(sre_parse, n)
    for n in ("AT_BEGINNING", "AT_BEGINNING_STRING", "AT_END", "AT_END_STRING")
    if hasattr(sre_parse, n)
}

def _walk(sub):
    state = getattr(sub, "state", None)
    flags = getattr(state, "flags", ASCII_FLAGS)
    ignore_case = bool(flags & re.IGNORECASE)
    dot_all = bool(flags & re.DOTALL)

    parts = []
    for op, av in sub:
        if op is sre_parse.LITERAL:
            parts.append(_literal(chr(av), ignore_case))
        elif op is sre_parse.NOT_LITERAL:
            parts.append(_negate(_literal(chr(av), ignore_case)))
        elif op is sre_parse.ANY:
            parts.append(ANY_CHAR if dot_all else _negate(Re("\n")))
        elif op is sre_parse.IN:
            parts.append(_walk_in(av, ignore_case))
        elif op is sre_parse.CATEGORY:
            parts.append(_category(av))
        elif op in (sre_parse.MAX_REPEAT, sre_parse.MIN_REPEAT):
            lo, hi, inner_sub = av
            inner = _walk(inner_sub)
            if hi == sre_parse.MAXREPEAT:
                if lo == 0:
                    parts.append(Star(inner))
                elif lo == 1:
                    parts.append(Plus(inner))
                else:
                    parts.append(Concat(*([inner] * lo), Star(inner)))
            else:
                parts.append(Loop(inner, lo, hi))
        elif op is sre_parse.SUBPATTERN:
            parts.append(_walk(av[-1]))  # (group, add_flags, del_flags, subpattern)
        elif op is sre_parse.BRANCH:
            branches = av[1]
            parts.append(Union(*[_walk(b) for b in branches]))
        elif op is sre_parse.AT:
            if av in _PURE_ANCHORS:
                continue
            raise UnsupportedPattern(
                f"anchor {_name(av)} (word boundaries are not regular)"
            )
        else:
            raise UnsupportedPattern(f"construct {_name(op)}")

    if not parts:
        return Re("")
    return parts[0] if len(parts) == 1 else Concat(*parts)

def compile_regex(pattern, flags=ASCII_FLAGS):
    """Compile a Python regex into a Z3 regex term, or raise UnsupportedPattern."""
    try:
        tree = sre_parse.parse(pattern, flags)
    except re.error as exc:
        raise UnsupportedPattern(f"invalid regex: {exc}") from exc
    return _walk(tree)

def pattern_is_supported(pattern):
    """True if `pattern` can be translated faithfully into Z3."""
    try:
        compile_regex(pattern)
        return True
    except UnsupportedPattern:
        return False

def verify(candidate, max_len, must_contain, pattern):
    """Re-check a candidate against the ORIGINAL constraints using Python's engine.

    This is the safety net: even if the translation is subtly wrong, no
    violating candidate can be returned as `success`.
    """
    if max_len is not None and len(candidate) > max_len:
        return False, f"length {len(candidate)} exceeds maxLength {max_len}"
    if must_contain and must_contain not in candidate:
        return False, "required substring missing"
    if pattern and not re.fullmatch(pattern, candidate, ASCII_FLAGS):
        return False, "candidate does not satisfy the requested pattern"
    return True, ""

# Z3 renders some non-printable characters in a lossy escape form: NUL comes
# back as the FIVE-character string '\\u{0}', not as chr(0). Detect it by
# comparing the rendered length against the model's own Length() value.
_Z3_ESCAPE = re.compile(r"\\u\{([0-9a-fA-F]{1,6})\}")

# Printable ASCII (0x20-0x7E). Preferred for candidates: a filler string a
# human can paste into a form, instead of a control character.
_PRINTABLE_STRING = Star(Range(" ", "~"))

def _decode_z3_escapes(text):
    return _Z3_ESCAPE.sub(lambda m: chr(int(m.group(1), 16)), text)

def _model_string(model, var):
    """Extract the model's string faithfully, undoing Z3's lossy escaping."""
    value = model.eval(var)
    rendered = value.as_string()
    try:
        model_len = model.eval(Length(var)).as_long()
    except Exception:  # noqa: BLE001 - non-concrete length evaluator
        return rendered
    if len(rendered) != model_len:
        decoded = _decode_z3_escapes(rendered)
        if len(decoded) == model_len:
            return decoded
    return rendered

def _solve_with(compiled, max_len, must_contain, pattern, timeout_ms, printable_only):
    """One solve attempt pass. Returns a result dict."""
    user_input = String("user_input")
    solver = Solver()
    solver.set("timeout", timeout_ms)

    solver.add(Length(user_input) <= max_len)
    if compiled is not None:
        solver.add(InRe(user_input, compiled))
    else:
        # Without a pattern nothing pins the string down; an empty answer would
        # be useless, so require at least one character.
        solver.add(Length(user_input) >= 1)
    if must_contain:
        solver.add(Contains(user_input, StringVal(must_contain)))
    if printable_only:
        solver.add(InRe(user_input, _PRINTABLE_STRING))

    for attempt in range(MAX_ATTEMPTS):
        result = solver.check()

        if result == sat:
            candidate = _model_string(solver.model(), user_input)
            ok, _why = verify(candidate, max_len, must_contain, pattern)
            if ok:
                return {
                    "status": "success",
                    "generated_input": candidate,
                    "verified": True,
                    "attempts": attempt + 1,
                    "printable": printable_only,
                }
            # Block this candidate and look for another.
            solver.add(user_input != StringVal(candidate))
            continue

        if result == Z3_UNKNOWN:
            return {"status": "unknown",
                    "reason": "solver could not decide within the time limit"}

        return {"status": "unsat",
                "reason": "No string satisfies the given constraints."}

    return {"status": "error",
            "reason": f"no candidate survived verification in {MAX_ATTEMPTS} attempts"}

def solve_constraints(max_len, must_contain="", pattern=None, timeout_ms=DEFAULT_TIMEOUT_MS):
    constraints = {"maxLength": max_len, "mustContain": must_contain, "pattern": pattern}

    if pattern:
        try:
            compiled = compile_regex(pattern)
        except UnsupportedPattern as exc:
            return {
                "status": "unsupported_pattern",
                "reason": str(exc),
                "constraints": constraints,
            }
    else:
        compiled = None

    # Pass 1 prefers printable ASCII; pass 2 is unconstrained, so patterns that
    # genuinely require control characters still solve.
    for printable_only in (True, False):
        result = _solve_with(compiled, max_len, must_contain, pattern,
                             timeout_ms, printable_only)
        if result["status"] == "success":
            result["constraints"] = constraints
            return result
        if printable_only:
            first = result  # keep the printable pass verdict as a fallback

    # Neither pass succeeded; report the more informative verdict.
    if result["status"] == "unsat" and first["status"] == "unknown":
        result = first
    result.pop("printable", None)
    result["constraints"] = constraints
    return result

def main(argv=None):
    parser = argparse.ArgumentParser(description="Z3 String Constraint Solver for Web Inputs")
    parser.add_argument("--max-len", type=int, default=50, help="Maximum allowed length")
    parser.add_argument("--contain", type=str, default="", help="Substring that must be present")
    parser.add_argument("--pattern", type=str, default=None, help="Regex pattern restriction")
    parser.add_argument("--timeout-ms", type=int, default=DEFAULT_TIMEOUT_MS,
                        help="Solver timeout in milliseconds")
    args = parser.parse_args(argv)

    output = solve_constraints(args.max_len, args.contain, args.pattern, args.timeout_ms)
    print(json.dumps(output))
    return 0

if __name__ == "__main__":
    sys.exit(main())

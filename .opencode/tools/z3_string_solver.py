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
8. Additional constraint kinds are all enforced BOTH in the Z3 model and in
   `verify()`: minimum length, negative substrings (`Not(Contains(...))`),
   multiple patterns (each `InRe`, i.e. ANDed), an allowed character set, and
   explicitly forbidden characters. Verification still runs last and is the
   authority, so a translation bug cannot produce a `success` that violates a
   constraint the caller asked for.
9. Numeric mode (`--numeric`) solves an `Int` instead of a `String`. The digit
   budget from `--max-len` becomes an upper bound (`10**max_len - 1`, capped at
   10**18 - 1) when `--int-max` is not supplied, and each candidate is
   re-verified against the numeric constraints with plain Python arithmetic.
10. Batch mode (`--count N`) blocks each accepted model (`x != previous`) and
    re-solves, so the returned candidates are guaranteed distinct.
11. Verification is fail-closed: unsupported patterns, unsatisfiable
    constraint sets, and exhausted retries are reported distinctly and never
    degrade into an unverified "success".
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
    Int,
    Intersect,
    Length,
    Loop,
    Not,
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
DEFAULT_MAX_LEN = 50
MAX_ATTEMPTS = 8
# Sanity cap for the upper bound derived from --max-len in numeric mode.
INT_CAP = 10**18 - 1

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

def _dedupe(items):
    """Stable de-duplication that keeps the caller's ordering."""
    seen = []
    for item in items or []:
        if item not in seen:
            seen.append(item)
    return seen

def _normalise_patterns(pattern, patterns):
    """Merge the legacy single `pattern` argument with the repeatable list."""
    raw = []
    if isinstance(pattern, (list, tuple)):
        raw.extend(pattern)
    elif pattern:
        raw.append(pattern)
    if patterns:
        raw.extend([patterns] if isinstance(patterns, str) else patterns)
    return [p for p in _dedupe(raw) if isinstance(p, str) and p]

def _charset_regex(chars):
    """A regex matching strings composed only of `chars` (possibly empty)."""
    alts = [Re(c) for c in chars]
    if not alts:
        # No permitted characters at all: only the empty string can match.
        return Re("")
    return Star(alts[0] if len(alts) == 1 else Union(*alts))

def verify(candidate, max_len, must_contain, pattern, min_len=0,
           must_not_contain=None, patterns=None, charset=None,
           forbidden_chars=None):
    """Re-check a candidate against the ORIGINAL constraints using Python's engine.

    This is the safety net: even if the translation is subtly wrong, no
    violating candidate can be returned as `success`.
    """
    if max_len is not None and len(candidate) > max_len:
        return False, f"length {len(candidate)} exceeds maxLength {max_len}"
    if min_len and len(candidate) < min_len:
        return False, f"length {len(candidate)} is below minLength {min_len}"
    if must_contain and must_contain not in candidate:
        return False, "required substring missing"
    for forbidden in must_not_contain or []:
        if forbidden and forbidden in candidate:
            return False, f"forbidden substring present: {forbidden!r}"
    if charset is not None:
        allowed = set(charset)
        if any(ch not in allowed for ch in candidate):
            return False, "candidate uses characters outside the allowed charset"
    if forbidden_chars:
        barred = set(forbidden_chars)
        if any(ch in barred for ch in candidate):
            return False, "candidate contains a forbidden character"
    for pat in _normalise_patterns(pattern, patterns):
        if not re.fullmatch(pat, candidate, ASCII_FLAGS):
            return False, "candidate does not satisfy the requested pattern"
    return True, ""

def verify_number(value, low, high, mod=None, mod_remainder=0,
                  divisible_by=None, must_equal=None):
    """Re-check a numeric candidate with plain Python arithmetic."""
    if low is not None and value < low:
        return False, f"{value} is below the lower bound {low}"
    if high is not None and value > high:
        return False, f"{value} is above the upper bound {high}"
    if must_equal is not None and value != must_equal:
        return False, f"{value} does not equal {must_equal}"
    if mod is not None and value % mod != mod_remainder % mod:
        return False, f"{value} is not congruent to {mod_remainder} mod {mod}"
    if divisible_by is not None and value % divisible_by != 0:
        return False, f"{value} is not divisible by {divisible_by}"
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

def _solve_with(compiled_patterns, max_len, must_contain, pattern, timeout_ms,
                printable_only, min_len=0, must_not_contain=None,
                charset=None, forbidden_chars=None, count=1):
    """One solve attempt pass. Returns a result dict.

    `compiled_patterns` is a list of Z3 regex terms; every one of them must
    match (they are ANDed), mirroring repeated `--pattern` arguments.
    """
    user_input = String("user_input")
    solver = Solver()
    solver.set("timeout", timeout_ms)

    solver.add(Length(user_input) <= max_len)
    for compiled in compiled_patterns:
        solver.add(InRe(user_input, compiled))
    if not compiled_patterns and not min_len:
        # Without a pattern nothing pins the string down; an empty answer would
        # be useless, so require at least one character.
        solver.add(Length(user_input) >= 1)
    if min_len:
        solver.add(Length(user_input) >= min_len)
    if must_contain:
        solver.add(Contains(user_input, StringVal(must_contain)))
    for forbidden in must_not_contain or []:
        if forbidden:
            solver.add(Not(Contains(user_input, StringVal(forbidden))))
    if charset is not None:
        solver.add(InRe(user_input, _charset_regex(_dedupe(charset))))
    for ch in _dedupe(forbidden_chars or ""):
        solver.add(Not(Contains(user_input, StringVal(ch))))
    if printable_only:
        solver.add(InRe(user_input, _PRINTABLE_STRING))

    found = []
    attempts = 0
    while len(found) < max(count, 1):
        progressed = False
        for _ in range(MAX_ATTEMPTS):
            attempts += 1
            result = solver.check()

            if result == sat:
                candidate = _model_string(solver.model(), user_input)
                # Block this candidate so a batch solve yields distinct values
                # and a failed verification cannot loop forever.
                solver.add(user_input != StringVal(candidate))
                ok, _why = verify(
                    candidate, max_len, must_contain, pattern,
                    min_len=min_len, must_not_contain=must_not_contain,
                    patterns=None, charset=charset,
                    forbidden_chars=forbidden_chars,
                )
                if ok and candidate not in found:
                    found.append(candidate)
                    progressed = True
                    break
                continue

            if result == Z3_UNKNOWN:
                if found:
                    return {"status": "success", "candidates": found,
                            "attempts": attempts, "printable": printable_only}
                return {"status": "unknown",
                        "reason": "solver could not decide within the time limit"}

            # unsat
            if found:
                return {"status": "success", "candidates": found,
                        "attempts": attempts, "printable": printable_only}
            return {"status": "unsat",
                    "reason": "No string satisfies the given constraints."}

        if not progressed:
            if found:
                return {"status": "success", "candidates": found,
                        "attempts": attempts, "printable": printable_only}
            return {"status": "error",
                    "reason": f"no candidate survived verification in {MAX_ATTEMPTS} attempts"}

    return {"status": "success", "candidates": found,
            "attempts": attempts, "printable": printable_only}

def _numeric_bounds(max_len, int_min, int_max):
    """Resolve the numeric search window.

    Without an explicit `int_max`, --max-len is treated as a digit budget for
    the field, which is exactly what a `maxlength=3` numeric input means.
    """
    low = 0 if int_min is None else int_min
    if int_max is not None:
        high = int_max
    elif max_len is None or max_len <= 0:
        high = 0
    elif max_len > 18:
        high = INT_CAP
    else:
        high = min(10**max_len - 1, INT_CAP)
    return low, high

def _solve_numeric(low, high, int_mod, int_mod_remainder, int_divisible_by,
                   int_must_equal, timeout_ms, count):
    """Solve for an integer inside the requested bounds. Returns a result dict."""
    number = Int("generated_number")
    solver = Solver()
    solver.set("timeout", timeout_ms)

    solver.add(number >= low)
    solver.add(number <= high)
    if int_must_equal is not None:
        solver.add(number == int_must_equal)
    if int_mod is not None:
        solver.add(number % int_mod == int_mod_remainder)
    if int_divisible_by is not None:
        solver.add(number % int_divisible_by == 0)

    found = []
    attempts = 0
    while len(found) < max(count, 1):
        progressed = False
        for _ in range(MAX_ATTEMPTS):
            attempts += 1
            result = solver.check()

            if result == sat:
                value = solver.model().eval(number).as_long()
                solver.add(number != value)
                ok, _why = verify_number(
                    value, low, high, int_mod, int_mod_remainder,
                    int_divisible_by, int_must_equal,
                )
                if ok and value not in found:
                    found.append(value)
                    progressed = True
                    break
                continue

            if result == Z3_UNKNOWN:
                if found:
                    return {"status": "success", "numbers": found,
                            "attempts": attempts}
                return {"status": "unknown",
                        "reason": "solver could not decide within the time limit"}

            if found:
                return {"status": "success", "numbers": found,
                        "attempts": attempts}
            return {"status": "unsat",
                    "reason": "No integer satisfies the given constraints."}

        if not progressed:
            if found:
                return {"status": "success", "numbers": found,
                        "attempts": attempts}
            return {"status": "error",
                    "reason": f"no candidate survived verification in {MAX_ATTEMPTS} attempts"}

    return {"status": "success", "numbers": found, "attempts": attempts}

def solve_constraints(max_len, must_contain="", pattern=None,
                      timeout_ms=DEFAULT_TIMEOUT_MS, *, min_len=0,
                      must_not_contain=None, patterns=None, charset=None,
                      forbidden_chars=None, numeric=False, int_min=None,
                      int_max=None, int_mod=None, int_mod_remainder=0,
                      int_divisible_by=None, int_must_equal=None, count=1):
    """Solve the requested constraint set.

    The first four parameters keep their historical positional meaning so
    existing callers (plugin, tests) are unaffected.
    """
    try:
        count = int(count)
    except (TypeError, ValueError):
        return {"status": "error", "reason": "count must be an integer"}
    if count < 1:
        return {"status": "error", "reason": "count must be >= 1"}

    must_not_contain = [s for s in _dedupe(must_not_contain or []) if s]
    pats = _normalise_patterns(pattern, patterns)
    if charset is not None:
        charset = "".join(_dedupe(charset))
    if forbidden_chars is not None:
        forbidden_chars = "".join(_dedupe(forbidden_chars))

    if numeric:
        return _solve_numeric_mode(
            max_len, must_contain, pats, timeout_ms, min_len,
            must_not_contain, charset, forbidden_chars, int_min, int_max,
            int_mod, int_mod_remainder, int_divisible_by, int_must_equal,
            count,
        )

    constraints = {
        "maxLength": max_len,
        "mustContain": must_contain,
        "pattern": pats[0] if len(pats) == 1 else None,
    }
    if min_len:
        constraints["minLength"] = min_len
    if must_not_contain:
        constraints["mustNotContain"] = list(must_not_contain)
    if len(pats) > 1:
        constraints["patterns"] = list(pats)
    if charset is not None:
        constraints["charset"] = charset
    if forbidden_chars:
        constraints["forbiddenChars"] = forbidden_chars
    if count > 1:
        constraints["count"] = count

    if min_len > max_len:
        return {
            "status": "unsat",
            "reason": f"minLength {min_len} exceeds maxLength {max_len}",
            "constraints": constraints,
        }

    compiled_patterns = []
    for pat in pats:
        try:
            compiled_patterns.append(compile_regex(pat))
        except UnsupportedPattern as exc:
            return {
                "status": "unsupported_pattern",
                "reason": f"{pat!r}: {exc}" if len(pats) > 1 else str(exc),
                "constraints": constraints,
            }

    # Pass 1 prefers printable ASCII; pass 2 is unconstrained, so patterns that
    # genuinely require control characters still solve. A caller-supplied
    # charset already pins the alphabet, so the printable pass is pointless.
    passes = [True, False] if charset is None else [False]
    first = None
    result = None
    for printable_only in passes:
        result = _solve_with(
            compiled_patterns, max_len, must_contain,
            pats[0] if len(pats) == 1 else pats, timeout_ms, printable_only,
            min_len=min_len, must_not_contain=must_not_contain,
            charset=charset, forbidden_chars=forbidden_chars, count=count,
        )
        if result["status"] == "success":
            return _format_string_result(result, constraints, count)
        if first is None:
            first = result

    # Neither pass succeeded; report the more informative verdict.
    if result is None:
        result = first
    if result["status"] == "unsat" and first["status"] == "unknown":
        result = first
    result.pop("printable", None)
    result["constraints"] = constraints
    return result

def _format_string_result(raw, constraints, count):
    """Shape a successful string solve for the CLI/plugin contract."""
    candidates = raw["candidates"]
    output = {"status": "success"}
    if count > 1:
        output["generated_inputs"] = candidates
        output["count"] = len(candidates)
        output["requested"] = count
    else:
        output["generated_input"] = candidates[0]
    output["verified"] = True
    output["attempts"] = raw["attempts"]
    output["printable"] = raw.get("printable", False)
    output["constraints"] = constraints
    return output

def _solve_numeric_mode(max_len, must_contain, pats, timeout_ms, min_len,
                        must_not_contain, charset, forbidden_chars, int_min,
                        int_max, int_mod, int_mod_remainder, int_divisible_by,
                        int_must_equal, count):
    """Numeric branch of `solve_constraints` (see module docstring, note 9)."""
    ignored = []
    if pats:
        ignored.append("pattern")
    if must_contain:
        ignored.append("mustContain")
    if min_len:
        ignored.append("minLength")
    if must_not_contain:
        ignored.append("mustNotContain")
    if charset is not None:
        ignored.append("charset")
    if forbidden_chars:
        ignored.append("forbiddenChars")

    low, high = _numeric_bounds(max_len, int_min, int_max)
    constraints = {
        "numeric": True,
        "maxLength": max_len,
        "intMin": low,
        "intMax": high,
    }
    if int_mod is not None:
        constraints["intMod"] = int_mod
        constraints["intModRemainder"] = int_mod_remainder
    if int_divisible_by is not None:
        constraints["intDivisibleBy"] = int_divisible_by
    if int_must_equal is not None:
        constraints["intMustEqual"] = int_must_equal
    if ignored:
        constraints["ignored"] = ignored
    if count > 1:
        constraints["count"] = count

    if int_mod is not None and int_mod <= 0:
        return {"status": "error",
                "reason": "int-mod requires a positive modulus",
                "constraints": constraints}
    if int_divisible_by is not None and int_divisible_by <= 0:
        return {"status": "error",
                "reason": "int-divisible-by requires a positive divisor",
                "constraints": constraints}
    if low > high:
        return {"status": "unsat",
                "reason": f"lower bound {low} exceeds upper bound {high}",
                "constraints": constraints}

    raw = _solve_numeric(low, high, int_mod, int_mod_remainder,
                         int_divisible_by, int_must_equal, timeout_ms, count)
    if raw["status"] != "success":
        raw["constraints"] = constraints
        return raw

    numbers = raw["numbers"]
    output = {"status": "success", "generated_number": numbers[0]}
    if count > 1:
        output["generated_numbers"] = numbers
        output["count"] = len(numbers)
        output["requested"] = count
    output["verified"] = True
    output["attempts"] = raw["attempts"]
    output["constraints"] = constraints
    return output

def main(argv=None):
    parser = argparse.ArgumentParser(description="Z3 String Constraint Solver for Web Inputs")
    parser.add_argument("--max-len", type=int, default=DEFAULT_MAX_LEN,
                        help="Maximum allowed length (digit budget in --numeric mode)")
    parser.add_argument("--min-len", type=int, default=0,
                        help="Minimum allowed length (default: 0)")
    parser.add_argument("--contain", type=str, default="", help="Substring that must be present")
    parser.add_argument("--must-not-contain", type=str, action="append",
                        dest="must_not_contain", default=None,
                        help="Substring that must NOT be present (repeatable)")
    parser.add_argument("--pattern", type=str, action="append", default=None,
                        help="Regex pattern restriction; repeat to require all patterns")
    parser.add_argument("--charset", type=str, default=None,
                        help="Restrict the candidate to these characters")
    parser.add_argument("--forbidden-chars", type=str, default=None,
                        help="Characters that must never appear")
    parser.add_argument("--numeric", action="store_true",
                        help="Solve for an integer instead of a string")
    parser.add_argument("--int-min", type=int, default=None,
                        help="Numeric mode lower bound (default: 0)")
    parser.add_argument("--int-max", type=int, default=None,
                        help="Numeric mode upper bound (default: 10**max_len - 1)")
    parser.add_argument("--int-mod", type=int, default=None,
                        help="Require n %% modulus == remainder")
    parser.add_argument("--int-mod-remainder", type=int, default=0,
                        help="Remainder for --int-mod (default: 0)")
    parser.add_argument("--int-divisible-by", type=int, default=None,
                        help="Require n to be divisible by this value")
    parser.add_argument("--int-must-equal", type=int, default=None,
                        help="Require n to equal this exact value")
    parser.add_argument("--count", type=int, default=1,
                        help="Number of distinct candidates to generate (default: 1)")
    parser.add_argument("--timeout-ms", type=int, default=DEFAULT_TIMEOUT_MS,
                        help="Solver timeout in milliseconds")
    args = parser.parse_args(argv)

    output = solve_constraints(
        args.max_len,
        args.contain,
        None,
        args.timeout_ms,
        min_len=args.min_len,
        must_not_contain=args.must_not_contain,
        patterns=args.pattern,
        charset=args.charset,
        forbidden_chars=args.forbidden_chars,
        numeric=args.numeric,
        int_min=args.int_min,
        int_max=args.int_max,
        int_mod=args.int_mod,
        int_mod_remainder=args.int_mod_remainder,
        int_divisible_by=args.int_divisible_by,
        int_must_equal=args.int_must_equal,
        count=args.count,
    )
    print(json.dumps(output))
    return 0

if __name__ == "__main__":
    sys.exit(main())

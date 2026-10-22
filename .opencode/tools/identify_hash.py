#!/usr/bin/env python3
"""Identify a hash type from its textual shape and emit a crack strategy.

Invoked by the `identify_hash` MCP tool (src/main/mcp/tools/identify_hash.ts):

    python identify_hash.py --hash <hash_string>

Writes exactly one JSON object to stdout and nothing else. Diagnostics go to
stderr with a non-zero exit code, so the caller can distinguish "could not
run" from "ran, nothing matched".

Design notes:

1. Rules are ordered most-specific first. Structural prefixes (bcrypt, argon2,
   MySQL 4.1+) are checked before length-based hex rules, because a length
   alone is a weak signal and an explicit prefix is not.
2. A hash can be genuinely ambiguous: a 32-character hex string is an MD5 by
   length, but an uppercase one is far more likely a Windows NTLM hash. Both
   candidates are listed (with the case-appropriate confidence ordering) and
   the highest-confidence one drives the crack strategy.
3. `crackStrategy` is advisory data only. This script never runs a cracker,
   reads a wordlist, or touches the network — it maps a type to the hashcat
   mode / John format an operator would use if authorized.
4. Unknown input is not an error: it returns the advisory with no candidates
   and `crackStrategy: null`, so the caller can report "unrecognized" without
   special-casing an error path.
"""

from __future__ import annotations

import json
import re
import sys

ADVISORY = (
    "Only crack hashes you own or are explicitly authorized to test. "
    "Unauthorized cracking may violate law and policy."
)

WORDLIST = "rockyou.txt"

# $2a$/$2b$/$2x$/$2y$ + 2-digit cost + 53 chars of the bcrypt alphabet.
BCRYPT_RE = re.compile(r"^\$2[abxy]\$[0-9]{2}\$[./A-Za-z0-9]{53}$")
# $argon2id$v=19$m=65536,t=3,p=4$<salt base64>$<hash base64>
#
# The trailing `(?:\\$[A-Za-z0-9+/]+)?` accepts the standard two-segment
# "salt$hash" body as well as a single body segment. Without it the rule would
# only match a truncated argon2 string and reject every real PHC-format hash —
# `$` is not in the base64 class, so the required end-anchor could never span
# `salt$hash`.
ARGON2ID_RE = re.compile(
    r"^\$argon2id\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+(?:\$[A-Za-z0-9+/]+)?$"
)
ARGON2I_RE = re.compile(
    r"^\$argon2i\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+(?:\$[A-Za-z0-9+/]+)?$"
)
# MySQL 4.1+ = "*" + SHA1(SHA1(password)) as 40 uppercase hex chars.
MYSQL41_RE = re.compile(r"^\*[0-9A-Fa-f]{40}$")
HEX_RE = re.compile(r"^[0-9a-fA-F]+$")


def _strategy(
    mode: int | None = None,
    john: str | None = None,
    estimated: str = "",
    notes: str = "",
    tool: str = "hashcat",
) -> dict:
    """Build a crackStrategy object, omitting fields that do not apply."""
    strategy: dict = {"tool": tool}
    if mode is not None:
        strategy["mode"] = mode
    if john:
        strategy["johnFormat"] = john
    strategy["wordlist"] = WORDLIST
    if estimated:
        strategy["estimatedTime"] = estimated
    if notes:
        strategy["notes"] = notes
    return strategy


# One strategy per identified type. Only the primary (highest-confidence)
# candidate's entry is emitted with the result.
STRATEGIES: dict[str, dict] = {
    "bcrypt": _strategy(
        3200,
        "bcrypt",
        "slow — thousands of guesses/sec/GPU at cost 12; a rockyou pass takes minutes, brute force is infeasible",
        "slow hash; brute-force infeasible, dictionary only",
    ),
    "argon2id": _strategy(
        34000,
        "argon2",
        "memory-hard — hundreds to thousands of guesses/sec/GPU; brute force is infeasible",
        "memory-hard; dictionary only",
    ),
    # hashcat's 34000 covers Argon2id only, so Argon2i goes through John.
    "argon2i": _strategy(
        None,
        "argon2",
        "memory-hard — hundreds to thousands of guesses/sec/CPU; brute force is infeasible",
        "memory-hard; dictionary only — hashcat mode 34000 targets argon2id, so use John (argon2 format) for argon2i",
        tool="john",
    ),
    "SHA-512": _strategy(
        1700,
        "raw-sha512",
        "fast — billions/sec/GPU for short passwords; each extra character multiplies work by ~95x",
        "unsalted fast hash — precompute/breach corpora first; no per-user salt cost",
    ),
    "SHA-384": _strategy(
        17600,
        "raw-sha384",
        "fast — billions/sec/GPU for short passwords; long passwords quickly become infeasible",
        "unsalted fast hash — dictionary/rules attack is far cheaper than brute force",
    ),
    "SHA-256": _strategy(
        1400,
        "raw-sha256",
        "very fast — tens to hundreds of billions/sec/GPU; 8-char passwords in minutes, long passwords infeasible",
        "unsalted fast hash — try rockyou + rules before any mask/brute-force run",
    ),
    "SHA-224": _strategy(
        1300,
        "raw-sha224",
        "very fast — GPU rates comparable to SHA-256; short passwords crack in minutes",
        "less common in the wild; confirm the source format before investing in a long run",
    ),
    "SHA-1": _strategy(
        100,
        "raw-sha1",
        "very fast — tens of billions/sec/GPU; short passwords instant",
        "40 hex is also the shape of MySQL5/raw-sha1 — if the value came from a MySQL dump, try mode 300 or John mysql-sha1",
    ),
    "MD5": _strategy(
        0,
        "raw-md5",
        "very fast — tens to hundreds of billions/sec/GPU; short passwords instant, >10 chars usually infeasible",
        "32 hex is ambiguous with NTLM — if the source is Windows/SAM, also try mode 1000",
    ),
    "NTLM": _strategy(
        1000,
        "ntlm",
        "very fast — MD5-class GPU rates; short Windows passwords crack quickly",
        "uppercase 32 hex is most likely a Windows NTLM hash — MD5 (mode 0) is also possible for the same length",
    ),
    "MySQL 4.1+": _strategy(
        300,
        "mysql-sha1",
        "fast — SHA-1-class GPU rates; dictionary/rule attacks are the practical route",
        "MySQL 4.1+ stores SHA1(SHA1(password)); hashcat mode 300 and John mysql-sha1 take this format directly",
    ),
}


def _candidate(type_name: str, confidence: float, pattern: str) -> dict:
    return {"type": type_name, "confidence": confidence, "pattern": pattern}


def _hex_candidates(value: str) -> list[dict]:
    """Map a pure-hex value to candidates by length (and case for 32 hex)."""
    length = len(value)
    if length == 128:
        return [_candidate("SHA-512", 0.98, "128 hex chars")]
    if length == 96:
        return [_candidate("SHA-384", 0.98, "96 hex chars")]
    if length == 64:
        return [_candidate("SHA-256", 0.98, "64 hex chars")]
    if length == 56:
        return [_candidate("SHA-224", 0.95, "56 hex chars")]
    if length == 40:
        return [_candidate("SHA-1", 0.95, "40 hex chars")]
    if length == 32:
        # Case is the only signal separating MD5 from NTLM at this length.
        # Uppercase letter present -> NTLM is the better bet; otherwise (all
        # lowercase or all digits) MD5 leads.
        if any(c.isupper() for c in value):
            return [
                _candidate("NTLM", 0.9, "32 uppercase hex chars"),
                _candidate("MD5", 0.85, "32 hex chars (uppercase)"),
            ]
        return [
            _candidate("MD5", 0.95, "32 lowercase hex chars"),
            _candidate("NTLM", 0.8, "32 uppercase hex chars (input is lowercase)"),
        ]
    # Hex, but not a length any standard digest produces.
    return [
        _candidate(
            "hex-encoded",
            0.3,
            f"{length} hex chars — not a standard digest length",
        )
    ]


def identify(raw_value: str) -> dict:
    """Identify a single hash string and build the advisory response."""
    # Copy-pasted hashes often carry a trailing newline/space; surrounding
    # whitespace is never part of the value, so normalize it away.
    value = raw_value.strip()

    if BCRYPT_RE.match(value):
        candidates = [
            _candidate(
                "bcrypt",
                0.99,
                "$2a$/$2b$/$2x$/$2y$ + 2-digit cost + 53 chars [./A-Za-z0-9]",
            )
        ]
    elif ARGON2ID_RE.match(value):
        candidates = [
            _candidate(
                "argon2id",
                0.99,
                "$argon2id$v=<n>$m=<mem>,t=<iterations>,p=<parallelism>$<salt+hash>",
            )
        ]
    elif ARGON2I_RE.match(value):
        candidates = [
            _candidate(
                "argon2i",
                0.99,
                "$argon2i$v=<n>$m=<mem>,t=<iterations>,p=<parallelism>$<salt+hash>",
            )
        ]
    elif MYSQL41_RE.match(value):
        candidates = [_candidate("MySQL 4.1+", 0.9, "* + 40 hex chars (SHA1(SHA1(pw)))")]
    elif HEX_RE.match(value):
        candidates = _hex_candidates(value)
    else:
        candidates = []

    # Highest confidence wins; max() keeps the first on a tie, which matches
    # the ordering chosen in _hex_candidates.
    primary = max(candidates, key=lambda c: c["confidence"], default=None)
    primary_type = primary["type"] if primary else None

    return {
        "hash": value,
        "length": len(value),
        "candidates": candidates,
        "primaryType": primary_type,
        "crackStrategy": STRATEGIES.get(primary_type) if primary_type else None,
        "advisory": ADVISORY,
    }


def main(argv: list[str]) -> int:
    value: str | None = None
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--hash" and i + 1 < len(argv):
            value = argv[i + 1]
            i += 2
            continue
        if arg.startswith("--hash="):
            value = arg[len("--hash=") :]
            i += 1
            continue
        if arg in ("-h", "--help"):
            sys.stderr.write("usage: identify_hash.py --hash <hash>\n")
            return 0
        sys.stderr.write(f"unknown argument: {arg}\nusage: identify_hash.py --hash <hash>\n")
        return 2

    if value is None:
        sys.stderr.write("usage: identify_hash.py --hash <hash>\n")
        return 2

    # Compact separators keep the payload on a single line: stdout must contain
    # one JSON object and nothing else.
    sys.stdout.write(json.dumps(identify(value), ensure_ascii=False, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

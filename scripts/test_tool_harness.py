import json
import os
import re
import subprocess
import sys

# Color formatting for clean CLI output
GREEN = "\033[92m"
RED = "\033[91m"
CYAN = "\033[96m"
RESET = "\033[0m"

# The constraint set both tool paths must satisfy.
#
# MUST_CONTAIN deliberately avoids HTML-sensitive characters ('<', '>', '&'): the tool
# path is driven by an agent, and an agent asked to transcribe '<script>' may emit
# '&lt;script&gt;', which makes the constraint set genuinely unsatisfiable and fails the
# test for a reason unrelated to tool registration.
MAX_LENGTH = 20
MUST_CONTAIN = "script"
PATTERN = re.compile(r"^[a-zA-Z0-9<>_]{5,20}$")

# Tool-path tests deliberately omit the regex: transcribing a regex into a prompt is
# the flakiest part of an agent-mediated test and has nothing to do with whether the
# tool is registered. Regex handling is covered deterministically by Test 1.
TOOL_ARGS = {"maxLength": MAX_LENGTH, "mustContain": MUST_CONTAIN}

def check_recorded_args(state):
    """Verify the tool was invoked with the intended arguments."""
    recorded = state.get("input")
    if not isinstance(recorded, dict):
        return False, f"tool input was not an object: {recorded!r}"
    for key, expected in TOOL_ARGS.items():
        if recorded.get(key) != expected:
            return False, f"argument {key!r} was {recorded.get(key)!r}, expected {expected!r}"
    return True, f"arguments as requested: {recorded!r}"

def run_direct_z3_test():
    """Test 1: Directly run the Python Z3 tool via subprocess to verify solver logic."""
    print(f"\n{CYAN}Test 1: Direct Python Z3 Solver Exec{RESET}")

    tool_path = os.path.join(".opencode", "tools", "z3_string_solver.py")
    if not os.path.exists(tool_path):
        print(f"{RED}[FAIL] Could not find script at {tool_path}{RESET}")
        return False

    cmd = [
        sys.executable,
        tool_path,
        "--max-len", str(MAX_LENGTH),
        "--contain", MUST_CONTAIN,
        "--pattern", PATTERN.pattern,
    ]

    print(f"Executing: {' '.join(cmd)}")
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        print(f"Raw Output: {result.stdout.strip()}")

        data = json.loads(result.stdout)
        if data.get("status") != "success":
            print(f"{RED}[FAIL] Z3 returned unsatisfiable or error: {data}{RESET}")
            return False

        ok, detail = validate_candidate(data.get("generated_input"))
        print(f"{GREEN if ok else RED}[{'PASS' if ok else 'FAIL'}] {detail}{RESET}")
        return ok

    except subprocess.CalledProcessError as e:
        print(f"{RED}[ERROR] Execution failed with error:\n{e.stderr}{RESET}")
        return False
    except json.JSONDecodeError:
        print(f"{RED}[ERROR] Output from Z3 solver was not valid JSON.{RESET}")
        return False

def parse_run_events(stdout):
    """Parse `opencode run --format json` output.

    The format is line-delimited JSON. Any non-JSON line means we cannot trust the
    run, so it is reported as an error instead of being skipped.
    """
    events = []
    for lineno, line in enumerate(stdout.splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise ValueError(f"output line {lineno} is not valid JSON ({exc}): {line[:120]}") from exc
    return events

def find_tool_calls(events):
    """Return every structured tool call recorded in the run."""
    calls = []
    for event in events:
        part = event.get("part") if isinstance(event, dict) else None
        if isinstance(part, dict) and part.get("type") == "tool":
            calls.append(part)
    return calls

def decode_json_values(text):
    """Decode JSON values from text, tolerating markdown fences and surrounding prose."""
    decoder = json.JSONDecoder()
    stripped = (text or "").strip()

    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        stripped = "\n".join(lines).strip()

    try:
        return [json.loads(stripped)]
    except json.JSONDecodeError:
        pass

    values = []
    index = 0
    while index < len(stripped):
        starts = [pos for pos in (stripped.find("{", index), stripped.find("[", index)) if pos >= 0]
        if not starts:
            break
        start = min(starts)
        try:
            value, end = decoder.raw_decode(stripped, start)
            values.append(value)
            index = end
        except json.JSONDecodeError:
            index = start + 1
    return values

def iter_json_values(value, depth=0):
    """Yield a decoded value plus every JSON payload nested inside it.

    Agents legitimately wrap results (for example `{"ok": true, "result": "<json>"}`),
    so the payload is searched recursively rather than at a fixed shape.
    """
    if depth > 5:
        return
    yield value
    if isinstance(value, str):
        for nested in decode_json_values(value):
            yield from iter_json_values(nested, depth + 1)
    elif isinstance(value, dict):
        for nested in value.values():
            yield from iter_json_values(nested, depth + 1)
    elif isinstance(value, list):
        for nested in value:
            yield from iter_json_values(nested, depth + 1)

def extract_solver_result(text):
    """Return (status, candidate) from a tool output, or (None, None) if absent.

    Falls back to scanning an unescaped copy of the text so escaped-JSON embeddings
    are still recognised.
    """
    for value in decode_json_values(text):
        for nested in iter_json_values(value):
            if isinstance(nested, dict) and "generated_input" in nested:
                return nested.get("status"), nested.get("generated_input")

    normalized = (text or "").replace("\\", "")
    match = re.search(r'generated_input\s*:\s*"([^"]*)"', normalized)
    if match:
        status = "success" if re.search(r'"status"\s*:\s*"success"', normalized) else None
        return status, match.group(1)
    return None, None

def validate_candidate(candidate, check_pattern=True):
    """Validate a solver candidate against the requested constraints."""
    if not isinstance(candidate, str) or not candidate:
        return False, f"no candidate string found (got {candidate!r})"
    if len(candidate) > MAX_LENGTH:
        return False, f"candidate exceeds {MAX_LENGTH} chars: {candidate!r}"
    if MUST_CONTAIN not in candidate:
        return False, f"candidate does not contain {MUST_CONTAIN!r}: {candidate!r}"
    if check_pattern and not PATTERN.match(candidate):
        return False, f"candidate does not match {PATTERN.pattern}: {candidate!r}"
    scope = "length, substring, and regex" if check_pattern else "length and substring"
    return True, f"candidate {candidate!r} satisfies {scope} constraints"


def run_opencode(prompt):
    """Run OpenCode non-interactively and return its line-delimited JSON output."""
    cmd = ["opencode", "run", "--format", "json", "--auto", prompt]
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return result.stdout

def run_direct_tool_test():
    """Test 2: the tool is callable as a native/direct tool call."""
    print(f"\n{CYAN}=== Test 2: Direct Tool Call ==={RESET}")

    prompt = (
        "Call the z3_string_solver tool directly as a native tool call. "
        "Do NOT use code mode, the execute tool, or the code-mode runtime. "
        f"Arguments: maxLength={MAX_LENGTH}, mustContain='{MUST_CONTAIN}'. "
        "Then print the raw result verbatim."
    )

    try:
        print("Prompting OpenCode CLI (direct path)...")
        events = parse_run_events(run_opencode(prompt))
    except ValueError as exc:
        print(f"{RED}[FAIL] Could not parse run output: {exc}{RESET}")
        return False
    except subprocess.CalledProcessError as e:
        print(f"{RED}[ERROR] OpenCode execution failed:\n{e.stderr}{RESET}")
        return False
    except FileNotFoundError:
        print(f"{RED}[ERROR] 'opencode' binary not found in PATH.{RESET}")
        return False

    calls = find_tool_calls(events)
    direct = [c for c in calls if c.get("tool") == "z3_string_solver"]
    print(f"Tool calls observed: {[c.get('tool') for c in calls] or 'none'}")

    if not direct:
        print(f"{RED}[FAIL] No direct 'z3_string_solver' tool call was recorded.{RESET}")
        return False

    state = direct[-1].get("state") or {}
    if state.get("status") != "completed":
        print(f"{RED}[FAIL] z3_string_solver did not complete: {state.get('status')!r}{RESET}")
        return False

    output = state.get("output") or ""
    args_ok, args_detail = check_recorded_args(state)
    if not args_ok:
        print(f"{RED}[FAIL] {args_detail}{RESET}")
        return False
    print(f"         {args_detail}")

    status, candidate = extract_solver_result(output)
    if status != "success":
        print(f"{RED}[FAIL] Solver did not report success (status={status!r}). Raw output: {output[:400]!r}{RESET}")
        return False

    ok, detail = validate_candidate(candidate, check_pattern=False)
    if not ok:
        print(f"{RED}[FAIL] Raw output: {output[:400]!r}{RESET}")
    print(f"{GREEN if ok else RED}[{'PASS' if ok else 'FAIL'}] {detail}{RESET}")
    return ok

def run_codemode_tool_test():
    """Test 3: the tool is callable inside the code-mode runtime as tools.reconix.<tool>."""
    print(f"\n{CYAN}=== Test 3: Code Mode Tool Call ==={RESET}")

    prompt = (
        "Inside the code-mode execute runtime, call "
        f"await tools.reconix.z3_string_solver({{maxLength: {MAX_LENGTH}, "
        f"mustContain: '{MUST_CONTAIN}'}}) "
        "and return its raw result. If the call fails, return the exact error message."
    )

    try:
        print("Prompting OpenCode CLI (code-mode path)...")
        events = parse_run_events(run_opencode(prompt))
    except ValueError as exc:
        print(f"{RED}[FAIL] Could not parse run output: {exc}{RESET}")
        return False
    except subprocess.CalledProcessError as e:
        print(f"{RED}[ERROR] OpenCode execution failed:\n{e.stderr}{RESET}")
        return False
    except FileNotFoundError:
        print(f"{RED}[ERROR] 'opencode' binary not found in PATH.{RESET}")
        return False

    calls = find_tool_calls(events)
    codemode = [c for c in calls if c.get("tool") == "execute"]
    print(f"Tool calls observed: {[c.get('tool') for c in calls] or 'none'}")

    if not codemode:
        print(f"{RED}[FAIL] No 'execute' (code mode) call was recorded.{RESET}")
        return False

    state = codemode[-1].get("state") or {}
    if state.get("status") != "completed":
        print(f"{RED}[FAIL] execute did not complete: {state.get('status')!r}{RESET}")
        return False

    code = (state.get("input") or {}).get("code")
    if not isinstance(code, str) or "z3_string_solver" not in code:
        print(f"{RED}[FAIL] execute did not target z3_string_solver: {str(code)[:300]!r}{RESET}")
        return False
    print(f"         code targeted the namespaced tool ({len(code)} chars)")

    output = state.get("output") or ""
    status, candidate = extract_solver_result(output)
    if status != "success":
        print(f"{RED}[FAIL] Code-mode call did not return a successful solver result. Raw output: {output[:400]!r}{RESET}")
        return False

    ok, detail = validate_candidate(candidate, check_pattern=False)
    if not ok:
        print(f"{RED}[FAIL] Raw output: {output[:400]!r}{RESET}")
    print(f"{GREEN if ok else RED}[{'PASS' if ok else 'FAIL'}] {detail}{RESET}")
    return ok

if __name__ == "__main__":
    print(f"{CYAN}Starting OpenCode Tools Test Suite...{RESET}")

    results = {}

    # Tests 2 and 3 exercise the same solver; the Python backend must work first.
    results["python solver backend"] = run_direct_z3_test()

    if results["python solver backend"]:
        results["direct tool call"] = run_direct_tool_test()
        results["code mode tool call"] = run_codemode_tool_test()
    else:
        print(f"\n{RED}Skipping OpenCode tests because the Python Z3 backend failed.{RESET}")
        results["direct tool call"] = False
        results["code mode tool call"] = False

    print(f"\n{CYAN}--- Summary ---{RESET}")
    for name, passed in results.items():
        color = GREEN if passed else RED
        print(f"{color}{'PASS' if passed else 'FAIL'}  {name}{RESET}")

    sys.exit(0 if all(results.values()) else 1)

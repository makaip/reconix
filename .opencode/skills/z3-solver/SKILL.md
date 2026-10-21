---
name: z3-solver
description: Use the z3_string_solver tool to calculate valid inputs for length bounds, required/forbidden fragments, regex constraints, charsets, and numeric validation rules.
---

# Z3 String Constraint Solver

## Purpose
You have a dedicated tool named **`z3_string_solver`**. You must invoke this tool directly through your tool-calling interface whenever you encounter a web form, client-side script, or validation rule that imposes strict character length limits, required prefixes/suffixes, forbidden fragments, character-set restrictions, regex patterns, or numeric constraints (bounds, divisibility, modulus, exact values).

The tool returns a candidate that has been re-verified against your original constraints, so a `status: "success"` result is safe to submit directly.

## Inputs
`maxLength` is the only required argument — in numeric mode it acts as the digit budget when `intMax` is omitted.

| Argument | Type | Meaning |
| --- | --- | --- |
| `maxLength` | number (**required**) | Maximum allowed length (digit budget in numeric mode). |
| `minLength` | number | Minimum allowed length. |
| `mustContain` | string | A substring the input must include (e.g. `admin`, `@`, `../../`). |
| `mustNotContain` | string \| string[] | One or more substrings that must NOT appear (e.g. `<>`, `script`). |
| `pattern` | string | A regex the whole input must match. |
| `patterns` | string[] | Extra regexes; **every** pattern must match (ANDed). |
| `charset` | string | The only characters the input may use (e.g. `abcdef0123456789`). |
| `forbiddenChars` | string | Characters that must never appear (e.g. `<>"'`). |
| `numeric` | boolean | Solve for an integer instead of a string. |
| `intMin` / `intMax` | number | Numeric bounds. `intMax` defaults to `10**maxLength - 1`. |
| `intMod` / `intModRemainder` | number | Require `n % intMod == intModRemainder` (remainder defaults to `0`). |
| `intDivisibleBy` | number | Require `n % intDivisibleBy == 0`. |
| `intMustEqual` | number | Require a specific integer value. |
| `count` | number | Number of **distinct** candidates to generate (default `1`). |
| `timeoutMs` | number | Solver timeout in milliseconds. |

## Output
- String mode: `{ status: "success", generated_input, verified: true, attempts, printable, constraints }`.
- Batch mode (`count > 1`): `generated_inputs: string[]` plus `count` and `requested`.
- Numeric mode: `generated_number` (`generated_numbers: number[]` when `count > 1`).
- Failure statuses: `unsat`, `unsupported_pattern`, `unknown`, `error`. On any non-`success` status, loosen a constraint or fall back to manual payloads — never assume a candidate was produced.

## Rules
1. **Never** execute `.opencode/tools/z3_string_solver.py` manually via terminal or shell commands. Always call the `z3_string_solver` tool with your extracted arguments.
2. Extract the real constraints from the target element or code: `maxlength`/`minlength` attributes, `required` fragments, negative checks, `pattern` attributes, and keypad/allowed-character restrictions.
3. Translate negative checks (`indexOf(x) === -1`, "must not contain") into `mustNotContain`, and regex rules into `pattern`/`patterns`.
4. For integer-only fields (age, quantity, PIN, OTP), use `numeric: true` with `intMin`/`intMax`; add `intDivisibleBy`, `intMod`, or `intMustEqual` when the validation implies them.
5. Use `charset`/`forbiddenChars` when the field filters characters client-side, so the candidate is not silently rejected after generation.
6. Use `count > 1` when you need several distinct values (e.g. fuzzing a field or probing multiple retries).
7. Unsupported regex constructs (backreferences, lookarounds, word boundaries) return `unsupported_pattern`; rewrite the rule with supported syntax or drop to a plain length/charset constraint.
8. Pass the generated value directly into the target form field, then verify the result through `dom_evaluator`.

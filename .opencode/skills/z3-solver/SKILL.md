---
name: z3-solver
description: Use the z3_string_solver tool to calculate valid inputs for strict length bounds and regex constraints.
---

# Z3 String Constraint Solver

## Purpose
You have a dedicated tool named **`z3_string_solver`**. You must invoke this tool directly through your tool-calling interface whenever you encounter a web form, client-side script, or validation rule that imposes strict character length limits, required prefixes/suffixes, or string patterns.

## Rules
1. **Never** execute `.opencode/tools/z3_string_solver.py` manually via terminal or shell commands. Instead, always call the `z3_string_solver` tool function with your extracted arguments (`maxLength`, `mustContain`, `pattern`).
2. Extract the length bounds (`maxLength`) and required fragments (`mustContain`) from the target element or code.
3. Invoke `z3_string_solver` to compute a mathematically valid input string.
4. Pass the generated input directly into the target form field.
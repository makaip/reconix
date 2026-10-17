---
name: z3-solver
description: Use the z3_string_solver tool to calculate valid inputs for strict length bounds and regex constraints.
---

# Z3 String Constraint Solver

## Purpose
Use the `z3_string_solver` tool whenever a web form, client-side script, or validation rule imposes strict character length limits, required prefixes/suffixes, or string patterns.

## Instructions
1. Never hallucinate or manually guess values for constrained input fields.
2. Extract the length bounds (`maxLength`) and required fragments (`mustContain`) from the target element or code.
3. Invoke `z3_string_solver` to compute a mathematically valid input string.
4. Pass the generated input directly into the target form field.
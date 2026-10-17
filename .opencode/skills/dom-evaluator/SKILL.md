---
name: dom-evaluator
description: Use the dom_evaluator tool to analyze state changes and error messages after browser actions.
---

# DOM Execution Evaluator

## Purpose
Use the `dom_evaluator` tool immediately after executing a browser action (such as clicking a button, submitting a form, or injecting a payload) to determine its impact.

## Instructions
1. Capture the DOM state or HTML before and after your action.
2. Invoke `dom_evaluator` to analyze state changes, URL redirects, error messages, or success keywords.
3. Use the evaluation report to decide whether the attack vector succeeded or if you need to adjust your strategy.
# Penetration Testing Browser - Project Guidelines

## Project Overview
This repository contains an AI-driven penetration testing browser built on **Electron**, **Playwright**, and **OpenCode**. It features an orchestrator-evaluator agent architecture designed to safely map application attack surfaces, execute generic verification actions, and attack security anomalies.

## Tech Stack & Architecture
- **Desktop Shell:** Electron (TypeScript/JavaScript). Strict separation between Main (Node/Playwright) and Renderer (UI) processes via IPC.
- **Automation Engine:** Playwright for browser control, DOM inspection, and network interception.
- **Agentic Core:** OpenCode with model tiering (Claude Sonnet orchestrator + Claude Haiku evaluator).

## Safety & Scope Guardrails
1. **Human-in-the-Loop:** Destructive or high-impact actions must pause and request explicit sign-off in the Electron UI.
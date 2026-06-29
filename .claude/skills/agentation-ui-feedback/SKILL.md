---
name: agentation-ui-feedback
description: How the ADIA ERP team uses Agentation — a visual annotation tool that turns in-browser UI feedback into structured context (CSS selectors, file paths, component hierarchy) for the agent. Use when the user gives visual UI feedback, when iterating on the frontend, or when interpreting Agentation annotation output.
---

# Agentation — Visual UI Feedback

Agentation (https://www.agentation.com/) lets the project owner annotate the running UI directly in the browser. Each annotation carries structured context an agent can act on precisely: CSS selectors, file paths, React component hierarchy, computed styles, and the owner's note. It removes ambiguity — the agent works from exact element identifiers, not vague descriptions.

## Two ways feedback arrives

1. **Pasted output:** the owner annotates in the browser and pastes Agentation's structured output into the chat. Use the selectors / file paths to jump straight to the code.
2. **MCP (`agentation` server):** the agent queries all annotations directly, asks for clarification, and resolves them with a summary. The server runs on port 4747.

## Setup state

- The `agentation` MCP server is configured in `.mcp.json`.
- The `<Agentation />` React component must be added to the frontend **once it exists** (Faza 1):
  ```jsx
  import { Agentation } from "agentation";
  // at the app root, development only:
  {process.env.NODE_ENV === "development" && (
    <Agentation endpoint="http://localhost:4747" />
  )}
  ```
- Package: `npm install agentation -D`. See `docs/SETUP.md`.

## Workflow for the frontend agent

1. Read the annotation context: selector, file path, component, computed style, the owner's note.
2. Navigate straight to the file / component — no guessing.
3. Make the change following the `frontend-ui-engineering` skill and the design system.
4. Resolve the annotation (via MCP) with a short summary of what changed.

## When to use

- Any time the owner reports a visual issue or asks for a UI tweak.
- During frontend iteration cycles.

## Boundary

Agentation tells you *where* and *what* the owner means — it does not replace the design system or accessibility requirements. Verify every change in a real browser with the `browser-testing-with-devtools` skill.

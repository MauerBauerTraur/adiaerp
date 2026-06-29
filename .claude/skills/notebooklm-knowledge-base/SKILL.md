---
name: notebooklm-knowledge-base
description: How the ADIA ERP team uses NotebookLM (via the notebooklm MCP server) as its shared knowledge base and memory — ingesting the spec, domain docs, and research, then querying for grounded, citation-backed answers. Use when you need authoritative project or domain information, when research-analyst is curating knowledge, or before answering a factual domain question.
---

# NotebookLM Knowledge Base

NotebookLM is the ADIA ERP team's **shared knowledge base and memory**. It is reached through the `notebooklm` MCP server (npm package `notebooklm-mcp`). Answers are grounded in uploaded sources with citations — no hallucination.

## What goes in

- The technical spec (`docs/TZ.md`).
- Domain notes: bakery production, inventory management, reorder-point / safety-stock theory.
- `market-analyst` competitor and trend research.
- Architecture decisions and outcomes worth retaining long-term.

## Who maintains it

`research-analyst` owns notebook curation — creating notebooks, uploading sources, keeping them current. Other agents are mainly consumers: they query for grounded answers.

## Workflow

1. **First use ever:** authentication is required. The MCP `setup_auth` tool opens a Chrome window for a one-time Google login. This is a project-owner action — see `docs/SETUP.md`.
2. **To learn something:** query the relevant notebook through the MCP tools instead of guessing. Prefer grounded answers for domain and spec facts.
3. **To add knowledge:** `research-analyst` uploads the source document to the appropriate notebook.
4. **To cite:** when you use a NotebookLM answer, note that it came from the knowledge base so the team can trace the source.

## When to use vs. not

- **Use for:** domain facts, spec details, prior research, "what did we decide about X".
- **Do NOT use for:** live code state (read the files directly), or anything faster to verify by hand.

## Relation to the project's other memory

- **NotebookLM** = team knowledge base — shared, sourced, durable.
- **`docs/`** = the repo's own canonical documents.
- **The team lead's file-memory** = cross-session continuity of decisions and the owner's preferences.

Keep these distinct; do not duplicate large content across them — link instead.

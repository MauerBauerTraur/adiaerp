---
name: lazyweb-design-references
description: How to use Lazyweb (lazyweb.com) — a library of 250k+ real product UI screens — as a grounded design reference for the ADIA ERP interface. Use when designing or building any UI (dashboards, tables, forms, onboarding, settings), choosing a UI pattern, or doing competitive UI research.
---

# Lazyweb — Design References

Lazyweb (https://www.lazyweb.com/) is a curated library of 250k+ real, in-production app screens and UI patterns. It is free and exposes an API for agents (no login). Use it to ground UI decisions in proven, real-world examples instead of guessing.

## When to use

- Designing a screen for ADIA ERP: dashboard, stock tables, replenishment views, production board, store view, settings, login, assistant chat.
- Choosing a pattern: data table, filters, status badges, KPI cards, empty / loading / error states, chart layouts.
- Competitive UI research: how real ERP / inventory / dashboard products solve a problem.

## How to use

1. Identify the concrete pattern needed — e.g. "dark dashboard with KPI cards + dense table", "multi-step form", "list with status pills".
2. Query Lazyweb for that pattern (WebFetch on the site or its API).
3. Study 3-5 real examples; extract what works — layout, hierarchy, density, state handling.
4. **Adapt, do not copy** — translate the idea into the ADIA ERP design system.

## Fit with the project

- TZ 10 sets a **dark premium** aesthetic: shadcn/ui + Tailwind + Recharts.
- The dashboard must show the whole supply chain in real time, with red alerts for below-min stock.
- `ui-ux-designer` leads reference gathering; `frontend-engineer` consults it during implementation.

## Boundary

References inform decisions — they do not replace the design system. Every screen must stay consistent with the project's tokens, component library, Uzbek UI language, and WCAG 2.1 AA accessibility.

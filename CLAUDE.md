# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AdPilot — SaaS for automating VK Ads (myTarget API v2). Rule-based monitoring stops ineffective ads and sends Telegram/email notifications. Self-hosted Convex backend + React frontend deployed via Docker/Dokploy.

## Quick Commands

```bash
npm run dev                              # Vite dev server
npm run build                            # Production build
npm run lint                             # ESLint (max 50 warnings)
npm run test                             # Unit + integration (Vitest)
npm run test:e2e                         # Playwright E2E
npm run ci                               # Full pipeline
npx tsc --noEmit -p convex/tsconfig.json # Typecheck Convex
```

**Deploy:** Push to `main` → GitHub Actions auto-deploys Convex + Docker image.

## Modular Rules

Detailed rules are in `.claude/rules/`:

| File | Contents |
|---|---|
| `architecture.md` | Stack, project structure, data flow, key files |
| `design-system.md` | Colors (HSL tokens), light/dark mode, spacing, animations |
| `components.md` | UI components (Button, Card, Badge variants), icon usage |
| `layout-and-navigation.md` | Sidebar, mobile nav, page structure, grid patterns |
| `frontend-patterns.md` | React patterns, hooks, forms, routing, formatting |
| `convex-patterns.md` | Backend functions, queries, mutations, VK API, rule engine |
| `database-schema.md` | All 14 tables with fields, indexes, conventions |
| `deploy-and-testing.md` | Deploy flow, servers, testing commands, env vars |

## Critical Conventions

- **Language:** All UI text in Russian. Use `ru-RU` locale for formatting.
- **Colors:** NEVER use raw hex/rgb. Always use design tokens (`bg-primary`, `text-muted-foreground`, etc.)
- **Components:** shadcn/ui pattern with CVA. Merge classes with `cn()`.
- **Backend:** Convex functions (query/mutation/action). VK API via `callMtApi()` with retry.
- **Dates:** UTC in backend (`todayStr()`). Russian format in frontend (`formatDate()`).
- **Leads:** 5 sources (base.goals, vk.result, vk.goals, events, Lead Ads API), take `Math.max()`. Safety check via statistics API before stopping ads.
- **Notifications:** Critical → immediate. Standard → 5-min grouped. Quiet hours for non-critical.
- **Path alias:** `@/*` → `./src/*`
- **Testing:** Add `data-testid` to key elements.

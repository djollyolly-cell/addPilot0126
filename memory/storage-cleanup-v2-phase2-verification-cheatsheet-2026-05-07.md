# Storage Cleanup V2 — Phase 2 Local Verification Cheat Sheet — 2026-05-07

Status: pre-deploy verification cheat sheet. Implementer / operator runs these checks against a clean working tree at HEAD = Phase 1 code commit (`2410f14` or later doc-only) BEFORE giving a Phase 3 deploy go.

Verified against actual code in commit `2410f14` (convex/{schema,metrics,metrics.test}.ts unchanged since). If `convex/` content changed since this cheat sheet was written, re-derive expected outputs from current code first.

Related:
- Plan (hardened runbook): `docs/superpowers/plans/2026-05-07-storage-cleanup-v2.md` (commit `9f6786b`)
- Phase 1 design: `memory/storage-cleanup-v2-phase1-design-2026-05-07.md` (commit `b3e4bd4`)
- Phase 1 code: commit `2410f14 feat(storage-cleanup): add metricsRealtime cleanup V2`
- Phase 4 canary runbook: `memory/storage-cleanup-v2-phase4-canary-runbook-2026-05-07.md` (commit `5d3aa81`)

## Prerequisites

- [ ] Branch is `emergency/drain-scheduled-jobs`.
- [ ] HEAD is at the Phase 1 code commit OR a doc-only descendant. Run:
      ```bash
      git log --oneline 2410f14^..HEAD -- convex/
      ```
      Expected: only `2410f14 feat(storage-cleanup): add metricsRealtime cleanup V2` touches `convex/`. If anything else touched `convex/` since `2410f14`, re-audit before continuing.
- [ ] Working tree clean for `convex/`:
      ```bash
      git status --short convex/
      ```
      Expected: empty. If anything modified, decide whether it belongs in Phase 1 or is unrelated drift; do NOT verify against a dirty tree.
- [ ] Node / npm tooling installed (typical dev environment).

If any prerequisite fails → STOP. Do not proceed to verification until resolved.

## Check 1 — Convex typecheck

```bash
npx tsc --noEmit -p convex/tsconfig.json
```

Expected: zero output (clean exit code 0). Any error is a fail-the-deploy bug — do NOT commit a fix that masks the error, fix at the source.

If errors reference `cleanupRunState` types not found → `_generated/api.ts` or `_generated/dataModel.d.ts` may be stale. Run a project-approved codegen step ONCE (`npx convex codegen` per Convex CLI), re-typecheck, do NOT deploy as part of this step, do NOT edit `_generated/` files by hand.

## Check 2 — Run metrics tests

`npm run test` is a chain (`test:unit && test:integration` per `package.json`) and does not propagate file-path arguments cleanly to a single targeted file. Use `test:unit` directly (which is `vitest run --config vitest.config.ts` per `package.json`):

```bash
npm run test:unit -- convex/metrics.test.ts
```

Equivalent direct vitest invocation:

```bash
npx vitest run --config vitest.config.ts convex/metrics.test.ts
```

Expected: **24 tests pass, 0 fail, 0 skip**.

Breakdown (verified against `2410f14`):

| Block | Tests | Description |
|---|---|---|
| `metrics` describe | 12 | Pre-Phase 1: `saveRealtime`, `saveDaily`, `getRealtimeByAd`, `getDailyByAd/Account`, `deleteRealtimeBatch` (3 existing) |
| Phase 1 V2 tests | 9 | `manualMassCleanup` no-op, V2 schedules V2, cutoffMs retention, `deleteRealtimeBatch` backward-compat, env gate off, refuse active run, maxRuns via batchesRun, success observability, env-toggle mid-chain |
| `saveDailyBatch — dirty-check` describe | 3 | Pre-Phase 1: dirty-check upsert (inserted/skipped/patched) |

If V2 test count != 9, or any pre-existing test fails → fail-the-deploy. Pre-existing failures are critical — they mean the `cutoffMs` widening (Decision E step 2) accidentally broke V1 callers.

## Check 3 — Grep guard A: broad inventory of cleanup symbol references

```bash
rg "manualMassCleanup|manualMassCleanupV2|scheduleMassCleanup|scheduleMassCleanupV2|cleanupOldRealtimeMetrics" convex/metrics.ts convex/crons.ts
```

Expected hits in `convex/metrics.ts` (verified against `2410f14`):
- `manualMassCleanup` declaration line (V1, internalAction, body still `return;`).
- `triggerMassCleanup` (public mutation) calls `internal.metrics.manualMassCleanup` via scheduler.
- `cleanupOldRealtimeMetrics` (internalAction, V1 cron entry — STILL UNCHANGED) reads `cleanup-realtime-metrics` heartbeat and delegates to `scheduleMassCleanup`.
- `scheduleMassCleanup` (internalMutation) schedules V1 `manualMassCleanup`.
- `scheduleNextChunkV2` (V2 internalMutation) schedules V2 `manualMassCleanupV2`.
- `manualMassCleanupV2` (V2 internalAction) — main worker.
- `triggerMassCleanupV2` (V2 internalMutation) schedules first `manualMassCleanupV2`.

Notes on the broad pattern:
- One or more hits may legitimately fall inside `// ...` comments referencing the V1 chain history (e.g. the comment above `cleanupOldRealtimeMetrics` explaining why it delegates). Comments do NOT count as references for the V1-isolation check (Check 4 below); they are documentation.
- `scheduleMassCleanupV2` is included in the pattern as a TRIPWIRE — Phase 1 does NOT introduce a function with this exact name (the V2 chain helper is `scheduleNextChunkV2`). Expected: **zero hits** for `scheduleMassCleanupV2`. Any hit means a name collision with a hypothetical drop-in V1 replacement, which would re-poison naming discipline — investigate.

Expected hits in `convex/crons.ts`:
- `cleanupOldRealtimeMetrics` referenced ONLY inside a commented-out cron block (`// crons.cron("cleanup-old-realtime-metrics", ...)` or similar). NO active cron entry.

If `convex/crons.ts` shows any uncommented `cleanupOldRealtimeMetrics` cron → fail-the-deploy. Phase 6 cron restoration is a separate go.

## Check 4 — Grep guard B: V1 udfPath isolation in V2 block

The point of this check is NOT "zero V1 references in convex/" — V1 functions (`triggerMassCleanup`, `cleanupOldRealtimeMetrics`, `scheduleMassCleanup`) legitimately reference `internal.metrics.manualMassCleanup` and that is the V1 chain we explicitly preserved. The check is: V2 code MUST NOT reference V1 udfPath.

```bash
rg -n "internal\.metrics\.manualMassCleanup\b" convex/metrics.ts
```

Expected (verified against `2410f14`): exactly 2 hits, both in V1 callers:
- One in `triggerMassCleanup` handler (`ctx.scheduler.runAfter(0, internal.metrics.manualMassCleanup, ...)`)
- One in `scheduleMassCleanup` handler (same pattern)

V2 functions (`triggerMassCleanupV2`, `manualMassCleanupV2`, `scheduleNextChunkV2`, etc.) MUST NOT contain `internal.metrics.manualMassCleanup\b` — they MUST reference `internal.metrics.manualMassCleanupV2\b` only.

To assert this directly:

```bash
# All V2 export bodies — V1 udfPath references should be 0.
# Approach: extract V2 functions, grep for V1 pattern.
# Visual inspection of convex/metrics.ts is acceptable; below is one mechanical option:
sed -n '/^export const triggerMassCleanupV2 = /,/^});/p' convex/metrics.ts | rg "internal\.metrics\.manualMassCleanup\b" || echo "PASS: triggerMassCleanupV2 has zero V1 udfPath refs"
sed -n '/^export const manualMassCleanupV2 = /,/^});/p' convex/metrics.ts | rg "internal\.metrics\.manualMassCleanup\b" || echo "PASS: manualMassCleanupV2 has zero V1 udfPath refs"
sed -n '/^export const scheduleNextChunkV2 = /,/^});/p' convex/metrics.ts | rg "internal\.metrics\.manualMassCleanup\b" || echo "PASS: scheduleNextChunkV2 has zero V1 udfPath refs"
```

Expected: each command prints PASS line (rg returns non-zero on no match → `||` fires the echo). Any rg hit before PASS = V2 leakage = fail-the-deploy.

## Check 5 — 8 V2 exports present

```bash
rg -n "^export const (triggerMassCleanupV2|manualMassCleanupV2|getCleanupRunStateV2|markRunningV2|recordBatchProgressV2|scheduleNextChunkV2|markCompletedV2|markFailedV2)" convex/metrics.ts
```

Expected: exactly 8 lines, one per V2 export. Verified line numbers at `2410f14`:
- `434: triggerMassCleanupV2`
- `478: getCleanupRunStateV2`
- `488: markRunningV2`
- `504: recordBatchProgressV2`
- `534: scheduleNextChunkV2`
- `550: markCompletedV2`
- `583: markFailedV2`
- `602: manualMassCleanupV2`

If count != 8 → fail-the-deploy. Naming drift breaks the canary runbook trigger command and the closure memo template.

## Check 6 — Schema `cleanupRunState` table sanity

```bash
rg -n "cleanupRunState" convex/schema.ts
```

Expected: exactly 1 hit at the `defineTable` line (verified: line 825 at `2410f14`).

Table content sanity (visual inspection or):

```bash
sed -n '/cleanupRunState: defineTable/,/by_runId.*runId/p' convex/schema.ts
```

Expected fields present (per Decision A):
- `cleanupName: v.string()`
- `runId: v.string()`
- `state: v.union(claimed, running, completed, failed)`
- `isActive: v.boolean()`
- `startedAt: v.number()`
- `lastBatchAt: v.optional(v.number())`
- `batchesRun: v.number()` (NOT `runNumber`)
- `maxRuns: v.number()`
- `cutoffUsed: v.number()` (NOT optional)
- `deletedCount: v.number()` (NOT optional)
- `oldestRemainingTimestamp: v.optional(v.number())`
- `durationMs: v.optional(v.number())`
- `error: v.optional(v.string())`
- `batchSize: v.number()`
- `timeBudgetMs: v.number()`
- `restMs: v.number()`

Indexes:
- `.index("by_cleanupName_isActive", ["cleanupName", "isActive"])`
- `.index("by_runId", ["runId"])`

Any missing field, any wrong type, any wrong index name → fail-the-deploy. The canary runbook and closure template both rely on these names verbatim.

## Check 7 — `deleteRealtimeBatch` cutoffMs widening

```bash
rg -n "cutoffMs" convex/metrics.ts
```

Expected (verified): at least 3 hits:
- Type alias / FunctionReference declaration (line 28).
- Args definition: `cutoffMs: v.optional(v.number())` (line 417).
- Handler usage: `const cutoff = args.cutoffMs ?? Date.now() - METRICS_REALTIME_CLEANUP_V2_CUTOFF_MS` (line 420).
- V2 caller: `cutoffMs: state.cutoffUsed` inside `manualMassCleanupV2` handler (line 633).

Backward compatibility verified by Check 2 test #4 (`deleteRealtimeBatch remains backward-compatible without cutoffMs` at line 552 of metrics.test.ts).

If `cutoffMs` arg is NOT optional → fail-the-deploy. Existing callers `deleteRealtimeBatch({ batchSize: N })` without `cutoffMs` would break.

## Check 8 — V1 `manualMassCleanup` body remains no-op

```bash
sed -n '/^export const manualMassCleanup = /,/^});/p' convex/metrics.ts
```

Expected: body is `return;` (or equivalent immediate no-op return). NO database writes, NO scheduler calls, NO logic. Per Phase 1 deploy-safety contract — V1 bodies untouched.

If body has been resurrected (e.g. someone re-added the V1 mass cleanup logic) → fail-the-deploy. The drain-mode no-op MUST be preserved until V1 backlog is provably drained.

## Check 9 — Env var name and log prefix

```bash
rg -n "METRICS_REALTIME_CLEANUP_V2_ENABLED" convex/metrics.ts
```

Expected: at least 1 hit at the gate function (line 37 at `2410f14`):
```ts
return process.env.METRICS_REALTIME_CLEANUP_V2_ENABLED === "1";
```

Any typo in the env var name (case, underscores, `_V2_` vs `V2`, `_ENABLED` vs `_ENABLE`) → fail-the-deploy. Phase 4 runbook trigger command uses this exact name; mismatch = canary cannot be enabled.

```bash
rg -n "\[cleanup-v2\]" convex/metrics.ts
```

Expected: at least 5 hits (verified: lines 443, 610, 624, 654, 668 at `2410f14`):
- `[cleanup-v2] skip reason=disabled` (trigger gate)
- `[cleanup-v2] runId=... skip reason=disabled_mid_chain` (worker gate mid-chain)
- `[cleanup-v2] start runId=... batchesRun_pre=...` (chunk start)
- `[cleanup-v2] end runId=... deleted=... durationMs=... hasMore=... decision=...` (chunk end success)
- `[cleanup-v2] end runId=... deleted=0 ... decision=failed` (chunk end failure path)

Phase 4 runbook stdout grep relies on `[cleanup-v2]` literal. Any prefix typo → runbook observation step 5a misses log lines.

## Check 10 — `cleanupOldRealtimeMetrics` cron remains commented in `convex/crons.ts`

```bash
rg -n "cleanup-old-realtime-metrics" convex/crons.ts
```

Expected: 1 or more hits, ALL inside commented-out cron block (lines starting with `//`). NO active `crons.cron(...)` or `crons.interval(...)` registration.

If the cron is uncommented → fail-the-deploy. Phase 1 explicitly does NOT enable the cron; Phase 6 has its own go.

## Decision criteria

**All green → ready for Phase 3 deploy go.** Specifically:
- Check 1: typecheck clean (exit 0, no output).
- Check 2: 24/24 tests pass.
- Check 3: broad inventory matches expected.
- Check 4: each V2 function block prints PASS (zero V1 udfPath in V2).
- Check 5: 8 V2 export lines.
- Check 6: schema fields and indexes match Decision A verbatim.
- Check 7: `cutoffMs` widening present and optional.
- Check 8: V1 `manualMassCleanup` body still `return;`.
- Check 9: env var name and `[cleanup-v2]` log prefix exact.
- Check 10: `cleanup-old-realtime-metrics` cron still commented.

**Any red → fix at source before commit.** Do NOT use `--no-verify`, do NOT mask the error.

## Operator note: do NOT do these as part of Phase 2

- Do NOT set `METRICS_REALTIME_CLEANUP_V2_ENABLED` env in any environment. Default-off is the deploy-safety guarantee.
- Do NOT run `npx convex run internal.metrics.triggerMassCleanupV2 ...` even on dev. Smoke would create scheduled-function entries that confuse Phase 4 baseline (Phase 4 prereq requires zero `manualMassCleanupV2` entries).
- Do NOT `npx convex deploy`. Phase 3 is a separate go.
- Do NOT touch `convex/crons.ts` to enable cron. Phase 6 only.

## After verification

If all green:
- Phase 2 closure: a brief note in commit message of any post-Phase 1 doc commit (or a one-line entry in MEMORY.md auto-memory).
- Hand off to Phase 3 (deploy) — separate go, separate runbook.

If red:
- Fix at source.
- Re-run failing checks.
- Iterate until all green.
- Do NOT commit fix and re-run later — iterate in one session.

## Re-verification before Phase 3 deploy

This cheat sheet was written against `2410f14`. Before invoking `npx convex deploy --yes` for Phase 3:

- [ ] Re-run all 10 checks against current HEAD.
- [ ] Confirm `git diff 2410f14..HEAD -- convex/` is empty (or contains only verified safe additions).
- [ ] If `convex/` has drifted, re-derive expected outputs from current code, update this cheat sheet OR write a fresh one for the new HEAD.

Pre-deploy hygiene: 5-10 minutes of re-verification beats post-deploy rollback by an order of magnitude.

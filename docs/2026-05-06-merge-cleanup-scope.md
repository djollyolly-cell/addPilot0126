# Merge cleanup scope: `emergency/drain-scheduled-jobs` → `main`

Date: 2026-05-06
Updated: 2026-05-13 — P4/P7 read-only merge-readiness verification recorded; D2a closure reflected, B1 1-week window date added, Phase 8 confirmed closed clean per source links. See update notes below for change log. Inline `[Updated ...]` annotations mark stale claims throughout the doc.
Branch: `emergency/drain-scheduled-jobs`
Status: **scope analysis only — no merge action authorized**

This document is a read-only audit of what currently lives on the emergency branch versus `main`, classifies the differences, and surfaces the constraints that any merge strategy must honor. It does not propose a merge timing.

## Update notes 2026-05-12

This document was originally written 2026-05-06. Since then:

- **D2a deployed clean** (commit `a5ff381`, 2026-05-07). Closure: `memory/d2a-closure-2026-05-07.md`. The four `vkApi.ts` producer guards are no longer `if (false && hasData)` — they call `ctx.runMutation(internal.vkApiLimits.recordRateLimit, ...)` directly via async `onResponse` (one row per logical 429 enforced in `callMtApi` via `saw429` state). Four affected functions: `getMtStatistics`, `getCampaignsSpentTodayBatch`, `getMtLeadCounts`, `getMtBanners`. Evidence snapshot 2026-05-12: `convex/vkApi.ts` lines 556, 683, 875, 1086 — function names are stable, line numbers are brittle and may shift after refactors.
- **`vkApiLimits.recordRateLimit` is no longer a V1 no-op stub** — it is the live D2a mutation with `statusCode === 429` insert predicate. Historical `_scheduled_jobs` V1 rows for this function may still need drain proof, but the function body is restored.
- **D2b (sampled headers on 200), D2c (aggregated state), Option D (`vk-throttling-probe` cron)** — all explicitly deferred per `docs/2026-05-06-recordRateLimit-redesign-design.md`. **Not blocking merge.**
- **D1 still blocking.** Commit `9aa3a68` (env gate `DISABLE_ERROR_ALERT_FANOUT=1`) is the emergency suppression, **not** the Tier 1 fix. D1a/D1b/D1c per `docs/2026-05-06-adminAlerts-notify-redesign-design.md` all pending. `convex/adminAlerts.ts:144` handler still `// EMERGENCY DRAIN MODE: no-op. return;`. Production alert delivery to Telegram is currently zero.
- **B1 1-week observation window**: B1 deployed 2026-05-06 (`9768449`); window closes 2026-05-13.
- **Phase 8 closed clean** at `2026-05-06T17:47Z = 20:47 MSK` per `docs/2026-05-06-concurrency-bump-8-to-16-runbook.md` "Phase 8 strict closure" section (line 358). Final state: `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16`. Key canary token refresh `17:09Z` passed (dispatcher completed, `+25 success`, 0 rollback signals). The pre-merge Phase 8 checkbox below is now marked `[x]` with source link.

The rest of this document still describes the 2026-05-06 baseline with inline `[Updated 2026-05-12: ...]` annotations where stale. Original prose is preserved for history; do not retro-edit beyond annotations.

## Update notes 2026-05-13

- **P4 V1 backlog latest-state proof closed** via read-only Convex admin path (`npx convex data _scheduled_functions --limit 8000 --format jsonLines`), not raw PostgreSQL. The six merge-readiness target `udfPath`s all showed `0` `pending` and `0` `inProgress`: `auth.js:tokenRefreshOne`, `syncMetrics.js:syncBatchWorker`, `ruleEngine.js:uzBudgetBatchWorker`, `metrics.js:manualMassCleanup`, `vkApiLimits.js:recordRateLimit`, `adminAlerts.js:notify`. Method and caveats recorded in `memory/merge-readiness-p4-p7-2026-05-13.md`.
- **P7 concurrency target re-confirmed** via read-only Convex env query: `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16`.
- **P5 split clarified**: four ordinary V1 no-op stubs are now eligible for a separate stub-cleanup code track after P4 proof (`auth.tokenRefreshOne`, `syncMetrics.syncBatchWorker`, `ruleEngine.uzBudgetBatchWorker`, `metrics.manualMassCleanup`). `adminAlerts.notify` remains under D1 redesign and should not be removed as a standalone stub cleanup.

## Executive finding

**A direct merge of `emergency/drain-scheduled-jobs` → `main` would break production.** The emergency branch deliberately disables most of the cron schedule and gates several producer paths behind `if (false && ...)` guards. Merging as-is would propagate those disablements onto `main`, silently turning off ~25 production features. **[Updated 2026-05-12: the producer-guards portion of this finding is resolved by D2a `a5ff381`. Cron-schedule disablements remain.]**

The merge is therefore not a "cleanup of leftover drain artifacts" task. It is a **gate-by-gate restoration decision** for ~26 disabled crons + several producer guards, plus a small set of cleanly-mergeable improvements. **[Updated 2026-05-12: producer guards resolved via D2a; the remaining gate-by-gate decision is for ~26 disabled crons only.]**

## State summary

### Branch ahead of `main` by 18 commits, 0 behind

```text
b0258fc prepare(sync): enable V2 cron canary registration
9f62cfa prepare(sync): gate escalation alerts during canary
3f92025 docs: record sync phase 6 prepare guardrails
a510695 prepare(sync): per-account failure check + drop V1 ready-to-uncomment block
ed5d5bf prepare(sync): runtime env reads + explicit V1 cron warning
e478dcb prepare(sync): V2 entrypoints + moderation gate (NOT enabled)
a52a2a3 prepare(uz): enable 45m V2 cron canary registration
ba5cf83 prepare(uz): layered kill-switch checks in V2 worker and dispatcher
3abc818 prepare(uz): V2 budget dispatcher canary plumbing
d1b4a01 docs: incident report Phase 2 V2 verification chronology + bloat cleanup plan
f2c9042 diag: add diagFanoutConfig action to verify V8 isolate env visibility
9aa3a68 fix: env-gated guard for error alert fan-out (cuts amplification loop)
31cf100 fix: slow token refresh fanout for nested actions
c34bbc3 fix: account for sub-action V8 slots in token refresh fan-out stagger
4373678 fix: stagger token refresh dispatch by concurrency
02bcfbb emergency: Phase 2 V2 — versioned restore for token refresh
7aa2170 emergency: Phase 1 restore — re-enable safe lightweight crons
f452348 emergency: drain-mode no-op handlers for scheduled jobs queue
```

### Cron registration counts

**[Updated 2026-05-12: this table is a historical snapshot from 2026-05-06. Numbers are not re-verified after later restores, V2 cron name swaps, or cadence changes (e.g., sync 45m→15m per `memory/sync-cadence-45-to-15-closure-2026-05-07.md`). Do not treat as the current cron inventory; re-count `convex/crons.ts` if a current number is needed.]**

| Source | Active crons |
|---|---:|
| `main:convex/crons.ts` | **31** |
| `branch:convex/crons.ts` | **6** |
| Commented out in branch | **26** (some overlap due to V1→V2 cron name reuse) |

### Active crons in branch

- `sync-metrics` (V2 dispatcher, 45 min)
- `uz-budget-increase` (V2 dispatcher, 45 min)
- `proactive-token-refresh` (V2 dispatcher, 2h)
- `cleanup-stuck-payments` (Phase 1 restore)
- `cleanup-old-logs` (Phase 1 restore)
- `cleanup-expired-invites` (Phase 1 restore)

### Disabled in branch (commented out, were active in `main`)

Approximately 25 crons including (non-exhaustive list inferred from comment patterns):

- `daily-digest`, `weekly-digest`, `monthly-digest`
- `monthly-org-report`
- `ai-recommendations`
- `analyze-new-creatives`
- `validate-community-profiles`
- `agency-token-health`
- `function-verification`
- `cleanup-old-metrics-daily`
- `cleanup-old-realtime-metrics`
- `cleanup-old-ai-generations`
- `cleanup-credential-history`
- `vk-throttling-probe`
- `video-rotation-tick`
- `uz-budget-reset`
- And several others

The exact list and recommended restore order is governed by `docs/2026-05-06-restore-matrix-uz-runbook.md`.

### V1 no-op stubs still present in branch

Originally six files contained V1 handlers that have been gutted to no-op while keeping the original signature so existing `_scheduled_jobs` entries with V1 `udfPath` still resolve:

- `convex/auth.ts` (`tokenRefreshOne`)
- `convex/syncMetrics.ts` (`syncBatchWorker`)
- `convex/ruleEngine.ts` (`uzBudgetBatchWorker`)
- `convex/metrics.ts` (`manualMassCleanup`)
- ~~`convex/vkApiLimits.ts` (`recordRateLimit`)~~ **[Updated 2026-05-12: restored as live D2a mutation `a5ff381`. No longer a no-op. Body is `statusCode === 429 ? insert : null`. Historical `_scheduled_jobs` V1 rows for this udfPath may still exist as residue, but the function is live — see V1 backlog drain note in pre-merge checklist below.]**
- `convex/adminAlerts.ts` (`notify`)

So as of 2026-05-12 the live no-op-stub list is **five files** (excluding `vkApiLimits.ts` which was restored).

### Producer guards in `convex/vkApi.ts`

**[Updated 2026-05-12: this section is historical. As of D2a (`a5ff381`, 2026-05-07), the four sites no longer use `if (false && hasData)` guards. They were converted to direct `ctx.runMutation(internal.vkApiLimits.recordRateLimit, ...)` via async `onResponse` callback, with one-row-per-logical-call enforcement in `callMtApi` (`saw429` state). Four affected functions: `getMtStatistics`, `getCampaignsSpentTodayBatch`, `getMtLeadCounts`, `getMtBanners`. Evidence snapshot 2026-05-12: lines 556, 683, 875, 1086 in this same order (shifted slightly from original 546/676/871/1085). Function names are the stable identifier; line numbers are evidence, not proof. No further merge action required for these guards.]**

Original 2026-05-06 description preserved for history: four sites guarded by `if (false && hasData)` to suppress `recordRateLimit` scheduling during drain at lines 546, 676, 871, 1085. These guards were dead code in any non-drain mode and were to be either removed or replaced with the bounded telemetry redesign before merge.

### TEMP diagnostic in branch

- `auth.diagFanoutConfig` (added by `f2c9042`) — explicitly TEMP, "remove after fanout stabilization confirmed by 2 clean ticks". Phase 2 closed `2026-05-05`, Phase 8 in progress today; cleanup of this stub is now safe.

## Classification of the 18 commits

### Recovery-essential — keep in `main` as-is

These bring forward stable improvements that stand alone without the drain-mode framing.

| Commit | Why keep |
|---|---|
| `7aa2170` Phase 1 restore | Restores three safe cleanup crons. Already represents net-positive change to `crons.ts`. |
| `02bcfbb` Phase 2 V2 token refresh | Adds `tokenRefreshOneV2` real handler + dispatcher rewiring. Necessary for current production. |
| `4373678` first stagger fan-out | Foundational fan-out helper. |
| `c34bbc3` slotsPerWorker math | Improves the helper. |
| `31cf100` `slotsPerWorker=3, stagger=7s` | Final calibration. Required for correctness of Phase 2/5/6 production runs. |
| `9aa3a68` `DISABLE_ERROR_ALERT_FANOUT` env guard | Architectural fix to amplification loop. Default value handling is the only nuance — see Constraints below. |
| `e478dcb` V2 sync entrypoints | Required for live sync. |
| `ed5d5bf` runtime env reads for sync sizing | Required for live sync. |
| `a510695` per-account failure check + drop V1 sync block | Required for monitoring correctness. |
| `9f62cfa` sync escalation alert guard | Architectural; depends on `SYNC_ESCALATION_ALERTS_ENABLED` env. |
| `b0258fc` V2 sync cron registration | Required to keep V2 sync running. |
| `3abc818` V2 UZ dispatcher | Required for live UZ. |
| `ba5cf83` UZ kill-switch checks | Required for live UZ. |
| `a52a2a3` UZ V2 cron registration | Required for live UZ. |
| `3f92025`, `d1b4a01` docs | Documentation only. |

### Drain-only — require reverse transformation before merge

These cannot ride into `main` as-is. Each needs an explicit decision before merge.

| Artifact | What it does in branch | What needs to happen for `main` |
|---|---|---|
| `f452348` mass cron commenting | 25+ production crons commented out | Decide cron-by-cron whether to restore (per restore matrix). Effectively this means many separate decisions, not one. |
| `f452348` V1 no-op stubs (6 files) | Drains old `_scheduled_jobs` entries quietly | Decision: keep stubs in `main` indefinitely (safe but confusing), or remove only after V1 backlog in `_scheduled_jobs` is verified fully drained. |
| ~~`f452348` `vkApi.ts` producer guards~~ **[Updated 2026-05-12: RESOLVED via D2a `a5ff381` 2026-05-07.]** | ~~4 sites of `if (false && hasData)` for `recordRateLimit`~~ Producers now call `ctx.runMutation(internal.vkApiLimits.recordRateLimit, ...)` directly via async `onResponse`. | **No merge action required.** Row retained for history. |

### TEMP diagnostic — decide

| Artifact | Path forward |
|---|---|
| `f2c9042` `auth.diagFanoutConfig` | Remove before merge. Phase 8 already used it, no further use planned. |

## Critical constraints any merge strategy must honor

1. **Cannot delete V1 handlers without backlog drain proof.** Current `_scheduled_jobs` may still contain entries with `udfPath` like `auth.js:tokenRefreshOne`, `syncMetrics.js:syncBatchWorker`. Removing the handlers would break these entries. Verify drain via latest-state `_scheduled_jobs` query before any V1 handler delete.

2. **Cannot restore producer guards in `vkApi.ts` without `recordRateLimit` redesign.** Removing `if (false && ...)` and re-enabling the producers would re-create the 248k pending backlog problem from the original incident.

3. **Cannot restore disabled crons en masse.** Each cron has its own risk profile. The restore matrix in `docs/2026-05-06-restore-matrix-uz-runbook.md` defines per-cron triggers (business decision, usage signal, storage pressure). Bulk restore would re-introduce the conditions that caused the original incident.

4. **`DISABLE_ERROR_ALERT_FANOUT` default for `main`** — the guard reads the env var at module load. `main` users without this env set will see fan-out behavior. This is correct because `adminAlerts.notify` in `main` is real and notifications should fan out. But the `runAfter(0)` per error log architecture is what caused the amplification. **Recommendation: pair the merge of `9aa3a68` with the alert redesign (Trigger D1)**, not a standalone merge.

5. **V2 cron registrations replace V1 paths.** When merging V2 crons into `main`, the corresponding V1 cron registrations must be removed. The branch already does this for `sync-metrics`, `uz-budget-increase`, `proactive-token-refresh`. Verify no straggling V1 cron registration in any other path.

6. **`emergency/drain-scheduled-jobs` is currently the deployment branch.** Production deploys come off this branch (`b0258fc` is live). Merging into `main` does not switch the deploy source automatically; CI/CD configuration needs review. Without that step, `main` becomes correct documentation but `emergency` keeps being deployed.

## Three candidate strategies

### Strategy A — Cherry-pick recovery commits, leave drain artifacts in branch

Pick `02bcfbb`, `4373678`, `c34bbc3`, `31cf100`, `9aa3a68`, `7aa2170`, `e478dcb`, `ed5d5bf`, `a510695`, `9f62cfa`, `b0258fc`, `3abc818`, `ba5cf83`, `a52a2a3`, `3f92025`, `d1b4a01` (and `f2c9042` deleted) onto `main` as a series of small PRs. Leave `f452348` (drain patch) only in the emergency branch. Production deploy source switches to `main` once cherry-picks land.

**Pros**

- `main` never sees the no-op stubs or producer guards.
- Each cherry-pick is reviewable in isolation.
- History on `main` reads cleanly without "drain mode" entries.

**Cons**

- Cherry-picks may not apply cleanly because `f452348` reshapes many files; subsequent commits sit on top of a drained tree.
- Substantial conflict-resolution work per cherry-pick.
- The "drain handler signatures with no-op bodies" became the de-facto contract for V2 to coexist with backlog. Skipping `f452348` means re-engineering that coexistence on `main`.

**Verdict**: clean theoretically, conflict-prone in practice. Probably highest engineering effort.

### Strategy B — Full merge, then follow-up cleanup PRs

Merge the whole branch into `main` as-is, then immediately open a series of cleanup PRs that:

- Restore each disabled cron (cron-by-cron, per restore matrix).
- Replace producer guards with bounded redesign once D2 lands.
- Remove V1 no-op stubs after backlog drain proof.
- Remove `auth.diagFanoutConfig`.

**Pros**

- Single clean merge moment for the recovery code itself.
- Conflict-free (branch only adds and modifies, does not lose information).
- Each follow-up PR is small and per-concern.

**Cons**

- Between merge and follow-ups, `main` deliberately ships disabled production features. If anything triggers a fresh `main` deploy in that window (CI/CD reset, accidental rebase, infra rotation), production loses crons.
- Requires discipline to actually ship the follow-ups.
- Pollutes `main` history with "ship it then unship it" patterns.

**Verdict**: lowest immediate effort, highest medium-term risk if follow-ups slip.

### Strategy C — Reverse-transform the branch first, then merge

In a dedicated session on the emergency branch:

1. Restore each cron one by one (over multiple sessions, gated by restore matrix triggers).
2. ~~Implement `recordRateLimit` redesign (D2) and remove producer guards.~~ **[Updated 2026-05-12: DONE via D2a `a5ff381` 2026-05-07. D2b/D2c/Option D explicitly deferred — not part of merge prerequisite.]**
3. Implement `adminAlerts.notify` redesign (D1) and complete D1c (handler restore). **[Updated 2026-05-12: still pending. D1a/D1b/D1c sequential sub-steps per design doc. Original 2026-05-06 wording said "remove `DISABLE_ERROR_ALERT_FANOUT` reliance" — corrected per D1 design doc Open Questions section: env flag is intentionally **retained** as a kill-switch after D1c, normally `0` once D1c canary clean, set to `1` only as fast revert path for any future amplification surprise.]**
4. Verify V1 backlog is fully drained, remove V1 no-op stubs. **[Updated 2026-05-12: now five stubs to delete (vkApiLimits.recordRateLimit excluded — restored as live D2a mutation).]**
5. Remove `auth.diagFanoutConfig`.
6. At that point the branch contains only V2 architecture and operational improvements.
7. Then merge.

**Pros**

- The merge itself becomes uneventful.
- `main` never sees a regressed state.
- Forces explicit decisions on each constraint before they hit `main`.

**Cons**

- Slowest end-to-end. Could be weeks before merge.
- Branch lives long. Increases merge-conflict risk if `main` evolves separately.
- During this period, production deploys keep coming off the emergency branch, which is fine but feels permanent.

**Verdict**: safest, slowest. The "right" choice given the recovery posture.

## Recommendation

Adopt **Strategy C** as the planned path, with explicit milestones tied to the post-Phase-8 checklist. Concretely:

1. Continue current production posture: deploy from `emergency/drain-scheduled-jobs`. Do not rush to merge.
2. Treat each cron restoration in the restore matrix as a step toward merge readiness, not just a runtime decision.
3. ~~Adopt Trigger D1 (`adminAlerts.notify` redesign) and Trigger D2 (`recordRateLimit` redesign) as hard prerequisites for merge.~~ **[Updated 2026-05-12: D2 prerequisite met via D2a `a5ff381` 2026-05-07. D1 still required as hard prerequisite — see D1 design doc and pre-merge checklist below.]**
4. Once all disabled crons have an explicit decision (restored or formally retired) and D1+D2 land, schedule a "merge readiness audit" session.
5. Only after that audit, merge.

If business or engineering pressure forces faster merge, Strategy B is the fallback, with explicit awareness that follow-up PRs become load-bearing for production correctness.

Strategy A is not recommended unless someone wants to take on the cherry-pick conflict resolution as a deliberate choice.

## Pre-merge readiness checklist

Items must all be true before the merge readiness audit:

- [x] Phase 8 closed clean. **[Updated 2026-05-12: confirmed closed clean at `2026-05-06T17:47Z = 20:47 MSK` per `docs/2026-05-06-concurrency-bump-8-to-16-runbook.md` "Phase 8 strict closure" section (line 358). Final state: `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16`. Key canary token refresh `17:09Z` passed.]**
- [x] `getAccountAllAdIds` Tier 1 fix landed (`9768449`) and closure recorded (`memory/b1-closure-2026-05-06.md`).
- [x] `getAccountAllAdIds` organic E2E / ≥1 week observation confirmed by read-only query. **[Updated 2026-05-13: B1 observation gate closed clean. 7-day window cutoff `2026-05-13T19:53:27Z`; post-window read-only verification at `2026-05-13T19:55:59Z` (`+2m32s`) confirmed full-window absence-of-regression — both target accounts synced continuously, 0 `checkRulesForAccount timed out` patterns vs. 4 historical per account, function-level direct call within latency budget with natural ad-count growth (Вардек 1327→1334, Интерьер 1136→1144). Background systemLogs noise fully attributable (controlled `d1a-gate-test`/`d1b-gate-test` bursts + 2 unrelated pre-D1a `auth` rows from 2026-05-10). Caveat preserved from 2026-05-12: positive-trigger E2E remains **inconclusive** (not failed) — current rule configuration cannot produce positive evidence (Вардек's relevant rule quiet pre-deploy, Интерьер no current active relevant rule); this is a configuration condition, not a B1 fault. Checkbox marked because the checklist criterion is "observation confirmed by read-only query", which is satisfied; inconclusive positive-trigger is a known scope limitation, not a regression. See `memory/b1-closure-2026-05-06.md` "Organic E2E read-only verification (2026-05-13) — 7-day window closed" for full evidence and methodology.]**
- [ ] All 26 disabled crons have an explicit decision in `docs/2026-05-06-restore-matrix-uz-runbook.md`: either restored in branch or marked as retired with rationale.
- [ ] `adminAlerts.notify` redesign (D1) landed and canary-clean (D1c handler restore deployed and observed). `DISABLE_ERROR_ALERT_FANOUT` env flag retained as kill-switch per D1 design recommendation, normally `0` after D1c canary clean. **[Updated 2026-05-12: still blocking. D1 design ready (`docs/2026-05-06-adminAlerts-notify-redesign-design.md`); D1a/D1b/D1c implementation sessions all pending. Commit `9aa3a68` env gate is emergency suppression, not Tier 1 fix. `convex/adminAlerts.ts:144` handler still no-op. Original 2026-05-06 wording said "env reliance removed" — corrected: env flag is intentionally retained per D1 design Open Questions section.]**
- [x] **`recordRateLimit` redesign (D2a) landed `a5ff381` 2026-05-07; `vkApi.ts` producer guards removed (4 sites converted to direct `ctx.runMutation` via async `onResponse`).** [Updated 2026-05-12: D2b sampled-headers, D2c aggregated state, and Option D `vk-throttling-probe` cron explicitly deferred per design doc — not blocking merge. Closure: `memory/d2a-closure-2026-05-07.md`.]
- [x] V1 backlog in `_scheduled_jobs` verified fully drained via latest-state query for: `auth.js:tokenRefreshOne`, `syncMetrics.js:syncBatchWorker`, `ruleEngine.js:uzBudgetBatchWorker`, `metrics.js:manualMassCleanup`, `vkApiLimits.js:recordRateLimit`, `adminAlerts.js:notify`. Each must show `0` pending and `0` inProgress in latest state. **[Updated 2026-05-12: `vkApiLimits.js:recordRateLimit` is now the live D2a mutation, not a V1 no-op stub. The check for this udfPath is therefore **not** a V1-stub-removal gate — the function body is already restored. The check serves a different purpose: prove that (a) the old `runAfter(0)` scheduled-transport path has not silently returned (e.g., via accidental re-introduction of producer scheduling), and (b) historical pre-D2a `_scheduled_jobs` residue is not growing post-D2a. Per D2a design doc: "blocking condition is growth after D2a deploy, not historical residue before deploy." Baseline reference: `memory/d2a-closure-2026-05-07.md`. The other five udfPaths in this list remain V1-stub-removal gates as originally intended.]** **[Updated 2026-05-13: verified by read-only Convex admin path, not raw PG: `_scheduled_functions --limit 8000 --format jsonLines`; all six target `udfPath`s showed `pending=0` and `inProgress=0`. PG raw probe ban remains active; see `memory/merge-readiness-p4-p7-2026-05-13.md`.]**
- [ ] V1 no-op stubs deleted from all ~~six~~ ~~five~~ **four ordinary cleanup-track files; `adminAlerts.notify` deferred to D1**. **[Updated 2026-05-12: `vkApiLimits.ts` `recordRateLimit` restored to live mutation via D2a; only `auth.tokenRefreshOne`, `syncMetrics.syncBatchWorker`, `ruleEngine.uzBudgetBatchWorker`, `metrics.manualMassCleanup`, `adminAlerts.notify` remain as no-op stubs to delete after V1 backlog drain proof.]** **[Updated 2026-05-13: P4 backlog proof is now closed. Ordinary stub-cleanup is unblocked for `convex/auth.ts`, `convex/syncMetrics.ts`, `convex/ruleEngine.ts`, and `convex/metrics.ts`. Do not remove `convex/adminAlerts.ts` `notify` as a standalone cleanup; it remains coupled to D1 (`adminAlerts.notify` redesign and D1c handler restore).]**
- [ ] `auth.diagFanoutConfig` deleted.
- [x] Concurrency `APPLICATION_MAX_CONCURRENT_V8_ACTIONS` confirmed stable at the production target (currently 16). **[Updated 2026-05-13: read-only `npx convex env get APPLICATION_MAX_CONCURRENT_V8_ACTIONS` returned `16`; see `memory/merge-readiness-p4-p7-2026-05-13.md`.]**
- [ ] CI/CD deploy source reviewed; switch from `emergency/drain-scheduled-jobs` to `main` planned and tested.

## Out of scope for this audit

- Choosing the merge time. That depends on operational schedule and is the operator's call.
- Estimating each follow-up PR effort beyond a coarse "small, per-concern" framing.
- Branching strategy for D1/D2 redesigns (own design tickets).
- Documentation cleanup of `docs/` recovery files. They are valid history; do not retro-edit them.
- Memory file consolidation. Separate housekeeping concern.

## Reading order if a future operator picks this up cold

1. `docs/2026-05-05-convex-scheduled-jobs-incident-report.md` — the original incident.
2. `docs/2026-05-05-convex-recovery-plan-execution-report.md` — what was done during recovery.
3. `docs/2026-05-06-restore-matrix-uz-runbook.md` — current state of all gates and crons.
4. `docs/2026-05-06-post-phase-8-checklist.md` — sequence of post-recovery work.
5. **This document** — merge planning specifically.
6. Trigger E2 row in the post-Phase-8 checklist references back here.

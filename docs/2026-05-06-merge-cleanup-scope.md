# Merge cleanup scope: `emergency/drain-scheduled-jobs` → `main`

Date: 2026-05-06
Branch: `emergency/drain-scheduled-jobs`
Status: **scope analysis only — no merge action authorized**

This document is a read-only audit of what currently lives on the emergency branch versus `main`, classifies the differences, and surfaces the constraints that any merge strategy must honor. It does not propose a merge timing.

## Executive finding

**A direct merge of `emergency/drain-scheduled-jobs` → `main` would break production.** The emergency branch deliberately disables most of the cron schedule and gates several producer paths behind `if (false && ...)` guards. Merging as-is would propagate those disablements onto `main`, silently turning off ~25 production features.

The merge is therefore not a "cleanup of leftover drain artifacts" task. It is a **gate-by-gate restoration decision** for ~26 disabled crons + several producer guards, plus a small set of cleanly-mergeable improvements.

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

Six files contain V1 handlers that have been gutted to no-op while keeping the original signature so existing `_scheduled_jobs` entries with V1 `udfPath` still resolve:

- `convex/auth.ts` (`tokenRefreshOne`)
- `convex/syncMetrics.ts` (`syncBatchWorker`)
- `convex/ruleEngine.ts` (`uzBudgetBatchWorker`)
- `convex/metrics.ts` (`manualMassCleanup`)
- `convex/vkApiLimits.ts` (`recordRateLimit`)
- `convex/adminAlerts.ts` (`notify`)

### Producer guards in `convex/vkApi.ts`

Four sites guarded by `if (false && hasData)` to suppress `recordRateLimit` scheduling during drain:

- Line 546
- Line 676
- Line 871
- Line 1085

These guards are dead code in any non-drain mode and should be either removed or replaced with the bounded telemetry redesign before merge.

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
| `f452348` `vkApi.ts` producer guards | 4 sites of `if (false && hasData)` for `recordRateLimit` | Replace with bounded redesign (Trigger D2 in post-Phase-8 checklist). Until that lands, leaving producers disabled in `main` is acceptable but the `if (false && ...)` shape is misleading. |

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
2. Implement `recordRateLimit` redesign (D2) and remove producer guards.
3. Implement `adminAlerts.notify` redesign (D1) and remove `DISABLE_ERROR_ALERT_FANOUT` reliance.
4. Verify V1 backlog is fully drained, remove V1 no-op stubs.
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
3. Adopt Trigger D1 (`adminAlerts.notify` redesign) and Trigger D2 (`recordRateLimit` redesign) as hard prerequisites for merge.
4. Once all disabled crons have an explicit decision (restored or formally retired) and D1+D2 land, schedule a "merge readiness audit" session.
5. Only after that audit, merge.

If business or engineering pressure forces faster merge, Strategy B is the fallback, with explicit awareness that follow-up PRs become load-bearing for production correctness.

Strategy A is not recommended unless someone wants to take on the cherry-pick conflict resolution as a deliberate choice.

## Pre-merge readiness checklist

Items must all be true before the merge readiness audit:

- [ ] Phase 8 closed clean.
- [x] `getAccountAllAdIds` Tier 1 fix landed (`9768449`) and closure recorded (`memory/b1-closure-2026-05-06.md`).
- [ ] `getAccountAllAdIds` organic E2E / ≥1 week observation confirmed by read-only query. The observation window has elapsed, but no canonical verification query is recorded yet.
- [ ] All 26 disabled crons have an explicit decision in `docs/2026-05-06-restore-matrix-uz-runbook.md`: either restored in branch or marked as retired with rationale.
- [ ] `adminAlerts.notify` redesign (D1) landed; `DISABLE_ERROR_ALERT_FANOUT` env reliance removed.
- [ ] `recordRateLimit` redesign (D2) landed; `vkApi.ts` producer guards removed.
- [ ] V1 backlog in `_scheduled_jobs` verified fully drained via latest-state query for: `auth.js:tokenRefreshOne`, `syncMetrics.js:syncBatchWorker`, `ruleEngine.js:uzBudgetBatchWorker`, `metrics.js:manualMassCleanup`, `vkApiLimits.js:recordRateLimit`, `adminAlerts.js:notify`. Each must show `0` pending and `0` inProgress in latest state.
- [ ] V1 no-op stubs deleted from all six files.
- [ ] `auth.diagFanoutConfig` deleted.
- [ ] Concurrency `APPLICATION_MAX_CONCURRENT_V8_ACTIONS` confirmed stable at the production target (currently 16).
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

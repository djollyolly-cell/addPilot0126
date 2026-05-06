# After Phase 8 closure: next steps checklist

Date: 2026-05-06
Branch context: `emergency/drain-scheduled-jobs`
Status: planning document — applies after Phase 8 (concurrency bump 8→16) is closed clean

This document organizes everything that should be done **after** Phase 8 closure (`~17:40-17:45Z = 20:40-20:45 MSK` 2026-05-06 if canaries stay clean), so a future session does not need to reconstruct context from scattered runbooks and memory files.

The list is grouped by trigger condition. Items are independent unless explicitly noted.

## Trigger A — immediately after Phase 8 strict closure

These are housekeeping items that need to land while Phase 8 context is still fresh.

- **Append closure block to runbook.** Add the actual `17:09Z` token refresh canary results, post-token UZ/sync ticks, and final strict-closure timestamp to `docs/2026-05-06-concurrency-bump-8-to-16-runbook.md` Execution log. Include `pg_wal` byte-exact post-canary delta.
- **Update memory** (`memory/phase-6-sync-canary-status.md`): replace "Phase 8 in progress" block with "Phase 8 closed clean" plus closure timestamp. Update operating gates line to reflect `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=16`.
- **Update execution report** (`docs/2026-05-05-convex-recovery-plan-execution-report.md`): add Phase 8 row to status table, append closure section after Phase 6 Live Reopen section.
- **Update incident report** (`docs/2026-05-05-convex-scheduled-jobs-incident-report.md`): append Phase 8 closure note to Phase 6 organic results section.

These should happen in one short documentation session; no prod changes.

## Trigger B — separate dedicated session, non-emergency

These are scoped tasks that should each get their own session, not bundled together.

### B1. Tier 1 fix for `getAccountAllAdIds` (Option A)

- Design doc: `docs/2026-05-06-getAccountAllAdIds-fix-design.md`
- Tracking memory: `memory/todo-getAccountAllAdIds-pagination.md`
- Pre-Tier-1 safety gate: PASSED on `2026-05-06` for two known affected accounts. Numbers recorded in design doc.
- Scope: change body of one function in `convex/ruleEngine.ts:647-660`. No schema change. No call-site changes.
- Effort: ~1.5h including unit test, diagnostic verification, deploy.
- Why now: this is a real production correctness bug (rule evaluation silently fails on 2+ active accounts). It pre-dates the incident; recovery exposed it but did not cause it. User-visible symptom: `cpl_limit since_launch` rules do not stop ads on heavy accounts.
- Why a separate session: this is a code change, deploy, and verification — different rhythm from operational bumps. Bundling with anything else risks scope creep.

### B2. Pre-existing zero-spend alerts re-enable

- Tracking: `memory/zero-spend-alerts-todo.md`
- Status before incident: alerts disabled due to false positives.
- Pre-req: investigate why false positives were happening, design correction.
- Not part of recovery; separate.

## Trigger C — after at least one week of post-Phase-8 stability

These need actual production observation data on `concurrency=16` before being decided. Premature execution loses optionality.

### C1. Sync worker/batch bump

- Candidates: `SYNC_WORKER_COUNT_V2 1→2` or `SYNC_BATCH_SIZE_V2 10→30`.
- Goal: sync more of the 264 accounts per tick. Currently `1 worker × 10 batch = 10 accounts / 45 min = ~13 accounts/h = ~20h for full pass`.
- Pre-req: review V8 utilization data after Phase 8 to confirm headroom is real.
- Expected runbook structure: similar to concurrency bump runbook; needs new pre-bump baseline, single env change, post-bump canary, exit criteria.

### C2. UZ reset cron

- Currently disabled. Needed if full UZ budget lifecycle (increase + reset) is desired.
- Pre-req: business decision on whether daily reset behavior is wanted.
- Code likely already in place, just needs cron registration.

### C3. Moderation polling

- `SYNC_METRICS_V2_POLL_MODERATION` currently `0`.
- Pre-req: signal that creatives feature actively needs AI banner moderation polling.
- Otherwise leave off.

### C4. Safe cleanup/storage crons

- Several disabled cleanup crons listed in `docs/2026-05-06-restore-matrix-uz-runbook.md` restore matrix.
- Pre-req: storage pressure signal (none currently observed; `pg_wal` flat at `1.6 GB`).
- If no storage pressure, defer indefinitely.

## Trigger D — last wave, requires bounded redesign

These should not be reactivated as-is. Each requires design work before any code.

### D1. `adminAlerts.notify` redesign

- Currently: handler is no-op, fan-out gate `DISABLE_ERROR_ALERT_FANOUT=1`.
- Original problem: `systemLogger.log({level: "error"})` scheduled `adminAlerts.notify` per error, which was the amplification loop component of the incident.
- Required redesign: batched/dedup alert queue instead of per-log scheduling. Possibly bounded retry, dedup window, severity gating.
- Coupled with: lifting `DISABLE_ERROR_ALERT_FANOUT` and enabling `SYNC_ESCALATION_ALERTS_ENABLED`.
- Effort: design session + implementation session + canary; multi-day.

### D2. `recordRateLimit` bounded redesign

- Currently: handler no-op, producers in `convex/vkApi.ts` disabled (`if (false && hasData)` guards).
- Original problem: was scheduled per VK API response → 248k pending jobs at incident peak.
- Required redesign: one of: bounded insert only on 429, sampling (1/min/account/endpoint), or batch aggregation in action.
- Effort: design session + implementation session; multi-day.

### D3. `vk-throttling-probe` cron

- Currently disabled. Depends on `recordRateLimit` redesign.
- No standalone work needed before D2 lands.

## Trigger E — after all of the above are stable

### E1. Cleanup of drain-mode artifacts

- V1 no-op handlers: `auth.tokenRefreshOne`, `syncMetrics.syncBatchWorker`, `ruleEngine.uzBudgetBatchWorker`, `metrics.manualMassCleanup`. Keep until historical V1 backlog in `_scheduled_jobs` is verified fully drained.
- Producer guards `if (false && hasData)` in `convex/vkApi.ts` — remove only when D2 lands.
- TEMP diagnostic action `auth.diagFanoutConfig` — can remove once `concurrency=16` is fully confirmed in production for some weeks.
- TEMP diagnostic functions per CLAUDE.md memory: `debugMetrics`, `backfillVkResults`, `diagnosLeadsForAccount` in `convex/syncMetrics.ts`; `diagnosLeads` in `convex/vkApi.ts`.

### E2. Merge `emergency/drain-scheduled-jobs` → `main`

- **Full scope analysis already done**: see `docs/2026-05-06-merge-cleanup-scope.md`.
- Headline finding: branch is 18 commits ahead, 0 behind, but a direct merge would propagate disablement of ~25 production crons + 4 producer guards in `vkApi.ts`. **Direct merge would break production.**
- Three candidate strategies (A: cherry-pick, B: full merge + follow-ups, C: reverse-transform branch first then merge) analyzed in the scope doc.
- **Recommended path**: Strategy C. Pre-merge readiness checklist with 9 hard prerequisites is in the scope doc.
- Pre-reqs (summary): E1 cleanup done, D1 (`adminAlerts.notify` redesign) landed, D2 (`recordRateLimit` redesign) landed, all 26 disabled crons have explicit decisions, V1 backlog drained, V1 stubs removed, `auth.diagFanoutConfig` removed, CI/CD deploy source switch planned.
- Not a single-PR effort; expect a series of small PRs once readiness is met.

## What this checklist intentionally omits

- Any new feature work. Recovery aftermath is not the time for feature scope.
- Concurrency `16→32` bump. Explicitly out of scope per concurrency runbook ("Do not combine"), separate runbook required.
- Fixing zero-spend alerts beyond just identifying it as a tracked TODO.
- Architecture-level rule-engine refactor. Tier 2 of `getAccountAllAdIds` design covers part of that, but only re-evaluated after Tier 1 observation.

## Reading order if a future operator picks this up cold

1. `docs/2026-05-05-convex-scheduled-jobs-incident-report.md` — what happened.
2. `docs/2026-05-05-convex-recovery-plan-execution-report.md` — what was done.
3. `docs/2026-05-05-convex-drain-reenable-plan.md` — phased recovery framework.
4. `docs/2026-05-06-restore-matrix-uz-runbook.md` — current state of all gates and crons.
5. `docs/2026-05-06-concurrency-bump-8-to-16-runbook.md` — Phase 8 details and execution log.
6. **This checklist** — what is left to do.
7. `memory/phase-6-sync-canary-status.md` — short ongoing status.
8. `memory/todo-getAccountAllAdIds-pagination.md` — pre-existing bug tracking.
9. `docs/2026-05-06-getAccountAllAdIds-fix-design.md` — design for the bug fix.

This ordering minimizes context loss and avoids duplicate decision-making.

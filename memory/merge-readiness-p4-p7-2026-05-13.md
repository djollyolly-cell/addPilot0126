# Merge Readiness P4/P7 Read-Only Verification — 2026-05-13

Date: 2026-05-13
Branch source: `origin/emergency/drain-scheduled-jobs` at `63a286beb456ceb3a47fdceeb3c3598158e3e92c`
Scope: pre-merge readiness checklist items P4 and P7 in `docs/2026-05-06-merge-cleanup-scope.md`.
Status: **read-only verification complete; docs updated; no runtime change**

## Guardrails

- No deploy.
- No env mutation.
- No code change.
- No raw PostgreSQL.
- No `docker exec`.
- No direct reads against PG `documents` / `indexes`.

Method used: Convex admin read-only path only.

This matters because `memory/pg-readonly-diagnostic-2026-05-11.md` keeps the PG raw probe ban active (`shared_buffers=128 MB`, `documents heap_hit < 50%`). Convex admin reads (`npx convex env get`, `npx convex data`) are explicitly separate from the banned raw PG probe class.

## P7 — Concurrency Target

Command class: read-only Convex env query.

Result:

```text
APPLICATION_MAX_CONCURRENT_V8_ACTIONS = 16
```

Verdict: **P7 verified.** Production still matches the Phase 8 target.

## P4 — V1 Backlog Latest-State Proof

Command class: read-only Convex admin system table query.

Sample:

```text
npx convex data _scheduled_functions --limit 8000 --format jsonLines
```

The query was aggregated locally; no raw SQL was used. The relevant merge-readiness target set was:

- `auth.js:tokenRefreshOne`
- `syncMetrics.js:syncBatchWorker`
- `ruleEngine.js:uzBudgetBatchWorker`
- `metrics.js:manualMassCleanup`
- `vkApiLimits.js:recordRateLimit`
- `adminAlerts.js:notify`

Result:

| udfPath | pending | inProgress | Notes |
|---|---:|---:|---|
| `auth.js:tokenRefreshOne` | 0 | 0 | V1 token-refresh stub backlog drained in latest-state sample. |
| `syncMetrics.js:syncBatchWorker` | 0 | 0 | V1 sync stub backlog drained in latest-state sample. |
| `ruleEngine.js:uzBudgetBatchWorker` | 0 | 0 | V1 UZ stub backlog drained in latest-state sample. |
| `metrics.js:manualMassCleanup` | 0 | 0 | V1 cleanup stub backlog drained in latest-state sample. |
| `vkApiLimits.js:recordRateLimit` | 0 | 0 | Not a V1-stub-removal gate after D2a, but confirms old scheduler-transport path did not reappear in the latest-state sample. Baseline: `memory/d2a-closure-2026-05-07.md`. |
| `adminAlerts.js:notify` | 0 | 0 | Backlog drained, but handler restore/removal remains D1 scope, not ordinary stub cleanup. |

Verdict: **P4 verified.** The latest-state sample satisfies the checklist condition: each target showed `0` `pending` and `0` `inProgress`.

## Follow-Up Implication

P4 unblocks a separate ordinary V1 stub-cleanup track for four files:

- `convex/auth.ts` (`tokenRefreshOne`)
- `convex/syncMetrics.ts` (`syncBatchWorker`)
- `convex/ruleEngine.ts` (`uzBudgetBatchWorker`)
- `convex/metrics.ts` (`manualMassCleanup`)

Do **not** remove `convex/adminAlerts.ts` `notify` as a standalone cleanup. It remains coupled to D1 (`adminAlerts.notify` redesign and D1c handler restore/canary).

## Checklist Updates

`docs/2026-05-06-merge-cleanup-scope.md` was updated to:

- mark P4 as complete;
- mark P7 as complete;
- split P5 so ordinary stub cleanup covers four files while `adminAlerts.notify` remains deferred to D1.

Doc-only. No runtime, no env, no deploy, no SQL.

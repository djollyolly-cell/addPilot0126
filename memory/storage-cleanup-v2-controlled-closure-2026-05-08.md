# Storage Cleanup V2 - Controlled Run Closure - 2026-05-08

Status: clean
Trigger time: 2026-05-08T07:35:05.482Z
runId: 1778225705482-b8b7b8deb8ac
Params: batchSize=500, timeBudgetMs=10000, restMs=90000, maxRuns=3

## Preconditions

- Phase 4 closure: `memory/storage-cleanup-v2-canary-closure-2026-05-08.md`, status clean.
- Phase 5 runbook: `memory/storage-cleanup-v2-phase5-controlled-runs-runbook-2026-05-08.md` at commit `1178288`.
- Env pre: `METRICS_REALTIME_CLEANUP_V2_ENABLED=0`.
- Cron status: `cleanup-old-realtime-metrics` still commented in `convex/crons.ts`.
- `cleanupRunState` pre: no active V2 row. Only prior Phase 4 canary row was `completed`, `isActive=false`.
- Core heartbeats pre: clean. `syncDispatch`, `uzBudgetDispatch`, and `tokenRefreshDispatch` were `completed`, `error=null`.

## Git / Deploy Context

- HEAD == origin/emergency/drain-scheduled-jobs == `1178288`.
- No code change was made for this run.
- No deploy was run during this closure.
- Production cleanup behavior/payload remained the Phase 1 cleanup V2 implementation introduced in `2410f14`.
- This closure memo is doc-only.

## Anchors

| Anchor | Pre | Post | Delta | Threshold | Verdict | Source |
|---|---:|---:|---:|---|---|---|
| `/version` | HTTP 200, `2.203963s / 1.498784s / 1.518851s` | HTTP 200, `1.512460s / 1.243989s / 1.311503s` | n/a | HTTP 200 | PASS | `curl https://convex.aipilot.by/version` |
| disk free | `141G` free, `54%` used | `141G` free, `54%` used | 0pp | no unexplained drop | PASS | `ssh ... "df -h /"` |
| `pg_wal` | `2,281,701,376` bytes | `2,281,701,376` bytes | `0` bytes | warn=25 MB, hard=150 MB | PASS | `ssh ... "docker exec adpilot-postgres du -sb /var/lib/postgresql/data/pg_wal"` |
| `metricsRealtime` total | `9,424,786` | not re-counted | n/a | informational | PASS | server-local `/api/list_snapshot` pre-count |
| `metricsRealtime` eligible | `9,089,514` at pre cutoff `1778047209787` | not re-counted | structural proof | first Phase 5 profile allows structural proof | PASS | server-local `/api/list_snapshot` pre-count; `cleanupRunState`; `_scheduled_functions` |
| `oldestRemainingTimestamp` | `1,777,733,701,988` (`2026-05-02T14:55:01.988Z`) | `1,777,733,705,347` (`2026-05-02T14:55:05.347Z`) | `+3,359 ms` | post >= pre | PASS | pre count; `cleanupRunState` final row |

Fresh pre-count:

```text
startedAt:  2026-05-08T06:00:12Z
completed:  2026-05-08T06:51:53Z
cutoffMs:   1778047209787
cutoffIso:  2026-05-06T06:00:09.787Z
pages:      9204
total:      9,424,786
eligible:   9,089,514
oldest:     1777733701988 (2026-05-02T14:55:01.988Z)
newest:     1778222990483 (2026-05-08T06:49:50.483Z)
```

During the long pre-count, `pg_wal` decreased from `2,650,800,128` to `2,281,701,376` bytes. This is normal checkpoint/recycle behavior and indicates no WAL pressure from the read-only count.

## Eligible Delta Cutoff Alignment

- `cleanupRunState.cutoffUsed`: `1778052905482` (`2026-05-06T07:35:05.482Z`).
- `pre_cutoff_used`: `1778047209787` (`2026-05-06T06:00:09.787Z`).
- Cutoff gap: about 95 minutes.
- Fresh exact pre-count was captured for backlog sizing and first-run safety.
- Fresh exact post-count was intentionally not run after completion. The first Phase 5 profile is `batchSize=500`, `maxRuns=3` (maximum `1500` rows), and the Phase 5 runbook allows structural proof for this first small controlled run.

Structural proof:

- `cleanupRunState.deletedCount=1500`.
- `cleanupRunState.cutoffUsed` is immutable for the run.
- `manualMassCleanupV2` uses that immutable cutoff for every chunk.
- `_scheduled_functions` shows exactly three new `metrics.js:manualMassCleanupV2` success entries for this run.
- `cleanupRunState.batchesRun=3`, matching `maxRuns=3`.
- No V2 failed entries.
- `oldestRemainingTimestamp` advanced by `3,359 ms`.

Verdict: PASS for first Phase 5 controlled profile. Larger later controlled runs should refresh eligible/backlog sizing and may require a stricter post-count delta gate.

## Scheduled Functions

| UDF | Pre failed | Post failed | Delta failed | Total entries | Success | Failed | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| `metrics.js:manualMassCleanupV2` | 0 | 0 | 0 | 4 cumulative, 3 for this run | 4 cumulative, 3 for this run | 0 | PASS |
| `metrics.js:manualMassCleanup` (V1) | 1 | 1 | 0 | n/a | n/a | n/a | PASS |
| `adminAlerts.js:notify` | 38 | 38 | 0 | n/a | n/a | n/a | PASS |
| `auth.js:tokenRefreshOneV2` | 14 | 14 | 0 | n/a | n/a | n/a | PASS |
| `ruleEngine.js:uzBudgetBatchWorkerV2` | 1 | 1 | 0 | n/a | n/a | n/a | PASS |

V2 scheduled entries for this run:

```text
2026-05-08T07:35:05.482Z success metrics.js:manualMassCleanupV2
2026-05-08T07:35:09.269Z success metrics.js:manualMassCleanupV2
2026-05-08T07:36:42.871Z success metrics.js:manualMassCleanupV2
```

These timestamps are `_scheduled_functions._creationTime` values for the job rows, not a precise wall-clock execution duration trace. The authoritative chunk timing is the `cleanupRunState` row: `batchesRun=3`, `lastBatchAt=2026-05-08T07:38:16.315Z`, `durationMs=190847`.

Notes:

- V2 failed is absolute zero, not only delta zero.
- V1 evidence is failed-counter delta zero. V1 total/success count is not used because the V1 no-op residue path has historical scheduled entries.
- A fresh `uzBudgetBatchWorkerV2` row was briefly observed as `inProgress` after the cleanup run window; it resolved to `success` before closure.

## cleanupRunState Final Row

```json
{
  "cleanupName": "metrics-realtime-v2",
  "runId": "1778225705482-b8b7b8deb8ac",
  "state": "completed",
  "isActive": false,
  "startedAt": 1778225705482,
  "lastBatchAt": 1778225896315,
  "batchesRun": 3,
  "maxRuns": 3,
  "cutoffUsed": 1778052905482,
  "deletedCount": 1500,
  "oldestRemainingTimestamp": 1777733705347,
  "durationMs": 190847,
  "batchSize": 500,
  "timeBudgetMs": 10000,
  "restMs": 90000
}
```

Derived times:

```text
startedAt:                 2026-05-08T07:35:05.482Z
cutoffUsed:                2026-05-06T07:35:05.482Z
lastBatchAt:               2026-05-08T07:38:16.315Z
durationMs:                190,847 ms
oldestRemainingTimestamp:  2026-05-02T14:55:05.347Z
error:                     undefined / absent
```

## Backend Stdout

- `[cleanup-v2]` start lines: 0.
- `[cleanup-v2]` end schedule lines: 0.
- `[cleanup-v2]` end complete lines: 0.
- `[cleanup-v2]` end failed lines: 0.
- `disabled_mid_chain` skip lines: 0.
- Rollback patterns (`Too many concurrent`, `Transient error`, `TOKEN_EXPIRED`, `syncBatchV2.*Account .* failed`, `Restarting Isolate`, `user_timeout`): 0.

`[cleanup-v2]` markers still do not surface in `adpilot-convex-backend` docker stdout in this self-hosted runtime. This matches the Phase 4 closure caveat from commit `8b96807` and is not a dirty signal. Authoritative proof for this run is `cleanupRunState` plus `_scheduled_functions`, WAL, env, and heartbeat checks.

## Core Heartbeats

| Heartbeat | Pre | Post | Verdict |
|---|---|---|---|
| `syncDispatch` | `completed`, `error=null` | `2026-05-08T07:34:10.311Z`, `completed`, `error=null` | PASS |
| `uzBudgetDispatch` | `completed`, `error=null` | `2026-05-08T07:42:10.546Z`, `completed`, `error=null` | PASS |
| `tokenRefreshDispatch` | `completed`, `error=null` | `2026-05-08T07:09:36.647Z`, `completed`, `error=null` | PASS |

The stale legacy heartbeat remains:

```text
cleanup-realtime-metrics: running since 2026-05-04T18:00:00.793Z
```

This is the known V1 residue. V2 uses `cleanupRunState` and did not read or update this heartbeat.

## Decision

Clean.

The first Phase 5 controlled run proved a three-chunk self-scheduling chain with the env gate enabled only for a short controlled window. The run deleted exactly `1500` rows, completed terminally, did not revive the V1 cleanup path, produced no V2 failed entries, did not increase WAL, and left core cron signals clean.

## Post-run State

- `METRICS_REALTIME_CLEANUP_V2_ENABLED`: `0`, verified after the run.
- `cleanup-old-realtime-metrics` cron: still commented.
- `cleanupRunState`: Phase 5 row is `completed`, `isActive=false`.
- Code/deploy: no code change, no deploy.
- Git: closure memo is doc-only.

## Phase 5 Next-Run Recommendation

Do not jump directly to Phase 6 cron restore from this single controlled run.

Recommended next runtime step, if continuing manually:

```text
batchSize:     500
timeBudgetMs:  10000
restMs:        90000
maxRuns:       5
```

Rationale: `maxRuns=5` is a conservative increase from the clean `maxRuns=3` run while preserving the same batch size and rest interval. It proves a longer chain without changing two load dimensions at once.

Sizing: this run deleted `1500` rows in about `190.8s`. A `maxRuns=5` profile would delete at most `2500` rows, still tiny relative to the fresh `9,089,514` eligible backlog.

If the operator wants to move toward cron restore instead, first harden the Phase 6 runbook with the actual Phase 5 closure values and keep the first organic cron profile derived from the last clean controlled profile.

## Phase 6 Readiness

Phase 6 is not ready for execution yet.

Required before Phase 6:

- Review this Phase 5 closure.
- Patch `memory/storage-cleanup-v2-phase6-cron-restore-runbook-2026-05-08.md` before treating it as executable. It still contains stale hard-gate framing that says Phase 5 controlled runs have not been executed.
- Harden the Phase 6 runbook against Phase 4 and Phase 5 actual values.
- Keep first cron params tied to the last clean Phase 5 profile, not hardcoded `maxRuns=10`.
- Preserve the stdout caveat: missing `[cleanup-v2]` docker stdout markers are informational, not dirty, if authoritative row/scheduled-function proof is clean.
- Use V2-specific observability names if adding heartbeat (`cleanup-realtime-metrics-v2`), never stale V1 `cleanup-realtime-metrics`.
- Require a separate explicit go for any code change to `convex/crons.ts`.

## Follow-Ups

- Commit this closure memo doc-only after review.
- Decide whether to run one more controlled Phase 5 profile (`maxRuns=5`) before Phase 6.
- Patch Phase 6 runbook doc-only before treating it as executable.
- Investigate Convex user-log routing separately if stdout visibility is desired for later phases; this is not a Phase 5 blocker.

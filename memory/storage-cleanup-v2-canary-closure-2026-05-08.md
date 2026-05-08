# Storage Cleanup V2 — Canary Closure — 2026-05-08

Status: **clean**
Trigger time: `2026-05-08T04:38:11.302Z`
runId: `1778215091302-1a285e0ec02c`
Track: metricsRealtime cleanup V2 Phase 4 canary
Convex deployment: `https://convex.aipilot.by` / self-hosted admin URL `http://178.172.235.49:3220`

References:
- Runbook (procedure): `memory/storage-cleanup-v2-phase4-canary-runbook-2026-05-07.md` (commit `5d3aa81`)
- Phase 1 design: `memory/storage-cleanup-v2-phase1-design-2026-05-07.md` (commit `b3e4bd4`)
- Phase 1 code: `2410f14 feat(storage-cleanup): add metricsRealtime cleanup V2`
- Phase 3 deploy closure: `memory/storage-cleanup-v2-phase3-deploy-closure-2026-05-07.md` (commit `1358aaa`)
- Canary closure template: `memory/storage-cleanup-v2-canary-closure-template-2026-05-07.md` (commit `1b3e6b2`)
- Phase 5 controlled-runs runbook: `memory/storage-cleanup-v2-phase5-controlled-runs-runbook-2026-05-08.md` (commit `f7c7d3c`)

## Summary

The first metricsRealtime cleanup V2 canary ran one bounded chunk with `maxRuns=1` and deleted exactly `500` rows. The cleanup chain completed successfully, remained pinned to a single runId, did not self-schedule extra chunks, did not revive the V1 cleanup path, and left core cron / WAL / alert signals clean.

`METRICS_REALTIME_CLEANUP_V2_ENABLED` was returned to `0` and verified after the canary.

## Git / Deploy Context

- Actual branch HEAD during canary: `f7c7d3c docs(storage-cleanup): add phase 5 controlled runs runbook`
- `HEAD == origin/emergency/drain-scheduled-jobs`: yes, `f7c7d3c9ff062f43f553d2a5623d3af2cdea9ec9`
- Phase 5 runbook commit landed before the armed window and changed only `memory/storage-cleanup-v2-phase5-controlled-runs-runbook-2026-05-08.md`.
- No git operations were performed during the armed window.
- Production cleanup code remained the Phase 1 payload from `2410f14`; no `convex/` code drift was present.

## Canary Parameters

```text
batchSize:     500
timeBudgetMs:  10000   # stored only, not enforced in Phase 1
restMs:        60000
maxRuns:       1
```

Trigger command:

```bash
npx convex run internal.metrics.triggerMassCleanupV2 \
  '{"batchSize":500,"timeBudgetMs":10000,"restMs":60000,"maxRuns":1}'
```

Trigger return:

```json
{
  "runId": "1778215091302-1a285e0ec02c",
  "status": "scheduled"
}
```

## Pre-Canary Gates

| Gate | Observed | Verdict | Source |
|---|---:|---|---|
| Cleanup env gate before sync wait | `METRICS_REALTIME_CLEANUP_V2_ENABLED` absent | clean | `npx convex env get METRICS_REALTIME_CLEANUP_V2_ENABLED` |
| `/version` before armed flow | HTTP 200, `0.700638s` | clean | `curl http://178.172.235.49:3220/version` |
| `pg_wal` before armed flow | `3,070,230,528` bytes | clean | `ssh + docker exec adpilot-postgres du -sb /var/lib/postgresql/data/pg_wal` |
| Organic sync gate | `2026-05-08T04:34:10.368Z`, 2 `syncBatchWorkerV2` workers success | clean | `_scheduled_functions` latest 8000 |
| UZ recovery prerequisite | UZ `19:42Z` tick had 2 workers success; no failed rows after `18:57:10Z` | clean | `_scheduled_functions`, `cronHeartbeats` |
| Backend stdout after UZ recovery | 0 rollback patterns since `2026-05-07T18:30:00Z` | clean | `docker logs adpilot-convex-backend` grep |

Known pre-canary yellow signal, attributed before canary:
- One isolated `ruleEngine.js:uzBudgetBatchWorkerV2` timeout at `2026-05-07T18:12:10.643Z`; sibling worker succeeded, later UZ ticks recovered cleanly, and no pattern repeated before the canary.

## Anchors

| Anchor | Pre | Post | Delta | Threshold / Rule | Verdict | Source |
|---|---:|---:|---:|---|---|---|
| `/version` HTTP | 200 | 200 | 0 | `== 200` | clean | `curl http://178.172.235.49:3220/version` |
| `/version` time | `0.700638s` | `0.685881s` | `-0.014757s` | no material drift | clean | same curl probes |
| disk used | 54% | 54% | 0pp | no unexplained large drop | clean | `df -h /` |
| `pg_wal` | `3,070,230,528` | `3,070,230,528` | `0` bytes | warn `5 MB`, hard-stop `50 MB` | clean | `ssh + docker exec adpilot-postgres du -sb /var/lib/postgresql/data/pg_wal` |
| `metricsRealtime` eligible | stale context: `9,530,384` at `2026-05-07T15:08:55Z` | not re-counted | n/a | structural proof used for Phase 4 | clean with caveat | `/tmp/count-metrics-realtime-eligible.result`, `cleanupRunState` |
| `oldestRemainingTimestamp` | `1,777,733,699,259` (`2026-05-02T14:54:59.259Z`) | `1,777,733,701,988` (`2026-05-02T14:55:01.988Z`) | `+2,729 ms` | post `>=` pre | clean | pre: `metricsRealtime --order asc --limit 1`; post: `cleanupRunState` |

### Eligible Count Caveat

A fresh exact eligible count was intentionally not run immediately before the canary because the prior full-table scan took about 9,448 pages and roughly 50 minutes. For this Phase 4 canary (`batchSize=500`, `maxRuns=1`), the exact count gate was downgraded to structural proof:

- `cutoffUsed` was captured once at trigger time and persisted on the run row.
- `manualMassCleanupV2` uses that immutable `cutoffUsed`.
- `deleteRealtimeBatch` deletes only rows with `timestamp < cutoffUsed`.
- `deletedCount` is exact and equals `500`.
- `oldestRemainingTimestamp` advanced forward by `2,729 ms`.
- `manualMassCleanupV2` produced exactly one success entry and no extra scheduled chunks.

The stale eligible count remains useful as backlog context, not as a strict delta gate. Phase 5 controlled runs should refresh sizing / eligible calibration before larger deletion windows.

## Core Heartbeats

| Heartbeat | Pre / Gate | Post | Verdict | Source |
|---|---|---|---|---|
| `syncDispatch` | `2026-05-08T04:34:10.296Z` completed, err `null` | same latest heartbeat at post-check | clean | `cronHeartbeats` |
| `uzBudgetDispatch` | `2026-05-07T19:42:10.547Z` completed, err `null` before canary gate | `2026-05-08T04:42:10.529Z` completed, err `null` | clean | `cronHeartbeats` |
| `tokenRefreshDispatch` | `2026-05-08T03:09:36.645Z` completed, err `null` | same latest heartbeat at post-check | clean | `cronHeartbeats` |

No sync / UZ / token heartbeat degraded during the canary window.

## `_scheduled_functions` Counters

Latest 8000 sample before / after canary:

| UDF | Pre failed | Post failed | Delta | Verdict | Source |
|---|---:|---:|---:|---|---|
| `auth.js:tokenRefreshOneV2` | 14 | 14 | 0 | clean | `_scheduled_functions` latest 8000 |
| `ruleEngine.js:uzBudgetBatchWorkerV2` | 1 | 1 | 0 | clean | `_scheduled_functions` latest 8000 |
| `syncMetrics.js:syncBatchWorkerV2` | 0 | 0 | 0 | clean | `_scheduled_functions` latest 8000 |
| `metrics.js:manualMassCleanup` (V1) | 1 | 1 | 0 | clean | `_scheduled_functions` latest 8000 |
| `metrics.js:manualMassCleanupV2` (V2) failed | 0 | 0 | 0 | clean | `_scheduled_functions` latest 8000 |
| `adminAlerts.js:notify` | 37 | 37 | 0 | clean | `_scheduled_functions` latest 8000 |

V2 success entry:

| UDF | Total entries | Success | Failed | Verdict | Source |
|---|---:|---:|---:|---|---|
| `metrics.js:manualMassCleanupV2` | 1 | 1 | 0 | clean | `_scheduled_functions` rows for `metrics.js:manualMassCleanupV2` |

V2 scheduled row:

```json
{
  "id": "kc295fhfntq6r292pvwmgxz0zx86a4sg",
  "creation": "2026-05-08T04:38:11.302Z",
  "scheduled": "2026-05-08T04:38:11.302Z",
  "completed": "2026-05-08T04:38:15.077Z",
  "state": { "kind": "success" },
  "args": [{ "runId": "1778215091302-1a285e0ec02c" }]
}
```

## `cleanupRunState` Final Row

Source: `internal.metrics.getCleanupRunStateV2 {"runId":"1778215091302-1a285e0ec02c"}`.

```json
{
  "_creationTime": 1778215091302.304,
  "_id": "r17f6k7dbc9713hwmfvwk39jc586a6bq",
  "batchSize": 500,
  "batchesRun": 1,
  "cleanupName": "metrics-realtime-v2",
  "cutoffUsed": 1778042291302,
  "deletedCount": 500,
  "durationMs": 3554,
  "isActive": false,
  "lastBatchAt": 1778215094844,
  "maxRuns": 1,
  "oldestRemainingTimestamp": 1777733701988,
  "restMs": 60000,
  "runId": "1778215091302-1a285e0ec02c",
  "startedAt": 1778215091302,
  "state": "completed",
  "timeBudgetMs": 10000
}
```

Derived timing:

| Field | Value |
|---|---|
| `startedAt` | `2026-05-08T04:38:11.302Z` |
| `lastBatchAt` | `2026-05-08T04:38:14.844Z` |
| `durationMs` | `3,554 ms` |
| rows deleted | `500` |
| oldest delta | `+2,729 ms` |

Verdict: clean. The row reached terminal state `completed`, `isActive=false`, `batchesRun=1`, `deletedCount=500`, and no `error` field.

## Backend Stdout

Window checked: `2026-05-08T04:34:00Z` onward, covering sync gate, env-on, trigger, worker execution, env-off, and post-checks.

| Pattern | Expected | Observed | Verdict | Source |
|---|---:|---:|---|---|
| `[cleanup-v2] start` | 1 | 0 | caveat | `docker logs adpilot-convex-backend` grep |
| `[cleanup-v2] end` | 1 | 0 | caveat | `docker logs adpilot-convex-backend` grep |
| `Too many concurrent` | 0 | 0 | clean | same grep |
| `Transient error` | 0 | 0 | clean | same grep |
| `TOKEN_EXPIRED` | 0 | 0 | clean | same grep |
| `syncBatchV2.*Account .* failed` | 0 | 0 | clean | same grep |
| `user_timeout` / `Restarting Isolate` | 0 | 0 | clean | same grep |
| `adminAlerts` | 0 | 0 | clean | same grep |

The absence of `[cleanup-v2]` stdout markers is a known verification gap in this self-hosted runtime, not a canary failure. Independent verification through `cleanupRunState`, `_scheduled_functions`, WAL, env, and heartbeats is authoritative for this closure.

Follow-up: verify Convex user `console.log` routing for internal actions before relying on docker stdout markers in Phase 5+ closure evidence.

## Env Gate

| Moment | Value | Source |
|---|---|---|
| Pre-canary | absent / not found | `npx convex env get METRICS_REALTIME_CLEANUP_V2_ENABLED` |
| Armed window | set to `1` immediately before trigger | `npx convex env set METRICS_REALTIME_CLEANUP_V2_ENABLED 1` |
| Finally-clause | set to `0` immediately after run completion | `npx convex env set METRICS_REALTIME_CLEANUP_V2_ENABLED 0` |
| Post-canary verification | `0` | `npx convex env get METRICS_REALTIME_CLEANUP_V2_ENABLED` |

The deploy-safe state was restored and verified before leaving the armed window.

## Decision

Overall: **clean**

Clean criteria met:

- `manualMassCleanupV2`: exactly 1 success, 0 failed.
- V1 `manualMassCleanup` failed counter did not advance.
- `cleanupRunState`: `completed`, `isActive=false`, `batchesRun=1`, `deletedCount=500`, `oldestRemainingTimestamp` advanced.
- `pg_wal` delta: 0 bytes.
- Core heartbeats: clean.
- `adminAlerts.notify`: unchanged.
- Env gate: restored to `0` and verified.
- No rollback stdout patterns during the canary window.

No rollback was triggered.

## Post-Canary State

| Item | State | Source |
|---|---|---|
| `METRICS_REALTIME_CLEANUP_V2_ENABLED` | `0` | `npx convex env get METRICS_REALTIME_CLEANUP_V2_ENABLED` |
| `cleanup-old-realtime-metrics` cron | still disabled / commented | `convex/crons.ts` unchanged from Phase 1 code path |
| Cleanup V2 run state | completed terminal row, inactive | `cleanupRunState` via `getCleanupRunStateV2` |
| Branch HEAD | `f7c7d3c` | `git rev-parse HEAD` during canary |
| Production cleanup behavior after canary | dormant again until env is explicitly re-enabled | env gate verified `0`; cron still disabled |

## Phase 5 Sizing Notes

Observed canary performance:

- `500` rows deleted in `3,554 ms`.
- `pg_wal` delta: `0` bytes at observed granularity.
- V8 action completed comfortably under the 600s timeout.
- No core-cron contention surfaced.

Phase 5 controlled runs should still refresh sizing before increasing scope:

- Fresh eligible count / backlog estimate before larger batches.
- Re-check WAL baseline noise.
- Re-check stdout log routing gap.
- Re-read Phase 5 runbook `f7c7d3c` against actual canary values; update assumptions if needed.

## Open Follow-Ups

1. **Phase 5 sizing review** — compare `f7c7d3c` controlled-runs runbook assumptions against this canary's actual `durationMs=3554`, `deletedCount=500`, and `pg_wal_delta=0`.
2. **Stdout log routing** — investigate why `[cleanup-v2]` user logs did not appear in `adpilot-convex-backend` docker stdout despite successful internal action execution.
3. **Eligible-count strategy for controlled runs** — Phase 4 accepted structural proof; Phase 5 should decide whether to run a fresh long count or use a faster indexed / SQL-side measurement before larger deletion volume.

Phase 4 canary is closed clean. MetricsRealtime cleanup V2 is validated for one bounded chunk; further cleanup remains gated by a separate Phase 5 go.

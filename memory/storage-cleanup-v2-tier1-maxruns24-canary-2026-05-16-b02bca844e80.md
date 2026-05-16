# Storage Cleanup V2 — Wave 6 Closure — 2026-05-16

Type: closure memo
Scope: Tier 1 supervised `maxRuns=24` Wave 6
Source runbook: `docs/2026-05-15-storage-cleanup-v2-wave-6-runbook.md`
Result: **STRICT CLEAN with operational notes**

## Identity

| Field | Value |
|---|---|
| Explicit go | user: `go Wave 6` |
| Target runId | `1778955542827-b02bca844e80` |
| Short runId | `b02bca844e80` |
| Profile | `{ batchSize: 1000, timeBudgetMs: 10000, restMs: 90000, maxRuns: 24 }` |
| SOT | `2b62f9936c5864910450fd25a7ac6b9884776ce7` |
| Trigger/start UTC | `2026-05-16T18:19:02.827Z` |
| Trigger/start Minsk | `2026-05-16 21:19:02.827 +03` |
| Terminal UTC | `2026-05-16T18:55:08.549Z` |
| Terminal Minsk | `2026-05-16 21:55:08.549 +03` |

## Preflight

Wave 6 was launched after the D1c closeout PASS and fresh preflight:

- `/version`: `HTTP 200` (`1.445826s` on retry preflight; post-wave 3/3 HTTP 200).
- `METRICS_REALTIME_CLEANUP_V2_ENABLED`: `0` before env flip.
- `DISABLE_ERROR_ALERT_FANOUT`: `0`.
- `SYNC_METRICS_V2_ENABLED`: `1`; `SYNC_BATCH_SIZE_V2`: `20`; `SYNC_WORKER_COUNT_V2`: `2`.
- latest cleanup row before Wave 6: W5 `1778751243514-2d97cfccdf0a`, `completed`, `isActive=false`.
- origin SOT: `2b62f9936c5864910450fd25a7ac6b9884776ce7`.
- clean tmp worktree restored at `/private/tmp/adpilot-wave6-sot-2026-05-15`; restorer `--help` and both dry-run rehearsals passed.
- server preflight: disk `142G` free, host available `24Gi`, PG locks `0`, idle-in-tx `0`, `pg_wal=449M`.

## Execution Notes

The first trigger attempt at `2026-05-16T18:14:07Z` failed with `TypeError: fetch failed`. Per runbook, env was immediately restored to `0`, and `cleanupRunState --limit 3` confirmed no new Wave 6 row was created. After a fresh clean preflight, the manual retry was scheduled successfully.

The first restorer process exited during the active run on noisy Convex CLI output (`Unexpected token 'W', "WebSocket "... is not valid JSON`) at about T+17. It was re-armed immediately against the same exact `runId` while the target row was still `running` at `batchesRun=11`. No manual env rescue was needed. The re-armed restorer detected terminal and restored env to `0` automatically with `env_verify=0`.

## Terminal Row

| Field | Observed |
|---|---:|
| `state` | `completed` |
| `isActive` | `false` |
| `batchesRun` | `24` |
| `deletedCount` | `24000` |
| `durationMs` | `2165722` |
| human duration | `36m 05.722s` |
| `lastBatchAt` | `1778957708536` |
| `oldestRemainingTimestamp` | `1777741818661` |

Duration thresholds:

- yellow threshold `> 2,300,000 ms`: **not hit** (`94.16%` of yellow threshold).
- hard threshold `> 2,400,000 ms`: **not hit** (`90.24%` of hard threshold).

## Probes

| Probe | UTC | Convex CPU | PG CPU | Loadavg 1m | locks | idle-in-tx | DFR/BIO/BufferPin | WAL | Result |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| T+~16 | `2026-05-16T18:35:39Z` | `0.06%` | `7.48%` | `0.30` | `0` | `0` | `0` | `513M` | PASS |
| T+~24 | `2026-05-16T18:43:21Z` | `3.01%` | `7.52%` | `0.48` | `0` | `0` | `0` | `641M` | PASS |
| T+~30 | `2026-05-16T18:49:22Z` | `81.94%` | `3.93%` | `0.37` | `0` | `0` | `0` | `721M` | PASS; active compute-phase sample |
| T+~3 post | `2026-05-16T18:59:20Z` | `138.72%` | `64.39%` | `1.39` | `0` | `0` | `0` | `721M` | WATCH; transient burst |
| T+~5 settle | `2026-05-16T19:03:47Z` | `0.00%` | `0.02%` | `0.20` | `0` | `0` | `0` | `721M` | PASS |

Post-wave `/version` retry after a local DNS flake: `HTTP 200` x3 (`1.589959s`, `1.162141s`, `1.223532s`).

## Env Restore Evidence

| Path | Observed | Result |
|---|---|---|
| Restorer log | `env_verify=0` | PASS |
| Independent CLI immediately post-terminal | `0` | PASS |
| T+3 CLI | `0` | PASS |
| T+5 CLI | `0` | PASS |
| cleanupRunState corroboration | latest row `completed`, `isActive=false` | PASS |

Manual env rescue needed: **no**.

## Floor / Series

W5 oldest remaining timestamp: `1777741473560`.

W6 oldest remaining timestamp: `1777741818661`.

Floor advance: `345101 ms` (`5m 45.101s`).

Series total after Wave 6: `144000` rows deleted across six `maxRuns=24` waves.

## Re-Halt Rules

| Rule | Result | Notes |
|---|---|---|
| 1 duration ceiling | GREEN | `2165722 ms`, below yellow and hard thresholds |
| 2 sustained PG waits | GREEN | locks/waits/DFR/BIO stayed `0` across probes |
| 3 loadavg elevated/not settled | GREEN | T+3 burst settled by T+5 to loadavg `0.20` |
| 4 env not back to `0` | GREEN | restorer + independent CLI verified `0` |
| 5 PG memory/headroom | GREEN | PG MEM peaked around `21%`, headroom not exhausted |
| 6 discipline breach | GREEN | no DDL/DML outside cleanup, no GUC, no VACUUM/ANALYZE, no container restart, no parallel cleanup |

## Decision

Outcome: **STRICT CLEAN with operational notes**.

Wave 6 completion does **not** authorize Wave 7, parameter escalation, cron automation, or any database maintenance by inertia. Any next wave requires a separate explicit operator decision and runbook/preflight.

# Storage Cleanup V2 — BD-2 wave closure (2026-05-09)

## Verdict

**Clean terminal.** Safe profile (`1000/8/90s`) reproduced; 8000 rows deleted; pg_wal flat (0 byte delta over 11+ min); env restored to 0; no race with the 18:00 UTC cron boundary; chunk durations 6.56–7.61s — entirely within tier-clean (< 8.5s).

This wave was the post-BD-3 reaffirmation that the safe profile is reproducible after the BD-3 dirty (`restMs=60s`, chunk-8 outlier 9.572s). It is NOT meant to drain the backlog — backlog horizon advanced only ~36s.

## Identifiers

| Field | Value |
|---|---|
| runId | `1778346956979-42133ff2ac4d` |
| short-runId | `42133ff2ac4d` |
| Profile | `batchSize=1000, timeBudgetMs=10000, restMs=90000, maxRuns=8` |
| Trigger UTC | `2026-05-09T17:15:55Z` |
| Terminal UTC | `2026-05-09T17:27:23Z` |
| env restored UTC | `2026-05-09T17:28:29Z` |
| Total wall (cleanupRunState `durationMs`) | `685,756 ms` (11.43 min) |
| Cron boundary headroom at terminal | next 18:00 UTC = +32 min |

## Procedure executed

1. Pre-flight (read-only, 13 gates) — green.
2. Pre-trigger sanity (~30s before env flip) — green.
3. `env METRICS_REALTIME_CLEANUP_V2_ENABLED 0 → 1` (verified `1`).
4. `internal.metrics.triggerMassCleanupV2 {batchSize:1000, timeBudgetMs:10000, restMs:90000, maxRuns:8}` → `{status:"scheduled", runId:"1778346956979-42133ff2ac4d"}`.
5. runId verified ≠ all 9 baseline runIds.
6. Polled `cleanupRunState` every 30–90s for 8 chunks; per-poll PG sanity (locks, idle-in-tx, pg_wal).
7. Terminal at chunk 8 with `state="completed"`, no `error` field.
8. `env 1 → 0` (verified `0`).

No abort, no recovery branch hit. `disabled` and `already-running` trigger responses did not occur.

## Per-chunk timing — two sources

`cleanupRunState`-derived = `lastBatchAt(N) − lastBatchAt(N−1) − restMs` (chunk 1: `lastBatchAt(1) − startedAt`).
`_scheduled_functions`-derived = `completedTime − scheduledTime` for each `metrics.js:manualMassCleanupV2` entry filtered by `args.runId == "1778346956979-42133ff2ac4d"`.

| chunk | end UTC | duration (cleanupRunState) | duration (_scheduled_functions) | tier |
|---|---|---|---|---|
| 1 | 17:16:04Z | 7.04s | 7.07s | clean |
| 2 | 17:17:41Z | 7.19s | 7.19s | clean |
| 3 | 17:19:18Z | 6.90s | 6.91s | clean |
| 4 | 17:20:55Z | 7.61s | 7.62s | clean |
| 5 | 17:22:32Z | 7.21s | 7.21s | clean |
| 6 | 17:24:09Z | 6.65s | 6.66s | clean |
| 7 | 17:25:46Z | 6.58s | 6.59s | clean |
| 8 | 17:27:23Z | 6.56s | 7.88s | clean (see note) |

**Chunk 8 discrepancy (1.32s):** `_scheduled_functions.completedTime` for chunk 8 includes the `markCompletedV2` mutation (terminal finalization), which is NOT part of the `deleteRealtimeBatch` delete loop. `cleanupRunState.lastBatchAt` is set inside `recordBatchProgressV2`, before `markCompletedV2`. Effective delete-work for chunk 8 = `6.56s`, in line with chunks 1–7. The `_scheduled_functions` figure is correct as wall-clock total but should not be used for the 8.5/8.7/9.0 tier decision on the final chunk.

Range (cleanupRunState, primary): **6.56–7.61s**. All chunks ≪ 8.5 yellow tier.

Threshold tiering applied during wave:
- chunk > 8.5s → yellow / caveat
- chunk > 8.7s → hold escalation for future
- chunk > 9.0s → dirty / mid-wave env=0
None breached.

## Cross-checks

`_scheduled_functions` filtered by `args.runId == "1778346956979-42133ff2ac4d"`:
- entries: **8** (matches 8 chunks)
- state distribution: 8 × `success`, 0 × `failed | inProgress | pending | canceled`

stdout `[cleanup-v2] ...` for our runId on `adpilot-convex-backend`: **not observed** during live polling (last 2-min `docker logs --since` window was empty for the runId pattern). Self-hosted Convex stdout routing for cleanup-v2 logs appeared incomplete in this session; cross-check via `_scheduled_functions` confirms execution. Noted as observation, not a defect.

## Pre-flight baseline (snapshot at 16:53:47Z post-feedback re-snap)

| Item | Value |
|---|---|
| env | `0` |
| Active cleanup row | none |
| `cleanupRunState` baseline rows preserved | 9 (newest 9, top-1 = BD-3 dirty `1778317001080-6bce771f1759`) |
| `/version` (3 probes) | `1.750 / 1.308 / 1.401` s, all HTTP 200 |
| `track_io_timing` | `value=off, source=default, pending_restart=false, reset_val=off` |
| `pg_wal` | `1,342,177,280` bytes (1280 MB, 80 files) |
| Locks waiting | 0 |
| Idle-in-tx | 0 |
| Longest active query | 0s |
| `shared_buffers` | `128MB` (pre-existing TODO, untouched) |
| `adpilot_prod` size | 143 GB (`documents`: 23 GB heap / 50 GB total; `indexes`: 34 GB heap / 93 GB total — pre-existing bloat, untouched) |
| 6-pattern stdout gate (15 min) | rollback=0, TOKEN_EXPIRED=0, "Too many concurrent"=0, "cleanup failed"=0, FATAL=0, panic=0 |
| `_scheduled_functions` non-success in newest 500 + oldest 100 | 0 |
| Cron boundary distance (next 18:00 UTC at 16:53Z) | +1h 06m 13s |

## Post-wave audit (snapshot at 17:28:29–17:28:50Z)

| Metric | Pre-flight | Post-wave | Delta |
|---|---|---|---|
| env | 0 | 0 | restored |
| `pg_wal` bytes | 1,342,177,280 | 1,342,177,280 | **0** |
| `pg_wal` files | 80 | 80 | 0 |
| Locks waiting | 0 | 0 | 0 |
| Idle-in-tx | 0 | 0 | 0 |
| `/version` avg latency (3 probes) | ~1.49s | ~1.27s | improved |
| `documents` heap / total | 23 GB / 50 GB | 23 GB / 50 GB | unchanged at this resolution |

`longest_active = 19s` post-wave likely the operator's own ssh+psql `pg_ls_waldir` query — not flagged as a backend signal.

## Backlog horizon

| Source | `oldestRemainingTimestamp` |
|---|---|
| Pre-wave (top of baseline, `1778317001080-6bce771f1759`) | `2026-05-02T15:09:47Z` |
| Post-wave (this run) | `2026-05-02T15:10:23Z` |
| Δ | **+36 seconds** of cleanup-frontier advance |

8000 deletions advanced the oldest-remaining frontier by only ~36 seconds. Backlog beneath the 2-day cutoff remains ~4.74 days. Single waves at this profile are insufficient for a sweep; planning a sustained drain requires either repeated safe waves or a separately-designed BD-X profile after dedicated investigation.

## Comparison: BD-2 repeat (08:33Z) vs this BD-2 wave (17:15Z)

Both at `1000 / 8 / 90s` safe profile.

| Metric | BD-2 repeat (08:33Z, runId `1778315592229-0ece8cbe741f`) | This BD-2 wave (17:15Z, `42133ff2ac4d`) |
|---|---|---|
| Profile | 1000/8/90s | 1000/8/90s |
| Total `durationMs` | 686,545 | 685,756 |
| Chunks deleted | 8000 | 8000 |
| Terminal | `completed` | `completed` |
| Chunk range | n/a in baseline | 6.56–7.61s |

Δ wall-time: −789 ms (faster by 0.79s, within noise). Reproducible.

## Open notes (not in scope of this wave)

1. **`healthCheck.checkCronHeartbeats` config drift.** `maxStaleMin` thresholds in `convex/healthCheck.ts:79-80` are V1-era (sync 10 min, UZ 15 min) but actual V2 cadences are sync 15 min (`syncDispatchV2`) and UZ 45 min (`uzBudgetDispatchV2`). Health check therefore reports sync/UZ as stale during normal operation. Functional state during this wave was healthy (last syncDispatch finishedAt within cadence, last uzBudgetDispatch finishedAt within cadence, no errors in 6-pattern stdout gate). Recommend updating thresholds in a separate change.

2. **Stuck `cleanup-realtime-metrics` heartbeat row.** `cronHeartbeats` row with `name="cleanup-realtime-metrics"`, `status="running"`, `startedAt=2026-05-04T18:00:00Z` — not finalized after a ~5-day-old chain; legacy from prior incident. Not touched in this wave to keep one runtime effect per session. Reset path exists at `internal.migrations.resetStuckCleanupHeartbeat` (only resets when `status === "running" && age > 12h`); can be applied in a future short session.

3. **Indexes bloat.** `pg_total_relation_size('indexes')` = 93 GB vs heap 34 GB (≈ 19:1 ratio). Pre-existing memory-flagged work (Phase 9 candidate); BD-2 wave does not address.

4. **stdout routing for `[cleanup-v2]` in self-hosted backend.** Live `docker logs --since 2m adpilot-convex-backend | grep "[cleanup-v2]"` did not surface our runId during polling, despite chunks completing as evidenced by `cleanupRunState` and `_scheduled_functions`. Investigation of stdout routing in self-hosted Convex is a separate observability follow-up.

## What this wave does NOT change

- env returned to `0` post-terminal; cron `cleanup-old-realtime-metrics` remains fail-closed.
- No PG settings changed (`track_io_timing` stayed `off/default`; `shared_buffers` unchanged).
- No migration run.
- No `cleanupRunState` row mutated outside this run.
- Main dirty worktree untouched; closure authored from a fresh isolated worktree at `origin/emergency/drain-scheduled-jobs` HEAD `699571e`.

## References

- Pre-flight baseline + 13 gates: this session's pre-flight protocol.
- BD-1 maxRuns8 closure: `memory/storage-cleanup-v2-bd-1-closure-2026-05-09.md`.
- BD-2 wave runbook: `docs/2026-05-06-...` series + safe fallback procedure (`memory/MEMORY.md`).
- Phase 6 cron registration: `convex/crons.ts:215-225` (origin/main `3287a5a`).
- Cleanup mechanics: `convex/metrics.ts:424-700` (origin/main `3287a5a`).

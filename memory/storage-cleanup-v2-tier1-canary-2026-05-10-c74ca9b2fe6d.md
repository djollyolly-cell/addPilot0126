# Storage Cleanup V2 — Tier 1 canary closure (2026-05-10 08:13Z, maxRuns=16)

## Verdict

**Clean.** First validated wave at the new tier (`maxRuns=16`). 16,000 rows deleted across 16 chunks, terminal `completed`, env restored to 0, all hard gates PASS, no PG/host footprint. **Linear scaling vs `maxRuns=8` baseline** — duration ~2.1×, deletion 2×, no degradation across PG metrics.

This is **1/10** clean waves required at the new tier before considering Tier 2 (automation) or `maxRuns=24`. Not a new default until series confirmed.

## Identifiers

| Field | Value |
|---|---|
| runId | `1778400801169-c74ca9b2fe6d` |
| short-runId | `c74ca9b2fe6d` |
| Profile | `batchSize=1000, timeBudgetMs=10000, restMs=90000, maxRuns=16` |
| Trigger UTC | `2026-05-10T08:13:21Z` |
| Last batch UTC | `2026-05-10T08:37:36Z` |
| env restored UTC | `2026-05-10T08:43:01Z` (approx, after post-audit fetch) |
| Total wall (`durationMs`) | `1,455,738 ms` (24m 15.7s) |
| Avg chunk-to-chunk | ~91 s (rest=90 s + ~1 s controller overhead) |
| Cron boundary headroom at terminal | next 12:00 UTC = +3h 22m |

## Operator / agent trace

| T (UTC) | Action |
|---|---|
| 07:47Z | Pre-flight start (UTC + git-side verify) |
| 07:56Z | Direct PG host-probe pack (loadavg, pg_stat_activity, pg_locks, pg_ls_waldir, container health) — all GREEN |
| 08:12:16Z | Pre-flip runway recheck — 192 min budget vs 11:25 cutoff |
| 08:12:43Z | env flip 0→1 (verified `1`) |
| 08:13:17Z | Trigger `internal.metrics.cleanupOldRealtimeMetricsV2 {batchSize:1000,timeBudgetMs:10000,restMs:90000,maxRuns:16}` |
| 08:13:21Z | Action returned `{status:"scheduled", runId:"1778400801169-c74ca9b2fe6d"}` |
| 08:13:27Z | First chunk completed (batchesRun=1, deleted=1000) — verified active row in `cleanupRunState` |
| 08:13–08:37Z | Wave executing in scheduler chain (controller exited, chunks via `scheduler.runAfter`) |
| 08:37:36Z | Terminal `completed` (batchesRun=16/16, deleted=16,000) |
| 08:43:01Z (approx) | env flip 1→0 (verified `0` ≠ `1`) |
| 08:43:32Z | Post-wave PG re-probe (all GREEN) |

No abort, no recovery branch hit. No `disabled` or `already-running` trigger response.

**Polling note:** local Node poll-loop (`/tmp/cleanup-v2-poll.log`) wrote zero lines — `nohup node …` likely silently failed at startup (suspect non-ASCII cwd interaction with `execSync('node gen-admin-key.cjs')`). Primary monitoring path through direct `cleanupRunState` reads worked. Not a wave issue; tooling cleanup parked.

## Pre-flight baseline (snapshot at 07:47–08:12Z)

| Item | Value |
|---|---|
| env | `0` (idle-safe) |
| Active cleanup row | none (top: BD-2 prior `c854314303f8`, isActive=false, completed) |
| `/version` × 3 | `1.531 / 1.600 / 1.249` s, all HTTP 200 |
| `track_io_timing` | `off` (default) |
| `shared_buffers` | `128MB` (storm-fix state, unchanged) |
| `pg_wal` | **`76 files / 1,216 MB`** |
| Locks waiting | 0 |
| Idle-in-tx | 0 |
| Active wait_events `DataFileRead` / `BufferIO` / `BufferPin*` | 0 / 0 / 0 |
| Long-active queries (>30s) | 0 (max_secs=0) |
| `loadavg` | `0.66 / 0.43 / 0.33` |
| Containers | adpilot-convex-backend / adpilot-postgres / adpilot-frontend — all `healthy` |
| Cron boundary distance | +3h 38m to next 11:55 no-go entry; cutoff 11:25 UTC for `maxRuns=16` (start + 30 min ≤ boundary − 5 min) |
| 7d cleanupRunState | 11/11 `completed`, 0 failed, 0 disabled_mid_chain |
| Floor trend (7d) | `2026-05-02 14:55 → 15:14` (+19 min, monotonic) |

## Aggregate metrics (cleanupRunState target row)

```json
{
  "runId": "1778400801169-c74ca9b2fe6d",
  "state": "completed",
  "isActive": false,
  "batchesRun": 16,
  "maxRuns": 16,
  "batchSize": 1000,
  "restMs": 90000,
  "timeBudgetMs": 10000,
  "deletedCount": 16000,
  "durationMs": 1455738,
  "startedAt": 1778400801169,
  "lastBatchAt": 1778402256895,
  "cutoffUsed": 1778228001169,
  "oldestRemainingTimestamp": 1777735203457,
  "error": null
}
```

- `cutoffUsed` = `startedAt − 48h` = `2026-05-08T08:13:21Z` (consistent with retention window).
- `oldestRemainingTimestamp` = `2026-05-02T15:20:03Z`.
- Backlog at terminal: ~7d 17h between `oldestRemaining` and `cutoffUsed`.

## Floor advance vs prior wave

Prior wave (`c854314303f8`, 2026-05-09 18:31Z, profile `1000/8/90s`):
- `oldestRemainingTimestamp` = `1,777,734,893,381` ms = `2026-05-02T15:14:53Z`

This wave (`c74ca9b2fe6d`):
- `oldestRemainingTimestamp` = `1,777,735,203,457` ms = `2026-05-02T15:20:03Z`

**Δ = +310,076 ms ≈ +5.17 min** floor advance. Range of last 11 waves: +0 to +5 min/wave. This wave with 2× chunks moved floor at the upper end of prior range — chunk-density at deletion frontier governs translation from rows-deleted to time-advance, and dense regions cap effective per-row contribution.

## 7d wave history (completed only, sorted)

| startedAt UTC | maxR | batch | restMs | deleted | dur(s) | floor (UTC) | Δ |
|---|---|---|---|---|---|---|---|
| 2026-05-08 04:38 | 1 | 500 | 60000 | 500 | 4 | 2026-05-02 14:55 | — |
| 2026-05-08 07:35 | 3 | 500 | 90000 | 1500 | 191 | 2026-05-02 14:55 | +0 |
| 2026-05-08 09:36 | 5 | 500 | 90000 | 2500 | 377 | 2026-05-02 14:55 | +0 |
| 2026-05-09 04:00 | 8 | 500 | 90000 | 4000 | 656 | 2026-05-02 14:59 | +4 |
| 2026-05-09 06:00 | 5 | 500 | 90000 | 2500 | 377 | 2026-05-02 14:59 | +0 |
| 2026-05-09 06:32 | 8 | 500 | 90000 | 4000 | 658 | 2026-05-02 14:59 | +0 |
| 2026-05-09 07:56 | 8 | 1000 | 90000 | 8000 | 688 | 2026-05-02 15:02 | +2 |
| 2026-05-09 08:33 | 8 | 1000 | 90000 | 8000 | 687 | 2026-05-02 15:05 | +3 |
| 2026-05-09 08:56 | 8 | 1000 | 60000 | 8000 | 476 | 2026-05-02 15:09 | +5 |
| 2026-05-09 17:15 | 8 | 1000 | 90000 | 8000 | 686 | 2026-05-02 15:10 | +1 |
| 2026-05-09 18:31 | 8 | 1000 | 90000 | 8000 | 689 | 2026-05-02 15:14 | +4 |
| **2026-05-10 08:13** | **16** | **1000** | **90000** | **16000** | **1456** | **2026-05-02 15:20** | **+5** |

Linear scaling baseline (vs last 5 BD-2 waves at 8/1000/90s, dur 686–689s, deleted=8000):
- Duration: `1456 / 688 = 2.12×` for `2×` chunks → **+6 % wall overhead** vs ideal linear; explained by single startup/finalize markers.
- Deletion: `16000 / 8000 = 2.0×` → exact.
- No per-chunk drift breach (aggregate consistent).

## Hard gates

| Gate | Threshold | Result | Verdict |
|---|---|---|---|
| state | `completed` | `completed` | **PASS** |
| isActive | `false` | `false` | **PASS** |
| deletedCount | 16,000 (= `maxRuns × batchSize`) | 16,000 | **PASS** |
| env after | `≠ "1"` | `0` | **PASS** |
| `durationMs` | ≤ 1,600,000 ms (16 × 100s envelope) | 1,455,738 ms | **PASS** |
| floor advance | ≥ 0, monotonic | +310,076 ms | **PASS** |
| Cron boundary headroom at terminal | ≥ 5 min to next no-go | +3h 22m | **PASS** |

Per-chunk timings from `_scheduled_functions` not pulled this run (admin DNS hiccup at audit time, GitHub-side fine). Aggregate envelope holds; per-chunk deferred unless a future wave shows aggregate drift.

## Post-wave probe (08:43:32Z)

| Metric | Pre-wave | Post-wave |
|---|---|---|
| loadavg 1m / 5m / 15m | 0.66 / 0.43 / 0.33 | **0.20 / 0.28 / 0.31** |
| Containers | 3× healthy | 3× healthy |
| pg_stat_activity (idle / idle-in-tx) | 4 / 0 | 4 / 0 |
| Long-active >30s | 0 | 0 |
| DataFileRead / BufferIO / BufferPin | 0 / 0 / 0 | 0 / 0 / 0 |
| pg_locks waiting | 0 | 0 |
| pg_wal | 76 files / 1216 MB | **72 files / 1152 MB** (Δ: −4 files / −64 MB) |

**`pg_wal` movement:** size decreased by 4 segments / 64 MB during the wave window. Neutral observation — could be WAL recycle, archive, or replication-slot release. No attribution claimed; checkpoint is one of several plausible causes. Important point: wave did **not** add net WAL.

## Caveats / parked

- **Per-chunk timing detail** not captured (admin DNS hiccup at audit). If next 16-wave shows aggregate drift, drilldown via `_scheduled_functions` first.
- **Local poll-loop wrote zero lines.** Suspect Node `execSync('node gen-admin-key.cjs')` from non-ASCII cwd under nohup. Tooling fix parked; primary `cleanupRunState` reads cover monitoring needs.
- **Floor still at `2026-05-02 15:20`** — backlog ~7d 17h between floor and `cutoffUsed`. Convergence to 48h retention requires either Tier 2 automation or a sustained 16-wave cadence; design refs in `memory/storage-cleanup-v2-acceleration-design-2026-05-10.md` (Tier 1 → 2 gate = 10 consecutive clean waves + fresh PG snapshot green).

## Gate ledger

| Item | Value |
|---|---|
| Tier | 1 (`maxRuns=16`) |
| Clean-waves count at this tier | **1 / 10** |
| Next action | another `maxRuns=16` canary, **not** back-to-back (require fresh sanity/PG probe before next) |
| Tier 2 / `maxRuns=24` gate | **NOT MET** — need ≥ 10 consecutive clean waves at Tier 1 |

## Anchors

- Origin canon at trigger time: `704cd42` (acceleration design — Phase 2b ingest baseline).
- Branch: `emergency/drain-scheduled-jobs`.
- Trigger function: `internal.metrics.cleanupOldRealtimeMetricsV2` (`metrics.ts:610`).
- Prior closure (BD-2 wave): `memory/storage-cleanup-v2-bd-2-wave-2026-05-09-c854314303f8.md`.
- Plan refs: `memory/storage-cleanup-v2-sustained-drain-plan-2026-05-10.md`, `memory/storage-cleanup-v2-acceleration-design-2026-05-10.md`.

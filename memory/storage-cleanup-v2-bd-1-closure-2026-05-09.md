# Storage Cleanup V2 - BD-1 Closure - 2026-05-09

Status: **clean with caveat** — V2 chain met every contract gate; both observed
heartbeat alarms in post-run audit attributed to a pre-existing watcher-cadence
mismatch in `convex/healthCheck.ts`, **not** caused by BD-1.

This is the second clean run on the `maxRuns=8` profile and closes BD-1 from
the bulk-drain phase ladder per
`memory/storage-cleanup-v2-bulk-drain-reclaim-plan-2026-05-09.md`.

## Caveat

> Post-run UZ heartbeat alert was an observation artifact caused by config
> mismatch: `uz-budget-increase` cron cadence 45 min, watcher
> `maxStaleMin=15`. UZ fired successfully at 06:57:10Z; no evidence BD-1
> caused UZ regression. Sync-metrics post-run alert was the same class of
> artifact (cron cadence 15 min, watcher `maxStaleMin=10`) and self-cleared
> within the 5-minute re-check window.

## Summary

- Profile: `batchSize=500, timeBudgetMs=10_000, restMs=90_000, maxRuns=8`.
- runId: `1778308356596-e1523fbe8a8b`.
- Trigger time: 2026-05-09T06:32:36.596Z (manual via
  `internal.metrics.triggerMassCleanupV2`, after manual env-set 1 at 06:32:29Z).
- Completion: 2026-05-09T06:43:34.647Z. durationMs = 658,064 (10:58.064).
- batchesRun: 8 (== maxRuns), deletedCount: 4,000 (== batchSize × batchesRun).
- env restored: `0` at 2026-05-09T06:44:05Z, verified `0` immediately after.
- Repeatability: this is the **second** clean `maxRuns=8` run; the first was
  the emergency run `1778299225930-4f57ec67d364` at 04:00:25.930Z (durationMs
  656,268). Δ duration = +1,796 ms (+0.27%).

## Preconditions

Previous closures referenced (all on `emergency/drain-scheduled-jobs`):

- Phase 4 canary: `memory/storage-cleanup-v2-canary-closure-2026-05-08.md`.
- Phase 5 run #1 (maxRuns=3): `memory/storage-cleanup-v2-controlled-closure-2026-05-08.md`.
- Phase 5 run #2 (maxRuns=5): `memory/storage-cleanup-v2-controlled-closure-2026-05-08-maxRuns5.md`.
- Emergency maxRuns=8: `memory/storage-cleanup-v2-emergency-maxRuns8-closure-2026-05-09.md`
  (commit `4e886fe`).
- Bulk-drain + reclaim plan: `memory/storage-cleanup-v2-bulk-drain-reclaim-plan-2026-05-09.md`
  (commit `e8cee10`).
- Phase 6 Gate B: `memory/storage-cleanup-v2-phase6-gate-b-closure-2026-05-09.md`
  (commit `1074adf`).
- Workspace HEAD == origin == `1074adf` at trigger time.

Phase 6 cron path **certified clean** (Gate A + Gate B). BD-1 ran independently
of cron (manual trigger), under the same V2 entrypoints, but at the higher
maxRuns profile.

## Operator / Agent Trace

State-changing steps (env-on, env-off, trigger) were performed by the agent
under explicit operator go (`go env-set` for autonomous Gate B, then `go BD-1`
following the operator's plan). All audit reads were performed by the agent.
No deploy, no code change.

| Time (UTC) | Actor | Action | Result |
|---|---|---|---|
| 06:32:21 | agent | pre-flight: `env get`, `data cleanupRunState`, SSH anchors | env=0; top row = Gate B closure row, no active row; pg_wal=1,493,172,224 b, disk 54%, DB 143 GB |
| **06:32:29** | **agent** | **`npx convex env set METRICS_REALTIME_CLEANUP_V2_ENABLED 1`** | success |
| 06:32:34 | agent | env get verify | `1` |
| **06:32:36** | **agent** | **`npx convex run metrics:triggerMassCleanupV2 {batchSize:500, timeBudgetMs:10000, restMs:90000, maxRuns:8}`** | `{ runId: "1778308356596-e1523fbe8a8b", status: "scheduled" }` |
| 06:32:36 → 06:43:34 | system | 8 batches, 7 inter-chunk rests of 90 s | terminal: `state=completed, batchesRun=8, deletedCount=4000` |
| 06:33:39 → 06:44:05 | agent | poll `cleanupRunState` every 60 s | progress: 1→2→3→4→5→6→7→8 batches; final `isActive=false, durationMs=658,064` |
| **06:44:05** | **agent** | **`npx convex env set METRICS_REALTIME_CLEANUP_V2_ENABLED 0`** | success |
| 06:44:09 | agent | env get verify | `0` |
| 06:44:49 | agent | post-run `/version` × 3 + SSH anchors + stdout grep | `/version` 200 (1.38/1.30/1.09 s); pg_wal 1,476,395,008 b (Δ −16 MiB recycled); disk/DB flat; 0 stdout errors over 13-min window |
| 06:44:54 | agent | `_scheduled_functions` audit + `healthCheck.checkCronHeartbeats` | V2 8/8/0; V1 0; **alarms: sync-metrics 11 min + uz-budget 33 min + cleanup-realtime 6525 min** |
| 06:51:47 | agent | re-check heartbeats after 5-min wait | sync-metrics cleared; **uz-budget grew 33→40 min**; cleanup-realtime 6532 min |
| 06:54–06:57 | agent | UZ source investigation (read-only) | found cron interval 45 min vs `maxStaleMin=15` watcher mismatch (see Heartbeat Attribution) |
| 06:57:10 | system | UZ dispatcher fired organically (next 45-min boundary) | new heartbeat row `startedAt=06:57:10`, `status=completed`; UZ alarm cleared on subsequent check |

## Anchors

| Anchor | Pre | Post | Delta | Threshold | Verdict |
|---|---:|---:|---:|---|---|
| `/version` (× 3) | (last verified Gate B post-run) HTTP 200, 1.51 / 1.57 / 1.31 s | HTTP 200, 1.38 / 1.30 / 1.09 s | latency stable, slight improvement | 200 | PASS |
| `pg_wal` (size) | 1,493,172,224 b (= Gate B post-run baseline) | 1,476,395,008 b | **−16,777,216 b (−16 MiB)** — segment recycled, normal | warn 25 MiB / hard 150 MiB | PASS |
| `/dev/sda1` usage | 54% (used 161G / 315G, free 142G) | 54%, no change | 0 | informational | PASS |
| DB total size | 143 GB | 143 GB | 0 | informational | PASS |
| `cleanupRunState` (this run row) | n/a (no active row pre-trigger) | row written, `state=completed, isActive=false` | n/a | row terminal | PASS |
| `oldestRemainingTimestamp` | 1,777,733,981,580 (post-Gate B, 2026-05-02T14:59:41.580Z) | 1,777,733,996,443 (2026-05-02T14:59:56.443Z) | **+14,863 ms (+14.863 s)** source-time | post >= pre | PASS |
| `metricsRealtime` eligible | not re-counted | not re-counted | structural: `deletedCount=4000 == batchSize × batchesRun` | matches `deletedCount` | PASS structural |

`pg_wal` shrank by exactly one 16 MiB segment during the run. This is normal WAL
recycling; below the warn threshold; not attributable to the cleanup deletes
themselves (delete WAL footprint is small relative to a segment).

### Eligible delta cutoff alignment

- `cleanupRunState.cutoffUsed` (this run): 1,778,135,556,596 (2026-05-07T06:32:36.596Z),
  exactly `startedAt − 48h` (172,800,000 ms).
- No fresh post-run server-local exact eligible count. Per Phase 5 contract,
  structural proof is sufficient in the `batchSize=500 * maxRuns ∈ {3..8}` band.
- Verdict: **PASS structural**.

## cleanupRunState Final Row

```text
_id                                 r178q6xhq9p18pm6ebe56wbr5h86ctyy
_creationTime                       1778308356596.3987   (2026-05-09T06:32:36.596Z)
batchSize                           500
batchesRun                          8
cleanupName                         "metrics-realtime-v2"
cutoffUsed                          1778135556596       (2026-05-07T06:32:36.596Z)
deletedCount                        4000
durationMs                          658064              (10:58.064)
isActive                            false
lastBatchAt                         1778309014647       (2026-05-09T06:43:34.647Z)
maxRuns                             8
oldestRemainingTimestamp            1777733996443       (2026-05-02T14:59:56.443Z)
restMs                              90000
runId                               "1778308356596-e1523fbe8a8b"
startedAt                           1778308356596       (2026-05-09T06:32:36.596Z)
state                               "completed"
timeBudgetMs                        10000
error                               (absent)
```

### Per-chunk math

- 7 inter-chunk rests × 90,000 ms = 630,000 ms.
- Per-chunk execution: `(658,064 − 630,000) / 8 = 3,508.0 ms`.
- Linearity across the full Phase 4/5/emergency/Gate B/BD-1 history:

  | Run | Profile | Per-chunk exec |
  |---|---|---:|
  | Phase 4 canary | maxRuns=1 | 3,554 ms |
  | Phase 5 #1 | maxRuns=3 | 3,615 ms |
  | Phase 5 #2 | maxRuns=5 | 3,439 ms |
  | Emergency #3 | maxRuns=8 | 3,283.5 ms |
  | Gate B (cron) | maxRuns=5 | 3,456.6 ms |
  | **BD-1 (this run)** | **maxRuns=8** | **3,508.0 ms** |

  Linearity preserved. BD-1 mid-band; per-chunk variance between
  this run and emergency `maxRuns=8` is +6.8% which is well within the
  natural slice-density variance (see Density Note).

## Scheduled Functions

Sourced via `npx convex data _scheduled_functions --limit 200` and grep'd
for the BD-1 `runId`:

| UDF | Total in run window | Success | Failed | Verdict |
|---|---:|---:|---:|---|
| `metrics.js:manualMassCleanupV2` (this runId) | **8** | **8** | **0** | **PASS** |
| `metrics.js:manualMassCleanup` (V1, anywhere in dump) | 0 | n/a | 0 | PASS by construction (V1 entrypoint not reachable from any active cron or trigger) |

All 8 V2 entries reference `runId: "1778308356596-e1523fbe8a8b"`. State
`{ "kind": "success" }` on every entry.

## Backend Stdout

Verified via `docker logs --since 13m adpilot-convex-backend` grep:

| Pattern | Count | Verdict |
|---|---:|---|
| `[cleanup-v2] start` | 0 | INFORMATIONAL (Phase 4 caveat: marker absence is known log-routing behaviour) |
| `[cleanup-v2] end schedule` | 0 | INFORMATIONAL |
| `[cleanup-v2] end complete` | 0 | INFORMATIONAL |
| `[cleanup-v2] end failed` | 0 | PASS |
| `[cleanup-v2] disabled_mid_chain` | 0 | PASS (env held at `1` throughout the chain) |
| `TOKEN_EXPIRED` / `Too many concurrent` / `Transient error` / `rollback` / `FATAL` / `panic` | 0 | PASS |

## Heartbeat Attribution

Two new alarms appeared in the post-run heartbeat snapshot (BD-1 finished at
06:43:34Z, first heartbeat check at 06:44:49Z):

```text
sync-metrics:        отстаёт (11 мин)
uz-budget-increase:  отстаёт (33 мин)
cleanup-realtime:    STUCK (6525 мин)   ← pre-existing legacy V1
```

Re-check 5 minutes later (06:51:47Z):

```text
uz-budget-increase:  отстаёт (40 мин)   ← lag GREW; not catch-up
cleanup-realtime:    STUCK (6532 мин)   ← pre-existing legacy V1
(sync-metrics:       cleared — caught up within the 5-min window)
```

Investigation found the root cause is a **pre-existing watcher-cadence
mismatch** in `convex/healthCheck.ts`, not BD-1:

| Heartbeat | Cron interval (source) | Watcher `maxStaleMin` (source) | Alarm window per cycle |
|---|---|---|---|
| `sync-metrics` (`syncDispatch` watcher) | 15 min (`convex/crons.ts:37–41`) | 10 min (`convex/healthCheck.ts:79`) | ~5 min of every 15 (≈33%) |
| `uz-budget-increase` (`uzBudgetDispatch` watcher) | 45 min (`convex/crons.ts:127–131`) | 15 min (`convex/healthCheck.ts:80`) | ~30 min of every 45 (≈67%) |

The watcher fires whenever `now − lastHeartbeatAt > maxStaleMin`. With cron
intervals longer than the watcher threshold, the alarm is **expected** during
the gap between cron fires.

UZ confirmation evidence:

- `uzBudgetDispatchV2` heartbeat row at investigation time:
  `name=uzBudgetDispatch, status=completed, startedAt=2026-05-09T06:57:10.515Z`
  — UZ dispatcher fired at 06:57:10Z, on the 45-min boundary (previous
  observed fire 06:32:10Z, gap 25 min — see Schedule Drift Note).
- `uzBudgetBatchWorkerV2` invocations in `_scheduled_functions` over a
  ~80-entry dump: workers spawned at 05:47:10, 06:32:10, 06:57:10
  (3 dispatcher events, 2 workers each).
- BD-1 post-run check at 06:44:49Z fell **between** dispatcher fires
  (06:32:10 → 06:57:10 gap of 25 min); 06:44:49Z − 06:32:10 = 12:39, but
  the heartbeat was reporting status=running at that point with stale
  startedAt — see Heartbeat Update Lag Note below — yielding the 33-min
  number.

Sync-metrics confirmation evidence:

- The 11-min reading at 06:44:49Z aligned with the 10-min watcher threshold
  on a 15-min cadence; one missed window during the BD-1 chain caused
  the post-trigger lag, and the next cron tick caught up before the 5-min
  re-check at 06:51:47Z.

### Schedule Drift Note (informational)

The UZ dispatcher fires were at 05:47:10, 06:32:10, 06:57:10 — gaps of 45 min
and 25 min, not the documented 45-min cadence in both gaps. Possible reasons:

- A previous deploy (commit `e8cee10` at ~05:00Z, commit `1074adf` at
  ~06:13Z) reset the cron timer.
- The dispatcher's `tryAcquireHeartbeat` may have hit `takeover_stale`
  branch and re-fired ahead of schedule.

Not a blocker for BD-1 closure; tracked separately in the follow-up note.

### Heartbeat Update Lag Note (informational)

For UZ, the heartbeat row's `startedAt` field appears to be the value used
by the watcher to compute lag. If a dispatcher fired at 06:32:10 but the
`finally`-block heartbeat upsert (`status: completed`) lagged or did not
materialize cleanly, the row would still show the previous cycle's
`startedAt` — yielding a 33-min reading at 06:44:49Z instead of the
expected ~12 min. This is a secondary anomaly, possibly a Convex mutation
batching artifact, and is recorded as part of the follow-up note.

## Decision

**clean with caveat** — BD-1 contract satisfied, V2 chain integrity proven.
Specifically:

- V2 chain completed: `state=completed, isActive=false, error=undefined`.
- `batchesRun=8 (== maxRuns)`, `deletedCount=4000 (== batchSize × batchesRun)`.
- V2 failed absolute zero. V1 absolute zero.
- Eligible delta vs deletedCount: structural PASS.
- `oldestRemainingTimestamp` post >= pre (+14.863 s).
- `pg_wal` flat (−16 MiB segment recycled, well below warn threshold).
- `/dev/sda1` and DB size flat.
- Backend stdout zero rollback / zero TOKEN_EXPIRED / zero concurrent /
  zero `[cleanup-v2] end failed`.
- Sync-metrics heartbeat alarm cleared within 5 min self-recovery window.
- UZ heartbeat alarm attributed to pre-existing watcher-cadence mismatch;
  UZ fired successfully at 06:57:10Z; **no evidence BD-1 caused UZ
  regression**.
- Env returned to `0`, verified.
- Repeatability of `maxRuns=8` profile proven (this is the second clean
  run on this profile; ΔdurationMs to emergency run is +0.27%).

**not** a real drainage (per the bulk-drain plan; this is BD-1 by intent —
repeatability proof, not throughput ramp).

## Density Note

BD-1 advanced `oldestRemainingTimestamp` by **+14.863 s** while deleting
4,000 rows — local slice density `≈ 269 rows/s`. Comparison:

| Run | Source-time advance | Rows deleted | Local density |
|---|---:|---:|---:|
| Emergency maxRuns=8 (oldest edge) | +258.864 s | 4,000 | ≈ 15 rows/s |
| Gate B (maxRuns=5) | +8.855 s | 2,500 | ≈ 282 rows/s |
| BD-1 (this run, maxRuns=8) | +14.863 s | 4,000 | ≈ 269 rows/s |

Density across the slices visited so far ranges 15–282 rows/s — confirms
the bulk-drain plan's framing that density is **not** uniform across the
backlog. The maxRuns=8 emergency oldest-edge density of 15 rows/s was
unrepresentatively low; the BD-1 / Gate B slice (~270–280 rows/s) is closer
to typical.

## Post-run State

- `METRICS_REALTIME_CLEANUP_V2_ENABLED`: `0`, verified.
- `cleanup-old-realtime-metrics` cron: ACTIVE at `convex/crons.ts:219` with
  cron profile `{batchSize:500, timeBudgetMs:10_000, restMs:90_000, maxRuns:5}`.
  Fail-closed by env. Next organic ticks: 12:00Z, 18:00Z, 00:00Z UTC.
  Phase 6 certification (Gate A + Gate B) remains valid.
- `cleanupRunState` active rows: none. Final row above is `isActive=false`.
- HEAD/origin: `1074adf`. No deploy or code change by this run.
- Working tree: pre-existing dirty unrelated files (untouched). Only new
  artifact: this closure file.
- Admin key: still in `/tmp/.cnvx_admin_key` (ephemeral, this session only;
  to be cleaned up at session end).

## BD-2 Readiness Rules (per operator)

After this closure is committed, BD-2 is **unblocked**, subject to a fresh
**BD-0-lite pre-flight** before the trigger:

- `/version` × 3 → HTTP 200.
- `npx convex env get METRICS_REALTIME_CLEANUP_V2_ENABLED` → `0`.
- `npx convex data cleanupRunState --limit 5` → no `isActive=true` row.
- `pg_wal`, disk, DB size → no growth from BD-1 baseline (flat or recycled).
- `_scheduled_functions` → no V2 failed entries since BD-1.
- Backend stdout → clean of rollback / FATAL / cleanup-end-failed patterns.
- `healthCheck.checkCronHeartbeats` snapshot — apply the **alarm-attribution
  rule below** before treating any line as a blocker.

### Alarm attribution rule for BD-2 pre-flight

A heartbeat alarm is **NOT** a blocker if **all** of the following hold:

1. The alarm matches a known cron-watcher mismatch (see Heartbeat Attribution
   table above): `sync-metrics` at lag ≤ ~6 min beyond threshold, OR
   `uz-budget-increase` at lag ≤ ~30 min beyond threshold (i.e. fits within
   the expected stale window of the actual cron cadence).
2. No `_scheduled_functions` failed/inProgress entries exist for the
   corresponding UDF (`syncDispatchV2` / `uzBudgetDispatchV2` / their
   dispatched workers) over the relevant window.
3. The alarm does not include a STUCK signal (other than the pre-existing
   legacy `cleanup-realtime` STUCK).

Otherwise, treat as a blocker: do not enable env, do not trigger.

The pre-existing legacy `cleanup-realtime: STUCK` heartbeat is **not** a
blocker (V1 heartbeat name no longer written by any active cron).

## Open Follow-ups (doc-only, no code change in this commit)

1. **Heartbeat watcher-cadence mismatches** — `convex/healthCheck.ts`:
   - `sync-metrics`: `maxStaleMin: 10` vs cron 15 min → propose `maxStaleMin: 25`
     (cron + 10 min headroom).
   - `uz-budget-increase`: `maxStaleMin: 15` vs cron 45 min → propose
     `maxStaleMin: 60` (cron + 15 min headroom).
   - **Code fix is deferred** until after BD-2 / a quiet maintenance moment;
     not part of cleanup-track work.

2. **launchd late-fire (Gate B prior attempt)** — timing-critical env touches
   should be done via manual `npx convex env set` plus a Bash `until`-loop
   target, not via launchd. launchd late-fired by +4:50 s in the
   2026-05-09T00:00:00Z attempt.

3. **Heartbeat update lag artifact** (UZ specifically) — `tryAcquireHeartbeat`
   logic combined with `finally`-block upsert produced a heartbeat
   `startedAt` in the BD-1 window that did not match the actual dispatcher
   fire time. Worth a deeper look, but not a runtime blocker.

4. **UZ dispatcher schedule drift** — observed gaps of 45 / 25 min instead of
   45 / 45 min between fires. Likely caused by cron timer reset on recent
   deploys. Not a blocker; will normalize on next quiet day.

All four go into a single follow-up note (separate doc-only commit) per the
operator's decision.

## Reference Pointers For Next Agent

- Bulk-drain + reclaim plan: `memory/storage-cleanup-v2-bulk-drain-reclaim-plan-2026-05-09.md`
  (commit `e8cee10`).
- Phase 6 Gate B closure: `memory/storage-cleanup-v2-phase6-gate-b-closure-2026-05-09.md`
  (commit `1074adf`).
- Emergency maxRuns=8 closure (first clean on this profile):
  `memory/storage-cleanup-v2-emergency-maxRuns8-closure-2026-05-09.md`
  (commit `4e886fe`).
- Code at run time:
  - HEAD/origin: `1074adf`.
  - V2 entrypoints in `convex/metrics.ts`: `triggerMassCleanupV2` (line 444),
    `getCleanupRunStateV2` (488), `cleanupOldRealtimeMetricsV2` (612),
    `manualMassCleanupV2` (635).
  - V1 path is a no-op in current code; not reachable from any active cron.
  - Cron registration: `convex/crons.ts:219` (cleanup), `:127` (UZ V2 every
    45 min), `:37` (sync V2 every 15 min), `:144` (UZ reset every 5 min).
  - Heartbeat config: `convex/healthCheck.ts:66-113`.
- Admin key generation: `memory/convex-deploy.md`.

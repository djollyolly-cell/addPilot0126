# Storage Cleanup V2 - Phase 6 Gate B Closure - 2026-05-09

Status: **clean** — organic cron tick fired with env=1 and produced a clean V2 chain.

This closes the Phase 6 cron certification. Gate A (env=0 fail-closed, 2026-05-08T18:00:00Z)
and Gate B (env=1 active tick, **2026-05-09T06:00:00Z**) both clean. The
`cleanup-old-realtime-metrics` cron is now proven at the current baseline profile.

## Summary

- Cron entry: `convex/crons.ts:219` — `cleanup-old-realtime-metrics`, schedule
  `0 */6 * * *`, entrypoint `internal.metrics.cleanupOldRealtimeMetricsV2`,
  profile `{batchSize:500, timeBudgetMs:10_000, restMs:90_000, maxRuns:5}`.
- Env gate: `METRICS_REALTIME_CLEANUP_V2_ENABLED`. Fail-closed unless `=1`.
- runId: `1778306400020-61a90d1d20fe`.
- Trigger time: 2026-05-09T06:00:00.020Z (cron drift +20 ms).
- Completion: 2026-05-09T06:06:17.293Z. durationMs = 377,283 (6:17.283).
- batchesRun: 5 (== maxRuns), deletedCount: 2,500 (== batchSize × batchesRun).
- env restored: `0` at 2026-05-09T06:10:16Z, verified `0` at 06:10:25Z.

## Preconditions

Previous closures referenced (all on `emergency/drain-scheduled-jobs`):

- Phase 4 canary: `memory/storage-cleanup-v2-canary-closure-2026-05-08.md` (commit `8b96807`).
- Phase 5 run #1 (maxRuns=3): `memory/storage-cleanup-v2-controlled-closure-2026-05-08.md`.
- Phase 5 run #2 (maxRuns=5): `memory/storage-cleanup-v2-controlled-closure-2026-05-08-maxRuns5.md`.
- Emergency maxRuns=8: `memory/storage-cleanup-v2-emergency-maxRuns8-closure-2026-05-09.md`
  (commit `4e886fe`).
- Bulk-drain + reclaim plan: `memory/storage-cleanup-v2-bulk-drain-reclaim-plan-2026-05-09.md`
  (commit `e8cee10`).
- Workspace HEAD == origin == `e8cee10` at trigger time.

Gate A boundary 2026-05-08T18:00:00Z confirmed env=0 fail-closed (wrapper fired,
returned `disabled` result, no `cleanupRunState`, no deletes).

Gate B prior attempt at 2026-05-09T00:00:00Z was missed: launchd env-on landed
late at 00:04:50Z while the wrapper had already fired at 00:00:00.045Z reading
env=0. Not dirty, but Gate B not satisfied. **This run replaces that miss with
a clean active tick**, using manual env-set instead of launchd.

## Operator / Agent Trace

State-changing steps (env-on, env-off) were performed by the agent after explicit
operator go (`go env-set`). All other reads were performed by the agent. No
deploy, no code change.

| Time (UTC) | Actor | Action | Result |
|---|---|---|---|
| 05:46:21 | agent | server clock probe + `/version` × 3 + SSH anchors | HTTP 200, latency 1.82/1.55/1.33s, pg_wal flat |
| ≤ 05:52 | agent | admin key generation via INSTANCE_SECRET (pulled from `docker inspect adpilot-convex-backend`) + `@noble/ciphers` script in `memory/convex-deploy.md` | key length 87 chars |
| 05:50:02 | agent | `npx convex env get` | `0` |
| 05:51:xx | agent | `npx convex data cleanupRunState --limit 5` | top row = maxRuns=8 closure row, all 4 historical rows `isActive=false`, no active row |
| 05:52:xx | agent | `docker logs --since 10m` grep error patterns | `0` rollback / TOKEN_EXPIRED / concurrent / `[cleanup-v2] end failed` |
| **05:57:04** | **agent** | **`npx convex env set METRICS_REALTIME_CLEANUP_V2_ENABLED 1`** | success |
| 05:57:09 | agent | `npx convex env get` | `1` (verified) |
| **06:00:00.020** | system | cron fired, wrapper started chain (drift +20 ms) | new `cleanupRunState` row, `isActive=true` |
| 06:00:33 | agent | poll `cleanupRunState` | row visible, `state=running, batchesRun=1, deletedCount=500, lastBatchAt=06:00:03.708Z` |
| 06:00:00 → 06:06:17 | system | 5 batches, 4 inter-chunk rests of 90 s | terminal: `state=completed, batchesRun=5, deletedCount=2500` |
| 06:10:07 | agent | poll `cleanupRunState` | `state=completed, isActive=false, durationMs=377,283` |
| **06:10:16** | **agent** | **`npx convex env set METRICS_REALTIME_CLEANUP_V2_ENABLED 0`** | success |
| 06:10:25 | agent | `npx convex env get` | `0` (verified) |
| 06:11:09 | agent | post-run `/version` × 3 + SSH anchors + stdout grep | flat |
| 06:11:xx | agent | `_scheduled_functions` audit + `healthCheck.checkCronHeartbeats` | clean except pre-existing legacy STUCK |

## Anchors

| Anchor | Pre | Post | Delta | Threshold | Verdict |
|---|---:|---:|---:|---|---|
| `/version` (× 3) | HTTP 200, 1.82 / 1.55 / 1.33 s | HTTP 200, 1.51 / 1.57 / 1.31 s | latency stable, slight improvement | 200 | PASS |
| `pg_wal` (size) | 1,493,172,224 b | 1,493,172,224 b | 0 b (bit-exact) | warn 25 MB / hard 150 MB | PASS |
| `/dev/sda1` usage | 54% (used 161G / 315G, free 142G) | 54%, no change | 0 | informational | PASS |
| DB total size | 143 GB | 143 GB | 0 | informational | PASS |
| `cleanupRunState` (this run row) | n/a | row written, `state=completed, isActive=false` | n/a | row terminal | PASS |
| `oldestRemainingTimestamp` | 1,777,733,972,725 (post-maxRuns=8, 2026-05-02T14:59:32.725Z) | 1,777,733,981,580 (2026-05-02T14:59:41.580Z) | +8.855 s source-time | post >= pre | PASS |
| `metricsRealtime` eligible | not re-counted | not re-counted | structural: `deletedCount=2500 == batchSize × batchesRun` | matches `deletedCount` after cutoff alignment | PASS structural |

### Eligible delta cutoff alignment

- `cleanupRunState.cutoffUsed` (this run): 1,778,133,600,020 (2026-05-07T06:00:00.020Z),
  exactly `startedAt − 48h` (172,800,000 ms). Verified via arithmetic on row values.
- No fresh post-run server-local exact eligible count. Phase 5 contract allows
  structural proof in the `batchSize=500 * maxRuns ∈ {3..8}` band; the cron
  baseline `maxRuns=5` is inside that band.
- Verdict: **PASS structural**. `deletedCount=2500 == batchSize * batchesRun`
  confirms no missed-batch evidence.

## cleanupRunState Final Row

```text
_id                                 r175pgk7czej897sdnyg26kadh86ca3q
_creationTime                       1778306400020.8857   (2026-05-09T06:00:00.020Z)
batchSize                           500
batchesRun                          5
cleanupName                         "metrics-realtime-v2"
cutoffUsed                          1778133600020       (2026-05-07T06:00:00.020Z)
deletedCount                        2500
durationMs                          377283              (6:17.283)
isActive                            false
lastBatchAt                         1778306777293       (2026-05-09T06:06:17.293Z)
maxRuns                             5
oldestRemainingTimestamp            1777733981580       (2026-05-02T14:59:41.580Z)
restMs                              90000
runId                               "1778306400020-61a90d1d20fe"
startedAt                           1778306400020       (2026-05-09T06:00:00.020Z)
state                               "completed"
timeBudgetMs                        10000
error                               (absent)
```

### Per-chunk math

- 4 inter-chunk rests × 90,000 ms = 360,000 ms.
- Per-chunk execution: `(377,283 − 360,000) / 5 = 3,456.6 ms ≈ 3.46 s`.
- Linearity across full Phase 4/5/emergency/Gate B history:

  | Run | Profile | Per-chunk exec |
  |---|---|---:|
  | Phase 4 canary | maxRuns=1 | 3,554 ms |
  | Phase 5 #1 | maxRuns=3 | 3,615 ms |
  | Phase 5 #2 | maxRuns=5 | 3,439 ms |
  | Emergency #3 | maxRuns=8 | 3,283.5 ms |
  | **Gate B (this run)** | maxRuns=5 (cron) | **3,456.6 ms** |

  Linearity preserved across all five runs. The Gate B per-chunk time is mid-band,
  consistent with the slice density observed (see Density Note).

## Scheduled Functions

Sourced via `npx convex data _scheduled_functions --limit 80` and grep'd for
`metrics.js:manualMassCleanupV2` / `metrics.js:manualMassCleanup` / kind values:

| UDF | Total in run window | Success | Failed | Verdict |
|---|---:|---:|---:|---|
| `metrics.js:manualMassCleanupV2` | **5** | **5** | **0** | **PASS** |
| `metrics.js:manualMassCleanup` (V1) | 0 | n/a | 0 | PASS by construction (cron entrypoint at `convex/crons.ts:219` points only to V2 wrapper) |

All 5 V2 entries reference `runId: "1778306400020-61a90d1d20fe"`. Their
scheduled `start_time__nanos` chain matches the expected `[batch_n_finish + restMs]`
pattern of the V2 chain. State `{ "kind": "success" }` on every entry.

Wider system snapshot (informational, not run-specific): 73 success / 0 failed
across the dump window — no failed-state entries anywhere in the recently scheduled
batch.

## Backend Stdout

Verified via `docker logs --since 11m adpilot-convex-backend` grep:

| Pattern | Count | Verdict |
|---|---:|---|
| `[cleanup-v2] start` | 0 | INFORMATIONAL (Phase 4 caveat: marker absence is known log-routing behaviour of this self-hosted runtime, not a dirty signal) |
| `[cleanup-v2] end schedule` | 0 | INFORMATIONAL |
| `[cleanup-v2] end complete` | 0 | INFORMATIONAL |
| `[cleanup-v2] end failed` | 0 | PASS |
| `[cleanup-v2] disabled_mid_chain` | 0 | PASS (env held at `1` throughout the chain) |
| `TOKEN_EXPIRED` / `Too many concurrent` / `Transient error` / `rollback` / `FATAL` / `panic` | 0 | PASS |

## Heartbeats

Sourced via `npx convex run healthCheck:checkCronHeartbeats '{}'`:

```json
{
  "details": [
    "cleanup-realtime: STUCK (6493 мин)"
  ],
  "message": "1 проблем",
  "name": "Кроны (heartbeat)",
  "status": "error"
}
```

The single signal is the **pre-existing legacy V1 heartbeat** (`cleanup-realtime`,
~108 h stale). The V1 heartbeat name is no longer written by any active cron
entrypoint; the healthCheck config still watches the legacy name
(`convex/healthCheck.ts:87`). This is the **same** signal flagged in maxRuns=5
and maxRuns=8 closures. No new heartbeat regression caused by Gate B. Phase 6
follow-up: rename to `cleanup-realtime-metrics-v2` (not done in this run).

`syncDispatch`, `uzBudgetDispatch`, `tokenRefreshDispatch` — not flagged. No
correlation between the cleanup window 06:00:00Z – 06:06:17Z and any heartbeat
regression.

## Density Note (informational)

This Gate B run advanced `oldestRemainingTimestamp` by **+8.855 s** while
deleting 2,500 rows — local density `≈ 282 rows/s`. The maxRuns=8 emergency run
advanced by +258.864 s while deleting 4,000 rows — density `≈ 15 rows/s`. The
two runs walked **different slices** of the backlog:

- maxRuns=8 covered 2026-05-02T14:55:13.861Z → 14:59:32.725Z (low-density edge,
  oldest pages of `metricsRealtime`).
- Gate B covered 2026-05-02T14:59:32.725Z → 14:59:41.580Z (much denser slice).

This confirms the bulk-drain plan's framing that backlog density varies by slice
and the maxRuns=8 oldest-edge density is **not** representative of the full
backlog. The order-of-millions sizing signal in
`memory/storage-cleanup-v2-emergency-maxRuns8-closure-2026-05-09.md` "Backlog
Math" section was a lower-bound-style estimate based on the oldest, lowest-density
edge; later/denser slices likely contain proportionally more rows per source-time
unit. No new estimate computed in this closure — see the bulk-drain plan for the
phased response.

## Decision

**clean** — Gate B contract satisfied. Specifically:

- V2 chain completed: `state=completed, isActive=false, error=undefined`.
- `batchesRun=5 (== maxRuns)`, `deletedCount=2500 (== batchSize × batchesRun)`.
- V2 failed absolute zero.
- V1 `manualMassCleanup` failed delta zero, total entries this run = 0.
- Eligible delta vs deletedCount: structural PASS.
- `oldestRemainingTimestamp` post >= pre (+8.855 s).
- `pg_wal` bit-exact flat (no growth across the run).
- `/dev/sda1` and DB size flat.
- Backend stdout has no rollback patterns.
- Core heartbeats clean apart from pre-existing V1 cleanup STUCK
  (legacy heartbeat name, monitoring rename gap, not a runtime regression).
- Env returned to `0`, verified.

**not** a real drainage (cron baseline profile is sized for organic safety, not
backlog drainage). Local slice density observed `≈ 282 rows/s` is informational.

## Post-run State

- `METRICS_REALTIME_CLEANUP_V2_ENABLED`: `0`, verified after run.
- `cleanup-old-realtime-metrics` cron: ACTIVE at `convex/crons.ts:219` with
  profile `{batchSize:500, timeBudgetMs:10_000, restMs:90_000, maxRuns:5}`.
  Fail-closed by env. Next organic ticks: 12:00Z, 18:00Z, 00:00Z UTC.
- `cleanupRunState` active rows: none. Final row above is `isActive=false`. The
  previous four rows (canary maxRuns=1, run #1 maxRuns=3, run #2 maxRuns=5,
  emergency maxRuns=8) are also `isActive=false`.
- HEAD/origin: `e8cee10`. No deploy or code change by this run.
- Working tree: pre-existing dirty unrelated files (untouched).

## Phase 6 Status

Phase 6 cron path **certified**:

- Gate A (env=0 fail-closed, 2026-05-08T18:00:00Z) — **clean** (operator brief).
- Gate B (env=1 active tick, 2026-05-09T06:00:00Z) — **clean** (this closure).

Cron `cleanup-old-realtime-metrics` at the current baseline profile is now
authorized to fire organically without operator intervention. Next organic tick
fires at 12:00Z UTC under env=0 (no-op) unless env is enabled again.

## Recommendations (no follow-up trigger without explicit go)

1. **Phase 6 closed at the current baseline profile.** No further Gate runs are
   needed for the `{batchSize:500, maxRuns:5}` configuration. Any change to that
   profile (batchSize, maxRuns, restMs, cadence) is a **new phase boundary**
   per the bulk-drain plan and requires its own approval, gate(s), and closure.

2. **The next decision is the bulk-drain phase ladder, not another Gate.**
   Per `memory/storage-cleanup-v2-bulk-drain-reclaim-plan-2026-05-09.md`:
   - BD-0 baseline → BD-1 (repeat clean maxRuns=8) → BD-2 (batchSize=1000) → ...
   - Each step requires explicit go.
   - BD-4 Option B (cron-driven drain) is a **separate deploy boundary**.

3. **Legacy V1 STUCK signal** (`cleanup-realtime`) — open follow-up, not
   blocker. Plan: introduce V2 heartbeat name `cleanup-realtime-metrics-v2`
   in the V2 wrapper and update `convex/healthCheck.ts:87` watcher. Defer to
   the next code window; not part of this closure.

4. **launchd-based env-on is unreliable** — Gate B prior attempt missed by
   +4:50 s due to launchd late-fire. This run used **manual `npx convex env
   set`** with a python-computed UTC target and a Bash `until` loop. Fired
   on schedule. Recommendation: do not return to launchd for env-on of any
   future timing-critical Gate / BD runs without first diagnosing the launchd
   delay (kernel sleep, launchd throttling, daemon plist `StartCalendarInterval`
   semantics).

## Reference Pointers For Next Agent

- Bulk-drain + reclaim plan: `memory/storage-cleanup-v2-bulk-drain-reclaim-plan-2026-05-09.md`.
- Phase 1 design (V2 architecture, env flag, `cleanupRunState` shape):
  `memory/storage-cleanup-v2-phase1-design-2026-05-07.md`.
- Phase 6 runbook (pre-existing): `memory/storage-cleanup-v2-phase6-cron-restore-runbook-2026-05-08.md`
  — should be updated to mark Phase 6 certified after this closure.
- Gate A draft (untracked): `memory/storage-cleanup-v2-cron-closure-2026-05-08.md`.
- Gate B prior-attempt checklist (untracked): `memory/storage-cleanup-v2-phase6-gate-b-checklist-2026-05-08.md`.
- Code at run time:
  - HEAD/origin: `e8cee10 docs(storage-cleanup): add bulk-drain + physical reclaim plan`.
  - Cron registration: `convex/crons.ts:219`.
  - V2 entrypoints in `convex/metrics.ts`: `triggerMassCleanupV2`, `manualMassCleanupV2`,
    `getCleanupRunStateV2`, `cleanupOldRealtimeMetricsV2`.
  - V1 path is a no-op in current code; not reachable from any active cron.
  - Heartbeat config: `convex/healthCheck.ts:66-113` (`checkCronHeartbeats`).
- Admin key generation algorithm: `memory/convex-deploy.md` (KBKDF-CTR-HMAC-SHA256
  + AES-128-GCM-SIV via `@noble/ciphers`). Used in this session to enable agent
  to perform `env get/set` and `data` reads autonomously.

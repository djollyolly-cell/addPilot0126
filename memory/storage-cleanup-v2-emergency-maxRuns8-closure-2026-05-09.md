# Storage Cleanup V2 - Emergency Run Closure - 2026-05-09 - maxRuns=8

Status: **clean** (safety proof, not a real drainage — see Backlog Math).
Trigger time: 2026-05-09T04:00:25.930Z
runId: `1778299225930-4f57ec67d364`
Params: `batchSize=500, timeBudgetMs=10000, restMs=90000, maxRuns=8`

This is the **third** Phase 5-style controlled run. The progression so far is
`canary maxRuns=1` → `controlled maxRuns=3` → `controlled maxRuns=5` → **`emergency maxRuns=8`** (this run).

Label: "emergency" reflects the operator request following the missed Gate B canary
boundary on 2026-05-09T00:00:00Z (03:00 МСК); env-on landed late at 00:04:50Z, after
the wrapper had already fired at 00:00:00.045Z reading env=0. See Preconditions. The
label does **not** mean parameter escalation beyond the recommended next-step profile
from the maxRuns=5 closure (which proposed exactly `maxRuns=8`, lines 300–317 of
`memory/storage-cleanup-v2-controlled-closure-2026-05-08-maxRuns5.md`). Hard rule
`maxRuns >= 10 forbidden` not breached.

## Document Status For Next Agent

The run completed cleanly with authoritative app-level proof
(`cleanupRunState.state=completed`, `error=undefined`, `batchesRun=8`,
`deletedCount=4000=batchSize*batchesRun`).

Per the maxRuns=5 closure precedent, structural proof is sufficient for Phase 5-style
profiles in the `batchSize=500 * maxRuns<=8` band; full eligible-delta arithmetic deferred.

**Important framing**: this run is a **safety proof of an 8-chunk chain**, not real
drainage. `oldestRemainingTimestamp` advanced only `+4m 18.864s` of source-time per
4000 rows deleted. The backlog from `oldest → cutoff` is ~4.54 days of source-time. A
density-derived **sizing signal** (not a fresh exact count) suggests on the order of
millions of rows still eligible and on the order of thousands of maxRuns=8 chains to
catch up to the 48h retention target. See "Backlog Math" for the explicit caveats and
what it implies for the next phase.

## Preconditions Confirmed

- Phase 5 run #1 closure: `memory/storage-cleanup-v2-controlled-closure-2026-05-08.md`
  (`maxRuns=3`, runId `1778225705482-b8b7b8deb8ac`). Status: clean.
- Phase 5 run #2 closure: `memory/storage-cleanup-v2-controlled-closure-2026-05-08-maxRuns5.md`
  (`maxRuns=5`, runId `1778232969547-20283bb90f21`). Status: clean.
- Phase 4 canary closure: `memory/storage-cleanup-v2-canary-closure-2026-05-08.md` (commit `8b96807`). Status: clean.
- Phase 6 runbook: `memory/storage-cleanup-v2-phase6-cron-restore-runbook-2026-05-08.md`.
  Phase 6 cron code is **deployed**: `cleanup-old-realtime-metrics` is ACTIVE at
  `convex/crons.ts:219` (schedule `0 */6 * * *`, entrypoint
  `internal.metrics.cleanupOldRealtimeMetricsV2`, profile
  `{batchSize:500, timeBudgetMs:10_000, restMs:90_000, maxRuns:5}`). The cron is
  fail-closed by env: it executes only when `METRICS_REALTIME_CLEANUP_V2_ENABLED=1`.
  Gate A on 2026-05-08T18:00:00Z confirmed env=0 fail-closed behaviour (wrapper fired,
  returned `disabled` result, no `cleanupRunState` row, no deletes). This emergency
  run was triggered manually via `triggerMassCleanupV2` with env temporarily set to 1
  for the run window only.
- Gate A env=0 proof: clean (operator brief; boundary 2026-05-08T18:00:00Z, drift +61.5ms,
  wrapper success with `disabled` result, no new `cleanupRunState`).
- Gate B canary attempt: missed boundary `2026-05-09T00:00:00Z` (03:00 МСК); launchd
  env-on landed late at `2026-05-09T00:04:50Z` while the wrapper had already fired at
  `00:00:00.045Z` reading env=0. Not dirty: `manualMassCleanupV2 = 0`, no new
  `cleanupRunState`, env returned to `0`.
- Workspace state at trigger: branch `emergency/drain-scheduled-jobs`, HEAD == origin ==
  `259c91e docs(uz-budget): align reset cron cadence comment`. Working tree dirty with
  unrelated/legacy files (intentionally not touched). No deploy occurred during this run.
- Env pre: `METRICS_REALTIME_CLEANUP_V2_ENABLED=0`, verified independently in this
  session by `npx convex env get` before trigger sequence.
- No active `cleanupRunState` row at trigger time (verified independently in this
  session by `npx convex data cleanupRunState --limit 20 --format jsonArray`; no
  `isActive=true` rows in the returned set).
- `/version` pre: HTTP 200 across all probes (operator-side: 2.486 / 1.366 / 1.326 s
  closer to trigger; agent-side earlier in session: 1.026–1.258 s). Both probe sets
  converge on HTTP 200 healthy.
- UZ budget reset cron unaffected: midnight МСК window 2026-05-08T21:03:17Z–21:07:31Z
  ran clean (14×success, 0 failed, 853 `budget_reset` actionLogs).

## Anchors

| Anchor | Pre | Post | Delta | Threshold | Verdict | Source |
|---|---:|---:|---:|---|---|---|
| `/version` | HTTP 200, 2.486 / 1.366 / 1.326 s (operator-side pre-run) | HTTP 200, 1.493 / 1.402 / 1.917 s (operator-side post-run) | latency stable, no error | 200 | PASS | `curl https://convex.aipilot.by/version` |
| `pg_wal` (size) | 1,493,172,224 bytes pre-run | 1,493,172,224 bytes post-run | 0 bytes | warn 25 MB / hard 150 MB | PASS | verified in this session |
| `/dev/sda1` usage | 54% (used 161G / 315G, free 142G) pre-run | 54% post-run, no change | 0 | informational | PASS | verified in this session |
| DB total size | 143 GB pre-run | 143 GB post-run, no growth | 0 | informational | PASS | verified in this session |
| `cleanupRunState` (this run row) | n/a (no active row pre-trigger) | row written, `state=completed, isActive=false` | n/a | row terminal | PASS | `npx convex data cleanupRunState --limit 20 --format jsonArray` (verified in this session) |
| `oldestRemainingTimestamp` | 1,777,733,713,861 (post run #2, 2026-05-02T14:55:13.861Z) | 1,777,733,972,725 (2026-05-02T14:59:32.725Z) | +258,864 ms (+4m 18.864s) | post >= pre | PASS | run #2 closure final row + `cleanupRunState` row this run |
| `metricsRealtime` eligible | not re-counted pre-run | not re-counted | structural proof: `deletedCount=4000 == batchSize * batchesRun` | matches `deletedCount` after cutoff alignment | PASS structural | `cleanupRunState` row (Phase 5 structural proof contract) |

Notes:
- WAL/disk/DB size anchors were verified in this session via `ssh root@178.172.235.49`
  + `docker exec adpilot-postgres ...` (`du -sb /var/lib/postgresql/data/pg_wal`,
  `df -h /`, `pg_database_size`). All three anchors flat across the run window — no WAL
  growth, no disk growth, no DB-size growth attributable to the cleanup chain.
- `oldestRemainingTimestamp` advanced `+258.864 s`. PASS condition `post >= pre` holds
  with significant margin (compare to maxRuns=5 closure which had only `+8.51 s`). The
  larger delta here matches the larger maxRuns and the lower density of source-time
  drained per chunk on the very oldest pages of `metricsRealtime`.

### Eligible delta cutoff alignment

- `cleanupRunState.cutoffUsed` (this run): 1,778,126,425,930 (2026-05-07T04:00:25.930Z),
  exactly `startedAt − 48h` (172,800,000 ms). Verified via arithmetic on row values.
- No fresh post-run server-local exact eligible count was performed (51-min scan cost,
  not justified for an 8-run safety profile).
- Strict expected if a count had been done: `|eligible_delta| == deletedCount = 4000` ±
  `boundary_M_estimate` (rows ingested into `metricsRealtime` during the 656.255-s run
  window).
- Verdict: **PASS structural**. `deletedCount=4000 == batchSize * batchesRun` confirms
  no missed-batch evidence. Phase 5 contract (maxRuns=5 closure line 144) explicitly
  allows structural proof in the `batchSize=500 * maxRuns ∈ {3..5}` band; this run
  extends that band to 8, which is the next-step profile already approved by the
  maxRuns=5 closure.

## Scheduled Functions

Verified in this session via direct SQL query against `adpilot-postgres` over the
run's `ts` window (mirroring the maxRuns=5 closure SQL recipe):

| UDF | Pre failed | Post failed | Delta failed | Total entries this run | Success this run | Failed this run | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| `metrics.js:manualMassCleanupV2` | 0 (post run #2 baseline) | 0 | **0** | 8 distinct documents | **8** | **0** | **PASS** |
| `metrics.js:manualMassCleanup` (V1) | 0 in run window | 0 | 0 | **0** | n/a | 0 | PASS by construction (V1 entrypoint is now a no-op; cron at `convex/crons.ts:219` points only to V2 wrapper `cleanupOldRealtimeMetricsV2`) |

Result: `manualMassCleanupV2 = 8 distinct / 8 success / 0 failed`; V1
`manualMassCleanup = 0` invocations.

Interpretation:
- 8 distinct V2 documents in the window match `cleanupRunState.batchesRun=8`.
- 0 V2 failed states confirms `cleanupRunState.error=undefined` and complements
  application-level proof.
- 0 V1 `manualMassCleanup` entries confirms no legacy path was reached.

## cleanupRunState Final Row

Independently verified via `npx convex data cleanupRunState --limit 20 --format jsonArray`
in this session:

```json
{
  "_creationTime": 1778299225930.8352,
  "_id": "r175q83p2czg4k8s2g1gdr6zyn86dg5g",
  "batchSize": 500,
  "batchesRun": 8,
  "cleanupName": "metrics-realtime-v2",
  "cutoffUsed": 1778126425930,
  "deletedCount": 4000,
  "durationMs": 656268,
  "isActive": false,
  "lastBatchAt": 1778299882185,
  "maxRuns": 8,
  "oldestRemainingTimestamp": 1777733972725,
  "restMs": 90000,
  "runId": "1778299225930-4f57ec67d364",
  "startedAt": 1778299225930,
  "state": "completed",
  "timeBudgetMs": 10000
}
```

Required fields per next-agent minimum:

- runId: `1778299225930-4f57ec67d364`
- trigger/start time: `2026-05-09T04:00:25.930Z` (epoch ms `1778299225930`)
- lastBatchAt: `2026-05-09T04:11:22.185Z` (epoch ms `1778299882185`)
- durationMs: `656268` (10 min 56.27 s)
- cutoffUsed: `1778126425930` (`2026-05-07T04:00:25.930Z`, exactly trigger − 48h)
- state: `completed`
- isActive: `false`
- batchesRun: `8`
- deletedCount: `4000`
- oldestRemainingTimestamp: `1777733972725` (`2026-05-02T14:59:32.725Z`)
- error: undefined / absent
- V2 `_scheduled_functions` success count delta: **+8** (verified in this session)
- Actual params: `batchSize=500, timeBudgetMs=10000, restMs=90000, maxRuns=8` (matches
  trigger args exactly)

### Per-chunk math sanity

- 7 inter-chunk rests × 90,000 ms = 630,000 ms.
- Per-chunk execution time: `(656,268 − 630,000) / 8 = 3,283.5 ms ≈ 3.28 s`.
- Linearity across full Phase 5 history:

  | Run | Profile | Per-chunk exec |
  |---|---|---:|
  | Phase 4 canary | maxRuns=1 | 3,554 ms |
  | Phase 5 #1 | maxRuns=3 | 3,615 ms |
  | Phase 5 #2 | maxRuns=5 | 3,439 ms |
  | Emergency #3 | maxRuns=8 | 3,283.5 ms |

  Linearity preserved across all four runs. Slight downward trend on the most recent run
  is consistent with cleanup hitting the very oldest, lowest-density pages of
  `metricsRealtime` (cheaper rows to find via the cutoff index).

`batchesRun == maxRuns == 8` and `oldestRemainingTimestamp` did not regress to before
`cutoffUsed`, so the chain hit `decision=complete` because `maxRuns` cap was reached, not
because backlog emptied. See "Backlog Math" for the size of the un-touched backlog.

## Backlog Math (honest framing)

This is the most important section of this closure. Numbers below are arithmetic on
`cleanupRunState` and not new measurements.

**All sizing figures here are approximate and density-derived** (from the very oldest
slice of the backlog, between this run's oldest pointer and run #2's). They are
intended as a **sizing signal**, not a fact. A fresh exact count via the preflight
SSH method (`/api/list_snapshot` page-by-page, ~50 min) was not performed. The actual
density across the full backlog likely differs from the oldest-edge density measured
here — typically the more recent slices of `metricsRealtime` are denser (more accounts
active, more banner-level rows per timestamp), so the density-derived row count is a
**lower-bound-style estimate**, not a precise figure.

- `cutoffUsed`: 2026-05-07T04:00:25.930Z (now − 48h at trigger time). [exact]
- `oldestRemainingTimestamp` post-run: 2026-05-02T14:59:32.725Z. [exact]
- Source-time gap from oldest to cutoff: **~4.542 days** (392,453,205 ms). [exact]
- Source-time drained by this run vs run #2: 258,864 ms ≈ **+4m 18.864s**. [exact]
- Density at this slice (oldest edge) of the backlog: `4,000 rows / 258.864 s ≈ 15.45
  rows/sec`. [exact for this slice; not extrapolable to later slices without
  measurement]
- **Approximate** remaining eligible rows below the current oldest pointer, using the
  oldest-edge density as a proxy: `4.542 days × 86400 s/day × 15.45 rows/s ≈ 6.06M
  rows`. [order-of-magnitude sizing signal only; could easily be ±50% or more]
- **Approximate** number of maxRuns=8 runs to drain at `4,000 rows / run`: ~1.5K
  runs. [order-of-magnitude only; depends on the same density assumption above]
- At ~10m56s per run plus operator-driven env-on/off cycles, this is **not** an
  operator-driven workload at any plausible density — it requires either:
  1. A larger profile (bigger `batchSize`, larger `maxRuns`, or smaller `restMs`) — each
     change crosses a Phase boundary and needs its own safety proof and explicit go.
  2. A fully restored cron with operator-supervised parameters (Phase 6 path), tuned to
     drain ≫ 4,000 rows/cycle.
  3. A separate "bulk-drain" mode with different safety semantics from the V2 contract
     (e.g. larger transactions, different lock profile, possibly with VACUUM-aware
     pacing).

None of these is decided in this closure. The decision belongs to a separate spec /
runbook. This closure only states the math so the next operator does not mistake the
present run for drainage.

Physical-disk caveat: deleting Convex rows reduces logical pressure but does not
immediately shrink Postgres physical size without a separate VACUUM/compaction
strategy. `pg_database_size` and `/dev/sda1` usage staying flat across this run is
consistent with that — the WAL footprint of the deletes is small, but the bytes do not
free up to the OS without VACUUM FULL or `pg_repack`. This is also out of scope here
and tracked in the `pg-bloat` track separately.

## Backend Stdout

Verified in this session via `docker logs --since 04:00 adpilot-convex-backend`:

| Pattern | Count | Verdict |
|---|---:|---|
| `[cleanup-v2] start` | 0 | INFORMATIONAL (Phase 4 caveat: marker absence is known log-routing behaviour of this self-hosted runtime, not a dirty signal) |
| `[cleanup-v2] end schedule` | 0 | INFORMATIONAL |
| `[cleanup-v2] end complete` | 0 | INFORMATIONAL |
| `[cleanup-v2] end failed` | 0 | PASS |
| `[cleanup-v2] disabled_mid_chain` skip | 0 | PASS (env held at 1 throughout the chain) |
| `TOKEN_EXPIRED` / `Too many concurrent` / `Transient error` / `rollback` | 0 | PASS |

Per maxRuns=5 closure (line 230), `[cleanup-v2]` marker absence in docker stdout with
clean `cleanupRunState` and `_scheduled_functions` is the documented self-hosted runtime
caveat, not dirty.

## Pre-existing Signals (NOT caused by this run)

Health signals checked at end of run (verified in this session via
`internal.healthCheck.*`), classified as pre-existing operational state of
`emergency/drain-scheduled-jobs`, not regressions caused by this cleanup chain:

1. **`cleanup-realtime: STUCK`** — V1 heartbeat for the legacy
   `cleanup-realtime-metrics` name. The cron entry at `convex/crons.ts:219` now points
   to the V2 wrapper (`cleanupOldRealtimeMetricsV2`), which does **not** record the V1
   heartbeat name; the legacy V1 entrypoint that did write it
   (`convex/metrics.ts:743`, `cleanup-realtime-metrics`) is no longer fired by any
   cron. The healthCheck config still watches the legacy name
   (`convex/healthCheck.ts:87`), which is the source of the STUCK signal — a
   monitoring rename gap, not a runtime regression. Same signal as in the maxRuns=5
   closure; no change of nature. Phase 6 plan is to introduce a V2 heartbeat name
   (`cleanup-realtime-metrics-v2`); not done in this run.

2. **Sync warning: `19/202 синхронизированы, abandoned: 2`** — operational state of
   this branch; sync throughput follow-ups (`SYNC_BATCH_SIZE_V2`,
   `SYNC_WORKER_COUNT_V2`) are tracked in `memory/b1-closure-2026-05-06.md`. Numbers
   `19/202` and `abandoned=2` are slightly different from the maxRuns=5 closure
   (`17/196 + 2`) — this is normal day-over-day account-set drift, not a regression
   attributable to cleanup. The cleanup window
   `04:00:25.930Z – 04:11:22.185Z` does not correlate with sync work; if the run had
   displaced sync, we would expect `STUCK` on `syncDispatch` heartbeat, which is absent.

3. **Token health: 1 expired (Анжелика Медведева, long-standing) + 2 expiring in
   ~11 h** — the expired token is the project owner's own token (per `MEMORY.md`
   userId `kx7djr...`) with `no refresh token`, ~36 days expired now, predates this
   branch by a wide margin. The 2 near-expiry tokens are informational; refresh path
   will pick them up before expiry. Not a regression caused by cleanup.

None of these three signals correlates to the cleanup window
`04:00:25.930Z – 04:11:22.185Z`. No new error counter growth on `_scheduled_functions`
(verified in this session, 0 V2 failed). No new rollback patterns in stdout
(verified in this session).

## Decision

**clean** — for the safety contract of the V2 chain. Specifically:

- V2 chain completed: `state=completed, isActive=false, error=undefined`.
- `batchesRun=8 (== maxRuns)`, `deletedCount=4000 (== batchSize * batchesRun)`.
- V2 failed absolute zero (verified in this session via SQL audit).
- V1 `manualMassCleanup` failed delta zero, total entries this run = 0 (cron entrypoint
  points only to V2 wrapper).
- Eligible delta vs deletedCount: structural PASS (Phase 5 contract; band extended to
  maxRuns=8 by the maxRuns=5 closure recommendation).
- `oldestRemainingTimestamp` post >= pre (+258.864 s, large positive delta).
- `pg_wal` flat (verified in this session, no growth across the run).
- `/dev/sda1` and DB size flat (verified in this session).
- Backend stdout has no rollback patterns (verified in this session).
- Core heartbeats clean apart from pre-existing V1 cleanup STUCK (legacy heartbeat
  name no longer written by any active cron entrypoint; monitoring rename gap, not a
  runtime regression — see "Pre-existing Signals" item 1).
- Env returned to `0`, verified independently in this session via `npx convex env get`.

**not** a real drainage. See "Backlog Math" — under an oldest-edge-density estimate
(approximate, not a fresh count), reaching the 48h retention target with the current
4000-row profile is on the order of thousands of chains, not tens.

## Post-run State

- `METRICS_REALTIME_CLEANUP_V2_ENABLED`: `0`, verified after run via `npx convex env get`
  in this session.
- `cleanup-old-realtime-metrics` cron: ACTIVE at `convex/crons.ts:219` with profile
  `{batchSize:500, timeBudgetMs:10_000, restMs:90_000, maxRuns:5}`. Fail-closed by env;
  no organic ticks fired during this run window because env was set to `1` only for the
  duration of `triggerMassCleanupV2` and the next 6h-aligned organic tick is outside the
  run window.
- `cleanupRunState` active rows: none. Final row above is `isActive=false`. The previous
  three rows (`maxRuns ∈ {1, 3, 5}`) are also `isActive=false`. Verified via
  `npx convex data cleanupRunState --limit 20 --format jsonArray` in this session.
- HEAD/origin: `259c91e`. No deploy or code changes by this run; env was temporarily
  enabled (`METRICS_REALTIME_CLEANUP_V2_ENABLED` 0 → 1 → 0) for the trigger window
  only and is restored to `0`.
- Working tree: pre-existing dirty state (untouched by this run; closure file is the
  only new artifact).

## Recommendations (no follow-up trigger without explicit go)

1. **Do not interpret this run as drainage.** Communicating to anyone other than the
   operator that "we cleaned up backlog" without the sizing caveat (millions of rows
   estimated still eligible below the cutoff, on the basis of an oldest-edge-density
   approximation) misrepresents the state. Use "safety proof of an 8-chunk chain"
   instead.

2. **The next decision is a phase decision, not a parameter bump.** Three sane next
   steps, all requiring their own discussion:
   - **Phase 6 (cron restore) with the maxRuns=8 profile as baseline.** Pre-condition:
     re-read `memory/storage-cleanup-v2-phase6-cron-restore-runbook-2026-05-08.md` and
     update its "latest clean controlled profile" reference to this closure. Each Phase 6
     step still needs explicit go.
   - **Bulk-drain spec** (separate from V2 chain): a parameter set or a different
     entrypoint sized to drain ≫ 4,000 rows per cycle. This is a new design, not a
     parameter bump on top of V2; safety proof would need to be redone.
   - **Postgres physical-size strategy** (orthogonal to row deletion): VACUUM /
     `pg_repack` / partitioning. Tracked in the `pg-bloat` track separately.
   None of these is recommended as "next click" — operator decides the order.

3. **Manual one-more-go path** (if operator wants another clean safety proof at this
   profile rather than crossing a phase): another `maxRuns=8` run is allowed by the
   established hard rules (`maxRuns >= 10 forbidden`, `restMs=90000`,
   `timeBudgetMs=10000`, `batchSize=500` unchanged). Adds another `~4,000 rows / ~10m56s`
   of drainage. Diminishing returns vs the order-of-millions backlog (per the
   density-derived sizing signal in "Backlog Math"); not a path to 48h retention.

## Operator Trace Summary

Chronological trace of operations performed in this session. State-changing steps
(env on, trigger, env off) were performed by the operator; verification reads were
performed by both the operator (SSH/SQL/docker logs/health-check API) and by the
agent (admin API: env, `cleanupRunState`, `/version`). All evidence cited in this
closure was produced inside this session.

1. Pre-run env read: `npx convex env get METRICS_REALTIME_CLEANUP_V2_ENABLED` → `0`.
2. Pre-run `cleanupRunState` scan: `npx convex data cleanupRunState --limit 20
   --format jsonArray` → 3 historical rows, all `isActive=false`. No active row.
3. Pre-run `/version` probes: HTTP 200 (operator-side: 2.486 s / 1.366 s / 1.326 s;
   agent-side earlier in session: 1.026–1.258 s).
4. Operator: env-on `1`, trigger `internal.metrics.triggerMassCleanupV2 {batchSize=500,
   timeBudgetMs=10000, restMs=90000, maxRuns=8}` → `{ runId:
   "1778299225930-4f57ec67d364", status: "scheduled" }`.
5. Chain self-progressed for 656.255 s, terminal `state=completed, batchesRun=8,
   deletedCount=4000`.
6. Operator: env-off `0`, verified.
7. SSH-side audit: `pg_wal` size flat (1,493,172,224 bytes pre/post), `df -h /` 54%
   flat, `docker logs --since 04:00 adpilot-convex-backend` grep `[cleanup-v2]` → 0,
   grep rollback patterns → 0.
8. SQL audit (mirroring maxRuns=5 closure recipe with this run's `ts` window):
   `manualMassCleanupV2 = 8 distinct / 8 success / 0 failed`,
   V1 `manualMassCleanup = 0` invocations.
9. Admin-API health checks (`internal.healthCheck.*`): V1 cleanup STUCK heartbeat,
   sync 19/202 + abandoned 2, token health (Анжелика expired + 2 expiring in ~11h);
   all classified pre-existing in "Pre-existing Signals".
10. Post-run env read: `npx convex env get METRICS_REALTIME_CLEANUP_V2_ENABLED` → `0`.
11. Post-run `cleanupRunState` read: `npx convex data cleanupRunState --limit 20
    --format jsonArray` → new row present in returned set, `isActive=false`,
    `deletedCount=4000`, all numbers match the run-state row reproduced above exactly.
12. Post-run `/version` probes: HTTP 200 (operator-side: 1.493 / 1.402 / 1.917 s;
    agent-side earlier: 1.320 / 1.356 s). Latency stable across both probe sets.

No code-file edits this session. No commits. No deploy. One new file written: this
closure memo.

## Reference Pointers For Next Agent

- Phase 5 run #1 closure (`maxRuns=3`): `memory/storage-cleanup-v2-controlled-closure-2026-05-08.md`.
- Phase 5 run #2 closure (`maxRuns=5`): `memory/storage-cleanup-v2-controlled-closure-2026-05-08-maxRuns5.md`.
- Phase 4 canary closure: `memory/storage-cleanup-v2-canary-closure-2026-05-08.md` (commit `8b96807`).
- Phase 1 design (V2 architecture, env flag, `cleanupRunState` shape):
  `memory/storage-cleanup-v2-phase1-design-2026-05-07.md`.
- Phase 6 runbook: `memory/storage-cleanup-v2-phase6-cron-restore-runbook-2026-05-08.md`
  (update its "latest clean controlled profile" reference to this closure before any
  Phase 6 work).
- Phase 5 runbook (locked params, gates, hard stops):
  `memory/storage-cleanup-v2-phase5-controlled-runs-runbook-2026-05-08.md`.
- Code source of truth at run time:
  - HEAD/origin: `259c91e docs(uz-budget): align reset cron cadence comment` on
    `emergency/drain-scheduled-jobs`.
  - Phase 6 cleanup wrapper / cron entry was deployed via commit
    `a1775dd feat(storage-cleanup): enable cleanup V2 cron wrapper` (params on the
    cron line: `batchSize=500, timeBudgetMs=10000, restMs=90000, maxRuns=5`).
  - Commits between `a1775dd` and HEAD `259c91e` (5): `93c3584 docs(storage-cleanup):
    mark master plan superseded`, `783ff89 docs(uz): diagnose 2026-05-08 UZ rule
    bugs`, `fccad0a fix(uz-budget): restore daily reset cron`, `99b81d1 fix(uz-budget):
    increase reset cron cadence`, `259c91e docs(uz-budget): align reset cron cadence
    comment`. None modify cleanup V2 code; UZ-budget changes are unrelated to this
    closure.
  - V2 entrypoints in `convex/metrics.ts`:
    `triggerMassCleanupV2 (line 444)`, `manualMassCleanupV2 (line 635)`,
    `getCleanupRunStateV2 (line 488)`, `cleanupOldRealtimeMetricsV2 (line 612)`.
  - V1 path is a no-op in current code; not reachable from any active cron.
  - Cron registration: `convex/crons.ts:219` —
    `crons.cron("cleanup-old-realtime-metrics", "0 */6 * * *",
    internal.metrics.cleanupOldRealtimeMetricsV2, {batchSize:500, timeBudgetMs:10_000,
    restMs:90_000, maxRuns:5})`. Fail-closed by `METRICS_REALTIME_CLEANUP_V2_ENABLED`.
  - Heartbeat config: `convex/healthCheck.ts:66-113` (`checkCronHeartbeats`).
- Plan: `docs/superpowers/plans/2026-05-07-storage-cleanup-v2.md` (Phase 5 / 6 sections).
- DB access for direct SQL audit (mirror maxRuns=5 closure recipe with this run's
  ts window `[1778299225000000000, 1778299900000000000]`):
  `ssh root@178.172.235.49`, then `docker exec -e PGPASSWORD=$(...)` etc., per the
  maxRuns=5 closure "Reference Pointers" line.
- Gate A env=0 proof and Gate B missed-window record live as untracked drafts in
  `memory/storage-cleanup-v2-cron-closure-2026-05-08.md` and
  `memory/storage-cleanup-v2-phase6-gate-b-checklist-2026-05-08.md` — **not** committed,
  not touched by this closure.

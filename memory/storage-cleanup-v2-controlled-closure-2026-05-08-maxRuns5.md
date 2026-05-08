# Storage Cleanup V2 - Controlled Run Closure - 2026-05-08 - maxRuns=5

Status: clean
Trigger time: 2026-05-08T09:36:09.547Z
runId: 1778232969547-20283bb90f21
Params: batchSize=500, timeBudgetMs=10000, restMs=90000, maxRuns=5

This is the **second** Phase 5 controlled run on 2026-05-08. The first
(`maxRuns=3` at 07:35:05Z, runId `1778225705482-b8b7b8deb8ac`) is documented at
`memory/storage-cleanup-v2-controlled-closure-2026-05-08.md`. Pre-anchors here are
post-state of run #1 where applicable, not the original preflight values.

Deviation from runbook recommendation: `maxRuns=5` instead of recommended `3`. Explicitly
allowed by runbook Step 2 line 122 ("small multiplier 3-5x over canary `maxRuns=1`"). Hard
rule `maxRuns >= 10 forbidden` not breached. Followed run #1's "Phase 5 Next-Run
Recommendation" section (lines 178-183 of run #1 closure), which proposed exactly this
profile.

## Document Status For Next Agent

The run completed cleanly with authoritative app-level proof
(`cleanupRunState.state=completed`, `error=undefined`, `batchesRun=5`,
`deletedCount=2500=batchSize*batchesRun`).

`_scheduled_functions` SQL audit confirms exactly **5 success states**, **0 failed
states** for `metrics.js:manualMassCleanupV2` in the run window, and **0 V1
`manualMassCleanup` invocations**.

`pg_wal` did not grow; net delta over a wider observation window is negative (Postgres
checkpoint completed). Backend stdout has no rollback patterns. Three pre-existing
operational signals were classified as not caused by this run (see "Pre-existing Signals").

For Phase 6 readiness: this is the second clean Phase 5 closure on the same day. Phase 5
runbook (line 374) prefers "several controlled runs". Two clean runs with a `1->3->5`
chain progression satisfy "several" minimally; operator decides if more are needed before
Phase 6 cron restore.

A network incident during observation prevented mid-run polling, but did not affect
server-side chain integrity (chain self-schedules within Convex). All anchors were
re-acquired after the fact.

## Preconditions Confirmed

- Phase 4 closure: `memory/storage-cleanup-v2-canary-closure-2026-05-08.md` (commit `8b96807`), Status: clean.
- Phase 5 run #1 closure: `memory/storage-cleanup-v2-controlled-closure-2026-05-08.md`, Status: clean (`maxRuns=3`, runId `1778225705482-b8b7b8deb8ac`, 07:35:05Z).
- Git context after handoff in this workspace: HEAD == origin == `4a9eb4f` on
  `emergency/drain-scheduled-jobs`. Production cleanup code was unchanged during this
  run; local Phase 6 code patch files may be dirty in this workspace but were not
  deployed and did not affect the run.
- Phase 6 runbook is already tracked (`memory/storage-cleanup-v2-phase6-cron-restore-runbook-2026-05-08.md`,
  latest doc-only commit `4a9eb4f`) and is updated separately with this maxRuns=5
  closure as the latest clean profile.
- Env pre: `METRICS_REALTIME_CLEANUP_V2_ENABLED=0`, verified by `npx convex env get`.
- `cleanup-old-realtime-metrics` cron still commented in `convex/crons.ts:216`.
- No active `cleanupRunState` row at trigger time. Trigger #2 returned
  `{status: "scheduled", runId: 1778232969547-20283bb90f21}`, which by Phase 1 contract
  is only possible when no row is `isActive=true` for `cleanupName="metrics-realtime-v2"`.
- `/version` pre: HTTP 200 across 4 probes, ~1.2-1.4s.
- Core heartbeats pre (operator preflight): `syncDispatch`, `uzBudgetDispatch`,
  `tokenRefreshDispatch` all `completed`, `error=null`.

## Network Incident During Observation

Between approximately +1 min and +9 min after trigger, the local admin API saw 12
consecutive `TypeError: fetch failed` errors while polling `getCleanupRunStateV2`. The
first poll at +1 min succeeded with `state=running, batchesRun=1, deletedCount=500`. The
final state read was retried successfully after the run completed and the network
stabilised.

Trigger sequence: trigger #1 also failed with `TypeError: fetch failed`; the request did
not reach the server (proven by trigger #2 returning `{status: "scheduled"}` with a fresh
runId rather than `{status: "already-running"}` per the runbook Step 7 contract).

Impact: per-chunk progression visibility lost during the run. Server-side chain is
self-scheduling within Convex and does not depend on client polling, so chain integrity
is unaffected. Authoritative final-state proof is the `cleanupRunState` row reproduced
below; per runbook line 271 this overrides `_scheduled_functions.kind` (and is here also
corroborated by direct `_scheduled_functions` SQL audit, see Scheduled Functions section).

## Anchors

| Anchor | Pre (= post-run #1 where applicable) | Post | Delta | Threshold | Verdict | Source |
|---|---:|---:|---:|---|---|---|
| `/version` | HTTP 200, 1.2-1.4s | HTTP 200, slow during incident, then 200 stable | latency spike during incident, recovered | 200 | PASS | `curl https://convex.aipilot.by/version` |
| `pg_wal` | 2,281,701,376 bytes (post-run #1) | 1,929,379,840 bytes (post-run #2 + 22 min) | -352,321,536 bytes (-336 MiB) | warn 25 MB / hard 150 MB | PASS | `ssh ... docker exec adpilot-postgres du -sb /var/lib/postgresql/data/pg_wal` |
| `metricsRealtime` total | 9,424,786 (preflight); 9,423,286 inferred post run #1 | not re-counted | n/a | informational | INFORMATIONAL | preflight scan |
| `metricsRealtime` eligible | 9,089,514 at preflight cutoff `1778047209787` (06:00:09.787Z); ~9,088,014 inferred after run #1 | not re-counted | structural proof: `deletedCount=2500 == batchSize * batchesRun` | matches `deletedCount` after cutoff alignment and boundary-M adjustment | PASS structural | preflight scan + cleanupRunState |
| `oldestRemainingTimestamp` | 1,777,733,705,347 (post-run #1, 2026-05-02T14:55:05.347Z) | 1,777,733,713,861 (2026-05-02T14:55:13.861Z) | +8,514 ms (+8.51 s) | post >= pre | PASS | run #1 closure final row + cleanupRunState run #2 |

Notes:
- WAL net negative because checkpoint(s) ran during the wider observation window
  (preflight scan + run #1 + run #2 + 22 min trail = ~4.1 h). Authoritative for "no WAL
  pressure attributable to this run".
- `oldestRemainingTimestamp` advanced ~8.5 s due to concurrent `metricsRealtime` ingest
  during the 6.3-min run window plus boundary effects of cleanup against an immutable
  per-run cutoff. PASS condition `post >= pre` holds.

### Eligible delta cutoff alignment

- `cleanupRunState.cutoffUsed` (run #2): 1,778,060,169,547 (2026-05-06T09:36:09.547Z),
  exactly `startedAt - 48 h` (172,800,000 ms).
- Pre-cutoff used by preflight scan (06:00 window): 1,778,047,209,787 (2026-05-06T06:00:09.787Z).
- Cutoff drift between preflight scan and run #2: 12,959,760 ms ≈ 3 h 36 min.
- `boundary_M_estimate`: rows ingested into `metricsRealtime` in the cutoff drift window;
  not measured directly. Bounded above by typical ingest rate of `metricsRealtime` for
  3.6 h.
- Strict expected if cutoffs matched: `|eligible_delta| == deletedCount = 2500`.
- Approximate expected with cutoff drift: `|eligible_delta| ~= 2500 +/- boundary_M_estimate`.
- Verdict: **PASS structural**. `deletedCount=2500 == batchSize * batchesRun` confirms no
  missed-batch evidence. Full eligible_delta arithmetic deferred because no fresh
  post-run exact count was performed (51-min scan cost). Runbook line 144 explicitly
  allows structural proof for the first Phase 5 profiles in the
  `batchSize=500 * maxRuns=3..5` range.

## Scheduled Functions

Counts obtained by direct SQL query against `adpilot-postgres` (`adpilot_prod` database,
public.documents JSON-text grep with `convert_from(json_value, 'UTF8') LIKE`) over the
run's `ts` window `[1778232969000000000, 1778233500000000000]` (nanoseconds since epoch).

| UDF | Pre failed | Post failed | Delta failed | Total entries this run | Success this run | Failed this run | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| `metrics.js:manualMassCleanupV2` | 0 (preflight; 0 from run #1) | 0 | **0** | 5 distinct documents (15 state-row writes: pending->in_progress->success per chunk) | **5** | **0** | **PASS** |
| `metrics.js:manualMassCleanup` (V1) | 1 historical (preflight) | 1 historical | 0 | **0** | n/a | 0 | PASS by construction (V1 cron commented) |
| `adminAlerts.js:notify` | 38 (preflight baseline) | 38 | 0 | n/a | n/a | 0 | PASS |
| `auth.js:tokenRefreshOneV2` | 14 (preflight baseline) | 14 | 0 | n/a | n/a | 0 | PASS |
| `ruleEngine.js:uzBudgetBatchWorkerV2` | 1 (preflight baseline) | 1 | 0 | n/a | n/a | 0 | PASS |

Direct evidence:

```text
SELECT count(*) AS v2_success_states FROM documents
  WHERE ts >= 1778232969000000000 AND ts <= 1778233500000000000
    AND convert_from(json_value, 'UTF8') LIKE '%manualMassCleanupV2%'
    AND convert_from(json_value, 'UTF8') LIKE '%"state":{"type":"success"}%';
=> 5

SELECT count(*) AS v2_all, count(DISTINCT id) AS v2_docs FROM documents
  WHERE ts >= 1778232969000000000 AND ts <= 1778233500000000000
    AND convert_from(json_value, 'UTF8') LIKE '%metrics.js:manualMassCleanupV2%';
=> 15 / 5

SELECT count(*) FROM documents
  WHERE ts >= 1778232969000000000 AND ts <= 1778233500000000000
    AND convert_from(json_value, 'UTF8') LIKE '%manualMassCleanupV2%'
    AND convert_from(json_value, 'UTF8') LIKE '%"state":{"type":"failed"%';
=> 0

SELECT count(*) FROM documents
  WHERE ts >= 1778232969000000000 AND ts <= 1778233500000000000
    AND convert_from(json_value, 'UTF8') LIKE '%metrics.js:manualMassCleanup"%'
    AND convert_from(json_value, 'UTF8') NOT LIKE '%manualMassCleanupV2%';
=> 0
```

Interpretation:
- 5 distinct V2 documents in the window match `cleanupRunState.batchesRun=5`. Each
  document went pending -> in_progress -> success (3 state writes, 15 total = 3 * 5).
- 0 V2 failed states confirms `cleanupRunState.error=undefined` and complements
  application-level proof.
- 0 V1 `manualMassCleanup` entries confirms the V1 cron commenting is effective; no
  invocations during the run window.

## cleanupRunState Final Row

```json
{
  "_creationTime": 1778232969547.6682,
  "_id": "r17657bcpq01mn1rd0zz8pvz9586a1yc",
  "batchSize": 500,
  "batchesRun": 5,
  "cleanupName": "metrics-realtime-v2",
  "cutoffUsed": 1778060169547,
  "deletedCount": 2500,
  "durationMs": 377196,
  "isActive": false,
  "lastBatchAt": 1778233346730,
  "maxRuns": 5,
  "oldestRemainingTimestamp": 1777733713861,
  "restMs": 90000,
  "runId": "1778232969547-20283bb90f21",
  "startedAt": 1778232969547,
  "state": "completed",
  "timeBudgetMs": 10000
}
```

Required fields per next-agent minimum (matches operator request):

- runId: `1778232969547-20283bb90f21`
- trigger/start time: `2026-05-08T09:36:09.547Z` (epoch ms `1778232969547`)
- durationMs: `377196` (6 min 17 s)
- cutoffUsed: `1778060169547` (`2026-05-06T09:36:09.547Z`, exactly trigger - 48 h)
- state: `completed`
- isActive: `false`
- batchesRun: `5`
- deletedCount: `2500`
- oldestRemainingTimestamp: `1777733713861` (`2026-05-02T14:55:13.861Z`)
- error: undefined / absent
- V2 `_scheduled_functions` success count delta: **+5** (SQL-verified)
- Actual params: `batchSize=500, timeBudgetMs=10000, restMs=90000, maxRuns=5` (matches
  trigger args exactly)

Per-chunk math sanity:

- 4 inter-chunk rests * 90,000 ms = 360,000 ms.
- Per-chunk execution time: `(377,196 - 360,000) / 5 = 3,439 ms ≈ 3.44 s`.
- Phase 4 canary per-chunk was `3,554 ms ≈ 3.55 s` for 500 rows.
- Run #1 (`maxRuns=3`) per-chunk: `(190,847 - 180,000) / 3 = 3,615 ms ≈ 3.62 s`.
- Linearity preserved across canary, run #1, and run #2.

`batchesRun == maxRuns == 5` and `oldestRemainingTimestamp` did not regress to before
`cutoffUsed`, so the chain hit `decision=complete` because `maxRuns` cap was reached, not
because backlog emptied. Eligible backlog of ~9.09 M rows confirms this: `deletedCount=2500`
is 0.027% of backlog, structural-proof scale only.

## Backend Stdout

| Pattern | Count | Window | Verdict |
|---|---:|---|---|
| `[cleanup-v2] start` | 0 | `docker logs --since 09:35` | INFORMATIONAL (Phase 4 caveat) |
| `[cleanup-v2] end schedule` | 0 | same | INFORMATIONAL |
| `[cleanup-v2] end complete` | 0 | same | INFORMATIONAL |
| `[cleanup-v2] end failed` | 0 | same | PASS |
| `[cleanup-v2] disabled_mid_chain` skip | 0 | same | PASS (env held at 1 throughout) |
| `TOKEN_EXPIRED` / `Too many concurrent` / `Transient error` / `rollback` | 0 | same | PASS |

`[cleanup-v2]` markers absent in `docker logs adpilot-convex-backend` since 09:35Z.
Matches Phase 4 closure caveat (`8b96807`: "phase4_stdout_markers: not surfaced in docker
stdout"). Per runbook line 236, marker absence with clean `cleanupRunState` and
`_scheduled_functions` is the known log-routing caveat of this self-hosted runtime, not a
dirty signal.

## Core Heartbeats

Verified via `internal.healthCheck.checkCronHeartbeats` at ~10:04Z (post-run +22 min).

| Heartbeat | Pre | Post | Verdict |
|---|---|---|---|
| `syncDispatch` | completed, err= - (preflight) | not in error/stuck list | PASS |
| `uzBudgetDispatch` | completed, err= - | same | PASS |
| `tokenRefreshDispatch` | completed, err= - | same | PASS |
| `cleanup-realtime-metrics` (V1 stale legacy) | stale by design (cron commented) | `STUCK (5292 мин)` returned in issues | PRE-EXISTING (not regression; see below) |

## Pre-existing Signals (NOT caused by this run)

Three non-zero results from health-check queries — investigated and classified as
operational state of `emergency/drain-scheduled-jobs`, not regressions:

1. **`cleanup-realtime: STUCK (5292 мин)`** - V1 heartbeat for the deprecated
   `cleanup-realtime-metrics` name. V1 cron is commented in `convex/crons.ts:216`; the
   heartbeat has no firing path. Threshold `maxStaleMin=25*60=1500` in
   `convex/healthCheck.ts:87` flags >88 hours of staleness. This is intentional during
   storage-cleanup-V2; Phase 6 will introduce a V2 heartbeat name
   (`cleanup-realtime-metrics-v2`). Documented in the Phase 6 runbook draft
   (Implementation Contract).

2. **`sync: 17/196 синхронизированы, abandoned: 2`** (from `checkCronSyncResults`).
   Operational state of this branch; sync throughput follow-ups (`SYNC_BATCH_SIZE_V2`,
   `SYNC_WORKER_COUNT_V2`) are tracked in `memory/b1-closure-2026-05-06.md`. The run did
   not break sync: `syncDispatch` heartbeat is not stuck/error in post-run health check;
   if the run had displaced sync work, we would expect `STUCK` on `syncDispatch`, which
   is absent.

3. **Token health: 1 expired (Анжелика Медведева, 836 h), 2 expiring in ~5 h** (from
   `checkTokenHealth`). The expired token belongs to the project owner (per `MEMORY.md`
   userId `kx7djr...`) and has `no refresh token` — long-standing, ~35 days expired,
   predates this branch. The 2 near-expiry tokens are informational (refresh path will
   pick them up); not a regression.

None of these three signals correlates to the cleanup window
`09:36:09.547Z - 09:42:26.730Z`. No new error counter growth on `_scheduled_functions`
(SQL-verified). No new rollback patterns in stdout since 09:35Z.

## Decision

**clean**

All Phase 5 runbook Step 10 cleanness criteria satisfied:
- V2 chain completed: `state=completed, isActive=false, error=undefined`.
- `batchesRun=5 (== maxRuns)`, `deletedCount=2500 (== batchSize * batchesRun)`.
- V2 failed absolute zero (SQL-verified, also implied by row state).
- V1 `manualMassCleanup` failed delta zero, total entries this run = 0 (SQL-verified, V1
  cron commented).
- Eligible delta vs deletedCount: structural PASS for Phase 5 (runbook line 144).
- `oldestRemainingTimestamp` post >= pre (+8.51 s).
- `pg_wal` delta below warn (well below — net negative -336 MiB).
- Backend stdout has no rollback patterns; `[cleanup-v2]` marker absence not dirty.
- Core heartbeats clean (V1 cleanup stale by design).
- Env returned to 0, verified.

## Post-run State

- `METRICS_REALTIME_CLEANUP_V2_ENABLED`: `0`, verified after run via `npx convex env get`.
- `cleanup-old-realtime-metrics` cron: still commented in `convex/crons.ts:216`.
- `cleanupRunState` active rows: none (final row above is `isActive=false`).
- HEAD/origin after handoff: `4a9eb4f`. No deploy/code/env changes were made by this
  run; this closure memo is the only new storage-cleanup artifact from the run itself.

## Phase 5 Next-Run Recommendation

Two clean Phase 5 closures (`maxRuns=3` then `maxRuns=5`) with linear per-chunk timing
(3.55 -> 3.62 -> 3.44 s) demonstrate a stable chain across the 1-3-5 progression.

If continuing manually, optional next profile:

```text
batchSize:     500
timeBudgetMs:  10000
restMs:        90000
maxRuns:       8
```

Rationale: another conservative step within the operational comfort range, still well
below cron-equivalent throughput. Maximum delete pressure: 4,000 rows per run, ~10 min
chain, ~720 ms WAL footprint expected based on observed scale. Each next run requires one
explicit operator go.

Alternative: stop manual runs and proceed to Phase 6 planning with parameters derived
from this last clean controlled profile (`maxRuns=5`), not any older example profile.

## Phase 6 Readiness

- Two clean Phase 5 closures available (run #1 `maxRuns=3`, run #2 `maxRuns=5`).
- Runbook line 374 prefers "several controlled runs". Two on a `1-3-5` progression
  satisfies the minimum gate but is at the lower edge of "several".
- Phase 6 runbook at `memory/storage-cleanup-v2-phase6-cron-restore-runbook-2026-05-08.md`
  has been hardened through commit `4a9eb4f`; update it with this maxRuns=5 closure
  before committing Phase 6 code.
- First organic cron profile must be derived from the last clean controlled profile
  (`maxRuns=5` here), not any older `maxRuns=3` profile.
- Each Phase 6 step requires explicit go.

## Follow-ups

- (P5) Out of scope here but sometimes useful: a fresh post-run exact eligible count via
  the preflight server-local SSH method (`/api/list_snapshot` page-by-page, ~50 min).
  Skip for the current `maxRuns=5` profile (structural proof allowed).
- (P5) The local admin API `fetch failed` instability hampered live polling. Investigate
  whether it is an ISP/Wi-Fi/Traefik-stream issue independent of prod (prod stayed
  healthy: `/version` 200 throughout, internal chain self-scheduled correctly).
- (P5 -> P6) Sync `17/196` and `abandoned: 2` are unrelated to cleanup; expected to be
  addressed by SYNC_BATCH/WORKER bumps tracked in `memory/b1-closure-2026-05-06.md`
  follow-ups.
- (P6) Resolve V1 cleanup heartbeat stale signal in Phase 6 by adopting V2 heartbeat
  name; do not silence the V1 monitor entry.

## Operator Trace Summary

Chronological trace of operations performed during this run:

1. Read `npx convex env get METRICS_REALTIME_CLEANUP_V2_ENABLED` -> `0`.
2. Wrote `npx convex env set METRICS_REALTIME_CLEANUP_V2_ENABLED 1`, verified -> `1`.
3. Trigger #1 `internal.metrics.triggerMassCleanupV2 {batchSize=500, timeBudgetMs=10000, restMs=90000, maxRuns=5}` -> `TypeError: fetch failed` (request did not reach server, see retry result).
4. Trigger #2 same args -> `{ runId: "1778232969547-20283bb90f21", status: "scheduled" }` (scenario A: first attempt did not register on server).
5. Polled `internal.metrics.getCleanupRunStateV2 {runId}` over ~9 min: 1 successful poll showed `state=running, batchesRun=1, deletedCount=500`; 12 subsequent polls returned `fetch failed`.
6. After network recovery (`/version` 6.36s response), single read of `getCleanupRunStateV2 {runId}` returned the final completed row above.
7. Wrote `npx convex env set METRICS_REALTIME_CLEANUP_V2_ENABLED 0`, verified -> `0`.
8. Post-run SSH read-only checks via `id_ed25519_server` to `root@178.172.235.49`:
   - `du -sb /var/lib/postgresql/data/pg_wal` inside `adpilot-postgres` -> 1,929,379,840 bytes.
   - `docker logs --since 09:35:00 adpilot-convex-backend` grep `[cleanup-v2]` -> 0 hits.
   - `docker logs --since 09:35:00 adpilot-convex-backend` grep rollback patterns -> 0 hits.
9. Three admin-API health checks via `npx convex run internal.healthCheck.*`:
   `checkCronHeartbeats` (one stale V1 heartbeat returned, see Pre-existing Signals),
   `checkCronSyncResults` (warning, pre-existing operational state),
   `checkTokenHealth` (one long-standing expired token, pre-existing).
10. SQL audit via SSH + `docker exec adpilot-postgres psql -U convex -d adpilot_prod`:
    counted V2 success/failed states and V1 invocations in run window. Results: V2
    success=5, V2 failed=0, V1 entries=0.

No code-file edits. No commits. One new file written: this closure memo.

## Reference Pointers For Next Agent

- Phase 5 runbook (locked params, gates, hard stops): `memory/storage-cleanup-v2-phase5-controlled-runs-runbook-2026-05-08.md`.
- Phase 5 run #1 closure (`maxRuns=3`): `memory/storage-cleanup-v2-controlled-closure-2026-05-08.md`.
- Phase 4 closure (canary precedent): `memory/storage-cleanup-v2-canary-closure-2026-05-08.md` (commit `8b96807`).
- Phase 1 design (V2 architecture, env flag, `cleanupRunState` shape): `memory/storage-cleanup-v2-phase1-design-2026-05-07.md`.
- Phase 6 runbook: `memory/storage-cleanup-v2-phase6-cron-restore-runbook-2026-05-08.md`.
- Code source of truth at run time:
  - V2 entrypoints: `convex/metrics.ts` (commit `2410f14`): `triggerMassCleanupV2`, `manualMassCleanupV2`, `scheduleNextChunkV2`, `getCleanupRunStateV2 (line 488)`.
  - V1 dead path: same file, `manualMassCleanup` no-op.
  - Cron registration: `convex/crons.ts:216` (commented `cleanup-old-realtime-metrics`).
  - Heartbeat config: `convex/healthCheck.ts:66-113` (`checkCronHeartbeats`).
- Plan: `docs/superpowers/plans/2026-05-07-storage-cleanup-v2.md` (Phase 5 section).
- DB access for direct SQL audit: `ssh root@178.172.235.49`, then
  `docker exec -e PGPASSWORD=$(docker inspect adpilot-postgres --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^POSTGRES_PASSWORD=' | cut -d= -f2-) adpilot-postgres psql -U convex -d adpilot_prod`.
  System tables (e.g. `_scheduled_functions`) live in `public.documents` as JSON-text in
  `bytea`; query with `convert_from(json_value, 'UTF8') LIKE '%pattern%'`. Time filter via
  `ts` column in nanoseconds since epoch (epoch_ms * 10^6).

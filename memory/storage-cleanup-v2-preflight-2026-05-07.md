# Storage Cleanup V2 Preflight Baseline - 2026-05-07

Status: read-only Phase 0 baseline captured. No code edits, no deploy, no env changes, and no cleanup trigger were run.

Related plan:
- `docs/superpowers/plans/2026-05-07-storage-cleanup-v2.md`

## Scope

This baseline supports the next Storage Cleanup V2 implementation track. It is not a go decision for cleanup execution.

Phase 1 scope remains `metricsRealtime` only. `metricsDaily` and `vkApiLimits` must not be implemented or tuned in the Phase 1 commit.

## Branch State

```text
HEAD:   9f6786bc7834a67c4bd856ba2f4efd6318c422b5
origin: 9f6786bc7834a67c4bd856ba2f4efd6318c422b5
commit: 9f6786b docs(storage-cleanup): runbook hardening for V2 implementation
```

`HEAD == origin/emergency/drain-scheduled-jobs`.

## Production Health Snapshot

Initial `/version`:

```text
HTTP 200, about 1.41s
```

Final `/version` after the long read-only `metricsRealtime` count:

```text
HTTP 200, about 1.50s
```

Disk:

```text
/dev/sda1  315G total, 165G used, 138G available, 55%
```

Backend stdout rollback patterns since cadence closure (`2026-05-07T11:40:00Z`):

```text
Too many concurrent / Transient error / TOKEN_EXPIRED /
syncBatchV2.*Account .* failed / adminAlerts.*notify: 0
```

Backend stdout rollback patterns since the long count window (`2026-05-07T14:00:00Z`):

```text
0
```

## PostgreSQL Anchors

Initial `pg_wal`:

```text
1,543,503,872 bytes
```

Post-count `pg_wal`:

```text
5,888,802,816 bytes
```

Delta:

```text
+4,345,298,944 bytes
```

Follow-up stability checks:

```text
5,888,802,816 bytes repeated
351 pg_wal segment files
archive_status files: 0 total, 0 ready, 0 done
```

Interpretation: this is a yellow preflight signal. The long read-only pagination count correlated with a large WAL-size increase, but the value was stable on repeat checks and disk headroom stayed healthy. Phase 4 canary must refresh `pg_wal` immediately before trigger and must not proceed if WAL is still rising or disk headroom has deteriorated.

Important caveat: this preflight did not isolate baseline WAL rate from count-induced WAL growth. The 13:49Z to 15:34Z window included normal post-cadence-15 production activity (sync ticks, UZ ticks, token refresh, and dirty-check writes). Before Phase 4 canary, take a no-cleanup WAL spot-check pair, for example `T=0` and `T=+30min`, to estimate baseline WAL noise without another full count. If baseline noise is already larger than the expected canary signal, canary rollback thresholds must use the baseline rate rather than the illustrative per-batch estimate alone.

`archive_status files: 0` is recorded only as an observation. It does not prove archiving mode by itself; depending on PostgreSQL configuration it can mean archive mode is off or that there are no pending archive-status marker files.

`pg_stat_user_tables` / size snapshot:

```text
indexes|99588489216|36049010688|63529484288|177635|3435170||
documents|53826166784|24394162176|29385162752|44024910|128121|2026-05-07 13:36:10.573994+00|2026-05-07 10:48:51.900361+00
persistence_globals|458752|106496|16384|10|15|2026-05-07 13:52:11.207363+00|2026-05-07 13:51:11.190707+00
leases|49152|8192|16384|0|4||
read_only|8192|0|8192|0|0||
```

Interpretation: `indexes` has a separate yellow signal. It reports about 177,635 live tuples vs 3,435,170 dead tuples, roughly a 19:1 dead/live ratio, with empty `last_autovacuum` / `last_autoanalyze` fields in this snapshot. `documents` is comparatively healthy by tuple ratio: 44,024,910 live vs 128,121 dead, with recent autovacuum. This matters for Phase 9 priority (`VACUUM (ANALYZE)` may be more urgent for `indexes` than `documents`) and for cleanup WAL estimates, because deleting Convex documents still touches bloated index structures.

Active PostgreSQL work:

```text
pg_stat_progress_vacuum: 0 rows
no active long-running cleanup/count query after count completion
```

## Scheduled Function State

Latest scheduled-function state:

```text
auth.js:tokenRefreshOneV2|failed|14|1777964976757.1868
auth.js:tokenRefreshOneV2|success|1829|1778159376915.3904
metrics.js:manualMassCleanup|failed|1|1777944369227.103
metrics.js:manualMassCleanup|success|1968|1777943677251.12
ruleEngine.js:uzBudgetBatchWorkerV2|success|76|1778161330613.7468
syncMetrics.js:syncBatchWorkerV2|success|78|1778161750361.8164
```

No `manualMassCleanupV2` entries were observed. Existing `metrics.js:manualMassCleanup` entries are historical V1 residue only.

Environment gate:

```text
METRICS_REALTIME_CLEANUP_V2_ENABLED: not found
```

Interpretation: this matches the planned default-off state for future V2 code. No env value was set during this preflight.

## Heartbeat Snapshot

Before long count:

```text
syncDispatch:         2026-05-07T13:49:10.293Z, completed, err=-
uzBudgetDispatch:     2026-05-07T13:42:10.535Z, completed, err=-
tokenRefreshDispatch: 2026-05-07T13:09:36.640Z, completed, err=-
```

After long count:

```text
syncDispatch:         2026-05-07T15:34:10.333Z, completed, 150ms, err=-
uzBudgetDispatch:     2026-05-07T15:12:10.520Z, completed, 116ms, err=-
tokenRefreshDispatch: 2026-05-07T15:09:36.656Z, completed, 2858ms, err=-
```

Known stale heartbeat:

```text
cleanup-realtime-metrics: running since 2026-05-04T18:00:00.793Z
```

Interpretation: the cleanup heartbeat is old V1/stale state, not new V2 cleanup work. This is a Phase 1 implementation gotcha: V2 must use a V2-specific heartbeat/run-state name such as `cleanup-realtime-metrics-v2`. Reusing `cleanup-realtime-metrics` would see the stale `running` row and may incorrectly skip the new V2 cleanup path.

## metricsRealtime Count Anchor

Read-only count method:

```text
server-local pagination through /api/list_snapshot
```

This was a read-only Convex snapshot pagination path invoked from the production server against localhost. It did not call cleanup mutations, did not write application data, and did not trigger scheduled jobs. The count was intentionally not repeated for other large tables to avoid another heavy scan.

Window:

```text
started_at:   2026-05-07T14:15:30Z
completed_at: 2026-05-07T15:08:55Z
```

Cutoff:

```text
cutoff_ms:  1777990527043
cutoff_iso: 2026-05-05T14:15:27Z
retention:  2 days
```

Result:

```text
pages:                      9448
metricsRealtime total:      9,673,954
metricsRealtime eligible:   9,530,384
oldest_remaining_timestamp: 1777733699259
oldest_remaining_iso:       2026-05-02T14:54:59Z
```

Interpretation: nearly all `metricsRealtime` rows are eligible under the 2-day retention cutoff. The backlog is severe enough that app-level cleanup is operationally important, but the first canary must remain tiny and bounded (`maxRuns=1`, small batch, env gate on only for the trigger window).

Row-size sanity check: the `documents` heap snapshot implies an average on the order of 550 B per live row (`24.4 GB / 44.0M rows`), before index/WAL amplification. The runbook's worked example (`~200 B/row`) should be treated as a floor. A first canary of 500 rows may be closer to about 1 MB of WAL before background noise, not 300 KB, and the tight-window Phase 4 WAL gate should use fresh measurements.

## Non-Phase-1 Tables

Current exact counts for `metricsDaily` and `vkApiLimits` were not re-run during this preflight to avoid another heavy scan. Use the existing storage report as context only:

```text
metricsDaily:  1,434,396
vkApiLimits:     925,350
```

Phase 7 and Phase 8 must recapture their own current numeric calibration immediately before those phases.

## Phase 1 Implications

- Implement `manualMassCleanupV2` / trigger flow for `metricsRealtime` only.
- Keep the old `manualMassCleanup` no-op.
- Use a V2-specific heartbeat / run-state name (e.g. `cleanup-realtime-metrics-v2`). Reusing the V1 name `cleanup-realtime-metrics` would match the stale `running` row from `2026-05-04T18:00:00.793Z` (see Heartbeat Snapshot) and silently skip cleanup.
- Add `METRICS_REALTIME_CLEANUP_V2_ENABLED`, default-off.
- Use persistent run state; args alone are not sufficient.
- Use one cleanup worker slot at a time.
- Do not enable the cron in the Phase 1 implementation commit.
- Before the first manual canary, recapture:
  - `/version`
  - core heartbeats
  - `pg_wal`
  - disk headroom
  - backend stdout rollback patterns
  - eligible count / oldest remaining timestamp
  - baseline WAL rate without cleanup if the previous WAL value is still elevated or drifting

## Decision

Preflight is usable for Phase 1 code design and implementation planning.

It is not a clean canary-go by itself because `pg_wal` changed materially during the long read-only count. Canary execution requires a fresh tight-window gate immediately before trigger, and the runbook hard stops should be applied literally.

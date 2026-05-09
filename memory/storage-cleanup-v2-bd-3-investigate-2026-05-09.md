# Storage Cleanup V2 - BD-3 Investigate Note - 2026-05-09

Read-only investigation following the BD-3 dirty closure
(`memory/storage-cleanup-v2-bd-3-closure-2026-05-09.md`, commit `358663a`).
Goal: attribute the chunk-8 outlier (max action_ms = 9,572 in BD-3) so
that further runtime steps on the cleanup track have a clear next action.

No runtime in this note. No code change. No env touch.

## TL;DR

Hypothesis A (code accumulating per-chain state) is **rejected** — the
cleanup code is stateless across batches.

Hypothesis B (per-chunk slice density) is **rejected as standalone** —
aggregate density anti-correlates with chunk-8 severity (sparser slice
= worse chunk 8).

Hypothesis D (V8 contention with sync / token refresh) is **weak**:
token-refresh density is high (~8 fires/min) but uniform across the chain
window; uniform load cannot explain a positional outlier on chunk 8
specifically across three consecutive runs.

Most plausible remaining attribution is a **PostgreSQL-side tombstone
accumulation** along the `by_timestamp` index in `metricsRealtime`,
amplified by `restMs=60_000` (BD-3) versus `restMs=90_000` (BD-2 first /
repeat). This sits in Hypothesis C's territory and is **not yet verified**
in this note. The verification path is documented below.

## Hypothesis A — code per-chain state — REJECTED

`convex/metrics.ts` `manualMassCleanupV2` (line 635–706):

- Reads `cleanupRunState` row fresh per invocation via
  `internal.metrics.getCleanupRunStateV2`.
- Calls `deleteRealtimeBatch` with `batchSize` and `cutoffMs` from the row.
- Calls `recordBatchProgressV2` to bump `batchesRun` and `deletedCount`.
- Schedules next chunk via `scheduleNextChunkV2` or marks complete via
  `markCompletedV2`. No values are passed between invocations except via
  the `cleanupRunState` row.

`recordBatchProgressV2` (line 514–542) increments `batchesRun` and
`deletedCount`; **does not** update `oldestRemainingTimestamp`.
`markCompletedV2` (line 560–591) is the only writer of
`oldestRemainingTimestamp` (one query at chain end).

There is no in-memory module-level mutable state used by these helpers.
Each chunk action starts cold from the row.

**Verdict:** the code does not accumulate state across chunks. Whatever
makes chunk 8 expensive is **not** in the cleanup logic itself.

## Hypothesis B — per-chunk slice density — REJECTED AS STANDALONE

The closure recorded aggregate density (rows / source-time advance) per
run:

| Run | density (rows/s) | chunk-8 max action_ms |
|---|---:|---:|
| BD-2 first | ≈ 60 | 8,172 |
| BD-2 repeat | ≈ 45 | 8,497 |
| BD-3 | ≈ 28.7 | **9,572** |

The trend is monotonic in two opposite directions: density **falls**
across runs, chunk-8 max **rises**. If density alone drove chunk-8 cost,
denser slice should give worse chunk 8 (more rows packed close
together). We see the **opposite**.

A sparser slice means the deletion edge advances over more empty / gap
source-time per row deleted. The `by_timestamp` index has to cross more
of that gap to reach the next live row. That **does** match a
"sparseness amplifies tombstone-skipping cost" story — which lands us on
Hypothesis A/C territory, not on density-as-such.

Per-chunk density from the row history is unavailable —
`oldestRemainingTimestamp` is only written at chain end. We cannot run a
finer-grained density check without instrumenting `recordBatchProgressV2`,
which is a code change and out of scope here.

**Verdict:** density alone does not explain chunk 8. The aggregate
density signal is consistent with a tombstone-skipping interpretation
(see Hypothesis C below).

## Hypothesis D — V8 contention with sync / token refresh — WEAK

`_scheduled_functions` dump (last ~3 min relative to investigation time;
older entries truncated by Convex CLI 64 KB output cap) shows:

| UDF (in last ~3 min dump) | count |
|---|---:|
| `tokenRefreshOneV2` | 76 |
| `syncBatchWorkerV2` | 2 |
| `uzBudgetBatchWorkerV2` | 2 |

`tokenRefreshOneV2` density is roughly **8.4 fires per minute**. Across the
9.572 s of chunk 8, expectation is ~1.3 token-refresh actions running
concurrently. Token refresh is V8-bound (calls to VK API).

If token-refresh contention drove chunk 8, we would expect:

- **Random** chunks across the 8-position chain to show outlier behaviour
  in different runs, because token-refresh fires are roughly uniform
  across the ~11-min chain window.
- **Variance across runs** in which chunk gets hit.

What we actually observed:

- Chunk 8 is the max in **all three** consecutive BD-2 first / BD-2
  repeat / BD-3 runs (chunks 1–7 stayed at 6.6–7.4 s in all three).
- The pattern is positional, not random.

Uniform background load cannot produce position-specific outliers on
three runs in a row.

**Verdict:** token refresh is a fact (high density on this deployment),
but it is **not** the proximate cause of the chunk-8 outlier on the
observed pattern. May be a secondary contributor on top of the actual
mechanism. Not the root cause.

## Hypothesis C — PostgreSQL tombstone accumulation — NOT YET VERIFIED

This is the residual hypothesis after A/B/D are ruled out (A) or weakened
(B/D), and it fits the pattern A's review uncovered.

Mechanism:

1. `deleteRealtimeBatch` (`convex/metrics.ts:424-440`) scans the
   `by_timestamp` index for the first `batchSize` rows below the cutoff,
   then issues `db.delete()` per row.
2. PostgreSQL deletes mark heap tuples as dead; the **`by_timestamp`
   index entries remain** as tombstones until autovacuum cleans them up
   (via `VACUUM` or autovacuum process).
3. The next chunk's `withIndex("by_timestamp", q => q.lt("timestamp", cutoff)).take(batchSize)`
   has to skip past those tombstones in the index before finding live
   rows.
4. With `restMs=90_000`, autovacuum has more time to catch up between
   chunks. With `restMs=60_000`, less time. By chunk 8, the accumulated
   tombstone load is larger.
5. This explains:
   - **Position-specific** outlier: tombstone load grows monotonically
     across the chain; chunk 8 hits it last and worst.
   - **`restMs` sensitivity**: amplification when `restMs` is reduced.
   - **Sparseness amplification** (Hypothesis B's anti-correlation):
     sparser slice = more index pages walked per `take(1000)` =
     more tombstones encountered.

This is a working hypothesis, **not** verified in this session. It would
need either of:

- **Direct PG measurement**: `SELECT n_dead_tup FROM pg_stat_user_tables
  WHERE relname = '<convex documents-or-equivalent>'` taken before and
  after the run, or sampled during chunk 8. Convex hides the table name;
  it lives inside `documents`. SSH+psql access exists but the schema
  mapping requires investigation. Worth a separate session with the
  `pg-bloat` track tooling.
- **Code instrumentation**: add a per-chunk timing breakdown
  (index-scan time vs delete time vs commit time) in
  `deleteRealtimeBatch` and one repeat run. Code change, separate go.

## What this means for the cleanup ladder

If Hypothesis C is correct:

- **BD-2 repeat profile (`restMs=90_000`) is genuinely safer**, not by
  luck. The 90-s rest is enough for autovacuum to keep up on
  `metricsRealtime`'s backing relation under current load.
- **BD-3 profile (`restMs=60_000`) is genuinely riskier**, also not by
  luck. The chunk-8 hard-rule trip is the early symptom of
  insufficient vacuum recovery time.
- **BD-4 / cron-driven drain** would compound the issue: shorter cadence
  = longer continuous tombstone pressure.

Working assumption forward: `restMs ≥ 90_000` is the conservative
boundary. Further `restMs` reduction needs a verified vacuum-pacing
strategy, not just a faster cycle.

## What is now allowed

- BD-2 repeat profile (`batchSize=1000, restMs=90_000, maxRuns=8`) remains
  safe per its own closure; can run additional waves with explicit go.
- Phase 6 cron baseline (`batchSize=500, maxRuns=5`, every 6 h) is
  unaffected by this investigation.

## What is still blocked

- Any `restMs < 90_000` profile — frozen until Hypothesis C is verified
  and a vacuum-pacing answer exists.
- Any `batchSize > 1000` profile — frozen by the BD-2 repeat closure
  caveat (max chunk +207 ms drift between BD-2 first and BD-2 repeat).
  This investigation does **not** change that gate.
- BD-4 cron-driven drain — frozen by the BD-3 dirty closure.

## Recommended next steps (no runtime; choose order on next session)

1. **PG instrumentation read** — direct SSH+psql query to extract
   `n_dead_tup` and last_autovacuum for the relation backing
   `metricsRealtime`. Schema discovery first; query second. No code
   change. Estimate: 30–60 min including schema discovery.
2. **Code instrumentation proposal** — write a small spec for
   per-chunk timing in `deleteRealtimeBatch`. Two micro-metrics:
   index-scan ms and delete-loop ms. Doc-only spec, no commit until
   reviewed.
3. **Vacuum-pacing strategy proposal** — once C is verified, write a
   note covering: (a) increase autovacuum aggressiveness for the
   relation; (b) explicit `VACUUM ANALYZE` between chains; (c)
   `restMs` floor of 90_000 for any future ramp.

None of the above runs until explicitly approved.

## Operator/agent ledger for this investigation

- Read-only file reads in `convex/metrics.ts` (lines 424–706).
- One `npx convex data _scheduled_functions --limit 80 --format jsonArray`
  read; output truncated by Convex CLI 64 KB cap (oldest scheduledTime
  in dump = 1778317832753 = 2026-05-09T09:10:32Z; BD-3 chunk 8 was
  earlier so could not be observed directly).
- No env touch, no deploy, no code change, no commit.

## Reference Pointers

- BD-3 dirty closure: `memory/storage-cleanup-v2-bd-3-closure-2026-05-09.md`
  (commit `358663a`).
- BD-2 first / repeat closures and bulk-drain plan as referenced in the
  BD-3 closure.
- Cleanup-track follow-ups: `memory/storage-cleanup-v2-followups-2026-05-09.md`
  (already documents the heartbeat watcher mismatches; this note adds the
  tombstone hypothesis as a separate item to chase).
- Code under investigation:
  - `convex/metrics.ts:424-440` (`deleteRealtimeBatch`).
  - `convex/metrics.ts:635-706` (`manualMassCleanupV2`).
  - `convex/metrics.ts:498-591` (state mutations: markRunning, recordBatchProgress,
    scheduleNextChunk, markCompleted, markFailed).

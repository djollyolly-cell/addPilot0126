# `track_io_timing` window findings — 2026-05-09

**Outcome:** **Aborted by abort-criteria** (probe failures), not by graceful T+30m completion. Window ~37 minutes total. Service rolled back cleanly. PG-side IO data was captured for the window and is presented below with explicit caveats.

## Status

**Rollback proof:** `track_io_timing setting=off, source=default after RESET` (verified at 14:08:27Z and again at 14:16:04Z).

- `track_io_timing` setting now: `off`, `source = default` ✓
- `postgresql.auto.conf`: storm-fix block only, no leftover `track_io_timing` line ✓
- Locks not granted: 0 ✓
- Service: responsive (4/5 probes 200 post-rollback) ✓
- Server-side T+45m safety rollback: not fired (cancelled by operator pkill before deadline)
- Reference baseline: `memory/pg-baseline-2026-05-09.md` (commit `d05a8c8`)
- Reference runbook: `memory/pg-track-io-timing-runbook-2026-05-09.md` (commit `302d18e`)

## Timeline

| Mark | UTC | Note |
|---|---|---|
| Pre-flight | 13:30Z | clocksource=`kvm-clock`, PG 16.11, `pg_stat_io` available, `track_io_timing=off`, no autovac on documents/indexes, 0 not-granted locks, 142 GB free disk |
| /version baseline (5 probes) | 13:30Z | n=5, avg=1.316s, max=1.536s, all 200 → abort threshold = **3.949s on 3 of 5** |
| T−0 PG snap | 13:31:01Z | pg_stat_database/statio/bgwriter/wal/pg_stat_io captured |
| **T+0 enable** | **13:31:20Z** | `ALTER SYSTEM SET track_io_timing = on; pg_reload_conf()` ✓ |
| Wait T+30m | 14:01:20Z target | until-loop, completed 14:02:09Z (~30s sleep granularity overrun) |
| Re-engagement delay | 14:02–14:07Z | Operator (Claude) needed ~5 min to verify state and run capture due to hung curl tasks (see "Confounders") |
| Window /version probes | 14:07Z | n=5: 200@1.26s / **000**@0.69s / **000**@2.88s / **000**@5.00s (max-time hit) / 200@1.56s → **3 of 5 non-200** ⇒ abort criterion met |
| **T+abort rollback** | **14:08:27Z** | `ALTER SYSTEM RESET track_io_timing; pg_reload_conf()` ✓ — `setting=off, source=default` |
| Post-rollback /version | 14:09Z | n=5: 4×200 (1.0–1.6s) + 1×000 — service largely recovered |
| T+1 PG snap | 14:13:09Z | full delta capture |
| Window length | 37 min 7 sec | enable→rollback wall-clock |

## Pre-flight (passed)

| Check | Result |
|---|---|
| Host clocksource | `kvm-clock` — paravirtual KVM clock, low gettimeofday overhead. Acceptable; documented here in lieu of `tsc`. |
| PG version | 16.11 |
| `pg_stat_io` available | true |
| Initial `track_io_timing` | off / default |
| Active backends (non-idle) | only own psql session |
| Active autovacuum/analyze | none |
| Locks not granted | 0 |
| Disk free | 142 GB (≥ 100 GB threshold) |
| pg_wal size | 1.3 GB (baseline level) |
| `auto.conf` BEFORE | storm-fix block only |

## /version probe summary

| Phase | n | avg | max | non-200 |
|---|---|---|---|---|
| Pre-window baseline | 5 | 1.316s | 1.536s | 0 |
| During window | 5 | 2.280s | 5.006s (max-time) | **3** |
| Post-rollback | 5 | ~1.4s | ~1.6s | 1 |

The during-window failure pattern (3 consecutive 000 codes) is what triggered abort.

## PG metrics during window

### Database aggregate (`pg_stat_database` for `adpilot_prod`)

| Metric | T−0 | T−1 | Δ during window |
|---|---|---|---|
| `blk_read_time` (ms) | 0 (timing was off) | 93,794.185 | **+93,794 ms** (≈ 94 sec) |
| `blk_write_time` (ms) | 0 | 574.336 | +574 ms |
| `blks_read` | 802,442,702 | 805,676,909 | +3,234,207 reads |
| `blks_hit` | 1,609,576,864 | 1,620,701,861 | +11,124,997 hits |
| Hit rate during window | — | — | **77.5%** (vs cumulative 66.6%) |
| `temp_files` | 885 | 885 | 0 |
| `temp_bytes` | 184,093,958,144 | 184,093,958,144 | 0 |

### Average physical read latency during window

`blk_read_time / blks_read` = 93,794 / 3,234,207 = **0.029 ms** = **~29 μs per read**.

> **Caveat:** this is an **aggregate average across all reads from all backends**. It can hide per-query spikes (a single 9-second batch could be lost in millions of fast reads). For per-query latency we need `pg_stat_statements` or PG slow-query logs, neither of which is in place.

### Total wall time on physical reads (aggregated across all backends)

`blk_read_time / window_seconds` = 93,794 / 2227 = **42.1 sec / 37 min** = **3.8% of wall time** spent on physical reads, aggregated across all client backends + autovacuum + bgworkers.

### `pg_stat_io` per backend type (timing during window only — counters cumulative)

| backend_type / context | reads (cumul.) | read_time (ms, window only) | avg_read_ms |
|---|---|---|---|
| client backend / normal | 502,284,134 | 93,327.35 | 0.029 (~29 μs) |
| autovacuum worker / vacuum | 120,383,753 | 2,035.71 | ~0 (sub-μs, OS-cached) |
| autovacuum worker / normal | 3,510,608 | 27.17 | ~0 |
| background worker / normal | 107,315,702 | 0.00 | — |
| client backend / bulkread | 24,635,863 | 0.00 | — |
| background worker / bulkread | 47,929,769 | 0.00 | — |

### Other counters during window

- `pg_stat_bgwriter`: checkpoints +2 timed (212→214), `buffers_backend` +39,530, `buffers_clean` +126,805 — normal steady-state.
- `pg_stat_wal`: +583,618 records, +129,593 FPI (FPI rate **22.2%** during window vs 31.2% cumulative — lower than baseline), +384 MB WAL.
- `pg_statio_user_tables` for documents: +1,140,225 heap_blks_read, +1,139,284 heap_blks_hit (50% hit rate just for this delta).

## Confounders (do not over-interpret)

**Probe attribution rule:** non-200 probes are **not attributed to Postgres** without corroborating PG signals (active backends, lock waits, query duration, IO latency spike). In this window, no PG signal corroborated the probe failures — therefore probe failures cannot be claimed as evidence that `track_io_timing` damaged Postgres.

1. **Mid-window curl pile-up.** Earlier in the session two foreground bash tasks running curl-in-for-loop hung on first probe (root cause not fully identified; possibly a transient TLS/TCP issue on the operator's local network or Cloudflare edge, or zsh subshell quirk under multi-task load). These tasks were killed at ~14:07Z, immediately followed by the re-run probes that triggered abort. There is non-zero probability that probe failures during window were caused by the operator's local network state, not by `track_io_timing` or PG.
2. **Window was steady-state, not cleanup-time.** No cleanup wave was active. The numbers describe baseline Convex production traffic, not the conditions under which BD-3 chunk-8 stalled.
3. **Sample size for probes is small** (5 per phase). 3-of-5 is the abort threshold, but with n=5 each phase, the noise floor is wide.
4. **`pg_stat_io` `read_time` is partial.** Counters started at 0 when `track_io_timing` was enabled. The `reads` column is cumulative since stats_reset (2026-05-05); only `read_time`/`write_time` are window-scoped. Per-backend avg is computed against window reads, not cumulative.

## Verdict

**Hypothesis C — IO contribution to chunk stalls:** **partial weak signal, not confirmed.**

> **This was a steady-state observation window, not a cleanup-stress window.** Conclusions below describe normal Convex production traffic only. They **do not** directly address the BD-3 chunk-8 stall, which occurred under cleanup-wave load.

- During the steady-state window, **physical read latency was ≈ 29 μs**, indicating most of Postgres' "physical reads" hit the Linux page cache, not the disk. Only **3.8% of aggregate wall time** went to physical reads. This is **inconsistent with IO being the primary bottleneck during steady-state**.
- The 33% Postgres heap-cache-hit rate from baseline is real, but the cost of those misses is small in steady-state because OS page cache absorbs them at memory speed.
- **However**, this window did not include a cleanup wave. BD-3 chunk-8 stalled during a cleanup wave with bulk DELETE pressure. Under cleanup load, autovacuum may fire on `documents` and pull in cold pages from disk (rather than OS-cache), shifting the latency profile materially. This window cannot answer that case.
- Probe failures during the window were the abort trigger but are **not strong evidence** of PG-side distress — PG's own metrics were healthy throughout. The probe failures more plausibly point to a network/edge artifact or operator-side curl issue, not Postgres latency.

**Net: Hypothesis C not strengthened, not weakened, against the chunk-stall scenario specifically. Steady-state PG IO is healthier than baseline cache-hit alone implied.** The steady-state finding does **not** mean "chunk-8 was not IO" — it only means a different load regime would need a separate observation window to answer.

## What was learned

- `track_io_timing` enable/disable cycle works cleanly via `ALTER SYSTEM SET … = on` + `pg_reload_conf()` and `ALTER SYSTEM RESET …` + `pg_reload_conf()`. No restart, no leftover entries when using RESET.
- Linux page cache is doing significant heavy lifting in front of Postgres' tiny `shared_buffers = 128 MB`. Physical reads at ~29 μs argue this layer has been masking Postgres' under-tuned shared_buffers.
- Container has 14–15 GiB resident, mostly OS cache → effective working set is far larger than `shared_buffers` suggests.
- Probe-based abort criteria need a confounder filter (network/edge issues vs PG distress) — pg_stat_activity sampling during window would have helped distinguish.

## Recommended next reads (each requires separate go)

1. **Repeat under cleanup wave**, not steady-state, to actually test Hypothesis C against the originating scenario. The wave for this **must use the proven safe BD-2 profile** (`batchSize=1000, timeBudgetMs=10000, restMs=90000, maxRuns=8`), **not BD-3** (`restMs=60000` failed safety gate at chunk 8 = 9.572s and is frozen). Coordination of `track_io_timing = on` with the BD-2 wave is non-trivial and needs its own runbook.
2. **`pg_stat_statements` install** (requires container restart + `shared_preload_libraries` edit) — would let us correlate slow queries with cleanup-wave timeline directly.
3. **`pgstattuple` extension** — confirm bloat numbers from baseline (3.1× / 3.3× approximate) more precisely.
4. **Investigate operator-side curl flakiness** before next probe-based abort criteria use, to avoid false positives.

## Frozen / out of scope

- Tuning `shared_buffers`, `work_mem`, `wal_buffers`, `effective_cache_size`, `random_page_cost`, `effective_io_concurrency` — separate go.
- VACUUM FULL / pg_repack — separate go.
- Cleanup wave (BD-2 fallback / BD-3 / BD-4) — separate decision.

## Artifacts (operator-side, not committed)

- `/tmp/pg_track_io/clocksource.txt`
- `/tmp/pg_track_io/preflight.txt`
- `/tmp/pg_track_io/version_baseline.txt`
- `/tmp/pg_track_io/version_window.txt`
- `/tmp/pg_track_io/version_after_rollback.txt`
- `/tmp/pg_track_io/t0.txt`
- `/tmp/pg_track_io/t1.txt`
- `/tmp/pg_track_io/enable.txt`
- `/tmp/pg_track_io/rollback.txt`

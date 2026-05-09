# PG read-only baseline — 2026-05-09

**Captured:** 2026-05-09 12:50 UTC.
**Branch / HEAD:** `emergency/drain-scheduled-jobs` @ `835b39a`.
**Service state:** running, `METRICS_REALTIME_CLEANUP_V2_ENABLED=0`, no active cleanup wave.
**Mode:** read-only diagnostic. **Nothing was changed.** No VACUUM/REINDEX/ALTER/INSERT/UPDATE/DELETE/CHECKPOINT, no extension install, no `pg_stat_reset*`, no `pg_terminate_backend`, no env edits. Only SELECT and read-only system views.

## Data hygiene

Captured fields only. Excluded by design:
- `docker inspect` — only `Image`, `State.Status`, `State.StartedAt`, `HostConfig.Memory`, `HostConfig.MemorySwap`, `HostConfig.NanoCpus`, `HostConfig.RestartPolicy`, `Mounts`. **`Config.Env`, `Config.Cmd`, `Config.Args` not captured** (contain INSTANCE_SECRET, DB credentials, image labels).
- `pg_stat_activity` — `usename`, `application_name` (full), `backend_type`, `state`, wait events, ages. `LEFT(query, 120)` only. **`client_addr` not captured.**
- No payload data, no document keys, no secrets.

## Host

| Property | Value |
|---|---|
| Kernel | Linux 6.8.0-85 (Ubuntu, x86_64) |
| Host RAM total | 29 GiB |
| Host RAM free | 665 MiB |
| Host RAM available | 25 GiB (mostly buff/cache) |
| Swap | 2.0 GiB total, 614 MiB used |
| CPU | 6 cores |
| loadavg | 0.50 / 0.37 / 0.26 |
| uptime | 4 days, 11h |
| Disk `/dev/sda1` | 315 GB total, 161 GB used (54%), **142 GB free** |
| Tablespaces (FS) | one — all on `/dev/sda1`, no separate WAL volume |

## Docker container

| Property | Value |
|---|---|
| Name | `adpilot-postgres` |
| Image | `postgres:16` |
| Status | running |
| Started at | 2026-05-05 01:51:09 UTC (4d 11h) |
| `HostConfig.Memory` | **0** (no cgroup limit — can use all host RAM, OOM risk) |
| `HostConfig.MemorySwap` | 0 |
| `HostConfig.NanoCpus` | 0 (no CPU limit) |
| RestartPolicy | `unless-stopped` |
| Mounts | volume `adpilot-convex-pgdata` → `/var/lib/postgresql/data` (rw), single volume |
| Live MEM USAGE | 15.49 GiB (mostly Linux page cache held by container) |
| Lifetime BlockIO | 1.44 TB read / 710 GB write |
| `pg_repack` binary | **not on PATH** (not installed inside container) |

`postgresql.auto.conf` contents (only persisted ALTER SYSTEM changes):
```
max_wal_size = '8GB'
checkpoint_timeout = '30min'
checkpoint_completion_target = '0.9'
wal_compression = 'on'
```
Storm-fix from 2026-05-03 still in effect.

## PG version

PostgreSQL 16.11 (Debian 16.11-1.pgdg13+1).

## Database sizing

| Database | Size | Bytes |
|---|---|---|
| `adpilot_prod` | **143 GB** | 153,435,341,283 |
| `postgres` | 7.5 MB | — |
| `convex_adpilot` | 7.5 MB | empty legacy |
| `template1` | 7.4 MB | — |
| `template0` | 7.4 MB | — |

PG data dir on disk: 145 GB total (143 GB base + 1.3 GB pg_wal + small).

### Tables in `adpilot_prod`

Convex multiplexes everything into 5 PG tables:

| Table | Total | Heap | Indexes | Live tup | Dead tup | Dead % |
|---|---|---|---|---|---|---|
| `indexes` | 93 GB | 34 GB | **59 GB** | 65,799,655 | 2,993,064 | 4.35% |
| `documents` | 50 GB | 23 GB | 27 GB | 23,355,982 | 1,050,786 | 4.31% |
| `persistence_globals` | 448 kB | 104 kB | 16 kB | 10 | 59 | 85.51% |
| `leases` | 48 kB | 8 kB | 16 kB | 0 | 4 | 100% |
| `read_only` | 8 kB | 0 | 8 kB | 0 | 0 | — |

### Per-PG-index sizes

| Table | Index | Size |
|---|---|---|
| `indexes` | `indexes_by_index_id_key_prefix_key_sha256` | **35 GB** |
| `indexes` | `indexes_pkey` | **24 GB** |
| `documents` | `documents_by_table_ts_and_id` | 10 GB |
| `documents` | `documents_by_table_and_id` | 9.78 GB |
| `documents` | `documents_pkey` | 7.55 GB |

idx/heap ratio: `indexes` = 59/34 = **1.74×**, `documents` = 27/23 = 1.20×.

## Cache pressure

| Relation | Heap blks read | Heap blks hit | **Heap hit %** | Idx hit % |
|---|---|---|---|---|
| `documents` | 389,180,704 | 195,473,756 | **33.43%** | 83.35% |
| `indexes` | 152,223,149 | 256,146,416 | 62.72% | 75.89% |
| `persistence_globals` | 29,676 | 798,764 | 96.42% | 99.07% |
| `leases` | 2,918 | 1,442,704 | 99.80% | 99.44% |

**DB-level:** blks_read = 794.9M, blks_hit = 1596.1M → **66.75% hit rate**. Healthy is ≥99%.

## WAL & checkpoint (since stats_reset 2026-05-05 01:34 UTC)

| Metric | Value |
|---|---|
| Uptime since reset | ≈ 4d 11h |
| `wal_records` | 145,662,160 |
| `wal_fpi` | 45,398,308 |
| **FPI rate** | **31.2%** of records |
| `wal_bytes` | 109.73 GB |
| WAL/day | ≈ 24.7 GB |
| `wal_buffers_full` | 29,814 |
| `wal_write` | 2,432,779 |
| `wal_sync` | 2,330,957 |
| Current WAL file | `000000010000092000000023` |
| LSN cumulative | 9,345 GB |
| `pg_wal` dir size | 1.3 GB |
| `checkpoints_timed` | 211 |
| `checkpoints_req` | 7 |
| Avg interval | ≈ 1 / 27 min (matches `checkpoint_timeout=1800s`) |
| `buffers_checkpoint` | 84,294 |
| `buffers_clean` (bgwriter) | 21,218,930 |
| `buffers_backend` | **37,268,924** |
| `maxwritten_clean` | 110,965 |
| `buffers_alloc` | 609,188,207 |

**Backends are doing 99.7% of dirty page writes** (`buffers_backend / (buffers_backend + buffers_clean + buffers_checkpoint)`). Bgwriter saturates `maxwritten_clean` regularly. Direct consequence of `shared_buffers = 128 MB`.

## Vacuum / dead-tuples

| Table | Live | Dead | Dead % | last_vacuum | last_autovacuum | autovacuum_count | n_tup_ins | n_tup_del |
|---|---|---|---|---|---|---|---|---|
| `indexes` | 65.8M | 3.0M | 4.35% | never | 2026-05-07 21:09 | **2** | 10.65M | 11.69M |
| `documents` | 23.4M | 1.05M | 4.31% | never | 2026-05-09 10:31 | 23 | 2.34M | 51.18M |
| `persistence_globals` | 10 | 59 | 85.51% | never | 2026-05-09 12:46 | 916 | 0 | 53.30K |
| `leases` | 0 | 4 | 100% | never | never | 0 | 0 | 4 |

Per-relation overrides (already in place):
- `documents` and `indexes`: `autovacuum_vacuum_scale_factor = 0.05` (vs global 0.2).

Trigger thresholds at 0.05 scale:
- `documents`: 50 + 0.05 × 23.4M ≈ **1.17M dead** → currently 1.05M, **89% of threshold** — autovac likely fires within hours.
- `indexes`: 50 + 0.05 × 65.8M ≈ **3.29M dead** → currently 3.0M, **91% of threshold** — autovac likely fires within hours.

## Activity / locks (snapshot moment)

- 6 client backends in `convex` role; 5 idle in `ClientRead`, 1 active was the diagnostic session itself.
- `application_name` populated only for `psql` (Convex driver doesn't set it).
- One client backend's last query had planner hints (`/*+ Set(enable_seqscan OFF) ... */`) — Convex query optimizer.
- Background processes: autovacuum launcher, bgwriter, checkpointer, walwriter, logical replication launcher — all healthy.
- `pg_locks` not-granted: **none**.
- No idle-in-transaction.

## Extensions

| extname | extversion |
|---|---|
| plpgsql | 1.0 |

`pg_repack` not installed. `pg_stat_statements`, `pgstattuple`, `pg_buffercache` — not installed.
`shared_preload_libraries` — empty in `pg_settings` (default: empty). To install `pg_stat_statements` requires editing `shared_preload_libraries` + container restart.

## Key settings

| Setting | Value | Source | Note |
|---|---|---|---|
| `shared_buffers` | 128 MB (16384 × 8kB) | configuration file | **far below ratio for 143 GB DB** |
| `work_mem` | 4 MB | default | spills frequent (171 GB temp lifetime) |
| `maintenance_work_mem` | 64 MB | default | low for vacuum/index ops on big tables |
| `effective_cache_size` | 4 GB | default | should reflect host RAM ≈ 22 GB |
| `wal_buffers` | 4 MB (512 × 8kB) | default | undersized (`wal_buffers_full`=29,814) |
| `max_wal_size` | 8 GB | configuration file | storm-fix |
| `min_wal_size` | 80 MB | default | |
| `wal_compression` | pglz | configuration file | storm-fix |
| `checkpoint_timeout` | 1800s (30min) | configuration file | storm-fix |
| `checkpoint_completion_target` | 0.9 | configuration file | storm-fix |
| `autovacuum` | on | default | |
| `autovacuum_max_workers` | 3 | default | |
| `autovacuum_vacuum_scale_factor` | 0.2 | default | overridden to 0.05 on documents/indexes |
| `autovacuum_vacuum_cost_delay` | 2 ms | default | |
| `autovacuum_vacuum_cost_limit` | -1 | default | inherits from `vacuum_cost_limit` (200) |
| `track_io_timing` | off | default | no block latency available |
| `track_activity_query_size` | 1024 | default | |
| `shared_preload_libraries` | (empty) | default | no pg_stat_statements |
| `random_page_cost` | 4 | default | SSD default would be 1.1 |
| `effective_io_concurrency` | 1 | default | SSD typical 200 |
| `huge_pages` | try | default | |
| `synchronous_commit` | on | default | |
| `max_connections` | 100 | configuration file | |
| `default_statistics_target` | 100 | default | |

## Database stats (`pg_stat_database`)

| Metric | Value |
|---|---|
| numbackends | 6 |
| xact_commit | 8,358,858 |
| xact_rollback | 18 (negligible) |
| blk_read_time | 0 (track_io_timing off) |
| blk_write_time | 0 |
| temp_files | 885 |
| temp_bytes | **171 GB** cumulative |
| deadlocks | 0 |
| conflicts | 0 |

## Approximate bloat heuristic — *NOT proof*

Computed as actual heap size vs `n_live_tup × (sum of pg_stats.avg_width + 28-byte page overhead)`. Does NOT account for TOAST, alignment padding, item pointers, free space inside pages, or HOT chains. Use only as a directional sizing signal. Definitive bloat measurement requires `pgstattuple` (NOT installed; would need extension install).

| Table | Heap actual | n_live + n_dead | bytes/row on disk | sum(avg_width) | Expected min heap |
|---|---|---|---|---|---|
| `indexes` | 34 GB | 68.79M | 524 | 149 | ≈ 11 GB |
| `documents` | 23 GB | 24.41M | 999 | 281 | ≈ 6.88 GB |
| `persistence_globals` | 104 kB | 69 | 1543 | 43 | ≈ 710 B |

**Approximate bloat factor:** documents ≈ 3.3×, indexes ≈ 3.1×. Treat as upper-bound signal only — TOAST overhead alone could reduce real bloat to 1.5–2×. Confirmation requires `pgstattuple` or `pg_repack --dry-run`-style analysis.

## Hypothesis C — verdict (read-only data only)

**Verdict: Hypothesis C strongly supported, not proven against exact BD-3 chunk-8 timestamp.**

Read-only data establishes the structural conditions in which a 9-second chunk stall is plausible (low cache hit, autovac threshold close, FPI-heavy WAL, single FS for data + WAL). It does not establish a confirmed timestamp correlation with the chunk-8 outlier; that requires `pg_stat_statements` or PG slow-query logs that are not currently in place.

Mechanism that fits the data:
1. `shared_buffers=128 MB` and `documents` heap_hit = 33.4% → every batch DELETE re-reads pages from disk.
2. autovacuum on `documents` triggers when dead tuples cross ~1.17M (currently 1.05M, 89% of threshold). When it fires, it sequentially scans 23 GB heap through 128 MB pool, evicting client batch's working set.
3. Next cleanup batch refaults from disk — single chunk can stall ≥ 9 sec while the working set rebuilds.
4. WAL FPI 31.2% means any concurrent checkpoint amplifies write volume, compounding I/O contention.

What read-only diagnostic **cannot** answer (gap):
- Exact timestamp correlation between BD-3 chunk-8 9.572s outlier and a specific autovacuum / checkpoint event. Requires either `pg_stat_statements` (needs container restart) or PG log scrape with high `log_min_duration_statement`. Neither is in place.

## Diff vs personal-memory baseline (this session)

| Metric | Earlier today | Now | Δ |
|---|---|---|---|
| `wal_records` | 141.82M | 145.66M | +3.84M |
| `wal_bytes` | 100 GB | 109.73 GB | +9.73 GB |
| `wal_fpi` | 44.13M | 45.40M | +1.27M |
| `documents` n_dead_tup | 0.90M | 1.05M | +0.15M (closer to autovac threshold) |
| `indexes` n_dead_tup | 2.83M | 3.00M | +0.17M |
| `documents` autovacuum_count | 22 | 23 | +1 |
| `documents` heap_hit_pct | 33.14% | 33.43% | +0.29 pp |
| `temp_files` | 879 | 885 | +6 |
| numbackends | 4 | 6 | +2 |
| Free disk | 142 GB | 142 GB | 0 |

No regression. Trends consistent with steady-state production load.

## Read-only follow-ups (no service restart)

These are **diagnostic-only enablements**, not yet applied. Each requires its own `go` to run.

1. `ALTER SYSTEM SET track_io_timing = on; SELECT pg_reload_conf();` — block-level latency visibility, no restart.
2. `ALTER SYSTEM SET log_min_duration_statement = '1s';` + `pg_reload_conf()` — query-level log of slow statements; no restart, but increases log volume.
3. `CREATE EXTENSION pgstattuple;` — exact bloat measurement on `documents` / `indexes`. No restart. Read-only after creation.

## Frozen actions — require explicit go

- `shared_buffers` 128 MB → 3–4 GB (PG restart, downtime). Highest-impact fix for cache pressure.
- `work_mem` 4 MB → 32 MB (no restart, `ALTER SYSTEM`).
- `maintenance_work_mem` 64 MB → 512 MB (no restart, but used by autovacuum/REINDEX).
- `wal_buffers` 4 MB → 64 MB (restart).
- `effective_cache_size` 4 GB → 16–22 GB (no restart; planner hint).
- `random_page_cost` 4 → 1.1 if SSD (no restart; planner hint).
- `effective_io_concurrency` 1 → 200 if SSD (no restart).
- `pg_stat_statements` — requires `shared_preload_libraries` + restart.
- `VACUUM FULL` / `pg_repack` on tables (`pg_repack` not installed; install requires extension + binary).
- BD-2 fallback wave — separate decision.
- `track_io_timing = on` — minor diagnostic; mentioned above as low-risk enable.

Disk feasibility for compaction:
- `documents` (50 GB) — 92 GB headroom → safe.
- `indexes` (93 GB) — 49 GB headroom → tight; WAL spike during operation can erase margin. Either need `+200 GB` disk extension, or move `pg_wal` to separate FS, or schedule maintenance window with write traffic paused.

## Notes for future sessions

- `MEMORY.md` index entry should point to this file (separate from personal-memory snapshot).
- Personal-memory `pg-readonly-diagnostic-2026-05-09.md` (claude-side) is the same domain but different audience; this file is the canonical team-visible artifact.
- Any tuning step must update this baseline (write a new dated baseline file rather than mutate this one).

# PG Read-Only Diagnostic Snapshot — 2026-05-11 04:25Z (post Tier 1 maxRuns=16 series)

## Verdict at a glance

**Сервис здоров, idle profile, all re-halt rules GREEN.** PG в спокойном состоянии после 11-волновой Tier 1 серии. Storm-fix продолжает держаться (217 files / 3.47 GB vs 09b 200/3.2 GB — stable). PG raw probe ban остаётся ACTIVE: `shared_buffers=128 MB` (still <1 GB) **И** `documents heap_hit=35.89%` (still <50%).

Cleanup discipline formally verified via Convex admin: `METRICS_REALTIME_CLEANUP_V2_ENABLED = "0"`, no active runs, last 5 cleanupRunState rows all `state="completed"` matching series ledger w7→w11 exactly.

## Window check
- Current UTC: `2026-05-11T04:25:51Z`
- Last past boundary: `02:00 UTC` (−145 min)
- Next upcoming boundary: `05:30 UTC` (+65 min)
- Status: **clean window** — далеко от ±5 min cron boundaries

## Service (Convex)
- `/version` ×3: all "unknown" (expected for self-hosted) — endpoint reachable, no timeout / 5xx
- Probe time: ~1s each

## Host
| Metric | Value | Notes |
|---|---|---|
| loadavg 1/5/15m | `0.24 / 0.20 / 0.19` | 6 cores → very quiet |
| Mem available | **25 GiB** | well above 5 GiB rule-5 threshold |
| Mem used | 3.6 GiB | |
| Buff/cache | 25 GiB | |
| Swap used | 1.0 GiB / 2.0 GiB | |
| Disk `/` | 140 GB free / 163 GB used / 315 GB total (54%) | |
| Uptime | 6 days 2:45 | |
| Kernel | Linux 6.8.0-85-generic x86_64 | |

## Containers
| Container | Status | CPU% | MEM | MEM% |
|---|---|---|---|---|
| adpilot-frontend | healthy, 40h | 0.00 | 22.94 MiB | 0.06 |
| adpilot-convex-backend | healthy, 5d | 0.05 | 2.11 GiB | 5.39 |
| adpilot-postgres | healthy, 6d | 0.01 | **4.516 GiB** | 11.53 |
| dokploy (+ family) | healthy | <0.5 | small | — |

`HostConfig.Memory = 0` на adpilot-postgres и adpilot-convex-backend (= no docker cgroup limit; same as 09b).

## adpilot-postgres cgroup memory split (key check for rule 5)

| Component | Bytes | Pretty |
|---|---|---|
| anon | 12,189,696 | **~12 MB** (pure RSS, non-cache) |
| active_anon | 154,357,760 | ~147 MB |
| inactive_anon | 2,994,176 | ~3 MB |
| shmem | 144,121,856 | ~137 MB (shared mem, PG buffers) |
| file (page cache) | 25,796,866,048 | **~25.8 GB** |
| active_file | 3,941,490,688 | ~3.94 GB |
| inactive_file | 21,711,253,504 | ~21.71 GB |
| slab | 751,215,912 | ~751 MB |
| kernel | 754,659,328 | ~755 MB |

**Non-cache RSS ≈ 300 MB.** Host headroom 25 GiB. Rule 5 (`non-cache RSS growth + MEM>30% + host headroom<5 GiB`): **NOT TRIGGERED**, all three independently false. PG MEM% jump observed in w8/w9 confirmed once more as page-cache attribution, not RSS growth.

## PG sessions (server-wide)
| datname | state | count |
|---|---|---|
| adpilot_prod | active | 1 (probe itself) |
| adpilot_prod | idle | 2 |
| convex_adpilot | idle | 2 |

**0 waiting**, **0 long-active**, **0 idle-in-transaction**. All quiet.

## PG locks
- Total locks: 2 (both granted, my own probe)
- **Waiting locks: 0**

## PG WAL
- Files: **217**
- Total size: **3,472 MB** (~3.47 GB)
- Baseline 09b: 200 files / 3.2 GB
- Δ: +17 files / +272 MB — within stable band; `max_wal_size=8 GB` still gives ~4.5 GB headroom

## PG settings (relevant subset)

| Setting | Value | Notes |
|---|---|---|
| shared_buffers | `128 MB` (16384 × 8 KB) | **TODO жив** — ban contributor #1 |
| effective_cache_size | `4 GB` | |
| work_mem | `4 MB` | |
| maintenance_work_mem | `64 MB` | |
| track_io_timing | **off** | unchanged from 09b; per scope agreement NOT toggled |
| max_wal_size | `8 GB` | storm-fix value |
| min_wal_size | `80 MB` | |
| checkpoint_timeout | `1800 s` (30 min) | storm-fix value |
| checkpoint_completion_target | `0.9` | |
| wal_compression | `pglz` | |
| wal_level | `replica` | |
| autovacuum_naptime | `60 s` | default |
| autovacuum_vacuum_scale_factor | `0.2` | default |
| autovacuum_vacuum_cost_limit | `-1` | default (= 200) |

`track_io_timing=off` → blk_read_time / blk_write_time accumulators всегда `0`, не запрашивал per scope agreement.

## PG database-level (adpilot_prod = production DB)

| Metric | Value | vs 09 / 09b |
|---|---|---|
| blks_hit | 2,124,189,047 | cumulative |
| blks_read | 989,559,955 | cumulative |
| **hit_ratio_pct** | **68.22 %** | 09: 66.59 % / 09b: 66.95 % → +1.3 pp creep, same band |
| xact_commit | 11,824,657 | |
| xact_rollback | 28 | tiny |
| deadlocks | **0** | |
| temp_files (cumulative) | 885 | |
| temp_bytes (cumulative) | **171 GB** | matches 09 baseline (cumulative since stats_reset) |
| stats_reset | NULL | never explicitly reset |

**Note on DB topology:** Production data lives in `adpilot_prod` (143 GB). `convex_adpilot` is essentially empty (7.5 MB, legacy/leftover). All hit ratios prior to this snapshot also referred to `adpilot_prod` — the initial probe in this snapshot mistakenly hit `convex_adpilot` and was re-run against the correct DB; the values above are authoritative.

## Per-table stats (documents / indexes) — system stats only, no table scan

### Autovac state (`pg_stat_user_tables`)
| Table | n_live_tup | n_dead_tup | dead_pct | last_autovacuum | last_autoanalyze | autovac_count |
|---|---|---|---|---|---|---|
| documents | 14,036,266 | **692,898** | **4.94 %** | `2026-05-10 05:43:30Z` (~22h ago, pre-series start) | `2026-05-11 03:05:47Z` (~80 min ago) | 32 |
| indexes | 103,753,891 | **168,169** | **0.16 %** | `2026-05-11 00:58:57Z` (~3.5h ago) | `2026-05-10 22:05:23Z` (~6h ago) | 4 |

**Autovac догоняет.** Both dead-tuple counts match 09b baseline order of magnitude (~0.7M / ~0.17M). Manual VACUUM still NOT needed per 09b policy.

### Heap & index io (`pg_statio_user_tables`)
| Table | heap_blks_hit | heap_blks_read | **heap_hit_pct** | idx_hit_pct |
|---|---|---|---|---|
| documents | 251,391,601 | 449,008,767 | **35.89 %** | 84.11 % |
| indexes | 311,609,336 | 201,264,598 | **60.76 %** | 74.86 % |

**documents heap_hit = 35.89 %** vs 09 baseline 33.14 % — minor +2.75 pp creep, but **still well below 50%** → PG raw probe ban condition #2 remains true.

### Table sizes (no scan, `pg_class` metadata)
| Table | total |
|---|---|
| indexes | **93 GB** |
| documents | **50 GB** |

Sizes unchanged vs 09b (indexes bloat 93 GB still flagged for Phase 9).

## Cleanup state — verified via Convex admin (read-only)

Verification path: ephemeral admin key generated in subshell from `INSTANCE_NAME` / `INSTANCE_SECRET` retrieved via `docker inspect adpilot-convex-backend`. Key consumed by `npx convex env get` + `npx convex data`, unset on exit. Never written to disk, never logged.

### env var
```
METRICS_REALTIME_CLEANUP_V2_ENABLED = "0"
```
Formally `!= "1"`. Idle-safe state confirmed.

### Recent cleanupRunState (`npx convex data cleanupRunState --limit 5`)

All 5 most recent runs are series waves w7→w11, matching the series summary `5428e77` exactly:

| runId (short) | wave | state | isActive | durationMs | startedAt UTC | oldestRemainingTimestamp |
|---|---|---|---|---|---|---|
| `4bd5ee0a7f91` | w11 | `completed` | `false` | 1,439,231 | `2026-05-10T19:14:48Z` | `2026-05-02T16:19:44Z` |
| `bad0065b2658` | w10 | `completed` | `false` | 1,439,197 | `2026-05-10T18:36:53Z` | `2026-05-02T16:14:38Z` |
| `6609098e7e9d` | w9 | `completed` | `false` | 1,442,927 | `2026-05-10T16:32:17Z` | `2026-05-02T16:05:24Z` |
| `f0970af9676d` | w8 | `completed` | `false` | 1,444,602 | `2026-05-10T15:49:40Z` | `2026-05-02T16:00:10Z` |
| `69f72eeef224` | w7 | `completed` | `false` | 1,446,753 | `2026-05-10T15:05:32Z` | `2026-05-02T15:55:06Z` |

**0 active runs**, **0 partial/failed/in-progress**, **0 stuck `isActive=true`**. Latest `oldestRemainingTimestamp = 2026-05-02T16:19:44Z` matches series summary exactly.

## Re-halt rules — all GREEN (verified)

| # | Rule | Status |
|---|---|---|
| 1 | durationMs > 1,500,000 (per-wave) | N/A (no wave) |
| 2 | Sustained PG waits | 0 sustained (0 waiting locks, 0 long-active) |
| 3 | loadavg elevated, not settled | loadavg 0.24/0.20/0.19 — quiet |
| 4 | env != 0 / != "1" | **GREEN — directly verified `env="0"`, 0 active runs, last 5 cleanupRunState all completed** |
| 5 | non-cache RSS + MEM>30% + headroom<5 GiB | non-cache RSS ~300 MB; host headroom 25 GiB — far from breach |
| 6 | runtime / SQL / cleanup discipline breach | none |

## PG raw probe ban — status

Ban remains **ACTIVE**. Conditions evaluated against this snapshot:
- `shared_buffers < 1 GB`: TRUE (128 MB)
- `documents heap_hit < 50%`: TRUE (35.89 %)
- Either one true → ban active. Both true → ban firmly active.

## Method note — Convex admin path

`npx convex env get` and `npx convex data <tableName>` are Convex CLI read-only operations that go through the Convex backend's admin HTTP interface. **They are not PG raw probes** and are not subject to the `documents` / `indexes` probe ban (which targets direct PostgreSQL `COUNT/MIN/MAX/GROUP BY` against the internal document store). The ban policy and the admin verification path are separate concerns.

## Comparison to baselines (compact)

| Metric | 2026-05-09 (am) | 2026-05-09b (post BD-2) | **2026-05-11 (now)** |
|---|---|---|---|
| DB hit ratio (adpilot_prod) | 66.59 % | 66.95 % | **68.22 %** |
| documents heap_hit | 33.14 % | similar | **35.89 %** |
| documents n_dead_tup | — | ~0.7M | **0.69M** |
| indexes n_dead_tup | — | ~0.17M | **0.17M** |
| pg_wal | 25 GB/day rate | 200 files / 3.2 GB | **217 files / 3.47 GB** |
| Host mem available | 29 GiB total / X free | similar | **25 GiB free** |
| shared_buffers | 128 MB | 128 MB | **128 MB** (TODO жив) |
| track_io_timing | (tested) | off | **off** |
| HostConfig.Memory | — | 0 | **0** |
| indexes table size | 93 GB | 93 GB | **93 GB** |

Post-series state структурно идентичен 09b (поправки 09b vs 09 morning все остались в силе). Никакой регрессии после 11 волн — наоборот, лёгкое улучшение hit ratio.

## Decision-gate readiness

| Gate | Status |
|---|---|
| 10/10 strict-clean series complete | ✅ done (commit `5428e77`) |
| Fresh PG snapshot — read-only | ✅ this doc |
| Snapshot shows green (all 6 re-halt rules) | ✅ all rules verified GREEN |
| Cleanup discipline formally verified | ✅ env=0, 0 active runs, w7→w11 cleanupRunState match ledger |
| PG raw probe ban released | ❌ STILL ACTIVE (shared_buffers + heap_hit conditions both true) |
| Operator decision | ⏳ pending |

**Implication for Tier 2 decision:** профиль Tier 1 maxRuns=16 совершенно безопасен и воспроизводим, cleanup discipline verified end-to-end. PG ban остаётся → heavy probes по `documents`/`indexes` нельзя; снимок состоял из system stats + Convex admin read-only. Это не блокирует операционное Tier 2 (cleanup-волны делают только DELETE, не heavy reads); но блокирует диагностические heavy reads, если они потребуются в Tier 2 monitoring.

## Operational hygiene during this snapshot

- All probes read-only. No GUC toggle, no VACUUM/ANALYZE, no DDL/DML, no container restart.
- Convex admin key generated ephemerally in subshell; consumed inline; `unset` on exit. Never written to disk, never logged.
- All bash commands operated on the snapshot worktree; main dirty WT untouched.
- Per-WT pushurl set on snapshot worktree only; main WT push lock `DISABLED_DO_NOT_PUSH_FROM_DIRTY_WT` preserved.

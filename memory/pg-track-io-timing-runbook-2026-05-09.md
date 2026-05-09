# Runbook: `track_io_timing` 30-минутное наблюдательное окно

**Status:** **draft, not executed.** This file documents the procedure. Running it requires a separate explicit `go` from operator.

**Goal:** Получить block-level latency Postgres (read/write time) в течение короткого окна (30 минут) на адекватной нагрузке, чтобы оценить долю IO в задержках. Baseline 2026-05-09 показывает 33.43% heap cache hit на `documents` и 31.2% FPI rate в WAL; нужно подтвердить или опровергнуть, что время IO доминирует.

**Reference baseline:** `memory/pg-baseline-2026-05-09.md` (commit `d05a8c8`).

**Branch context:** `emergency/drain-scheduled-jobs`. Service running, `METRICS_REALTIME_CLEANUP_V2_ENABLED=0`, no active cleanup wave.

## Protocol & constraints

- Только **read-only SELECT** + **2 управляющих оператора**: `ALTER SYSTEM SET track_io_timing = on` (включение) и `ALTER SYSTEM RESET track_io_timing` (откат). Оба персистируют через `pg_reload_conf()`, без рестарта.
- Никаких других ALTER, никаких VACUUM/REINDEX/CHECKPOINT/INSERT/UPDATE/DELETE.
- Окно — **30 минут на спокойной нагрузке**, не вокруг cleanup wave (cleanup wave = отдельный go и отдельная процедура).
- Capture без секретов: `pg_stat_activity` с `LEFT(query, 120)`, без `client_addr`, без `Config.Env`.
- Если что-то странно — abort через шаг 6 немедленно.

## Pre-flight (read-only)

### P1. Host clocksource

```bash
ssh -i ~/.ssh/id_ed25519_server root@178.172.235.49 \
  'cat /sys/devices/system/clocksource/clocksource0/current_clocksource'
```
- **Ожидание:** `tsc`. Тогда `gettimeofday` cost в `track_io_timing` пренебрежимо мал.
- **Если** `hpet` / `acpi_pm` / другое — overhead может стать заметным; в окне 30 минут терпимо, но в findings отметить.
- **Abort condition:** не выполнять, если clocksource неизвестный или ядро не Linux — пересмотреть с человеком.

### P2. PG version и наличие представлений

```sql
SELECT version();
SELECT to_regclass('pg_stat_io') IS NOT NULL AS pg_stat_io_available;
SELECT name, setting, source FROM pg_settings WHERE name='track_io_timing';
```
- **Ожидание:** PG 16.x, `pg_stat_io_available = true`, текущее `track_io_timing setting = 'off'`, `source = 'default'`.
- **Если** `track_io_timing` уже on — **abort**, разобраться кто и когда включил.
- **Если** `pg_stat_io_available = false` — продолжить, но в финальной выборке использовать только `pg_stat_database.blk_*_time` + `pg_statio_user_tables` (см. шаг 4 fallback).

### P3. Background activity check

```sql
SELECT backend_type, state, wait_event_type, wait_event,
       to_char(now()-query_start,'HH24:MI:SS') AS q_age,
       LEFT(query,120) AS q
FROM pg_stat_activity
WHERE state <> 'idle'
ORDER BY query_start NULLS LAST;

SELECT * FROM pg_stat_progress_vacuum;
SELECT * FROM pg_stat_progress_analyze;

SELECT count(*) FROM pg_locks WHERE NOT granted;
```
- **Norm:** autovacuum в принципе fine and expected — наличие autovacuum на мелких таблицах / `pg_catalog` НЕ блокирует окно.
- **Hold (wait, не abort)** только если: (a) autovacuum активен на `documents` или `indexes` — подождать окончания, не убивать; либо (b) `pg_locks WHERE NOT granted > 0` уже до включения. Окно стартуем когда оба условия очищены.
- **Долгие запросы:** если есть client backend с `query_start` старше 5 минут в active state — проверить отдельно (это аномалия для Convex), при необходимости отложить окно.

### P4. Disk + WAL headroom

```bash
ssh ... 'df -h / && docker exec adpilot-postgres du -sh /var/lib/postgresql/data/pg_wal'
```
- **Ожидание:** ≥ 100 GB free, `pg_wal` около baseline (1.3 GB).
- **Abort condition:** free < 50 GB или `pg_wal` > 5 GB.

### P5. Service health

`/version` HTTP 200, нет активных алертов от admin.

---

## Step 0 — T−0 baseline snap (read-only)

**Зачем:** через 30 минут `pg_stat_database.blk_*_time` покажет cumulative since `stats_reset` (2026-05-05). Без T−0 snap дельта непрозрачна.

```sql
\timing on

-- B1. Per-DB IO time + temp + cache hits
SELECT now() AS t0, datname, blk_read_time, blk_write_time,
       blks_read, blks_hit, temp_files, temp_bytes,
       to_char(stats_reset,'YYYY-MM-DD HH24:MI') AS stats_reset
FROM pg_stat_database WHERE datname='adpilot_prod';

-- B2. Per-table block counters
SELECT now() AS t0, relname,
       heap_blks_read, heap_blks_hit,
       idx_blks_read, idx_blks_hit,
       toast_blks_read, toast_blks_hit
FROM pg_statio_user_tables
ORDER BY heap_blks_read DESC;

-- B3. bgwriter / WAL
SELECT now() AS t0, * FROM pg_stat_bgwriter;
SELECT now() AS t0, * FROM pg_stat_wal;

-- B4. pg_stat_io (gate)
SELECT to_regclass('pg_stat_io') IS NOT NULL AS pg_stat_io_available;
-- если true:
SELECT now() AS t0, backend_type, object, context,
       reads, writes, extends, hits, evictions, reuses
FROM pg_stat_io
WHERE reads+writes+extends+hits > 0
ORDER BY (reads+writes) DESC LIMIT 30;
```

Сохранить вывод в `memory/pg-track-io-timing-window-2026-05-09-T0.txt` (или текстовый блок в финальном findings-доке).

---

## Step 1 — T+0 enable

```sql
-- ENABLE
ALTER SYSTEM SET track_io_timing = on;
SELECT pg_reload_conf();

-- VERIFY
SELECT name, setting, source FROM pg_settings WHERE name='track_io_timing';
-- expect: setting='on', source='configuration file' (auto.conf merged into config tree)

-- NOTE TIMESTAMP
SELECT now() AS t_enabled;
```

**После этого момента** `pg_stat_database.blk_*_time`, `pg_stat_io.read_time/write_time`, `pg_statio_*` начнут считать **только новые** IO операции с timing. Cumulative значения до T+0 остаются прежними и не получают timing задним числом.

---

## Step 2 — T+30 minutes hold

- Не запускать диагностики чаще одного раза в окне.
- Не запускать cleanup wave / sync stress / heavy queries вручную.
- Если оператор замечает деградацию ответов API — немедленно перейти к шагу 4 (rollback).

В середине окна (T+15m) можно сделать sanity ping без накопления:
```sql
SELECT name, setting FROM pg_settings WHERE name='track_io_timing';  -- still 'on'?
SELECT count(*) FROM pg_stat_activity WHERE state <> 'idle';         -- normal range?
```

---

## Step 3 — T+30m capture (read-only)

```sql
\timing on

-- C1. Per-DB IO time + temp (compare to T0)
SELECT now() AS t1, datname, blk_read_time, blk_write_time,
       blks_read, blks_hit, temp_files, temp_bytes
FROM pg_stat_database WHERE datname='adpilot_prod';

-- C2. Per-table block counters (compare to T0)
SELECT now() AS t1, relname,
       heap_blks_read, heap_blks_hit,
       idx_blks_read, idx_blks_hit
FROM pg_statio_user_tables
ORDER BY heap_blks_read DESC;

-- C3. bgwriter / WAL deltas
SELECT now() AS t1, * FROM pg_stat_bgwriter;
SELECT now() AS t1, * FROM pg_stat_wal;

-- C4. pg_stat_io with TIMING (only valid if pg_stat_io exists AND has timing columns)
SELECT to_regclass('pg_stat_io') IS NOT NULL AS pg_stat_io_available;
-- if true:
SELECT now() AS t1, backend_type, object, context,
       reads, writes, read_time, write_time,
       (read_time / NULLIF(reads,0))::numeric(10,3)  AS avg_read_ms,
       (write_time / NULLIF(writes,0))::numeric(10,3) AS avg_write_ms,
       evictions, reuses
FROM pg_stat_io
WHERE reads+writes > 0
ORDER BY (read_time+write_time) DESC NULLS LAST
LIMIT 30;

-- C5. Activity snapshot (no client_addr, LEFT(query,120))
SELECT pid, usename, application_name, backend_type, state,
       wait_event_type, wait_event,
       to_char(now()-query_start,'HH24:MI:SS') AS q_age,
       LEFT(query,120) AS q
FROM pg_stat_activity
ORDER BY backend_type, state;
```

### Fallback if `pg_stat_io_available = false`

Использовать только `pg_stat_database.blk_*_time` (cumulative на уровне БД, не per-relation) и `pg_statio_user_tables` (volume без timing). Дельта `(t1.blk_read_time - t0.blk_read_time)` за 30 минут даст агрегированный IO time по всей `adpilot_prod`. Этого достаточно для grossbig-picture проверки гипотезы; per-relation timing не нужен для текущей цели.

### Delta computation (for findings)

```
read_time_delta_ms  = t1.blk_read_time  - t0.blk_read_time
write_time_delta_ms = t1.blk_write_time - t0.blk_write_time
read_ops_delta      = t1.blks_read      - t0.blks_read
hit_ops_delta       = t1.blks_hit       - t0.blks_hit
window_seconds      = 1800
read_io_share       = read_time_delta_ms / (1000 * window_seconds * num_backends)
                       — приблизительная доля wall time backend'ов на IO read.
```

Сохранить вывод в `memory/pg-track-io-timing-window-2026-05-09-T1.txt` (или общий findings-док).

---

## Step 4 — T+30m+ rollback

```sql
-- ROLLBACK
ALTER SYSTEM RESET track_io_timing;
SELECT pg_reload_conf();

-- VERIFY
SELECT name, setting, source FROM pg_settings WHERE name='track_io_timing';
-- expect: setting='off', source='default'
SELECT now() AS t_disabled;
```

Если `source <> 'default'` после RESET — повторить:
```sql
ALTER SYSTEM SET track_io_timing = off;
SELECT pg_reload_conf();
SELECT name, setting, source FROM pg_settings WHERE name='track_io_timing';
-- expect: setting='off', source='configuration file'
```
И сразу же опять:
```sql
ALTER SYSTEM RESET track_io_timing;
SELECT pg_reload_conf();
```
Чтобы не оставить явную запись в `postgresql.auto.conf`.

---

## Step 5 — Post-window check

```sql
-- Settings clean
SELECT name, setting, source FROM pg_settings WHERE name='track_io_timing';

-- No leftover track_io_timing in auto.conf
-- (run on host)
-- docker exec adpilot-postgres cat /var/lib/postgresql/data/postgresql.auto.conf
-- expect: NO `track_io_timing` line present after RESET.
-- Любые pre-existing entries (storm-fix block: max_wal_size, checkpoint_timeout,
-- checkpoint_completion_target, wal_compression) — НЕ трогать. Этот шаг
-- проверяет только отсутствие нашей сессионной записи, а не "чистоту" файла.

-- No new locks / long queries
SELECT pid, mode, locktype, relation::regclass, granted FROM pg_locks WHERE NOT granted;
SELECT count(*) FROM pg_stat_activity WHERE state <> 'idle';
```

---

## Step 6 — Abort criteria (взять немедленно)

**Pre-window:** перед T+0 зафиксировать **baseline `/version` response time** (среднее из 3–5 проб) — обозначим `baseline_ms`. Это та точка отсчёта, против которой меряем деградацию.

Перейти к Step 4 (rollback) **немедленно**, если в окне:
- `/version` отвечает **> 3× baseline_ms** на нескольких подряд probe (например 3 из 5), или **non-200**. Одиночный spike не считается — нужен паттерн.
- `pg_stat_activity` показывает **> 20 active backends** дольше 60 секунд (а не одиночный peak).
- `pg_locks WHERE NOT granted` count **> 5** (стабильно, не одиночный snapshot).
- Disk free падает быстрее **1 GB/мин** (WAL spike).
- Telegram alerts по latency / errors.
- Любой stakeholder говорит «верни как было».

Abort = шаг 4. Время от обнаружения до RESET — менее 1 минуты.

---

## Out of scope (NOT done in this runbook)

- Tuning `shared_buffers`, `work_mem`, `wal_buffers`, `effective_cache_size`, `random_page_cost`, `effective_io_concurrency`.
- Установка `pg_stat_statements`, `pgstattuple`, `pg_repack`.
- VACUUM / VACUUM FULL / REINDEX / CHECKPOINT / `pg_switch_wal()`.
- Cleanup wave (BD-2 fallback, BD-3, BD-4 — все заморожены).
- Любые env-изменения, restart, deploy.

Каждое из перечисленного — отдельный go и отдельный runbook.

---

## Findings template

После выполнения создать `memory/pg-track-io-timing-findings-2026-05-09.md` со структурой:

```
# track_io_timing window findings — 2026-05-09

T0 timestamp:   ...
T1 timestamp:   ...
Window length:  ~30 min
PG version:     16.11
Clocksource:    tsc  (or actual)

## Deltas
blk_read_time   t0=...  t1=...  Δ=... ms
blk_write_time  t0=...  t1=...  Δ=... ms
blks_read       t0=...  t1=...  Δ=...
blks_hit        t0=...  t1=...  Δ=...
hit_pct_window  ...%
avg_read_ms_per_op = read_time_delta / read_ops_delta = ...
avg_write_ms_per_op = ...

## pg_stat_io (if available)
documents heap   read_time=...  write_time=...
indexes  heap   read_time=...  write_time=...

## Verdict on IO contribution to chunk-stall
[strongly supports / weakly supports / does not support]
```

После findings — отдельный go на следующий шаг (commit findings, или другой диагностический шаг).

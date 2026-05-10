# Storage Cleanup V2 — Sustained Drain Plan (2026-05-10)

## Goal
Свести `metricsRealtime` live data к 48h retention через серию BD-2 safe-profile волн. Целевая математика: `drain_rate ≥ ingest_rate` устойчиво за окно >48h. Пока это неравенство не держится, retention не сходится.

## Context
- BD-2 safe profile подтверждён 2026-05-09: две clean waves (`aaff3eb` 17:15Z, `a7d6e9f` 18:31Z), 16K rows.
- Profile воспроизводимый, но медленный.
- HEAD on `origin/emergency/drain-scheduled-jobs` = `5b31da9` (healthCheck thresholds aligned).
- Service healthy. `METRICS_REALTIME_CLEANUP_V2_ENABLED=0` (волны запускаются операторно).
- Storm-fix от 03.05 держится (1 checkpoint / 30 мин).

## Honest unknowns

| Метрика | Значение | Как получено / почему unknown |
|---|---|---|
| `metricsRealtime` live row count | **unknown** | PG raw probes banned (см. ниже); Convex `.collect()` тоже дорого на миллионах rows — нужно пагинированное counting если станет необходимо |
| oldest live ts в `metricsRealtime` | available via `cleanupRunState.oldestRemainingTimestamp` (последняя completed wave) или Convex admin query `db.query("metricsRealtime").withIndex("by_timestamp").order("asc").first()` — **только в preflight перед wave**, отдельным go |
| ingest rate (rows/hour) | **unknown в idle** | derive из `cleanupRunState` trend между completed waves: Δ(`oldestRemainingTimestamp`) vs `deletedCount` за окно |
| dominant table_id PG footprint | ~13.3M rows (**estimate**) | `pg_stats.most_common_freqs[1] = 0.7075 × n_live_tup 18.8M`; includes ALL versions + tombstones; **НЕ backlog count** |

Backlog = subset строк старше retention cutoff. У нас этого числа нет. 13.3M = footprint, не backlog.

## Frozen safe profile (не менять до re-evaluation gate)
- `batchSize = 1000`
- `timeBudgetMs = 10000`
- `restMs = 90000`
- `maxRuns = 8`
- → 8K rows / wave, ~11.5 мин duration.

## Wave cadence (operator-driven, без приукрашивания)
- **Baseline: 1–3 waves/day.** Каждая wave — explicit operator go.
- **Monitored window: 4–6 waves/day** только при активном operator dispatch/observation.
- 6+/day без автоматизации нереалистично.

## Cron-window avoidance
Verified против `origin/emergency/drain-scheduled-jobs:convex/crons.ts` (большинство crons закомментировано — emergency drain mode).

**Fixed UTC no-go windows (всего 6 точек, ±5 мин от каждого):**
- `00:00 / 06:00 / 12:00 / 18:00 UTC` (4 точки) — `cleanup-old-realtime-metrics` cron (`0 */6 * * *`).
- `02:00 UTC` (1 точка) — `cleanup-old-logs` cron (`0 2 * * *`).
- `05:30 UTC` (1 точка) — `cleanup-expired-invites` cron (`30 5 * * *`).

**Interval crons — фон, НЕ no-go windows** (запускаются от регистрации, не aligned к UTC):
- `sync-metrics` 15 мин (V2 main work, основной WAL-генератор).
- `uz-budget-increase` 45 мин.
- `uz-budget-reset` 5 мин.
- `proactive-token-refresh` 2 ч.
- `cleanup-stuck-payments` 2 ч.

**Cron `cleanup-old-realtime-metrics` profile:** `(batchSize=500, timeBudgetMs=10000, restMs=90000, maxRuns=5)` = до 2.5K rows/tick. **Отличается** от manual safe BD-2 wave `(1000/.../8)` = 8K rows. Если env=1 между manual waves, organic cron на 00/06/12/18 UTC запустит свой 500/5 run отдельно — это смешает атрибуцию drain rate.

## Stop criteria (per wave — hard stop)
- chunk duration > 9s
- WAL abnormal (`pg_wal` grows beyond `max_wal_size = 8 GB`, или delta > baseline expectation)
- waiting locks > 0 / `idle-in-transaction` count rises
- `/version` response degrades >2× baseline (~1.3–1.6s OK сейчас)
- env did not return to 0 after wave end (`METRICS_REALTIME_CLEANUP_V2_ENABLED`)
- host loadavg spike >3× baseline (baseline ~0.3)

## Kill-switch (cumulative, over 24h)
- **Primary:** `progress_floor_delta ≤ 0` over 24h, где `progress_floor = cleanupRunState.oldestRemainingTimestamp`.
  - progress_floor advances → drain > ingest (good).
  - stagnant or retreats → drain ≤ ingest, профиль недостаточен → пересматривать.
- **Поле verified в schema** (`origin/emergency/drain-scheduled-jobs:convex/schema.ts:841`). Источник записи: `metrics.ts:markCompletedV2` line 568-571 — `db.query("metricsRealtime").withIndex("by_timestamp").order("asc").first()` — реальная самая старая live-строка через Convex layer, **не tombstone и не версия**.
- **Caveat — пишется ТОЛЬКО на `state="completed"`.** `markFailedV2` НЕ обновляет поле, остаётся значение от предыдущей completed wave. Trend измеряется **только между completed waves**; failed waves в trend не попадают, причину failure смотреть в `error`.
- **Note: `disabled_mid_chain` — это `state="failed"` + `error="disabled_mid_chain"`, НЕ отдельный state-литерал.** Если env выключили mid-chain, wave заканчивается через `markFailedV2`, попадает в "failed" группу и не двигает progress floor.
- **Fallback:** если все waves в окне 24h — failed → primary metric не двигается → degraded в `cumulativeDeletedRows` proxy (weaker, ловит только "drained 0").

## Yellow/hold signal (не hard stop)
- `autovacuum_count` stagnant **+** `n_dead_tup` растёт **+** `last_autovac` старый одновременно — pause перед следующей волной, разбираться (lock holder, cost throttle, autovac заблокирован).
- Stagnant `autovacuum_count` сам по себе при низких dead_tuples = irrelevant, не останавливать.

## Re-evaluation gate (когда рассматривать bump профиля)
1. ≥10 consecutive clean waves (no stop criteria triggered).
2. **Fresh PG snapshot** taken before any change. Snapshot должен показать:
   - WAL bytes/day и FPI в пределах baseline (~23.6 GB/day, FPI ~31%);
   - 0 waiting locks / 0 idle-in-tx;
   - `documents.n_dead_tup` не trending вверх;
   - cache hit rate не degraded vs текущий 66.95%.
3. Если snapshot green → bump **ОДНОГО** параметра:
   - либо `batchSize` 1000 → 1500, ИЛИ
   - `restMs` 90 → 75.
4. **Никогда не оба сразу.** Re-validate over 5 waves before considering second bump.

## PG raw probes — banned (with gating conditions)
PG raw probes (`COUNT(*)`, `MIN/MAX(ts)` filtered by Convex `table_id`, `GROUP BY table_id` over `documents`) **запрещены** до тех пор, пока ОБА условия:
- `shared_buffers ≥ 1 GB` (сейчас 128 MB)
- `documents` heap hit rate ≥ 50% (сейчас 34.21%)

**Причина:** Incident 2026-05-10 05:09–05:20 UTC. Две read-only diagnostic queries (`max_ts` в 5-min window over all `documents`; `min/max ts` для top table_id) застряли на `DataFileRead` на 50 GB heap с устаревшим visibility map (last_autovac на documents 11h prior). SSH connections дропались по таймауту, но `psql -i` внутри `docker exec` продолжал скриптить следующие queries из probe sql — поэтому появлялись новые stuck backends на тех же PID. Потребовался `pg_cancel_backend` × 2 + grace + match по query-text. Параллельно работала prod cleanup DELETE-волна (3 active DELETEs + 1 idle-in-tx); наши probes добавляли I/O шум к live load.

**Allowed alternatives:**
- Convex admin/internal queries (separate go для admin key generation если нужен);
- `cleanupRunState` reads (cheap, indexed) — главный канал измерения темпа;
- `pg_stats` sample-based estimates (no heap scan);
- aggregate `pg_stat_*` snapshots (как в обычном PG snapshot routine).

## VACUUM / ANALYZE policy
- Для текущих BD-2 safe-profile waves (8K rows/wave): ручной VACUUM **не нужен вообще**. autovac справляется. Ручной VACUUM на `indexes` (93 GB) или `documents` (50 GB) без throttle = больше I/O нагрузка чем autovac с `cost_delay = 2ms`.
- ANALYZE и VACUUM **разделять**: stats-drift (`last_autoanalyze` старо) → `ANALYZE table` (sample-based, дёшево); dead_tuples drift при throttled autovac → разбираться с throttle, не ручной VACUUM.

## Operational rules (env handling)
- `METRICS_REALTIME_CLEANUP_V2_ENABLED` держать `=1` **только на время конкретной manual wave**, сразу после wave end вернуть `=0`.
- Мотивация: если env остаётся `=1` между manual waves, то organic cron `cleanup-old-realtime-metrics` на 00/06/12/18 UTC запустит свой 500/5 run отдельно. Это (а) смешает атрибуцию drain rate (наши 8K/wave + chunked 2.5K/cron tick), (б) добавит cleanupRunState records которые не наши waves.
- Если env не вернулся в 0 после wave end — это hard stop criterion (уже в Stop criteria).
- Live `oldestRemainingTimestamp` фетчится в **preflight перед wave** — отдельным explicit go (требует Convex admin key). Не делать этот замер в idle-периодах между waves.

## Pre-wave checklist
Не дублирую — ссылка на существующие runbook'и:
- `docs/storage-cleanup-v2-cheatsheet.md` (`7d8a121`)
- `docs/storage-cleanup-v2-bd-2-runbook.md` (`5d3aa81`)
- BD-2 closure template (`1b3e6b2`)

Добавить к существующему checklist (preflight перед каждой wave):
- Запросить live `cleanupRunState` за последние 7 дней (через Convex admin) — последние completed waves, их `oldestRemainingTimestamp`, `deletedCount`, `durationMs`. Это baseline для current wave's gates.
- Verify env=0 **до** старта (если =1 → значит предыдущая wave не сделала post-cleanup, разбираться).

## Open items / known caveats
- ✅ `cleanupRunState` schema verify — done 2026-05-10 (поля подтверждены в `origin/emergency/drain-scheduled-jobs:convex/schema.ts`, primary kill-switch не fictional).
- `cleanup-realtime` STUCK row from 2026-05-04 — известный cosmetic, не запускать `resetStuckCleanupHeartbeat` без отдельного go.
- Tuning plan (`shared_buffers` 128 MB → ~3 GB + docker `--memory` limit одновременно + `work_mem` + `effective_cache_size` + `random_page_cost`) — отдельный design doc, не часть этого drain plan. Этот план работает на текущих PG settings; после tuning re-evaluation gate может разрешить более агрессивный профиль.
- Если drain rate окажется существенно ниже ingest даже после bump-ов в (re-eval gate), значит safe profile не достаточен — design doc для альтернативной механики (parallel waves? larger chunks под более крупным shared_buffers? отдельный drain process?).

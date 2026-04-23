# Анализ диска сервера 178.172.235.49 — 22-23.04.2026

## Связанные документы

| Документ | Статус | Описание |
|----------|--------|----------|
| `docs/server-cleanup-plan-2026-04-13.md` | Частично выполнен | Аварийный план от 13.04 (диск 100%). Docker cleanup, WAL, volumes |
| `docs/superpowers/specs/2026-04-16-metrics-realtime-cleanup-design.md` | Реализован (rev.7) | Дизайн-спек cleanup metricsRealtime: архитектура, индексы, деплой |
| `docs/superpowers/plans/2026-04-16-metrics-realtime-cleanup.md` | Deploy 1 выполнен | План имплементации. Deploy 2 (удаление старых индексов) — не проверен |
| Этот файл | Актуален | Полный анализ диска + документы по таблицам + план действий |

## Хронология проблем с диском

| Дата | Событие | Диск |
|------|---------|------|
| 13.04.2026 | Диск 100% (79 GB). PostgreSQL crash loop. Аварийная очистка Docker + volumes | 79 GB |
| 16.04.2026 | Реализован cleanup metricsRealtime (24.3 млн записей). Индексы добавлены, cleanup запущен | — |
| 21.04.2026 | Восстановление из бэкапа hoster.by. DNS сломался. Диск увеличен до 163 GB | 163 GB |
| 22.04.2026 | Диск 92% (143/163 GB). Анализ таблиц, bloat, retention. Docker cleanup (−1.2 GB) | 163 GB |
| 23.04.2026 | Анализ документов по таблицам. metricsRealtime cleanup работает корректно (3.25 млн = норма для 2825 объявлений). Retention можно сократить с 4 до 2 дней. metricsDaily/actionLogs не имеют cleanup | 163 GB |

## Общая картина

- **Диск:** `/dev/sda1` — 163 GB всего, 143 GB занято (92%), 14 GB свободно
- **ОС:** Ubuntu 24.04.3 LTS (6.8.0-85-generic)
- **Hostname:** server-rwutxg

## Docker Volumes

| Volume | Размер | Назначение |
|--------|--------|------------|
| `adpilot-convex-pgdata` | **125 GB** | PostgreSQL — ВСЕ данные Convex PROD |
| `adpilot-convex-data` | 1.8 GB | File storage Convex (uploads) |
| `adpilot-dev-convex-pgdata-v2` | 221 MB | DEV PostgreSQL (новый) |
| `adpilot-dev-convex-pgdata` | 47 MB | DEV PostgreSQL (старый) |
| `adpilot-dev-convex-data` | 89 MB | DEV file storage |
| `dokploy-postgres` | 66 MB | Dokploy внутренняя БД |
| `dokploy-redis` | 72 KB | Dokploy кэш |
| Docker overlay + images | ~16 GB | Образы контейнеров, система |

## Контейнеры (все Running)

| Контейнер | Image | Порты |
|-----------|-------|-------|
| adpilot-frontend | ghcr.io/djollyolly-cell/addpilot-frontend:latest | 3000/tcp |
| adpilot-convex-backend | ghcr.io/get-convex/convex-backend:latest | 3220→3210, 3221→3211 |
| adpilot-postgres | postgres:16 | 127.0.0.1:5433→5432 |
| adpilot-convex-dashboard | ghcr.io/get-convex/convex-dashboard:latest | 6792→6791 |
| vkmonitorfrontend | vkmonitorpro-vkmonitorfrontend-r11oj9:latest | 80/tcp |
| browserless | ghcr.io/browserless/chromium:latest | 3100→3000 |
| dokploy | dokploy/dokploy:latest | 3000→3000 |
| dokploy-postgres | postgres:16 | 5432/tcp |
| dokploy-redis | redis:7 | 6379/tcp |
| dokploy-traefik | traefik:v3.6.7 | 80, 443 |

## PostgreSQL: базы данных

Подключение: `docker exec adpilot-postgres psql -U convex -d postgres`

| БД | Размер | Статус |
|----|--------|--------|
| `adpilot_prod` | **124 GB** | Рабочая PROD база Convex |
| `convex_adpilot` | 7.5 MB | Пустая/старая, не используется |
| `postgres` | 7.5 MB | Системная |

## Таблицы в `adpilot_prod`

Подключение: `docker exec adpilot-postgres psql -U convex -d adpilot_prod`

| Таблица | Размер | Live строки | Dead строки | % мёртвых |
|---------|--------|-------------|-------------|-----------|
| `indexes` | **91 GB** | 20,949,188 | 3,334,487 | 16% |
| `documents` | **32 GB** | 372,522 | 1,004,593 | **73%** |
| `persistence_globals` | 296 KB | 10 | 35 | — |
| `leases` | 48 KB | 0 | 2 | — |
| `read_only` | 8 KB | 0 | 0 | — |

**Примечание:** `indexes` и `documents` — внутренние таблицы Convex. Все таблицы приложения хранятся внутри них как JSON-документы.

## Количество документов по таблицам (данные из Convex Dashboard 22.04.2026)

| Таблица | Документов | Cleanup | Комментарий |
|---------|-----------|---------|-------------|
| **metricsRealtime** | **3 254 123** | **2 дня** (было 4), каждые 6ч | Cleanup РАБОТАЕТ. Retention сокращён с 4 до 2 дней (−50%). Ожидается ~1.6 млн документов |
| **metricsDaily** | **974 967** | ❌ НЕТ | **ВТОРОЙ пожиратель.** Растёт бесконечно |
| **actionLogs** | **151 472** | ❌ НЕТ | Третий по объёму. Растёт бесконечно |
| ads | 70 637 | — | Бизнес-данные, не чистить |
| campaigns | 54 044 | — | Бизнес-данные, не чистить |
| systemLogs | 27 500 | 30 дней | Работает нормально |
| credentialHistory | 1 341 | 10 дней | Работает нормально |
| auditLog | 764 | 90 дней | Работает нормально |
| adAccounts | 266 | — | Бизнес-данные |
| rules | 187 | — | Бизнес-данные |
| sessions | 112 | — | Малый объём |
| users | 90 | — | Бизнес-данные |
| notifications | 78 | ❌ НЕТ | Мизер, но нет cleanup |

### Анализ: кто съедает 124 GB?

124 GB в PostgreSQL — это `indexes` (91 GB) + `documents` (32 GB). Обе таблицы — внутренние для Convex. Все приложенческие данные (metricsRealtime, metricsDaily, ads и т.д.) хранятся внутри них как JSON. Невозможно узнать размер отдельной Convex-таблицы в байтах — только количество документов.

**metricsRealtime (3.25 млн документов)** — самая большая по числу документов. Cleanup РАБОТАЕТ корректно: ~2825 активных объявлений × 288 снимков/день × 4 дня retention = ~3.25 млн. Это ожидаемый объём. Но постоянная ротация (запись + удаление каждые 5 минут) генерирует основной bloat: каждое удаление создаёт dead tuple в PostgreSQL, отсюда 73% мёртвых строк в `documents`.

**metricsDaily (975K документов)** — cleanup ОТСУТСТВУЕТ, растёт бесконечно. Каждый день на каждое объявление = 1 запись. При ~2825 объявлениях: ~2825/день × 345 дней ≈ 975K. Это все данные с момента запуска. Upsert (update existing record) при каждом sync-цикле тоже генерирует dead tuples.

**actionLogs (151K документов)** — cleanup ОТСУТСТВУЕТ. Каждое срабатывание правила = 1 запись. Растёт пропорционально активности правил.

**Главная проблема — bloat, а не живые данные:**
- `documents`: 32 GB на диске, ~8-10 GB живых данных, ~22 GB bloat (73% мёртвых строк)
- Причина bloat: metricsRealtime ротация (миллионы insert+delete) + metricsDaily upsert (миллионы update)
- Обычный VACUUM не возвращает место ОС, только помечает для переиспользования
- Нужен VACUUM FULL (exclusive lock, даунтайм) для реального освобождения

### Что нужно сделать (в порядке приоритета)

1. **Сократить retention metricsRealtime** с 4 до 2 дней → −50% документов, −50% bloat-генерации
2. **Добавить cleanup metricsDaily** (90 дней) → удалит ~720K из 975K документов
3. **Добавить cleanup actionLogs** (90 дней) → удалит большую часть из 151K документов
4. **VACUUM FULL documents** → вернёт ~22 GB мёртвых строк
5. Рассмотреть увеличение диска для VACUUM FULL indexes (нужно ~76 GB свободных)

## Bloat анализ

### `documents` — 73% мёртвых строк
- 32 GB на диске, реальных данных ~8-10 GB
- VACUUM FULL освободит **~22 GB**
- Для операции нужно ~10 GB свободных (есть 14 GB — **хватает**)

### `indexes` — 16% мёртвых строк
- 91 GB на диске, реальных данных ~76 GB
- VACUUM FULL освободит **~15 GB**
- Для операции нужно ~76 GB свободных — **НЕ хватает даже после очистки documents** (будет ~36 GB свободных)

## Что уже сделано (22.04.2026)

1. **DNS fix** — добавлен `dns: [8.8.8.8, 8.8.4.4]` в docker-compose для backend сервиса (исправлена ошибка DNS после восстановления из бэкапа hoster.by)
2. **Docker cleanup через Dokploy** — удалены:
   - Stopped containers (2 exited vkmonitor контейнера)
   - Unused Docker images
   - Docker build cache
   - Результат: освободилось ~1.2 GB
3. **Неудачный pg_dump** — SSH-сессия оборвалась (не хватило места). Дамп удалён: `docker exec adpilot-postgres rm -f /tmp/adpilot_prod_backup.dump`

## Что можно сделать для очистки

### Шаг 1: VACUUM FULL documents (безопасно, хватает места)
```bash
docker exec adpilot-postgres psql -U convex -d adpilot_prod -c "VACUUM FULL VERBOSE documents;"
```
- Освободит ~22 GB
- Даунтайм Convex ~10-30 минут
- Не удаляет живые данные, только мёртвые кортежи
- Нужно ~10 GB свободных (есть 14 GB)

### Шаг 2: pg_dump бэкап (после шага 1)
```bash
docker exec adpilot-postgres pg_dump -U convex -d adpilot_prod -Fc -f /tmp/adpilot_prod_backup.dump
docker cp adpilot-postgres:/tmp/adpilot_prod_backup.dump /root/adpilot_prod_backup_$(date +%Y%m%d).dump
```
- После шага 1 будет ~36 GB свободных — должно хватить для сжатого дампа

### Шаг 3: VACUUM FULL indexes (только после шагов 1-2)
- Нужно ~76 GB свободных
- После шага 1: ~36 GB — **НЕ хватает**
- Вариант: увеличить диск на сервере, или принять текущий размер

### Дополнительно: удаление DEV volumes (~350 MB)
```bash
docker volume rm adpilot-dev-convex-pgdata adpilot-dev-convex-pgdata-v2 adpilot-dev-convex-data
```
- Только если DEV не используется
- Освободит ~350 MB (мало)

## Retention: что, где, сколько хранится

### Convex (серверный уровень)
- **DOCUMENT_RETENTION_DELAY:** 172800 сек (2 дня) — `docker/docker-compose.convex-selfhosted.yml`
  - Это внутренний параметр Convex: через 2 дня soft-deleted документы удаляются из transaction log

### Cron-очистки (приложение)

| Таблица | Retention | Cron | Файл |
|---------|-----------|------|------|
| `metricsRealtime` | **4 дня** | каждые 6ч | `convex/metrics.ts` |
| `systemLogs` | **10 дней** (было 30) | ежедневно 02:00 UTC | `convex/systemLogger.ts` |
| `auditLog` | **10 дней** (было 90) | ежедневно 02:00 UTC | `convex/auditLog.ts` |
| `adminAlertDedup` | **1 день** | ежедневно 02:00 UTC | `convex/adminAlerts.ts` |
| `aiGenerations` | **35 дней** (было 60, мин 30 — лимитное окно) | ежедневно 04:00 UTC | `convex/aiLimits.ts` |
| `credentialHistory` | **10 дней** (только токены) | ежедневно 03:00 UTC | `convex/credentialHistory.ts` |
| `creatives` (drafts) | **2 дня** | каждые 6ч | `convex/creatives.ts` |
| `orgInvites` | по expiresAt | ежедневно 05:30 UTC | `convex/orgAuth.ts` |
| Organizations (frozen) | **150 дней** (60 grace + 90 frozen) | ежедневно 04:30 UTC | `convex/loadUnits.ts` |

### Что НЕ очищается автоматически (растёт бесконечно)
- ~~**`metricsDaily`** — 974 967 документов!~~ **РЕАЛИЗОВАНО 23.04:** cleanup 90 дней, cron каждые 6ч, массовая очистка через `triggerMetricsDailyCleanup`
- ~~**`actionLogs`** — 151 472 документов.~~ **РЕАЛИЗОВАНО 23.04:** cleanup 90 дней, cron ежедневно 02:30 UTC
- `notifications` — 78 документов. Малый объём, но нет cleanup
- `ads` — 70 637 док. Бизнес-данные, не чистить
- `campaigns` — 54 044 док. Бизнес-данные, не чистить
- `rules` — 187 док., `users` — 90 док., `sessions` — 112 док., `adAccounts` — 266 док.
- `payments` — малый объём

### metricsRealtime cleanup — анализ 23.04.2026

**Статус:** cleanup работает корректно. 3.25 млн документов — ожидаемый объём.

**Расчёт:**
- ~2825 активных объявлений (3,254,123 / (288 снимков/день × 4 дня) ≈ 2825)
- syncMetrics каждые 5 мин = 288 insert/день на объявление
- 4 дня retention × 2825 объявлений × 288 = 3,254,400 — совпадает с реальным числом

**Где используется metricsRealtime (проверено 23.04):**

| Место | Файл | Окно запроса |
|-------|------|-------------|
| minSamples check | `ruleEngine.ts:1722` | 24 часа |
| fast_spend history | `ruleEngine.ts:1736` | 15 минут |
| timeWindow 1h/6h | `ruleEngine.ts:1769` | 1ч или 6ч |
| admin diagnostic | `adminRuleDiagnostic.ts` | те же окна |
| getRealtimeByAd | `metrics.ts:185` | последняя 1 запись |
| Фронтенд | — | НЕ используется |

**Максимальная глубина чтения: 24 часа** (minSamples check).

**Вывод:** retention можно безопасно сократить с 4 до 2 дней:
- 2 дня покрывает все окна (макс 24ч) с двойным запасом
- Результат: с 3.25 млн до ~1.63 млн документов (−50%)
- Меньше insert/delete операций → меньше bloat → медленнее рост диска

### Что нет cleanup и нужно добавить

| Таблица | Документов | Рекомендуемый retention | Обоснование |
|---------|-----------|----------------------|-------------|
| **metricsDaily** | 974 967 | 90 дней | Отчёты/аналитика используют данные за последние 30-60 дней. 90 = запас. Освободит ~720K документов |
| **actionLogs** | 151 472 | 90 дней | Логи срабатываний правил. История за 90 дней достаточна для аудита |
| notifications | 78 | 30 дней | Малый объём, но стоит добавить для порядка |

### Оркестрация очистки
- Все cron-задачи в `convex/crons.ts`
- Логи очищаются через `convex/logCleanup.ts` (вызывает systemLogs + auditLog + adminAlertDedup)
- Батчинг: 500-3000 записей за вызов (защита от таймаута мутаций 8с)

## Настройки Dokploy

- **Daily Docker Cleanup:** включён (автоочистка)
- **Backups в Dokploy:** требует настройки S3 Destinations

## Полезные команды

```bash
# Общий диск
df -h /

# Размер volumes
du -sh /var/lib/docker/volumes/*/

# Размер PostgreSQL WAL
du -sh /var/lib/docker/volumes/adpilot-convex-pgdata/_data/pg_wal/

# Список БД
docker exec adpilot-postgres psql -U convex -d postgres -c "\l"

# Размер БД
docker exec adpilot-postgres psql -U convex -d postgres -c "SELECT datname, pg_size_pretty(pg_database_size(datname)) FROM pg_stat_database WHERE datname NOT LIKE 'template%' ORDER BY pg_database_size(datname) DESC;"

# Размер таблиц + bloat
docker exec adpilot-postgres psql -U convex -d adpilot_prod -c "SELECT relname, n_live_tup, n_dead_tup, pg_size_pretty(pg_total_relation_size(relid)) FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC;"

# Генерация admin key для Convex Dashboard
CONVEX_INSTANCE_SECRET=2de125637ad4cefdbb60e5e350aa0894545bc813a4bc296fcdbd3e3506490e19 node gen-key.cjs
```

## Проблемы с которыми столкнулись

### 1. Замкнутый круг: нет места для бэкапа, нет бэкапа для очистки
- pg_dump на 124 GB базу требует ~15-30 GB свободных (со сжатием -Fc)
- Свободно 14 GB — не хватает. pg_dump оборвался, SSH-сессия упала
- Но VACUUM FULL хотим делать только после бэкапа
- **Решение:** сначала сократить живые данные (cleanup metricsDaily/actionLogs + сократить retention metricsRealtime), потом VACUUM FULL documents (хватает 14 GB), потом pg_dump (будет ~36 GB свободных)

### 2. Потеря данных при предыдущем инциденте
- При прошлом инциденте с диском данные были потеряны. Восстановление из бэкапа hoster.by 21.04.2026
- **Урок:** никаких деструктивных операций без подтверждённого бэкапа
- **Текущий бэкап:** только hoster.by snapshot от 21.04.2026. Нет S3/offsite бэкапов

### 3. VACUUM FULL indexes невозможен при текущем размере диска
- indexes = 91 GB, VACUUM FULL нужно ~76 GB свободных (размер после compaction)
- Даже после VACUUM FULL documents будет ~36 GB свободных — не хватает
- **Решение:** либо увеличить диск, либо принять текущий размер indexes (16% bloat = терпимо)

### 4. Convex Dashboard admin key протухает быстро
- Ключ эфемерный, генерируется из INSTANCE_SECRET
- Каждая навигация на новый URL сбрасывает сессию → нужно перелогиниваться
- Переключение таблиц только через сайдбар, не через URL
- **Команда генерации:** `CONVEX_INSTANCE_SECRET=2de125637ad4cefdbb60e5e350aa0894545bc813a4bc296fcdbd3e3506490e19 node gen-key.cjs`

### 5. Невозможно узнать размер отдельной Convex-таблицы в байтах
- Convex хранит все таблицы в двух PostgreSQL таблицах: `indexes` и `documents`
- Можно узнать только количество документов через Convex Dashboard
- Невозможно сказать "metricsDaily занимает X GB" — только "metricsDaily содержит 975K документов"
- Оценки размера в байтах — всегда приблизительные (средний размер документа × количество)

### 6. Docker cleanup через Dokploy — ограниченная эффективность
- Удалили stopped containers, unused images, build cache — освободили всего ~1.2 GB
- 96% диска занимает pgdata (125 GB) — Docker cleanup почти не помогает
- Dokploy daily docker cleanup включён, но не решает проблему роста PostgreSQL

### 7. metricsRealtime: bloat-генератор несмотря на работающий cleanup
- Cleanup работает, удаляет старые записи, количество документов стабильно (~3.25 млн)
- НО каждое удаление создаёт dead tuple в PostgreSQL. При ~800K записей/день × записи + удаления = ~1.6 млн операций/день
- Обычный autovacuum помечает dead tuples для переиспользования, но НЕ возвращает место ОС
- Результат: таблица `documents` = 32 GB на диске при ~8-10 GB живых данных (73% bloat)
- Это хроническая проблема — без периодического VACUUM FULL bloat будет расти

## План действий (порядок выполнения)

### Этап 1: Сократить данные (безопасно, без даунтайма) ✅ РЕАЛИЗОВАНО 23.04
1. ✅ Сократить `RETENTION_DAYS` с 4 до 2 в `convex/metrics.ts`
2. ✅ Добавить cleanup cron для `metricsDaily` (90 дней retention, 500/час — постепенно)
3. ✅ Добавить cleanup cron для `actionLogs` (90 дней retention)
4. ✅ Сократить retention: systemLogs 30→10 дн, auditLog 90→10 дн, aiGenerations 60→35 дн
5. ✅ Добавить индексы: `actionLogs.by_createdAt`, `metricsDaily.by_date`
6. ⬜ Задеплоить → cleanup автоматически удалит старые данные
7. ✅ metricsDaily cleanup постепенный: 500 записей/час ≈ 12K/день. Бэклог ~720K очистится за ~60 дней без нагрузки

**Ожидаемый результат:** удалено ~1.6 млн metricsRealtime + ~720K metricsDaily + ~120K actionLogs = ~2.4 млн документов. Dead tuples увеличатся временно, но потом autovacuum переиспользует их.

### Этап 2: VACUUM FULL documents (даунтайм ~10-30 мин)
1. Дождаться завершения cleanup из этапа 1 (проверить через Dashboard)
2. Выполнить `VACUUM FULL VERBOSE documents` — освободит ~22 GB
3. Нужно 14 GB свободных — хватает

### Этап 3: pg_dump бэкап
1. После этапа 2 будет ~36 GB свободных
2. Выполнить pg_dump с compression (`-Fc`) — ожидаемый размер ~10-20 GB
3. Скопировать дамп на внешнее хранилище

### Этап 4: (опционально) VACUUM FULL indexes
- Нужно ~76 GB свободных
- После этапов 1-3: ~36 GB + экономия от cleanup ≈ может хватить, надо считать
- Если не хватает — увеличить диск или принять 16% bloat в indexes

## Критические предупреждения

- **НИКОГДА не удалять volume `adpilot-convex-pgdata`** — это ВСЕ данные Convex
- **VACUUM FULL безопасен** — удаляет только мёртвые строки, живые данные не трогает
- **pg_dump перед рискованными операциями** — но нужно достаточно свободного места
- **Бэкап hoster.by от 21.04.2026** — последний известный полный бэкап сервера

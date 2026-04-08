# Service Diagnostic — Design Spec

## Назначение

Автоматическая диагностика работоспособности сервиса AdPilot. Находит все проблемы, включая скрытые (silent failures). Отчёт приходит в Telegram.

## Архитектура: Convex-native + внешний ping

```
ВНЕШНИЙ СЕРВЕР (178.172.235.49):
  cron каждые 15 мин:
    ping https://convex.aipilot.by
    ping https://aipilot.by
    если не отвечает 2 раза подряд -> Telegram алерт

CONVEX (внутри сервиса):
  crons.ts:
    "system-health-check"    каждые 6ч   -> Цикл 1
    "function-verification"  каждые 12ч  -> Цикл 2

  convex/healthCheck.ts      — логика проверок
  convex/healthReport.ts     — форматирование + отправка в Telegram

  Админ-панель:
    Кнопка "Быстрая проверка"         -> Цикл 1
    Кнопка "Полная диагностика"       -> Цикл 2
    Кнопка "Диагностика пользователя" -> Цикл 2 для одного userId
```

## Общие принципы

- Все проверки — для ВСЕХ пользователей с хотя бы 1 кабинетом (freemium/start/pro одинаково)
- Тариф влияет только на лимиты, не на то, проверяем ли мы работоспособность
- Каждый блок заканчивается вердиктом: ok / warning / error с конкретными данными
- Не верить "всё success" — сверять ожидаемое с фактическим (M из N кампаний обработано)
- Не верить своим данным — сверять с VK API напрямую
- Трассировать код с реальными числами при любой аномалии

---

## Цикл 1: Здоровье системы

Частота: каждые 6 часов (00:00, 06:00, 12:00, 18:00 UTC).
Скорость: 5-15 секунд. Только внутренние данные, без VK API.
Telegram: только при проблемах (warning/error). Silent when green.

### Блок 1.1: Кроны (heartbeat)

Источник: таблица `cronHeartbeats`.

Проверяем:
- sync-metrics: status != "running" > 10 мин -> STUCK (error)
- uz-budget-increase: finishedAt < now - 15 мин -> STALE (warning)
- daily-digest, weekly-digest, monthly-digest: finishedAt exists
- agency-token-health: finishedAt < now - 12ч -> warning
- Любой крон с error != null -> error

Вердикт: "ok: все кроны в норме" / "warning: N отстают" / "error: N застряли"

### Блок 1.2: Токены пользователей

Источник: таблица `users` (все у кого есть хотя бы 1 кабинет в `adAccounts`).

Проверяем для каждого:
- vkAdsTokenExpiresAt < now -> EXPIRED (error)
- vkAdsTokenExpiresAt < now + 24ч -> EXPIRING (warning)
- vkAdsRefreshToken == null -> NO_REFRESH (warning)
- vkTokenExpiresAt (VK ID) аналогично

Группировка в отчёте: платные (start/pro) первыми, бесплатные (freemium) вторыми.

Вердикт: "ok: все токены валидны" / "warning: N истекают в 24ч" / "error: N истекли"

### Блок 1.3: Кабинеты и синхронизация

Источник: таблица `adAccounts` (status != "paused").

Проверяем для каждого активного кабинета:
- status == "error" -> error
- lastSyncAt < now - 15 мин -> SYNC_STALE (warning)
- lastError != null -> warning с текстом ошибки
- tokenExpiresAt < now -> ACCOUNT_TOKEN_EXPIRED (error)
- Агентский кабинет (vitaminCabinetId) без VITAMIN_API_KEY -> warning
- accessToken == null -> MISSING_TOKEN (error)
- clientId == null AND clientSecret == null AND нет user-level credentials (vkAdsClientId/vkAdsClientSecret) -> NO_CREDENTIALS (warning) — refresh невозможен при истечении токена
- status == "error" и createdAt за последние 24ч -> CONNECT_FAILED (warning): "Кабинет '{name}' не подключился: {lastError}"
- lastSyncAt == null (ни разу не синхронизировался) -> NEVER_SYNCED (error): подключён но не работает

Вердикт: "ok: N/N синхронизируются" / "warning: N отстают / N не подключились" / "error: N в ошибке"

### Блок 1.4: Уведомления

Источник: таблица `notifications` (за последние 24ч).

Проверяем:
- status="failed" -> error с количеством
- Все пользователи с активными правилами имеют telegramChatId -> warning если нет

Вердикт: "ok: все доставлены" / "warning: N пользователей без Telegram" / "error: N не доставлено"

### Блок 1.5: Платежи

Источник: таблица `payments`.

Проверяем:
- status="pending" и createdAt < now - 2ч -> STUCK_PAYMENT (warning)
- Пользователи с subscriptionExpiresAt < now но tier != "freemium" -> EXPIRED_NOT_DOWNGRADED (error)

Вердикт: "ok" / "warning: N зависших платежей" / "error: N не даунгрейднутых"

### Блок 1.6: Подписки

Источник: таблица `users`.

Проверяем:
- subscriptionExpiresAt < now + 48ч и tier != "freemium" -> EXPIRING_SOON (warning)
- Количество активных правил > лимит тарифа -> LIMIT_EXCEEDED (error)
- Количество активных кабинетов > лимит тарифа -> LIMIT_EXCEEDED (error)

Вердикт: "ok" / "warning: N подписок истекают" / "error: N превышают лимиты"

### Формат отчёта Цикл 1 (Telegram)

Отправляется ТОЛЬКО при проблемах:

```
Здоровье системы — 2 проблемы

[error] Кроны: sync-metrics STUCK (12 мин)
[ok] Токены: 5/5 валидны
[warning] Кабинеты: 1/12 отстаёт (Контрград — lastSync 18 мин назад)
[ok] Уведомления: 47/47 доставлены
[ok] Платежи: ок
[ok] Подписки: ок
```

---

## Цикл 2: Работа функций

Частота: каждые 12 часов (03:00, 15:00 UTC) + ручной запуск.
Скорость: 30-120 секунд. Включает VK API запросы, per-user с пагинацией. 10 блоков проверок.
Telegram: краткий summary ВСЕГДА + подробности только при проблемах.

### Пагинация

Все пользователи с хотя бы 1 кабинетом. Обработка по одному.
Таймаут на одного пользователя: 60 сек (пропустить и отметить warning TIMEOUT).
Таймаут на весь Цикл 2: 5 мин (завершить, отправить частичный отчёт).

### Блок 2.1: Профиль пользователя

Источник: `users`, `adAccounts`, `rules`.

Проверяем:
- Тариф и срок подписки
- Кол-во активных кабинетов vs лимит тарифа
- Кол-во активных правил vs лимит тарифа
- telegramChatId заполнен (если есть правила с notify)

Ищем:
- Правила с actions.stopAd=true у freemium -> error (не должно работать)
- Активных кабинетов/правил больше лимита -> LIMIT_BREACH (error)

### Блок 2.2: Токены — тестовый вызов

Источник: VK API (реальный запрос).

Для каждого кабинета пользователя:
1. `getValidTokenForAccount(accountId)` — получить токен
2. Тестовый вызов: `getCampaignsForAccount(accessToken)` — минимальный запрос

Ищем:
- TOKEN_EXPIRED -> error (refresh не работает)
- 403 Forbidden -> error (права отозваны)
- timeout -> warning (VK API медленный)
- success -> ok (токен рабочий)

Отличие от Цикла 1: Цикл 1 проверяет дату, Цикл 2 проверяет реальный вызов.

### Блок 2.3: Покрытие правил (правила vs логи)

Источник: `rules`, `actionLogs`.

Для каждого активного правила пользователя:
1. targetCampaignIds -> N целевых кампаний
2. actionLogs за сегодня по этому ruleId -> уникальные campaignId -> M обработанных
3. Если M < N -> какие кампании не обработаны?

Ищем:
- M < N -> COVERAGE_GAP (warning): "Правило '{name}': {M}/{N} кампаний обработано"
- M = 0 при N > 0 -> RULE_NOT_WORKING (error)
- Для uz_budget_manage: проверяем отдельно (свой крон, свои логи)

Исключения:
- Правило создано сегодня -> пропускаем (ещё не было цикла)
- Правило isActive=false -> пропускаем

### Блок 2.4: Реальный статус кампаний в VK

Источник: VK API (`getCampaignsForAccount`).

Для каждого кабинета (токен из блока 2.2):
1. Получить все кампании из VK API
2. Сравнить с нашей таблицей `campaigns`:
   - status расходится? (наш "active", VK "blocked") -> error
   - delivery расходится? -> warning
   - budget_limit_day: VK показывает бюджет, у нас нет записи -> warning

Ищем:
- Кампания active в VK но нет в нашей БД -> NOT_TRACKED (warning)
- Кампания в правиле, delivery=not_delivering, но нет логов увеличения -> NOT_PROCESSED (error)
- Кампания blocked/deleted в VK но active у нас -> STATUS_MISMATCH (warning)

### Блок 2.5: Трассировка логики правил

Источник: `metricsDaily`, `rules`, VK API.

Для каждой аномалии из блока 2.3 (coverage gap):
1. Получить spent из metricsDaily за сегодня
2. Получить условия правила (conditions)
3. Прогнать `evaluateCondition` / `shouldTriggerBudgetIncrease` с реальными числами
4. Объяснить ПОЧЕМУ правило не сработало

Пример вывода:
"Кампания 134206326: spent=102, budget=115, порог=90%. 102 >= 115*0.90 (103.5) -> FALSE. Причина: spent не дорос до порога"

Ищем:
- FALSE при not_delivering -> LOGIC_BUG (error) — должно срабатывать
- Spent=0 при active кампании -> NO_SPEND (warning) — кампания не крутится

### Блок 2.6: Динамика логов

Источник: `actionLogs` за сегодня.

Для каждого правила uz_budget_manage:
1. Все логи за сегодня, сортировка по времени
2. Анализ паттерна:

Здоровый паттерн:
```
09:15 budget 100->101, spent=100
09:20 budget 101->102, spent=101  <- spent растёт, gap 5 мин
```

Паттерн бага:
```
09:15 budget 100->101, spent=100
09:30 budget 101->102, spent=100  <- spent НЕ растёт, gap 15 мин
... логи прекращаются (порог 90% превышен)
```

Ищем:
- spent не растёт между увеличениями -> RESUME_NOT_WORKING (error)
- gap > 10 мин между увеличениями -> SLOW_CYCLE (warning)
- Логи прекратились при not_delivering -> STUCK_CAMPAIGN (error)

### Блок 2.7: Лиды — 5 источников

Источник: `metricsDaily` + VK API.

Для каждого кабинета с правилами, зависящими от лидов (cpl_limit, spend_no_leads, clicks_no_leads):
1. Получить leads из metricsDaily за сегодня
2. Если leads=0 для активной кампании с расходом -> проверить через VK API:
   - `diagnosLeads(adId)` -> какие из 5 источников вернули данные?

Ищем:
- Все 5 источников = 0 при spend > 0 -> NO_LEADS_DATA (warning)
- Lead Ads API вернул 404 -> LEAD_ADS_UNAVAILABLE (warning)
- Расхождение: наш leads=0, VK goals > 0 -> LEADS_MISMATCH (error)
- Типы данных: string вместо number -> TYPE_MISMATCH (error)

### Блок 2.8: Дедупликация и пересечения

Источник: `actionLogs`, `rules`.

Проверяем:

1. Дедупликация остановок:
   - actionLogs за сегодня: группировка по (adId, actionType="stopped")
   - count > 1 для одного adId -> DOUBLE_STOP (error)

2. Пересечение кампаний между UZ правилами:
   - Все активные uz_budget_manage правила пользователя
   - Intersection targetCampaignIds между ними
   - Пересечение > 0 -> CAMPAIGN_OVERLAP (error): "Кампания X в правилах Y и Z"

### Блок 2.9: Функциональность кабинетов

Источник: VK API (`fetchUzCampaigns`).

Для каждого активного кабинета (независимо от наличия правил):
1. Тестовый вызов `fetchUzCampaigns(accountId)`
2. Проверить что возвращает данные (adPlans.length > 0 или ungrouped.length > 0)
3. Сравнить с VK API: есть ли кампании в кабинете вообще?

Ищем:
- Fetch вернул ошибку (TOKEN_EXPIRED, 403, timeout) -> FETCH_FAILED (error) с причиной
- Пустой ответ при active кабинете с кампаниями в VK -> DATA_MISMATCH (error)
- Пустой ответ, кампаний в VK тоже нет -> NO_CAMPAIGNS (warning) — кабинет пуст
- Кабинет active, но нет UZ-пакета (adPlans пустой) -> NO_UZ_PACKAGE (warning) — не сможет создать UZ-правило

Зачем: ловит ситуацию Никиты Исаева — кабинеты подключены, но создать правило невозможно (группы не загружаются). Без этого блока пользователь сам обнаруживает проблему, а мы узнаём только по обращению.

### Блок 2.10: Перерасход бюджета

Источник: VK API (budget_limit_day + spent per group).

Для каждого кабинета с активным uz_budget_manage правилом:
1. Получить из VK API: `budget_limit_day` и `spent` для каждой группы (ad_group)
2. Сравнить spent vs budget

Ищем:
- spent > budget * 1.05 (перерасход >5%) -> OVERSPEND (warning): "Группа '{name}': бюджет {budget}, потрачено {spent} (+{diff})"
- spent > budget * 1.20 (перерасход >20%) -> CRITICAL_OVERSPEND (error)
- Множественный перерасход в одном кабинете (>3 групп) -> SYSTEMATIC_OVERSPEND (error) — UZ-правило слишком медленно увеличивает бюджет или race condition с VK

Зачем: ловит ситуацию Ольги (ООО "Странник") — бюджет 103, потрачено 106-110. Без этого блока перерасход обнаруживается только когда пользователь смотрит в VK Ads и замечает расхождение.

Примечание: VK допускает естественный перерасход ~5-10% (откручивает рекламу до обновления лимита). Порог warning на 5% отсекает шум, но ловит системные проблемы.

### Формат отчёта Цикл 2 (Telegram)

Всегда — краткий summary:

```
Диагностика функций — 08.04.2026 09:00

Проверено: 5 пользователей, 12 кабинетов, 18 правил

[ok] Ольга Чистякова (5 каб, 3 правила) — ок
[warning] Карина Контрград (3 каб, 2 правила) — 1 проблема
[ok] Иван Петров (1 каб, 1 правило) — ок
[ok] Анна Сидорова (1 каб, 2 правила) — ок
[error] Тула Лазер (2 каб, 1 правило) — 3 проблемы
```

При проблемах — подробности:

```
[warning] Карина Контрград:
  [warning] Кабинет "Контрград": lastSync 18 мин назад

[error] Тула Лазер:
  [error] Покрытие: правило "УЗ бюджет" — 3/18 кампаний обработано
  [error] Кампания 134206326: not_delivering, но нет логов увеличения
  [warning] Лиды: Lead Ads API недоступен для кабинета "Саратов"
```

### Отчёт для одного пользователя (ручной запуск)

Всегда полный:

```
Диагностика: Ольга Чистякова

Тариф: pro (до 15.05.2026)
Токены: [ok] VK ID, [ok] VK Ads (истекает через 12д)

Кабинет "Саратов" (active, sync 2 мин назад):
  [ok] Токен: рабочий (тестовый вызов ок)
  [ok] 12 кампаний в VK, 12 у нас

Кабинет "Уфа" (active, sync 3 мин назад):
  [ok] Токен: рабочий
  [warning] 8 кампаний в VK, 7 у нас — 1 не отслеживается

Правило "CPL лимит" (active):
  [ok] Покрытие: 20/20 кампаний обработано
  [ok] Сработало 3 раза сегодня

Правило "УЗ бюджет" (active):
  [error] Покрытие: 3/18 кампаний обработано
  [error] 15 кампаний не обработаны — причины:
    - 8: delivery=not_delivering, spent не растёт (resume?)
    - 5: spent=0, budget=0 (ожидаемо неактивны)
    - 2: не найдены в VK API (deleted?)
```

---

## Инфраструктура

### Внешний ping-скрипт

Файл: `scripts/external-ping.sh` (деплоится на сервер 178.172.235.49).
Cron: `*/15 * * * *`.

Проверяет:
1. `https://convex.aipilot.by` — Convex backend (HTTP 200?)
2. `https://aipilot.by` — Frontend (HTTP 200?)
3. `https://convex-site.aipilot.by/telegram` — Webhook endpoint (HTTP 405 = alive)

Защита от ложных срабатываний: алерт только при 2 подряд неудачных проверках.
Состояние хранится в `/tmp/addpilot_ping_state`.

### Ручной запуск из админки

Админ-панель -> кнопки:
1. "Быстрая проверка" -> `runManualSystemCheck()` — Цикл 1 (5-15 сек)
2. "Полная диагностика" -> `runManualFunctionCheck()` — Цикл 2 (30-120 сек)
3. "Диагностика пользователя" -> `runManualUserCheck(userId)` — Цикл 2 для одного

Результат: отправляется в Telegram + показывается inline в админке.

### Хранение результатов

Таблица `healthCheckResults`:
- type: "system" | "function" | "user"
- targetUserId: optional (для type="user")
- status: "ok" | "warning" | "error"
- summary: string
- details: object (полный результат по блокам)
- checkedUsers, checkedAccounts, checkedRules: number
- warnings, errors: number
- duration: number (мс)
- createdAt: number

Индексы: `by_type` (type + createdAt), `by_createdAt`.
Хранить 30 дней (cleanup в существующем cron cleanup).

### Cron-расписание

```
"system-health-check":   каждые 6ч  (00:00, 06:00, 12:00, 18:00 UTC)
"function-verification": каждые 12ч (03:00, 15:00 UTC)
```

Время подобрано вне пиков существующих кронов.

---

## Файловая структура

### Новые файлы

```
convex/healthCheck.ts       — логика проверок (Цикл 1 + Цикл 2)
convex/healthReport.ts      — форматирование Telegram-сообщений
scripts/external-ping.sh    — внешний ping-скрипт для сервера
```

### Изменения в существующих файлах

```
convex/schema.ts            — таблица healthCheckResults
convex/crons.ts             — 2 новых крон-задачи
src/pages/AdminPage.tsx     — кнопки диагностики + отображение результатов
```

### Экспортируемые функции healthCheck.ts

```
// Cron handlers
runSystemCheck: internalAction
runFunctionCheck: internalAction

// Ручной запуск из админки
runManualSystemCheck: action
runManualFunctionCheck: action
runManualUserCheck: action (args: userId)

// Результаты для админки
getLatestResults: query
getResultHistory: query (с пагинацией)

// Internal helpers (per-block)
checkCronHealth: internalQuery
checkTokenHealth: internalQuery
checkAccountSync: internalQuery
checkNotifications: internalQuery
checkPayments: internalQuery
checkSubscriptions: internalQuery
checkRuleCoverage: internalAction
checkVkStatus: internalAction
checkRuleLogic: internalAction
checkLogDynamics: internalQuery
checkLeadSources: internalAction
checkDeduplication: internalQuery
checkAccountFunctionality: internalAction
checkBudgetOverspend: internalAction
```

---

## Обработка ошибок

Принцип: диагностика НИКОГДА не должна падать целиком. Каждый блок обёрнут в try/catch.

- Если блок упал: записать warning CHECK_FAILED, продолжить следующий блок
- Если VK API не отвечает: пропустить VK-зависимые блоки (2.2, 2.4, 2.5, 2.7), выполнить внутренние
- Если один пользователь зависает > 60 сек: прервать, записать warning USER_TIMEOUT, перейти к следующему
- Если весь Цикл 2 > 5 мин: завершить, отправить частичный отчёт

### Защита от конфликтов с syncMetrics

Цикл 2 использует только read-only VK API запросы:
- `getCampaignsForAccount` — список кампаний
- `diagnosLeads` — диагностика лидов

Никаких мутаций (не стопаем объявления, не меняем бюджеты).
Расписание (03:00, 15:00 UTC) выбрано вне пиков syncMetrics.

---

## Скил-триггер

Файл: `docs/skills/service-diagnostic.md`
Триггер: диагностика сервиса, проверка работоспособности, мониторинг, health check, "почему не работает правило/кабинет/синхронизация"

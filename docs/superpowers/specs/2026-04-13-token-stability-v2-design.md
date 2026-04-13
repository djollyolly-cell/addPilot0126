# Token Stability v2 — Design Spec

**Дата**: 2026-04-13
**Цель**: Устранить каскадный отказ токенов и закрыть все 3 пути к ложной инвалидации.

## Контекст

13 апреля 2026 — массовая потеря токенов: 38 аккаунтов в `error`, 65+ с `tokenExpiresAt=0`. Причина — цепочка из багов, где один временный 401 от VK API запускает необратимую инвалидацию.

### Цепочка отказа (текущая)

```
VK API 401 (даже временный)
  → vkApi.ts: мгновенный TOKEN_EXPIRED (без retry)
    → syncMetrics/ruleEngine/uzBudgetCron: invalidateAccountToken
      → tokenExpiresAt = 0
        → auth.ts не распознаёт 0 как permanent
          → markRecoverySuccess НЕ сбрасывает tokenExpiresAt
            → бесконечный цикл error → recovery → error
```

3 точки входа в каскад: `syncMetrics.ts`, `ruleEngine.ts`, `uzBudgetCron.ts`. Текущий план фиксит только syncMetrics.

## Изменения

### 1. `tokenExpiresAt=0` как permanent token

**Файл**: `convex/auth.ts` (строки 921, 996)

Добавить `|| account.tokenExpiresAt === 0` в оба условия проверки permanent-токенов:

```typescript
if (account.tokenExpiresAt === undefined || account.tokenExpiresAt === null || account.tokenExpiresAt === 0) {
```

Без этого фикса все остальные изменения бессмысленны — `0` продолжит восприниматься как "протухший".

### 2. `markRecoverySuccess` сбрасывает tokenExpiresAt

**Файл**: `convex/tokenRecovery.ts` (строки 47-60)

Добавить optional аргумент `tokenExpiresAt` в `markRecoverySuccess`. После успешного recovery:
- Если передан `tokenExpiresAt` — ставим его (реальный expiry нового токена)
- Если не передан и текущий `=== 0` — сбрасываем в `undefined` (permanent)
- Если не передан и текущий нормальный — не трогаем

Существующие вызовы без аргумента продолжат работать (аргумент optional).

### 3. Retry 401 в vkApi

**Файл**: `convex/vkApi.ts` (callMtApi, postMtApi)

При получении 401 — один retry через 2с перед выбросом TOKEN_EXPIRED. Аналогично существующему retry для 429, но максимум 1 попытка. Применить во всех местах с `response.status === 401`.

### 4. Централизованный `handleTokenExpired` (подход B)

**Файл**: `convex/tokenRecovery.ts` — новая internalAction

```
handleTokenExpired(ctx, accountId):
  1. Получить аккаунт из БД
  2. quickTokenCheck(accessToken) → жив? → clear error status, return
  3. tryRecoverToken(accountId) → recovered? → return
  4. invalidateAccountToken(accountId) → только если оба шага провалились
```

Заменяет 3 разных блока обработки TOKEN_EXPIRED:
- `syncMetrics.ts:311-324` — вместо invalidate→recover
- `ruleEngine.ts:1961` — вместо invalidate без recover
- `uzBudgetCron.ts:96` — вместо invalidate без recover

Все 3 файла: удалить inline-обработку, заменить на один вызов `handleTokenExpired`.

### 5. Permanent-токены в proactive refresh

**Файл**: `convex/auth.ts` (строки 1786-1804, `getExpiringAccounts`)

Расширить фильтр: включить аккаунты с `tokenExpiresAt === undefined || null || 0` в proactive refresh. Они будут рефрешиться каждые 4 часа наравне с expiring-токенами, что даёт 5 попыток в пределах 24-часового окна artificial expiry.

## Что НЕ меняется

- **schema.ts** — ноль новых полей, ноль изменений схемы
- **Agency health check** (`checkAgencyTokenHealth`) — остаётся только для agency-аккаунтов, без изменений. У agency и прямых OAuth разная логика уведомлений и recovery.
- **Telegram-уведомления** — без изменений
- **Фронтенд** — без изменений
- **Публичные API** — без изменений

## Восстановление существующих аккаунтов

Migration script не нужен. После деплоя:
- Аккаунты с `tokenExpiresAt=0` и `status=active`: fix #1 распознает `0` как permanent → syncMetrics (каждые 5 мин) подберёт их автоматически
- Аккаунты с `status=error`: `retryRecovery` (каждые 4ч из proactiveTokenRefresh) подберёт их, fix #2 корректно сбросит tokenExpiresAt

## Порядок реализации

```
1. Fix #1 (tokenExpiresAt=0)        — фундамент
2. Fix #2 (markRecoverySuccess)      — разрывает петлю recovery
3. Fix #3 (retry 401 в vkApi)       — отсекает ложные 401
4. Fix #4 (handleTokenExpired)       — централизует verify→recover→invalidate
5. Fix #5 (permanent в refresh)      — превентивный мониторинг
```

## Метрики успеха (48ч после деплоя)

- 0 аккаунтов с `tokenExpiresAt=0` и `status=active` (все подобраны)
- 0 ложных инвалидаций от временных 401
- `[callMtApi] got 401, retrying` в логах — retry работает
- `[handleTokenExpired] false TOKEN_EXPIRED` — ложные 401 перехвачены
- Все 3 пути (syncMetrics, ruleEngine, uzBudgetCron) используют handleTokenExpired

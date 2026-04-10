# Resilient Token Recovery — Design Spec

**Date:** 2026-04-10
**Status:** Draft
**Problem:** Когда VK удаляет/отзывает токен аккаунта, система сдаётся после первой неудачи, не пробуя полный каскад восстановления. Аккаунт остаётся `status: "active"` с мёртвым токеном, забивает очередь синхронизации, пользователь не уведомлён.

---

## Три бага

1. **proactiveTokenRefresh** при UNRECOVERABLE ошибке очищает refreshToken и сдаётся, не вызывая полный каскад (6 методов) из `getValidTokenForAccount`
2. **`tokenExpiresAt === undefined`** — система считает токен бессрочным, возвращает мёртвый токен без проверки
3. **status остаётся "active"** после провала — аккаунт продолжает забивать батч синхронизации (40 слотов/цикл)

## Принцип безопасности

**auth.ts не теряет ни одной строки рабочего кода.** Вся новая логика — в отдельном файле `tokenRecovery.ts`. В существующие файлы добавляются только вызовы `tryRecoverToken()` перед тем как сдаться. Существующий каскад, agency-провайдеры, крон-расписание не модифицируются.

---

## Новый файл: `convex/tokenRecovery.ts`

### `tryRecoverToken(ctx, accountId)` — internalAction

Основная функция восстановления. Возвращает `boolean`.

**Алгоритм:**
1. Загрузить аккаунт из БД
2. Вызвать `getValidTokenForAccount(accountId)` — полный существующий каскад:
   - OAuth2 refresh (account-level → user-level fallback)
   - Agency client_credentials
   - GetUNIQ API
   - Click.ru API
   - ZaleyCash API
   - Vitamin API
3. Если каскад вернул токен → аккаунт жив:
   - `status: "active"`, очистить `tokenErrorSince`, `tokenRecoveryAttempts`
   - Return `true`
4. Если каскад провалился → попробовать user-level fallback:
   - Загрузить `users` запись владельца
   - Если есть `vkAdsAccessToken` + `vkAdsClientId` + `vkAdsClientSecret`:
     - Проверить через `quickTokenCheck(user.vkAdsAccessToken)`
     - Если жив → записать на аккаунт через `updateAccountCredentials`
     - Return `true`
5. Если всё провалилось:
   - `status: "error"`, `tokenErrorSince: Date.now()`, `tokenRecoveryAttempts: (prev + 1)`
   - Если это первая попытка (`tokenRecoveryAttempts === 1`): отправить Telegram пользователю
   - Return `false`

### `retryRecovery(ctx)` — internalAction

Вызывается из `proactiveTokenRefresh` (каждые 4ч).

**Алгоритм:**
1. Найти все аккаунты с `status: "error"` И `tokenErrorSince` задан
2. Для каждого:
   - Если `tokenErrorSince` > 7 дней → окончательный error: `tokenErrorSince: undefined`, не пробовать больше
   - Иначе → `tryRecoverToken(accountId)`
   - Если восстановлен → лог

### `quickTokenCheck(accessToken)` — вспомогательная функция

Лёгкая проверка жизнеспособности токена.

**Алгоритм:**
1. `GET https://target.my.com/api/v2/user.json` с `Authorization: Bearer {token}`
2. `200` → return `true`
3. `401/403` → return `false`
4. Сетевая ошибка/таймаут → return `true` (не ломаем, считаем живым)
5. Таймаут: 5 секунд

### `migrateUndefinedExpiry(ctx)` — internalAction (одноразовая)

Миграция для существующих аккаунтов с `tokenExpiresAt === undefined`.

**Алгоритм:**
1. Найти все аккаунты где `tokenExpiresAt` не задан и `accessToken` есть
2. Для каждого: `quickTokenCheck(accessToken)`
   - Жив → `tokenExpiresAt = Date.now() + 24 * 60 * 60 * 1000` (24ч, proactive refresh подхватит)
   - Мёртв → `tryRecoverToken(accountId)`
3. Лог результатов в Telegram (X живых, Y восстановлено, Z мёртвых)
4. Запускается вручную один раз после деплоя

---

## Изменения в существующих файлах

### `convex/auth.ts` — proactiveTokenRefresh (~15 строк)

**Точка изменения:** блок `if (isUnrecoverable(err))` (строки ~1509-1520)

**Было:**
```typescript
if (isUnrecoverable(err)) {
  await ctx.runMutation(internal.auth.clearAccountRefreshToken, { accountId: acc._id });
  failures.push(`Account "${acc.name}": НЕИСПРАВИМО — ${errMsg}. Refresh token очищен.`);
}
```

**Станет:**
```typescript
if (isUnrecoverable(err)) {
  await ctx.runMutation(internal.auth.clearAccountRefreshToken, { accountId: acc._id });
  const recovered = await ctx.runAction(internal.tokenRecovery.tryRecoverToken, { accountId: acc._id });
  if (recovered) {
    successes.push(`Account "${acc.name}": восстановлен через каскад после ${errMsg}`);
  } else {
    failures.push(`Account "${acc.name}": НЕИСПРАВИМО — ${errMsg}. Автовосстановление запущено (7 дней).`);
  }
}
```

**Добавить в конец proactiveTokenRefresh:** вызов `retryRecovery()` для аккаунтов в `token_error`.

### `convex/auth.ts` — getValidTokenForAccount (~10 строк)

**Точка изменения:** блок `if (!tokens.expiresAt)` (строки ~491-494 или ~955-957 в зависимости от сценария)

**Было:**
```typescript
if (!tokens.expiresAt) {
  return tokens.accessToken;
}
```

**Станет:**
```typescript
if (!tokens.expiresAt) {
  const alive = await quickTokenCheck(tokens.accessToken);
  if (alive) return tokens.accessToken;
  const recovered = await ctx.runAction(internal.tokenRecovery.tryRecoverToken, { accountId: args.accountId });
  if (recovered) {
    const fresh = await ctx.runQuery(internal.auth.getAccountWithCredentials, { accountId: args.accountId });
    if (fresh) return fresh.accessToken;
  }
  throw new Error("TOKEN_EXPIRED: токен недействителен и не удалось восстановить");
}
```

### `convex/syncMetrics.ts` — обработка TOKEN_EXPIRED (~5 строк)

**Точка изменения:** catch-блок при ошибке sync аккаунта (строки ~276-296)

**Было:**
```typescript
if (msg.includes("TOKEN_EXPIRED")) {
  await ctx.runMutation(internal.adAccounts.invalidateAccountToken, { accountId: account._id });
}
```

**Станет:**
```typescript
if (msg.includes("TOKEN_EXPIRED")) {
  await ctx.runMutation(internal.adAccounts.invalidateAccountToken, { accountId: account._id });
  await ctx.runAction(internal.tokenRecovery.tryRecoverToken, { accountId: account._id });
}
```

### `convex/schema.ts` — новые поля adAccounts (~2 строки)

```typescript
// Добавить в defineTable adAccounts:
tokenErrorSince: v.optional(v.number()),
tokenRecoveryAttempts: v.optional(v.number()),
```

Новый статус НЕ добавляется. Используется существующий `"error"` + наличие `tokenErrorSince` определяет что аккаунт в режиме автовосстановления.

---

## In-app баннер

### `src/pages/AccountsPage.tsx` (~20 строк)

Для аккаунтов с `status: "error"` и `tokenErrorSince`:

```
⚠️ Кабинет "X" — токен недействителен. Мониторинг приостановлен.
   Автовосстановление: попытка 3, осталось 5 дней.
   [Переподключить кабинет]
```

- Жёлтый warning-баннер (`bg-warning/10 text-warning`)
- Показывается вверху страницы кабинетов
- Кнопка "Переподключить" → OAuth flow для этого аккаунта
- Текст формируется из `tokenRecoveryAttempts` и `tokenErrorSince`

---

## Что НЕ меняется

- Весь существующий каскад в `getValidTokenForAccount` (6 методов)
- `refreshTokenForAccount`, `generateAgencyToken`
- Все agency-provider функции (tryVitamin, tryGetuniq, tryClickru, tryZaleycash)
- Крон-расписание в `crons.ts`
- `updateAccountTokens`, `updateAccountCredentials`
- Фронтенд кроме страницы кабинетов
- Логика синхронизации (батчинг, приоритеты, таймауты)

---

## Потоки данных

```
Proactive Refresh (каждые 4ч)
  ├─ Штатная работа: рефреш истекающих токенов [НЕ МЕНЯЕТСЯ]
  ├─ UNRECOVERABLE ошибка:
  │   └─ tryRecoverToken() [НОВОЕ]
  │       ├─ getValidTokenForAccount() [полный каскад, НЕ МЕНЯЕТСЯ]
  │       ├─ user-level fallback [НОВОЕ]
  │       └─ status="error" + tokenErrorSince [НОВОЕ]
  └─ retryRecovery() [НОВОЕ]
      └─ пробует tryRecoverToken() для error+tokenErrorSince < 7д

SyncMetrics (каждые 5 мин)
  ├─ Штатная синхронизация [НЕ МЕНЯЕТСЯ]
  └─ TOKEN_EXPIRED:
      ├─ invalidateAccountToken [НЕ МЕНЯЕТСЯ]
      └─ tryRecoverToken() [НОВОЕ]

getValidTokenForAccount
  ├─ tokenExpiresAt задан: штатная логика [НЕ МЕНЯЕТСЯ]
  └─ tokenExpiresAt === undefined:
      ├─ quickTokenCheck() → жив: return [НОВОЕ, безопасно]
      └─ quickTokenCheck() → мёртв: tryRecoverToken() [НОВОЕ]

In-app (AccountsPage)
  └─ status="error" + tokenErrorSince → warning баннер [НОВОЕ]
```

---

## Объём изменений

| Файл | Действие | ~Строк |
|------|----------|--------|
| `convex/tokenRecovery.ts` | Новый | ~150 |
| `convex/auth.ts` | Добавить вызовы | ~25 |
| `convex/syncMetrics.ts` | Добавить вызов | ~5 |
| `convex/schema.ts` | 2 поля | ~2 |
| `src/pages/AccountsPage.tsx` | Баннер | ~20 |
| **Итого** | | **~200** |

---

## Тестирование

- Unit-тесты для `tryRecoverToken`: mock каскада → success/failure paths
- Unit-тесты для `quickTokenCheck`: mock HTTP → 200/401/timeout
- Unit-тесты для `retryRecovery`: аккаунты с разным возрастом tokenErrorSince
- Integration: создать аккаунт с мёртвым токеном → проверить что каскад запускается
- E2E: проверить in-app баннер на AccountsPage

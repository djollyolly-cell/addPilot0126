# Спек: восстановление кабинетов и правил после оплаты + ручная активация

**Дата:** 2026-05-03
**Статус:** готов к реализации (v2 — после ревью)

## Контекст и проблема

При истечении подписки крон `processExpiredSubscriptions` (`convex/billing.ts:1444`) вызывает `updateLimitsOnDowngrade` (`convex/billing.ts:1332`), который:
- Переводит лишние (по новому лимиту) кабинеты в `status: "paused"`.
- Выключает лишние правила в `isActive: false`.

Обратной операции при апгрейде/продлении **нет**: при `payment.status = "completed"` (`convex/billing.ts:843`) обновляется только `subscriptionTier` и `subscriptionExpiresAt` пользователя — кабинеты остаются `paused`, правила `isActive: false`. В UI нет ни автоматизма, ни кнопки. На момент написания спеки найдено 9 пользователей с истёкшей подпиской, у части — paused-кабинеты, которые они физически не могут реактивировать.

Дополнительно: публичная мутация `api.adAccounts.updateStatus` (`convex/adAccounts.ts:1458`) принимает любой `status` без проверки лимита — теоретический bypass биллинга со стороны клиента.

## Решение — короткий тезис

1. **Primary (автомат):** при payment success вызывать новую `updateLimitsOnUpgrade`, которая активирует первые N paused-кабинетов и включает только те правила, которые были выключены биллингом (по маркеру `disabledByBillingAt`). Симметрично `updateLimitsOnDowngrade`.
2. **Fallback (ручной):** новая мутация `api.adAccounts.activate` + кнопка «Активировать» в `AccountCard` для тех paused-кабинетов, которые остались после auto-reactivation (превышение лимита, edge cases) или были отключены вручную в будущем.
3. **Hardening:** запретить `paused → active` через публичный `updateStatus` (без миграции в `internalMutation` — это ломает 10 callers в `syncMetrics.ts`).
4. **UX-разрыв правил:** контекстный CTA на `/accounts` (окно 7 дней после reactivation event) для правил, которые auto-reactivation не вернёт — юзер-выключенные (без маркера) и `video_rotation` (сознательно не реактивируем). Ведёт в `/rules`.

## Скоуп

**В скоупе:**
- Schema: `rules.disabledByBillingAt: v.optional(v.number())` + `users.lastReactivationAt: v.optional(v.number())`.
- Backend: `updateLimitsOnDowngrade` ставит `disabledByBillingAt = Date.now()` при выключении правила (кроме `video_rotation`); для `video_rotation` дополнительно дёргает `internal.videoRotation.deactivate` (сейчас downgrade этого не делает — открытый bug).
- Backend: новая `updateLimitsOnUpgrade` internalMutation; вызов из payment success flow (две точки: bePaid webhook + mock processPayment).
- Backend: новая публичная `api.adAccounts.activate` (manual fallback) — стампит `lastReactivationAt`.
- Backend: helper `patchRuleAndClearBillingMarker`; `rules.update` / `rules.toggleActive` физически удаляют `disabledByBillingAt` через `replace()` при ручных изменениях.
- Backend hardening: `updateStatus` запрещает `paused → active` в публичном пути (вариант (b) — без internal-миграции).
- Backend: query `getReactivationCta` для контекстного баннера.
- Frontend: кнопка «Активировать» в `AccountCard` для `status === "paused"`.
- Frontend: page-level message «Кабинет активирован, данные обновятся в течение 5 минут».
- Frontend: контекстный CTA в `/accounts` (окно 7 дней после reactivation), показывает count + флаг про video_rotation.
- Audit log: `account_activated` (source: `manual` | `auto_reactivation`), `rule_reactivated` (только auto_reactivation).
- Тесты: unit (мутации, маркер lifecycle, replace, идемпотентность, CTA-окно) + E2E (UI activate, CTA).

**Вне скоупа (отдельные тикеты):**
- Централизация `effective tier` логики в `convex/billing.ts` (сейчас helper `getEffectiveTier` живёт в `rules.ts:893`; `connect` дублирует; `activate` в этой задаче **временно использует inline resolve** — не reuse, см. Решение 6). Follow-up: вынести в `billing.ts` как single source of truth (`resolveAccountLimits(ctx, account, user)`) и обновить `connect`, `activate`, `toggleActive`.
- `users.getLimits` усage badge показывает `5/3` (считает все аккаунты), а `activate` лимитирует `active + abandoned`. Расхождение задокументировано, фикс — отдельным тикетом.
- Кнопка «Приостановить» — рассматривается отдельно.
- `syncNow` после активации — не делаем, ждём 5-мин крон.
- Реактивация `error` / `abandoned` / `archived` — другие домены.

## Backend

### 1. Schema changes

`convex/schema.ts` — таблица `rules`:

```typescript
disabledByBillingAt: v.optional(v.number()),
```

Таблица `users`:

```typescript
lastReactivationAt: v.optional(v.number()),
```

Никаких новых индексов. Миграция не нужна — `optional` поля появляются по факту первой записи.

### 2. `updateLimitsOnDowngrade` — выставлять маркер (кроме `video_rotation`) + останавливать ротацию

В `convex/billing.ts:1390` модифицировать цикл выключения правил: для не-`video_rotation` ставить маркер; для `video_rotation` — дёргать deactivate scheduler. Полный код блока — ниже под обоснованием.

**Почему `video_rotation` исключается из маркировки:**
- Это активное правило, которое **меняет креативы** в кабинете (не reactive-мониторинг). За время простоя подписки юзер мог удалить часть видео, переименовать кампании, сменить стратегию. Авто-старт ротации со старым списком при upgrade = реальный мусор в кабинете.
- В `rules.toggleActive` для `video_rotation` уже есть `validateRotationConflicts` и `validateNoConflictingRules` — ручное включение в `/rules` пройдёт через эти проверки. Auto-reactivation мимо валидации — небезопасно.
- Reactive-правила (cpl_limit, min_ctr, fast_spend и т.д.) безопасны: срабатывают только на реальную плохую статистику сегодня, устаревание им не страшно.

**Поведение для `video_rotation` при downgrade:**
- Правило выключается (`isActive: false`).
- **Останавливаем фоновый процесс ротации** через `ctx.scheduler.runAfter(0, internal.videoRotation.deactivate, { ruleId: rule._id })`. Сейчас `updateLimitsOnDowngrade` этого НЕ делает — только `rules.toggleActive` (`convex/rules.ts:917`) корректно дёргает scheduler. Без этого вызова ротация продолжит крутиться до следующего health check, что особенно опасно если кабинет тоже paused (статус несинхронизирован). Добавляем вызов в downgrade-цикл рядом с patch'ем правила.
- Маркер `disabledByBillingAt` НЕ ставится → upgrade его не реактивирует.
- Юзер в `/rules` сам включит, когда убедится, что ротация всё ещё актуальна.

Полный код блока:
```typescript
for (const rule of rulesToDeactivate) {
  const isRotation = rule.type === "video_rotation";
  await ctx.db.patch(rule._id, {
    isActive: false,
    updatedAt: Date.now(),
    ...(isRotation ? {} : { disabledByBillingAt: Date.now() }),
  });
  if (isRotation) {
    await ctx.scheduler.runAfter(0, internal.videoRotation.deactivate, { ruleId: rule._id });
  }
  deactivatedRuleIds.push(rule._id);
}
```

Кабинеты маркер не получают (для них реактивация идёт по `status === "paused"` напрямую, см. п.3).

### 3. `updateLimitsOnUpgrade` — новая internalMutation

Файл: `convex/billing.ts` (рядом с `updateLimitsOnDowngrade`).

```typescript
export const updateLimitsOnUpgrade = internalMutation({
  args: {
    userId: v.id("users"),
    newTier: v.union(
      v.literal("freemium"),
      v.literal("start"),
      v.literal("pro")
    ),
  },
  handler: async (ctx, args) => {
    // Skip org-members — symmetric to updateLimitsOnDowngrade
    const user = await ctx.db.get(args.userId);
    if (!user) return { accountsActivated: 0, rulesReactivated: 0 };
    if (user.organizationId) {
      return {
        accountsActivated: 0,
        rulesReactivated: 0,
        skipped: "user is in organization, upgrade flow N/A",
      };
    }

    // Compute new account limit
    const newAccountLimit =
      args.newTier === "pro"
        ? user.proAccountLimit ?? TIERS.pro.accountsLimit
        : TIERS[args.newTier].accountsLimit;

    // Reactivate paused accounts up to limit (oldest first)
    const accounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    const activeCount = accounts.filter(
      (a) => a.status === "active" || a.status === "abandoned"
    ).length;
    const pausedAccounts = accounts
      .filter((a) => a.status === "paused")
      .sort((a, b) => a.createdAt - b.createdAt);

    const slotsAvailable = newAccountLimit < 0 ? pausedAccounts.length : Math.max(0, newAccountLimit - activeCount);
    const accountsToActivate = pausedAccounts.slice(0, slotsAvailable);

    let reactivatedAt: number | null = null;
    for (const account of accountsToActivate) {
      await ctx.db.patch(account._id, { status: "active" });
      reactivatedAt = Date.now();
      try { await ctx.runMutation(internal.auditLog.log, {
        userId: args.userId,
        category: "account",
        action: "account_activated",
        status: "success",
        details: { accountName: account.name, vkAccountId: account.vkAccountId, source: "auto_reactivation" },
      }); } catch { /* non-critical */ }
    }

    // Reactivate ONLY billing-disabled reactive rules — never touch user-disabled
    // and never touch video_rotation (belt-and-suspenders: marker shouldn't exist on rotation,
    // but defensive filter protects against marker leaks via migrations / manual patches).
    const newRulesLimit =
      TIERS[args.newTier].rulesLimit === -1
        ? Infinity
        : TIERS[args.newTier].rulesLimit;

    const rules = await ctx.db
      .query("rules")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    const activeRulesCount = rules.filter((r) => r.isActive).length;
    const billingDisabledRules = rules
      .filter((r) =>
        !r.isActive &&
        r.disabledByBillingAt !== undefined &&
        r.type !== "video_rotation"
      )
      .sort((a, b) => (a.disabledByBillingAt ?? 0) - (b.disabledByBillingAt ?? 0));

    const ruleSlotsAvailable = Math.max(0, newRulesLimit - activeRulesCount);
    const rulesToReactivate = billingDisabledRules.slice(0, ruleSlotsAvailable);

    for (const rule of rulesToReactivate) {
      // Physically remove disabledByBillingAt via replace() — patch({ field: undefined })
      // is a no-op in Convex (project rule, see CLAUDE.md). Without removal:
      // (a) future re-runs of this mutation would re-process the same rule (idempotency break),
      // (b) audit log would duplicate, (c) rules.toggleActive cleanup logic gets confused.
      // CRITICAL #1: ctx.db.replace(id, value) expects body WITHOUT system fields (_id, _creationTime).
      // Must destructure them out — otherwise Convex throws.
      // CRITICAL #2: здесь все накатываемые поля (isActive, updatedAt) — concrete defined values,
      // никаких optional undefined. Если позже добавишь новое поле в этот replace, убедись что оно
      // не undefined (используй cleanPatch паттерн как в patchRuleAndClearBillingMarker).
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _id, _creationTime, disabledByBillingAt: _drop, ...rest } = rule;
      await ctx.db.replace(rule._id, {
        ...rest,
        isActive: true,
        updatedAt: Date.now(),
      });
      reactivatedAt = Date.now();
      try { await ctx.runMutation(internal.auditLog.log, {
        userId: args.userId,
        category: "rule",
        action: "rule_reactivated",
        status: "success",
        details: { ruleName: rule.name, source: "auto_reactivation" },
      }); } catch { /* non-critical */ }
    }

    // Stamp lastReactivationAt for contextual CTA (see Frontend section)
    if (reactivatedAt) {
      await ctx.db.patch(args.userId, { lastReactivationAt: reactivatedAt });
    }

    return {
      accountsActivated: accountsToActivate.length,
      rulesReactivated: rulesToReactivate.length,
    };
  },
});
```

**Решения:**
- Skip org-members симметрично downgrade — у них своя grace policy.
- Сортировка paused — `createdAt asc` (старейшие первыми), как в downgrade.
- Сортировка билинг-выключенных правил — `disabledByBillingAt asc` (выключенные раньше — реактивируются раньше). Это покрывает ступенчатый downgrade pro → start → freemium → upgrade обратно: правила, выключенные первым downgrade, поднимаются в первую очередь.
- **`disabledByBillingAt` физически удаляем через `replace()`.** `patch({ field: undefined })` в Convex skip-ает поле (зафиксировано в CLAUDE.md). Без физического удаления повторный вызов upgrade-мутации (например, после payment webhook retry) повторно нашёл бы те же правила в `billingDisabledRules` и записал бы дубль audit log. Replace гарантирует идемпотентность.
- **video_rotation двойная защита:** маркер не выставляется в downgrade + явный фильтр `r.type !== "video_rotation"` здесь. Если кто-то случайно добавит маркер ротации (миграция, ручной patch), upgrade всё равно её пропустит.
- **`lastReactivationAt` штампуем на user**, если реально что-то реактивировали (не пустой холостой вызов). Используется для контекстного CTA на frontend (см. секцию Frontend).
- Args union — `freemium | start | pro` (agency идёт через `organizations.updateSubscriptionFromPayment`). Поэтому ветка `newAccountLimit === -1` сейчас недостижима — оставлена в коде для безопасности при будущем расширении args, но НЕ покрывается тестами и не должна влиять на review.

### 4. Точки вызова `updateLimitsOnUpgrade`

**Все** payment-flow'ы, которые поднимают `subscriptionTier` user'а, должны вызвать `updateLimitsOnUpgrade`. Если пропустить любую — auto-reactivation работает в части окружений и не работает в других, что даёт ложные тесты.

| Файл / линия | Что | Когда вызывать |
|---|---|---|
| `convex/billing.ts:843` | Реальный bePaid webhook success (индивидуальная ветка после `if (payment.orgId)`) | Сразу после `ctx.db.patch(payment.userId, { subscriptionTier, ... })` |
| `convex/billing.ts:953` (`processPayment`) | Mock-flow для dev/manual ручной отметки оплаты | После patch user (≈ строка 1064) |
| Любой будущий admin-flow `setTier` / `grantSubscription` | — | Сразу после patch user |

Шаблон вызова одинаковый:
```typescript
await ctx.runMutation(internal.billing.updateLimitsOnUpgrade, {
  userId: payment.userId, // или args.userId для admin-flow
  newTier: payment.tier as "freemium" | "start" | "pro",
});
```

Org-ветка (`internal.organizations.updateSubscriptionFromPayment:854`) — не трогаем: org-юзеры пропускаются и downgrade'ом, и upgrade'ом.

**Edge case — ступенчатый upgrade:** юзер платит start, потом сразу pro. Каждая успешная оплата вызовет `updateLimitsOnUpgrade` со своим `newTier`. Идемпотентно: вторая итерация просто доберёт оставшиеся paused/disabled до нового лимита.

**Edge case — webhook retry:** если bePaid webhook ретраится, `updateLimitsOnUpgrade` вызывается повторно. Благодаря `replace()` (см. п.3) маркер уже физически снят → `billingDisabledRules` пуст → audit log не дублируется → idempotent.

### 5. `rules.update` и `rules.toggleActive` — чистить маркер при ручных изменениях

Если юзер сам меняет правило (toggle или update), маркер биллинга больше не отражает реальность. Иначе сценарий:
1. downgrade → rule.isActive=false, disabledByBillingAt=T1
2. юзер открывает /rules, осознанно включает (через toggleActive) → isActive=true, маркер остаётся T1
3. юзер сразу выключает обратно (передумал) → isActive=false, маркер всё ещё T1
4. upgrade → правило неожиданно реактивируется (юзер не хотел)

Фикс: в `rules.toggleActive` (`convex/rules.ts:861`) и в `rules.update` (`convex/rules.ts:615`), если у правила есть `disabledByBillingAt` — снять его через `replace()`. Если нет — обычный `patch()`.

Помощник для встраивания в обе мутации (можно вынести в `convex/rules.ts` локально):

```typescript
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

// Tighter type than Partial<Doc>: запрещает передачу системных полей _id / _creationTime,
// чтобы caller не мог случайно их перезаписать или попытаться положить в replace.
type RulePatch = Partial<Omit<Doc<"rules">, "_id" | "_creationTime">>;

async function patchRuleAndClearBillingMarker(
  ctx: MutationCtx,
  ruleId: Id<"rules">,
  patch: RulePatch
): Promise<void> {
  const rule = await ctx.db.get(ruleId);
  if (!rule) throw new Error("Правило не найдено");

  // Strip undefined-valued keys from patch so они не попадут в replace.
  // Если caller передаст { name: undefined } по optional полю — без фильтра это уйдёт в replace
  // и нарушит схему (или семантически перетрёт существующее значение). cleanPatch собирает
  // только реально переданные поля.
  const cleanPatch = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined)
  ) as RulePatch;

  if (rule.disabledByBillingAt !== undefined) {
    // Physical removal via replace — patch({ field: undefined }) is no-op in Convex.
    // CRITICAL: replace(id, value) expects body WITHOUT system fields. Must destructure
    // _id and _creationTime out, otherwise Convex throws schema validation error.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _id, _creationTime, disabledByBillingAt: _drop, ...rest } = rule;
    await ctx.db.replace(ruleId, { ...rest, ...cleanPatch, updatedAt: Date.now() });
  } else {
    await ctx.db.patch(ruleId, { ...cleanPatch, updatedAt: Date.now() });
  }
}
```

Использование в `toggleActive`:
```typescript
await patchRuleAndClearBillingMarker(ctx, args.ruleId, { isActive: newActive });
```

В `update`:
```typescript
await patchRuleAndClearBillingMarker(ctx, args.ruleId, {
  name: args.name,
  conditions: args.conditions,
  // ... все остальные поля как сейчас
});
```

Сам факт ручного редактирования = «правило стало моим, не биллинговым» → маркер снимаем даже если юзер не трогал `isActive`.

`rules.create` маркер не выставляет (новое правило — не биллингом выключено).

### 6. Hardening `updateStatus` — вариант (b)

Файл: `convex/adAccounts.ts:1458`. Заменить тело на:

```typescript
export const updateStatus = mutation({
  args: {
    accountId: v.id("adAccounts"),
    status: v.union(v.literal("active"), v.literal("paused"), v.literal("error"), v.literal("archived"), v.literal("abandoned")),
    lastError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Bypass guard: restoring paused → active must go through `activate`
    // (which enforces tier limits). All non-billing transitions remain allowed.
    if (args.status === "active") {
      const current = await ctx.db.get(args.accountId);
      if (current?.status === "paused") {
        throw new Error(
          "Используйте api.adAccounts.activate для возврата приостановленного кабинета — там проверка лимита тарифа."
        );
      }
    }

    await ctx.db.patch(args.accountId, {
      status: args.status,
      lastError: args.lastError,
    });
  },
});
```

**Почему вариант (b), не (a):**
- `api.adAccounts.updateStatus` вызывают **10 раз** в `convex/syncMetrics.ts` + 3 раза внутри `convex/adAccounts.ts` + 2 раза в `convex/adAccounts.test.ts`. Миграция в `internalMutation` ломает все 13 production-вызовов и требует переключения на `internal.adAccounts.updateStatus` + `runMutation`. Это раздувает PR на не связанную работу.
- Реальный риск — клиентский bypass `paused → active`. Точечный guard в публичном пути закрывает его при минимуме изменений.

**Что НЕ меняется:** все existing transitions (`error → active`, `active → paused`, `* → error`, `* → abandoned`, `* → archived`) работают как раньше.

**⚠️ Side-effect: `syncNow` для paused-кабинета.** В `convex/adAccounts.ts:1630/1640/1648` action `syncNow` после успешной синхронизации вызывает `updateStatus({ status: "active" })`. Если юзер вручную запустит sync на paused-кабинете, новый guard кинет ошибку «Используйте activate». Это **намеренное поведение** — paused оживляется ТОЛЬКО через `activate` (там проверка лимита). Чтобы юзер не упёрся в эту ошибку, **нужно скрыть кнопку sync для paused в `AccountCard.tsx`** (см. Frontend секцию). Backend-изменений в syncNow не требуется — guard правильно ловит этот случай.

**Зафиксированное правило:** `paused → active` — единственный путь через `api.adAccounts.activate`. `syncNow` для paused = noop с явной ошибкой.

### 7. `api.adAccounts.activate` — manual fallback

Файл: `convex/adAccounts.ts`.

```typescript
export const activate = mutation({
  args: {
    accountId: v.id("adAccounts"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) throw new Error("Кабинет не найден");
    if (account.userId !== args.userId) throw new Error("Нет доступа");
    if (account.status !== "paused") {
      throw new Error("Активировать можно только приостановленный кабинет");
    }

    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("Пользователь не найден");

    // Effective tier: account.orgId wins over user.organizationId.
    // Reuses helper already exported from rules.ts (see follow-up: move to billing.ts).
    const ownerOrgId = account.orgId ?? user.organizationId;
    let effectiveTier: SubscriptionTier;
    if (ownerOrgId) {
      const org = await ctx.db.get(ownerOrgId);
      if (!org) throw new Error("Организация не найдена");
      // Optional: respect org grace phase
      if (org.expiredGracePhase === "frozen") {
        throw new Error("Подписка организации заморожена. Продлите подписку.");
      }
      effectiveTier = org.subscriptionTier;
    } else {
      effectiveTier = (user.subscriptionTier ?? "freemium") as SubscriptionTier;
    }

    const limit =
      effectiveTier === "pro"
        ? user.proAccountLimit ?? TIERS.pro.accountsLimit
        : TIERS[effectiveTier].accountsLimit;

    if (limit !== -1) {
      const accounts = await ctx.db
        .query("adAccounts")
        .withIndex("by_userId", (q) => q.eq("userId", args.userId))
        .collect();
      const activeCount = accounts.filter(
        (a) => a.status === "active" || a.status === "abandoned"
      ).length;
      if (activeCount + 1 > limit) {
        const tierName = TIERS[effectiveTier].name;
        throw new Error(
          `Лимит активных кабинетов на тарифе ${tierName}: ${limit}. Продлите подписку или отключите другой кабинет.`
        );
      }
    }

    await ctx.db.patch(args.accountId, { status: "active" });
    await ctx.db.patch(args.userId, { lastReactivationAt: Date.now() });

    try { await ctx.runMutation(internal.auditLog.log, {
      userId: args.userId,
      category: "account",
      action: "account_activated",
      status: "success",
      details: { accountName: account.name, vkAccountId: account.vkAccountId, source: "manual" },
    }); } catch { /* non-critical */ }

    return { success: true };
  },
});
```

**Зафиксированные решения:**
- **`lastError` не очищаем — и не обещаем.** Существующий `clearSyncErrors` (`convex/adAccounts.ts:1432-1444`) использует `patch({ consecutiveSyncErrors: undefined, lastSyncError: undefined })` — это no-op в Convex (поля остаются после первого успешного sync). Это **pre-existing bug** в проекте, починка вне скоупа этой задачи. Соответственно: после `activate` юзер может ещё какое-то время видеть старый `lastError` в UI до того, как `clearSyncErrors` будет переписан на `replace()` отдельным тикетом. Для текущей задачи это cosmetic issue, не блокер. Если решим починить здесь — отдельный мелкий PR с переходом `clearSyncErrors` на `replace()`.
- **Effective tier — приоритет `account.orgId`.** Если аккаунт принадлежит org A, а юзер в org B (или вышел из org), tier берём от owner-org аккаунта. Это безопаснее, чем `user.organizationId`.
- **Effective tier — inline-логика, не reuse.** `getEffectiveTier` (`convex/rules.ts:893`) возвращает только tier и не учитывает `account.orgId` / `proAccountLimit` / `org.expiredGracePhase`. В этой задаче пишем inline (5 строк) и НЕ переиспользуем helper, чтобы не плодить две сигнатуры. Централизация — отдельный follow-up `resolveAccountLimits(ctx, account, user)`.
- **Admin alert НЕ шлём.** Это re-enable, не connect и не incident. Telegram не должен спамить.
- **Audit log пишем** — пригодится для post-mortem.
- **`syncNow` НЕ запускаем** — следующий 5-мин крон подхватит.
- **Правила не реактивируем здесь** — `activate` касается только одного кабинета. Auto-reactivation правил живёт в `updateLimitsOnUpgrade` (привязана к payment, не к кабинету).
- **Race condition.** Convex использует optimistic concurrency: read-set фиксируется, при конфликтующей записи мутация ретраится. Параллельные `activate` на разные `accountId`, читающие тот же `accounts` list, **должны** конфликтовать (общий read из `adAccounts.by_userId`). Покрыть unit-тестом, не утверждать без проверки.

## Frontend

### Файл: `src/components/AccountCard.tsx`

`userId` уже приходит как prop (`AccountCard.tsx:24,64`).

В блок действий (рядом с disconnect, `AccountCard.tsx:223-272`, текущий стиль — icon-only `p-1.5 rounded-md`) добавить **icon-only кнопку** (для консистентности со стилем карточки):

```tsx
{account.status === 'paused' && (
  <button
    type="button"
    disabled={activating}
    onClick={async (e) => {
      e.stopPropagation();
      setActivating(true);
      try {
        await activateAccount({
          accountId: account._id as Id<"adAccounts">,
          userId: userId as Id<"users">,
        });
        onActivated?.("Кабинет активирован. Данные обновятся в течение 5 минут.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Ошибка активации";
        onActivationError?.(msg);
      } finally {
        setActivating(false);
      }
    }}
    className="p-1.5 rounded-md text-muted-foreground hover:text-green-600 hover:bg-green-50 transition-colors disabled:opacity-50"
    title="Активировать кабинет"
    data-testid={`activate-account-${account.vkAccountId}`}
  >
    {activating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
  </button>
)}
```

Хук:
```tsx
const activateAccount = useMutation(api.adAccounts.activate);
const [activating, setActivating] = useState(false);
```

**Скрыть sync button для paused.** В `AccountCard.tsx:285` сейчас:
```tsx
{account.status !== 'abandoned' && (<SyncButton ... />)}
```
Изменить на:
```tsx
{account.status !== 'abandoned' && account.status !== 'paused' && (<SyncButton ... />)}
```
Иначе клик по sync на paused сначала запустит синхронизацию, потом упрётся в `updateStatus` guard и юзер увидит непонятную ошибку. Для paused единственный action — кнопка «Активировать», которая делает всё сама.

### Файл: `src/pages/AccountsPage.tsx`

В `AccountsPage` уже есть `setError` / `setSuccess` (`AccountsPage.tsx:18-19`). Добавить пропсы-callbacks через `AccountList` → `AccountCard`:

```tsx
onActivated={(msg) => { setSuccess(msg); setTimeout(() => setSuccess(null), 5000); }}
onActivationError={(msg) => setError(msg)}
```

### Новое: контекстный CTA для выключенных правил

CTA показывается только в **окне 7 дней после reactivation event** (manual activate ИЛИ auto-reactivation после payment). Это не «постоянный nudge» — баннер появляется когда есть смысл напомнить («ты только что вернул кабинеты — проверь правила»), и сам исчезает через неделю.

Backend (`convex/rules.ts`):

```typescript
const REACTIVATION_CTA_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const getReactivationCta = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user?.lastReactivationAt) {
      return { show: false, count: 0, hasVideoRotation: false };
    }
    const withinWindow = Date.now() - user.lastReactivationAt < REACTIVATION_CTA_WINDOW_MS;
    if (!withinWindow) {
      return { show: false, count: 0, hasVideoRotation: false };
    }

    const rules = await ctx.db
      .query("rules")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    // Кандидаты на ручное включение: либо юзер выключил сам (нет маркера),
    // либо это video_rotation (мы её не авто-реактивируем).
    const candidates = rules.filter((r) =>
      !r.isActive && (r.disabledByBillingAt === undefined || r.type === "video_rotation")
    );

    return {
      show: candidates.length > 0,
      count: candidates.length,
      hasVideoRotation: candidates.some((r) => r.type === "video_rotation"),
    };
  },
});
```

Frontend (`src/pages/AccountsPage.tsx`):

```tsx
const cta = useQuery(api.rules.getReactivationCta, user?.userId ? { userId } : "skip");

{cta?.show && (
  <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm flex items-center justify-between" data-testid="reactivation-cta">
    <span>
      {cta.count} {pluralRules(cta.count)} требуют ручного включения в /rules
      {cta.hasVideoRotation && " (включая правила ротации видео — проверьте актуальность креативов перед запуском)"}
    </span>
    <Link to="/rules" className="font-medium hover:underline">Перейти →</Link>
  </div>
)}
```

**Решения:**
- 7 дней — баланс между «успеть напомнить» и «не надоесть». Если юзер не отреагировал за неделю — скорее всего, правила ему не нужны.
- Не делаем dismiss-кнопку: окно само закрывается, экстра-UX избыточен.
- Не показываем для юзеров без `lastReactivationAt` (новые юзеры, которые никогда ничего не реактивировали) — у них нет контекста, баннер был бы шумом.
- Reset через downgrade не делаем — `lastReactivationAt` живёт до следующего reactivation event. Это OK: если за окном 7 дней произошёл downgrade и юзер потом снова upgrade'нул, поле перезапишется свежим timestamp и окно начнётся заново.
- **CTA advisory-only.** Не пытаемся матчить выключенные правила к недавно активированным кабинетам — это потребовало бы tracking activation IDs и пересечения `targetAccountIds` правил со списком reactivated. Сложно и хрупко. Принимаем небольшой шум: если юзер реактивировал один кабинет, но выключенные правила касаются другого — баннер всё равно покажется. Это компромисс в пользу простоты. Если в проде окажется реальной проблемой — фиксим в follow-up.

## Сценарии и поведение

### Walkthrough 1 — был pro (5 кабинетов), оплатил start (3)

| Шаг | Состояние | Что видит юзер |
|---|---|---|
| До истечения pro | 5 active, 8 active rules | — |
| Подписка истекла, downgrade-крон (freemium: limit=1 acc, 3 rules) | 1 active + 4 paused, 3 active rules + 5 disabled с маркером (или меньше disabled, если правило `video_rotation` — оно не маркируется, см. §2) | Баннер «Подписка истекла» |
| Открывает /accounts | то же | Кнопка «Активировать» на 4 paused. CTA пока не показывается (нет recent reactivation event) |
| Оплатил start (limit=3 acc, 10 rules) | **Auto:** 3 active + 2 paused; rules: было 3 active, ruleSlotsAvailable=10-3=7, реактивируется min(5, 7)=5 → **8 active rules + 0 disabled** (если все 5 были reactive). `lastReactivationAt = now` | После редиректа с /pricing — 3 активных, 2 paused (превышение лимита start). Баннер «Подписка истекла» исчез. CTA показывается, если есть user-disabled или video_rotation правила |
| Клик «Активировать» на paused #1 | Ошибка: `Лимит активных кабинетов на тарифе Start: 3. Продлите подписку или отключите другой кабинет.` | Toast с ошибкой |
| Решает отключить один из active и активировать paused | 3 active + 1 paused | Работает |

### Walkthrough 2 — start (3) → freemium (1) → обратно start

| Шаг | Состояние |
|---|---|
| start (3 active, 5 active rules) | — |
| downgrade freemium | 1 active + 2 paused, 3 active rules + 2 disabled (маркер T1) |
| upgrade start | **Auto:** 3 active + 0 paused, 5 active rules (2 реактивированы по маркеру, маркер очищен) |

### Walkthrough 3 — юзер сам выключил правило, потом downgrade+upgrade

| Шаг | Состояние |
|---|---|
| start, 5 правил все active | 5 active, 0 disabled |
| юзер выключил правило R3 в /rules | 4 active (R1, R2, R4, R5); R3.isActive=false, disabledByBillingAt=undefined (НЕ маркер, ручное действие) |
| downgrade freemium (limit=3 rules) | Активных надо урезать с 4 до 3 → выключаем 1 правило с маркером (например R5 — самое новое из активных). Итог: 3 active (R1, R2, R4) + R5 disabled с маркером T2 + R3 disabled без маркера. **Auto также активирует одно paused-правило?** Нет, только реактивирует ранее маркированные — здесь ничего не было |
| upgrade start (limit=10 rules) | Auto: R5 реактивировано (по маркеру T2, маркер физически снят через replace). **R3 НЕ реактивировано** (нет маркера). `lastReactivationAt = now`. Итог: 4 active (R1, R2, R4, R5) + R3 disabled |
| Юзер на /accounts в первые 7 дней видит CTA | «1 правило требует ручного включения в /rules» |

### Edge cases

| Случай | Поведение |
|---|---|
| `freemium`, 0 active + 1 paused | Manual activate разрешён (1 ≤ 1) |
| `freemium`, 1 active + N paused, юзер кликнул activate | Ошибка лимита, статус не изменился |
| `pro` grandfathered (`proAccountLimit=27`) → start → обратно pro | Лимит = `user.proAccountLimit ?? TIERS.pro.accountsLimit`. Если поле есть — используем его (27); если нет — дефолт 9. Никакого «retroactively grandfathering» новых pro: payment не выставляет `proAccountLimit`, оно сохраняется только у тех, кто его уже имел. Покрыть тестом. |
| `tier=agency*` через org, manual activate | Resolve `account.orgId` → проверка `frozen` grace; если не frozen — активация проходит без count-limit |
| `tier=agency*` через org, auto-reactivation | Skip (симметрично downgrade — у org'ов отдельная grace policy) |
| `account.orgId` существует, но org удалена — manual activate | throw «Организация не найдена» (валидируем в момент resolve effective tier). |
| `user.organizationId` указывает на удалённую org — auto-reactivation | Skip silently с `{ skipped: "user is in organization, upgrade flow N/A" }`. Auto не пытается get'нуть org — early return по `if (user.organizationId)`. |
| Race: 2 параллельные activate на грани лимита | Convex optimistic concurrency должен сериализовать — read из `accounts` list пересекается. Покрыть unit-тестом. |
| Кабинет paused, токен мёртв | После activate первая sync → `error`. Это нормально. Юзер увидит и решит. |
| Юзер вручную выключил правило R3, потом downgrade выключил R4 (маркер) | После upgrade: R4 реактивировано, R3 нет. CTA показывает «1 правило выключено». ✅ |
| `updateStatus` вызвали с `paused → active` | throw «Используйте api.adAccounts.activate». Тест обязателен. |
| `updateStatus` вызвали с `error → active` | OK, проходит. Покрывает существующий syncMetrics flow. |
| Юзер платит start, потом сразу pro (ступенчатый upgrade) | Каждый payment вызывает `updateLimitsOnUpgrade` отдельно. Идемпотентно — второй вызов добивает оставшиеся paused/disabled до нового лимита. |
| Org grace `frozen`, юзер кликает activate | throw «Подписка организации заморожена» |
| Usage badge показывает `5/3` после downgrade | Известный gap (`getLimits` считает все, `activate` — active+abandoned). Не фиксим в этой задаче. |

## Тесты

### Unit (Vitest) — `convex/adAccounts.test.ts`

| Тест | Ожидание |
|---|---|
| paused → activate в пределах лимита | `status === "active"`. `lastError` не проверяем (не трогаем) |
| paused → activate с превышением | throw, текст содержит название тарифа и лимит |
| status=active → activate | throw «можно только приостановленный» |
| status=error/abandoned/archived → activate | throw |
| Чужой userId | throw «Нет доступа» |
| Несуществующий accountId | throw «Кабинет не найден» |
| pro с proAccountLimit=27 | лимит = 27 |
| pro без proAccountLimit | лимит = TIERS.pro.accountsLimit |
| account.orgId с agency tier | проверка count-limit пропущена |
| account.orgId, org удалена | throw «Организация не найдена» |
| account.orgId, org.expiredGracePhase=frozen | throw «Подписка организации заморожена» |
| account.orgId ≠ user.organizationId | tier берётся от account.orgId |
| Audit log записан с source="manual" | log entry exists, action="account_activated" |
| `lastReactivationAt` обновлён на user после успешного activate | поле = Date.now() ± delta |
| Race: 2 параллельные activate на грани лимита | Только одна успевает, вторая throws |
| `updateStatus`: `paused → active` | throw «Используйте activate» |
| `updateStatus`: `error → active` | OK, status patched |
| `updateStatus`: `active → paused` | OK |
| `syncNow` для paused-аккаунта | После успешной синхронизации внутренний `updateStatus(active)` ловит guard → throw. Это ожидаемо: paused оживляется только через `activate`. UI скрывает sync button для paused. |

### Unit — `convex/billing.test.ts` (новые)

| Тест | Ожидание |
|---|---|
| `updateLimitsOnDowngrade` ставит `disabledByBillingAt` на выключенных правилах (НЕ video_rotation) | timestamp ≈ Date.now() для reactive-правил |
| `updateLimitsOnDowngrade` НЕ ставит маркер на `video_rotation` | `disabledByBillingAt === undefined` для rotation-правил |
| `updateLimitsOnDowngrade` дёргает `internal.videoRotation.deactivate` для каждого выключаемого `video_rotation` | scheduler call зафиксирован в моке/spy |
| После downgrade `rotationState` для выключенного `video_rotation` правила остановлен | companion-запись либо удалена, либо `status: "stopped"` (зависит от текущей реализации `videoRotation.deactivate`) |
| `updateLimitsOnUpgrade` активирует paused и реактивирует только маркированные правила | счётчики совпадают |
| `updateLimitsOnUpgrade` НЕ реактивирует `video_rotation` (нет маркера → пропуск) | rotation-правило остаётся isActive=false |
| `updateLimitsOnUpgrade` физически удаляет `disabledByBillingAt` через replace() | поле отсутствует в записи (`disabledByBillingAt === undefined`) |
| Идемпотентность: повторный вызов `updateLimitsOnUpgrade` (webhook retry) | второй вызов: `accountsActivated=0, rulesReactivated=0`, audit log не дублируется |
| `lastReactivationAt` обновлён только если что-то реально реактивировано | пустой вызов (нет paused/disabled): поле не трогается |
| Mock `processPayment` (`billing.ts:953`) тоже триггерит `updateLimitsOnUpgrade` | после mock payment paused-кабинет реактивирован |
| `updateLimitsOnUpgrade` для org-member skip | `{ skipped: ... }` |
| `updateLimitsOnUpgrade` НЕ трогает правила без маркера (юзер сам выключил) | isActive остаётся false |
| `updateLimitsOnUpgrade` сортирует paused по createdAt asc | старейшие реактивируются первыми |
| `updateLimitsOnUpgrade` сортирует disabled rules по `disabledByBillingAt` asc | то же |
| Ступенчатый upgrade (start → pro): два вызова идемпотентны | финальное состояние = ожидаемое для pro |
| `updateLimitsOnUpgrade` при превышении лимита paused (newLimit < pausedCount + activeCount) | реактивирует только до лимита |

### Unit — `convex/rules.test.ts` (новые)

| Тест | Ожидание |
|---|---|
| `rules.toggleActive` физически удаляет `disabledByBillingAt` при включении (через replace) | поле отсутствует в записи |
| `rules.toggleActive` физически удаляет `disabledByBillingAt` при выключении (передумал) | поле отсутствует |
| `rules.toggleActive` без маркера: использует patch (не replace) | работает как раньше, без regression |
| `rules.update` физически удаляет `disabledByBillingAt` при любом редактировании | поле отсутствует |
| `rules.create` НЕ выставляет `disabledByBillingAt` | поле undefined по дефолту |
| `getReactivationCta` показывает (show=true) в окне 7 дней после reactivation | show=true, count > 0 |
| `getReactivationCta` НЕ показывает после 7 дней | show=false |
| `getReactivationCta` НЕ показывает для юзера без `lastReactivationAt` | show=false |
| `getReactivationCta` включает video_rotation в hasVideoRotation flag | hasVideoRotation=true если есть выключенное rotation-правило |
| `getReactivationCta` НЕ включает биллинг-выключенные reactive-правила в count | корректный count |

### E2E (Playwright) — `tests/`

Фикстуры через `convexTest` или прямой DB seed (см. существующие тесты в `tests/`):
- Юзер freemium с 1 active + 1 paused
- Юзер start с 1 active + 2 paused
- Юзер start с 1 правилом (isActive=false, без маркера)

| Тест | Шаги |
|---|---|
| Кнопка `activate-account-*` видна только на paused | Открыть /accounts → присутствует на paused, отсутствует на active |
| Sync button скрыта на paused | Открыть /accounts → SyncButton отсутствует у paused-карточки, присутствует у active |
| Activate в пределах лимита (start, 1 active + 2 paused) | Клик → бейдж «Активен», success-сообщение про 5 минут |
| Activate выше лимита (freemium, 1 active + 1 paused) | Клик → error-сообщение с лимитом, статус не изменился |
| CTA `reactivation-cta` показывается в первые 7 дней после activate | Видим баннер, ссылка на /rules |
| CTA показывается с упоминанием video_rotation, если выключено rotation-правило | В тексте баннера есть «включая правила ротации видео» |
| CTA НЕ показывается, если все disabled rules — биллинговые reactive | Баннера нет |
| CTA НЕ показывается через 8+ дней после activate | Баннера нет (окно закрылось) |
| CTA НЕ показывается, если юзер никогда не активировал кабинет (нет lastReactivationAt) | Баннера нет |

## Pre-commit чеклист

- [ ] `npx tsc --noEmit -p convex/tsconfig.json` — clean.
- [ ] `npm run lint` — проходит `--max-warnings 60` (актуальное значение из `package.json:10`); новых warnings от задачи не добавлено.
- [ ] `npm run test` — все проходят, новые тесты добавлены.
- [ ] Schema: `rules.disabledByBillingAt` и `users.lastReactivationAt` добавлены в `convex/schema.ts`.
- [ ] `grep -rn "api\.adAccounts\.activate" src/` — UI вызывает мутацию.
- [ ] `grep -n "disabledByBillingAt" convex/billing.ts` — выставляется в downgrade (НЕ для video_rotation), очищается в upgrade через `replace()`.
- [ ] `grep -n "disabledByBillingAt" convex/rules.ts` — очищается в `toggleActive`, `update` через `replace()` (helper `patchRuleAndClearBillingMarker`).
- [ ] `grep -n "ctx.db.patch.*disabledByBillingAt: undefined" convex/` — пусто. `patch({field: undefined})` в Convex no-op, физическое удаление только через `replace()`.
- [ ] `grep -n "MutationCtx" convex/rules.ts` — helper `patchRuleAndClearBillingMarker` импортирует тип из `_generated/server` (без self-referential `typeof ctx.*`).
- [ ] `grep -n "_creationTime" convex/rules.ts convex/billing.ts` — везде, где есть `ctx.db.replace`, `_id` и `_creationTime` destructured out из исходного doc.
- [ ] `grep -n "internal.billing.updateLimitsOnUpgrade" convex/billing.ts` — вызывается из ОБЕИХ payment веток: bePaid webhook (`:843`) и mock `processPayment` (`:953`/`:1064`).
- [ ] `grep -n "lastReactivationAt" convex/` — обновляется в `activate` и в `updateLimitsOnUpgrade` (только при реальной реактивации, не на пустых вызовах).
- [ ] `grep -n "Используйте api.adAccounts.activate" convex/adAccounts.ts` — guard есть в `updateStatus`.
- [ ] `grep -rn "api\.adAccounts\.updateStatus" src/` — нет клиентских вызовов вообще.
- [ ] `grep -rn "api\.adAccounts\.updateStatus" convex/syncMetrics.ts` — 10 вызовов, все с `status !== "active"` или с `error → active` (валидно). Ни один не делает `paused → active`.
- [ ] `data-testid` на кнопке активации и на CTA-баннере.
- [ ] `grep -n "status !== 'paused'" src/components/AccountCard.tsx` — SyncButton условно скрыт для paused.
- [ ] Все строки на русском.
- [ ] Audit log пишется для manual и auto_reactivation (категория account / rule).
- [ ] Companion-sync проверка: у `adAccounts` companion нет; у `rules` есть `rotationState`/`budgetManageState`. `updateLimitsOnUpgrade` не реактивирует `video_rotation` → rotationState стартовать не нужно. `updateLimitsOnDowngrade` дёргает `internal.videoRotation.deactivate` для каждого выключаемого `video_rotation` (см. §2 — это новый код).
- [ ] `grep -n "video_rotation" convex/billing.ts` — `updateLimitsOnDowngrade` проверяет `rule.type === "video_rotation"`: (a) не ставит маркер, (b) вызывает `scheduler.runAfter(0, internal.videoRotation.deactivate, ...)`.
- [ ] Cascade deleteUser проверка: новых таблиц не добавляем — пропускаем.

## Файлы к изменению

| Файл | Что |
|---|---|
| `convex/schema.ts` | + `rules.disabledByBillingAt: v.optional(v.number())`; + `users.lastReactivationAt: v.optional(v.number())` |
| `convex/billing.ts` | + `updateLimitsOnUpgrade` internalMutation; вызовы из ДВУХ payment flow'ов: bePaid webhook (строка 843, индивидуальная ветка) и mock `processPayment` (строки ≈953/1064); `updateLimitsOnDowngrade` ставит маркер на выключенных reactive-правилах (НЕ на video_rotation) |
| `convex/adAccounts.ts` | + `activate` mutation (стампит `lastReactivationAt`); `updateStatus` guard на `paused → active`; импорт `TIERS`, `SubscriptionTier` |
| `convex/rules.ts` | + helper `patchRuleAndClearBillingMarker` (replace при наличии маркера); `toggleActive` и `update` используют helper; + `getReactivationCta` query |
| `convex/adAccounts.test.ts` | + unit-тесты на `activate` и `updateStatus` guard |
| `convex/billing.test.ts` | + unit-тесты на `updateLimitsOnUpgrade` и downgrade-маркер |
| `convex/rules.test.ts` | + тесты на маркер lifecycle и `getReactivationCta` (окно, video_rotation flag, фильтрация) |
| `src/components/AccountCard.tsx` | + кнопка «Активировать», icon-only, `useMutation`, `useState`; **скрыть SyncButton для `status === "paused"`** (иначе sync упрётся в guard) |
| `src/components/AccountList.tsx` | пробросить `onActivated` / `onActivationError` callbacks |
| `src/pages/AccountsPage.tsx` | callbacks → `setSuccess` / `setError`; query `getReactivationCta`; CTA-баннер с условным показом по `cta.show` |
| `tests/accounts-activate.spec.ts` (новый) | + 8 E2E-сценариев (3 activate + 5 CTA) |

`syncMetrics.ts` и существующие 10 вызовов `updateStatus` — НЕ ТРОГАЕМ. Все они валидны (либо `error → *`, либо `* → error/paused/abandoned/archived`, либо `error → active` после recovery), guard их не зацепит.

## Зафиксированные решения

1. **Реактивация правил** — auto через `disabledByBillingAt` для reactive-правил (cpl_limit, min_ctr, etc.); `video_rotation` НЕ маркируется (downgrade дёргает `internal.videoRotation.deactivate`) и НЕ авто-реактивируется (риск запуска ротации с устаревшими креативами). Ручная реактивация — в /rules через существующий toggle (там есть `validateRotationConflicts`). Контекстный CTA на /accounts (окно 7 дней после reactivation event) закрывает UX-разрыв для правил, требующих ручного включения.
2. **Кнопка «Приостановить»** — нет, отдельный тикет.
3. **Автоматический `syncNow` после activate** — нет, ждём 5-мин крон.
4. **`lastError` cleanup** — НЕ обещаем. Существующий `clearSyncErrors` использует `patch(undefined)` (no-op в Convex) — pre-existing bug, не наш скоуп. Cosmetic issue после `activate`: старый `lastError` может остаться видимым. Фикс — отдельным мелким тикетом (перевод `clearSyncErrors` на `replace()`).
5. **Hardening `updateStatus`** — вариант (b) — публичная мутация с guard на `paused → active`. Не миграция в `internalMutation` (не оправдано: 13 production-вызовов править).
6. **Effective tier** — inline-логика, НЕ переиспользуем `getEffectiveTier` (`rules.ts:893`), чтобы не плодить две сигнатуры. Follow-up: централизовать в `billing.ts` как `resolveAccountLimits(ctx, account, user)`.
7. **`account.orgId` vs `user.organizationId`** — приоритет `account.orgId`. `user.organizationId` — только fallback.
8. **Admin alert для activate** — НЕ шлём (re-enable, не connect, не incident).
9. **Audit log** — пишем (`account_activated` с `source: "manual" | "auto_reactivation"`, `rule_reactivated`).
10. **Org expired grace** — `frozen` блокирует activate; `read_only` / `deep_read_only` — пропускаем (UI может ограничить отдельно).
11. **`updateLimitsOnUpgrade` для org-юзеров** — skip (симметрично downgrade). Manual `activate` для org accounts работает (resolve `account.orgId`, проверка frozen grace).
12. **Race condition** — полагаемся на Convex optimistic concurrency, покрываем unit-тестом, не утверждаем без проверки.
13. **`disabledByBillingAt` clearing** — только через `replace()`. `patch({field: undefined})` в Convex no-op (CLAUDE.md), идемпотентность ломается.
14. **`updateLimitsOnUpgrade` точки вызова** — обязательно ОБА: реальный bePaid webhook (`billing.ts:843`) и mock `processPayment` (`billing.ts:953`/`1064`). Иначе dev/manual flow проходит без auto-reactivation и тесты дают ложную картину.
15. **CTA окно — 7 дней** после reactivation event. Контекстный показ, без dismiss-кнопки. Окно закрывается само; следующий activate перезапускает таймер.
16. **CTA advisory-only** — не матчим к конкретным reactivated кабинетам. Может показываться, даже если выключенное правило относится к другому кабинету. Принимаем шум в пользу простоты; фикс — follow-up при необходимости.
17. **`syncNow` для paused** — намеренно блокируется guard'ом updateStatus. UX-фикс: скрываем sync button для paused в `AccountCard.tsx` (единственный action — кнопка «Активировать»). Backend-изменений в syncNow не требуется.

## Follow-up тикеты (вне скоупа)

1. **Централизация tier/limit логики** в `convex/billing.ts` (`resolveAccountLimits`, `resolveRuleLimits`). Заменить дублирование в `connect`, `activate`, `toggleActive`, `updateLimitsOn*`.
2. **`users.getLimits` alignment с activate-семантикой** — usage badge `5/3` сейчас вводит в заблуждение.
3. **Кнопка «Приостановить»** в AccountCard для симметрии (если будет реальный запрос).
4. **`pausedReason` поле** на `adAccounts` — различать «выключено биллингом» vs «выключено вручную». Сейчас не нужно (нет manual pause), но появится при добавлении кнопки «Приостановить».
5. **Фикс `clearSyncErrors`** (`convex/adAccounts.ts:1432-1444`) — перевести с `patch({ field: undefined })` на `replace()` (с destructure `_id`, `_creationTime`). Pre-existing bug: сейчас `consecutiveSyncErrors` и `lastSyncError` не очищаются после успешного sync. Мелкий PR.

# Prorated Upgrade — доплата при переходе на высший тариф

## Goal

При переходе на более высокий тариф (Start → Pro) пользователь доплачивает разницу с учётом неиспользованных дней текущей подписки. Кредит рассчитывается по фактической сумме последнего платежа.

## Формула

```
remainingDays = ceil((subscriptionExpiresAt - now) / 86400000)
totalDays = 30 + bonusDays   // bonusDays из последнего completed платежа
dailyRate = lastPaymentAmount / totalDays
credit = dailyRate * remainingDays
upgradeCost = max(newTierPriceBYN - credit, 1)   // минимум 1 BYN
```

**Пример:** Start оплачен 35 BYN за 30 дней. Осталось 20 дней.
- dailyRate = 35 / 30 = 1.167 BYN
- credit = 1.167 * 20 = 23.33 BYN
- Pro стоит 88 BYN
- upgradeCost = 88 - 23.33 = 64.67 → округляем вверх → **65 BYN**

## Валюта

Все платежи сейчас идут через bePaid в BYN. Кредит считается в BYN по фактической оплате. Когда подключатся рубли — доработаем расчёт.

## Изменения

### Backend — `convex/billing.ts`

#### Новая query: `getUpgradePrice`

```typescript
export const getUpgradePrice = query({
  args: {
    userId: v.id("users"),
    newTier: v.union(v.literal("start"), v.literal("pro")),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return null;

    const currentTier = user.subscriptionTier ?? "freemium";
    const expiresAt = user.subscriptionExpiresAt;
    const now = Date.now();

    // Нет активной подписки или freemium — полная цена, нет кредита
    if (currentTier === "freemium" || !expiresAt || expiresAt <= now) {
      return { credit: 0, upgradeCost: null, remainingDays: 0, isUpgrade: false };
    }

    // Тот же или более высокий тариф — не апгрейд
    const tierOrder = { freemium: 0, start: 1, pro: 2 };
    if (tierOrder[args.newTier] <= tierOrder[currentTier]) {
      return { credit: 0, upgradeCost: null, remainingDays: 0, isUpgrade: false };
    }

    // Последний completed платёж
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .order("desc")
      .collect();
    const lastPayment = payments.find((p) => p.status === "completed");

    if (!lastPayment) {
      return { credit: 0, upgradeCost: null, remainingDays: 0, isUpgrade: false };
    }

    const remainingDays = Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000));
    const totalDays = 30 + (lastPayment.bonusDays || 0);
    const dailyRate = lastPayment.amount / totalDays;
    const credit = Math.round(dailyRate * remainingDays * 100) / 100;

    return {
      credit,
      remainingDays,
      isUpgrade: true,
      currency: lastPayment.currency,  // "BYN"
    };
  },
});
```

Поле `upgradeCost` не возвращаем — его вычисляет фронт, потому что цена нового тарифа в BYN зависит от курса НБРБ, который фронт уже загружает.

#### `createBepaidCheckout` — добавить поля для логирования

```typescript
// Добавить в args:
isUpgrade: v.optional(v.boolean()),
creditAmount: v.optional(v.number()),
```

Эти поля пробрасываются в `savePendingPayment` и сохраняются в запись `payments` для аудита.

#### `savePendingPayment` — добавить поля

```typescript
// Добавить в args:
isUpgrade: v.optional(v.boolean()),
creditAmount: v.optional(v.number()),
```

Сохраняются в запись `payments`.

### Frontend — `PaymentModal.tsx`

1. При открытии модала вызывать `getUpgradePrice({ userId, newTier: tier })`
2. Если `isUpgrade === true`:
   - Рассчитать `upgradeCost = max(ceil(newTierPriceBYN - credit), 1)`
   - Показать блок:
     ```
     Кредит за остаток Start (20 дн.): -23.33 BYN
     Стоимость Pro: 88 BYN
     К оплате: 65 BYN
     ```
   - Передать `upgradeCost` как `amountBYN` в `createBepaidCheckout`
   - Передать `isUpgrade: true`, `creditAmount: credit`
3. Если `isUpgrade === false` — поведение как сейчас (полная цена)

### Schema — без изменений

Поля `isUpgrade` и `creditAmount` в `payments` — опциональные, не требуют миграции. В schema.ts добавить:

```typescript
// В таблице payments:
isUpgrade: v.optional(v.boolean()),
creditAmount: v.optional(v.number()),
```

## Что НЕ меняется

- `handleBepaidWebhook` — при успешной оплате устанавливает 30 новых дней на новом тарифе (та же логика)
- Даунгрейд (Pro → Start) — не поддерживается, только апгрейд
- Продление того же тарифа — полная цена, без кредита
- `crons.ts` — расписание не меняется
- Промокоды — работают поверх (bonusDays добавляются к 30 дням нового тарифа)

## Edge Cases

| Кейс | Поведение |
|------|-----------|
| freemium → Start | Полная цена, нет кредита |
| freemium → Pro | Полная цена, нет кредита |
| Start → Pro | Кредит за остаток Start, доплата |
| Pro → Pro (продление) | Полная цена, нет кредита |
| Start → Start (продление) | Полная цена, нет кредита |
| Pro → Start (даунгрейд) | Не поддерживается — кнопка не показывается |
| Подписка истекла | Полная цена, нет кредита |
| Нет предыдущего платежа | Полная цена, нет кредита |
| Платёж с промокодом (+7 дней) | totalDays = 37, dailyRate пересчитывается |

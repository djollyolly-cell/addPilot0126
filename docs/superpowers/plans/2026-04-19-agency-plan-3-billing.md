# Agency Plan 3: Billing Agency

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Расширить биллинг на agency-тарифы — TIERS константы, прорейтед-апгрейд с fallback (Решение 2), bePaid checkout/webhook для agency, поддержка lockedPrices/promo/referral в agency-контексте, downgrade-логика-isolation для org-юзеров.

**Architecture:** Расширяем existing `convex/billing.ts` (не дробим в новый файл — консистентность с проектом). Все changes additive: existing flows для start/pro работают как есть, agency_* добавляются параллельно. Webhook routing определяется по наличию `payment.orgId`.

**Tech Stack:** Convex, TypeScript. Никаких новых зависимостей.

**Зависимости:** Plans 0, 1, 2 задеплоены. `payments.tier` union расширен (Plan 1 Task 1). `organizations` таблица существует. `accessControl.ts` готов.

---

## Стыковочный анализ (rev 2, 2026-04-21)

Ревизия документа после cross-plan анализ всех 7 планов. Исправлены 6 проблем:

| # | Проблема | Где в плане | Исправление |
|---|---|---|---|
| 1 | `createPending` — двойной клик создаёт 2 pending org | Task 3 | Idempotency check: query existing pending org by ownerId before insert |
| 2 | `TIER_LIMITS` hardcode в `updateSubscriptionFromPayment` дублирует TIERS | Task 4 | Заменён на `TIERS[tier].includedLoadUnits` import |
| 3 | `ctx.db.patch(orgId, { field: undefined })` не очищает grace-флаги (Convex семантика) | Task 4 | `ctx.db.replace()` через `clearGraceFlags` mutation в `organizations.ts` |
| 4 | `getUpgradePrice` берёт любой `lastPayment` без фильтрации по типу тарифа | Task 2 | Фильтрация `lastPayment` по `isAgencyTier(p.tier) === isAgencyTier(newTier)` |
| 5 | 3 источника agency-цен (TIERS + 2 hardcode в Plan 6 UI) | Cross-plan note | Plan 6 MUST use `getUserPrices` query, не hardcode |
| 6 | AgencyOnboardingPage (Plan 6) не читает localStorage referralCode | Cross-plan note | Plan 6 MUST read `adpilot_referral_code` и передать в checkout |

---

## File Structure

| Файл | Действие | Ответственность |
|---|---|---|
| `convex/billing.ts` | Modify (large) | +TIERS agency entries, +`isAgencyTier` helper, +`calculateUpgradePriceWithFallback`, +`getUpgradePrice` фильтрация по типу, +agency-tier в createBepaidCheckout, +webhook routing, +`getUserPrices` расширение, +org-user isolation |
| `convex/organizations.ts` | Modify | +`createPending` (idempotent), +`updateSubscriptionFromPayment`, +`clearGraceFlags` (используется webhook + Plan 4) |
| `convex/referrals.ts` | Modify | +`paymentTier` arg в `applyReferralBonus`, tier-specific bonusDays |
| `tests/unit/billing-agency-tiers.test.ts` | Create | Tests: цены, прорейтед fallback, agency_* в TIERS |
| `tests/unit/billing-webhook-org.test.ts` | Create | Tests: webhook → organizations update вместо users |

---

## Task 1: Расширить `TIERS` константой agency-тарифами

**Files:**
- Modify: `convex/billing.ts:6-30`

- [ ] **Step 1: Добавить agency_* в TIERS**

Edit `convex/billing.ts`. Заменить блок `TIERS`:

```typescript
export const TIERS = {
  freemium: {
    name: "Freemium",
    price: 0,
    accountsLimit: 1,
    rulesLimit: 3,
    includedLoadUnits: 0,
    overagePrice: 0,
    features: ["1 рекламный кабинет", "3 правила автоматизации", "Telegram-уведомления"],
  },
  start: {
    name: "Start",
    price: 1290,
    accountsLimit: 3,
    rulesLimit: 10,
    includedLoadUnits: 0,
    overagePrice: 0,
    features: ["3 рекламных кабинета", "10 правил автоматизации", "Telegram-уведомления", "Базовая аналитика"],
  },
  pro: {
    name: "Pro",
    price: 2990,
    accountsLimit: 20,
    rulesLimit: -1,
    includedLoadUnits: 0,
    overagePrice: 0,
    features: ["До 20 кабинетов", "Неограниченные правила", "Приоритетная поддержка", "Расширенная аналитика"],
  },
  // Agency tiers — load-units based (updated 2026-04-27, aligned with billing.ts)
  agency_s: {
    name: "Agency S",
    price: 14900,
    accountsLimit: -1,
    rulesLimit: -1,
    includedLoadUnits: 30,
    overagePrice: 600,
    maxManagers: 3,
    maxNiches: 3,
    features: ["До 30 ед. нагрузки", "Конструктор правил (L2)", "До 3 менеджеров", "До 3 ниш", "Приоритетная поддержка", "Мониторинг здоровья аккаунтов", "Месячный отчёт по нагрузке"],
  },
  agency_m: {
    name: "Agency M",
    price: 24900,
    accountsLimit: -1,
    rulesLimit: -1,
    includedLoadUnits: 60,
    overagePrice: 500,
    maxManagers: 10,
    maxNiches: 6,
    features: ["До 60 ед. нагрузки", "Конструктор правил (L2)", "До 10 менеджеров", "До 6 ниш", "Приоритетная поддержка", "Мониторинг здоровья аккаунтов", "Месячный отчёт по нагрузке"],
  },
  agency_l: {
    name: "Agency L",
    price: 39900,
    accountsLimit: -1,
    rulesLimit: -1,
    includedLoadUnits: 120,
    overagePrice: 400,
    maxManagers: 30,
    maxNiches: -1,
    features: ["До 120 ед. нагрузки", "Конструктор правил (L2)", "До 30 менеджеров", "Все ниши", "Приоритетная поддержка", "Мониторинг здоровья аккаунтов", "Месячный отчёт по нагрузке", "Выделенный IP", "Кастомные типы правил (L3)", "SLA на синхронизацию"],
  },
  // Agency XL — individual pricing, no fixed price
  agency_xl: {
    name: "Agency XL",
    price: 0,
    accountsLimit: -1,
    rulesLimit: -1,
    includedLoadUnits: 200,
    overagePrice: 0,
    maxManagers: -1,
    maxNiches: -1,
    features: ["От 200 ед. нагрузки", "Всё из Agency L", "Персональный менеджер", "Индивидуальная цена"],
  },
} as const;

export type SubscriptionTier = keyof typeof TIERS;
export type AgencyTier = "agency_s" | "agency_m" | "agency_l" | "agency_xl";
export type IndividualTier = "freemium" | "start" | "pro";

export const isAgencyTier = (tier: string): tier is AgencyTier =>
  tier === "agency_s" || tier === "agency_m" || tier === "agency_l" || tier === "agency_xl";
```

- [ ] **Step 1b: Расширить `TIER_RULE_LIMITS` в `rules.ts` (Pre-flight dependency)**

> **Cross-plan:** Pre-flight Task 2 экспортировал `TIER_RULE_LIMITS` из `rules.ts` как single source of truth. При добавлении agency_* тиров в TIERS — нужно синхронно расширить `TIER_RULE_LIMITS`.

Edit `convex/rules.ts`. Найти `export const TIER_RULE_LIMITS`:

```typescript
// Before (Pre-flight):
export const TIER_RULE_LIMITS: Record<string, number> = {
  freemium: 3,
  start: 10,
  pro: Infinity,
};

// After (Plan 3):
export const TIER_RULE_LIMITS: Record<string, number> = {
  freemium: 3,
  start: 10,
  pro: Infinity,
  agency_s: Infinity,
  agency_m: Infinity,
  agency_l: Infinity,
  agency_xl: Infinity,
};
```

Run: `npm run test:unit -- tests/unit/rule-tier-limits.test.ts`
Expected: PASS (existing tests cover freemium/start/pro, new agency tiers are Infinity — consistent with `TIERS[agency_*].rulesLimit = -1`).

- [ ] **Step 2: Расширить `TIER_ORDER`**

Edit `convex/billing.ts:76`:

```typescript
const TIER_ORDER: Record<string, number> = {
  freemium: 0,
  start: 1,
  pro: 2,
  agency_s: 3,
  agency_m: 4,
  agency_l: 5,
  agency_xl: 6,
};
```

- [ ] **Step 3: Расширить `getUserPrices` query**

> **Стыковочный анализ:** `getUserPrices` (billing.ts:36-48) возвращает только `{ start, pro }`. Plan 6 PricingPage и AgencyOnboardingPage нуждаются в agency-ценах. Единственный source of truth — TIERS.

Edit `convex/billing.ts:36-48`. Расширить return-тип:

```typescript
export const getUserPrices = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);

    const basePrices = {
      start: TIERS.start.price,
      pro: TIERS.pro.price,
      agency_s: TIERS.agency_s.price,
      agency_m: TIERS.agency_m.price,
      agency_l: TIERS.agency_l.price,
      agency_xl: TIERS.agency_xl.price,
    };

    if (!user) return basePrices;

    // lockedPrices applies only to individual tiers (start/pro)
    const locked = user.lockedPrices;
    if (locked && locked.until > Date.now()) {
      return {
        ...basePrices,
        start: locked.start,
        pro: locked.pro,
      };
    }
    return basePrices;
  },
});
```

**Callers:** `src/pages/PricingPage.tsx:59-61` — уже вызывает `getUserPrices`, получит расширенный ответ. Обратная совместимость: `.start` и `.pro` доступны как раньше.

- [ ] **Step 4: TypeScript check**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: возможны ошибки в местах, где `TIERS[tier]` использует non-agency типы. Исправить cast-ами или добавить экземпляр в local типы.

- [ ] **Step 5: Закоммитить**

```bash
git add convex/billing.ts convex/rules.ts
git commit -m "feat(billing): extend TIERS with agency_s/m/l/xl

Adds includedLoadUnits and overagePrice to all tiers (0 for non-agency).
Adds AgencyTier/IndividualTier type aliases + isAgencyTier helper.
Extends TIER_ORDER for prorated upgrade comparison.
getUserPrices now returns agency prices (single source of truth).
TIER_RULE_LIMITS extended with Infinity for all agency tiers."
```

---

## Task 2: Реализовать fallback в `calculateUpgradePrice` (Решение 2)

**Files:**
- Modify: `convex/billing.ts:96-116`
- Test: `tests/unit/billing-agency-tiers.test.ts`

- [ ] **Step 1: Создать failing test**

Create `tests/unit/billing-agency-tiers.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { calculateUpgradePrice, calculateUpgradePriceWithFallback, TIERS } from "../../convex/billing";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("calculateUpgradePrice — existing behavior preserved", () => {
  it("returns credit for pro user with payment history (existing flow)", () => {
    const result = calculateUpgradePrice({
      currentTier: "pro",
      newTier: "agency_m",
      subscriptionExpiresAt: Date.now() + 12 * DAY_MS,
      lastPaymentAmount: 2990,
      lastPaymentBonusDays: 0,
      lastPaymentCurrency: "RUB",
      now: Date.now(),
    });
    expect(result.isUpgrade).toBe(true);
    expect(result.credit).toBeGreaterThan(0);
    // 12 days / 30 * 2990 ≈ 1196
    expect(result.credit).toBeCloseTo(1196, -1);
  });

  it("returns credit reduced by promo (60-day coverage)", () => {
    // User paid 1495 (50% promo) + 30 bonus days = 60 days coverage
    const result = calculateUpgradePrice({
      currentTier: "pro",
      newTier: "agency_m",
      subscriptionExpiresAt: Date.now() + 30 * DAY_MS,
      lastPaymentAmount: 1495,
      lastPaymentBonusDays: 30,
      lastPaymentCurrency: "RUB",
      now: Date.now(),
    });
    // dailyRate = 1495/60 ≈ 24.92, credit = 24.92 * 30 ≈ 747
    expect(result.credit).toBeCloseTo(747, -1);
  });

  it("returns no upgrade for freemium → pro (no payment history)", () => {
    const result = calculateUpgradePrice({
      currentTier: "freemium",
      newTier: "pro",
      subscriptionExpiresAt: undefined,
      lastPaymentAmount: undefined,
      lastPaymentBonusDays: undefined,
      lastPaymentCurrency: undefined,
      now: Date.now(),
    });
    expect(result.isUpgrade).toBe(false);
    expect(result.credit).toBe(0);
  });
});

describe("calculateUpgradePriceWithFallback — Решение 2", () => {
  it("primary path: uses lastPayment when present", () => {
    const result = calculateUpgradePriceWithFallback({
      currentTier: "pro",
      newTier: "agency_m",
      subscriptionExpiresAt: Date.now() + 12 * DAY_MS,
      lastPaymentAmount: 2990,
      lastPaymentBonusDays: 0,
      lastPaymentCurrency: "RUB",
      now: Date.now(),
    });
    expect(result.isUpgrade).toBe(true);
    expect(result.credit).toBeCloseTo(1196, -1);
  });

  it("fallback path: uses catalog price when lastPayment is missing (admin-granted)", () => {
    const result = calculateUpgradePriceWithFallback({
      currentTier: "pro",
      newTier: "agency_m",
      subscriptionExpiresAt: Date.now() + 15 * DAY_MS,
      lastPaymentAmount: undefined,  // no payment history (admin-granted)
      lastPaymentBonusDays: undefined,
      lastPaymentCurrency: undefined,
      now: Date.now(),
    });
    expect(result.isUpgrade).toBe(true);
    // 15 days / 30 * 2990 = 1495
    expect(result.credit).toBeCloseTo(1495, -1);
    expect(result.currency).toBe("RUB");
  });

  it("fallback returns no upgrade if currentTier is freemium", () => {
    const result = calculateUpgradePriceWithFallback({
      currentTier: "freemium",
      newTier: "agency_s",
      subscriptionExpiresAt: undefined,
      lastPaymentAmount: undefined,
      lastPaymentBonusDays: undefined,
      lastPaymentCurrency: undefined,
      now: Date.now(),
    });
    expect(result.isUpgrade).toBe(false);
  });
});
```

- [ ] **Step 2: Запустить тест — должен фейлить**

Run: `npm run test:unit -- tests/unit/billing-agency-tiers.test.ts`
Expected: PASS первые 3 теста, FAIL последние 3 (`calculateUpgradePriceWithFallback` не существует).

- [ ] **Step 3: Реализовать fallback**

Edit `convex/billing.ts`. После `calculateUpgradePrice` добавить:

```typescript
/**
 * Решение 2: hybrid prorated formula.
 * Primary: existing calculateUpgradePrice (uses lastPayment).
 * Fallback: catalog price / 30 × remainingDays (when no payment history).
 *
 * Use case for fallback:
 * - Grandfathered Pro users (no payment record)
 * - Admin-granted tiers via admin.updateUserTier
 * - Test orgs without prior subscription
 */
export function calculateUpgradePriceWithFallback(input: UpgradePriceInput): UpgradePriceResult {
  const primary = calculateUpgradePrice(input);
  if (primary.isUpgrade) return primary;

  // Fallback: try catalog-based credit
  const { currentTier, newTier, subscriptionExpiresAt, now } = input;

  if (currentTier === "freemium" || !subscriptionExpiresAt || subscriptionExpiresAt <= now) {
    return { credit: 0, remainingDays: 0, isUpgrade: false };
  }
  if ((TIER_ORDER[newTier] ?? 0) <= (TIER_ORDER[currentTier] ?? 0)) {
    return { credit: 0, remainingDays: 0, isUpgrade: false };
  }

  // Catalog price for current tier
  const catalogPrice = (TIERS as Record<string, { price: number }>)[currentTier]?.price;
  if (!catalogPrice || catalogPrice <= 0) {
    return { credit: 0, remainingDays: 0, isUpgrade: false };
  }

  const remainingDays = Math.ceil((subscriptionExpiresAt - now) / (24 * 60 * 60 * 1000));
  const credit = Math.round((remainingDays / 30) * catalogPrice * 100) / 100;

  return { credit, remainingDays, isUpgrade: true, currency: "RUB" };
}
```

- [ ] **Step 4: Заменить `getUpgradePrice` query на fallback-версию с фильтрацией по типу тарифа**

> **Стыковочный анализ (Change 4):** Текущий `getUpgradePrice` берёт ЛЮБОЙ `lastPayment` без фильтрации. Если владелец перешёл с individual (pro) на agency, `lastPayment` может быть от другой категории. Фильтруем `lastPayment` по `isAgencyTier(p.tier) === isAgencyTier(newTier)`.

Edit `convex/billing.ts:119-148`:

```typescript
/** Query: get upgrade credit for prorated pricing (with fallback) */
export const getUpgradePrice = query({
  args: {
    userId: v.id("users"),
    newTier: v.union(
      v.literal("start"),
      v.literal("pro"),
      v.literal("agency_s"),
      v.literal("agency_m"),
      v.literal("agency_l"),
      v.literal("agency_xl")
    ),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return { credit: 0, remainingDays: 0, isUpgrade: false };

    const currentTier = (user.subscriptionTier as string) ?? "freemium";

    const payments = await ctx.db
      .query("payments")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .order("desc")
      .collect();

    // Filter lastPayment by tier category: individual payments for individual upgrade,
    // agency payments for agency upgrade. Prevents cross-contamination when owner
    // has both individual and agency payment history.
    const targetIsAgency = isAgencyTier(args.newTier);
    const lastPayment = payments.find((p) =>
      p.status === "completed" && isAgencyTier(p.tier) === targetIsAgency
    );

    return calculateUpgradePriceWithFallback({
      currentTier,
      newTier: args.newTier,
      subscriptionExpiresAt: user.subscriptionExpiresAt,
      lastPaymentAmount: lastPayment?.amount,
      lastPaymentBonusDays: lastPayment?.bonusDays,
      lastPaymentCurrency: lastPayment?.currency,
      now: Date.now(),
    });
  },
});
```

**Callers:** `src/components/PaymentModal.tsx:67-70` — вызывает `getUpgradePrice({ userId, newTier: tier })`. `tier` сейчас только `start | pro`. После Plan 6 появится agency_*. Обратная совместимость: individual тарифы работают как раньше (фильтр `isAgencyTier(p.tier) === false` пропускает только individual платежи).

- [ ] **Step 5: Запустить тесты**

Run: `npm run test:unit -- tests/unit/billing-agency-tiers.test.ts`
Expected: 6 tests pass.

- [ ] **Step 6: Закоммитить**

```bash
git add convex/billing.ts tests/unit/billing-agency-tiers.test.ts
git commit -m "feat(billing): hybrid prorated upgrade formula (Решение 2)

calculateUpgradePriceWithFallback wraps existing calculateUpgradePrice:
- Primary: lastPayment-based (учитывает promo + referral bonus days)
- Fallback: catalog price / 30 * remainingDays (когда нет payment history)

Use cases для fallback:
- Grandfathered Pro юзеры
- Admin-granted tiers (admin.updateUserTier)
- Тестовые orgs без предыдущей подписки

getUpgradePrice query теперь использует fallback. newTier union
расширен на agency_*. lastPayment фильтруется по isAgencyTier
для корректного прорейтинга при смешанной истории платежей.
6 unit-тестов покрывают оба пути + edge cases."
```

---

## Task 3: Расширить `createBepaidCheckout` для agency-тарифов

**Files:**
- Modify: `convex/billing.ts:160-292`
- Modify: `convex/organizations.ts`

- [ ] **Step 1: Расширить args + добавить orgId**

Edit `convex/billing.ts`. Найти `createBepaidCheckout`:

```typescript
export const createBepaidCheckout = action({
  args: {
    userId: v.id("users"),
    tier: v.union(
      v.literal("start"),
      v.literal("pro"),
      v.literal("agency_s"),
      v.literal("agency_m"),
      v.literal("agency_l"),
      v.literal("agency_xl")
    ),
    promoCode: v.optional(v.string()),
    referralCode: v.optional(v.string()),
    returnUrl: v.string(),
    amountBYN: v.number(),
    isUpgrade: v.optional(v.boolean()),
    creditAmount: v.optional(v.number()),
    /** For agency tiers: which org will be created/upgraded */
    orgId: v.optional(v.id("organizations")),
    /** For agency new-org: name + niches passed when creating */
    pendingOrgName: v.optional(v.string()),
    pendingOrgNiches: v.optional(v.array(v.object({
      niche: v.string(),
      cabinetsCount: v.number(),
    }))),
  },
  handler: async (ctx, args) => {
    // ... existing validation ...

    // Validate: agency tier requires either orgId (upgrade) or pendingOrgName (new)
    const isAgency = isAgencyTier(args.tier);
    if (isAgency && !args.orgId && !args.pendingOrgName) {
      throw new Error("agency-тариф требует orgId или pendingOrgName");
    }
    if (isAgency && args.orgId && args.pendingOrgName) {
      throw new Error("orgId и pendingOrgName взаимоисключаются");
    }

    // For new agency: create pending org (idempotent)
    let resolvedOrgId = args.orgId;
    if (isAgency && !resolvedOrgId && args.pendingOrgName) {
      resolvedOrgId = await ctx.runMutation(internal.organizations.createPending, {
        name: args.pendingOrgName,
        ownerId: args.userId,
        subscriptionTier: args.tier as AgencyTier,
        maxLoadUnits: TIERS[args.tier].includedLoadUnits,
        nichesConfig: args.pendingOrgNiches,
      });
    }

    // ... rest of existing checkout creation logic ...
    // When saving payment via savePendingPayment — pass orgId:
    await ctx.runMutation(internal.billing.savePendingPayment, {
      // ... existing fields ...
      orgId: resolvedOrgId,
    });
  },
});
```

- [ ] **Step 2: Расширить `savePendingPayment`**

Найти `savePendingPayment` в billing.ts. Добавить optional orgId:

```typescript
export const savePendingPayment = internalMutation({
  args: {
    userId: v.id("users"),
    tier: v.union(
      v.literal("start"), v.literal("pro"),
      v.literal("agency_s"), v.literal("agency_m"),
      v.literal("agency_l"), v.literal("agency_xl")
    ),
    orderId: v.string(),
    token: v.string(),
    amount: v.number(),
    currency: v.string(),
    promoCode: v.optional(v.string()),
    referralCode: v.optional(v.string()),
    referralDiscount: v.optional(v.number()),
    isUpgrade: v.optional(v.boolean()),
    creditAmount: v.optional(v.number()),
    orgId: v.optional(v.id("organizations")),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("payments", {
      userId: args.userId,
      tier: args.tier,
      orderId: args.orderId,
      token: args.token,
      amount: args.amount,
      currency: args.currency,
      status: "pending",
      promoCode: args.promoCode,
      referralCode: args.referralCode,
      referralDiscount: args.referralDiscount,
      isUpgrade: args.isUpgrade,
      creditAmount: args.creditAmount,
      orgId: args.orgId,
      createdAt: Date.now(),
    });
  },
});
```

> **Примечание:** `pendingOrgName` и `pendingOrgNiches` НЕ сохраняются в payments — org создаётся СРАЗУ при checkout (createPending), и `orgId` записывается в payment. При rejection/timeout — org остаётся в pending (`subscriptionExpiresAt: undefined`), при retry используется тот же orgId (idempotency).

- [ ] **Step 3: Добавить `createPending` в `convex/organizations.ts` (idempotent)**

> **Стыковочный анализ (Change 1):** Если пользователь быстро нажмёт «Оплатить» дважды, `createBepaidCheckout` вызовет `createPending` дважды. Без idempotency — 2 pending org. Решение: проверить existing pending org by ownerId перед insert.

```typescript
export const createPending = internalMutation({
  args: {
    name: v.string(),
    ownerId: v.id("users"),
    subscriptionTier: v.union(
      v.literal("agency_s"), v.literal("agency_m"),
      v.literal("agency_l"), v.literal("agency_xl")
    ),
    maxLoadUnits: v.number(),
    nichesConfig: v.optional(v.array(v.object({
      niche: v.string(),
      cabinetsCount: v.number(),
    }))),
  },
  handler: async (ctx, args) => {
    // Idempotency: if owner already has a pending org (no subscriptionExpiresAt),
    // return it instead of creating a duplicate.
    // This handles double-click and payment retry scenarios.
    const existingOrgs = await ctx.db
      .query("organizations")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .collect();
    const pendingOrg = existingOrgs.find((o) => !o.subscriptionExpiresAt);
    if (pendingOrg) {
      return pendingOrg._id;
    }

    // Runtime validation: niche must be in AVAILABLE_NICHES
    const AVAILABLE_NICHES = ["beauty", "schools", "realty", "auto", "medicine", "services"];
    if (args.nichesConfig) {
      for (const nc of args.nichesConfig) {
        if (!AVAILABLE_NICHES.includes(nc.niche)) {
          throw new Error(`Неизвестная ниша: ${nc.niche}. Доступные: ${AVAILABLE_NICHES.join(", ")}`);
        }
      }
    }

    return await ctx.db.insert("organizations", {
      name: args.name,
      ownerId: args.ownerId,
      subscriptionTier: args.subscriptionTier,
      // subscriptionExpiresAt: undefined — pending until webhook
      maxLoadUnits: args.maxLoadUnits,
      currentLoadUnits: 0,
      nichesConfig: args.nichesConfig,
      timezone: "Europe/Moscow",
      createdAt: Date.now(),
    });
  },
});
```

- [ ] **Step 4: TypeScript + commit**

Run: `npx tsc --noEmit -p convex/tsconfig.json`

```bash
git add convex/billing.ts convex/organizations.ts
git commit -m "feat(billing): support agency_* tiers in createBepaidCheckout

For agency: requires orgId (existing org upgrade) OR pendingOrgName
(creates pending org via organizations.createPending). Pending org
has subscriptionExpiresAt: undefined until webhook activates.

createPending is idempotent — returns existing pending org if owner
already has one (handles double-click / payment retry).

savePendingPayment now stores orgId. webhook (next task) will
route to organizations.updateSubscriptionFromPayment when orgId set."
```

---

## Task 4: Расширить `handleBepaidWebhook` для org-платежей

**Files:**
- Modify: `convex/billing.ts:329-483`
- Modify: `convex/organizations.ts` (add `updateSubscriptionFromPayment`, `clearGraceFlags`)

- [ ] **Step 1: Добавить `clearGraceFlags` mutation в `organizations.ts`**

> **Стыковочный анализ (Change 3):** `ctx.db.patch(orgId, { field: undefined })` в Convex **пропускает** поле (не удаляет его). Для сброса grace-флагов нужен `ctx.db.replace()`. Выносим в `organizations.ts` как reusable mutation — используется и в webhook (Plan 3), и в load monitoring cron (Plan 4).

```typescript
/**
 * Clear all grace/overage flags from organization.
 * Uses ctx.db.replace() because Convex patch({field: undefined}) SKIPS the field
 * instead of removing it. This is the ONLY correct way to clear optional fields.
 *
 * Used by:
 * - Plan 3: handleBepaidWebhook (on successful agency payment)
 * - Plan 4: load monitoring cron (when overage resolved)
 */
export const clearGraceFlags = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.orgId);
    if (!org) return;

    // Build clean doc without grace fields
    const { _id, _creationTime, ...rest } = org;
    const {
      overageNotifiedAt,
      overageWarningAt,
      overageGraceStartedAt,
      featuresDisabledAt,
      expiredGracePhase,
      expiredGraceStartedAt,
      pendingCredit,
      pendingCreditCurrency,
      ...clean
    } = rest as Record<string, unknown>;

    await ctx.db.replace(args.orgId, {
      ...clean,
      updatedAt: Date.now(),
    });
  },
});
```

- [ ] **Step 2: Добавить `updateSubscriptionFromPayment` в `organizations.ts`**

> **Стыковочный анализ (Change 2):** Вместо hardcoded `TIER_LIMITS` — используем `TIERS[tier].includedLoadUnits` из billing.ts (single source of truth).

```typescript
import { TIERS, isAgencyTier } from "./billing";

export const updateSubscriptionFromPayment = internalMutation({
  args: {
    orgId: v.id("organizations"),
    tier: v.union(
      v.literal("agency_s"), v.literal("agency_m"),
      v.literal("agency_l"), v.literal("agency_xl")
    ),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    // Update subscription fields
    await ctx.db.patch(args.orgId, {
      subscriptionTier: args.tier,
      subscriptionExpiresAt: args.expiresAt,
      maxLoadUnits: TIERS[args.tier].includedLoadUnits,
      updatedAt: Date.now(),
    });

    // Clear all grace flags via replace (patch can't remove optional fields)
    await ctx.runMutation(internal.organizations.clearGraceFlags, {
      orgId: args.orgId,
    });
  },
});
```

- [ ] **Step 3: Расширить webhook handler**

Edit `convex/billing.ts:329-483` `handleBepaidWebhook`. После расчёта `bonusDays` и `expiresAt` (~L400-402), вместо patch user — routing на org или user:

```typescript
// Determine if this is agency payment
if (payment.orgId) {
  // Agency: update organizations record, not users
  await ctx.runMutation(internal.organizations.updateSubscriptionFromPayment, {
    orgId: payment.orgId,
    tier: payment.tier as AgencyTier,
    expiresAt,
  });
} else {
  // Individual: existing logic — patch users
  const paidUser = await ctx.db.get(payment.userId);
  const lockedUpdate: Record<string, unknown> = {};
  if (paidUser?.lockedPrices) {
    const isStillActive = paidUser.subscriptionExpiresAt && paidUser.subscriptionExpiresAt >= Date.now();
    if (isStillActive) {
      lockedUpdate.lockedPrices = {
        ...paidUser.lockedPrices,
        until: expiresAt,
      };
    }
  }

  const proLimitPatch: Record<string, unknown> = {};
  if (payment.tier === "pro" && !paidUser?.proAccountLimit) {
    proLimitPatch.proAccountLimit = 20;
  }

  await ctx.db.patch(payment.userId, {
    subscriptionTier: payment.tier as "freemium" | "start" | "pro",
    subscriptionExpiresAt: expiresAt,
    updatedAt: Date.now(),
    ...lockedUpdate,
    ...proLimitPatch,
  });
}

// Referral bonus — works for both individual and agency
// (referrer always gets bonus days on their own subscription)
if (payment.referralCode) {
  await ctx.runMutation(internal.referrals.applyReferralBonus, {
    referralCode: payment.referralCode,
    referredUserId: payment.userId,
    paymentId: payment._id,
    paymentTier: payment.tier,  // NEW: для tier-specific bonusDays
  });
}
```

- [ ] **Step 4: Создать тест**

Create `tests/unit/billing-webhook-org.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../convex/schema";
import { internal } from "../../convex/_generated/api";

const modules = import.meta.glob("../../convex/**/*.ts");

describe("handleBepaidWebhook for agency payment", () => {
  it("agency payment activates organization subscription, not user's", async () => {
    const t = convexTest(schema, modules);

    const ownerId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "o@x.com", createdAt: Date.now() })
    );
    const orgId = await t.run(async (ctx) =>
      ctx.db.insert("organizations", {
        name: "X", ownerId, subscriptionTier: "agency_m",
        maxLoadUnits: 0, currentLoadUnits: 0, createdAt: Date.now(),
      })
    );
    await t.run(async (ctx) =>
      ctx.db.insert("payments", {
        userId: ownerId,
        orgId,
        tier: "agency_m",
        orderId: "order_test_1",
        token: "tok",
        amount: 24900,
        currency: "RUB",
        status: "pending",
        createdAt: Date.now(),
      })
    );

    await t.mutation(internal.billing.handleBepaidWebhook, {
      transactionType: "payment",
      status: "successful",
      trackingId: "order_test_1",
      uid: "uid-1",
      amount: 2490000,
      currency: "RUB",
    });

    const org = await t.run(async (ctx) => ctx.db.get(orgId));
    expect(org?.subscriptionTier).toBe("agency_m");
    expect(org?.subscriptionExpiresAt).toBeGreaterThan(Date.now());
    expect(org?.maxLoadUnits).toBe(60);

    // User subscription not touched (org-payment)
    const user = await t.run(async (ctx) => ctx.db.get(ownerId));
    expect(user?.subscriptionTier).toBeUndefined();
  });

  it("individual payment still updates user's subscription (existing flow)", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "u@x.com", createdAt: Date.now() })
    );
    await t.run(async (ctx) =>
      ctx.db.insert("payments", {
        userId,
        tier: "pro",
        orderId: "order_pro_1",
        token: "t",
        amount: 2990,
        currency: "RUB",
        status: "pending",
        createdAt: Date.now(),
      })
    );

    await t.mutation(internal.billing.handleBepaidWebhook, {
      transactionType: "payment",
      status: "successful",
      trackingId: "order_pro_1",
      uid: "uid-pro",
      amount: 299000,
      currency: "RUB",
    });

    const user = await t.run(async (ctx) => ctx.db.get(userId));
    expect(user?.subscriptionTier).toBe("pro");
    expect(user?.proAccountLimit).toBe(20);
  });
});
```

- [ ] **Step 5: Запустить тесты**

Run: `npm run test:unit -- tests/unit/billing-webhook-org.test.ts`
Expected: PASS.

- [ ] **Step 6: Закоммитить**

```bash
git add convex/billing.ts convex/organizations.ts tests/unit/billing-webhook-org.test.ts
git commit -m "feat(billing): route agency webhook to organizations table

When payment.orgId is set, handleBepaidWebhook updates
organizations via updateSubscriptionFromPayment (uses TIERS
as single source of truth for maxLoadUnits, not hardcode).

Grace flags cleared via clearGraceFlags (ctx.db.replace) —
fixes Convex patch(undefined) semantics bug.

Individual payments unchanged (existing flow patches users).
2 tests cover both paths."
```

---

## Task 5: Защитить org-юзеров от destructive `updateLimitsOnDowngrade` и `handleExpiredSubscriptions`

**Files:**
- Modify: `convex/billing.ts:824-919`

**Контекст из аудита (Plan 0 / safety review):** existing `updateLimitsOnDowngrade` ставит `account.status = "paused"` и rules `isActive = false`. Для org-юзеров это сломает работу. Решение 4 говорит — overage НЕ выключает sync, только premium-фичи.

- [ ] **Step 1: Защитить updateLimitsOnDowngrade**

Edit `convex/billing.ts:824` `updateLimitsOnDowngrade`. В начало handler:

```typescript
handler: async (ctx, args) => {
  const user = await ctx.db.get(args.userId);
  if (!user) return { accountsDeactivated: 0, rulesDeactivated: 0 };

  // Skip downgrade actions for org-members — they have separate grace policies (Решение 4)
  if (user.organizationId) {
    return {
      accountsDeactivated: 0,
      rulesDeactivated: 0,
      skipped: "user is in organization, downgrade not applied",
    };
  }

  // ... existing logic for individuals continues ...
```

- [ ] **Step 2: Защитить handleExpiredSubscriptions**

Edit `convex/billing.ts:893` `handleExpiredSubscriptions`. В loop:

```typescript
for (const user of users) {
  // Skip org-members — Plan 4 (Load Monitoring) handles org expiry separately
  if (user.organizationId) continue;

  if (
    user.subscriptionTier !== "freemium" &&
    user.subscriptionExpiresAt &&
    user.subscriptionExpiresAt < now
  ) {
    await ctx.db.patch(user._id, {
      subscriptionTier: "freemium",
      updatedAt: now,
    });
    processed++;
  }
}
```

- [ ] **Step 3: Test что org-юзер защищён**

Add test в `tests/unit/billing-webhook-org.test.ts`:

```typescript
describe("org-user safety in downgrade flows", () => {
  it("updateLimitsOnDowngrade skips org-members", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        email: "o@x.com",
        organizationId: "fake_org_id" as any,
        createdAt: Date.now(),
      })
    );
    const result = await t.mutation(internal.billing.updateLimitsOnDowngrade, {
      userId: ownerId,
      newTier: "freemium",
    });
    expect(result.accountsDeactivated).toBe(0);
    expect(result.rulesDeactivated).toBe(0);
  });

  it("handleExpiredSubscriptions skips org-members", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) =>
      ctx.db.insert("users", {
        email: "o@x.com",
        organizationId: "fake_org_id" as any,
        subscriptionTier: "pro",
        subscriptionExpiresAt: Date.now() - 1000,
        createdAt: Date.now(),
      })
    );
    const result = await t.mutation(internal.billing.handleExpiredSubscriptions);
    expect(result.processed).toBe(0);
  });
});
```

- [ ] **Step 4: Закоммитить**

```bash
git add convex/billing.ts tests/unit/billing-webhook-org.test.ts
git commit -m "fix(billing): isolate org-users from individual downgrade logic

updateLimitsOnDowngrade and handleExpiredSubscriptions now skip
users with organizationId — org has separate grace policies
(Решение 4). Without this guard, agency users would have
accounts.status='paused' and rules deactivated on subscription
expiry, breaking spec 3.8 'sync never stopped' guarantee.

Plan 4 will implement org-specific expired flow (load-units cron
+ expired-grace-progression cron)."
```

---

## Task 6: Расширить referral-логику для agency-платежей (C16)

**Files:**
- Modify: `convex/referrals.ts`

- [ ] **Step 1: Расширить `applyReferralBonus` args с `paymentTier`**

> **Стыковочный анализ:** Текущая сигнатура `applyReferralBonus` не принимает `paymentTier` — `bonusDays = 7` hardcoded. Для agency-тарифов бонус может отличаться. Добавляем `paymentTier` arg.

Edit `convex/referrals.ts`. Найти `applyReferralBonus`:

```typescript
export const applyReferralBonus = internalMutation({
  args: {
    referralCode: v.string(),
    referredUserId: v.id("users"),
    paymentId: v.id("payments"),
    paymentTier: v.optional(v.string()),  // NEW: для tier-specific bonus
  },
  handler: async (ctx, args) => {
    // ... existing dedup logic ...

    // Tier-specific bonus days
    const TIER_BONUS_DAYS: Record<string, number> = {
      start: 7,
      pro: 14,
      agency_s: 14,
      agency_m: 14,
      agency_l: 21,
      agency_xl: 30,
    };
    const bonusDays = TIER_BONUS_DAYS[args.paymentTier ?? "start"] ?? 7;

    // ... rest of existing logic uses bonusDays ...
  },
});
```

> **Обратная совместимость:** `paymentTier` — optional. Existing callers (webhook до обновления Plan 3 Task 4) не передают его → fallback на 7 дней (start). После Task 4 webhook всегда передаёт `paymentTier`.

- [ ] **Step 2: Закоммитить**

```bash
git add convex/referrals.ts
git commit -m "feat(referrals): support agency tiers in bonus calculation

applyReferralBonus now accepts optional paymentTier arg.
agency_s/m: same as Pro (14 days), agency_l: 21 days, agency_xl: 30 days.
Bonus added to referrer's subscriptionExpiresAt as before — no org-side
changes (referrer remains individual unless they themselves are owner).
Backwards-compatible: paymentTier is optional, defaults to 7 days."
```

---

## Task 7: Расширить promo-codes на agency (17.2.3)

**Files:**
- Modify: `convex/billing.ts:329-483` (часть webhook где применяется promo)

- [ ] **Step 1: Проверить где применяется promo**

Look at handleBepaidWebhook где обрабатывается `payment.promoCode` (~L357-369). Логика — find promo + bonusDays. Добавляются к expiresAt.

Для agency — таких bonus days **не должно быть** (agency-цены не предполагают промо-бонусов в виде дней). Promo на agency должно быть **скидкой** (применяется в createBepaidCheckout до оплаты), не бонус-днями.

- [ ] **Step 2: Защитить webhook от promo-bonusDays для agency**

Edit `convex/billing.ts:357`:

```typescript
let bonusDays = 0;
const isAgencyPayment = isAgencyTier(payment.tier);
if (payment.promoCode && !isAgencyPayment) {
  // Promo bonus days only for individual tiers
  const promo = await ctx.db
    .query("promoCodes")
    .withIndex("by_code", (q) => q.eq("code", payment.promoCode!))
    .first();
  if (promo && promo.isActive
      && (!promo.expiresAt || promo.expiresAt > Date.now())
      && (!promo.maxUses || promo.usedCount < promo.maxUses)) {
    bonusDays = promo.bonusDays;
    await ctx.db.patch(promo._id, { usedCount: promo.usedCount + 1 });
  }
}
// For agency: promo (if any) was already applied as discount during checkout
```

И где-то в `createBepaidCheckout` для agency-тарифов — promo может применяться как скидка к `amountBYN` (сейчас это вне scope, делается на frontend). Документируем поведение в коммит-сообщении.

- [ ] **Step 3: Коммит**

```bash
git add convex/billing.ts
git commit -m "fix(billing): promo-bonus-days disabled for agency payments

For individual tiers (start/pro): promo gives extra subscription days
(existing behavior).

For agency: bonus days don't make sense (subscription is monthly with
fixed package). Frontend may apply promo as discount to amount during
checkout, but webhook does NOT add days. This prevents double-counting
when admin grants promo for agency client.

C16/17.2.3 from impact analysis."
```

---

## Task 8: End-of-plan verification

- [ ] **Step 1: Полный CI**

Run: `npm run ci`

- [ ] **Step 2: DEV smoke test через dashboard**

1. Создать тестовую org (Plan 1 createTestOrganization уже умеет)
2. Создать payment с `tier: "agency_m"`, `orgId: <test_org_id>`, `status: "pending"`
3. Вызвать `internal.billing.handleBepaidWebhook` с status=successful
4. Проверить — org subscription активирована, user не тронут

- [ ] **Step 3: Production deploy**

---

## Self-Review

**Spec coverage:**
- ✅ TIERS agency_* — Task 1 (включая `TIER_RULE_LIMITS` extension + `getUserPrices` расширение)
- ✅ Решение 2 (calculateUpgradePriceWithFallback + lastPayment фильтрация по типу тарифа) — Task 2
- ✅ createBepaidCheckout для agency (idempotent createPending) — Task 3
- ✅ Webhook routing на organizations (clearGraceFlags через replace) — Task 4
- ✅ Защита org-юзеров от downgrade — Task 5
- ✅ Referrals для agency (C16, tier-specific bonusDays) — Task 6
- ✅ Promo для agency (17.2.3) — Task 7

**Стыковочный анализ (rev 2) — все 6 проблем исправлены:**
- ✅ Change 1: createPending idempotency (Task 3 Step 3)
- ✅ Change 2: TIER_LIMITS → TIERS import (Task 4 Step 2)
- ✅ Change 3: patch(undefined) → clearGraceFlags с replace (Task 4 Step 1)
- ✅ Change 4: getUpgradePrice фильтрация по isAgencyTier (Task 2 Step 4)
- ✅ Change 5: getUserPrices расширение (Task 1 Step 3) + cross-plan note
- ✅ Change 6: referralCode в AgencyOnboardingPage — cross-plan note

**Не покрыто здесь — отложено:**
- `lockedPrices` для agency (C7) — нет immediate use case (grandfathered → agency не приоритет первой итерации); если понадобится, делается позже
- Frontend изменения PaymentModal/PricingPage — Plan 6 (UI задачи)

**Type consistency:**
- Все `tier` literals — `"agency_s" | "agency_m" | "agency_l" | "agency_xl"` единые
- TIER_ORDER расширен симметрично с TIERS
- `isAgencyTier()` helper используется вместо `.startsWith("agency_")` во всех новых местах

**Placeholder scan:** Нет TODO/TBD.

---

## Cross-Plan Dependencies

### → Plan 4 (Load & Grace)
- `clearGraceFlags` определён здесь (organizations.ts) — Plan 4 импортирует его для load monitoring cron и expired-grace-progression cron
- `TIERS[tier].includedLoadUnits` — single source of truth, Plan 4 использует для сравнения

### → Plan 6 (UI)
- **Agency prices:** Plan 6 PricingPage и AgencyOnboardingPage MUST использовать `getUserPrices` query (расширен в Task 1 Step 3), НЕ hardcode цены. Текущий Plan 6 содержит 2 hardcoded источника (`AGENCY_TIERS` в PricingPage строки 113-122, `TIER_THRESHOLDS` в AgencyOnboardingPage строки 328-332) — заменить на данные из query.
- **Referral:** AgencyOnboardingPage MUST читать `localStorage('adpilot_referral_code')` и передавать `referralCode` в `createBepaidCheckout`. Текущий Plan 6 НЕ делает этого (строки 357-366 вызывают checkout без referralCode).

### ← Plan 2 (Auth & Access)
- `orgAuth.ts:328` содержит `const PRO_PRICE = 2990; // TODO: replace with TIERS.pro.price after Plan 3` — после Plan 3 заменить на `import { TIERS } from "./billing"`.

---

Готов к Plan 4 (Load Monitoring + Grace).

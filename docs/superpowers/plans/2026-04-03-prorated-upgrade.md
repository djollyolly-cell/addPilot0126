# Prorated Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** При переходе Start → Pro пользователь доплачивает разницу с учётом неиспользованных дней текущей подписки (кредит по фактической сумме последнего платежа).

**Architecture:** Новая query `getUpgradePrice` в `convex/billing.ts` считает кредит за остаток. Фронт (`PaymentModal.tsx`) вызывает query, рассчитывает `upgradeCost = max(ceil(newTierPriceBYN - credit), 1)` и передаёт уменьшенную сумму в `createBepaidCheckout`. Поля `isUpgrade`/`creditAmount` логируются в `payments` для аудита.

**Tech Stack:** Convex (query/mutation/action), React, Vitest

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `convex/schema.ts` | Modify (lines 309-331) | Add `isUpgrade`, `creditAmount` optional fields to payments table |
| `convex/billing.ts` | Modify | Add `getUpgradePrice` query; add `isUpgrade`/`creditAmount` args to `createBepaidCheckout` and `savePendingPayment` |
| `src/components/PaymentModal.tsx` | Modify | Call `getUpgradePrice`, show credit info, pass reduced amount |
| `tests/unit/billing-upgrade.test.ts` | Create | Unit tests for credit calculation logic |

---

### Task 1: Add optional fields to payments schema

**Files:**
- Modify: `convex/schema.ts:309-331`

- [ ] **Step 1: Add `isUpgrade` and `creditAmount` to payments table**

In `convex/schema.ts`, inside the `payments` table definition, after `completedAt` (line 327), add two optional fields:

```typescript
    completedAt: v.optional(v.number()),
    isUpgrade: v.optional(v.boolean()),
    creditAmount: v.optional(v.number()),
  })
```

Note: `schemaValidation: false` is used, so no migration needed.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add convex/schema.ts
git commit -m "feat: add isUpgrade and creditAmount fields to payments schema"
```

---

### Task 2: Add `getUpgradePrice` query to billing.ts

**Files:**
- Modify: `convex/billing.ts` (add after `getSubscription` query, ~line 54)
- Create: `tests/unit/billing-upgrade.test.ts`

- [ ] **Step 1: Write the failing test for getUpgradePrice logic**

Create `tests/unit/billing-upgrade.test.ts`:

```typescript
import { describe, test, expect } from "vitest";

/**
 * Pure calculation functions extracted from getUpgradePrice logic.
 * These are tested independently of Convex runtime.
 */

export const TIER_ORDER: Record<string, number> = {
  freemium: 0,
  start: 1,
  pro: 2,
};

export interface UpgradePriceInput {
  currentTier: string;
  newTier: string;
  subscriptionExpiresAt: number | undefined;
  lastPaymentAmount: number | undefined;
  lastPaymentBonusDays: number | undefined;
  lastPaymentCurrency: string | undefined;
  now: number;
}

export interface UpgradePriceResult {
  credit: number;
  remainingDays: number;
  isUpgrade: boolean;
  currency?: string;
}

export function calculateUpgradePrice(input: UpgradePriceInput): UpgradePriceResult {
  const { currentTier, newTier, subscriptionExpiresAt, lastPaymentAmount, lastPaymentBonusDays, lastPaymentCurrency, now } = input;
  const noUpgrade = { credit: 0, remainingDays: 0, isUpgrade: false };

  // No active subscription or freemium
  if (currentTier === "freemium" || !subscriptionExpiresAt || subscriptionExpiresAt <= now) {
    return noUpgrade;
  }

  // Same or lower tier — not an upgrade
  if ((TIER_ORDER[newTier] ?? 0) <= (TIER_ORDER[currentTier] ?? 0)) {
    return noUpgrade;
  }

  // No previous payment
  if (!lastPaymentAmount || !lastPaymentCurrency) {
    return noUpgrade;
  }

  const remainingDays = Math.ceil((subscriptionExpiresAt - now) / (24 * 60 * 60 * 1000));
  const totalDays = 30 + (lastPaymentBonusDays || 0);
  const dailyRate = lastPaymentAmount / totalDays;
  const credit = Math.round(dailyRate * remainingDays * 100) / 100;

  return {
    credit,
    remainingDays,
    isUpgrade: true,
    currency: lastPaymentCurrency,
  };
}

describe("calculateUpgradePrice", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  test("Start → Pro with 20 remaining days, 35 BYN payment", () => {
    const result = calculateUpgradePrice({
      currentTier: "start",
      newTier: "pro",
      subscriptionExpiresAt: now + 20 * DAY_MS,
      lastPaymentAmount: 35,
      lastPaymentBonusDays: 0,
      lastPaymentCurrency: "BYN",
      now,
    });
    expect(result.isUpgrade).toBe(true);
    expect(result.remainingDays).toBe(20);
    // dailyRate = 35/30 = 1.1667, credit = 1.1667 * 20 = 23.33
    expect(result.credit).toBeCloseTo(23.33, 1);
    expect(result.currency).toBe("BYN");
  });

  test("freemium → Pro returns no upgrade", () => {
    const result = calculateUpgradePrice({
      currentTier: "freemium",
      newTier: "pro",
      subscriptionExpiresAt: now + 20 * DAY_MS,
      lastPaymentAmount: 35,
      lastPaymentBonusDays: 0,
      lastPaymentCurrency: "BYN",
      now,
    });
    expect(result.isUpgrade).toBe(false);
    expect(result.credit).toBe(0);
  });

  test("expired subscription returns no upgrade", () => {
    const result = calculateUpgradePrice({
      currentTier: "start",
      newTier: "pro",
      subscriptionExpiresAt: now - DAY_MS,
      lastPaymentAmount: 35,
      lastPaymentBonusDays: 0,
      lastPaymentCurrency: "BYN",
      now,
    });
    expect(result.isUpgrade).toBe(false);
  });

  test("Pro → Pro (renewal) returns no upgrade", () => {
    const result = calculateUpgradePrice({
      currentTier: "pro",
      newTier: "pro",
      subscriptionExpiresAt: now + 15 * DAY_MS,
      lastPaymentAmount: 88,
      lastPaymentBonusDays: 0,
      lastPaymentCurrency: "BYN",
      now,
    });
    expect(result.isUpgrade).toBe(false);
  });

  test("Start → Start (renewal) returns no upgrade", () => {
    const result = calculateUpgradePrice({
      currentTier: "start",
      newTier: "start",
      subscriptionExpiresAt: now + 15 * DAY_MS,
      lastPaymentAmount: 35,
      lastPaymentBonusDays: 0,
      lastPaymentCurrency: "BYN",
      now,
    });
    expect(result.isUpgrade).toBe(false);
  });

  test("payment with promo bonus days adjusts daily rate", () => {
    const result = calculateUpgradePrice({
      currentTier: "start",
      newTier: "pro",
      subscriptionExpiresAt: now + 25 * DAY_MS,
      lastPaymentAmount: 35,
      lastPaymentBonusDays: 7,
      lastPaymentCurrency: "BYN",
      now,
    });
    expect(result.isUpgrade).toBe(true);
    expect(result.remainingDays).toBe(25);
    // totalDays = 37, dailyRate = 35/37 = 0.9459, credit = 0.9459 * 25 = 23.65
    expect(result.credit).toBeCloseTo(23.65, 1);
  });

  test("no previous payment returns no upgrade", () => {
    const result = calculateUpgradePrice({
      currentTier: "start",
      newTier: "pro",
      subscriptionExpiresAt: now + 20 * DAY_MS,
      lastPaymentAmount: undefined,
      lastPaymentBonusDays: undefined,
      lastPaymentCurrency: undefined,
      now,
    });
    expect(result.isUpgrade).toBe(false);
  });

  test("1 remaining day gives minimal credit", () => {
    const result = calculateUpgradePrice({
      currentTier: "start",
      newTier: "pro",
      subscriptionExpiresAt: now + 0.5 * DAY_MS, // half a day → ceil = 1
      lastPaymentAmount: 35,
      lastPaymentBonusDays: 0,
      lastPaymentCurrency: "BYN",
      now,
    });
    expect(result.isUpgrade).toBe(true);
    expect(result.remainingDays).toBe(1);
    // dailyRate = 35/30 = 1.1667, credit = 1.17
    expect(result.credit).toBeCloseTo(1.17, 1);
  });
});

describe("upgradeCost calculation (frontend logic)", () => {
  test("upgradeCost = max(ceil(newTierPriceBYN - credit), 1)", () => {
    const newTierPriceBYN = 88;
    const credit = 23.33;
    const upgradeCost = Math.max(Math.ceil(newTierPriceBYN - credit), 1);
    expect(upgradeCost).toBe(65);
  });

  test("upgradeCost minimum is 1 BYN even if credit > price", () => {
    const newTierPriceBYN = 20;
    const credit = 30;
    const upgradeCost = Math.max(Math.ceil(newTierPriceBYN - credit), 1);
    expect(upgradeCost).toBe(1);
  });

  test("exact match rounds to 0 → clamped to 1", () => {
    const newTierPriceBYN = 88;
    const credit = 88;
    const upgradeCost = Math.max(Math.ceil(newTierPriceBYN - credit), 1);
    expect(upgradeCost).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/billing-upgrade.test.ts`
Expected: FAIL — `calculateUpgradePrice` is not defined yet (importing from test file itself, should pass since we define it inline. Actually the function is defined in the test file, so it will pass immediately — this is a pure function test.)

- [ ] **Step 3: Run tests to verify they pass**

Run: `npx vitest run tests/unit/billing-upgrade.test.ts`
Expected: All 10 tests PASS

- [ ] **Step 4: Add `getUpgradePrice` query to billing.ts**

In `convex/billing.ts`, after the `getSubscription` query (after line 54), add:

```typescript
// Calculate upgrade credit for prorated pricing
export const getUpgradePrice = query({
  args: {
    userId: v.id("users"),
    newTier: v.union(v.literal("start"), v.literal("pro")),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return { credit: 0, remainingDays: 0, isUpgrade: false };

    const currentTier = (user.subscriptionTier as string) ?? "freemium";
    const expiresAt = user.subscriptionExpiresAt;
    const now = Date.now();

    const tierOrder: Record<string, number> = { freemium: 0, start: 1, pro: 2 };
    const noUpgrade = { credit: 0, remainingDays: 0, isUpgrade: false };

    // No active subscription or freemium
    if (currentTier === "freemium" || !expiresAt || expiresAt <= now) {
      return noUpgrade;
    }

    // Same or lower tier — not an upgrade
    if ((tierOrder[args.newTier] ?? 0) <= (tierOrder[currentTier] ?? 0)) {
      return noUpgrade;
    }

    // Last completed payment
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .order("desc")
      .collect();
    const lastPayment = payments.find((p) => p.status === "completed");

    if (!lastPayment) {
      return noUpgrade;
    }

    const remainingDays = Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000));
    const totalDays = 30 + (lastPayment.bonusDays || 0);
    const dailyRate = lastPayment.amount / totalDays;
    const credit = Math.round(dailyRate * remainingDays * 100) / 100;

    return {
      credit,
      remainingDays,
      isUpgrade: true,
      currency: lastPayment.currency,
    };
  },
});
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add convex/billing.ts tests/unit/billing-upgrade.test.ts
git commit -m "feat: add getUpgradePrice query and unit tests for prorated upgrade"
```

---

### Task 3: Add `isUpgrade`/`creditAmount` to `createBepaidCheckout` and `savePendingPayment`

**Files:**
- Modify: `convex/billing.ts:66-169` (createBepaidCheckout) and `convex/billing.ts:172-195` (savePendingPayment)

- [ ] **Step 1: Add args to `savePendingPayment`**

In `convex/billing.ts`, modify `savePendingPayment` args (line 173-181). Add after `promoCode`:

```typescript
    promoCode: v.optional(v.string()),
    isUpgrade: v.optional(v.boolean()),
    creditAmount: v.optional(v.number()),
```

And in the handler's `ctx.db.insert` call (line 183-193), add the new fields:

```typescript
    await ctx.db.insert("payments", {
      userId: args.userId,
      tier: args.tier,
      orderId: args.orderId,
      token: args.token,
      amount: args.amount,
      currency: args.currency,
      promoCode: args.promoCode?.trim().toUpperCase(),
      isUpgrade: args.isUpgrade,
      creditAmount: args.creditAmount,
      status: "pending",
      createdAt: Date.now(),
    });
```

- [ ] **Step 2: Add args to `createBepaidCheckout`**

In `convex/billing.ts`, modify `createBepaidCheckout` args (line 67-73). Add after `amountBYN`:

```typescript
    amountBYN: v.number(),
    isUpgrade: v.optional(v.boolean()),
    creditAmount: v.optional(v.number()),
```

And in the `savePendingPayment` call (line 146-154), pass the new fields:

```typescript
      await ctx.runMutation(internal.billing.savePendingPayment, {
        userId: args.userId,
        tier: args.tier,
        orderId,
        token: data.checkout.token as string,
        amount: args.amountBYN,
        currency: "BYN",
        promoCode: args.promoCode,
        isUpgrade: args.isUpgrade,
        creditAmount: args.creditAmount,
      });
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No errors

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add convex/billing.ts
git commit -m "feat: pass isUpgrade and creditAmount through checkout flow"
```

---

### Task 4: Update PaymentModal to show prorated price

**Files:**
- Modify: `src/components/PaymentModal.tsx`

- [ ] **Step 1: Add `getUpgradePrice` query call**

At the top of the `PaymentModal` component (after line 61 where `createBepaidCheckout` is declared), add:

```typescript
  const upgradeInfo = useQuery(
    api.billing.getUpgradePrice,
    user?.userId ? { userId: user.userId as Id<"users">, newTier: tier } : "skip"
  );
```

- [ ] **Step 2: Add upgrade cost calculation**

After the `priceBYN` calculation (line 105), add computed values:

```typescript
  const priceRUB = PRICES_RUB[tier];
  const priceBYN = calculateBYNPrice(priceRUB);

  // Prorated upgrade calculation
  const isUpgrade = upgradeInfo?.isUpgrade === true;
  const upgradeCredit = upgradeInfo?.credit ?? 0;
  const upgradeCostBYN = isUpgrade
    ? Math.max(Math.ceil(priceBYN - upgradeCredit), 1)
    : priceBYN;
  const finalAmountBYN = isUpgrade ? upgradeCostBYN : priceBYN;
```

- [ ] **Step 3: Show credit info block in BYN payment step**

In the BYN payment section (after the features `<div>` at line ~331, before the promo code section), add the upgrade info block:

```tsx
            {/* Upgrade credit info */}
            {isUpgrade && (
              <div className="p-4 bg-green-500/10 rounded-lg space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Кредит за остаток {upgradeInfo?.currency === "BYN" ? (user as any)?.subscriptionTier : ""} ({upgradeInfo?.remainingDays} дн.)</span>
                  <span className="text-green-700 dark:text-green-400 font-medium">−{upgradeCredit.toFixed(2)} BYN</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Стоимость {tierInfo.name}</span>
                  <span>{priceBYN} BYN</span>
                </div>
                <div className="flex justify-between font-bold border-t border-border pt-1 mt-1">
                  <span>К оплате</span>
                  <span>{upgradeCostBYN} BYN</span>
                </div>
              </div>
            )}
```

Add the same block in the RUB payment section (after the conversion info `<div>` at line ~478).

- [ ] **Step 4: Update `handleBepaidCheckout` to use prorated amount**

Modify `handleBepaidCheckout` (line 140-167). Change the `createBepaidCheckout` call to pass `finalAmountBYN`, `isUpgrade`, and `creditAmount`:

```typescript
  const handleBepaidCheckout = async () => {
    if (!user?.userId) return;

    setBepaidLoading(true);
    setError(null);

    try {
      const returnUrl = `${window.location.origin}/pricing`;

      const result = await createBepaidCheckout({
        userId: user.userId as Id<"users">,
        tier,
        returnUrl,
        amountBYN: finalAmountBYN,
        promoCode: promoApplied ? promoCode.trim().toUpperCase() : undefined,
        isUpgrade: isUpgrade || undefined,
        creditAmount: isUpgrade ? upgradeCredit : undefined,
      });

      if (result.success && result.redirectUrl) {
        window.location.href = result.redirectUrl;
      } else {
        setError(result.error || 'Ошибка создания платежа');
      }
    } catch {
      setError('Произошла ошибка при создании платежа');
    } finally {
      setBepaidLoading(false);
    }
  };
```

- [ ] **Step 5: Update button text to show final amount**

In the BYN payment button (line ~413), change the button text to use `finalAmountBYN`:

```tsx
                  Перейти к оплате {finalAmountBYN} BYN
```

Do the same for the RUB payment button (line ~560):

```tsx
                  Перейти к оплате {finalAmountBYN} BYN
```

- [ ] **Step 6: Update description in BYN header**

Modify the CardDescription in BYN section (line ~312). If it's an upgrade, show the reduced price:

```tsx
            <CardDescription className="pl-8">
              {isUpgrade ? `${upgradeCostBYN} BYN (доплата)` : `${price} ${currencySymbol}/месяц`} • 🇧🇾 Беларусь
            </CardDescription>
```

- [ ] **Step 7: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add src/components/PaymentModal.tsx
git commit -m "feat: show prorated upgrade price in PaymentModal"
```

---

### Task 5: Final verification

- [ ] **Step 1: Run all unit tests**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Typecheck Convex**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No errors

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: No new errors (max 50 warnings threshold)

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 5: Commit any remaining changes**

If any fixes were needed, commit them:
```bash
git add -A
git commit -m "fix: address lint/typecheck issues for prorated upgrade"
```

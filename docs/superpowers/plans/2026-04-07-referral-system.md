# Реферальная система — План реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Реферальная система с бонусами за приведённых оплативших пользователей (+7 дней, бесплатный месяц за 3, скидка 15% за 10+).

**Architecture:** Новая таблица `referrals` для связей реферер→приглашённый. Реферальные поля на `users` (code, type, count). Бонусы начисляются в `handleBepaidWebhook` при первой оплате. Фильтры в админке через action (не реактивный query).

**Tech Stack:** Convex (schema, mutations, actions, queries), React (Settings tab, PaymentModal, AdminPage), Telegram Bot API.

**Spec:** `docs/superpowers/specs/2026-04-07-referral-system-design.md`

---

## Файловая структура

| Файл | Действие | Ответственность |
|---|---|---|
| `convex/schema.ts` | Modify | Добавить поля в `users`, `payments`; новая таблица `referrals` |
| `convex/referrals.ts` | Create | CRUD рефералов, валидация кода, начисление бонусов, миграция, админ-фильтры |
| `convex/billing.ts` | Modify | Интеграция реферального кода в checkout и webhook |
| `convex/telegram.ts` | Modify | Уведомления о рефералах |
| `convex/users.ts` | Modify | Генерация referralCode при создании пользователя |
| `convex/admin.ts` | Modify | Реферальные колонки в listUsers |
| `src/pages/SettingsPage.tsx` | Modify | Новая вкладка "Рефералы" |
| `src/components/PaymentModal.tsx` | Modify | Поле ввода реферального кода |
| `src/pages/AdminPage.tsx` | Modify | Сводные колонки + детальная таблица + фильтры |
| `tests/unit/referrals.test.ts` | Create | Тесты чистых функций |

---

### Task 1: Schema — новые поля и таблица

**Files:**
- Modify: `convex/schema.ts`

- [ ] **Step 1: Добавить реферальные поля в таблицу `users`**

В таблицу `users` после `subscriptionExpiresAt` добавить:

```typescript
    // Referral system
    referralCode: v.optional(v.string()),
    referralType: v.optional(v.union(v.literal("basic"), v.literal("discount"))),
    referralDiscount: v.optional(v.number()),
    referralCount: v.optional(v.number()),
    referralBonusDaysEarned: v.optional(v.number()),
    referredBy: v.optional(v.id("users")),
    referralMilestone3Claimed: v.optional(v.boolean()),
    referralMilestone10Reached: v.optional(v.boolean()),
```

Добавить индекс `by_referralCode` в users:

```typescript
    .index("by_referralCode", ["referralCode"])
```

- [ ] **Step 2: Добавить реферальные поля в таблицу `payments`**

В таблицу `payments` после `promoCode` добавить:

```typescript
    referralCode: v.optional(v.string()),
    referralDiscount: v.optional(v.number()),
```

- [ ] **Step 3: Создать таблицу `referrals`**

После таблицы `promoCodes` добавить:

```typescript
  referrals: defineTable({
    referrerId: v.id("users"),
    referredId: v.id("users"),
    referralCode: v.string(),
    status: v.union(v.literal("registered"), v.literal("paid")),
    paymentId: v.optional(v.id("payments")),
    bonusDaysGranted: v.optional(v.number()),
    createdAt: v.number(),
    paidAt: v.optional(v.number()),
  })
    .index("by_referrerId", ["referrerId"])
    .index("by_referredId", ["referredId"])
    .index("by_referralCode", ["referralCode"]),
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add convex/schema.ts
git commit -m "feat(referral): add schema — users fields, referrals table, payments fields"
```

---

### Task 2: Backend — генерация кода и базовые функции

**Files:**
- Create: `convex/referrals.ts`
- Modify: `convex/users.ts`

- [ ] **Step 1: Создать `convex/referrals.ts` с генерацией кода и валидацией**

```typescript
import { v } from "convex/values";
import { query, mutation, internalMutation, action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

// ─── Helpers ─────────────────────────────────────────

function generateReferralCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I,O,0,1 to avoid confusion
  let code = "REF-";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ─── Queries ─────────────────────────────────────────

/** Validate a referral code entered by invited user at payment */
export const validateReferralCode = query({
  args: { code: v.string(), userId: v.optional(v.id("users")) },
  handler: async (ctx, args) => {
    const code = args.code.trim().toUpperCase();
    if (code.length < 4) return { valid: false, error: "Код слишком короткий" };

    const referrer = await ctx.db
      .query("users")
      .withIndex("by_referralCode", (q) => q.eq("referralCode", code))
      .first();

    if (!referrer) return { valid: false, error: "Код не найден" };
    if (args.userId && referrer._id === args.userId) {
      return { valid: false, error: "Нельзя использовать свой код" };
    }

    // Check if this user already used a referral code (first payment only)
    if (args.userId) {
      const existingReferral = await ctx.db
        .query("referrals")
        .withIndex("by_referredId", (q) => q.eq("referredId", args.userId))
        .first();
      if (existingReferral) {
        return { valid: false, error: "Реферальный код можно использовать только при первой оплате" };
      }

      // Check if user already has completed payments
      const payments = await ctx.db
        .query("payments")
        .withIndex("by_userId", (q) => q.eq("userId", args.userId))
        .filter((q) => q.eq(q.field("status"), "completed"))
        .first();
      if (payments) {
        return { valid: false, error: "Реферальный код можно использовать только при первой оплате" };
      }
    }

    const isDiscount = referrer.referralType === "discount";
    const discount = isDiscount ? (referrer.referralDiscount ?? 10) : 0;

    return {
      valid: true,
      referrerId: referrer._id,
      referrerName: referrer.name || referrer.email || "Пользователь",
      discount,
      isDiscount,
    };
  },
});

/** Get referral stats for the current user (Settings tab) */
export const getMyReferralStats = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return null;

    const referrals = await ctx.db
      .query("referrals")
      .withIndex("by_referrerId", (q) => q.eq("referrerId", args.userId))
      .collect();

    const registered = referrals.length;
    const paid = referrals.filter((r) => r.status === "paid").length;
    const bonusDays = user.referralBonusDaysEarned ?? 0;

    return {
      referralCode: user.referralCode ?? null,
      referralType: user.referralType ?? "basic",
      referralDiscount: user.referralDiscount ?? 10,
      registered,
      paid,
      bonusDays,
      milestone3Claimed: user.referralMilestone3Claimed ?? false,
      milestone10Reached: user.referralMilestone10Reached ?? false,
      referrals: referrals.map((r) => ({
        referredId: r.referredId,
        status: r.status,
        createdAt: r.createdAt,
        paidAt: r.paidAt,
        bonusDaysGranted: r.bonusDaysGranted,
      })),
    };
  },
});

// ─── Mutations ───────────────────────────────────────

/** Generate a unique referral code for a user (called on registration or migration) */
export const generateCodeForUser = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user || user.referralCode) return;

    let code: string;
    let attempts = 0;
    do {
      code = generateReferralCode();
      const existing = await ctx.db
        .query("users")
        .withIndex("by_referralCode", (q) => q.eq("referralCode", code))
        .first();
      if (!existing) break;
      attempts++;
    } while (attempts < 10);

    await ctx.db.patch(args.userId, {
      referralCode: code,
      referralType: "basic",
      referralDiscount: 10,
      referralCount: 0,
      referralBonusDaysEarned: 0,
      referralMilestone3Claimed: false,
      referralMilestone10Reached: false,
    });
  },
});

/** Apply referral bonus when invited user pays for the first time */
export const applyReferralBonus = internalMutation({
  args: {
    referralCode: v.string(),
    referredUserId: v.id("users"),
    paymentId: v.id("payments"),
  },
  handler: async (ctx, args) => {
    const referrer = await ctx.db
      .query("users")
      .withIndex("by_referralCode", (q) => q.eq("referralCode", args.referralCode))
      .first();
    if (!referrer) return null;

    // Check for duplicate — already paid referral from this user
    const existing = await ctx.db
      .query("referrals")
      .withIndex("by_referredId", (q) => q.eq("referredId", args.referredUserId))
      .filter((q) => q.eq(q.field("status"), "paid"))
      .first();
    if (existing) return null;

    // Create or update referral record
    const existingReg = await ctx.db
      .query("referrals")
      .withIndex("by_referredId", (q) => q.eq("referredId", args.referredUserId))
      .first();

    const bonusDays = 7;
    const now = Date.now();

    if (existingReg) {
      await ctx.db.patch(existingReg._id, {
        status: "paid",
        paymentId: args.paymentId,
        bonusDaysGranted: bonusDays,
        paidAt: now,
      });
    } else {
      await ctx.db.insert("referrals", {
        referrerId: referrer._id,
        referredId: args.referredUserId,
        referralCode: args.referralCode,
        status: "paid",
        paymentId: args.paymentId,
        bonusDaysGranted: bonusDays,
        createdAt: now,
        paidAt: now,
      });
    }

    // Grant +7 days to referrer
    const currentExpires = referrer.subscriptionExpiresAt ?? now;
    const base = Math.max(currentExpires, now);
    const newExpires = base + bonusDays * 24 * 60 * 60 * 1000;
    const newCount = (referrer.referralCount ?? 0) + 1;
    const totalBonusDays = (referrer.referralBonusDaysEarned ?? 0) + bonusDays;

    const patch: Record<string, unknown> = {
      subscriptionExpiresAt: newExpires,
      referralCount: newCount,
      referralBonusDaysEarned: totalBonusDays,
    };

    // Milestone: 3 referrals → +30 days (one-time)
    let milestone3 = false;
    if (newCount >= 3 && !referrer.referralMilestone3Claimed) {
      patch.subscriptionExpiresAt = (newExpires as number) + 30 * 24 * 60 * 60 * 1000;
      patch.referralBonusDaysEarned = (totalBonusDays as number) + 30;
      patch.referralMilestone3Claimed = true;
      milestone3 = true;
    }

    // Milestone: 10 referrals → 15% discount flag
    let milestone10 = false;
    if (newCount >= 10 && !referrer.referralMilestone10Reached) {
      patch.referralMilestone10Reached = true;
      milestone10 = true;
    }

    await ctx.db.patch(referrer._id, patch);

    // Set referredBy on the invited user (write-once)
    const referred = await ctx.db.get(args.referredUserId);
    if (referred && !referred.referredBy) {
      await ctx.db.patch(args.referredUserId, { referredBy: referrer._id });
    }

    return {
      referrerId: referrer._id,
      bonusDays,
      newCount,
      milestone3,
      milestone10,
    };
  },
});

// ─── Admin ───────────────────────────────────────────

/** Admin: update referral type and discount for a user */
export const adminUpdateReferral = mutation({
  args: {
    userId: v.id("users"),
    referralType: v.union(v.literal("basic"), v.literal("discount")),
    referralDiscount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = { referralType: args.referralType };
    if (args.referralDiscount !== undefined) {
      patch.referralDiscount = args.referralDiscount;
    }
    await ctx.db.patch(args.userId, patch);
  },
});

/** Admin: filtered list of users with referral data (action, not reactive) */
export const adminFilterReferrals = action({
  args: {
    minReferrals: v.optional(v.number()),
    maxReferrals: v.optional(v.number()),
    referralType: v.optional(v.string()),
    search: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const allUsers = await ctx.runQuery(internal.referrals.getAllUsersWithReferrals);

    let filtered = allUsers;

    if (args.minReferrals !== undefined) {
      filtered = filtered.filter((u) => (u.referralCount ?? 0) >= args.minReferrals!);
    }
    if (args.maxReferrals !== undefined) {
      filtered = filtered.filter((u) => (u.referralCount ?? 0) <= args.maxReferrals!);
    }
    if (args.referralType && args.referralType !== "all") {
      filtered = filtered.filter((u) => u.referralType === args.referralType);
    }
    if (args.search) {
      const s = args.search.toLowerCase();
      filtered = filtered.filter((u) =>
        (u.name ?? "").toLowerCase().includes(s) ||
        (u.email ?? "").toLowerCase().includes(s)
      );
    }

    return filtered;
  },
});

/** Internal: get all users with referral codes (for admin filter) */
export const getAllUsersWithReferrals = internalQuery({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    return users
      .filter((u) => u.referralCode)
      .map((u) => ({
        _id: u._id,
        name: u.name,
        email: u.email,
        referralCode: u.referralCode,
        referralType: u.referralType ?? "basic",
        referralDiscount: u.referralDiscount ?? 10,
        referralCount: u.referralCount ?? 0,
        referralBonusDaysEarned: u.referralBonusDaysEarned ?? 0,
        milestone3Claimed: u.referralMilestone3Claimed ?? false,
        milestone10Reached: u.referralMilestone10Reached ?? false,
      }));
  },
});

/** Admin: get referral details for a specific user */
export const adminGetUserReferrals = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const referrals = await ctx.db
      .query("referrals")
      .withIndex("by_referrerId", (q) => q.eq("referrerId", args.userId))
      .collect();

    const details = [];
    for (const r of referrals) {
      const referred = await ctx.db.get(r.referredId);
      details.push({
        _id: r._id,
        referredName: referred?.name ?? referred?.email ?? "—",
        referredEmail: referred?.email ?? "—",
        status: r.status,
        createdAt: r.createdAt,
        paidAt: r.paidAt,
        bonusDaysGranted: r.bonusDaysGranted,
      });
    }
    return details;
  },
});

// ─── Migration ───────────────────────────────────────

/** One-time migration: generate referral codes for all existing users */
export const migrateExistingUsers = internalMutation({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    let migrated = 0;
    for (const user of users) {
      if (user.referralCode) continue;

      let code: string;
      let attempts = 0;
      do {
        code = generateReferralCode();
        const existing = await ctx.db
          .query("users")
          .withIndex("by_referralCode", (q) => q.eq("referralCode", code))
          .first();
        if (!existing) break;
        attempts++;
      } while (attempts < 10);

      await ctx.db.patch(user._id, {
        referralCode: code,
        referralType: "basic",
        referralDiscount: 10,
        referralCount: 0,
        referralBonusDaysEarned: 0,
        referralMilestone3Claimed: false,
        referralMilestone10Reached: false,
      });
      migrated++;
    }
    console.log(`[referral-migration] Migrated ${migrated} users`);
    return { migrated };
  },
});
```

Добавить недостающий import в начало файла:

```typescript
import { internalQuery } from "./_generated/server";
```

- [ ] **Step 2: Добавить генерацию кода в создание пользователя**

В `convex/users.ts`, в функции `create` (mutation), после `ctx.db.insert("users", ...)` добавить вызов:

```typescript
await ctx.runMutation(internal.referrals.generateCodeForUser, { userId });
```

Добавить import `internal` если отсутствует.

В `convex/authEmail.ts` (если email-регистрация создаёт пользователей отдельно) — аналогично.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add convex/referrals.ts convex/users.ts
git commit -m "feat(referral): backend — code generation, validation, bonus logic, migration, admin queries"
```

---

### Task 3: Интеграция в billing — checkout и webhook

**Files:**
- Modify: `convex/billing.ts`

- [ ] **Step 1: Добавить `referralCode` в `createBepaidCheckout`**

В args функции `createBepaidCheckout` добавить:

```typescript
referralCode: v.optional(v.string()),
```

В `savePendingPayment` передать:

```typescript
referralCode: args.referralCode?.toUpperCase(),
```

Если реферальный код со скидкой — применить скидку к `amount`. Для этого перед расчётом суммы:

```typescript
let referralDiscount = 0;
if (args.referralCode) {
  const referrer = await ctx.runQuery(internal.referrals.findReferrerByCode, {
    code: args.referralCode.toUpperCase(),
  });
  if (referrer && referrer.referralType === "discount") {
    referralDiscount = referrer.referralDiscount ?? 10;
  }
}
```

Применить скидку к `amountBYN`:

```typescript
const discountedAmount = referralDiscount > 0
  ? Math.round(amountBYN * (100 - referralDiscount) / 100)
  : amountBYN;
```

Использовать `discountedAmount` в запросе к bePaid.

Сохранить `referralDiscount` в payment record.

- [ ] **Step 2: Добавить `findReferrerByCode` internalQuery в `convex/referrals.ts`**

```typescript
export const findReferrerByCode = internalQuery({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_referralCode", (q) => q.eq("referralCode", args.code))
      .first();
    if (!user) return null;
    return {
      _id: user._id,
      referralType: user.referralType ?? "basic",
      referralDiscount: user.referralDiscount ?? 10,
    };
  },
});
```

- [ ] **Step 3: Добавить реферальный бонус в `handleBepaidWebhook`**

В `handleBepaidWebhook`, после применения промокода (после строки с `promo.usedCount + 1`), добавить блок обработки реферального кода:

```typescript
// Referral bonus
if (payment.referralCode) {
  const bonusResult = await ctx.runMutation(internal.referrals.applyReferralBonus, {
    referralCode: payment.referralCode,
    referredUserId: payment.userId,
    paymentId: payment._id,
  });

  if (bonusResult) {
    // Send Telegram notification to referrer
    await ctx.scheduler.runAfter(0, internal.telegram.sendReferralNotification, {
      referrerId: bonusResult.referrerId,
      bonusDays: bonusResult.bonusDays,
      totalReferrals: bonusResult.newCount,
      milestone3: bonusResult.milestone3,
      milestone10: bonusResult.milestone10,
    });
  }
}
```

- [ ] **Step 4: Валидация — реферальный код и промокод взаимоисключающие**

В `createBepaidCheckout` добавить проверку:

```typescript
if (args.promoCode && args.referralCode) {
  throw new Error("Нельзя использовать промокод и реферальный код одновременно");
}
```

- [ ] **Step 5: Скидка 15% для пользователей с 10+ рефералами**

В `createBepaidCheckout`, после проверки промо/реферального кода, добавить:

```typescript
// Auto-apply 15% discount for users with 10+ referrals
if (!args.promoCode && !args.referralCode) {
  const user = await ctx.runQuery(internal.users.getUser, { userId: args.userId });
  if (user?.referralMilestone10Reached) {
    referralDiscount = 15;
  }
}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add convex/billing.ts convex/referrals.ts
git commit -m "feat(referral): integrate into billing — checkout discount, webhook bonus, mutual exclusion with promo"
```

---

### Task 4: Telegram уведомления

**Files:**
- Modify: `convex/telegram.ts`

- [ ] **Step 1: Добавить `sendReferralNotification` internalAction**

```typescript
export const sendReferralNotification = internalAction({
  args: {
    referrerId: v.id("users"),
    bonusDays: v.number(),
    totalReferrals: v.number(),
    milestone3: v.boolean(),
    milestone10: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.runQuery(internal.users.getUser, { userId: args.referrerId });
    if (!user?.telegramChatId) return;

    let message = `🎁 По вашему промокоду подключился новый пользователь!\n`;
    message += `Вам начислено +${args.bonusDays} дней к подписке.\n`;
    message += `Всего рефералов: ${args.totalReferrals}.`;

    if (args.milestone3) {
      message += `\n\n🎉 3 реферала! Вам начислен бесплатный месяц (+30 дней).`;
    }

    if (args.milestone10) {
      message += `\n\n🏆 10 рефералов! Теперь вы получаете скидку 15% на все оплаты.`;
    }

    const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    if (!TELEGRAM_TOKEN) return;

    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: user.telegramChatId,
        text: message,
        parse_mode: "HTML",
      }),
    });
  },
});
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add convex/telegram.ts
git commit -m "feat(referral): telegram notification on referral payment"
```

---

### Task 5: Frontend — вкладка "Рефералы" в Настройках

**Files:**
- Modify: `src/pages/SettingsPage.tsx`

- [ ] **Step 1: Добавить вкладку "Рефералы" в массив табов**

В массив табов (рядом с "Профиль", "Telegram", "API", "Бизнес") добавить:

```typescript
{ id: "referral", label: "Рефералы", icon: Gift }
```

Импортировать `Gift` из `lucide-react`.

- [ ] **Step 2: Создать компонент `ReferralTab`**

Внутри `SettingsPage.tsx` (или в отдельном файле, если SettingsPage уже большой) добавить:

```tsx
function ReferralTab({ userId }: { userId: string }) {
  const stats = useQuery(
    api.referrals.getMyReferralStats,
    { userId: userId as Id<"users"> }
  );

  if (stats === undefined) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!stats || !stats.referralCode) {
    return <p className="text-sm text-muted-foreground py-4">Реферальный код не найден</p>;
  }

  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(stats.referralCode!);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Code */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Ваш реферальный код</CardTitle>
          <CardDescription>
            Поделитесь кодом — получайте бонусные дни за каждого оплатившего пользователя
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <code className="text-lg font-mono bg-muted px-4 py-2 rounded-lg">
              {stats.referralCode}
            </code>
            <Button variant="outline" size="sm" onClick={handleCopy}>
              {copied ? <CheckCircle className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? "Скопировано" : "Копировать"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{stats.paid}</div>
            <p className="text-sm text-muted-foreground">Оплативших рефералов</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">+{stats.bonusDays} дн.</div>
            <p className="text-sm text-muted-foreground">Дней заработано</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{stats.registered}</div>
            <p className="text-sm text-muted-foreground">Всего приглашённых</p>
          </CardContent>
        </Card>
      </div>

      {/* Progress bars */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Прогресс бонусов</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="flex justify-between text-sm mb-1">
              <span>Бесплатный месяц</span>
              <span className={stats.milestone3Claimed ? "text-green-600" : ""}>
                {Math.min(stats.paid, 3)}/3
              </span>
            </div>
            <div className="w-full bg-muted rounded-full h-2">
              <div
                className={cn("h-2 rounded-full", stats.milestone3Claimed ? "bg-green-500" : "bg-primary")}
                style={{ width: `${Math.min(100, (stats.paid / 3) * 100)}%` }}
              />
            </div>
            {stats.milestone3Claimed && (
              <p className="text-xs text-green-600 mt-1">Получено!</p>
            )}
          </div>
          <div>
            <div className="flex justify-between text-sm mb-1">
              <span>Скидка 15% на оплату</span>
              <span className={stats.milestone10Reached ? "text-green-600" : ""}>
                {Math.min(stats.paid, 10)}/10
              </span>
            </div>
            <div className="w-full bg-muted rounded-full h-2">
              <div
                className={cn("h-2 rounded-full", stats.milestone10Reached ? "bg-green-500" : "bg-primary")}
                style={{ width: `${Math.min(100, (stats.paid / 10) * 100)}%` }}
              />
            </div>
            {stats.milestone10Reached && (
              <p className="text-xs text-green-600 mt-1">Активна!</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Referral list */}
      {stats.referrals.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Приглашённые</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {stats.referrals.map((r, i) => (
                <div key={i} className="flex items-center justify-between text-sm py-1.5 border-b last:border-0">
                  <span className="text-muted-foreground">
                    {new Date(r.createdAt).toLocaleDateString("ru-RU")}
                  </span>
                  <Badge variant={r.status === "paid" ? "success" : "secondary"}>
                    {r.status === "paid" ? "Оплатил" : "Зарегистрирован"}
                  </Badge>
                  {r.bonusDaysGranted && (
                    <span className="text-xs text-green-600">+{r.bonusDaysGranted} дн.</span>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Подключить вкладку в рендер**

В switch/if по активному табу добавить:

```tsx
{activeTab === "referral" && <ReferralTab userId={user.userId} />}
```

- [ ] **Step 4: Typecheck и визуальная проверка**

Run: `npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pages/SettingsPage.tsx
git commit -m "feat(referral): settings tab — code display, stats, progress, referral list"
```

---

### Task 6: Frontend — поле реферального кода в PaymentModal

**Files:**
- Modify: `src/components/PaymentModal.tsx`

- [ ] **Step 1: Добавить state и валидацию реферального кода**

```typescript
const [referralCode, setReferralCode] = useState("");
const [referralApplied, setReferralApplied] = useState<{
  discount: number;
  referrerName: string;
} | null>(null);
const [referralError, setReferralError] = useState<string | null>(null);

const referralValidation = useQuery(
  api.referrals.validateReferralCode,
  referralCode.trim().length >= 4
    ? { code: referralCode.trim(), userId: user?.userId as Id<"users"> }
    : "skip"
);
```

- [ ] **Step 2: Добавить обработчик применения реферального кода**

```typescript
const handleApplyReferral = () => {
  if (!referralValidation) return;
  if (!referralValidation.valid) {
    setReferralError(referralValidation.error ?? "Неверный код");
    return;
  }
  // Mutual exclusion with promo code
  if (promoApplied) {
    setPromoApplied(null);
    setPromoCode("");
  }
  setReferralApplied({
    discount: referralValidation.discount,
    referrerName: referralValidation.referrerName!,
  });
  setReferralError(null);
};
```

При применении промокода — сбрасывать реферальный:

```typescript
// В handleApplyPromo, после setPromoApplied:
if (referralApplied) {
  setReferralApplied(null);
  setReferralCode("");
}
```

- [ ] **Step 3: Добавить UI поле ввода реферального кода**

После блока промокода добавить:

```tsx
{/* Referral code */}
<div className="space-y-2">
  <Label>Реферальный код</Label>
  <div className="flex gap-2">
    <Input
      value={referralCode}
      onChange={(e) => {
        setReferralCode(e.target.value);
        setReferralError(null);
        setReferralApplied(null);
      }}
      placeholder="REF-XXXXXX"
      disabled={!!promoApplied}
      className="font-mono"
    />
    <Button
      variant="outline"
      size="sm"
      onClick={handleApplyReferral}
      disabled={referralCode.trim().length < 4 || referralValidation === undefined || !!promoApplied}
    >
      Применить
    </Button>
  </div>
  {referralError && (
    <p className="text-xs text-destructive">{referralError}</p>
  )}
  {referralApplied && (
    <p className="text-xs text-green-600">
      {referralApplied.discount > 0
        ? `Скидка ${referralApplied.discount}% применена`
        : "Код принят"}
    </p>
  )}
  {promoApplied && (
    <p className="text-xs text-muted-foreground">Промокод и реферальный код нельзя использовать вместе</p>
  )}
</div>
```

- [ ] **Step 4: Передать `referralCode` в checkout**

В вызов `createBepaidCheckout` добавить:

```typescript
referralCode: referralApplied ? referralCode.trim().toUpperCase() : undefined,
```

- [ ] **Step 5: Отображение скидки в итоговой сумме**

Если `referralApplied?.discount > 0`, показать пересчитанную сумму:

```tsx
{referralApplied && referralApplied.discount > 0 && (
  <div className="flex justify-between text-sm">
    <span>Скидка реферала ({referralApplied.discount}%)</span>
    <span className="text-green-600">
      −{formatCurrency(Math.round(baseAmount * referralApplied.discount / 100))}
    </span>
  </div>
)}
```

- [ ] **Step 6: Typecheck**

Run: `npm run build`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/components/PaymentModal.tsx
git commit -m "feat(referral): payment modal — referral code field, discount display, mutual exclusion with promo"
```

---

### Task 7: Админка — сводные колонки + детальная таблица + фильтры

**Files:**
- Modify: `src/pages/AdminPage.tsx`
- Modify: `convex/admin.ts`

- [ ] **Step 1: Добавить реферальные данные в `listUsers` query**

В `convex/admin.ts`, в `listUsers` handler, к каждому пользователю добавить поля:

```typescript
referralCode: user.referralCode,
referralType: user.referralType ?? "basic",
referralDiscount: user.referralDiscount ?? 10,
referralCount: user.referralCount ?? 0,
```

- [ ] **Step 2: Добавить колонки в таблицу пользователей**

В `AdminPage.tsx`, в таблицу пользователей после колонки "Промо" добавить:

```tsx
<th className="text-xs font-medium text-muted-foreground px-3 py-2">Рефералов</th>
<th className="text-xs font-medium text-muted-foreground px-3 py-2">Тип ссылки</th>
```

И соответствующие ячейки в строке:

```tsx
<td className="px-3 py-2 text-sm">{u.referralCount ?? 0}</td>
<td className="px-3 py-2">
  <select
    value={u.referralType ?? "basic"}
    onChange={(e) => adminUpdateReferral({
      userId: u._id as Id<"users">,
      referralType: e.target.value as "basic" | "discount",
    })}
    className="text-xs bg-transparent border rounded px-1 py-0.5"
  >
    <option value="basic">Обычная</option>
    <option value="discount">Со скидкой</option>
  </select>
</td>
```

- [ ] **Step 3: Добавить раскрываемую детальную таблицу рефералов**

При клике на строку пользователя раскрывается детальная таблица:

```tsx
const [expandedUserId, setExpandedUserId] = useState<string | null>(null);

// В строке пользователя:
<tr
  className="cursor-pointer hover:bg-muted/50"
  onClick={() => setExpandedUserId(expandedUserId === u._id ? null : u._id)}
>
  {/* ... existing cells ... */}
</tr>

{expandedUserId === u._id && (
  <tr>
    <td colSpan={99} className="px-6 py-3 bg-muted/30">
      <ReferralDetailsTable userId={u._id as Id<"users">} />
    </td>
  </tr>
)}
```

Компонент `ReferralDetailsTable`:

```tsx
function ReferralDetailsTable({ userId }: { userId: Id<"users"> }) {
  const details = useQuery(api.referrals.adminGetUserReferrals, { userId });

  if (details === undefined) return <Loader2 className="h-4 w-4 animate-spin" />;
  if (details.length === 0) return <p className="text-xs text-muted-foreground">Нет рефералов</p>;

  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-muted-foreground">
          <th className="text-left py-1">Имя/Email</th>
          <th className="text-left py-1">Дата регистрации</th>
          <th className="text-left py-1">Дата оплаты</th>
          <th className="text-left py-1">Статус</th>
          <th className="text-left py-1">Бонус</th>
        </tr>
      </thead>
      <tbody>
        {details.map((r) => (
          <tr key={r._id} className="border-t border-border/50">
            <td className="py-1">{r.referredName}</td>
            <td className="py-1">{new Date(r.createdAt).toLocaleDateString("ru-RU")}</td>
            <td className="py-1">{r.paidAt ? new Date(r.paidAt).toLocaleDateString("ru-RU") : "—"}</td>
            <td className="py-1">
              <Badge variant={r.status === "paid" ? "success" : "secondary"} className="text-[10px]">
                {r.status === "paid" ? "Оплатил" : "Регистрация"}
              </Badge>
            </td>
            <td className="py-1">{r.bonusDaysGranted ? `+${r.bonusDaysGranted} дн.` : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 4: Добавить фильтры с кнопкой "Применить"**

```tsx
const [refFilters, setRefFilters] = useState({
  minReferrals: undefined as number | undefined,
  referralType: "all",
  search: "",
});
const [filteredUsers, setFilteredUsers] = useState<typeof users>(null);
const filterReferrals = useAction(api.referrals.adminFilterReferrals);

const handleApplyFilters = async () => {
  const result = await filterReferrals({
    minReferrals: refFilters.minReferrals,
    referralType: refFilters.referralType !== "all" ? refFilters.referralType : undefined,
    search: refFilters.search || undefined,
  });
  setFilteredUsers(result);
};
```

UI фильтров — над таблицей:

```tsx
<div className="flex items-center gap-3 mb-4">
  <select
    value={refFilters.minReferrals ?? ""}
    onChange={(e) => setRefFilters({ ...refFilters, minReferrals: e.target.value ? Number(e.target.value) : undefined })}
    className="text-sm border rounded px-2 py-1"
  >
    <option value="">Все</option>
    <option value="1">1+ реферал</option>
    <option value="3">3+ реферала</option>
    <option value="10">10+ рефералов</option>
  </select>
  <select
    value={refFilters.referralType}
    onChange={(e) => setRefFilters({ ...refFilters, referralType: e.target.value })}
    className="text-sm border rounded px-2 py-1"
  >
    <option value="all">Все типы</option>
    <option value="basic">Обычная</option>
    <option value="discount">Со скидкой</option>
  </select>
  <Input
    value={refFilters.search}
    onChange={(e) => setRefFilters({ ...refFilters, search: e.target.value })}
    placeholder="Поиск по имени/email"
    className="max-w-xs text-sm"
  />
  <Button size="sm" onClick={handleApplyFilters}>Применить</Button>
</div>
```

- [ ] **Step 5: Typecheck**

Run: `npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/pages/AdminPage.tsx convex/admin.ts
git commit -m "feat(referral): admin — summary columns, detail table, filters by button"
```

---

### Task 8: Миграция и деплой

**Files:**
- No new files

- [ ] **Step 1: Typecheck всего проекта**

Run: `npx tsc --noEmit -p convex/tsconfig.json && npm run build`
Expected: PASS

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: PASS (max 50 warnings)

- [ ] **Step 3: Commit всех оставшихся изменений и push**

```bash
git push origin main
```

- [ ] **Step 4: Дождаться деплоя**

```bash
gh run list --limit 2
```

Expected: Deploy workflow success.

- [ ] **Step 5: Запустить миграцию существующих пользователей**

После деплоя запустить через Convex Dashboard или CLI:

```bash
npx convex run referrals:migrateExistingUsers
```

Expected: `[referral-migration] Migrated N users`

- [ ] **Step 6: Проверить в UI**

1. Открыть Настройки → вкладка "Рефералы" — должен отображаться код
2. Открыть PaymentModal — должно быть поле реферального кода
3. Открыть Админку → таблица пользователей — должны быть колонки рефералов

import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../convex/schema";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

const modules = import.meta.glob("../../convex/**/*.ts");

/**
 * End-to-end lifecycle test: pro → expired (downgrade-cron) → pay start (auto-reactivation)
 * → manual activate of remaining paused → CTA appears for user-disabled rules.
 *
 * Покрывает все 4 task'а вместе:
 *  Task 1 — schema marker + downgrade ставит disabledByBillingAt
 *  Task 2 — payment success триггерит updateLimitsOnUpgrade
 *  Task 3 — manual activate для остатка
 *  Task 4 — CTA query показывается в окне 7 дней
 */
describe("Account Activation — Full Lifecycle", () => {
  it("pro → freemium → start → manual activate → CTA shows", async () => {
    const t = convexTest(schema, modules);

    // 1. Setup: pro user с 5 кабинетами + 6 правил (3 reactive active + 1 video_rotation
    //    active + 2 user-disabled reactive)
    const userId = await t.mutation(api.users.create, {
      email: "lifecycle@example.com",
      vkId: "lifecycle_user",
      name: "Lifecycle User",
    });
    await t.mutation(api.users.updateTier, { userId, tier: "pro" });

    const accountIds: Id<"adAccounts">[] = [];
    await t.run(async (ctx) => {
      const baseTime = Date.now();
      for (let i = 0; i < 5; i++) {
        const id = await ctx.db.insert("adAccounts", {
          userId,
          vkAccountId: `LC${i}`,
          name: `Cabinet ${i}`,
          accessToken: `token_${i}`,
          status: "active",
          createdAt: baseTime + i,
        });
        accountIds.push(id);
      }
    });

    const ruleIds: Id<"rules">[] = [];
    await t.run(async (ctx) => {
      const T = Date.now();
      // 3 active reactive
      for (let i = 0; i < 3; i++) {
        const id = await ctx.db.insert("rules", {
          userId,
          name: `Reactive ${i}`,
          type: "cpl_limit",
          conditions: { metric: "cpl", operator: ">", value: 500 },
          actions: { stopAd: false, notify: true },
          targetAccountIds: [accountIds[0]],
          isActive: true,
          triggerCount: 0,
          createdAt: T + i,
          updatedAt: T + i,
        });
        ruleIds.push(id);
      }
      // 1 active video_rotation
      const rotationId = await ctx.db.insert("rules", {
        userId,
        name: "Rotation",
        type: "video_rotation",
        conditions: { metric: "rotation", operator: "=", value: 0, slotDurationHours: 4, dailyBudget: 1000 },
        actions: { stopAd: false, notify: true },
        targetAccountIds: [accountIds[0]],
        isActive: true,
        triggerCount: 0,
        createdAt: T + 3,
        updatedAt: T + 3,
      });
      ruleIds.push(rotationId);
      // 2 user-disabled (без маркера)
      for (let i = 0; i < 2; i++) {
        const id = await ctx.db.insert("rules", {
          userId,
          name: `User Disabled ${i}`,
          type: "min_ctr",
          conditions: { metric: "ctr", operator: "<", value: 1.5 },
          actions: { stopAd: false, notify: true },
          targetAccountIds: [accountIds[0]],
          isActive: false,
          triggerCount: 0,
          createdAt: T + 4 + i,
          updatedAt: T + 4 + i,
        });
        ruleIds.push(id);
      }
    });

    // 2. Downgrade pro → freemium через крон-логику.
    //    freemium: accountsLimit=1, rulesLimit=3
    //    Ожидание: 1 active + 4 paused; 3 active rules + 1 rotation выключено без маркера +
    //    2 reactive с маркером + 2 user-disabled (без изменений)
    await t.mutation(internal.billing.updateLimitsOnDowngrade, {
      userId,
      newTier: "freemium",
    });

    const accountsAfterDowngrade = await t.run(async (ctx) =>
      Promise.all(accountIds.map((id) => ctx.db.get(id)))
    );
    const activeAfterDowngrade = accountsAfterDowngrade.filter((a) => a?.status === "active");
    const pausedAfterDowngrade = accountsAfterDowngrade.filter((a) => a?.status === "paused");
    expect(activeAfterDowngrade).toHaveLength(1);
    expect(pausedAfterDowngrade).toHaveLength(4);
    // Старейший должен остаться active
    expect(accountsAfterDowngrade[0]?.status).toBe("active");

    const rulesAfterDowngrade = await t.run(async (ctx) =>
      Promise.all(ruleIds.map((id) => ctx.db.get(id)))
    );
    // Reactive 0,1,2 должны остаться (3 ≤ 3 freemium limit). Active rules order — by createdAt
    expect(rulesAfterDowngrade[0]?.isActive).toBe(true);
    expect(rulesAfterDowngrade[1]?.isActive).toBe(true);
    expect(rulesAfterDowngrade[2]?.isActive).toBe(true);
    // Rotation выключен, маркер НЕ ставится
    expect(rulesAfterDowngrade[3]?.isActive).toBe(false);
    expect(rulesAfterDowngrade[3]?.disabledByBillingAt).toBeUndefined();
    // user-disabled остаются как были
    expect(rulesAfterDowngrade[4]?.isActive).toBe(false);
    expect(rulesAfterDowngrade[5]?.isActive).toBe(false);

    // 3. Имитация payment success = переключение subscription tier.
    //    Используем mock processPayment — он триггерит updateLimitsOnUpgrade.
    //    Сначала вернём tier обратно к freemium (downgrade выше его не менял), теперь
    //    апгрейдим до start.
    const result = await t.mutation(api.billing.processPayment, {
      userId,
      tier: "start",
      cardNumber: "4242424242424242",
    });
    expect(result.success).toBe(true);

    const accountsAfterUpgrade = await t.run(async (ctx) =>
      Promise.all(accountIds.map((id) => ctx.db.get(id)))
    );
    // start.accountsLimit = 3. Было 1 active + 4 paused. Реактивируется 2 (slots = 3-1=2).
    const activeAfterUpgrade = accountsAfterUpgrade.filter((a) => a?.status === "active");
    const pausedAfterUpgrade = accountsAfterUpgrade.filter((a) => a?.status === "paused");
    expect(activeAfterUpgrade).toHaveLength(3);
    expect(pausedAfterUpgrade).toHaveLength(2);

    const userAfterUpgrade = await t.run(async (ctx) => ctx.db.get(userId));
    expect(userAfterUpgrade?.lastReactivationAt).toBeDefined();

    // 4. Manual activate одного из оставшихся paused. start = 3 active, 2 paused.
    //    Активация 4-го кабинета должна провалиться (3+1 > 3).
    const remainingPaused = accountsAfterUpgrade.filter((a) => a?.status === "paused");
    await expect(
      t.mutation(api.adAccounts.activate, {
        accountId: remainingPaused[0]!._id,
        userId,
      })
    ).rejects.toThrow(/Лимит активных кабинетов/);

    // 5. CTA должен показываться в окне 7 дней — у нас 2 user-disabled rules.
    //    rotation тоже в счёт (выключен, type === video_rotation).
    const cta = await t.query(api.rules.getReactivationCta, { userId });
    expect(cta.show).toBe(true);
    expect(cta.count).toBe(3); // 2 user-disabled + 1 video_rotation
    expect(cta.hasVideoRotation).toBe(true);
  });

  it("idempotency: webhook retry → updateLimitsOnUpgrade no-op без дублирования audit log", async () => {
    const t = convexTest(schema, modules);

    const userId = await t.mutation(api.users.create, {
      email: "idem@example.com",
      vkId: "idem_user",
      name: "Idem User",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(userId, { subscriptionTier: "freemium" });
      await ctx.db.insert("adAccounts", {
        userId,
        vkAccountId: "IDEM1",
        name: "P1",
        accessToken: "t1",
        status: "paused",
        createdAt: Date.now(),
      });
      await ctx.db.insert("rules", {
        userId,
        name: "BD",
        type: "cpl_limit",
        conditions: { metric: "cpl", operator: ">", value: 500 },
        actions: { stopAd: false, notify: true },
        targetAccountIds: [],
        isActive: false,
        disabledByBillingAt: Date.now() - 1000,
        triggerCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const r1 = await t.mutation(internal.billing.updateLimitsOnUpgrade, {
      userId,
      newTier: "start",
    });
    expect(r1.accountsActivated).toBe(1);
    expect(r1.rulesReactivated).toBe(1);

    const r2 = await t.mutation(internal.billing.updateLimitsOnUpgrade, {
      userId,
      newTier: "start",
    });
    expect(r2.accountsActivated).toBe(0);
    expect(r2.rulesReactivated).toBe(0);

    // Audit log должен иметь только по 1 записи каждого типа (не продублировался)
    const auditEntries = await t.run(async (ctx) =>
      ctx.db.query("auditLog").collect()
    );
    const accountActivations = auditEntries.filter(
      (e) => e.action === "account_activated"
    );
    const ruleReactivations = auditEntries.filter(
      (e) => e.action === "rule_reactivated"
    );
    expect(accountActivations).toHaveLength(1);
    expect(ruleReactivations).toHaveLength(1);
  });
});

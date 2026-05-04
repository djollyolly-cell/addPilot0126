import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

// Helper: создаёт user на start tier с N правилами разных типов
async function createUserWithRules(
  t: ReturnType<typeof convexTest>,
  ruleSpecs: Array<{ type: "cpl_limit" | "min_ctr" | "video_rotation"; isActive: boolean }>
): Promise<{ userId: Id<"users">; ruleIds: Id<"rules">[] }> {
  const userId = await t.mutation(api.users.create, {
    email: "billing@example.com",
    vkId: "billing_user",
    name: "Billing Test User",
  });
  await t.mutation(api.users.updateTier, { userId, tier: "start" });

  const accountId = await t.mutation(api.adAccounts.connect, {
    userId,
    vkAccountId: "B001",
    name: "Billing Cabinet",
    accessToken: "token_billing",
  });

  // Insert rules directly via t.run чтобы обойти проверки лимита и валидации create
  // (нужно создать > rulesLimit для downgrade scenario)
  const ruleIds = await t.run(async (ctx) => {
    const ids: Id<"rules">[] = [];
    for (let i = 0; i < ruleSpecs.length; i++) {
      const spec = ruleSpecs[i];
      const conditions =
        spec.type === "video_rotation"
          ? { metric: "rotation", operator: "=", value: 0, slotDurationHours: 4, dailyBudget: 1000 }
          : { metric: spec.type === "cpl_limit" ? "cpl" : "ctr", operator: spec.type === "cpl_limit" ? ">" : "<", value: 500 };
      const id = await ctx.db.insert("rules", {
        userId,
        name: `Rule ${i + 1} (${spec.type})`,
        type: spec.type,
        conditions,
        actions: { stopAd: false, notify: true },
        targetAccountIds: [accountId],
        isActive: spec.isActive,
        triggerCount: 0,
        createdAt: Date.now() + i, // ordering deterministic
        updatedAt: Date.now() + i,
      });
      ids.push(id);
    }
    return ids;
  });

  return { userId, ruleIds };
}

describe("billing — downgrade marker", () => {
  test("updateLimitsOnDowngrade ставит disabledByBillingAt на reactive правило", async () => {
    const t = convexTest(schema);
    // start (10 правил) → freemium (3 правила) → выключаем 2 правила
    const { userId, ruleIds } = await createUserWithRules(t, [
      { type: "cpl_limit", isActive: true },
      { type: "min_ctr", isActive: true },
      { type: "cpl_limit", isActive: true },
      { type: "min_ctr", isActive: true },
      { type: "cpl_limit", isActive: true },
    ]);

    const before = Date.now();
    await t.mutation(internal.billing.updateLimitsOnDowngrade, {
      userId,
      newTier: "freemium",
    });
    const after = Date.now();

    // Первые 3 (по createdAt) должны остаться active без маркера
    // Последние 2 — выключены с маркером
    const allRules = await t.run(async (ctx) =>
      Promise.all(ruleIds.map((id) => ctx.db.get(id)))
    );

    expect(allRules[0]?.isActive).toBe(true);
    expect(allRules[0]?.disabledByBillingAt).toBeUndefined();
    expect(allRules[1]?.isActive).toBe(true);
    expect(allRules[2]?.isActive).toBe(true);

    expect(allRules[3]?.isActive).toBe(false);
    expect(allRules[3]?.disabledByBillingAt).toBeGreaterThanOrEqual(before);
    expect(allRules[3]?.disabledByBillingAt).toBeLessThanOrEqual(after);

    expect(allRules[4]?.isActive).toBe(false);
    expect(allRules[4]?.disabledByBillingAt).toBeGreaterThanOrEqual(before);
  });

  test("updateLimitsOnDowngrade НЕ ставит маркер на video_rotation", async () => {
    const t = convexTest(schema);
    // 4 правила: 3 reactive (помещаются в freemium=3 limit) + 1 video_rotation который окажется лишним
    const { userId, ruleIds } = await createUserWithRules(t, [
      { type: "cpl_limit", isActive: true },
      { type: "min_ctr", isActive: true },
      { type: "cpl_limit", isActive: true },
      { type: "video_rotation", isActive: true },
    ]);

    await t.mutation(internal.billing.updateLimitsOnDowngrade, {
      userId,
      newTier: "freemium",
    });

    const allRules = await t.run(async (ctx) =>
      Promise.all(ruleIds.map((id) => ctx.db.get(id)))
    );

    // video_rotation выключен но БЕЗ маркера
    expect(allRules[3]?.type).toBe("video_rotation");
    expect(allRules[3]?.isActive).toBe(false);
    expect(allRules[3]?.disabledByBillingAt).toBeUndefined();
  });

  // NOTE: проверка что videoRotation.deactivate реально планируется + rotationState физически
  // удаляется живёт в integration-тестах Задачи 5. convex-test не даёт introspection
  // scheduled queue, а попытка прогнать action в unit-тесте даёт unhandled errors из-за
  // VK API / Telegram chain. В Задаче 5 проверим end-to-end на seeded fixture.
});

// Helper: создаёт user с N кабинетами в paused статусе
async function createUserWithPausedAccounts(
  t: ReturnType<typeof convexTest>,
  pausedCount: number,
  activeCount: number = 0
): Promise<{ userId: Id<"users">; pausedAccountIds: Id<"adAccounts">[]; activeAccountIds: Id<"adAccounts">[] }> {
  const userId = await t.mutation(api.users.create, {
    email: "upgrade@example.com",
    vkId: "upgrade_user",
    name: "Upgrade Test User",
  });
  // Сразу ставим freemium — будем upgrade'ить
  await t.run(async (ctx) => {
    await ctx.db.patch(userId, { subscriptionTier: "freemium" });
  });

  const pausedAccountIds: Id<"adAccounts">[] = [];
  const activeAccountIds: Id<"adAccounts">[] = [];

  await t.run(async (ctx) => {
    const baseTime = Date.now();
    for (let i = 0; i < pausedCount; i++) {
      const id = await ctx.db.insert("adAccounts", {
        userId,
        vkAccountId: `P${i}`,
        name: `Paused ${i}`,
        accessToken: `token_p_${i}`,
        status: "paused",
        createdAt: baseTime + i,
      });
      pausedAccountIds.push(id);
    }
    for (let i = 0; i < activeCount; i++) {
      const id = await ctx.db.insert("adAccounts", {
        userId,
        vkAccountId: `A${i}`,
        name: `Active ${i}`,
        accessToken: `token_a_${i}`,
        status: "active",
        createdAt: baseTime + 1000 + i,
      });
      activeAccountIds.push(id);
    }
  });

  return { userId, pausedAccountIds, activeAccountIds };
}

describe("billing — updateLimitsOnUpgrade", () => {
  test("активирует первые N paused кабинетов до лимита нового тарифа", async () => {
    const t = convexTest(schema);
    // 4 paused, freemium → start (limit=3): activate 3, leave 1 paused
    const { userId, pausedAccountIds } = await createUserWithPausedAccounts(t, 4);

    const result = await t.mutation(internal.billing.updateLimitsOnUpgrade, {
      userId,
      newTier: "start",
    });

    expect(result.accountsActivated).toBe(3);

    // Проверяем по сортировке createdAt asc: первые 3 → active, последний → paused
    const accounts = await t.run(async (ctx) =>
      Promise.all(pausedAccountIds.map((id) => ctx.db.get(id)))
    );
    expect(accounts[0]?.status).toBe("active");
    expect(accounts[1]?.status).toBe("active");
    expect(accounts[2]?.status).toBe("active");
    expect(accounts[3]?.status).toBe("paused");
  });

  test("реактивирует только rules с маркером disabledByBillingAt", async () => {
    const t = convexTest(schema);
    const { userId } = await createUserWithPausedAccounts(t, 0);

    // Создаём правила: одно с маркером (биллинг), одно без (юзер сам выключил)
    const billingDisabledId = await t.run(async (ctx) => {
      return await ctx.db.insert("rules", {
        userId,
        name: "Billing Disabled",
        type: "cpl_limit",
        conditions: { metric: "cpl", operator: ">", value: 500 },
        actions: { stopAd: false, notify: true },
        targetAccountIds: [],
        isActive: false,
        disabledByBillingAt: Date.now() - 1000,
        triggerCount: 0,
        createdAt: Date.now() - 2000,
        updatedAt: Date.now() - 1000,
      });
    });
    const userDisabledId = await t.run(async (ctx) => {
      return await ctx.db.insert("rules", {
        userId,
        name: "User Disabled",
        type: "cpl_limit",
        conditions: { metric: "cpl", operator: ">", value: 500 },
        actions: { stopAd: false, notify: true },
        targetAccountIds: [],
        isActive: false,
        // No disabledByBillingAt — user turned it off
        triggerCount: 0,
        createdAt: Date.now() - 2000,
        updatedAt: Date.now() - 500,
      });
    });

    const result = await t.mutation(internal.billing.updateLimitsOnUpgrade, {
      userId,
      newTier: "start",
    });

    expect(result.rulesReactivated).toBe(1);

    const billingRule = await t.run(async (ctx) => ctx.db.get(billingDisabledId));
    const userRule = await t.run(async (ctx) => ctx.db.get(userDisabledId));

    // Биллинг-выключенное → реактивировано, маркер физически удалён
    expect(billingRule?.isActive).toBe(true);
    expect(billingRule?.disabledByBillingAt).toBeUndefined();
    expect("disabledByBillingAt" in (billingRule ?? {})).toBe(false);

    // Юзер-выключенное → НЕ тронуто
    expect(userRule?.isActive).toBe(false);
  });

  test("НЕ реактивирует video_rotation даже если у него каким-то чудом стоит маркер", async () => {
    const t = convexTest(schema);
    const { userId } = await createUserWithPausedAccounts(t, 0);

    const rotationRuleId = await t.run(async (ctx) => {
      return await ctx.db.insert("rules", {
        userId,
        name: "Rotation",
        type: "video_rotation",
        conditions: { metric: "rotation", operator: "=", value: 0, slotDurationHours: 4, dailyBudget: 1000 },
        actions: { stopAd: false, notify: true },
        targetAccountIds: [],
        isActive: false,
        // Имитируем "leak" маркера — defensive filter должен сработать
        disabledByBillingAt: Date.now() - 1000,
        triggerCount: 0,
        createdAt: Date.now() - 2000,
        updatedAt: Date.now() - 1000,
      });
    });

    await t.mutation(internal.billing.updateLimitsOnUpgrade, {
      userId,
      newTier: "start",
    });

    const rule = await t.run(async (ctx) => ctx.db.get(rotationRuleId));
    expect(rule?.isActive).toBe(false);
    // Маркер остаётся (мы не трогаем video_rotation)
    expect(rule?.disabledByBillingAt).toBeDefined();
  });

  test("идемпотентность: повторный вызов после успешного — no-op без дублирования audit log", async () => {
    const t = convexTest(schema);
    const { userId } = await createUserWithPausedAccounts(t, 2);

    await t.run(async (ctx) => {
      await ctx.db.insert("rules", {
        userId,
        name: "BD Rule",
        type: "cpl_limit",
        conditions: { metric: "cpl", operator: ">", value: 500 },
        actions: { stopAd: false, notify: true },
        targetAccountIds: [],
        isActive: false,
        disabledByBillingAt: Date.now() - 1000,
        triggerCount: 0,
        createdAt: Date.now() - 2000,
        updatedAt: Date.now() - 1000,
      });
    });

    const first = await t.mutation(internal.billing.updateLimitsOnUpgrade, {
      userId,
      newTier: "start",
    });
    expect(first.accountsActivated).toBe(2);
    expect(first.rulesReactivated).toBe(1);

    const second = await t.mutation(internal.billing.updateLimitsOnUpgrade, {
      userId,
      newTier: "start",
    });
    expect(second.accountsActivated).toBe(0);
    expect(second.rulesReactivated).toBe(0);
  });

  test("lastReactivationAt обновляется только если что-то реально реактивировано", async () => {
    const t = convexTest(schema);
    // Юзер БЕЗ paused-кабинетов и БЕЗ disabled-правил
    const { userId } = await createUserWithPausedAccounts(t, 0, 0);

    await t.mutation(internal.billing.updateLimitsOnUpgrade, {
      userId,
      newTier: "start",
    });

    const userAfter = await t.run(async (ctx) => ctx.db.get(userId));
    expect(userAfter?.lastReactivationAt).toBeUndefined();
  });

  test("lastReactivationAt стампится при реактивации", async () => {
    const t = convexTest(schema);
    const { userId } = await createUserWithPausedAccounts(t, 1);

    const before = Date.now();
    await t.mutation(internal.billing.updateLimitsOnUpgrade, {
      userId,
      newTier: "start",
    });
    const after = Date.now();

    const userAfter = await t.run(async (ctx) => ctx.db.get(userId));
    expect(userAfter?.lastReactivationAt).toBeGreaterThanOrEqual(before);
    expect(userAfter?.lastReactivationAt).toBeLessThanOrEqual(after);
  });

  test("skip для org-member (симметрично downgrade)", async () => {
    const t = convexTest(schema);
    const { userId } = await createUserWithPausedAccounts(t, 3);

    // Кладём юзера в org
    const orgId = await t.run(async (ctx) => {
      const oid = await ctx.db.insert("organizations", {
        name: "Test Agency",
        ownerId: userId,
        subscriptionTier: "agency_s",
        maxLoadUnits: 30,
        currentLoadUnits: 0,
        createdAt: Date.now(),
      });
      await ctx.db.patch(userId, { organizationId: oid });
      return oid;
    });

    const result = await t.mutation(internal.billing.updateLimitsOnUpgrade, {
      userId,
      newTier: "start",
    });

    expect(result.accountsActivated).toBe(0);
    expect(result.rulesReactivated).toBe(0);
    expect(result.skipped).toBeDefined();

    // Кабинеты остались paused
    const stillPaused = await t.run(async (ctx) =>
      ctx.db.query("adAccounts").withIndex("by_userId", (q) => q.eq("userId", userId)).collect()
    );
    expect(stillPaused.every((a) => a.status === "paused")).toBe(true);

    // Чтобы avoid unused warning
    expect(orgId).toBeDefined();
  });

  test("proAccountLimit с grandfathered=27 поднимает до 27 paused", async () => {
    const t = convexTest(schema);
    const { userId, pausedAccountIds } = await createUserWithPausedAccounts(t, 15);

    await t.run(async (ctx) => {
      await ctx.db.patch(userId, { proAccountLimit: 27 });
    });

    const result = await t.mutation(internal.billing.updateLimitsOnUpgrade, {
      userId,
      newTier: "pro",
    });

    // Лимит=27, у нас 15 paused — все должны активироваться
    expect(result.accountsActivated).toBe(15);

    const accounts = await t.run(async (ctx) =>
      Promise.all(pausedAccountIds.map((id) => ctx.db.get(id)))
    );
    expect(accounts.every((a) => a?.status === "active")).toBe(true);
  });

  test("proAccountLimit без поля использует TIERS.pro.accountsLimit (9)", async () => {
    const t = convexTest(schema);
    const { userId, pausedAccountIds } = await createUserWithPausedAccounts(t, 15);
    // Без proAccountLimit на user

    const result = await t.mutation(internal.billing.updateLimitsOnUpgrade, {
      userId,
      newTier: "pro",
    });

    // Лимит=9, активируем первые 9 (по createdAt asc), оставшиеся 6 paused
    expect(result.accountsActivated).toBe(9);

    const accounts = await t.run(async (ctx) =>
      Promise.all(pausedAccountIds.map((id) => ctx.db.get(id)))
    );
    const activeCount = accounts.filter((a) => a?.status === "active").length;
    const pausedCountAfter = accounts.filter((a) => a?.status === "paused").length;
    expect(activeCount).toBe(9);
    expect(pausedCountAfter).toBe(6);
  });

  test("сортировка disabled rules по disabledByBillingAt asc — реактивируются старейшие первыми", async () => {
    const t = convexTest(schema);
    const { userId } = await createUserWithPausedAccounts(t, 0);

    // Создадим 5 правил с разными timestamps маркера
    const T = Date.now();
    const ruleIds: Id<"rules">[] = [];
    await t.run(async (ctx) => {
      for (let i = 0; i < 5; i++) {
        const id = await ctx.db.insert("rules", {
          userId,
          name: `Rule ${i}`,
          type: "cpl_limit",
          conditions: { metric: "cpl", operator: ">", value: 500 },
          actions: { stopAd: false, notify: true },
          targetAccountIds: [],
          isActive: false,
          // Чем больше i, тем НОВЕЕ маркер — должны идти ПОСЛЕ
          disabledByBillingAt: T - (5 - i) * 1000,
          triggerCount: 0,
          createdAt: T,
          updatedAt: T,
        });
        ruleIds.push(id);
      }
    });

    // freemium лимит = 3 — реактивируется только 3 первых (старейших по disabledByBillingAt)
    await t.mutation(internal.billing.updateLimitsOnUpgrade, {
      userId,
      newTier: "freemium",
    });

    const rules = await t.run(async (ctx) =>
      Promise.all(ruleIds.map((id) => ctx.db.get(id)))
    );
    // 0, 1, 2 — старейшие маркеры → реактивированы
    expect(rules[0]?.isActive).toBe(true);
    expect(rules[1]?.isActive).toBe(true);
    expect(rules[2]?.isActive).toBe(true);
    // 3, 4 — новейшие маркеры → остались выключены
    expect(rules[3]?.isActive).toBe(false);
    expect(rules[4]?.isActive).toBe(false);
  });

  test("processPayment (mock) триггерит updateLimitsOnUpgrade", async () => {
    const t = convexTest(schema);
    const { userId, pausedAccountIds } = await createUserWithPausedAccounts(t, 2);

    // Мокируемая success-карта: 4242424242424242
    const result = await t.mutation(api.billing.processPayment, {
      userId,
      tier: "start",
      cardNumber: "4242424242424242",
    });

    expect(result.success).toBe(true);

    // После payment кабинеты должны быть автоматически реактивированы
    const accounts = await t.run(async (ctx) =>
      Promise.all(pausedAccountIds.map((id) => ctx.db.get(id)))
    );
    expect(accounts[0]?.status).toBe("active");
    expect(accounts[1]?.status).toBe("active");
  });
});

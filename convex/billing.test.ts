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

import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

// Helper: create user + account for rule targets
async function createTestUserWithAccount(t: ReturnType<typeof convexTest>) {
  const userId = await t.mutation(api.users.create, {
    email: "rules@example.com",
    vkId: "rules_user",
    name: "Rules Test User",
  });
  // Upgrade to start so we have room for rules and stopAd
  await t.mutation(api.users.updateTier, { userId, tier: "start" });

  const accountId = await t.mutation(api.adAccounts.connect, {
    userId,
    vkAccountId: "R001",
    name: "Rules Cabinet",
    accessToken: "token_rules",
  });

  return { userId, accountId };
}

const defaultActions = { stopAd: true, notify: true };

describe("rules", () => {
  // ── Sprint 4 DoD: Unit tests 1-4 — create each rule type ──

  test("creates cpl_limit rule", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "CPL Limit Rule",
      type: "cpl_limit",
      value: 500,
      actions: defaultActions,
      targetAccountIds: [accountId],
    });

    expect(ruleId).toBeDefined();

    const rule = await t.query(api.rules.get, { ruleId });
    expect(rule?.type).toBe("cpl_limit");
    expect(rule?.conditions.value).toBe(500);
    expect(rule?.conditions.metric).toBe("cpl");
    expect(rule?.isActive).toBe(true);
  });

  test("creates min_ctr rule", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Min CTR Rule",
      type: "min_ctr",
      value: 1.5,
      actions: defaultActions,
      targetAccountIds: [accountId],
    });

    expect(ruleId).toBeDefined();

    const rule = await t.query(api.rules.get, { ruleId });
    expect(rule?.type).toBe("min_ctr");
    expect(rule?.conditions.value).toBe(1.5);
    expect(rule?.conditions.metric).toBe("ctr");
  });

  test("creates fast_spend rule", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Fast Spend Rule",
      type: "fast_spend",
      value: 20,
      actions: defaultActions,
      targetAccountIds: [accountId],
    });

    expect(ruleId).toBeDefined();

    const rule = await t.query(api.rules.get, { ruleId });
    expect(rule?.type).toBe("fast_spend");
    expect(rule?.conditions.value).toBe(20);
  });

  test("creates spend_no_leads rule", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Spend No Leads Rule",
      type: "spend_no_leads",
      value: 1000,
      actions: defaultActions,
      targetAccountIds: [accountId],
    });

    expect(ruleId).toBeDefined();

    const rule = await t.query(api.rules.get, { ruleId });
    expect(rule?.type).toBe("spend_no_leads");
    expect(rule?.conditions.value).toBe(1000);
  });

  // ── Sprint 4 DoD: Unit tests 5-7 — validation ──

  test("rejects value = 0", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    await expect(
      t.mutation(api.rules.create, {
        userId,
        name: "Zero Value",
        type: "cpl_limit",
        value: 0,
        actions: defaultActions,
        targetAccountIds: [accountId],
      })
    ).rejects.toThrow("больше 0");
  });

  test("rejects negative value", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    await expect(
      t.mutation(api.rules.create, {
        userId,
        name: "Negative Value",
        type: "cpl_limit",
        value: -100,
        actions: defaultActions,
        targetAccountIds: [accountId],
      })
    ).rejects.toThrow("больше 0");
  });

  test("rejects CTR > 100", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    await expect(
      t.mutation(api.rules.create, {
        userId,
        name: "High CTR",
        type: "min_ctr",
        value: 150,
        actions: defaultActions,
        targetAccountIds: [accountId],
      })
    ).rejects.toThrow("больше 100");
  });

  // ── Sprint 4 DoD: Unit test 8 — toggleActive ──

  test("toggleActive switches isActive", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Toggle Rule",
      type: "cpl_limit",
      value: 500,
      actions: defaultActions,
      targetAccountIds: [accountId],
    });

    // Initially active
    let rule = await t.query(api.rules.get, { ruleId });
    expect(rule?.isActive).toBe(true);

    // Toggle off
    const result = await t.mutation(api.rules.toggleActive, {
      ruleId,
      userId,
    });
    expect(result.isActive).toBe(false);

    rule = await t.query(api.rules.get, { ruleId });
    expect(rule?.isActive).toBe(false);

    // Toggle back on
    const result2 = await t.mutation(api.rules.toggleActive, {
      ruleId,
      userId,
    });
    expect(result2.isActive).toBe(true);
  });

  // ── Sprint 4 DoD: Edge cases 18-19 ──

  test("rejects empty name", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    await expect(
      t.mutation(api.rules.create, {
        userId,
        name: "   ",
        type: "cpl_limit",
        value: 500,
        actions: defaultActions,
        targetAccountIds: [accountId],
      })
    ).rejects.toThrow("не может быть пустым");
  });

  test("rejects duplicate name", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    await t.mutation(api.rules.create, {
      userId,
      name: "My Rule",
      type: "cpl_limit",
      value: 500,
      actions: defaultActions,
      targetAccountIds: [accountId],
    });

    await expect(
      t.mutation(api.rules.create, {
        userId,
        name: "My Rule",
        type: "min_ctr",
        value: 2,
        actions: defaultActions,
        targetAccountIds: [accountId],
      })
    ).rejects.toThrow("уже существует");
  });

  // ── Additional: list, update, delete ──

  test("lists rules for user", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    await t.mutation(api.rules.create, {
      userId,
      name: "Rule 1",
      type: "cpl_limit",
      value: 500,
      actions: defaultActions,
      targetAccountIds: [accountId],
    });
    await t.mutation(api.rules.create, {
      userId,
      name: "Rule 2",
      type: "min_ctr",
      value: 2,
      actions: defaultActions,
      targetAccountIds: [accountId],
    });

    const rules = await t.query(api.rules.list, { userId });
    expect(rules).toHaveLength(2);
  });

  test("updates rule name and value", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Old Name",
      type: "cpl_limit",
      value: 500,
      actions: defaultActions,
      targetAccountIds: [accountId],
    });

    await t.mutation(api.rules.update, {
      ruleId,
      userId,
      name: "New Name",
      value: 700,
    });

    const rule = await t.query(api.rules.get, { ruleId });
    expect(rule?.name).toBe("New Name");
    expect(rule?.conditions.value).toBe(700);
  });

  test("deletes a rule", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Delete Me",
      type: "cpl_limit",
      value: 500,
      actions: defaultActions,
      targetAccountIds: [accountId],
    });

    await t.mutation(api.rules.remove, { ruleId, userId });

    const rule = await t.query(api.rules.get, { ruleId });
    expect(rule).toBeNull();
  });

  test("freemium disables stopAd even if requested", async () => {
    const t = convexTest(schema);

    const userId = await t.mutation(api.users.create, {
      email: "freemium_rules@example.com",
      vkId: "freemium_rules",
    });
    // Stay on freemium — no upgrade

    const accountId = await t.mutation(api.adAccounts.connect, {
      userId,
      vkAccountId: "FR001",
      name: "Freemium Cabinet",
      accessToken: "token_fr",
    });

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Freemium Rule",
      type: "cpl_limit",
      value: 500,
      actions: { stopAd: true, notify: true },
      targetAccountIds: [accountId],
    });

    const rule = await t.query(api.rules.get, { ruleId });
    // Freemium cannot use stopAd — should be forced to false
    expect(rule?.actions.stopAd).toBe(false);
  });
});

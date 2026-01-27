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

  // ── Sprint 5 DoD: Targets and actions ──

  test("creates rule with targets at account level", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Account Target Rule",
      type: "cpl_limit",
      value: 500,
      actions: defaultActions,
      targetAccountIds: [accountId],
    });

    const rule = await t.query(api.rules.get, { ruleId });
    expect(rule).toBeDefined();
    expect(rule?.targetAccountIds).toHaveLength(1);
    expect(rule?.targetAccountIds[0]).toBe(accountId);
  });

  test("creates rule with targets at campaign level", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    // Create campaigns in DB
    const campaignId1 = await t.mutation(api.adAccounts.upsertCampaign, {
      accountId,
      vkCampaignId: "camp_1",
      name: "Campaign 1",
      status: "active",
    });
    const campaignId2 = await t.mutation(api.adAccounts.upsertCampaign, {
      accountId,
      vkCampaignId: "camp_2",
      name: "Campaign 2",
      status: "active",
    });

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Campaign Target Rule",
      type: "min_ctr",
      value: 1.5,
      actions: defaultActions,
      targetAccountIds: [accountId],
      targetCampaignIds: [String(campaignId1), String(campaignId2)],
    });

    const rule = await t.query(api.rules.get, { ruleId });
    expect(rule).toBeDefined();
    expect(rule?.targetAccountIds).toHaveLength(1);
    expect(rule?.targetCampaignIds).toHaveLength(2);
  });

  test("creates rule with targets at ad level", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    // Create campaign + ads
    const campaignId = await t.mutation(api.adAccounts.upsertCampaign, {
      accountId,
      vkCampaignId: "camp_ads",
      name: "Campaign for Ads",
      status: "active",
    });

    const adId1 = await t.mutation(api.adAccounts.upsertAd, {
      accountId,
      campaignId,
      vkAdId: "ad_1",
      name: "Ad 1",
      status: "active",
    });
    const adId2 = await t.mutation(api.adAccounts.upsertAd, {
      accountId,
      campaignId,
      vkAdId: "ad_2",
      name: "Ad 2",
      status: "active",
    });
    const adId3 = await t.mutation(api.adAccounts.upsertAd, {
      accountId,
      campaignId,
      vkAdId: "ad_3",
      name: "Ad 3",
      status: "active",
    });

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Ad Target Rule",
      type: "fast_spend",
      value: 20,
      actions: defaultActions,
      targetAccountIds: [accountId],
      targetAdIds: [String(adId1), String(adId2), String(adId3)],
    });

    const rule = await t.query(api.rules.get, { ruleId });
    expect(rule).toBeDefined();
    expect(rule?.targetAdIds).toHaveLength(3);
  });

  test("rejects empty targets (EMPTY_TARGETS)", async () => {
    const t = convexTest(schema);
    const { userId } = await createTestUserWithAccount(t);

    await expect(
      t.mutation(api.rules.create, {
        userId,
        name: "No Targets Rule",
        type: "cpl_limit",
        value: 500,
        actions: defaultActions,
        targetAccountIds: [] as Id<"adAccounts">[],
      })
    ).rejects.toThrow("EMPTY_TARGETS");
  });

  test("update rejects empty targets", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Will Clear Targets",
      type: "cpl_limit",
      value: 500,
      actions: defaultActions,
      targetAccountIds: [accountId],
    });

    await expect(
      t.mutation(api.rules.update, {
        ruleId,
        userId,
        targetAccountIds: [] as Id<"adAccounts">[],
      })
    ).rejects.toThrow("EMPTY_TARGETS");
  });

  test("creates rule with notify only action", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Notify Only Rule",
      type: "cpl_limit",
      value: 500,
      actions: { stopAd: false, notify: true },
      targetAccountIds: [accountId],
    });

    const rule = await t.query(api.rules.get, { ruleId });
    expect(rule?.actions.stopAd).toBe(false);
    expect(rule?.actions.notify).toBe(true);
  });

  test("creates rule with stop only action", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Stop Only Rule",
      type: "cpl_limit",
      value: 500,
      actions: { stopAd: true, notify: false },
      targetAccountIds: [accountId],
    });

    const rule = await t.query(api.rules.get, { ruleId });
    expect(rule?.actions.stopAd).toBe(true);
    expect(rule?.actions.notify).toBe(false);
  });

  test("creates rule with stop and notify action", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Stop And Notify Rule",
      type: "cpl_limit",
      value: 500,
      actions: { stopAd: true, notify: true },
      targetAccountIds: [accountId],
    });

    const rule = await t.query(api.rules.get, { ruleId });
    expect(rule?.actions.stopAd).toBe(true);
    expect(rule?.actions.notify).toBe(true);
  });

  test("updates rule targets", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    // Create second account (need to upgrade to "start" which allows 3)
    const accountId2 = await t.mutation(api.adAccounts.connect, {
      userId,
      vkAccountId: "R002",
      name: "Second Cabinet",
      accessToken: "token_r2",
    });

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Multi Target Rule",
      type: "cpl_limit",
      value: 500,
      actions: defaultActions,
      targetAccountIds: [accountId],
    });

    // Update to include both accounts
    await t.mutation(api.rules.update, {
      ruleId,
      userId,
      targetAccountIds: [accountId, accountId2],
    });

    const rule = await t.query(api.rules.get, { ruleId });
    expect(rule?.targetAccountIds).toHaveLength(2);
  });
});

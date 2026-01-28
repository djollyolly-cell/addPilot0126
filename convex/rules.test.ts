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

  test("freemium rejects stopAd=true with FEATURE_UNAVAILABLE", async () => {
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

    await expect(
      t.mutation(api.rules.create, {
        userId,
        name: "Freemium Rule",
        type: "cpl_limit",
        value: 500,
        actions: { stopAd: true, notify: true },
        targetAccountIds: [accountId],
      })
    ).rejects.toThrow("FEATURE_UNAVAILABLE");
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

  // ── New rule types: budget_limit, low_impressions ──

  test("creates budget_limit rule", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Budget Limit Rule",
      type: "budget_limit",
      value: 5000,
      actions: defaultActions,
      targetAccountIds: [accountId],
    });

    expect(ruleId).toBeDefined();

    const rule = await t.query(api.rules.get, { ruleId });
    expect(rule?.type).toBe("budget_limit");
    expect(rule?.conditions.metric).toBe("spent");
    expect(rule?.conditions.operator).toBe(">");
    expect(rule?.conditions.value).toBe(5000);
    expect(rule?.isActive).toBe(true);
  });

  test("creates low_impressions rule", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Low Impressions Rule",
      type: "low_impressions",
      value: 100,
      actions: { stopAd: false, notify: true },
      targetAccountIds: [accountId],
    });

    expect(ruleId).toBeDefined();

    const rule = await t.query(api.rules.get, { ruleId });
    expect(rule?.type).toBe("low_impressions");
    expect(rule?.conditions.metric).toBe("impressions");
    expect(rule?.conditions.operator).toBe("<");
    expect(rule?.conditions.value).toBe(100);
  });

  test("budget_limit rejects value <= 0", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    await expect(
      t.mutation(api.rules.create, {
        userId,
        name: "Bad Budget",
        type: "budget_limit",
        value: 0,
        actions: defaultActions,
        targetAccountIds: [accountId],
      })
    ).rejects.toThrow("больше 0");
  });

  test("low_impressions rejects value <= 0", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    await expect(
      t.mutation(api.rules.create, {
        userId,
        name: "Bad Impressions",
        type: "low_impressions",
        value: -50,
        actions: defaultActions,
        targetAccountIds: [accountId],
      })
    ).rejects.toThrow("больше 0");
  });

  test("creates clicks_no_leads rule (clicks >= N, leads = 0)", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Clicks No Leads Rule",
      type: "clicks_no_leads",
      value: 50,
      actions: defaultActions,
      targetAccountIds: [accountId],
    });

    expect(ruleId).toBeDefined();

    const rule = await t.query(api.rules.get, { ruleId });
    expect(rule?.type).toBe("clicks_no_leads");
    expect(rule?.conditions.metric).toBe("clicks_no_leads");
    expect(rule?.conditions.operator).toBe(">=");
    expect(rule?.conditions.value).toBe(50);
  });

  test("clicks_no_leads rejects value <= 0", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    await expect(
      t.mutation(api.rules.create, {
        userId,
        name: "Bad Clicks",
        type: "clicks_no_leads",
        value: 0,
        actions: defaultActions,
        targetAccountIds: [accountId],
      })
    ).rejects.toThrow("больше 0");
  });

  // ── Sprint 6 DoD: Tier limits for rules ──

  test("S6-DoD#1: freemium can create 2 rules", async () => {
    const t = convexTest(schema);

    const userId = await t.mutation(api.users.create, {
      email: "s6_free@example.com",
      vkId: "s6_free",
    });
    // Stay on freemium

    const accountId = await t.mutation(api.adAccounts.connect, {
      userId,
      vkAccountId: "S6F001",
      name: "S6 Freemium Cabinet",
      accessToken: "token_s6f",
    });

    const ruleId1 = await t.mutation(api.rules.create, {
      userId,
      name: "Free Rule 1",
      type: "cpl_limit",
      value: 500,
      actions: { stopAd: false, notify: true },
      targetAccountIds: [accountId],
    });
    expect(ruleId1).toBeDefined();

    const ruleId2 = await t.mutation(api.rules.create, {
      userId,
      name: "Free Rule 2",
      type: "min_ctr",
      value: 2,
      actions: { stopAd: false, notify: true },
      targetAccountIds: [accountId],
    });
    expect(ruleId2).toBeDefined();

    const rules = await t.query(api.rules.list, { userId });
    expect(rules).toHaveLength(2);
  });

  test("S6-DoD#2: freemium rejects 3rd rule with RULE_LIMIT", async () => {
    const t = convexTest(schema);

    const userId = await t.mutation(api.users.create, {
      email: "s6_free3@example.com",
      vkId: "s6_free3",
    });

    const accountId = await t.mutation(api.adAccounts.connect, {
      userId,
      vkAccountId: "S6F002",
      name: "S6 Freemium Cabinet 2",
      accessToken: "token_s6f2",
    });

    await t.mutation(api.rules.create, {
      userId,
      name: "Free Rule A",
      type: "cpl_limit",
      value: 500,
      actions: { stopAd: false, notify: true },
      targetAccountIds: [accountId],
    });

    await t.mutation(api.rules.create, {
      userId,
      name: "Free Rule B",
      type: "min_ctr",
      value: 2,
      actions: { stopAd: false, notify: true },
      targetAccountIds: [accountId],
    });

    // 3rd rule should be rejected
    await expect(
      t.mutation(api.rules.create, {
        userId,
        name: "Free Rule C",
        type: "fast_spend",
        value: 10,
        actions: { stopAd: false, notify: true },
        targetAccountIds: [accountId],
      })
    ).rejects.toThrow("Лимит правил");
  });

  test("S6-DoD#4: start can create 10 rules", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    const ruleTypes: Array<"cpl_limit" | "min_ctr" | "fast_spend" | "spend_no_leads" | "budget_limit" | "low_impressions" | "clicks_no_leads"> =
      ["cpl_limit", "min_ctr", "fast_spend", "spend_no_leads", "budget_limit", "low_impressions", "clicks_no_leads", "cpl_limit", "min_ctr", "fast_spend"];

    for (let i = 0; i < 10; i++) {
      await t.mutation(api.rules.create, {
        userId,
        name: `Start Rule ${i + 1}`,
        type: ruleTypes[i],
        value: (i + 1) * 10,
        actions: defaultActions,
        targetAccountIds: [accountId],
      });
    }

    const rules = await t.query(api.rules.list, { userId });
    expect(rules).toHaveLength(10);
  });

  test("S6-DoD#5: start rejects 11th rule with RULE_LIMIT", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    const ruleTypes: Array<"cpl_limit" | "min_ctr" | "fast_spend" | "spend_no_leads" | "budget_limit" | "low_impressions" | "clicks_no_leads"> =
      ["cpl_limit", "min_ctr", "fast_spend", "spend_no_leads", "budget_limit", "low_impressions", "clicks_no_leads", "cpl_limit", "min_ctr", "fast_spend"];

    for (let i = 0; i < 10; i++) {
      await t.mutation(api.rules.create, {
        userId,
        name: `Start Rule ${i + 1}`,
        type: ruleTypes[i],
        value: (i + 1) * 10,
        actions: defaultActions,
        targetAccountIds: [accountId],
      });
    }

    // 11th rule should be rejected
    await expect(
      t.mutation(api.rules.create, {
        userId,
        name: "Start Rule 11",
        type: "cpl_limit",
        value: 999,
        actions: defaultActions,
        targetAccountIds: [accountId],
      })
    ).rejects.toThrow("Лимит правил");
  });

  // ═══════════════════════════════════════════════════════════
  // Sprint 16 — Full Rules UI (backend scenarios)
  // ═══════════════════════════════════════════════════════════

  // S16-DoD#1: rules.list returns all rules for user (two-column list data)
  test("S16-DoD#1: rules.list returns all user rules for list panel", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    await t.mutation(api.rules.create, {
      userId,
      name: "Rule A",
      type: "cpl_limit",
      value: 300,
      actions: { stopAd: false, notify: true },
      targetAccountIds: [accountId],
    });
    await t.mutation(api.rules.create, {
      userId,
      name: "Rule B",
      type: "min_ctr",
      value: 1.5,
      actions: { stopAd: false, notify: true },
      targetAccountIds: [accountId],
    });

    const rules = await t.query(api.rules.list, { userId });
    expect(rules).toHaveLength(2);
    expect(rules.map((r) => r.name)).toContain("Rule A");
    expect(rules.map((r) => r.name)).toContain("Rule B");
  });

  // S16-DoD#3: rules.update updates name and value (editor save)
  test("S16-DoD#3: rules.update updates name and value", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Original Name",
      type: "cpl_limit",
      value: 500,
      actions: defaultActions,
      targetAccountIds: [accountId],
    });

    await t.mutation(api.rules.update, {
      ruleId,
      userId,
      name: "Updated Name",
      value: 700,
    });

    const updated = await t.query(api.rules.get, { ruleId });
    expect(updated?.name).toBe("Updated Name");
    expect(updated?.conditions.value).toBe(700);
  });

  // S16-DoD#4: rules.update updates actions (editor form actions)
  test("S16-DoD#4: rules.update updates actions", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Action Update Rule",
      type: "budget_limit",
      value: 1000,
      actions: { stopAd: false, notify: true },
      targetAccountIds: [accountId],
    });

    await t.mutation(api.rules.update, {
      ruleId,
      userId,
      actions: { stopAd: true, notify: true },
    });

    const updated = await t.query(api.rules.get, { ruleId });
    expect(updated?.actions.stopAd).toBe(true);
    expect(updated?.actions.notify).toBe(true);
  });

  // S16-DoD#5: validation rejects negative value
  test("S16-DoD#5: create rejects negative value", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    await expect(
      t.mutation(api.rules.create, {
        userId,
        name: "Negative Rule",
        type: "cpl_limit",
        value: -100,
        actions: { stopAd: false, notify: true },
        targetAccountIds: [accountId],
      })
    ).rejects.toThrow("Значение должно быть больше 0");
  });

  // S16-DoD#6: update rejects negative value
  test("S16-DoD#6: update rejects negative value", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Will Update",
      type: "cpl_limit",
      value: 500,
      actions: { stopAd: false, notify: true },
      targetAccountIds: [accountId],
    });

    await expect(
      t.mutation(api.rules.update, {
        ruleId,
        userId,
        value: -100,
      })
    ).rejects.toThrow("Значение должно быть больше 0");
  });

  // S16-DoD#8: empty state — new user has 0 rules
  test("S16-DoD#8: new user has empty rules list", async () => {
    const t = convexTest(schema);
    const userId = await t.mutation(api.users.create, {
      email: "norules@test.com",
      vkId: "norules_user",
      name: "No Rules User",
    });

    const rules = await t.query(api.rules.list, { userId });
    expect(rules).toHaveLength(0);
  });

  // S16-DoD#9: freemium user — limit is 2, third rule rejected
  test("S16-DoD#9: freemium limit — 3rd rule rejected", async () => {
    const t = convexTest(schema);
    const userId = await t.mutation(api.users.create, {
      email: "freelimit@test.com",
      vkId: "freelimit_user",
      name: "Freemium Limit User",
    });
    // Stay on freemium tier (default)

    const accountId = await t.mutation(api.adAccounts.connect, {
      userId,
      vkAccountId: "FL001",
      name: "Free Cabinet",
      accessToken: "token_free",
    });

    // Create 2 rules (freemium limit)
    await t.mutation(api.rules.create, {
      userId,
      name: "Free Rule 1",
      type: "cpl_limit",
      value: 100,
      actions: { stopAd: false, notify: true },
      targetAccountIds: [accountId],
    });
    await t.mutation(api.rules.create, {
      userId,
      name: "Free Rule 2",
      type: "min_ctr",
      value: 2,
      actions: { stopAd: false, notify: true },
      targetAccountIds: [accountId],
    });

    // 3rd rule should be rejected
    await expect(
      t.mutation(api.rules.create, {
        userId,
        name: "Free Rule 3",
        type: "budget_limit",
        value: 500,
        actions: { stopAd: false, notify: true },
        targetAccountIds: [accountId],
      })
    ).rejects.toThrow("Лимит правил");

    // getLimits confirms usage = 2
    const limits = await t.query(api.users.getLimits, { userId });
    expect(limits.usage.rules).toBe(2);
    expect(limits.limits.rules).toBe(2);
  });

  // S16-DoD#10: rules.update updates target accounts
  test("S16-DoD#10: rules.update updates target accounts", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestUserWithAccount(t);

    const accountId2 = await t.mutation(api.adAccounts.connect, {
      userId,
      vkAccountId: "R002",
      name: "Second Cabinet",
      accessToken: "token_second",
    });

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "Target Update Rule",
      type: "cpl_limit",
      value: 500,
      actions: { stopAd: false, notify: true },
      targetAccountIds: [accountId],
    });

    await t.mutation(api.rules.update, {
      ruleId,
      userId,
      targetAccountIds: [accountId, accountId2],
    });

    const updated = await t.query(api.rules.get, { ruleId });
    expect(updated?.targetAccountIds).toHaveLength(2);
  });
});

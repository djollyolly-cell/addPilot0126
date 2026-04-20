import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../convex/schema";

const modules = import.meta.glob("../../convex/**/*.ts");

describe("rules.conditions union", () => {
  it("accepts existing object conditions (L1 backward compat)", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "u@example.com", createdAt: Date.now() })
    );
    const accountId = await t.run(async (ctx) =>
      ctx.db.insert("adAccounts", {
        userId, vkAccountId: "1", name: "A", accessToken: "t",
        status: "active", createdAt: Date.now(),
      })
    );
    const id = await t.run(async (ctx) =>
      ctx.db.insert("rules", {
        userId,
        name: "L1 rule",
        type: "cpl_limit",
        conditions: { metric: "cpl", operator: ">", value: 500 },
        actions: { stopAd: true, notify: true },
        targetAccountIds: [accountId],
        isActive: true,
        triggerCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    expect(id).toBeTruthy();
  });

  it("accepts array conditions (L2 constructor with AND)", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "u@example.com", createdAt: Date.now() })
    );
    const accountId = await t.run(async (ctx) =>
      ctx.db.insert("adAccounts", {
        userId, vkAccountId: "1", name: "A", accessToken: "t",
        status: "active", createdAt: Date.now(),
      })
    );
    const id = await t.run(async (ctx) =>
      ctx.db.insert("rules", {
        userId,
        name: "L2 rule with AND",
        type: "custom",
        conditions: [
          { metric: "cpl", operator: ">", value: 500 },
          { metric: "spent", operator: ">", value: 1000 },
        ],
        actions: { stopAd: true, notify: true },
        targetAccountIds: [accountId],
        isActive: true,
        triggerCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    expect(id).toBeTruthy();
  });

  it("accepts custom_l3 type with customRuleTypeCode", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "u@example.com", createdAt: Date.now() })
    );
    const accountId = await t.run(async (ctx) =>
      ctx.db.insert("adAccounts", {
        userId, vkAccountId: "1", name: "A", accessToken: "t",
        status: "active", createdAt: Date.now(),
      })
    );
    const id = await t.run(async (ctx) =>
      ctx.db.insert("rules", {
        userId,
        name: "L3 custom ROI rule",
        type: "custom_l3",
        customRuleTypeCode: "custom_roi",
        conditions: { metric: "roi", operator: "<", value: 1.5 },
        actions: { stopAd: true, notify: true },
        targetAccountIds: [accountId],
        isActive: true,
        triggerCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    expect(id).toBeTruthy();
  });
});

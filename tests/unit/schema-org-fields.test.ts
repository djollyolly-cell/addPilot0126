import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../convex/schema";

const modules = import.meta.glob("../../convex/**/*.ts");

describe("schema with orgId optional", () => {
  it("can insert user without organizationId (existing flow)", async () => {
    const t = convexTest(schema, modules);
    const id = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        email: "individual@example.com",
        createdAt: Date.now(),
      })
    );
    expect(id).toBeTruthy();
  });

  it("can insert adAccount without orgId (existing flow)", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "u@example.com", createdAt: Date.now() })
    );
    const id = await t.run(async (ctx) =>
      ctx.db.insert("adAccounts", {
        userId,
        vkAccountId: "12345",
        name: "Test cabinet",
        accessToken: "tok",
        status: "active",
        createdAt: Date.now(),
      })
    );
    expect(id).toBeTruthy();
  });

  it("can insert rule without orgId (existing flow)", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "u@example.com", createdAt: Date.now() })
    );
    const accountId = await t.run(async (ctx) =>
      ctx.db.insert("adAccounts", {
        userId,
        vkAccountId: "12345",
        name: "C",
        accessToken: "t",
        status: "active",
        createdAt: Date.now(),
      })
    );
    const id = await t.run(async (ctx) =>
      ctx.db.insert("rules", {
        userId,
        name: "Test rule",
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

  it("can insert adAccount with archived status", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "u@example.com", createdAt: Date.now() })
    );
    const id = await t.run(async (ctx) =>
      ctx.db.insert("adAccounts", {
        userId,
        vkAccountId: "99999",
        name: "Archived cabinet",
        accessToken: "tok",
        status: "archived",
        createdAt: Date.now(),
      })
    );
    expect(id).toBeTruthy();
  });
});

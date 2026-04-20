import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../convex/schema";
import { internal } from "../../convex/_generated/api";

const modules = import.meta.glob("../../convex/**/*.ts");

describe("getAccessibleAccounts", () => {
  it("individual user (no org) sees only their own accounts via by_userId", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "u@example.com", createdAt: Date.now() })
    );
    const acc1 = await t.run(async (ctx) =>
      ctx.db.insert("adAccounts", {
        userId, vkAccountId: "1", name: "A", accessToken: "t",
        status: "active", createdAt: Date.now(),
      })
    );
    await t.run(async (ctx) =>
      ctx.db.insert("adAccounts", {
        userId: "different_user_id" as any, vkAccountId: "2", name: "B",
        accessToken: "t", status: "active", createdAt: Date.now(),
      })
    );
    const accIds = await t.query(internal.accessControl.getAccessibleAccountIds, { userId });
    expect(accIds).toEqual([acc1]);
  });

  it("owner sees all accounts in org (including from other users)", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "owner@example.com", createdAt: Date.now() })
    );
    const orgId = await t.run(async (ctx) =>
      ctx.db.insert("organizations", {
        name: "Org", ownerId, subscriptionTier: "agency_m",
        maxLoadUnits: 60, currentLoadUnits: 0, createdAt: Date.now(),
      })
    );
    await t.run(async (ctx) =>
      ctx.db.patch(ownerId, { organizationId: orgId })
    );
    await t.run(async (ctx) =>
      ctx.db.insert("orgMembers", {
        orgId, userId: ownerId, role: "owner", permissions: [],
        assignedAccountIds: [], status: "active", createdAt: Date.now(),
      })
    );
    const acc1 = await t.run(async (ctx) =>
      ctx.db.insert("adAccounts", {
        userId: ownerId, orgId, vkAccountId: "1", name: "A", accessToken: "t",
        status: "active", createdAt: Date.now(),
      })
    );
    const acc2 = await t.run(async (ctx) =>
      ctx.db.insert("adAccounts", {
        userId: "another_user" as any, orgId, vkAccountId: "2", name: "B",
        accessToken: "t", status: "active", createdAt: Date.now(),
      })
    );
    const accIds = await t.query(internal.accessControl.getAccessibleAccountIds, { userId: ownerId });
    expect(accIds.sort()).toEqual([acc1, acc2].sort());
  });

  it("manager sees only assignedAccountIds, even within same org", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "owner@example.com", createdAt: Date.now() })
    );
    const managerId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "manager@example.com", createdAt: Date.now() })
    );
    const orgId = await t.run(async (ctx) =>
      ctx.db.insert("organizations", {
        name: "Org", ownerId, subscriptionTier: "agency_m",
        maxLoadUnits: 60, currentLoadUnits: 0, createdAt: Date.now(),
      })
    );
    await t.run(async (ctx) =>
      ctx.db.patch(managerId, { organizationId: orgId })
    );
    const acc1 = await t.run(async (ctx) =>
      ctx.db.insert("adAccounts", {
        userId: ownerId, orgId, vkAccountId: "1", name: "Assigned", accessToken: "t",
        status: "active", createdAt: Date.now(),
      })
    );
    await t.run(async (ctx) =>
      ctx.db.insert("adAccounts", {
        userId: ownerId, orgId, vkAccountId: "2", name: "Not assigned", accessToken: "t",
        status: "active", createdAt: Date.now(),
      })
    );
    await t.run(async (ctx) =>
      ctx.db.insert("orgMembers", {
        orgId, userId: managerId, role: "manager", permissions: ["rules", "reports"],
        assignedAccountIds: [acc1], status: "active", createdAt: Date.now(),
      })
    );
    const accIds = await t.query(internal.accessControl.getAccessibleAccountIds, { userId: managerId });
    expect(accIds).toEqual([acc1]);
  });
});

describe("checkPermission", () => {
  it("owner has all permissions implicitly", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "o@example.com", createdAt: Date.now() })
    );
    const orgId = await t.run(async (ctx) =>
      ctx.db.insert("organizations", {
        name: "Org", ownerId, subscriptionTier: "agency_m",
        maxLoadUnits: 60, currentLoadUnits: 0, createdAt: Date.now(),
      })
    );
    await t.run(async (ctx) => ctx.db.patch(ownerId, { organizationId: orgId }));
    await t.run(async (ctx) =>
      ctx.db.insert("orgMembers", {
        orgId, userId: ownerId, role: "owner", permissions: [],
        assignedAccountIds: [], status: "active", createdAt: Date.now(),
      })
    );
    // Owner has all permissions even with empty array
    for (const perm of ["rules", "budgets", "ads_control", "invite_members"]) {
      const has = await t.query(internal.accessControl.hasPermission, {
        userId: ownerId, permission: perm,
      });
      expect(has).toBe(true);
    }
  });

  it("manager has only granted permissions", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "o@example.com", createdAt: Date.now() })
    );
    const mgrId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "m@example.com", createdAt: Date.now() })
    );
    const orgId = await t.run(async (ctx) =>
      ctx.db.insert("organizations", {
        name: "Org", ownerId, subscriptionTier: "agency_m",
        maxLoadUnits: 60, currentLoadUnits: 0, createdAt: Date.now(),
      })
    );
    await t.run(async (ctx) => ctx.db.patch(mgrId, { organizationId: orgId }));
    await t.run(async (ctx) =>
      ctx.db.insert("orgMembers", {
        orgId, userId: mgrId, role: "manager",
        permissions: ["rules", "reports"],
        assignedAccountIds: [], status: "active", createdAt: Date.now(),
      })
    );
    expect(await t.query(internal.accessControl.hasPermission, { userId: mgrId, permission: "rules" })).toBe(true);
    expect(await t.query(internal.accessControl.hasPermission, { userId: mgrId, permission: "ads_control" })).toBe(false);
  });

  it("individual user (no org) gets fallback - all permissions on their own resources", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "u@example.com", createdAt: Date.now() })
    );
    expect(await t.query(internal.accessControl.hasPermission, { userId, permission: "rules" })).toBe(true);
  });
});

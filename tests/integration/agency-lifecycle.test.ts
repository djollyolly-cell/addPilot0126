import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../convex/schema";
import { api, internal } from "../../convex/_generated/api";

const modules = import.meta.glob("../../convex/**/*.ts");

/**
 * Integration tests for the full agency lifecycle.
 * Tests cross-module flows: org creation → members → access control → cleanup.
 */

// Helper: create a user and return ID
async function createUser(t: ReturnType<typeof convexTest>, email: string, vkId?: string) {
  return await t.mutation(api.users.create, {
    email,
    vkId: vkId ?? `vk_${email.split("@")[0]}`,
  });
}

describe("Agency Lifecycle Integration", () => {
  describe("org creation → member invite → access control", () => {
    it("full flow: create org, invite manager, accept, confirm, check access", async () => {
      const t = convexTest(schema, modules);

      // 1. Create owner user (upgrade to pro to allow multiple accounts)
      const ownerId = await createUser(t, "owner@agency.com");
      await t.mutation(api.users.updateTier, { userId: ownerId, tier: "pro" });

      // 2. Create organization via raw DB (simulating post-payment activation)
      const orgId = await t.run(async (ctx) => {
        const oid = await ctx.db.insert("organizations", {
          name: "Test Agency",
          ownerId,
          subscriptionTier: "agency_m" as const,
          subscriptionExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
          maxLoadUnits: 60,
          currentLoadUnits: 0,
          createdAt: Date.now(),
        });
        // Link owner to org
        await ctx.db.patch(ownerId, { organizationId: oid });
        // Create owner membership
        await ctx.db.insert("orgMembers", {
          orgId: oid,
          userId: ownerId,
          role: "owner" as const,
          permissions: [],
          assignedAccountIds: [],
          status: "active" as const,
          createdAt: Date.now(),
        });
        return oid;
      });

      // 3. Owner connects ad accounts
      const acc1 = await t.mutation(api.adAccounts.connect, {
        userId: ownerId,
        vkAccountId: "AGENCY_ACC_1",
        name: "Client 1",
        accessToken: "tok_1",
      });
      // Assign orgId to account
      await t.run(async (ctx) => {
        await ctx.db.patch(acc1, { orgId });
      });

      const acc2 = await t.mutation(api.adAccounts.connect, {
        userId: ownerId,
        vkAccountId: "AGENCY_ACC_2",
        name: "Client 2",
        accessToken: "tok_2",
      });
      await t.run(async (ctx) => {
        await ctx.db.patch(acc2, { orgId });
      });

      // 4. Create invite for manager
      const inviteToken = "invite_mgr_001";
      await t.run(async (ctx) => {
        await ctx.db.insert("orgInvites", {
          orgId,
          email: "manager@agency.com",
          permissions: ["rules", "reports", "logs"],
          assignedAccountIds: [acc1], // manager sees only Client 1
          invitedBy: ownerId,
          token: inviteToken,
          status: "pending" as const,
          createdAt: Date.now(),
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        });
      });

      // 5. Manager registers and accepts invite
      const managerId = await createUser(t, "manager@agency.com");
      const acceptResult = await t.mutation(api.orgAuth.acceptInviteForCurrentUser, {
        token: inviteToken,
        userId: managerId,
      });
      expect(acceptResult.status).toBe("pending_owner_confirm");

      // 6. Owner confirms manager
      const confirmResult = await t.mutation(api.orgAuth.confirmInviteByOwner, {
        inviteId: acceptResult.inviteId,
        ownerUserId: ownerId,
        transferAccountIds: [],
      });
      expect(confirmResult.ok).toBe(true);

      // 7. Verify access control: owner sees all org accounts
      const ownerAccounts = await t.query(internal.accessControl.getAccessibleAccountIds, {
        userId: ownerId,
      });
      expect(ownerAccounts).toHaveLength(2);
      expect(ownerAccounts).toContain(acc1);
      expect(ownerAccounts).toContain(acc2);

      // 8. Verify access control: manager sees only assigned account
      const managerAccounts = await t.query(internal.accessControl.getAccessibleAccountIds, {
        userId: managerId,
      });
      expect(managerAccounts).toHaveLength(1);
      expect(managerAccounts).toContain(acc1);

      // 9. Verify org membership data
      const members = await t.run(async (ctx) =>
        ctx.db.query("orgMembers")
          .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
          .collect()
      );
      expect(members).toHaveLength(2);
      const ownerMember = members.find((m) => m.role === "owner");
      const managerMember = members.find((m) => m.role === "manager");
      expect(ownerMember?.status).toBe("active");
      expect(managerMember?.status).toBe("active");
      expect(managerMember?.permissions).toEqual(["rules", "reports", "logs"]);
    });

    it("expired invite cannot be accepted", async () => {
      const t = convexTest(schema, modules);

      const ownerId = await createUser(t, "owner2@agency.com");
      const orgId = await t.run(async (ctx) => {
        const oid = await ctx.db.insert("organizations", {
          name: "Org 2",
          ownerId,
          subscriptionTier: "agency_s" as const,
          maxLoadUnits: 30,
          currentLoadUnits: 0,
          createdAt: Date.now(),
        });
        await ctx.db.insert("orgMembers", {
          orgId: oid, userId: ownerId, role: "owner" as const,
          permissions: [], assignedAccountIds: [],
          status: "active" as const, createdAt: Date.now(),
        });
        return oid;
      });

      // Create expired invite (expiresAt in the past)
      await t.run(async (ctx) => {
        await ctx.db.insert("orgInvites", {
          orgId,
          email: "late@agency.com",
          permissions: ["rules"],
          assignedAccountIds: [],
          invitedBy: ownerId,
          token: "expired_token",
          status: "pending" as const,
          createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
          expiresAt: Date.now() - 1 * 24 * 60 * 60 * 1000, // expired yesterday
        });
      });

      const managerId = await createUser(t, "late@agency.com");
      await expect(
        t.mutation(api.orgAuth.acceptInviteForCurrentUser, {
          token: "expired_token",
          userId: managerId,
        })
      ).rejects.toThrow();
    });
  });

  describe("deleteUser cascade — full agency context", () => {
    it("deleting org owner cleans up entire org ecosystem", async () => {
      const t = convexTest(schema, modules);

      // Setup: owner + org + 2 accounts + rules + payments + members + invites
      const ownerId = await createUser(t, "cascade_owner@agency.com");
      await t.mutation(api.users.updateTier, { userId: ownerId, tier: "pro" });

      const orgId = await t.run(async (ctx) => {
        const oid = await ctx.db.insert("organizations", {
          name: "Cascade Agency",
          ownerId,
          subscriptionTier: "agency_m" as const,
          maxLoadUnits: 60,
          currentLoadUnits: 12,
          createdAt: Date.now(),
        });
        await ctx.db.patch(ownerId, { organizationId: oid });
        return oid;
      });

      // Owner membership
      await t.run(async (ctx) => {
        await ctx.db.insert("orgMembers", {
          orgId, userId: ownerId, role: "owner" as const,
          permissions: [], assignedAccountIds: [],
          status: "active" as const, createdAt: Date.now(),
        });
      });

      // Ad account + rule
      const accId = await t.mutation(api.adAccounts.connect, {
        userId: ownerId,
        vkAccountId: "CASCADE_ACC",
        name: "Cascade Cabinet",
        accessToken: "tok_cascade",
      });

      await t.run(async (ctx) => {
        await ctx.db.patch(accId, { orgId });
        // Rule
        await ctx.db.insert("rules", {
          userId: ownerId, orgId,
          name: "Cascade Rule", type: "cpl_limit" as const,
          conditions: { metric: "cpl", operator: ">", value: 500 },
          actions: { stopAd: true, notify: true },
          targetAccountIds: [accId], isActive: true,
          triggerCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
        });
        // Payment
        await ctx.db.insert("payments", {
          userId: ownerId, orgId,
          tier: "agency_m" as const, orderId: "ord_cascade",
          token: "tok_pay", amount: 24900, currency: "BYN",
          status: "completed" as const, createdAt: Date.now(),
        });
        // Invite
        await ctx.db.insert("orgInvites", {
          orgId, email: "pending@agency.com",
          permissions: ["rules"], assignedAccountIds: [],
          invitedBy: ownerId, token: "cascade_invite",
          status: "pending" as const,
          createdAt: Date.now(),
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        });
        // Load history
        await ctx.db.insert("loadUnitsHistory", {
          orgId, date: "2026-04-26", loadUnits: 12,
          activeGroupsByAccount: [], capturedAt: Date.now(),
        });
        // Audit log
        await ctx.db.insert("auditLog", {
          userId: ownerId, orgId,
          action: "org.create", details: "test",
          createdAt: Date.now(),
        });
        // Telegram link
        await ctx.db.insert("telegramLinks", {
          userId: ownerId, token: "tg_link", createdAt: Date.now(),
        });
        // User notification
        await ctx.db.insert("userNotifications", {
          userId: ownerId, title: "Test", message: "msg",
          type: "info" as const, isRead: false, createdAt: Date.now(),
        });
      });

      // === DELETE ===
      const result = await t.mutation(api.users.deleteUser, { userId: ownerId });
      expect(result.success).toBe(true);

      // === VERIFY EVERYTHING IS GONE ===
      const checks = await t.run(async (ctx) => {
        const user = await ctx.db.get(ownerId);
        const org = await ctx.db.get(orgId);
        const members = await ctx.db.query("orgMembers")
          .withIndex("by_orgId", (q) => q.eq("orgId", orgId)).collect();
        const invites = await ctx.db.query("orgInvites")
          .withIndex("by_orgId", (q) => q.eq("orgId", orgId)).collect();
        const rules = await ctx.db.query("rules")
          .withIndex("by_userId", (q) => q.eq("userId", ownerId)).collect();
        const accounts = await ctx.db.query("adAccounts")
          .withIndex("by_userId", (q) => q.eq("userId", ownerId)).collect();
        const payments = await ctx.db.query("payments")
          .withIndex("by_userId", (q) => q.eq("userId", ownerId)).collect();
        const loadHistory = await ctx.db.query("loadUnitsHistory")
          .withIndex("by_orgId_date", (q) => q.eq("orgId", orgId)).collect();
        const auditLogs = await ctx.db.query("auditLog")
          .withIndex("by_userId_createdAt", (q) => q.eq("userId", ownerId)).collect();
        const tgLinks = await ctx.db.query("telegramLinks")
          .withIndex("by_userId", (q) => q.eq("userId", ownerId)).collect();
        const userNotifs = await ctx.db.query("userNotifications")
          .withIndex("by_userId", (q) => q.eq("userId", ownerId)).collect();

        return {
          user, org,
          members: members.length,
          invites: invites.length,
          rules: rules.length,
          accounts: accounts.length,
          payments: payments.length,
          loadHistory: loadHistory.length,
          auditLogs: auditLogs.length,
          tgLinks: tgLinks.length,
          userNotifs: userNotifs.length,
        };
      });

      expect(checks.user).toBeNull();
      expect(checks.org).toBeNull();
      expect(checks.members).toBe(0);
      expect(checks.invites).toBe(0);
      expect(checks.rules).toBe(0);
      expect(checks.accounts).toBe(0);
      expect(checks.payments).toBe(0);
      expect(checks.loadHistory).toBe(0);
      expect(checks.auditLogs).toBe(0);
      expect(checks.tgLinks).toBe(0);
      expect(checks.userNotifs).toBe(0);
    });

    it("deleting a manager does NOT delete the organization", async () => {
      const t = convexTest(schema, modules);

      const ownerId = await createUser(t, "owner_stays@agency.com");
      const managerId = await createUser(t, "manager_goes@agency.com");

      const orgId = await t.run(async (ctx) => {
        const oid = await ctx.db.insert("organizations", {
          name: "Stays Agency",
          ownerId,
          subscriptionTier: "agency_s" as const,
          maxLoadUnits: 30,
          currentLoadUnits: 0,
          createdAt: Date.now(),
        });
        await ctx.db.patch(managerId, { organizationId: oid });
        await ctx.db.insert("orgMembers", {
          orgId: oid, userId: ownerId, role: "owner" as const,
          permissions: [], assignedAccountIds: [],
          status: "active" as const, createdAt: Date.now(),
        });
        await ctx.db.insert("orgMembers", {
          orgId: oid, userId: managerId, role: "manager" as const,
          permissions: ["rules"], assignedAccountIds: [],
          status: "active" as const, createdAt: Date.now(),
        });
        return oid;
      });

      // Delete manager
      await t.mutation(api.users.deleteUser, { userId: managerId });

      // Org still exists
      const org = await t.run(async (ctx) => ctx.db.get(orgId));
      expect(org).not.toBeNull();
      expect(org?.name).toBe("Stays Agency");

      // Owner membership still exists
      const members = await t.run(async (ctx) =>
        ctx.db.query("orgMembers")
          .withIndex("by_orgId", (q) => q.eq("orgId", orgId)).collect()
      );
      expect(members).toHaveLength(1);
      expect(members[0].role).toBe("owner");

      // Manager user is gone
      const mgr = await t.run(async (ctx) => ctx.db.get(managerId));
      expect(mgr).toBeNull();
    });
  });

  describe("billing → org activation flow", () => {
    it("payment record with orgId links to organization correctly", async () => {
      const t = convexTest(schema, modules);

      const ownerId = await createUser(t, "billing@agency.com");

      // Create pending org
      const orgId = await t.run(async (ctx) =>
        ctx.db.insert("organizations", {
          name: "Billing Agency",
          ownerId,
          subscriptionTier: "agency_m" as const,
          maxLoadUnits: 60,
          currentLoadUnits: 0,
          createdAt: Date.now(),
        })
      );

      // Create payment with orgId
      const paymentId = await t.run(async (ctx) =>
        ctx.db.insert("payments", {
          userId: ownerId,
          orgId,
          tier: "agency_m" as const,
          orderId: "ord_billing_test",
          token: "tok_billing",
          amount: 24900,
          currency: "BYN",
          status: "pending" as const,
          createdAt: Date.now(),
        })
      );

      // Verify payment → org link
      const payment = await t.run(async (ctx) => ctx.db.get(paymentId));
      expect(payment?.orgId).toBe(orgId);
      expect(payment?.tier).toBe("agency_m");
      expect(payment?.status).toBe("pending");

      // Simulate webhook: mark completed + activate subscription
      await t.run(async (ctx) => {
        await ctx.db.patch(paymentId, {
          status: "completed" as const,
          completedAt: Date.now(),
        });
        await ctx.db.patch(orgId, {
          subscriptionExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
        });
      });

      // Verify org activated
      const org = await t.run(async (ctx) => ctx.db.get(orgId));
      expect(org?.subscriptionExpiresAt).toBeGreaterThan(Date.now());
    });
  });

});

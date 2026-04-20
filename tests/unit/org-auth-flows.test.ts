import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../convex/schema";

const modules = import.meta.glob("../../convex/**/*.ts");

describe("orgAuth — invite flow", () => {
  it("acceptInviteForCurrentUser moves invite to accepted + creates pending_owner_confirm member", async () => {
    const t = convexTest(schema, modules);

    // Setup: org + owner + invite
    const ownerId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "owner@test.com", createdAt: Date.now() })
    );
    const orgId = await t.run(async (ctx) =>
      ctx.db.insert("organizations", {
        name: "TestOrg", ownerId, subscriptionTier: "agency_m",
        maxLoadUnits: 60, currentLoadUnits: 0, createdAt: Date.now(),
      })
    );
    await t.run(async (ctx) =>
      ctx.db.insert("orgMembers", {
        orgId, userId: ownerId, role: "owner", permissions: [],
        assignedAccountIds: [], status: "active", createdAt: Date.now(),
      })
    );

    const managerId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "mgr@test.com", createdAt: Date.now() })
    );

    const inviteId = await t.run(async (ctx) =>
      ctx.db.insert("orgInvites", {
        orgId, email: "mgr@test.com", permissions: ["rules", "reports"],
        assignedAccountIds: [], invitedBy: ownerId,
        token: "test-token-123", status: "pending",
        createdAt: Date.now(), expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      })
    );

    // Accept
    const result = await t.mutation(
      // Using api since it's a public mutation
      (await import("../../convex/_generated/api")).api.orgAuth.acceptInviteForCurrentUser,
      { token: "test-token-123", userId: managerId }
    );

    expect(result.status).toBe("pending_owner_confirm");
    expect(result.inviteId).toBe(inviteId);

    // Verify invite status changed
    const invite = await t.run(async (ctx) => ctx.db.get(inviteId));
    expect(invite?.status).toBe("accepted");
    expect(invite?.acceptedByUserId).toBe(managerId);

    // Verify orgMember created
    const member = await t.run(async (ctx) => ctx.db.get(result.memberId));
    expect(member?.status).toBe("pending_owner_confirm");
    expect(member?.role).toBe("manager");
    expect(member?.permissions).toEqual(["rules", "reports"]);
  });

  it("acceptInviteForCurrentUser rejects expired invite", async () => {
    const t = convexTest(schema, modules);

    const ownerId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "owner@test.com", createdAt: Date.now() })
    );
    const orgId = await t.run(async (ctx) =>
      ctx.db.insert("organizations", {
        name: "TestOrg", ownerId, subscriptionTier: "agency_m",
        maxLoadUnits: 60, currentLoadUnits: 0, createdAt: Date.now(),
      })
    );
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "u@test.com", createdAt: Date.now() })
    );

    await t.run(async (ctx) =>
      ctx.db.insert("orgInvites", {
        orgId, email: "u@test.com", permissions: ["rules"],
        assignedAccountIds: [], invitedBy: ownerId,
        token: "expired-token", status: "pending",
        createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
        expiresAt: Date.now() - 1000, // already expired
      })
    );

    await expect(
      t.mutation(
        (await import("../../convex/_generated/api")).api.orgAuth.acceptInviteForCurrentUser,
        { token: "expired-token", userId }
      )
    ).rejects.toThrow("Инвайт истёк");
  });

  it("acceptInviteForCurrentUser rejects user already in org", async () => {
    const t = convexTest(schema, modules);

    const ownerId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "owner@test.com", createdAt: Date.now() })
    );
    const orgId = await t.run(async (ctx) =>
      ctx.db.insert("organizations", {
        name: "TestOrg", ownerId, subscriptionTier: "agency_m",
        maxLoadUnits: 60, currentLoadUnits: 0, createdAt: Date.now(),
      })
    );
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        email: "u@test.com", createdAt: Date.now(), organizationId: orgId,
      })
    );

    await t.run(async (ctx) =>
      ctx.db.insert("orgInvites", {
        orgId, email: "u@test.com", permissions: ["rules"],
        assignedAccountIds: [], invitedBy: ownerId,
        token: "org-token", status: "pending",
        createdAt: Date.now(), expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      })
    );

    await expect(
      t.mutation(
        (await import("../../convex/_generated/api")).api.orgAuth.acceptInviteForCurrentUser,
        { token: "org-token", userId }
      )
    ).rejects.toThrow("уже участник организации");
  });
});

describe("orgAuth — linkInviteToUser (internal)", () => {
  it("links invite to new user and creates pending_owner_confirm member", async () => {
    const t = convexTest(schema, modules);
    const { internal } = await import("../../convex/_generated/api");

    const ownerId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "owner@test.com", createdAt: Date.now() })
    );
    const orgId = await t.run(async (ctx) =>
      ctx.db.insert("organizations", {
        name: "TestOrg", ownerId, subscriptionTier: "agency_m",
        maxLoadUnits: 60, currentLoadUnits: 0, createdAt: Date.now(),
      })
    );
    const inviteId = await t.run(async (ctx) =>
      ctx.db.insert("orgInvites", {
        orgId, email: "new@test.com", permissions: ["rules", "budgets"],
        assignedAccountIds: [], invitedBy: ownerId,
        token: "link-token", status: "pending",
        createdAt: Date.now(), expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      })
    );

    const newUserId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        email: "new@test.com", name: "New User",
        passwordHash: "$2a$10$fakehash", createdAt: Date.now(),
      })
    );

    const result = await t.mutation(internal.orgAuth.linkInviteToUser, {
      token: "link-token", userId: newUserId, transferAccountIds: [],
    });

    expect(result.memberId).toBeTruthy();

    // Verify invite updated
    const invite = await t.run(async (ctx) => ctx.db.get(inviteId));
    expect(invite?.status).toBe("accepted");
    expect(invite?.acceptedByUserId).toBe(newUserId);

    // Verify orgMember
    const member = await t.run(async (ctx) => ctx.db.get(result.memberId));
    expect(member?.status).toBe("pending_owner_confirm");
    expect(member?.permissions).toEqual(["rules", "budgets"]);
  });
});

describe("orgAuth — confirmInviteByOwner", () => {
  it("activates member, transfers accounts, sets organizationId", async () => {
    const t = convexTest(schema, modules);
    const { api } = await import("../../convex/_generated/api");

    const ownerId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "owner@test.com", createdAt: Date.now() })
    );
    const orgId = await t.run(async (ctx) =>
      ctx.db.insert("organizations", {
        name: "TestOrg", ownerId, subscriptionTier: "agency_m",
        maxLoadUnits: 60, currentLoadUnits: 0, createdAt: Date.now(),
      })
    );
    await t.run(async (ctx) =>
      ctx.db.insert("orgMembers", {
        orgId, userId: ownerId, role: "owner", permissions: [],
        assignedAccountIds: [], status: "active", createdAt: Date.now(),
      })
    );

    const managerId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "mgr@test.com", createdAt: Date.now() })
    );
    const accId = await t.run(async (ctx) =>
      ctx.db.insert("adAccounts", {
        userId: managerId, vkAccountId: "100", name: "Кабинет",
        accessToken: "t", status: "active", createdAt: Date.now(),
      })
    );

    const inviteId = await t.run(async (ctx) =>
      ctx.db.insert("orgInvites", {
        orgId, email: "mgr@test.com", permissions: ["rules"],
        assignedAccountIds: [], invitedBy: ownerId,
        token: "confirm-token", status: "accepted",
        createdAt: Date.now(), expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        acceptedByUserId: managerId,
        acceptedAt: Date.now(),
        transferredAccountIds: [accId],
      })
    );

    const memberId = await t.run(async (ctx) =>
      ctx.db.insert("orgMembers", {
        orgId, userId: managerId, role: "manager", permissions: ["rules"],
        assignedAccountIds: [], status: "pending_owner_confirm",
        invitedBy: ownerId, invitedAt: Date.now(),
        contactEmail: "mgr@test.com", createdAt: Date.now(),
      })
    );

    const result = await t.mutation(api.orgAuth.confirmInviteByOwner, {
      inviteId, ownerUserId: ownerId, transferAccountIds: [accId],
    });

    expect(result.ok).toBe(true);

    // Verify member activated
    const member = await t.run(async (ctx) => ctx.db.get(memberId));
    expect(member?.status).toBe("active");
    expect(member?.assignedAccountIds).toContain(accId);

    // Verify account transferred
    const acc = await t.run(async (ctx) => ctx.db.get(accId));
    expect(acc?.orgId).toBe(orgId);

    // Verify user got organizationId
    const user = await t.run(async (ctx) => ctx.db.get(managerId));
    expect(user?.organizationId).toBe(orgId);
  });

  it("rejects non-owner confirmation", async () => {
    const t = convexTest(schema, modules);
    const { api } = await import("../../convex/_generated/api");

    const ownerId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "owner@test.com", createdAt: Date.now() })
    );
    const orgId = await t.run(async (ctx) =>
      ctx.db.insert("organizations", {
        name: "TestOrg", ownerId, subscriptionTier: "agency_m",
        maxLoadUnits: 60, currentLoadUnits: 0, createdAt: Date.now(),
      })
    );
    const managerId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "mgr@test.com", createdAt: Date.now() })
    );
    await t.run(async (ctx) =>
      ctx.db.insert("orgMembers", {
        orgId, userId: managerId, role: "manager", permissions: ["rules"],
        assignedAccountIds: [], status: "active", createdAt: Date.now(),
      })
    );

    const inviteId = await t.run(async (ctx) =>
      ctx.db.insert("orgInvites", {
        orgId, email: "new@test.com", permissions: ["rules"],
        assignedAccountIds: [], invitedBy: ownerId,
        token: "t", status: "accepted",
        createdAt: Date.now(), expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        acceptedByUserId: managerId, acceptedAt: Date.now(),
        transferredAccountIds: [],
      })
    );

    await expect(
      t.mutation(api.orgAuth.confirmInviteByOwner, {
        inviteId, ownerUserId: managerId, transferAccountIds: [],
      })
    ).rejects.toThrow("Только владелец может подтвердить");
  });
});

describe("orgAuth — withdrawAcceptance", () => {
  it("reverts accepted invite back to pending and deletes orgMember", async () => {
    const t = convexTest(schema, modules);
    const { api } = await import("../../convex/_generated/api");

    const ownerId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "owner@test.com", createdAt: Date.now() })
    );
    const orgId = await t.run(async (ctx) =>
      ctx.db.insert("organizations", {
        name: "TestOrg", ownerId, subscriptionTier: "agency_m",
        maxLoadUnits: 60, currentLoadUnits: 0, createdAt: Date.now(),
      })
    );

    const managerId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "mgr@test.com", createdAt: Date.now() })
    );

    const inviteId = await t.run(async (ctx) =>
      ctx.db.insert("orgInvites", {
        orgId, email: "mgr@test.com", permissions: ["rules"],
        assignedAccountIds: [], invitedBy: ownerId,
        token: "withdraw-token", status: "accepted",
        createdAt: Date.now(), expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        acceptedByUserId: managerId, acceptedAt: Date.now(),
        transferredAccountIds: [],
      })
    );

    const memberId = await t.run(async (ctx) =>
      ctx.db.insert("orgMembers", {
        orgId, userId: managerId, role: "manager", permissions: ["rules"],
        assignedAccountIds: [], status: "pending_owner_confirm",
        createdAt: Date.now(),
      })
    );

    const result = await t.mutation(api.orgAuth.withdrawAcceptance, {
      inviteId, userId: managerId,
    });

    expect(result.ok).toBe(true);

    // Invite should be back to pending without accepted* fields
    const invite = await t.run(async (ctx) => ctx.db.get(inviteId));
    expect(invite?.status).toBe("pending");
    expect(invite?.acceptedByUserId).toBeUndefined();
    expect(invite?.acceptedAt).toBeUndefined();

    // orgMember should be deleted
    const member = await t.run(async (ctx) => ctx.db.get(memberId));
    expect(member).toBeNull();
  });
});

describe("orgAuth — cleanupExpiredInvites", () => {
  it("marks expired pending invites", async () => {
    const t = convexTest(schema, modules);
    const { internal } = await import("../../convex/_generated/api");

    const ownerId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "owner@test.com", createdAt: Date.now() })
    );
    const orgId = await t.run(async (ctx) =>
      ctx.db.insert("organizations", {
        name: "TestOrg", ownerId, subscriptionTier: "agency_m",
        maxLoadUnits: 60, currentLoadUnits: 0, createdAt: Date.now(),
      })
    );

    // Expired invite
    const expiredId = await t.run(async (ctx) =>
      ctx.db.insert("orgInvites", {
        orgId, email: "old@test.com", permissions: ["rules"],
        assignedAccountIds: [], invitedBy: ownerId,
        token: "old-token", status: "pending",
        createdAt: Date.now() - 14 * 24 * 60 * 60 * 1000,
        expiresAt: Date.now() - 1000,
      })
    );

    // Non-expired invite
    const freshId = await t.run(async (ctx) =>
      ctx.db.insert("orgInvites", {
        orgId, email: "new@test.com", permissions: ["rules"],
        assignedAccountIds: [], invitedBy: ownerId,
        token: "fresh-token", status: "pending",
        createdAt: Date.now(), expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      })
    );

    const result = await t.mutation(internal.orgAuth.cleanupExpiredInvites, {});
    expect(result.expired).toBe(1);

    const expired = await t.run(async (ctx) => ctx.db.get(expiredId));
    expect(expired?.status).toBe("expired");

    const fresh = await t.run(async (ctx) => ctx.db.get(freshId));
    expect(fresh?.status).toBe("pending");
  });
});

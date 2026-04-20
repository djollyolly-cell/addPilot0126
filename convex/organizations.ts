import { v } from "convex/values";
import { mutation, query, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const PERMISSIONS = ["rules", "budgets", "ads_control", "reports", "logs", "telegram", "add_accounts", "invite_members", "ai_cabinet"];

const AVAILABLE_NICHES = ["beauty", "schools", "realty", "auto", "medicine", "services"];

/** Get current user's organization with members */
export const getCurrent = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user || !user.organizationId) return null;

    const org = await ctx.db.get(user.organizationId);
    if (!org) return null;

    const members = await ctx.db
      .query("orgMembers")
      .withIndex("by_orgId", (q) => q.eq("orgId", user.organizationId!))
      .collect();

    return { ...org, members };
  },
});

/**
 * Create a new organization.
 * Called from agency-onboarding flow after payment confirmation.
 */
export const create = mutation({
  args: {
    name: v.string(),
    ownerId: v.id("users"),
    subscriptionTier: v.union(
      v.literal("agency_s"),
      v.literal("agency_m"),
      v.literal("agency_l"),
      v.literal("agency_xl")
    ),
    maxLoadUnits: v.number(),
    nichesConfig: v.optional(v.array(v.object({
      niche: v.string(),
      cabinetsCount: v.number(),
    }))),
  },
  handler: async (ctx, args) => {
    // Runtime-validate niches
    if (args.nichesConfig) {
      for (const nc of args.nichesConfig) {
        if (!AVAILABLE_NICHES.includes(nc.niche)) {
          throw new Error(`Неизвестная ниша: ${nc.niche}`);
        }
      }
    }

    const owner = await ctx.db.get(args.ownerId);
    if (!owner) throw new Error("Owner not found");

    // Owner can have at most one active org
    if (owner.organizationId) {
      throw new Error("Пользователь уже владеет организацией");
    }

    const orgId = await ctx.db.insert("organizations", {
      name: args.name,
      ownerId: args.ownerId,
      subscriptionTier: args.subscriptionTier,
      maxLoadUnits: args.maxLoadUnits,
      currentLoadUnits: 0,
      nichesConfig: args.nichesConfig,
      timezone: "Europe/Moscow",
      createdAt: Date.now(),
    });

    await ctx.db.patch(args.ownerId, { organizationId: orgId });

    await ctx.db.insert("orgMembers", {
      orgId,
      userId: args.ownerId,
      role: "owner",
      permissions: PERMISSIONS,
      assignedAccountIds: [],
      status: "active",
      createdAt: Date.now(),
    });

    // Auto-transfer all owner's existing adAccounts to org
    const ownAccounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.ownerId))
      .collect();
    for (const acc of ownAccounts) {
      if (!acc.excludeFromOrgTransfer) {
        await ctx.db.patch(acc._id, { orgId });
      }
    }

    return orgId;
  },
});

/** List members of an organization (with their permissions/assignments) */
export const listMembers = query({
  args: { orgId: v.id("organizations"), requesterId: v.id("users") },
  handler: async (ctx, args) => {
    const requester = await ctx.db.get(args.requesterId);
    if (requester?.organizationId !== args.orgId) {
      throw new Error("Доступ запрещён");
    }

    const members = await ctx.db
      .query("orgMembers")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .collect();
    const out = [];
    for (const m of members) {
      const u = await ctx.db.get(m.userId);
      out.push({
        ...m,
        userName: u?.name ?? "—",
        userEmail: u?.email ?? "—",
      });
    }
    return out;
  },
});

/**
 * Invite a new manager by email. Creates orgInvites record + sends email.
 */
export const inviteManager = mutation({
  args: {
    orgId: v.id("organizations"),
    invitedBy: v.id("users"),
    email: v.string(),
    permissions: v.array(v.string()),
    assignedAccountIds: v.array(v.id("adAccounts")),
  },
  handler: async (ctx, args) => {
    // Permission check: only owner or manager with invite_members
    const inviter = await ctx.db.get(args.invitedBy);
    if (!inviter || inviter.organizationId !== args.orgId) {
      throw new Error("Доступ запрещён");
    }
    const membership = await ctx.db
      .query("orgMembers")
      .withIndex("by_orgId_userId", (q) =>
        q.eq("orgId", args.orgId).eq("userId", args.invitedBy)
      )
      .first();
    if (!membership) throw new Error("Не член организации");
    const canInvite = membership.role === "owner" ||
                      membership.permissions.includes("invite_members");
    if (!canInvite) throw new Error("Нет права invite_members");

    // Validate permissions list
    for (const p of args.permissions) {
      if (!PERMISSIONS.includes(p)) {
        throw new Error(`Неизвестное право: ${p}`);
      }
    }

    // Generate token (32 bytes hex) — crypto for security
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

    const inviteId = await ctx.db.insert("orgInvites", {
      orgId: args.orgId,
      email: args.email,
      permissions: args.permissions,
      assignedAccountIds: args.assignedAccountIds,
      invitedBy: args.invitedBy,
      token,
      status: "pending",
      createdAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });

    // Send email (stub — full implementation in Plan 6)
    await ctx.scheduler.runAfter(0, internal.email.sendInviteEmail, {
      to: args.email,
      orgName: (await ctx.db.get(args.orgId))?.name ?? "Organization",
      inviterName: inviter.name ?? inviter.email,
      inviteToken: token,
    });

    return inviteId;
  },
});

/**
 * Update a manager's permissions or assigned accounts.
 * Triggers session revoke (defensive — prevents stale-perm exploit).
 */
export const updatePermissions = mutation({
  args: {
    memberId: v.id("orgMembers"),
    requesterId: v.id("users"),
    permissions: v.optional(v.array(v.string())),
    assignedAccountIds: v.optional(v.array(v.id("adAccounts"))),
  },
  handler: async (ctx, args) => {
    const member = await ctx.db.get(args.memberId);
    if (!member) throw new Error("Member not found");

    const requesterMembership = await ctx.db
      .query("orgMembers")
      .withIndex("by_orgId_userId", (q) =>
        q.eq("orgId", member.orgId).eq("userId", args.requesterId)
      )
      .first();
    if (requesterMembership?.role !== "owner") {
      throw new Error("Только владелец может менять права");
    }

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.permissions !== undefined) {
      for (const p of args.permissions) {
        if (!PERMISSIONS.includes(p)) {
          throw new Error(`Неизвестное право: ${p}`);
        }
      }
      patch.permissions = args.permissions;
    }
    if (args.assignedAccountIds !== undefined) {
      patch.assignedAccountIds = args.assignedAccountIds;
    }

    await ctx.db.patch(args.memberId, patch);

    // Revoke sessions to invalidate cached permissions
    await ctx.runMutation(internal.authInternal.revokeSessionsByUserId, {
      userId: member.userId,
    });

    try {
      await ctx.runMutation(internal.auditLog.log, {
        userId: args.requesterId,
        category: "admin",
        action: "permissions_changed",
        status: "success",
        details: { memberId: args.memberId, ...patch },
      });
    } catch { /* non-critical */ }

    return { ok: true };
  },
});

/**
 * Remove a manager from organization.
 * Cabinets transferred to org REMAIN in org. Sessions revoked.
 */
export const removeMember = mutation({
  args: {
    memberId: v.id("orgMembers"),
    requesterId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const member = await ctx.db.get(args.memberId);
    if (!member) throw new Error("Member not found");

    if (member.role === "owner") {
      throw new Error("Нельзя удалить владельца");
    }

    const requesterMembership = await ctx.db
      .query("orgMembers")
      .withIndex("by_orgId_userId", (q) =>
        q.eq("orgId", member.orgId).eq("userId", args.requesterId)
      )
      .first();
    if (requesterMembership?.role !== "owner") {
      throw new Error("Только владелец может удалить менеджера");
    }

    // Mark disabled (keep record for audit)
    await ctx.db.patch(args.memberId, {
      status: "disabled",
      updatedAt: Date.now(),
    });

    // Clear organizationId on user — use replace() because patch(undefined) skips the field
    const memberUser = await ctx.db.get(member.userId);
    if (memberUser) {
      const { organizationId: _removed, ...rest } = memberUser;
      void _removed;
      await ctx.db.replace(member.userId, rest);
    }

    // Revoke sessions
    await ctx.runMutation(internal.authInternal.revokeSessionsByUserId, {
      userId: member.userId,
    });

    try {
      await ctx.runMutation(internal.auditLog.log, {
        userId: args.requesterId,
        category: "admin",
        action: "member_removed",
        status: "success",
        details: { removedMemberId: args.memberId },
      });
    } catch { /* non-critical */ }

    return { ok: true };
  },
});

/**
 * Manager toggles excludeFromOrgTransfer on their personal account.
 */
export const setExcludeFromOrgTransfer = mutation({
  args: {
    accountId: v.id("adAccounts"),
    userId: v.id("users"),
    exclude: v.boolean(),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) throw new Error("Кабинет не найден");
    if (account.userId !== args.userId) {
      throw new Error("Это не ваш кабинет");
    }
    if (account.orgId) {
      throw new Error("Кабинет уже в организации — отвязать нельзя");
    }
    await ctx.db.patch(args.accountId, { excludeFromOrgTransfer: args.exclude });
    return { ok: true };
  },
});

/** Get active membership for a user (used by loginWithEmail to enrich session) */
export const getMembershipForUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user?.organizationId) return null;
    return await ctx.db
      .query("orgMembers")
      .withIndex("by_orgId_userId", (q) =>
        q.eq("orgId", user.organizationId!).eq("userId", args.userId)
      )
      .first();
  },
});

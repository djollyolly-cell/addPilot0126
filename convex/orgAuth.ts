import { v } from "convex/values";
import { mutation, query, action, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import bcrypt from "bcryptjs";

/** Get invite info by token (for InviteAcceptPage) */
export const getInviteInfo = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const invite = await ctx.db
      .query("orgInvites")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();
    if (!invite) return null;
    if (invite.expiresAt < Date.now() && invite.status === "pending") {
      return { ...invite, status: "expired" as const };
    }

    const org = await ctx.db.get(invite.orgId);
    const inviter = await ctx.db.get(invite.invitedBy);
    return {
      _id: invite._id,
      orgId: invite.orgId,
      orgName: org?.name ?? "Организация",
      email: invite.email,
      permissions: invite.permissions,
      assignedAccountIdsCount: invite.assignedAccountIds.length,
      inviterName: inviter?.name ?? "—",
      status: invite.status,
      expiresAt: invite.expiresAt,
    };
  },
});

/**
 * Existing user (logged in via VK or local) accepts the invite.
 * Status moves: pending → accepted (awaiting owner-confirm).
 */
export const acceptInviteForCurrentUser = mutation({
  args: { token: v.string(), userId: v.id("users") },
  handler: async (ctx, args) => {
    // Rate limit: max 10 invite accepts per user per hour
    const rateLimitKey = `invite-accept:${args.userId}`;
    const rl = await ctx.db
      .query("rateLimits")
      .withIndex("by_key", (q) => q.eq("key", rateLimitKey))
      .first();
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;
    if (rl) {
      if (rl.blockedUntil && rl.blockedUntil > now) {
        throw new Error("Слишком много поп��ток. Повторите позже.");
      }
      if (rl.lastAttemptAt > now - ONE_HOUR && rl.attempts >= 10) {
        await ctx.db.patch(rl._id, { blockedUntil: now + ONE_HOUR });
        throw new Error("Слишком много попыток. Повторите через час.");
      }
      await ctx.db.patch(rl._id, {
        attempts: rl.lastAttemptAt > now - ONE_HOUR ? rl.attempts + 1 : 1,
        lastAttemptAt: now,
      });
    } else {
      await ctx.db.insert("rateLimits", { key: rateLimitKey, attempts: 1, lastAttemptAt: now });
    }

    const invite = await ctx.db
      .query("orgInvites")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();
    if (!invite) throw new Error("Инвайт не найден");
    if (invite.status !== "pending") {
      throw new Error(`Инвайт уже ${invite.status}`);
    }
    if (invite.expiresAt < Date.now()) {
      await ctx.db.patch(invite._id, { status: "expired" });
      throw new Error("Инвайт истёк");
    }

    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("User not found");
    if (user.organizationId) {
      throw new Error("Вы уже участник организации. Покиньте её перед принят��ем нового приглашения.");
    }

    // Find user's personal cabinets that should transfer (not excluded)
    const personalAccounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    const toTransfer = personalAccounts
      .filter((a) => !a.orgId && !a.excludeFromOrgTransfer)
      .map((a) => a._id);

    // Update invite: status=accepted
    await ctx.db.patch(invite._id, {
      status: "accepted",
      acceptedAt: Date.now(),
      acceptedByUserId: args.userId,
      transferredAccountIds: toTransfer,
    });

    // Create orgMember record in pending_owner_confirm status
    const memberId = await ctx.db.insert("orgMembers", {
      orgId: invite.orgId,
      userId: args.userId,
      role: "manager",
      permissions: invite.permissions,
      assignedAccountIds: invite.assignedAccountIds,
      invitedBy: invite.invitedBy,
      invitedAt: invite.createdAt,
      status: "pending_owner_confirm",
      contactEmail: invite.email,
      createdAt: Date.now(),
    });

    // Notify owner
    const org = await ctx.db.get(invite.orgId);
    if (org) {
      await ctx.scheduler.runAfter(0, internal.telegram.sendOwnerInviteAcceptedNotification, {
        ownerId: org.ownerId,
        managerEmail: invite.email,
        transferredCount: toTransfer.length,
        inviteId: invite._id,
      });
    }

    return { inviteId: invite._id, memberId, status: "pending_owner_confirm" as const };
  },
});

/**
 * New user signs up via invite link with email + password.
 */
export const acceptInviteAsNewUser = action({
  args: {
    token: v.string(),
    name: v.string(),
    password: v.string(),
  },
  handler: async (ctx, args): Promise<{ sessionToken: string; memberId: Id<"orgMembers"> }> => {
    if (args.password.length < 8) {
      throw new Error("Пароль должен быть не менее 8 символов");
    }

    const invite = await ctx.runQuery(internal.orgAuth.getInviteInternal, {
      token: args.token,
    });
    if (!invite || invite.status !== "pending") {
      throw new Error("Инвайт недействителен");
    }
    if (invite.expiresAt < Date.now()) {
      throw new Error("Инвайт истёк");
    }

    // Check email is not already used
    const existing = await ctx.runQuery(internal.authEmail.findUserByEmail, {
      email: invite.email,
    });
    if (existing) {
      throw new Error("Email уже зарегистрирован. Использу��те 'Войти в существу��щий'.");
    }

    const passwordHash = await bcrypt.hash(args.password, 10);
    const userId = await ctx.runMutation(internal.orgAuth.createOrgUser, {
      email: invite.email,
      name: args.name,
      passwordHash,
    });

    const result = await ctx.runMutation(internal.orgAuth.linkInviteToUser, {
      token: args.token,
      userId,
      transferAccountIds: [],
    });

    const sessionToken = await ctx.runMutation(internal.authInternal.createSession, { userId });

    return { sessionToken, memberId: result.memberId };
  },
});

export const getInviteInternal = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("orgInvites")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();
  },
});

export const createOrgUser = internalMutation({
  args: {
    email: v.string(),
    name: v.string(),
    passwordHash: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("users", {
      email: args.email,
      name: args.name,
      passwordHash: args.passwordHash,
      createdAt: Date.now(),
    });
  },
});

export const linkInviteToUser = internalMutation({
  args: {
    token: v.string(),
    userId: v.id("users"),
    transferAccountIds: v.array(v.id("adAccounts")),
  },
  handler: async (ctx, args) => {
    const invite = await ctx.db
      .query("orgInvites")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();
    if (!invite) throw new Error("Invite not found");

    await ctx.db.patch(invite._id, {
      status: "accepted",
      acceptedAt: Date.now(),
      acceptedByUserId: args.userId,
      transferredAccountIds: args.transferAccountIds,
    });

    const memberId = await ctx.db.insert("orgMembers", {
      orgId: invite.orgId,
      userId: args.userId,
      role: "manager",
      permissions: invite.permissions,
      assignedAccountIds: invite.assignedAccountIds,
      invitedBy: invite.invitedBy,
      invitedAt: invite.createdAt,
      status: "pending_owner_confirm",
      contactEmail: invite.email,
      createdAt: Date.now(),
    });

    return { memberId };
  },
});

/**
 * Owner confirms manager invite acceptance.
 * Activates orgMember, transfers cabinets to org.
 */
export const confirmInviteByOwner = mutation({
  args: {
    inviteId: v.id("orgInvites"),
    ownerUserId: v.id("users"),
    transferAccountIds: v.array(v.id("adAccounts")),
  },
  handler: async (ctx, args) => {
    const invite = await ctx.db.get(args.inviteId);
    if (!invite) throw new Error("Invite not found");
    if (invite.status !== "accepted") {
      throw new Error(`Невозможно подтвердить — статус ${invite.status}`);
    }

    const ownerMembership = await ctx.db
      .query("orgMembers")
      .withIndex("by_orgId_userId", (q) =>
        q.eq("orgId", invite.orgId).eq("userId", args.ownerUserId)
      )
      .first();
    if (ownerMembership?.role !== "owner") {
      throw new Error("Только владелец может подтвердить");
    }

    // Validate transferAccountIds is subset of what manager offered
    const offered = new Set(invite.transferredAccountIds ?? []);
    for (const id of args.transferAccountIds) {
      if (!offered.has(id)) {
        throw new Error("Кабинет не был предложен к переносу");
      }
    }

    if (!invite.acceptedByUserId) {
      throw new Error("acceptedByUserId не установл��н — нарушение flow");
    }

    const member = await ctx.db
      .query("orgMembers")
      .withIndex("by_orgId_userId", (q) =>
        q.eq("orgId", invite.orgId).eq("userId", invite.acceptedByUserId!)
      )
      .first();
    if (!member) throw new Error("orgMember not found");

    // Transfer cabinets — set orgId
    for (const accId of args.transferAccountIds) {
      await ctx.db.patch(accId, { orgId: invite.orgId });
    }

    // Add transferred to assignedAccountIds
    const newAssigned = Array.from(new Set([
      ...member.assignedAccountIds,
      ...args.transferAccountIds,
    ]));

    await ctx.db.patch(member._id, {
      status: "active",
      assignedAccountIds: newAssigned,
      updatedAt: Date.now(),
    });

    // Set user.organizationId
    await ctx.db.patch(invite.acceptedByUserId, {
      organizationId: invite.orgId,
    });

    // Update invite
    await ctx.db.patch(invite._id, {
      status: "confirmed",
      confirmedByOwnerAt: Date.now(),
      transferredAccountIds: args.transferAccountIds,
    });

    // Compute pendingCredit from manager's previous Pro subscription
    const newMember = await ctx.db.get(invite.acceptedByUserId);
    if (newMember?.subscriptionTier === "pro" && newMember.subscriptionExpiresAt) {
      const remainingDays = Math.max(0, Math.ceil(
        (newMember.subscriptionExpiresAt - Date.now()) / (24 * 60 * 60 * 1000)
      ));
      const PRO_PRICE = 2990; // TODO: replace with TIERS.pro.price after Plan 3
      const credit = remainingDays > 0 ? Math.round((remainingDays / 30) * PRO_PRICE) : 0;
      if (credit > 0) {
        const org = await ctx.db.get(invite.orgId);
        await ctx.db.patch(invite.orgId, {
          pendingCredit: (org?.pendingCredit ?? 0) + credit,
          pendingCreditCurrency: "RUB",
          updatedAt: Date.now(),
        });
      }
      // Deactivate manager's personal subscription
      await ctx.db.patch(invite.acceptedByUserId, {
        subscriptionTier: "freemium",
      });
    }

    try {
      await ctx.runMutation(internal.auditLog.log, {
        userId: args.ownerUserId,
        category: "admin",
        action: "member_confirmed",
        status: "success",
        details: { memberId: member._id, transferredCount: args.transferAccountIds.length },
      });
    } catch { /* non-critical */ }

    return { ok: true, memberId: member._id };
  },
});

/** Owner rejects manager invite acceptance. */
export const rejectInviteByOwner = mutation({
  args: {
    inviteId: v.id("orgInvites"),
    ownerUserId: v.id("users"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const invite = await ctx.db.get(args.inviteId);
    if (!invite || invite.status !== "accepted") {
      throw new Error("Не accepted-инвайт");
    }
    const ownerMembership = await ctx.db
      .query("orgMembers")
      .withIndex("by_orgId_userId", (q) =>
        q.eq("orgId", invite.orgId).eq("userId", args.ownerUserId)
      )
      .first();
    if (ownerMembership?.role !== "owner") {
      throw new Error("Только владелец может отклонить");
    }

    if (invite.acceptedByUserId) {
      const member = await ctx.db
        .query("orgMembers")
        .withIndex("by_orgId_userId", (q) =>
          q.eq("orgId", invite.orgId).eq("userId", invite.acceptedByUserId!)
        )
        .first();
      if (member) await ctx.db.delete(member._id);
    }

    await ctx.db.patch(invite._id, {
      status: "rejected",
      rejectedByOwnerAt: Date.now(),
    });

    try {
      await ctx.runMutation(internal.auditLog.log, {
        userId: args.ownerUserId,
        category: "admin",
        action: "member_rejected",
        status: "success",
        details: { inviteId: args.inviteId, reason: args.reason },
      });
    } catch { /* non-critical */ }

    return { ok: true };
  },
});

/** Manager withdraws their acceptance before owner-confirm */
export const withdrawAcceptance = mutation({
  args: {
    inviteId: v.id("orgInvites"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const invite = await ctx.db.get(args.inviteId);
    if (!invite || invite.acceptedByUserId !== args.userId) {
      throw new Error("Это не ваш инвайт");
    }
    if (invite.status !== "accepted") {
      throw new Error("Можно отозвать только в статусе accepted");
    }

    const member = await ctx.db
      .query("orgMembers")
      .withIndex("by_orgId_userId", (q) =>
        q.eq("orgId", invite.orgId).eq("userId", args.userId)
      )
      .first();
    if (member) await ctx.db.delete(member._id);

    // Check if invite has expired
    if (invite.expiresAt < Date.now()) {
      await ctx.db.patch(invite._id, { status: "expired" });
      return { ok: true, note: "Инвайт истёк — возврат к pending невозможен" };
    }

    // Use replace() to clear optional fields (patch(undefined) skips them)
    const { acceptedAt: _a, acceptedByUserId: _b, transferredAccountIds: _c, ...inviteRest } = invite;
    void _a; void _b; void _c;
    await ctx.db.replace(invite._id, {
      ...inviteRest,
      status: "pending",
    });

    return { ok: true };
  },
});

/** Cron: mark expired pending invites. Runs daily. */
export const cleanupExpiredInvites = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const pending = await ctx.db
      .query("orgInvites")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .collect();
    let expired = 0;
    for (const invite of pending) {
      if (invite.expiresAt < now) {
        await ctx.db.patch(invite._id, { status: "expired" });
        expired++;
      }
    }
    if (expired > 0) {
      console.log(`[invite-cleanup] marked ${expired} expired invites`);
    }
    return { expired };
  },
});

import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

/**
 * Get list of adAccount IDs the user can access.
 * - Individual user (no org): own accounts via by_userId
 * - Owner: all accounts in org via by_orgId
 * - Manager: only assignedAccountIds in their orgMembers record
 */
export const getAccessibleAccountIds = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<Id<"adAccounts">[]> => {
    const user = await ctx.db.get(args.userId);
    if (!user) return [];

    // Individual fallback
    if (!user.organizationId) {
      const own = await ctx.db
        .query("adAccounts")
        .withIndex("by_userId", (q) => q.eq("userId", args.userId))
        .collect();
      return own.map((a) => a._id);
    }

    // Org member — find role
    const membership = await ctx.db
      .query("orgMembers")
      .withIndex("by_orgId_userId", (q) =>
        q.eq("orgId", user.organizationId!).eq("userId", args.userId)
      )
      .first();
    if (!membership || membership.status !== "active") {
      return [];
    }

    if (membership.role === "owner") {
      const all = await ctx.db
        .query("adAccounts")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.organizationId!))
        .collect();
      return all.map((a) => a._id);
    }

    // Manager: only assigned
    return membership.assignedAccountIds;
  },
});

/**
 * Check if user has specific permission.
 * - Individual user: always true (works on own resources only)
 * - Owner: always true
 * - Manager: must be in permissions array
 */
export const hasPermission = internalQuery({
  args: { userId: v.id("users"), permission: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const user = await ctx.db.get(args.userId);
    if (!user) return false;
    if (!user.organizationId) return true; // individual fallback

    const membership = await ctx.db
      .query("orgMembers")
      .withIndex("by_orgId_userId", (q) =>
        q.eq("orgId", user.organizationId!).eq("userId", args.userId)
      )
      .first();
    if (!membership || membership.status !== "active") return false;
    if (membership.role === "owner") return true;
    return membership.permissions.includes(args.permission);
  },
});

/**
 * Get organization by user (or null if individual).
 */
export const getOrgByUserId = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user || !user.organizationId) return null;
    return await ctx.db.get(user.organizationId);
  },
});

/**
 * Check if user is owner of any organization.
 */
/**
 * Verify all targetAdPlanIds belong to accounts user can access.
 * B5: prevents manager from targeting ad plans in accounts they don't have access to.
 */
export const validateAdPlanIds = internalQuery({
  args: { userId: v.id("users"), adPlanIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    if (args.adPlanIds.length === 0) return { ok: true as const, invalidIds: [] as string[] };

    const user = await ctx.db.get(args.userId);
    if (!user) return { ok: false as const, invalidIds: args.adPlanIds };

    let accessibleAccountIds: Id<"adAccounts">[] = [];
    if (!user.organizationId) {
      const own = await ctx.db
        .query("adAccounts")
        .withIndex("by_userId", (q) => q.eq("userId", args.userId))
        .collect();
      accessibleAccountIds = own.map((a) => a._id);
    } else {
      const membership = await ctx.db
        .query("orgMembers")
        .withIndex("by_orgId_userId", (q) =>
          q.eq("orgId", user.organizationId!).eq("userId", args.userId)
        )
        .first();
      if (!membership || membership.status !== "active") {
        return { ok: false as const, invalidIds: args.adPlanIds };
      }
      if (membership.role === "owner") {
        const all = await ctx.db
          .query("adAccounts")
          .withIndex("by_orgId", (q) => q.eq("orgId", user.organizationId!))
          .collect();
        accessibleAccountIds = all.map((a) => a._id);
      } else {
        accessibleAccountIds = membership.assignedAccountIds;
      }
    }

    // For each ad_plan_id, find campaigns and check accountId is accessible
    const accessibleSet = new Set(accessibleAccountIds.map(String));
    const invalid: string[] = [];
    for (const planId of args.adPlanIds) {
      const camps = await ctx.db
        .query("campaigns")
        .withIndex("by_adPlanId", (q) => q.eq("adPlanId", planId))
        .collect();
      if (camps.length === 0) {
        // Plan ID not found — could be new, allow it
        continue;
      }
      const accessible = camps.some((c) => accessibleSet.has(String(c.accountId)));
      if (!accessible) invalid.push(planId);
    }

    return { ok: invalid.length === 0, invalidIds: invalid };
  },
});

export const isOwner = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<boolean> => {
    const user = await ctx.db.get(args.userId);
    if (!user || !user.organizationId) return false;
    const membership = await ctx.db
      .query("orgMembers")
      .withIndex("by_orgId_userId", (q) =>
        q.eq("orgId", user.organizationId!).eq("userId", args.userId)
      )
      .first();
    return membership?.role === "owner";
  },
});

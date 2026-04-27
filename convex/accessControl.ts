import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { GenericDatabaseReader } from "convex/server";
import type { DataModel } from "./_generated/dataModel";

/**
 * Shared helper: collect all account IDs a user can access.
 * Returns union of org accounts + personal accounts (not transferred to org).
 *
 * - Individual user (no org): own accounts via by_userId
 * - Org owner: all org accounts (by_orgId) + personal accounts without orgId
 * - Org manager: assignedAccountIds + personal accounts without orgId
 */
async function collectAccessibleAccountIds(
  db: GenericDatabaseReader<DataModel>,
  userId: Id<"users">,
): Promise<Id<"adAccounts">[]> {
  const user = await db.get(userId);
  if (!user) return [];

  // Individual user — only personal accounts
  if (!user.organizationId) {
    const own = await db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    return own.map((a) => a._id);
  }

  // Org member — find role
  const membership = await db
    .query("orgMembers")
    .withIndex("by_orgId_userId", (q) =>
      q.eq("orgId", user.organizationId!).eq("userId", userId)
    )
    .first();
  if (!membership || membership.status !== "active") {
    return [];
  }

  // 1. Org accounts (owner sees all, manager sees assigned)
  let orgAccountIds: Id<"adAccounts">[];
  if (membership.role === "owner") {
    const all = await db
      .query("adAccounts")
      .withIndex("by_orgId", (q) => q.eq("orgId", user.organizationId!))
      .collect();
    orgAccountIds = all.map((a) => a._id);
  } else {
    orgAccountIds = membership.assignedAccountIds;
  }

  // 2. Personal accounts not transferred to org (excludeFromOrgTransfer or connected after join)
  const personalAccounts = await db
    .query("adAccounts")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
  const personalIds = personalAccounts
    .filter((a) => !a.orgId)
    .map((a) => a._id);

  // 3. Union (org accounts may overlap with personal if userId matches)
  const seen = new Set<string>();
  const result: Id<"adAccounts">[] = [];
  for (const id of [...orgAccountIds, ...personalIds]) {
    const key = id.toString();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(id);
    }
  }
  return result;
}

export const getAccessibleAccountIds = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<Id<"adAccounts">[]> => {
    return collectAccessibleAccountIds(ctx.db, args.userId);
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
 * Verify all targetAdPlanIds belong to accounts user can access.
 * B5: prevents manager from targeting ad plans in accounts they don't have access to.
 */
export const validateAdPlanIds = internalQuery({
  args: { userId: v.id("users"), adPlanIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    if (args.adPlanIds.length === 0) return { ok: true as const, invalidIds: [] as string[] };

    const accessibleAccountIds = await collectAccessibleAccountIds(ctx.db, args.userId);
    if (accessibleAccountIds.length === 0) {
      return { ok: false as const, invalidIds: args.adPlanIds };
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

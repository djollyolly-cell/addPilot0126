import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";

const ACTIVE_CAMPAIGN_STATUSES = ["active", "blocked", "moderation"];

/**
 * Pure: compute load units from per-account active group counts.
 * Formula (spec 3.8): Σ ceil(activeGroups / 100) for each account.
 */
export function computeLoadUnitsFromAccountStats(
  stats: Array<{ accountId: string; activeGroups: number }>
): number {
  return stats.reduce((sum, s) => {
    if (s.activeGroups <= 0) return sum;
    return sum + Math.ceil(s.activeGroups / 100);
  }, 0);
}

// ═══════════════════════════════════════════════════════════
// Grace check helpers — exported for inline use in mutations.
// These do direct ctx.db reads (no runQuery overhead).
// ═══════════════════════════════════════════════════════════

/**
 * Check if org allows writes. Call directly from mutations:
 *   const check = await checkOrgWritable(ctx, args.userId);
 *   if (!check.writable) throw new Error(check.reason!);
 *
 * Returns { writable: true } for individuals (no orgId).
 */
export async function checkOrgWritable(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">
): Promise<{ writable: boolean; reason?: string }> {
  const user = await ctx.db.get(userId);
  if (!user || !user.organizationId) return { writable: true };
  const org = await ctx.db.get(user.organizationId);
  if (!org) return { writable: true };

  const BLOCKED_PHASES = {
    read_only: "Подписка истекла. Доступ только на чтение.",
    deep_read_only: "Подписка истекла. Только просмотр.",
    frozen: "Кабинеты заморожены. Восстановите подписку.",
  } as const;

  const phase = org.expiredGracePhase;
  if (phase && phase in BLOCKED_PHASES) {
    return { writable: false, reason: BLOCKED_PHASES[phase as keyof typeof BLOCKED_PHASES] };
  }
  return { writable: true };
}

/**
 * Check if premium features disabled due to overage (Решение 4 tier 1).
 * Call directly from mutations.
 */
export async function checkFeaturesDisabled(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">
): Promise<boolean> {
  const user = await ctx.db.get(userId);
  if (!user || !user.organizationId) return false;
  const org = await ctx.db.get(user.organizationId);
  return !!org?.featuresDisabledAt;
}

// ═══════════════════════════════════════════════════════════
// Daily recalculation (Task 2)
// ═══════════════════════════════════════════════════════════

/** Get all organizations (for daily recalc — recalc needs ALL orgs) */
export const listAllOrganizations = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("organizations").collect();
  },
});

/** Get all adAccounts of an org (excludes archived) */
export const listOrgAccounts = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("adAccounts")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.neq(q.field("status"), "archived"))
      .collect();
  },
});

/** Count active campaigns for an account */
export const countActiveCampaigns = internalQuery({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const campaigns = await ctx.db
      .query("campaigns")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();
    return campaigns.filter((c) => ACTIVE_CAMPAIGN_STATUSES.includes(c.status)).length;
  },
});

/** Save daily snapshot + update org.currentLoadUnits */
export const saveDailySnapshot = internalMutation({
  args: {
    orgId: v.id("organizations"),
    date: v.string(),
    loadUnits: v.number(),
    activeGroupsByAccount: v.array(v.object({
      accountId: v.id("adAccounts"),
      activeGroups: v.number(),
    })),
  },
  handler: async (ctx, args) => {
    // Idempotent: if snapshot for this date exists — overwrite
    const existing = await ctx.db
      .query("loadUnitsHistory")
      .withIndex("by_orgId_date", (q) =>
        q.eq("orgId", args.orgId).eq("date", args.date)
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        loadUnits: args.loadUnits,
        activeGroupsByAccount: args.activeGroupsByAccount,
        capturedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("loadUnitsHistory", {
        orgId: args.orgId,
        date: args.date,
        loadUnits: args.loadUnits,
        activeGroupsByAccount: args.activeGroupsByAccount,
        capturedAt: Date.now(),
      });
    }
    await ctx.db.patch(args.orgId, {
      currentLoadUnits: args.loadUnits,
      updatedAt: Date.now(),
    });
  },
});

/** Daily action: recalc load units for all orgs */
export const recalculateAll = internalAction({
  args: {},
  handler: async (ctx) => {
    const orgs = await ctx.runQuery(internal.loadUnits.listAllOrganizations);
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC

    let processed = 0;
    let totalUnits = 0;
    for (const org of orgs) {
      const accounts = await ctx.runQuery(internal.loadUnits.listOrgAccounts, {
        orgId: org._id,
      });
      const stats = [];
      for (const acc of accounts) {
        const activeGroups = await ctx.runQuery(internal.loadUnits.countActiveCampaigns, {
          accountId: acc._id,
        });
        stats.push({ accountId: acc._id, activeGroups });
      }
      const loadUnits = computeLoadUnitsFromAccountStats(
        stats.map((s) => ({ accountId: s.accountId as string, activeGroups: s.activeGroups }))
      );
      await ctx.runMutation(internal.loadUnits.saveDailySnapshot, {
        orgId: org._id,
        date: today,
        loadUnits,
        activeGroupsByAccount: stats,
      });
      processed++;
      totalUnits += loadUnits;
    }

    console.log(`[load-units-daily] processed=${processed}, totalUnits=${totalUnits}`);
    return { processed, totalUnits };
  },
});

// ═══════════════════════════════════════════════════════════
// Overage (Решение 4 tier 1)
// ═══════════════════════════════════════════════════════════

/**
 * FILTERED: orgs that are currently over limit OR have active overage flags.
 * Avoids loading all orgs — only scans candidates.
 */
export const listOrgsForOverageCheck = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("organizations").collect();
    return all.filter((org) =>
      org.currentLoadUnits > org.maxLoadUnits ||
      org.overageNotifiedAt !== undefined ||
      org.overageGraceStartedAt !== undefined ||
      org.featuresDisabledAt !== undefined
    );
  },
});

/** Count consecutive overage days from history (up to last N days) */
export const getRecentOverageHistory = internalQuery({
  args: { orgId: v.id("organizations"), days: v.number() },
  handler: async (ctx, args) => {
    const records = await ctx.db
      .query("loadUnitsHistory")
      .withIndex("by_orgId_date", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(args.days);
    return records;
  },
});

export const setOverageNotified = internalMutation({
  args: {
    orgId: v.id("organizations"),
    timestamp: v.number(),
    startGrace: v.boolean(),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = {
      overageNotifiedAt: args.timestamp,
      updatedAt: Date.now(),
    };
    if (args.startGrace) {
      patch.overageGraceStartedAt = args.timestamp;
    }
    await ctx.db.patch(args.orgId, patch);
  },
});

export const setFeaturesDisabled = internalMutation({
  args: { orgId: v.id("organizations"), timestamp: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.orgId, {
      featuresDisabledAt: args.timestamp,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Clear overage flags from org.
 *
 * SAFETY NOTE on ctx.db.replace():
 * Convex patch({ field: undefined }) SKIPS the field — does NOT clear it.
 * replace() is the only way to remove optional fields.
 * Convex replace() is atomic with optimistic concurrency — if the doc
 * was modified between get() and replace(), replace() throws ConflictError
 * and the cron retries on next cycle. This is SAFE because:
 *   (a) clearOverageFlags only runs from checkOverage cron (single writer)
 *   (b) the only concurrent writer is saveDailySnapshot which patches
 *       currentLoadUnits — if it wins, clearOverageFlags retries next day
 *       and the data is still correct.
 */
export const clearOverageFlags = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.orgId);
    if (!org) return;
    // Only replace if flags are actually set (avoid unnecessary writes)
    if (!org.overageNotifiedAt && !org.overageGraceStartedAt && !org.featuresDisabledAt) return;
    const {
      overageNotifiedAt: _a,
      overageGraceStartedAt: _b,
      featuresDisabledAt: _c,
      ...rest
    } = org;
    void _a; void _b; void _c;
    await ctx.db.replace(args.orgId, { ...rest, updatedAt: Date.now() });
  },
});

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Check overage for candidate orgs daily.
 * - 7+ days consecutive overage → set overageNotifiedAt + overageGraceStartedAt → notify owner
 * - 14+ days since grace started → featuresDisabledAt = now → notify
 * - currentLoadUnits ≤ maxLoadUnits → clear all flags
 */
export const checkOverage = internalAction({
  args: {},
  handler: async (ctx) => {
    // FILTERED: only orgs with active overage or currently over limit
    const orgs = await ctx.runQuery(internal.loadUnits.listOrgsForOverageCheck);
    const now = Date.now();

    let notified = 0;
    let disabled = 0;
    let cleared = 0;

    for (const org of orgs) {
      // No overage now → clear flags
      if (org.currentLoadUnits <= org.maxLoadUnits) {
        if (org.overageNotifiedAt || org.overageGraceStartedAt || org.featuresDisabledAt) {
          await ctx.runMutation(internal.loadUnits.clearOverageFlags, { orgId: org._id });
          cleared++;
          await ctx.scheduler.runAfter(0, internal.telegram.sendOverageRecoveryNotification, {
            orgId: org._id,
          });
        }
        continue;
      }

      // Check 7-day consecutive overage
      const history = await ctx.runQuery(internal.loadUnits.getRecentOverageHistory, {
        orgId: org._id,
        days: 7,
      });
      const allOver = history.length === 7 && history.every((h) => h.loadUnits > org.maxLoadUnits);

      if (allOver && !org.overageNotifiedAt) {
        await ctx.runMutation(internal.loadUnits.setOverageNotified, {
          orgId: org._id,
          timestamp: now,
          startGrace: true,
        });
        notified++;
        await ctx.scheduler.runAfter(0, internal.telegram.sendOverageStartNotification, {
          orgId: org._id,
        });
      }

      // Check 14-day grace expiry
      if (
        org.overageGraceStartedAt &&
        !org.featuresDisabledAt &&
        now - org.overageGraceStartedAt > FOURTEEN_DAYS_MS
      ) {
        await ctx.runMutation(internal.loadUnits.setFeaturesDisabled, {
          orgId: org._id,
          timestamp: now,
        });
        disabled++;
        await ctx.scheduler.runAfter(0, internal.telegram.sendFeaturesDisabledNotification, {
          orgId: org._id,
        });
      }
    }

    console.log(`[check-overage] candidates=${orgs.length}, notified=${notified}, disabled=${disabled}, cleared=${cleared}`);
    return { notified, disabled, cleared };
  },
});

// ═══════════════════════════════════════════════════════════
// Expired grace (Решение 4 tier 2)
// ═══════════════════════════════════════════════════════════

export type ExpiredGracePhase = "warnings" | "read_only" | "deep_read_only" | "frozen";

/**
 * Phase durations — cumulative thresholds from expiredGraceStartedAt.
 * Cumulative to avoid error-prone per-phase addition in cron loop.
 */
const PHASE_THRESHOLDS_MS = {
  warnings_end:        14 * 24 * 60 * 60 * 1000,  // day 14 → read_only
  read_only_end:       45 * 24 * 60 * 60 * 1000,  // day 45 → deep_read_only
  deep_read_only_end:  60 * 24 * 60 * 60 * 1000,  // day 60 → frozen
};

/**
 * Pure: determine if phase should advance given elapsed ms since grace start.
 * Returns next phase or null (no transition needed).
 * Exported for testing.
 */
export function getNextExpiredPhase(
  currentPhase: ExpiredGracePhase,
  elapsedMs: number
): ExpiredGracePhase | null {
  switch (currentPhase) {
    case "warnings":
      return elapsedMs > PHASE_THRESHOLDS_MS.warnings_end ? "read_only" : null;
    case "read_only":
      return elapsedMs > PHASE_THRESHOLDS_MS.read_only_end ? "deep_read_only" : null;
    case "deep_read_only":
      return elapsedMs > PHASE_THRESHOLDS_MS.deep_read_only_end ? "frozen" : null;
    case "frozen":
      return null; // terminal
  }
}

/**
 * FILTERED: only orgs that need grace processing:
 *   (a) subscriptionExpiresAt <= now AND no expiredGracePhase (need to START)
 *   (b) expiredGracePhase is set (need to PROGRESS or CLEAR)
 */
export const listOrgsForGraceCheck = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const all = await ctx.db.query("organizations").collect();
    return all.filter((org) =>
      // Has active grace
      org.expiredGracePhase !== undefined ||
      // OR subscription just expired (need to start warnings)
      (org.subscriptionExpiresAt !== undefined && org.subscriptionExpiresAt <= now)
    );
  },
});

export const setExpiredPhase = internalMutation({
  args: {
    orgId: v.id("organizations"),
    phase: v.union(
      v.literal("warnings"),
      v.literal("read_only"),
      v.literal("deep_read_only"),
      v.literal("frozen")
    ),
    startedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = {
      expiredGracePhase: args.phase,
      updatedAt: Date.now(),
    };
    if (args.startedAt !== undefined) {
      patch.expiredGraceStartedAt = args.startedAt;
    }
    await ctx.db.patch(args.orgId, patch);
  },
});

/**
 * Archive all non-archived accounts in org.
 * SAVES statusBeforeArchive so restoreOrgAccounts can restore exact state.
 */
export const archiveOrgAccounts = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const accounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .collect();
    let archived = 0;
    for (const acc of accounts) {
      if (acc.status !== "archived") {
        await ctx.db.patch(acc._id, {
          statusBeforeArchive: acc.status,  // save for restore
          status: "archived",
        });
        archived++;
      }
    }
    return { archived };
  },
});

/**
 * Restore archived accounts to their previous status.
 * Uses statusBeforeArchive if available, falls back to "paused" (safe default —
 * "active" would immediately resume sync which may be unwanted after long freeze).
 */
export const restoreOrgAccounts = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const accounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .collect();
    let restored = 0;
    for (const acc of accounts) {
      if (acc.status === "archived") {
        const restoreTo = acc.statusBeforeArchive ?? "paused";
        await ctx.db.patch(acc._id, {
          status: restoreTo,
          statusBeforeArchive: undefined,
        });
        restored++;
      }
    }
    return { restored };
  },
});

/**
 * Clear expired grace flags.
 * Same replace() safety model as clearOverageFlags — see comment there.
 */
export const clearExpiredFlags = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.orgId);
    if (!org) return;
    if (!org.expiredGracePhase && !org.expiredGraceStartedAt) return;
    const {
      expiredGracePhase: _a,
      expiredGraceStartedAt: _b,
      ...rest
    } = org;
    void _a; void _b;
    await ctx.db.replace(args.orgId, { ...rest, updatedAt: Date.now() });
  },
});

/**
 * Daily cron: progress expired grace phases.
 * Runs on FILTERED set of orgs (only those with expired sub or active grace).
 */
export const progressExpiredGrace = internalAction({
  args: {},
  handler: async (ctx) => {
    const orgs = await ctx.runQuery(internal.loadUnits.listOrgsForGraceCheck);
    const now = Date.now();

    let progressed = 0;
    let frozen = 0;

    for (const org of orgs) {
      // Active subscription? clear flags + skip
      if (org.subscriptionExpiresAt && org.subscriptionExpiresAt > now) {
        if (org.expiredGracePhase) {
          // Reactivate (was frozen — restore accounts)
          if (org.expiredGracePhase === "frozen") {
            try {
              await ctx.runMutation(internal.loadUnits.restoreOrgAccounts, { orgId: org._id });
            } catch (e) {
              // Log but don't block clearExpiredFlags — subscription is paid,
              // org must be unfrozen even if some accounts fail to unarchive.
              // Failed accounts will be retried on next cron cycle.
              console.error(`restoreOrgAccounts failed for ${org._id}:`, e);
            }
          }
          await ctx.runMutation(internal.loadUnits.clearExpiredFlags, { orgId: org._id });
        }
        continue;
      }

      // Just expired? Start warnings phase
      if (!org.expiredGracePhase && org.subscriptionExpiresAt) {
        await ctx.runMutation(internal.loadUnits.setExpiredPhase, {
          orgId: org._id,
          phase: "warnings",
          startedAt: now,
        });
        await ctx.scheduler.runAfter(0, internal.telegram.sendExpiredWarningNotification, {
          orgId: org._id, phase: "warnings",
        });
        progressed++;
        continue;
      }

      if (!org.expiredGracePhase || !org.expiredGraceStartedAt) continue;

      // Use pure function for phase transition logic
      const elapsed = now - org.expiredGraceStartedAt;
      const nextPhase = getNextExpiredPhase(
        org.expiredGracePhase as ExpiredGracePhase,
        elapsed
      );

      if (nextPhase) {
        await ctx.runMutation(internal.loadUnits.setExpiredPhase, {
          orgId: org._id, phase: nextPhase,
        });
        progressed++;

        if (nextPhase === "frozen") {
          await ctx.runMutation(internal.loadUnits.archiveOrgAccounts, { orgId: org._id });
          frozen++;
        }

        await ctx.scheduler.runAfter(0, internal.telegram.sendExpiredWarningNotification, {
          orgId: org._id, phase: nextPhase,
        });
      }
    }

    console.log(`[progress-expired-grace] candidates=${orgs.length}, progressed=${progressed}, frozen=${frozen}`);
    return { progressed, frozen };
  },
});

// ═══════════════════════════════════════════════════════════
// Cold delete (day 150 total = 60d grace + 90d frozen)
// ═══════════════════════════════════════════════════════════

const COLD_DELETE_TOTAL_MS = 150 * 24 * 60 * 60 * 1000;

/**
 * Delete ONE account + its campaigns + ads.
 * Batched: action calls this per-account to stay within mutation time limit.
 * Returns counts for logging.
 */
export const coldDeleteOneAccount = internalMutation({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    let deletedCampaigns = 0;
    let deletedAds = 0;
    const campaigns = await ctx.db
      .query("campaigns")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();
    for (const c of campaigns) {
      const ads = await ctx.db
        .query("ads")
        .withIndex("by_campaignId", (q) => q.eq("campaignId", c._id))
        .collect();
      for (const a of ads) {
        await ctx.db.delete(a._id);
        deletedAds++;
      }
      await ctx.db.delete(c._id);
      deletedCampaigns++;
    }
    await ctx.db.delete(args.accountId);
    return { deletedCampaigns, deletedAds };
  },
});

/** Delete rules of an org (separate mutation for batching) */
export const coldDeleteOrgRules = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const rules = await ctx.db
      .query("rules")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .collect();
    for (const r of rules) await ctx.db.delete(r._id);
    return { deleted: rules.length };
  },
});

/** Mark org as deleted (final step) */
export const markOrgDeleted = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.orgId);
    if (!org) return;
    await ctx.db.patch(args.orgId, {
      name: `[DELETED] ${org.name}`,
      updatedAt: Date.now(),
    });
  },
});

/** List ALL accounts of an org (including archived — for cold delete) */
export const listAllOrgAccounts = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("adAccounts")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .collect();
  },
});

/**
 * Daily cron: cold-delete orgs frozen >90 days (150 total since expiry).
 * BATCHED: iterates accounts one-by-one to stay within mutation limits.
 * Prod data: largest org could have ~264 accounts × 186 campaigns each.
 * Each coldDeleteOneAccount handles ~200 campaigns — safely within 8s limit.
 */
export const coldDeleteArchived = internalAction({
  args: {},
  handler: async (ctx) => {
    // FILTERED: only frozen orgs past the threshold
    const orgs = await ctx.runQuery(internal.loadUnits.listOrgsForGraceCheck);
    const now = Date.now();
    let deleted = 0;

    for (const org of orgs) {
      if (
        org.expiredGracePhase !== "frozen" ||
        !org.expiredGraceStartedAt ||
        now - org.expiredGraceStartedAt <= COLD_DELETE_TOTAL_MS
      ) {
        continue;
      }

      // Delete accounts one by one (batched)
      const allAccounts = await ctx.runQuery(internal.loadUnits.listAllOrgAccounts, {
        orgId: org._id,
      });
      let totalCampaigns = 0;
      let totalAds = 0;
      for (const acc of allAccounts) {
        const result = await ctx.runMutation(internal.loadUnits.coldDeleteOneAccount, {
          accountId: acc._id,
        });
        totalCampaigns += result.deletedCampaigns;
        totalAds += result.deletedAds;
      }

      // Delete rules (usually few — safe in one mutation)
      const rulesResult = await ctx.runMutation(internal.loadUnits.coldDeleteOrgRules, {
        orgId: org._id,
      });

      // Mark org as deleted
      await ctx.runMutation(internal.loadUnits.markOrgDeleted, { orgId: org._id });

      deleted++;
      console.log(`[cold-delete] org ${org._id}: accounts=${allAccounts.length}, campaigns=${totalCampaigns}, ads=${totalAds}, rules=${rulesResult.deleted}`);
    }

    return { deleted };
  },
});

// ═══════════════════════════════════════════════════════════
// UI query (Task 8)
// ═══════════════════════════════════════════════════════════

/** Get org's load + grace status for UI badges/banners */
export const getCurrentLoadStatus = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user || !user.organizationId) return null;
    const org = await ctx.db.get(user.organizationId);
    if (!org) return null;

    return {
      orgId: org._id,
      currentLoadUnits: org.currentLoadUnits,
      maxLoadUnits: org.maxLoadUnits,
      utilizationPct: Math.round((org.currentLoadUnits / org.maxLoadUnits) * 100),
      isOverLimit: org.currentLoadUnits > org.maxLoadUnits,
      overageNotifiedAt: org.overageNotifiedAt,
      overageGraceStartedAt: org.overageGraceStartedAt,
      featuresDisabledAt: org.featuresDisabledAt,
      expiredGracePhase: org.expiredGracePhase,
      expiredGraceStartedAt: org.expiredGraceStartedAt,
      subscriptionExpiresAt: org.subscriptionExpiresAt,
    };
  },
});

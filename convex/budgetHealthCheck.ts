// convex/budgetHealthCheck.ts
// Budget health checks for UZ rules — covers issues not caught by main healthCheck:
// 1. Cascade blocks (ad_plan → group → banners)
// 2. Budget growing without spent growth (dedup failure)
// 3. Budget mismatch (our logs vs VK API actual value)

/* eslint-disable @typescript-eslint/no-explicit-any */
import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  CheckResult,
  CheckStatus,
  worstStatus,
} from "./healthReport";

const MT_API_BASE = "https://target.my.com";

async function mtApi<T>(endpoint: string, token: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${MT_API_BASE}/api/v2/${endpoint}`);
  for (const [k, val] of Object.entries(params)) url.searchParams.set(k, val);
  const resp = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`MT API ${resp.status}`);
  return await resp.json() as T;
}

const ADMIN_CHAT_ID = "325307765";

/** Get user name by ID */
export const getUserName = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    return user?.name || user?.email || args.userId;
  },
});

// ─── Block 1: Cascade blocks (ad_plan / banners) ───

export const checkCascadeBlocks = internalAction({
  args: {},
  handler: async (ctx): Promise<CheckResult> => {
    const issues: string[] = [];
    let status: CheckStatus = "ok";

    const allRules: any[] = await ctx.runQuery(internal.ruleEngine.getActiveUzRules, {});
    if (allRules.length === 0) {
      return { name: "Каскадные блокировки", status: "ok", message: "нет UZ-правил" };
    }

    // Group by account to minimize API calls
    const accountMap = new Map<string, { token?: string; rules: any[] }>();
    for (const rule of allRules) {
      for (const accId of rule.targetAccountIds) {
        if (!accountMap.has(accId)) accountMap.set(accId, { rules: [] });
        accountMap.get(accId)!.rules.push(rule);
      }
    }

    let blockedPlans = 0;
    let blockedBannerGroups = 0;
    const userProblems = new Map<string, { plans: number; groups: number }>();

    for (const [accId, entry] of accountMap) {
      try {
        const token = await ctx.runAction(
          internal.auth.getValidTokenForAccount,
          { accountId: accId as Id<"adAccounts"> }
        );
        if (!token) continue;

        const campaigns: any[] = await ctx.runAction(
          internal.vkApi.getCampaignsForAccount,
          { accessToken: token }
        ) as any[];

        // Collect all matched campaign IDs and their ad_plan_ids
        const matchedCampaigns = new Set<number>();
        const planIds = new Set<number>();

        for (const rule of entry.rules) {
          const targetIds = rule.targetCampaignIds || [];
          for (const c of campaigns) {
            if (c.status === "deleted") continue;
            const matchesDirect = targetIds.includes(String(c.id));
            const matchesPlan = c.ad_plan_id && targetIds.includes(String(c.ad_plan_id));
            if (matchesDirect || matchesPlan) {
              matchedCampaigns.add(c.id);
              if (c.ad_plan_id) planIds.add(c.ad_plan_id);
            }
          }
        }

        // Check ad_plans
        for (const planId of planIds) {
          try {
            const planData = await mtApi<{ items: Array<{ id: number; status: string; name: string }> }>(
              "ad_plans.json", token, { _id: String(planId), fields: "id,status,name" }
            );
            const plan = planData.items?.[0];
            if (plan && plan.status === "blocked") {
              blockedPlans++;
              const groupsInPlan = campaigns.filter(c => c.ad_plan_id === planId && matchedCampaigns.has(c.id) && c.status !== "deleted").length;
              // Find user
              const rule = entry.rules[0];
              const user = await ctx.runQuery(internal.budgetHealthCheck.getUserName, { userId: rule.userId });
              const key = user || rule.userId;
              const prev = userProblems.get(key) || { plans: 0, groups: 0 };
              prev.plans++;
              prev.groups += groupsInPlan;
              userProblems.set(key, prev);
            }
          } catch { /* skip plan check errors */ }
        }

        // Check banners for active groups that are not_delivering (sample max 10 per account)
        const notDelivering = campaigns.filter(c =>
          matchedCampaigns.has(c.id) && c.status === "active" && c.delivery === "not_delivering"
        ).slice(0, 10);

        for (const camp of notDelivering) {
          try {
            const bannersData = await mtApi<{ items: Array<{ id: number; status: string }> }>(
              "banners.json", token, { campaign_id: String(camp.id), fields: "id,status", limit: "50" }
            );
            const banners = (bannersData.items || []).filter(b => b.status !== "deleted");
            const allBlocked = banners.length > 0 && banners.every(b => b.status === "blocked");
            if (allBlocked) {
              blockedBannerGroups++;
              const rule = entry.rules[0];
              const user = await ctx.runQuery(internal.budgetHealthCheck.getUserName, { userId: rule.userId });
              issues.push(`${user}: "${camp.name}" — все баннеры blocked`);
            }
          } catch { /* skip banner check errors */ }
        }
      } catch { /* skip accounts with token errors */ }
    }

    if (blockedPlans > 0) {
      status = "error";
      for (const [user, data] of userProblems) {
        issues.unshift(`${user}: ${data.plans} ad_plans blocked (${data.groups} групп)`);
      }
    }

    if (blockedBannerGroups > 0) {
      if (status === "ok") status = "warning";
    }

    return {
      name: "Каскадные блокировки",
      status,
      message: blockedPlans + blockedBannerGroups > 0
        ? `${blockedPlans} ad_plans, ${blockedBannerGroups} групп с blocked баннерами`
        : "ок",
      details: issues.slice(0, 15),
    };
  },
});

// ─── Block 2: Budget growing without spent growth ───

export const checkBudgetGrowthWithoutSpent = internalQuery({
  args: {},
  handler: async (ctx): Promise<CheckResult> => {
    const issues: string[] = [];
    let status: CheckStatus = "ok";

    const allRules = await ctx.db.query("rules").collect();
    const uzRules = allRules.filter(r => r.type === "uz_budget_manage" && r.isActive);

    // MSK midnight
    const msk = new Date(Date.now() + 3 * 3600_000);
    const mskMidnight = new Date(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate());
    const dayStartUtc = mskMidnight.getTime() - 3 * 3600_000;

    for (const rule of uzRules) {
      const logs = await ctx.db
        .query("actionLogs")
        .withIndex("by_ruleId", (q) => q.eq("ruleId", rule._id))
        .filter((q) =>
          q.and(
            q.eq(q.field("actionType"), "budget_increased"),
            q.gte(q.field("createdAt"), dayStartUtc),
            q.eq(q.field("status"), "success")
          )
        )
        .collect();

      // Group by campaign
      const byCampaign = new Map<string, any[]>();
      for (const l of logs) {
        const key = l.adId || "unknown";
        if (!byCampaign.has(key)) byCampaign.set(key, []);
        byCampaign.get(key)!.push(l);
      }

      for (const [campId, campLogs] of byCampaign) {
        const sorted = campLogs.sort((a: any, b: any) => a.createdAt - b.createdAt);
        // Count consecutive increases with same spent
        let maxConsecutive = 0;
        let consecutive = 1;
        for (let i = 1; i < sorted.length; i++) {
          const prevSpent = sorted[i - 1].metricsSnapshot?.spent;
          const currSpent = sorted[i].metricsSnapshot?.spent;
          if (prevSpent !== undefined && currSpent !== undefined && currSpent === prevSpent) {
            consecutive++;
            maxConsecutive = Math.max(maxConsecutive, consecutive);
          } else {
            consecutive = 1;
          }
        }

        if (maxConsecutive >= 5) {
          status = "error";
          const campName = sorted[0].adName || campId;
          issues.push(`"${rule.name}": ${campName} — ${maxConsecutive} увеличений с одинаковым spent`);
        } else if (maxConsecutive >= 3) {
          if (status === "ok") status = "warning";
          const campName = sorted[0].adName || campId;
          issues.push(`"${rule.name}": ${campName} — ${maxConsecutive} увеличений с одинаковым spent`);
        }
      }
    }

    return {
      name: "Бюджет без расхода",
      status,
      message: issues.length > 0 ? `${issues.length} кампаний` : "ок",
      details: issues.slice(0, 10),
    };
  },
});

// ─── Block 3: Budget mismatch (our logs vs VK API) ───

export const checkBudgetMismatch = internalAction({
  args: {},
  handler: async (ctx): Promise<CheckResult> => {
    const issues: string[] = [];
    let status: CheckStatus = "ok";

    // Get recent budget_increased logs (last 2 hours, sample up to 20)
    const recentLogs: any[] = await ctx.runQuery(
      internal.budgetHealthCheck.getRecentBudgetLogs, {}
    );

    if (recentLogs.length === 0) {
      return { name: "Budget vs VK", status: "ok", message: "нет недавних увеличений" };
    }

    // Group by account
    const byAccount = new Map<string, { token?: string; logs: any[] }>();
    for (const log of recentLogs) {
      const accId = log.accountId;
      if (!byAccount.has(accId)) byAccount.set(accId, { logs: [] });
      byAccount.get(accId)!.logs.push(log);
    }

    let checked = 0;
    let mismatches = 0;

    for (const [accId, entry] of byAccount) {
      try {
        const token = await ctx.runAction(
          internal.auth.getValidTokenForAccount,
          { accountId: accId as Id<"adAccounts"> }
        );
        if (!token) continue;

        const campaigns: any[] = await ctx.runAction(
          internal.vkApi.getCampaignsForAccount,
          { accessToken: token }
        ) as any[];

        for (const log of entry.logs) {
          const camp = campaigns.find((c: any) => String(c.id) === log.adId);
          if (!camp) continue;
          checked++;

          const expectedBudget = log.metricsSnapshot?.newBudget;
          const actualBudget = Number(camp.budget_limit_day || 0);

          if (expectedBudget && actualBudget < expectedBudget) {
            mismatches++;
            const user = await ctx.runQuery(internal.budgetHealthCheck.getUserName, { userId: log.userId });
            issues.push(`${user}: "${log.adName}" — лог=${expectedBudget}₽, VK=${actualBudget}₽`);
          }
        }
      } catch { /* skip */ }
    }

    if (mismatches > 0) status = "error";

    return {
      name: "Budget vs VK",
      status,
      message: mismatches > 0 ? `${mismatches}/${checked} не совпадают` : `${checked} проверено, ок`,
      details: issues.slice(0, 10),
    };
  },
});

/** Helper: get recent budget_increased logs for mismatch check */
export const getRecentBudgetLogs = internalQuery({
  args: {},
  handler: async (ctx) => {
    const twoHoursAgo = Date.now() - 2 * 3600_000;

    // Get a sample of recent logs across rules
    const allRules = await ctx.db.query("rules").collect();
    const uzRules = allRules.filter(r => r.type === "uz_budget_manage" && r.isActive);

    const result: any[] = [];
    for (const rule of uzRules.slice(0, 10)) {
      const logs = await ctx.db
        .query("actionLogs")
        .withIndex("by_ruleId", (q) => q.eq("ruleId", rule._id))
        .filter((q) =>
          q.and(
            q.eq(q.field("actionType"), "budget_increased"),
            q.gte(q.field("createdAt"), twoHoursAgo),
            q.eq(q.field("status"), "success")
          )
        )
        .collect();

      // Take last log per unique campaign
      const byCamp = new Map<string, any>();
      for (const l of logs) {
        const key = l.adId || "";
        if (!byCamp.has(key) || l.createdAt > byCamp.get(key).createdAt) {
          byCamp.set(key, l);
        }
      }
      result.push(...byCamp.values());
      if (result.length >= 20) break;
    }

    return result.slice(0, 20);
  },
});

// ─── Orchestrator ───

export const runBudgetHealthCheck = internalAction({
  args: {},
  handler: async (ctx) => {
    const startTime = Date.now();
    const blocks: CheckResult[] = [];

    // Block 1: Cascade blocks (VK API calls)
    try {
      const result = await ctx.runAction(internal.budgetHealthCheck.checkCascadeBlocks, {});
      blocks.push(result);
    } catch (err) {
      blocks.push({
        name: "Каскадные блокировки",
        status: "warning",
        message: `CHECK_FAILED: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Block 2: Budget without spent growth (DB only)
    try {
      const result = await ctx.runQuery(internal.budgetHealthCheck.checkBudgetGrowthWithoutSpent, {});
      blocks.push(result);
    } catch (err) {
      blocks.push({
        name: "Бюджет без расхода",
        status: "warning",
        message: `CHECK_FAILED: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Block 3: Budget mismatch (VK API)
    try {
      const result = await ctx.runAction(internal.budgetHealthCheck.checkBudgetMismatch, {});
      blocks.push(result);
    } catch (err) {
      blocks.push({
        name: "Budget vs VK",
        status: "warning",
        message: `CHECK_FAILED: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Format report
    const statuses = blocks.map(b => b.status);
    const overallStatus = worstStatus(statuses);
    const duration = Date.now() - startTime;

    const warnings = statuses.filter(s => s === "warning").length;
    const errors = statuses.filter(s => s === "error").length;
    const problemCount = warnings + errors;

    // Build Telegram message
    if (problemCount > 0) {
      const icon = overallStatus === "error" ? "🔴" : "🟡";
      const statusIcons: Record<CheckStatus, string> = { ok: "✅", warning: "⚠️", error: "🛑" };
      const lines: string[] = [];

      lines.push(`${icon} <b>Бюджеты УЗ</b> — ${problemCount} ${problemCount === 1 ? "проблема" : "проблем"}\n`);

      for (const block of blocks) {
        lines.push(`${statusIcons[block.status]} ${block.name}: ${block.message}`);
        if (block.details && block.status !== "ok") {
          for (const d of block.details.slice(0, 5)) {
            lines.push(`  ${d}`);
          }
        }
      }

      lines.push(`\n⏱ ${Math.round(duration / 1000)}сек`);

      await ctx.runAction(internal.telegram.sendMessage, {
        chatId: ADMIN_CHAT_ID,
        text: lines.join("\n"),
      });
    }

    // Save result
    await ctx.runMutation(internal.healthCheck.saveResult, {
      type: "system" as const,
      status: overallStatus,
      summary: problemCount > 0 ? `Бюджеты УЗ: ${problemCount} проблем` : "Бюджеты УЗ: ок",
      details: { blocks } as any,
      checkedUsers: 0,
      checkedAccounts: 0,
      checkedRules: 0,
      warnings,
      errors,
      duration,
    });
  },
});

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

    let manuallyStoppedPlans = 0;
    let budgetBlockedPlans = 0;
    let moderationBlockedPlans = 0;
    let blockedBannerGroups = 0;
    const userProblems = new Map<string, { stopped: number; budget: number; moderation: number; groups: number }>();

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
            const planData = await mtApi<{ items: Array<{ id: number; status: string; name: string; issues?: Array<{ code: string; message: string }> }> }>(
              "ad_plans.json", token, { _id: String(planId), fields: "id,status,name,issues" }
            );
            const plan = planData.items?.[0];
            if (plan && plan.status === "blocked") {
              const issueCode = plan.issues?.[0]?.code;
              const isStopped = issueCode === "STOPPED";
              const isBudget = issueCode === "BUDGET_LIMIT";

              if (isStopped) manuallyStoppedPlans++;
              else if (isBudget) budgetBlockedPlans++;
              else moderationBlockedPlans++;

              const groupsInPlan = campaigns.filter(c => c.ad_plan_id === planId && matchedCampaigns.has(c.id) && c.status !== "deleted").length;
              // Find user
              const rule = entry.rules[0];
              const user = await ctx.runQuery(internal.budgetHealthCheck.getUserName, { userId: rule.userId });
              const key = user || rule.userId;
              const prev = userProblems.get(key) || { stopped: 0, budget: 0, moderation: 0, groups: 0 };
              if (isStopped) prev.stopped++;
              else if (isBudget) prev.budget++;
              else prev.moderation++;
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

    // Severity: moderation → error, budget → warning, stopped → info only
    if (moderationBlockedPlans > 0) {
      status = "error";
    } else if (budgetBlockedPlans > 0 || blockedBannerGroups > 0) {
      status = "warning";
    }

    // Build details per user (only for non-stopped problems)
    for (const [user, data] of userProblems) {
      const parts: string[] = [];
      if (data.moderation > 0) parts.push(`${data.moderation} модерация`);
      if (data.budget > 0) parts.push(`${data.budget} бюджет`);
      if (parts.length > 0) {
        issues.unshift(`${user}: ${parts.join(", ")} (${data.groups} групп)`);
      }
    }

    // Build message
    const totalProblems = moderationBlockedPlans + budgetBlockedPlans;
    const totalBlocked = totalProblems + manuallyStoppedPlans;
    let message: string;
    if (totalBlocked === 0 && blockedBannerGroups === 0) {
      message = "ок";
    } else {
      const parts: string[] = [];
      if (moderationBlockedPlans > 0) parts.push(`${moderationBlockedPlans} модерация`);
      if (budgetBlockedPlans > 0) parts.push(`${budgetBlockedPlans} бюджет`);
      if (blockedBannerGroups > 0) parts.push(`${blockedBannerGroups} групп blocked баннеры`);
      if (manuallyStoppedPlans > 0) parts.push(`${manuallyStoppedPlans} ручных`);
      message = parts.join(", ");
    }

    return {
      name: "Каскадные блокировки",
      status,
      message,
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
        .withIndex("by_ruleId_createdAt", (q) =>
          q.eq("ruleId", rule._id).gte("createdAt", dayStartUtc)
        )
        .filter((q) =>
          q.and(
            q.eq(q.field("actionType"), "budget_increased"),
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
        .withIndex("by_ruleId_createdAt", (q) =>
          q.eq("ruleId", rule._id).gte("createdAt", twoHoursAgo)
        )
        .filter((q) =>
          q.and(
            q.eq(q.field("actionType"), "budget_increased"),
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

// ─── Block 4: Zero-spend UZ campaigns ───

interface BannerStatus {
  id: number;
  status: string;
  moderation_status: string;
}

function diagnoseReason(
  campaignStatus: string | undefined,
  campaignDelivery: string | undefined,
  banners: BannerStatus[]
): string {
  if (banners.some((b) => b.moderation_status === "banned")) return "баннер отклонён модерацией";
  if (banners.some((b) => b.moderation_status === "in_progress")) return "баннер на модерации";
  if (campaignStatus === "blocked") return "кампания заблокирована";
  if (campaignDelivery === "not_delivering") return "кампания не откручивается";
  if (banners.length === 0) return "нет баннеров в кампании";
  return "причина не определена — проверьте ставки и аудиторию";
}

export const checkZeroSpendUzCampaigns = internalAction({
  args: {},
  handler: async (ctx): Promise<CheckResult> => {
    const { getZeroSpendCampaigns } = await import("./uzBudgetHelpers");
    const uzRules = await ctx.runQuery(internal.ruleEngine.getActiveUzRules) as any[];

    if (uzRules.length === 0) {
      return { name: "Кампании без расхода", status: "ok", message: "нет активных УЗ-правил" };
    }

    // Collect account IDs
    const accountIds = new Set<string>();
    for (const r of uzRules) {
      for (const accId of r.targetAccountIds) accountIds.add(accId as string);
    }

    // Compute dates in MSK
    const now = new Date();
    const mskFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" });
    const today = mskFormatter.format(now);
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const fromDate = mskFormatter.format(sevenDaysAgo);
    const todayDate = new Date(today + "T00:00:00Z");
    const yesterday = new Date(todayDate);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const toDate = yesterday.toISOString().slice(0, 10);

    // Fetch metrics for all accounts
    const metricsMap = new Map<string, { campaignId: string; spent: number }[]>();
    for (const accId of accountIds) {
      try {
        const rows = await ctx.runQuery(internal.metrics.getByAccountDateRange, {
          accountId: accId as Id<"adAccounts">,
          fromDate,
          toDate,
        });
        for (const row of rows as any[]) {
          const key = `${accId}|${row.date}`;
          if (!metricsMap.has(key)) metricsMap.set(key, []);
          metricsMap.get(key)!.push({ campaignId: row.campaignId, spent: row.spent });
        }
      } catch (err) {
        console.warn(`[zeroSpend] Failed to fetch metrics for ${accId}:`, err);
      }
    }

    // Find zero-spend campaigns
    const zeroSpend = getZeroSpendCampaigns(uzRules, metricsMap, today, 2);

    if (zeroSpend.length === 0) {
      return { name: "Кампании без расхода", status: "ok", message: "все УЗ-кампании с расходом" };
    }

    // Diagnose each via VK API + check dedup + send user alerts
    const details: string[] = [];
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

    // Group by account for API efficiency
    const byAccount = new Map<string, typeof zeroSpend>();
    for (const zs of zeroSpend) {
      const accId = zs.accountId as string;
      if (!byAccount.has(accId)) byAccount.set(accId, []);
      byAccount.get(accId)!.push(zs);
    }

    for (const [accId, campaigns] of byAccount) {
      let token: string | null = null;
      let vkCampaigns: any[] = [];

      try {
        token = await ctx.runAction(internal.auth.getValidTokenForAccount, {
          accountId: accId as Id<"adAccounts">,
        });
        vkCampaigns = await ctx.runAction(internal.vkApi.getCampaignsForAccount, {
          accessToken: token,
        }) as any[];
      } catch {
        token = null;
      }

      for (const zs of campaigns) {
        // Diagnose reason
        let reason = "не удалось проверить (токен)";
        if (token) {
          const vkCamp = vkCampaigns.find((c: any) => String(c.id) === zs.campaignId);
          if (!vkCamp) {
            reason = "не найдена в VK";
          } else {
            let banners: BannerStatus[] = [];
            try {
              const bannersResp = await mtApi<{ items: BannerStatus[] }>(
                "banners.json",
                token,
                { campaign_id: zs.campaignId, limit: "50" }
              );
              banners = bannersResp.items || [];
            } catch { /* best-effort */ }
            reason = diagnoseReason(vkCamp.status, vkCamp.delivery, banners);
          }
        }

        // Check dedup: was alert sent in last 7 days?
        const recentAlert = await ctx.runQuery(internal.budgetHealthCheck.getRecentZeroSpendAlert, {
          ruleId: zs.ruleId,
          campaignId: zs.campaignId,
          sinceMs: Date.now() - SEVEN_DAYS_MS,
        });

        const userName = await ctx.runQuery(internal.budgetHealthCheck.getUserName, {
          userId: zs.userId,
        });
        const shortName = typeof userName === "string" ? userName.split(" ")[0] : "—";

        let alertSent = false;
        if (!recentAlert) {
          // Send Telegram to user
          try {
            const chatId = await ctx.runQuery(internal.telegram.getUserChatId, {
              userId: zs.userId,
            });
            if (chatId) {
              await ctx.runAction(internal.telegram.sendMessage, {
                chatId,
                text: [
                  `⚠️ <b>Правило «${zs.ruleName}»</b> работает на кампании без расхода ${zs.zeroDays} дн.`,
                  `Кампания: ${zs.campaignId}`,
                  `Причина: ${reason}`,
                  `→ Проверьте кампанию в VK или деактивируйте правило`,
                ].join("\n"),
              });
              alertSent = true;
            }
          } catch (err) {
            console.warn(`[zeroSpend] Failed to send alert to user ${zs.userId}:`, err);
          }

          // Log to actionLogs for dedup
          try {
            await ctx.runMutation(internal.ruleEngine.logBudgetAction, {
              userId: zs.userId,
              ruleId: zs.ruleId,
              accountId: zs.accountId,
              campaignId: zs.campaignId,
              campaignName: zs.campaignId,
              actionType: "zero_spend_alert" as any,
              oldBudget: 0,
              newBudget: 0,
              step: 0,
              error: `Кампания без расхода ${zs.zeroDays} дн. Причина: ${reason}`,
            });
          } catch (err) {
            console.warn(`[zeroSpend] Failed to log alert:`, err);
          }
        }

        const alertLabel = recentAlert ? "алерт ранее" : alertSent ? "алерт отправлен" : "нет chatId";
        details.push(`📤 ${shortName}: «${zs.ruleName}» → ${zs.campaignId} (0₽ ${zs.zeroDays} дн., ${reason}) — ${alertLabel}`);
      }
    }

    const plural = zeroSpend.length === 1 ? "кампания" : zeroSpend.length < 5 ? "кампании" : "кампаний";
    return {
      name: "Кампании без расхода",
      status: "warning",
      message: `${zeroSpend.length} ${plural} без расхода 2+ дн.`,
      details,
    };
  },
});

/** Check if zero_spend_alert was already sent for this rule+campaign recently */
export const getRecentZeroSpendAlert = internalQuery({
  args: {
    ruleId: v.id("rules"),
    campaignId: v.string(),
    sinceMs: v.number(),
  },
  handler: async (ctx, args) => {
    const log = await ctx.db
      .query("actionLogs")
      .withIndex("by_ruleId_createdAt", (q) =>
        q.eq("ruleId", args.ruleId).gte("createdAt", args.sinceMs)
      )
      .filter((q) =>
        q.and(
          q.eq(q.field("actionType"), "zero_spend_alert"),
          q.eq(q.field("adId"), args.campaignId)
        )
      )
      .first();
    return log !== null;
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

    // Block 4: Zero-spend UZ campaigns (VK API + DB)
    try {
      const result = await ctx.runAction(internal.budgetHealthCheck.checkZeroSpendUzCampaigns, {});
      blocks.push(result);
    } catch (err) {
      blocks.push({
        name: "Кампании без расхода",
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

import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

interface UzRule {
  _id: Id<"rules">;
  userId: Id<"users">;
  conditions: {
    initialBudget?: number;
    budgetStep?: number;
    maxDailyBudget?: number;
    resetDaily?: boolean;
  };
  actions: { notifyOnKeyEvents?: boolean; notifyOnEveryIncrease?: boolean };
  targetAccountIds: Id<"adAccounts">[];
  targetCampaignIds?: string[];
}

/**
 * Крон сброса бюджета.
 * Запускается каждые 30 минут, проверяет timezone пользователя,
 * и сбрасывает бюджет если наступили новые сутки (00:00 в timezone пользователя).
 */
export const resetBudgets = internalAction({
  args: {},
  handler: async (ctx) => {
    const uzRules = await ctx.runQuery(internal.ruleEngine.getActiveUzRules);
    console.log(`[uz_budget_reset] Found ${uzRules.length} active uz rules`);
    const resetRules = (uzRules as UzRule[]).filter(
      (r) => r.conditions.resetDaily
    );
    console.log(`[uz_budget_reset] Rules with resetDaily=true: ${resetRules.length}`);
    if (resetRules.length === 0) return;

    for (const rule of resetRules) {
      try {
        // Get user timezone
        const settings = await ctx.runQuery(internal.uzBudgetCron.getUserTimezone, {
          userId: rule.userId,
        });
        const tz = settings?.timezone || "Europe/Moscow";

        // Check: is it 00:00-00:29 in user's timezone?
        // Use Intl.DateTimeFormat.formatToParts() — reliable on Convex runtime
        const now = new Date();
        const formatter = new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          hour: "numeric",
          minute: "numeric",
          hour12: false,
        });
        const parts = formatter.formatToParts(now);
        const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "-1", 10);
        const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "-1", 10);

        console.log(`[uz_budget_reset] Rule ${rule._id}: tz=${tz}, hour=${hour}, minute=${minute}`);

        // Cron runs every 30 min → catch window 00:00-00:29
        if (hour !== 0 || minute >= 30) continue;

        // Check if already reset today
        // Since hour=0 and minute is 0-29, user's midnight was ~minute minutes ago
        const dayStartUtc = now.getTime() - minute * 60 * 1000;
        const dayEndUtc = dayStartUtc + 24 * 60 * 60 * 1000;
        const alreadyReset = await ctx.runQuery(
          internal.uzBudgetCron.hasResetToday,
          { ruleId: rule._id, dayStartUtc, dayEndUtc }
        );
        if (alreadyReset) continue;

        // Reset budget for each target campaign
        const { initialBudget } = rule.conditions;
        if (!initialBudget) continue;

        for (const accountId of rule.targetAccountIds) {
          let accessToken: string;
          try {
            accessToken = await ctx.runAction(
              internal.auth.getValidTokenForAccount,
              { accountId }
            );
          } catch {
            continue;
          }

          const targetIds = rule.targetCampaignIds || [];

          // Fetch campaign names from VK API
          const campaigns = await ctx.runAction(
            internal.vkApi.getCampaignsForAccount,
            { accessToken }
          ) as Array<{ id: number; name: string }>;
          const nameMap = new Map(campaigns.map((c) => [String(c.id), c.name]));

          const resetNames: string[] = [];
          for (const campaignIdStr of targetIds) {
            const campaignId = parseInt(campaignIdStr);
            if (isNaN(campaignId)) continue;
            // Only process campaigns that belong to this account
            if (!nameMap.has(campaignIdStr)) continue;
            const campaignName = nameMap.get(campaignIdStr) || `Группа #${campaignIdStr}`;

            try {
              await ctx.runAction(internal.vkApi.setCampaignBudget, {
                accessToken,
                campaignId,
                newLimitRubles: initialBudget,
              });

              await ctx.runMutation(internal.ruleEngine.logBudgetAction, {
                userId: rule.userId,
                ruleId: rule._id,
                accountId,
                campaignId: campaignIdStr,
                campaignName,
                actionType: "budget_reset" as const,
                oldBudget: 0,
                newBudget: initialBudget,
                step: 0,
              });
              resetNames.push(campaignName);
            } catch (err) {
              console.error(`[uz_budget_reset] Failed for campaign ${campaignId}:`, err);
            }
          }

          // Notify only about successfully reset campaigns
          if (rule.actions.notifyOnKeyEvents && resetNames.length > 0) {
            try {
              await ctx.runAction(internal.telegram.sendBudgetNotification, {
                userId: rule.userId,
                type: "reset" as const,
                campaignName: resetNames.length === 1
                  ? resetNames[0]
                  : `${resetNames.length} групп: ${resetNames.join(", ")}`,
                newBudget: initialBudget,
              });
            } catch (notifErr) {
              console.error(`[uz_budget_reset] Failed to send reset notification:`, notifErr);
            }
          }
        }
      } catch (err) {
        console.error(`[uz_budget_reset] Error processing rule ${rule._id}:`, err);
      }
    }
  },
});

export const getUserTimezone = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const settings = await ctx.db
      .query("userSettings")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
    return settings;
  },
});

export const hasResetToday = internalQuery({
  args: {
    ruleId: v.id("rules"),
    dayStartUtc: v.number(),
    dayEndUtc: v.number(),
  },
  handler: async (ctx, args) => {
    const log = await ctx.db
      .query("actionLogs")
      .withIndex("by_ruleId", (q) => q.eq("ruleId", args.ruleId))
      .filter((q) =>
        q.and(
          q.eq(q.field("actionType"), "budget_reset"),
          q.gte(q.field("createdAt"), args.dayStartUtc),
          q.lt(q.field("createdAt"), args.dayEndUtc)
        )
      )
      .first();
    return log !== null;
  },
});

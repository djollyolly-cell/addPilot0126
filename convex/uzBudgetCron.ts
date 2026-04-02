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
    const resetRules = (uzRules as UzRule[]).filter(
      (r) => r.conditions.resetDaily
    );
    if (resetRules.length === 0) return;

    for (const rule of resetRules) {
      try {
        // Get user timezone
        const settings = await ctx.runQuery(internal.uzBudgetCron.getUserTimezone, {
          userId: rule.userId,
        });
        const tz = settings?.timezone || "UTC";

        // Check: is it 00:00-00:29 in user's timezone?
        const now = new Date();
        const userTime = new Date(now.toLocaleString("en-US", { timeZone: tz }));
        const hour = userTime.getHours();
        const minute = userTime.getMinutes();

        // Cron runs every 30 min → catch window 00:00-00:29
        if (hour !== 0 || minute >= 30) continue;

        // Check if already reset today
        const todayStr = `${userTime.getFullYear()}-${String(userTime.getMonth() + 1).padStart(2, "0")}-${String(userTime.getDate()).padStart(2, "0")}`;
        const alreadyReset = await ctx.runQuery(
          internal.uzBudgetCron.hasResetToday,
          { ruleId: rule._id, dateStr: todayStr }
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
          for (const campaignIdStr of targetIds) {
            const campaignId = parseInt(campaignIdStr);
            if (isNaN(campaignId)) continue;

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
                campaignName: `Campaign ${campaignIdStr}`,
                actionType: "budget_reset" as const,
                oldBudget: 0,
                newBudget: initialBudget,
                step: 0,
              });
            } catch (err) {
              console.error(`[uz_budget_reset] Failed for campaign ${campaignId}:`, err);
            }
          }

          // Notify about reset
          if (rule.actions.notifyOnKeyEvents) {
            try {
              await ctx.runAction(internal.telegram.sendBudgetNotification, {
                userId: rule.userId,
                type: "reset" as const,
                campaignName: `${targetIds.length} групп(а)`,
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
    dateStr: v.string(),
  },
  handler: async (ctx, args) => {
    const dayStart = new Date(args.dateStr).getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    const log = await ctx.db
      .query("actionLogs")
      .withIndex("by_ruleId", (q) => q.eq("ruleId", args.ruleId))
      .filter((q) =>
        q.and(
          q.eq(q.field("actionType"), "budget_reset"),
          q.gte(q.field("createdAt"), dayStart),
          q.lt(q.field("createdAt"), dayEnd)
        )
      )
      .first();
    return log !== null;
  },
});

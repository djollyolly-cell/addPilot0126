import { v } from "convex/values";
import { action, internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { filterCampaignsForRule, VkCampaign } from "./uzBudgetHelpers";

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

          // Fetch campaigns from VK API
          const campaigns = await ctx.runAction(
            internal.vkApi.getCampaignsForAccount,
            { accessToken }
          ) as VkCampaign[];

          // Use filterCampaignsForRule to resolve ad_plan_id matches
          const matchedCampaigns = filterCampaignsForRule(campaigns, rule);

          const resetNames: string[] = [];
          for (const campaign of matchedCampaigns) {
            const campaignId = campaign.id;
            const campaignIdStr = String(campaignId);
            const campaignName = campaign.name || `Группа #${campaignIdStr}`;

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

/**
 * TEMP — One-time emergency budget reset after server outage.
 * Processes ONE rule at a time (by index) to avoid timeout.
 * For each campaign in the rule:
 *   - Gets current spent from VK API
 *   - Sets budget = max(spent, initialBudget)
 * Remove after use.
 */
export const emergencyBudgetReset = action({
  args: { ruleIndex: v.number() },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const uzRules: UzRule[] = await ctx.runQuery(internal.ruleEngine.getActiveUzRules) as UzRule[];
    const resetRules: UzRule[] = uzRules.filter(
      (r) => r.conditions.resetDaily
    );

    if (args.ruleIndex >= resetRules.length) {
      return { done: true, totalRules: resetRules.length, message: "All rules processed" };
    }

    const rule = resetRules[args.ruleIndex];
    let processed = 0;
    let reset = 0;
    let errors = 0;
    const details: string[] = [];

    for (const accountId of rule.targetAccountIds) {
      let accessToken: string;
      try {
        accessToken = await ctx.runAction(
          internal.auth.getValidTokenForAccount,
          { accountId }
        );
      } catch {
        errors++;
        details.push(`No token for account ${accountId}`);
        continue;
      }

      const campaigns = await ctx.runAction(
        internal.vkApi.getCampaignsForAccount,
        { accessToken }
      ) as VkCampaign[];

      // Use filterCampaignsForRule to resolve ad_plan_id matches
      const matchedCampaigns = filterCampaignsForRule(campaigns, rule);

      for (const camp of matchedCampaigns) {
        const campaignIdStr = String(camp.id);
        const currentLimit = Number(camp.budget_limit_day || "0");
        if (currentLimit <= 0) continue;
        processed++;

        try {
          const spentToday = await ctx.runAction(
            internal.vkApi.getCampaignSpentToday,
            { accessToken, campaignId: campaignIdStr }
          );

          const initialBudget = rule.conditions.initialBudget || 100;
          const newBudget = Math.max(Math.ceil(spentToday), initialBudget);

          if (currentLimit > newBudget + 5) {
            await ctx.runAction(internal.vkApi.setCampaignBudget, {
              accessToken,
              campaignId: camp.id,
              newLimitRubles: newBudget,
            });

            await ctx.runMutation(internal.ruleEngine.logBudgetAction, {
              userId: rule.userId,
              ruleId: rule._id,
              accountId,
              campaignId: campaignIdStr,
              campaignName: camp.name,
              actionType: "budget_reset" as const,
              oldBudget: currentLimit,
              newBudget,
              step: 0,
            });
            reset++;
            details.push(`${camp.name}: ${currentLimit} -> ${newBudget} (spent=${Math.ceil(spentToday)})`);
          }
        } catch (err) {
          errors++;
          details.push(`FAIL ${campaignIdStr}: ${err}`);
        }
      }
    }

    return {
      done: false,
      ruleIndex: args.ruleIndex,
      ruleName: (rule as unknown as { name?: string }).name || rule._id,
      totalRules: resetRules.length,
      campaignsProcessed: processed,
      campaignsReset: reset,
      errors,
      details,
    };
  },
});

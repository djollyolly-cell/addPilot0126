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
 * и сбрасывает бюджет в окне 00:00-00:59 нового дня (timezone пользователя).
 * Окно 00:00-00:59 даёт 2 попытки (крон каждые 30 мин).
 * Сброс в 00:00 безопасен: VK API возвращает spent=0 за новый день,
 * поэтому checkUzBudgetRules (catch-up) не откатит сброс.
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

        // Check: is it 00:00-00:59 in user's timezone?
        // Reset at start of new day: VK daily spent = 0, so catch-up won't undo it.
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

        console.log(`[uz_budget_reset] Rule ${rule._id}: tz=${tz}, hour=${hour}`);

        // Cron runs every 30 min → catch window 00:00-00:59 (2 attempts)
        if (hour !== 0) continue;

        // Compute start/end of current calendar day in user's timezone.
        // At hour=0, minute=M, second=S: we are M*60+S seconds into the new day.
        // dayStartUtc = now minus elapsed seconds = midnight in user's tz (in UTC ms).
        const minutePart = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
        const secondsPart = now.getSeconds();
        const dayStartUtc = now.getTime() - (minutePart * 60 + secondsPart) * 1000;
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
          const acc = await ctx.runQuery(internal.adAccounts.getInternal, { accountId });
          if (!acc || acc.status === "abandoned") continue;

          let accessToken: string;
          try {
            accessToken = await ctx.runAction(
              internal.auth.getValidTokenForAccount,
              { accountId }
            );
          } catch (tokenErr) {
            const tokenMsg = tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
            const accName = await ctx.runQuery(internal.uzBudgetCron.getAccountName, { accountId });
            console.error(`[uz_budget_reset] Token failed for account "${accName}" (${accountId}): ${tokenMsg}`);
            // Invalidate tokenExpiresAt so next cycle triggers refresh
            if (tokenMsg.includes("TOKEN_EXPIRED")) {
              try {
                await ctx.runAction(internal.tokenRecovery.handleTokenExpired, {
                  accountId,
                });
              } catch (handleErr) {
                console.log(`[uz_budget_reset] handleTokenExpired for ${accountId} failed: ${handleErr}`);
              }
            }
            // Notify user about skipped reset via Telegram
            try {
              const chatId = await ctx.runQuery(internal.telegram.getUserChatId, {
                userId: rule.userId,
              });
              if (chatId) {
                await ctx.runAction(internal.telegram.sendMessage, {
                  chatId,
                  text: `⚠️ <b>Ресет не выполнен</b>\n\nКабинет «${accName || accountId}»: ошибка токена.\nБюджеты не сброшены. Переподключите кабинет или обновите токен.`,
                });
              }
            } catch { /* notification best-effort */ }
            continue;
          }

          // Fetch campaigns from VK API
          const campaigns = await ctx.runAction(
            internal.vkApi.getCampaignsForAccount,
            { accessToken }
          ) as VkCampaign[];

          // Use filterCampaignsForRule to resolve ad_plan_id matches
          const matchedCampaigns = filterCampaignsForRule(campaigns, rule);

          // Fetch metrics for last 2 days to detect zero-spend campaigns
          const { getZeroSpendCampaigns } = await import("./uzBudgetHelpers");
          const mskFmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
          const todayStr = mskFmt.format(new Date());
          const todayDt = new Date(todayStr + "T00:00:00Z");
          const twoDaysAgoDt = new Date(todayDt);
          twoDaysAgoDt.setUTCDate(twoDaysAgoDt.getUTCDate() - 2);
          const fromDateStr = twoDaysAgoDt.toISOString().slice(0, 10);
          const yesterdayDt = new Date(todayDt);
          yesterdayDt.setUTCDate(yesterdayDt.getUTCDate() - 1);
          const toDateStr = yesterdayDt.toISOString().slice(0, 10);

          const metricsMap = new Map<string, { campaignId: string; spent: number }[]>();
          try {
            const rows = await ctx.runQuery(internal.metrics.getByAccountDateRange, {
              accountId,
              fromDate: fromDateStr,
              toDate: toDateStr,
            });
            for (const row of rows as any[]) {
              const key = `${accountId as string}|${row.date}`;
              if (!metricsMap.has(key)) metricsMap.set(key, []);
              metricsMap.get(key)!.push({ campaignId: row.campaignId, spent: row.spent });
            }
          } catch (err) {
            console.warn(`[uz_budget_reset] Failed to fetch metrics for skip check:`, err);
          }

          const zeroSpendCampaigns = getZeroSpendCampaigns([rule] as any[], metricsMap, todayStr, 2);
          const zeroSpendIds = new Set(zeroSpendCampaigns.map((z) => z.campaignId));

          const resetNames: string[] = [];
          for (const campaign of matchedCampaigns) {
            const campaignId = campaign.id;
            const campaignIdStr = String(campaignId);
            const campaignName = campaign.name || `Группа #${campaignIdStr}`;

            // Skip reset for zero-spend campaigns where budget is already at initial
            const currentBudget = Number(campaign.budget_limit_day || "0");
            if (zeroSpendIds.has(campaignIdStr) && currentBudget === initialBudget) {
              console.log(`[uz_budget_reset] Skipped reset for «${campaignName}» — 0₽ spend 2+ days, budget already at ${initialBudget}₽`);
              continue;
            }

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

export const getAccountName = internalQuery({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const acc = await ctx.db.get(args.accountId);
    return acc?.name || null;
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
      .withIndex("by_ruleId_createdAt", (q) => q.eq("ruleId", args.ruleId))
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

import { internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";

// Today's date in YYYY-MM-DD format
function todayStr(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

/**
 * Sync metrics for ALL active ad accounts.
 * Called by cron every 5 minutes.
 *
 * For each active account:
 *  1. Get valid VK Ads token
 *  2. Fetch statistics from myTarget API
 *  3. Save realtime + daily metrics to Convex DB
 */
export const syncAll = internalAction({
  args: {},
  handler: async (ctx) => {
    // Get all active ad accounts
    const accounts = await ctx.runQuery(internal.syncMetrics.listActiveAccounts);

    if (accounts.length === 0) {
      console.log("[syncMetrics] No active accounts, skipping");
      return;
    }

    const date = todayStr();

    for (const account of accounts) {
      try {
        // Get valid token
        const accessToken = await ctx.runAction(
          internal.auth.getValidVkAdsToken,
          { userId: account.userId }
        );

        // Fetch statistics for today
        const stats = await ctx.runAction(api.vkApi.getMtStatistics, {
          accessToken,
          dateFrom: date,
          dateTo: date,
        });

        if (!stats || stats.length === 0) {
          console.log(
            `[syncMetrics] Empty stats for account ${account._id}, skipping`
          );
          continue;
        }

        // Save metrics for each ad (banner)
        for (const item of stats) {
          const adId = String(item.id);

          for (const row of item.rows) {
            // myTarget API v2 nests metrics under row.base
            const base = (row as any).base || row;
            const spent = parseFloat(base.spent || "0") || 0;
            const impressions = base.shows || 0;
            const clicks = base.clicks || 0;

            // Count leads from base.goals
            const baseGoals = typeof base.goals === "number" ? base.goals : 0;

            // Count leads from events (VK lead forms report here, not in base.goals)
            let eventsGoals = 0;
            const events = (row as any).events;
            if (events && typeof events === "object") {
              for (const [, eventData] of Object.entries(events)) {
                const ed = eventData as { count?: number } | undefined;
                if (ed && typeof ed.count === "number") {
                  eventsGoals += ed.count;
                }
              }
            }

            // Use the maximum of base.goals and events total
            // (they may overlap or one may be 0 depending on campaign type)
            const leads = Math.max(baseGoals, eventsGoals);

            console.log(
              `[syncMetrics] Ad ${adId}: clicks=${clicks}, base.goals=${JSON.stringify(base.goals)}, eventsGoals=${eventsGoals}, leads=${leads}`
            );

            // Save realtime snapshot
            await ctx.runMutation(internal.metrics.saveRealtime, {
              accountId: account._id,
              adId,
              spent,
              leads,
              impressions,
              clicks,
            });

            // Save / update daily aggregate
            await ctx.runMutation(internal.metrics.saveDaily, {
              accountId: account._id,
              adId,
              date: row.date,
              impressions,
              clicks,
              spent,
              leads,
              reach: base.reach,
            });
          }
        }

        // Update sync time
        await ctx.runMutation(api.adAccounts.updateSyncTime, {
          accountId: account._id,
        });

        console.log(
          `[syncMetrics] Account ${account._id}: ${stats.length} ads synced`
        );
      } catch (error) {
        const msg =
          error instanceof Error ? error.message : "Unknown error";
        console.error(
          `[syncMetrics] Error syncing account ${account._id}: ${msg}`
        );

        // Mark account as error but don't stop the loop
        await ctx.runMutation(api.adAccounts.updateStatus, {
          accountId: account._id,
          status: "error",
          lastError: `Sync failed: ${msg}`,
        });
      }
    }

    // After all accounts synced, run rule engine
    try {
      await ctx.runAction(internal.ruleEngine.checkAllRules, {});
    } catch (error) {
      console.error(
        "[syncMetrics] Error running rule engine:",
        error instanceof Error ? error.message : error
      );
    }
  },
});

// Internal query — list all active ad accounts (for cron)
import { internalQuery } from "./_generated/server";

export const listActiveAccounts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("adAccounts").collect();
    return accounts.filter((a) => a.status === "active");
  },
});

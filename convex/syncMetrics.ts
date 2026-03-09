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
        const [stats, leadCounts] = await Promise.all([
          ctx.runAction(api.vkApi.getMtStatistics, {
            accessToken,
            dateFrom: date,
            dateTo: date,
          }),
          ctx.runAction(api.vkApi.getMtLeadCounts, {
            accessToken,
            dateFrom: date,
            dateTo: date,
          }),
        ]);

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

            // Count leads from Lead Ads API (separate endpoint for VK lead forms)
            const leadAdsCount = leadCounts[adId] || 0;

            // Use the maximum across all sources
            const leads = Math.max(baseGoals, eventsGoals, leadAdsCount);

            console.log(
              `[syncMetrics] Ad ${adId}: clicks=${clicks}, base.goals=${JSON.stringify(base.goals)}, eventsGoals=${eventsGoals}, leadAds=${leadAdsCount}, leads=${leads}`
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
import { internalQuery, query } from "./_generated/server";

export const listActiveAccounts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("adAccounts").collect();
    return accounts.filter((a) => a.status === "active");
  },
});

// TEMP diagnostic — remove after debugging
export const debugMetrics = query({
  args: {},
  handler: async (ctx) => {
    // Get recent daily metrics with clicks > 0
    const all = await ctx.db.query("metricsDaily").order("desc").take(200);
    const withClicks = all
      .filter((m) => m.clicks > 0)
      .slice(0, 20)
      .map((m) => ({
        adId: m.adId,
        date: m.date,
        clicks: m.clicks,
        leads: m.leads,
        spent: m.spent,
      }));

    // Get recent action logs
    const logs = await ctx.db.query("actionLogs").order("desc").take(10);
    const actionLogs = logs.map((l) => ({
      adId: l.adId,
      userId: l.userId,
      actionType: l.actionType,
      reason: l.reason,
      status: l.status,
      leads: l.metricsSnapshot.leads,
      clicks: l.metricsSnapshot.clicks,
      createdAt: new Date(l.createdAt).toISOString(),
    }));

    // Get users with telegramChatId
    const users = await ctx.db.query("users").collect();
    const usersTg = users.map((u) => ({
      id: u._id,
      telegramChatId: (u as any).telegramChatId ?? null,
    }));

    // Get notifications
    const notifs = await ctx.db.query("notifications").order("desc").take(10);
    const notifications = notifs.map((n) => ({
      status: n.status,
      type: n.type,
      title: n.title,
      errorMessage: (n as any).errorMessage ?? null,
      createdAt: new Date(n.createdAt).toISOString(),
    }));

    // Get rules config
    const rules = await ctx.db.query("rules").collect();
    const rulesInfo = rules.map((r) => ({
      id: r._id,
      name: r.name,
      type: r.type,
      userId: r.userId,
      stopAd: r.actions.stopAd,
      notify: r.actions.notify,
      value: r.conditions.value,
      timeWindow: r.conditions.timeWindow,
      isActive: r.isActive,
    }));

    return { withClicks, actionLogs, usersTg, notifications, rulesInfo };
  },
});

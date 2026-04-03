import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { MtVideoStats } from "./vkApi";

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
        // Use per-account token (with fallback to user-level for old accounts)
        const accessToken = await ctx.runAction(
          internal.auth.getValidTokenForAccount,
          { accountId: account._id }
        );

        // Fetch statistics, lead counts, and banners (for campaign mapping) in parallel
        const [stats, leadCounts, banners] = await Promise.all([
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
          ctx.runAction(api.vkApi.getMtBanners, { accessToken }),
        ]);

        // Build bannerId → campaignId map
        const bannerCampaignMap = new Map<string, string>();
        for (const b of banners) {
          bannerCampaignMap.set(String(b.id), String(b.campaign_id));
        }

        // Auto-link videos to banners by matching content.video_id with videos.vkMediaId
        try {
          const bannerVideoMap: { bannerId: string; videoMediaId: string }[] = [];
          for (const banner of banners) {
            if (!banner.content) continue;
            for (const slotKey of Object.keys(banner.content)) {
              const slot = banner.content[slotKey];
              // Check if this slot contains a video
              const isVideo =
                slot.type === "video" ||
                (slot.variants &&
                  Object.values(slot.variants).some(
                    (variant: any) => variant.media_type === "video"
                  ));
              if (isVideo && slot.id) {
                bannerVideoMap.push({
                  bannerId: String(banner.id),
                  videoMediaId: String(slot.id),
                });
                break; // one video per banner is enough
              }
            }
          }

          if (bannerVideoMap.length > 0) {
            await ctx.runMutation(internal.videos.autoLinkVideos, {
              accountId: account._id,
              bannerVideoMap,
            });
          }
        } catch (error) {
          console.error(
            `[syncMetrics] Auto-link error for account ${account._id}:`,
            error instanceof Error ? error.message : error
          );
        }

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
            const base = row.base;
            const spent = parseFloat(base.spent || "0") || 0;
            const impressions = base.shows || 0;
            const clicks = base.clicks || 0;

            // Count leads from base.goals (handle both number and string)
            const baseGoals = Number(base.goals) || 0;

            // Count leads from base.vk.result / base.vk.goals
            // VK Ads reports campaign results (joins, leads, etc.) in this nested object
            const vkData = base.vk;
            const vkResult = vkData ? (Number(vkData.result) || 0) : 0;
            const vkGoals = vkData ? (Number(vkData.goals) || 0) : 0;

            // Count leads from events (VK lead forms report here, not in base.goals)
            let eventsGoals = 0;
            const events = row.events;
            if (events && typeof events === "object") {
              for (const [, eventData] of Object.entries(events)) {
                const ed = eventData as { count?: number | string } | number | undefined;
                if (typeof ed === "number") {
                  eventsGoals += ed;
                } else if (ed && typeof ed === "object" && ed.count !== undefined) {
                  eventsGoals += Number(ed.count) || 0;
                }
              }
            }

            // Count leads from Lead Ads API (separate endpoint for VK lead forms)
            const leadAdsCount = leadCounts[adId] || 0;

            // Use the maximum across all sources (4 sources now)
            const leads = Math.max(baseGoals, vkResult, vkGoals, eventsGoals, leadAdsCount);

            console.log(
              `[syncMetrics] Ad ${adId}: clicks=${clicks}, base.goals=${baseGoals}, vk.result=${vkResult}, vk.goals=${vkGoals}, events=${eventsGoals}, leadAds=${leadAdsCount}, leads=${leads}`
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
              campaignId: bannerCampaignMap.get(adId),
              date: row.date,
              impressions,
              clicks,
              spent,
              leads,
              vkResult: vkResult > 0 ? vkResult : undefined,
              reach: base.reach,
            });
          }
        }

        // Collect video stats for linked creatives
        try {
          const linkedVideos = await ctx.runQuery(internal.videos.listLinkedVideos, {});
          const accountVideos = linkedVideos.filter((vid: any) => vid.accountId === account._id);

          if (accountVideos.length > 0) {
            const videoAdIds = accountVideos
              .map((vid: any) => vid.vkAdId)
              .filter(Boolean)
              .join(",");

            if (videoAdIds) {
              const videoStats = await ctx.runAction(api.vkApi.getMtVideoStatistics, {
                accessToken,
                dateFrom: date,
                dateTo: date,
                bannerIds: videoAdIds,
              });

              for (const item of videoStats) {
                const adId = String(item.id);
                const linkedVideo = accountVideos.find((vid: any) => vid.vkAdId === adId);

                for (const row of item.rows) {
                  const base = row.base;
                  const vid: MtVideoStats = row.video || {};

                  await ctx.runMutation(internal.creativeAnalytics.saveCreativeStats, {
                    accountId: account._id,
                    videoId: linkedVideo?._id,
                    adId,
                    date: row.date,
                    impressions: base.shows || 0,
                    clicks: base.clicks || 0,
                    spent: parseFloat(base.spent || "0") || 0,
                    videoStarted: vid.started || undefined,
                    videoViewed3s: vid.viewed_3_seconds || undefined,
                    videoViewed10s: vid.viewed_10_seconds || undefined,
                    videoViewed25: vid.viewed_25_percent || undefined,
                    videoViewed50: vid.viewed_50_percent || undefined,
                    videoViewed75: vid.viewed_75_percent || undefined,
                    videoViewed100: vid.viewed_100_percent || undefined,
                    depthOfView: vid.depth_of_view || undefined,
                    viewed3sRate: vid.viewed_3_seconds_rate || undefined,
                    viewed25Rate: vid.viewed_25_percent_rate || undefined,
                    viewed50Rate: vid.viewed_50_percent_rate || undefined,
                    viewed75Rate: vid.viewed_75_percent_rate || undefined,
                    viewed100Rate: vid.viewed_100_percent_rate || undefined,
                  });
                }
              }

              console.log(
                `[syncMetrics] Account ${account._id}: ${accountVideos.length} video creatives stats synced`
              );
            }
          }
        } catch (error) {
          console.error(
            `[syncMetrics] Error fetching video stats for account ${account._id}:`,
            error instanceof Error ? error.message : error
          );
        }

        // Update sync time and clear any previous error
        await ctx.runMutation(api.adAccounts.updateSyncTime, {
          accountId: account._id,
        });
        if (account.lastError) {
          await ctx.runMutation(api.adAccounts.updateStatus, {
            accountId: account._id,
            status: "active",
          });
        }

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

    // UZ budget rules — check budget exhaustion and auto-increase
    try {
      await ctx.runAction(internal.ruleEngine.checkUzBudgetRules, {});
    } catch (error) {
      console.error(
        "[syncMetrics] Error running UZ budget rules:",
        error instanceof Error ? error.message : error
      );
    }

    // Poll moderation status for AI Cabinet banners
    try {
      await ctx.runAction(internal.syncMetrics.pollAiBannerModeration, {});
    } catch (error) {
      console.error(
        "[syncMetrics] Error polling AI banner moderation:",
        error instanceof Error ? error.message : error
      );
    }
  },
});

// Internal query — list all active ad accounts (for cron)
import { internalQuery, internalMutation, query } from "./_generated/server";

export const listActiveAccounts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("adAccounts").collect();
    return accounts.filter((a) => a.status === "active" || a.status === "error");
  },
});

// ─── AI Banner Moderation Polling ────────────────────────────────

/**
 * Poll moderation status for all active AI campaigns' banners.
 * Updates aiBanners moderation fields and notifies via Telegram on changes.
 */
export const pollAiBannerModeration = internalAction({
  args: {},
  handler: async (ctx) => {
    // Get all active AI campaigns with vkCampaignId
    const campaigns = await ctx.runQuery(internal.syncMetrics.listActiveAiCampaigns);
    if (campaigns.length === 0) return;

    for (const campaign of campaigns) {
      try {
        // Get token for the account
        const accessToken = await ctx.runAction(
          internal.auth.getValidTokenForAccount,
          { accountId: campaign.accountId }
        );

        // Fetch banners from myTarget for this campaign
        const mtBanners = await ctx.runAction(api.vkApi.getMtBanners, {
          accessToken,
          campaignId: campaign.vkCampaignId!,
        });

        // Get our stored banners for this campaign
        const ourBanners = await ctx.runQuery(internal.syncMetrics.listAiBannersForCampaign, {
          campaignId: campaign._id,
        });

        // Match and update moderation status
        for (const ourBanner of ourBanners) {
          if (!ourBanner.vkBannerId) continue;
          const mtBanner = mtBanners.find(
            (b: { id: number }) => String(b.id) === ourBanner.vkBannerId
          );
          if (!mtBanner) continue;

          const oldStatus = ourBanner.moderationStatus;
          const newStatus = mtBanner.moderation_status;

          if (oldStatus !== newStatus) {
            // Update in DB
            await ctx.runMutation(internal.syncMetrics.updateAiBannerModeration, {
              bannerId: ourBanner._id,
              moderationStatus: newStatus,
              moderationReason: newStatus === "banned" ? (mtBanner as any).moderation_reason || "" : undefined,
            });

            // Notify on status changes
            if (newStatus === "banned" || newStatus === "allowed") {
              const user = await ctx.runQuery(internal.users.getById, { userId: campaign.userId });
              if (user?.telegramChatId) {
                const emoji = newStatus === "banned" ? "🚫" : "✅";
                const statusText = newStatus === "banned" ? "отклонён" : "одобрен";
                const message = `${emoji} <b>AI Кабинет</b>\n\nБаннер "${ourBanner.title}" — ${statusText}\nКампания: ${campaign.name}${
                  newStatus === "banned" && (mtBanner as any).moderation_reason
                    ? `\nПричина: ${(mtBanner as any).moderation_reason}`
                    : ""
                }`;
                await ctx.runAction(internal.telegram.sendMessage, {
                  chatId: user.telegramChatId,
                  text: message,
                });
              }
            }
          }
        }
      } catch (error) {
        console.error(
          `[pollModeration] Error for campaign ${campaign._id}:`,
          error instanceof Error ? error.message : error
        );
      }
    }
  },
});

/** List active AI campaigns that have been launched to myTarget */
export const listActiveAiCampaigns = internalQuery({
  args: {},
  handler: async (ctx) => {
    const [active, creating] = await Promise.all([
      ctx.db.query("aiCampaigns").withIndex("by_status", (q) => q.eq("status", "active")).collect(),
      ctx.db.query("aiCampaigns").withIndex("by_status", (q) => q.eq("status", "creating")).collect(),
    ]);
    return [...active, ...creating].filter((c) => c.vkCampaignId);
  },
});

/** List AI banners for a campaign */
export const listAiBannersForCampaign = internalQuery({
  args: { campaignId: v.id("aiCampaigns") },
  handler: async (ctx, args) => {
    return ctx.db
      .query("aiBanners")
      .withIndex("by_campaignId", (q) => q.eq("campaignId", args.campaignId))
      .collect();
  },
});

/** Update AI banner moderation status */
export const updateAiBannerModeration = internalMutation({
  args: {
    bannerId: v.id("aiBanners"),
    moderationStatus: v.string(),
    moderationReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const updates: Record<string, unknown> = {
      moderationStatus: args.moderationStatus,
      updatedAt: Date.now(),
    };
    if (args.moderationReason !== undefined) {
      updates.moderationReason = args.moderationReason;
    }
    await ctx.db.patch(args.bannerId, updates);
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
      telegramChatId: u.telegramChatId ?? null,
    }));

    // Get notifications
    const notifs = await ctx.db.query("notifications").order("desc").take(10);
    const notifications = notifs.map((n) => ({
      status: n.status,
      type: n.type,
      title: n.title,
      errorMessage: n.errorMessage ?? null,
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

// TEMP — backfill vk.result into historical metricsDaily records
import { action } from "./_generated/server";

export const backfillVkResults = action({
  args: {
    userId: v.id("users"),
    dateFrom: v.string(),
    dateTo: v.string(),
  },
  handler: async (ctx, args): Promise<{ updated: number; totalAds: number }> => {
    const accessToken = await ctx.runAction(
      internal.auth.getValidVkAdsToken,
      { userId: args.userId }
    );

    // Fetch all-time stats with vk.result for all banners
    const stats = await ctx.runAction(api.vkApi.getMtStatistics, {
      accessToken,
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
    });

    let updated = 0;
    for (const item of stats) {
      const adId = String(item.id);
      for (const row of item.rows) {
        const vk = row.base?.vk;
        const vkResult = vk ? Math.max(Number(vk.result) || 0, Number(vk.goals) || 0) : 0;
        if (vkResult > 0) {
          // Update metricsDaily for this ad/date
          await ctx.runMutation(internal.ruleEngine.updateAdLeads, {
            adId,
            date: row.date,
            leads: vkResult,
          });
          updated++;
          console.log(`[backfill] Ad ${adId} date=${row.date}: set leads=${vkResult} (from vk.result)`);
        }
      }
    }

    return { updated, totalAds: stats.length };
  },
});

// TEMP diagnostic — check raw VK API response for leads

export const diagnosLeadsForAccount = action({
  args: {
    userId: v.id("users"),
    bannerIds: v.string(), // comma-separated
    dateFrom: v.string(),
    dateTo: v.string(),
  },
  handler: async (ctx, args): Promise<unknown> => {
    // Get valid token
    const accessToken = await ctx.runAction(
      internal.auth.getValidVkAdsToken,
      { userId: args.userId }
    );

    // Call diagnostic
    return await ctx.runAction(api.vkApi.diagnosLeads, {
      accessToken,
      bannerIds: args.bannerIds,
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
    });
  },
});

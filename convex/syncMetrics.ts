import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { MtVideoStats, MtCampaign } from "./vkApi";
import { withTimeout } from "./vkApi";
import { quickTokenCheck } from "./tokenRecovery";

const ACCOUNT_TIMEOUT_MS = 120_000; // 120s per account (includes getCampaigns + upsert + rule check)
const TRANSIENT_ERROR_THRESHOLD = 3; // error status only after 3 consecutive transient failures

/** Permanent errors → immediate error status. Everything else is transient. */
function isPermanentError(msg: string): boolean {
  return msg.includes("TOKEN_EXPIRED") || msg.includes("403 Forbidden");
}

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
    // Hard lock: skip this run if previous is still running (< 10 min)
    const STUCK_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
    const prevHeartbeat = await ctx.runQuery(internal.syncMetrics.getCronHeartbeat, { name: "syncAll" });
    if (prevHeartbeat && prevHeartbeat.status === "running") {
      const elapsedMs = Date.now() - prevHeartbeat.startedAt;
      const stuckMinutes = Math.round(elapsedMs / 60_000);
      if (elapsedMs < STUCK_THRESHOLD_MS) {
        console.log(`[syncAll] Previous run still active (${stuckMinutes}m ago). Skipping this cycle.`);
        return;
      }
      console.warn(`[syncAll] Previous run STUCK (${stuckMinutes}m ago, >${Math.round(STUCK_THRESHOLD_MS / 60_000)}m). Overriding and starting new run.`);
    }
    await ctx.runMutation(internal.syncMetrics.upsertCronHeartbeat, { name: "syncAll", status: "running" });

    let syncError: string | undefined;
    try {

    // Get all active ad accounts
    const accounts = await ctx.runQuery(internal.syncMetrics.listActiveAccounts);

    if (accounts.length === 0) {
      console.log("[syncMetrics] No active accounts, skipping");
      return;
    }

    const date = todayStr();

    let consecutiveCampaignApiFailures = 0;

    for (const account of accounts) {
      try {
        await withTimeout((async () => {
        // Auto-recovery: if account is in error from a transient (non-TOKEN_EXPIRED) failure,
        // check if token is still alive and restore to active before syncing
        if (
          account.status === "error" &&
          account.lastError &&
          !account.lastError.includes("TOKEN_EXPIRED")
        ) {
          try {
            const alive = await quickTokenCheck(account.accessToken);
            if (alive) {
              console.log(`[syncMetrics] Auto-recovery: «${account.name}» token alive, restoring to active`);
              // Set active + clear errors; updateSyncTime at end of successful sync will clear lastError
              await ctx.runMutation(api.adAccounts.updateStatus, {
                accountId: account._id,
                status: "active",
              });
              await ctx.runMutation(internal.adAccounts.clearSyncErrors, {
                accountId: account._id,
              });
            } else {
              // Token actually dead but error wasn't TOKEN_EXPIRED — skip this account
              console.log(`[syncMetrics] «${account.name}» in error, token dead — skipping`);
              return;
            }
          } catch {
            // quickTokenCheck failed (network?) — optimistic, try sync anyway
          }
        }

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

        // Fetch campaigns from VK API for campaign filter + fast_spend budget
        let vkCampaigns: MtCampaign[] = [];
        if (consecutiveCampaignApiFailures < 3) {
          try {
            vkCampaigns = await ctx.runAction(
              internal.vkApi.getCampaignsForAccount, { accessToken }
            );
            consecutiveCampaignApiFailures = 0;
          } catch (err) {
            console.warn(`[syncAll] getCampaignsForAccount failed for «${account.name}»: ${err}`);
            // Retry once
            try {
              vkCampaigns = await ctx.runAction(
                internal.vkApi.getCampaignsForAccount, { accessToken }
              );
              consecutiveCampaignApiFailures = 0;
            } catch (retryErr) {
              consecutiveCampaignApiFailures++;
              console.error(`[syncAll] getCampaignsForAccount retry failed for «${account.name}» (${consecutiveCampaignApiFailures}/3): ${retryErr}`);
              try { await ctx.runMutation(internal.systemLogger.log, {
                accountId: account._id,
                level: "error",
                source: "syncMetrics",
                message: `getCampaignsForAccount failed after retry: ${String(retryErr).slice(0, 180)}`,
              }); } catch { /* non-critical */ }
            }
          }
        } else {
          console.warn(`[syncAll] Circuit breaker active — skipping getCampaignsForAccount for «${account.name}»`);
        }

        // Build campaign data map: ad_group_id → { adPlanId, dailyBudget }
        const groupData = new Map<string, { adPlanId: string | null; dailyBudget: number }>();
        for (const c of vkCampaigns) {
          groupData.set(String(c.id), {
            adPlanId: c.ad_plan_id ? String(c.ad_plan_id) : null,
            dailyBudget: Number(c.budget_limit_day || "0"),
          });
        }

        // Build adCampaignMap: adId → { adGroupId, adPlanId, dailyBudget }
        const adCampaignMap: Array<{ adId: string; adGroupId: string; adPlanId: string | null; dailyBudget: number }> = [];
        for (const [adId, adGroupId] of bannerCampaignMap) {
          const data = groupData.get(adGroupId);
          adCampaignMap.push({
            adId,
            adGroupId,
            adPlanId: data?.adPlanId ?? null,
            dailyBudget: data?.dailyBudget ?? 0,
          });
        }

        if (adCampaignMap.length > 0) {
          console.log(`[syncAll] Live campaign map: ${adCampaignMap.length} ads, ${vkCampaigns.length} campaigns for «${account.name}»`);
        }

        // Auto-upsert campaigns from VK API data
        if (vkCampaigns.length > 0) {
          try {
            for (const c of vkCampaigns) {
              await ctx.runMutation(api.adAccounts.upsertCampaign, {
                accountId: account._id,
                vkCampaignId: String(c.id),
                adPlanId: c.ad_plan_id ? String(c.ad_plan_id) : undefined,
                name: c.name || `Кампания ${c.id}`,
                status: c.status,
                dailyLimit: Number(c.budget_limit_day || "0") || undefined,
                allLimit: Number(c.budget_limit || "0") || undefined,
              });
            }
          } catch (err) {
            console.error(`[syncAll] upsertCampaigns failed for «${account.name}»:`, err);
            try { await ctx.runMutation(internal.systemLogger.log, {
              accountId: account._id,
              level: "warn",
              source: "syncMetrics",
              message: `Auto-upsert campaigns failed: ${String(err).slice(0, 180)}`,
            }); } catch { /* non-critical */ }
          }
        }

        // Auto-upsert ads from getMtBanners data
        try {
          for (const banner of banners) {
            const campaignVkId = String(banner.campaign_id);
            const campaign = await ctx.runQuery(api.adAccounts.getCampaignByVkId, {
              accountId: account._id,
              vkCampaignId: campaignVkId,
            });
            if (campaign) {
              const bannerName = banner.textblocks?.title?.text || `Баннер ${banner.id}`;
              await ctx.runMutation(api.adAccounts.upsertAd, {
                accountId: account._id,
                campaignId: campaign._id,
                vkAdId: String(banner.id),
                name: bannerName,
                status: banner.status,
                approved: banner.moderation_status,
              });
            }
          }
        } catch (err) {
          console.error(`[syncAll] upsertAds failed for «${account.name}»:`, err);
          try { await ctx.runMutation(internal.systemLogger.log, {
            accountId: account._id,
            level: "warn",
            source: "syncMetrics",
            message: `Auto-upsert ads failed: ${String(err).slice(0, 180)}`,
          }); } catch { /* non-critical */ }
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
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error(
            `[syncMetrics] Auto-link error for account ${account._id}:`,
            errMsg
          );
          try { await ctx.runMutation(internal.systemLogger.log, {
            accountId: account._id,
            level: "warn",
            source: "syncMetrics",
            message: `Auto-link videos failed: ${errMsg.slice(0, 180)}`,
          }); } catch { /* non-critical */ }
        }

        if (!stats || stats.length === 0) {
          console.log(
            `[syncMetrics] Empty stats for account ${account._id}, skipping`
          );
          return;
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

            // Count leads from events.sending_form only (lead form submissions)
            // Other events (moving_into_group, clicks_on_external_url, likes, etc.) are NOT leads
            let eventsGoals = 0;
            const events = row.events;
            if (events && typeof events === "object") {
              const sendingForm = (events as Record<string, unknown>).sending_form;
              if (typeof sendingForm === "number") {
                eventsGoals = sendingForm;
              } else if (sendingForm && typeof sendingForm === "object") {
                eventsGoals = Number((sendingForm as { count?: number | string }).count) || 0;
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
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error(
            `[syncMetrics] Error fetching video stats for account ${account._id}:`,
            errMsg
          );
          try { await ctx.runMutation(internal.systemLogger.log, {
            accountId: account._id,
            level: "warn",
            source: "syncMetrics",
            message: `Video stats fetch failed: ${errMsg.slice(0, 180)}`,
          }); } catch { /* non-critical */ }
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

        // Run rules for this account with live campaign data
        try {
          await ctx.runAction(internal.ruleEngine.checkRulesForAccount, {
            accountId: account._id,
            adCampaignMap: adCampaignMap.length > 0 ? adCampaignMap : undefined,
          });
        } catch (err) {
          console.error(`[syncAll] checkRulesForAccount failed for «${account.name}»:`, err);
          try { await ctx.runMutation(internal.systemLogger.log, {
            accountId: account._id,
            level: "error",
            source: "syncMetrics",
            message: `checkRulesForAccount failed: ${String(err).slice(0, 180)}`,
          }); } catch { /* non-critical */ }
        }
        })(), ACCOUNT_TIMEOUT_MS, `syncAll account ${account._id}`);
      } catch (error) {
        const msg =
          error instanceof Error ? error.message : "Unknown error";
        console.error(
          `[syncMetrics] Error syncing account ${account._id}: ${msg}`
        );

        try { await ctx.runMutation(internal.systemLogger.log, {
          accountId: account._id,
          level: "error",
          source: "syncMetrics",
          message: `Sync failed: ${msg.slice(0, 180)}`,
        }); } catch { /* non-critical */ }

        if (msg.includes("TOKEN_EXPIRED")) {
          // TOKEN_EXPIRED — centralized handler owns the full flow:
          // verify token → recover → set status. No updateStatus here to avoid double-write.
          try {
            await ctx.runAction(internal.tokenRecovery.handleTokenExpired, {
              accountId: account._id,
            });
          } catch (handleErr) {
            // handleTokenExpired failed — ensure account is in error state
            await ctx.runMutation(api.adAccounts.updateStatus, {
              accountId: account._id,
              status: "error",
              lastError: `Sync failed: ${msg}`,
            });
            console.log(`[syncMetrics] handleTokenExpired for ${account._id} failed: ${handleErr}`);
          }
          // Clear transient error counter so it doesn't carry over after recovery
          await ctx.runMutation(internal.adAccounts.clearSyncErrors, {
            accountId: account._id,
          });
        } else if (isPermanentError(msg)) {
          // Permanent non-token error (e.g. 403) — immediate error status
          await ctx.runMutation(api.adAccounts.updateStatus, {
            accountId: account._id,
            status: "error",
            lastError: `Sync failed: ${msg}`,
          });
        } else {
          // Transient error — increment counter, only set error after threshold
          const consecutive = (account.consecutiveSyncErrors ?? 0) + 1;
          await ctx.runMutation(internal.adAccounts.incrementSyncErrors, {
            accountId: account._id,
            error: msg,
          });
          if (consecutive >= TRANSIENT_ERROR_THRESHOLD) {
            console.warn(
              `[syncMetrics] «${account.name}» ${consecutive} consecutive transient errors — marking as error`
            );
            await ctx.runMutation(api.adAccounts.updateStatus, {
              accountId: account._id,
              status: "error",
              lastError: `Sync failed (${consecutive}x): ${msg}`,
            });
          } else {
            console.log(
              `[syncMetrics] «${account.name}» transient error ${consecutive}/${TRANSIENT_ERROR_THRESHOLD} — will retry next cycle`
            );
          }
        }
      }
    }

    // checkAllRules removed — rules now run per-account inside the loop above

    // UZ budget rules — moved to separate cron "uz-budget-increase" (crons.ts)
    // to avoid timeout when syncAll takes too long

    // Poll moderation status for AI Cabinet banners
    try {
      await ctx.runAction(internal.syncMetrics.pollAiBannerModeration, {});
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(
        "[syncMetrics] Error polling AI banner moderation:",
        errMsg
      );
      try { await ctx.runMutation(internal.systemLogger.log, {
        level: "warn",
        source: "syncMetrics",
        message: `AI banner moderation poll failed: ${errMsg.slice(0, 180)}`,
      }); } catch { /* non-critical */ }
    }

    } catch (err) {
      syncError = err instanceof Error ? err.message : "Unknown error";
      console.error("[syncAll] Fatal error:", syncError);
      try { await ctx.runMutation(internal.systemLogger.log, {
        level: "error",
        source: "syncMetrics",
        message: `Fatal syncAll error: ${syncError.slice(0, 180)}`,
      }); } catch { /* non-critical */ }
    } finally {
      await ctx.runMutation(internal.syncMetrics.upsertCronHeartbeat, {
        name: "syncAll",
        status: syncError ? "failed" : "completed",
        error: syncError,
      });
    }
  },
});

// Internal query — list all active ad accounts (for cron)
import { internalQuery, internalMutation, query } from "./_generated/server";

const BATCH_SIZE = 40; // Max accounts per sync cycle (~40 × 45s = 30 min)
const SKIP_IF_SYNCED_WITHIN_MS = 4 * 60 * 1000; // Skip if synced < 4 min ago

export const listActiveAccounts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("adAccounts").collect();
    const active = accounts.filter((a) => a.status === "active" || a.status === "error");
    const now = Date.now();

    // Prioritize: oldest lastSyncAt first, skip recently synced
    return active
      .filter((a) => !a.lastSyncAt || (now - a.lastSyncAt) > SKIP_IF_SYNCED_WITHIN_MS)
      .sort((a, b) => (a.lastSyncAt || 0) - (b.lastSyncAt || 0))
      .slice(0, BATCH_SIZE);
  },
});

// ─── Cron Heartbeat ──────────────────────────────────────────────

export const getCronHeartbeat = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("cronHeartbeats")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .first();
  },
});

export const upsertCronHeartbeat = internalMutation({
  args: {
    name: v.string(),
    status: v.union(v.literal("running"), v.literal("completed"), v.literal("failed")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("cronHeartbeats")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .first();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        status: args.status,
        startedAt: args.status === "running" ? now : existing.startedAt,
        finishedAt: args.status !== "running" ? now : undefined,
        error: args.error,
      });
    } else {
      await ctx.db.insert("cronHeartbeats", {
        name: args.name,
        startedAt: now,
        status: args.status,
        error: args.error,
      });
    }
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
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(
          `[pollModeration] Error for campaign ${campaign._id}:`,
          errMsg
        );
        try { await ctx.runMutation(internal.systemLogger.log, {
          level: "warn",
          source: "syncMetrics",
          message: `Moderation poll failed for campaign ${campaign._id}: ${errMsg.slice(0, 150)}`,
        }); } catch { /* non-critical */ }
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

// TEMP — full service diagnostic (read-only)
export const serviceDiagnostic = query({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const threeHoursAgo = now - 3 * 60 * 60 * 1000;
    const today = new Date().toISOString().slice(0, 10);

    // 1. All users
    const users = await ctx.db.query("users").collect();
    const usersSummary = users.map((u) => ({
      id: u._id,
      email: u.email,
      name: u.name,
      tier: u.subscriptionTier ?? "freemium",
      telegramChatId: u.telegramChatId ?? null,
    }));

    // 2. All ad accounts with status
    const accounts = await ctx.db.query("adAccounts").collect();
    const accountsSummary = accounts.map((a) => ({
      id: a._id,
      userId: a.userId,
      vkAccountId: a.vkAccountId,
      name: a.name,
      status: a.status,
      lastSyncAt: a.lastSyncAt ? new Date(a.lastSyncAt).toISOString() : null,
      lastError: a.lastError ?? null,
    }));

    // 3. All rules with trigger info
    const rules = await ctx.db.query("rules").collect();
    const rulesSummary = rules.map((r) => ({
      id: r._id,
      userId: r.userId,
      name: r.name,
      type: r.type,
      isActive: r.isActive,
      triggerCount: r.triggerCount ?? 0,
      lastTriggeredAt: r.lastTriggeredAt
        ? new Date(r.lastTriggeredAt).toISOString()
        : null,
      targetAccountIds: r.targetAccountIds,
      targetCampaignIds: r.targetCampaignIds ?? [],
      conditions: r.conditions,
      actions: r.actions,
    }));

    // 4. Recent action logs (last 200)
    const logs = await ctx.db.query("actionLogs").order("desc").take(200);
    const logsSummary = logs.map((l) => ({
      ruleId: l.ruleId,
      adId: l.adId,
      adName: l.adName,
      actionType: l.actionType,
      reason: l.reason,
      status: l.status,
      errorMessage: l.errorMessage ?? null,
      savedAmount: l.savedAmount ?? 0,
      metricsSnapshot: l.metricsSnapshot,
      createdAt: new Date(l.createdAt).toISOString(),
    }));

    // 5. Rules not triggered in 3+ hours (among active ones)
    const staleRules = rulesSummary.filter((r) => {
      if (!r.isActive) return false;
      if (!r.lastTriggeredAt) return true; // never triggered
      return new Date(r.lastTriggeredAt).getTime() < threeHoursAgo;
    });

    // 6. Cron heartbeats
    const heartbeats = await ctx.db.query("cronHeartbeats").collect();
    const heartbeatSummary = heartbeats.map((h) => ({
      name: h.name,
      startedAt: new Date(h.startedAt).toISOString(),
      finishedAt: h.finishedAt ? new Date(h.finishedAt).toISOString() : null,
      status: h.status,
      error: h.error ?? null,
    }));

    // 7. Today's metrics summary per account (lightweight — query per account)
    const todayOnly: Array<{ accountId: string; spent: number; leads: number; clicks: number }> = [];
    for (const acc of accounts) {
      const rows = await ctx.db.query("metricsDaily")
        .withIndex("by_accountId_date", (q) => q.eq("accountId", acc._id).eq("date", today))
        .collect();
      for (const m of rows) {
        todayOnly.push({ accountId: m.accountId as string, spent: m.spent ?? 0, leads: m.leads ?? 0, clicks: m.clicks ?? 0 });
      }
    }
    const accountMetrics: Record<string, { ads: number; totalSpent: number; totalLeads: number; totalClicks: number }> = {};
    for (const m of todayOnly) {
      const key = m.accountId;
      if (!accountMetrics[key]) accountMetrics[key] = { ads: 0, totalSpent: 0, totalLeads: 0, totalClicks: 0 };
      accountMetrics[key].ads++;
      accountMetrics[key].totalSpent += m.spent;
      accountMetrics[key].totalLeads += m.leads;
      accountMetrics[key].totalClicks += m.clicks;
    }

    // 8. UZ budget rules analysis
    const uzRules = rules.filter((r) => r.type === "uz_budget_manage" && r.isActive);
    const uzRulesSummary = uzRules.map((r) => ({
      id: r._id,
      name: r.name,
      userId: r.userId,
      initialBudget: r.conditions.initialBudget,
      budgetStep: r.conditions.budgetStep,
      maxDailyBudget: r.conditions.maxDailyBudget,
      targetAccounts: r.targetAccountIds.length,
      targetCampaigns: (r.targetCampaignIds ?? []).length,
      triggerCount: r.triggerCount ?? 0,
      lastTriggeredAt: r.lastTriggeredAt
        ? new Date(r.lastTriggeredAt).toISOString()
        : null,
    }));

    // 9. Budget increase logs (last 100)
    const budgetLogs = logs
      .filter((l) => l.actionType === "budget_increased" || l.actionType === "budget_reset")
      .slice(0, 100)
      .map((l) => ({
        ruleId: l.ruleId,
        adId: l.adId,
        adName: l.adName,
        actionType: l.actionType,
        reason: l.reason,
        createdAt: new Date(l.createdAt).toISOString(),
        status: l.status,
        errorMessage: l.errorMessage ?? null,
      }));

    return {
      timestamp: new Date(now).toISOString(),
      usersSummary,
      accountsSummary,
      rulesSummary,
      staleRules,
      heartbeatSummary,
      accountMetrics,
      uzRulesSummary,
      budgetLogs,
      recentLogs: logsSummary.slice(0, 50),
      stats: {
        totalUsers: users.length,
        totalAccounts: accounts.length,
        totalRules: rules.length,
        activeRules: rules.filter((r) => r.isActive).length,
        uzActiveRules: uzRules.length,
        totalLogsToday: logs.filter((l) => new Date(l.createdAt).toISOString().slice(0, 10) === today).length,
        staleRulesCount: staleRules.length,
      },
    };
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

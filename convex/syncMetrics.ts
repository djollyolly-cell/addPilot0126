import { v } from "convex/values";
import type { Id, Doc } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { MtVideoStats, MtCampaign, MtStatItem } from "./vkApi";
import { withTimeout } from "./vkApi";
import { quickTokenCheck } from "./tokenRecovery";

const ACCOUNT_TIMEOUT_MS = 400_000; // 400s default per account
const TRANSIENT_ERROR_THRESHOLD = 3; // error status only after 3 consecutive transient failures
const ERROR_ESCALATION_MS = 2 * 60 * 60 * 1000; // 2 hours — escalate if account stuck in error

// Batch worker constants
const WORKER_COUNT = 6;
const WORKER_TIMEOUT_MS = 570_000; // 9.5 min total (Convex action limit = 10 min, 30s margin)
const BATCH_ACCOUNT_TIMEOUT_MS = 560_000; // 9 min 20s per account — heaviest account (2000+ campaigns) needs ~540s
const SYNC_BANNER_FIELDS = "id,campaign_id,textblocks,status,moderation_status";
const DEFAULT_UPSERT_CHUNK_SIZE = 200;
const HEAVY_ACCOUNT_UPSERT_CHUNK_SIZE = 50;
const HEAVY_ACCOUNT_CAMPAIGN_THRESHOLD = 500;

// Residual carry-over fix: adaptive chunks for sync batch flush mutations.
// Threshold = items count in single batch (== ads count for daily/realtime,
// ads count for upsert). Calibrated via Pre-Step B production measurement
// (admin.adsCountByAccount): top-1 = 2047, top-5 median = 1471, 12/20
// accounts > 1000 ads. Threshold 800 catches outliers without bloating
// the ~280 lighter accounts. Exported so unit tests assert behaviour
// relative to the threshold rather than hardcoded magic numbers.
export const HEAVY_BATCH_THRESHOLD = 800;
const DEFAULT_DAILY_CHUNK = 100;
const HEAVY_DAILY_CHUNK = 25;
const DEFAULT_REALTIME_CHUNK = 200;
const HEAVY_REALTIME_CHUNK = 50;
const DEFAULT_AD_UPSERT_CHUNK = 200;
const HEAVY_AD_UPSERT_CHUNK = 50;

type AdUpsertPayload = {
  vkAdId: string;
  campaignVkId: string;
  name: string;
  status: string;
  approved?: string;
};

type CampaignUpsertPayload = {
  vkCampaignId: string;
  adPlanId?: string;
  name: string;
  status: string;
  dailyLimit?: number;
  allLimit?: number;
};

function campaignUpsertChunkSize(count: number): number {
  return count > HEAVY_ACCOUNT_CAMPAIGN_THRESHOLD
    ? HEAVY_ACCOUNT_UPSERT_CHUNK_SIZE
    : DEFAULT_UPSERT_CHUNK_SIZE;
}

export function dailyMetricsChunkSize(itemsCount: number): number {
  return itemsCount > HEAVY_BATCH_THRESHOLD
    ? HEAVY_DAILY_CHUNK
    : DEFAULT_DAILY_CHUNK;
}

export function realtimeMetricsChunkSize(itemsCount: number): number {
  return itemsCount > HEAVY_BATCH_THRESHOLD
    ? HEAVY_REALTIME_CHUNK
    : DEFAULT_REALTIME_CHUNK;
}

export function adUpsertChunkSize(itemsCount: number): number {
  return itemsCount > HEAVY_BATCH_THRESHOLD
    ? HEAVY_AD_UPSERT_CHUNK
    : DEFAULT_AD_UPSERT_CHUNK;
}

/** Permanent errors → immediate error status. Everything else is transient. */
function isPermanentError(msg: string): boolean {
  return (
    msg.includes("TOKEN_EXPIRED") ||
    msg.includes("403 Forbidden") ||
    msg.includes("refreshToken отсутствует")
  );
}

/** Token-specific permanent errors → route to handleTokenExpired for recovery attempt. */
function isTokenExpiredError(msg: string): boolean {
  return msg.includes("TOKEN_EXPIRED") || msg.includes("refreshToken отсутствует");
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

        // Fetch lightweight banners first (only active/blocked), then use their IDs for stats + leads.
        // Keep the full banner payload (especially `content`) out of the hot sync path.
        const {
          bannerIds,
          bannerCampaignMap,
          adBatch,
        } = await (async (): Promise<{
          bannerIds: string;
          bannerCampaignMap: Map<string, string>;
          adBatch: AdUpsertPayload[];
        }> => {
          const banners = await ctx.runAction(api.vkApi.getMtBanners, {
            accessToken,
            accountId: account._id,
            fields: SYNC_BANNER_FIELDS,
          });
          const bannerCampaignMap = new Map<string, string>();
          const adBatch: AdUpsertPayload[] = [];
          const ids: string[] = [];
          for (const banner of banners) {
            const id = String(banner.id);
            ids.push(id);
            bannerCampaignMap.set(id, String(banner.campaign_id));
            adBatch.push({
              vkAdId: id,
              campaignVkId: String(banner.campaign_id),
              name: banner.textblocks?.title?.text || `Баннер ${banner.id}`,
              status: banner.status,
              approved: banner.moderation_status,
            });
          }
          return { bannerIds: ids.join(","), bannerCampaignMap, adBatch };
        })();

        // Fetch statistics and lead counts in parallel, using known banner IDs
        const [stats, leadCounts] = bannerIds
          ? await Promise.all([
              ctx.runAction(api.vkApi.getMtStatistics, {
                accessToken,
                dateFrom: date,
                dateTo: date,
                accountId: account._id,
                bannerIds,
              }),
              ctx.runAction(api.vkApi.getMtLeadCounts, {
                accessToken,
                dateFrom: date,
                dateTo: date,
                accountId: account._id,
              }),
            ])
          : [[] as MtStatItem[], {} as Record<string, number>];

        // Fetch campaigns from VK API for campaign filter + fast_spend budget
        const {
          groupData,
          adPlanBudgets,
          campaignBatch,
          campaignCount,
        } = await (async (): Promise<{
          groupData: Map<string, { adPlanId: string | null; dailyBudget: number }>;
          adPlanBudgets: Map<string, number>;
          campaignBatch: CampaignUpsertPayload[];
          campaignCount: number;
        }> => {
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

          const groupData = new Map<string, { adPlanId: string | null; dailyBudget: number }>();
          const campaignBatch: CampaignUpsertPayload[] = [];
          for (const c of vkCampaigns) {
            groupData.set(String(c.id), {
              adPlanId: c.ad_plan_id ? String(c.ad_plan_id) : null,
              dailyBudget: Number(c.budget_limit_day || "0"),
            });
            campaignBatch.push({
              vkCampaignId: String(c.id),
              adPlanId: c.ad_plan_id ? String(c.ad_plan_id) : undefined,
              name: c.name || `Кампания ${c.id}`,
              status: c.status,
              dailyLimit: Number(c.budget_limit_day || "0") || undefined,
              allLimit: Number(c.budget_limit || "0") || undefined,
            });
          }

          const adPlanBudgets = new Map<string, number>();
          try {
            const fetchedAdPlans = await ctx.runAction(api.vkApi.getMtAdPlans, { accessToken });
            for (const plan of fetchedAdPlans) {
              if (plan.budget_limit_day && plan.budget_limit_day > 0) {
                adPlanBudgets.set(String(plan.id), plan.budget_limit_day);
              }
              campaignBatch.push({
                vkCampaignId: String(plan.id),
                name: plan.name || `Кампания ${plan.id}`,
                status: plan.status,
                dailyLimit: plan.budget_limit_day && plan.budget_limit_day > 0 ? plan.budget_limit_day : undefined,
                allLimit: plan.budget_limit && plan.budget_limit > 0 ? plan.budget_limit : undefined,
              });
            }
          } catch (err) {
            // Non-critical: if ad_plans fetch fails, we still have group-level budgets
            console.warn(`[syncAll] getMtAdPlans failed for «${account.name}»: ${err}`);
          }

          return { groupData, adPlanBudgets, campaignBatch, campaignCount: vkCampaigns.length };
        })();

        // Build campaignType map: adGroupId → CampaignType
        // Uses existing getCampaignTypeMap (packages.json + ad_groups.json)
        const campaignTypeMap = new Map<string, string>();
        try {
          const typeMapArray = await ctx.runAction(
            internal.vkApi.getCampaignTypeMap,
            { accessToken }
          );
          for (const entry of typeMapArray) {
            campaignTypeMap.set(entry.adGroupId, entry.type);
          }
        } catch (err) {
          console.warn(`[syncAll] getCampaignTypeMap failed for «${account.name}»: ${err}`);
        }

        // Build adCampaignMap: adId → { adGroupId, adPlanId, dailyBudget }
        // CASCADE: group budget → ad_plan budget (if group budget = 0)
        const adCampaignMap: Array<{ adId: string; adGroupId: string; adPlanId: string | null; dailyBudget: number }> = [];
        for (const [adId, adGroupId] of bannerCampaignMap) {
          const data = groupData.get(adGroupId);
          let dailyBudget = data?.dailyBudget ?? 0;

          // Cascade: if group has no daily budget, use ad_plan budget
          if (dailyBudget <= 0 && data?.adPlanId) {
            dailyBudget = adPlanBudgets.get(data.adPlanId) ?? 0;
          }

          adCampaignMap.push({
            adId,
            adGroupId,
            adPlanId: data?.adPlanId ?? null,
            dailyBudget,
          });
        }

        if (adCampaignMap.length > 0) {
          console.log(`[syncAll] Live campaign map: ${adCampaignMap.length} ads, ${campaignCount} campaigns for «${account.name}»`);
        }

        // Auto-upsert campaigns (ad groups) + ad_plans — batched
        if (campaignBatch.length > 0) {
          try {
            const chunk = campaignUpsertChunkSize(campaignBatch.length);
            for (let i = 0; i < campaignBatch.length; i += chunk) {
              await ctx.runMutation(internal.adAccounts.upsertCampaignsBatch, {
                accountId: account._id,
                campaigns: campaignBatch.slice(i, i + chunk),
              });
            }
          } catch (err) {
            console.error(`[syncAll] upsertCampaignsBatch failed for «${account.name}»:`, err);
            try { await ctx.runMutation(internal.systemLogger.log, {
              accountId: account._id, level: "warn", source: "syncMetrics",
              message: `Auto-upsert campaigns batch failed: ${String(err).slice(0, 180)}`,
            }); } catch { /* non-critical */ }
          }
        }

        // Auto-upsert ads from lightweight getMtBanners data — batched
        {
          if (adBatch.length > 0) {
            try {
              const chunk = adUpsertChunkSize(adBatch.length);
              for (let i = 0; i < adBatch.length; i += chunk) {
                await ctx.runMutation(internal.adAccounts.upsertAdsBatch, {
                  accountId: account._id,
                  ads: adBatch.slice(i, i + chunk),
                });
              }
            } catch (err) {
              console.error(`[syncAll] upsertAdsBatch failed for «${account.name}»:`, err);
              try { await ctx.runMutation(internal.systemLogger.log, {
                accountId: account._id, level: "warn", source: "syncMetrics",
                message: `Auto-upsert ads batch failed: ${String(err).slice(0, 180)}`,
              }); } catch { /* non-critical */ }
            }
          }
        }

        // TODO(auto-link-cron): auto-link-video is temporarily disabled in primary
        // sync because banner.content triggers Convex V8 carry-over restarts.
        // Restore it as a separate low-frequency, per-account-sequential cron.

        if (!stats || stats.length === 0) {
          console.log(
            `[syncMetrics] Empty stats for account ${account._id}, skipping`
          );
          return;
        }

        // Save metrics for each ad (banner) — batched
        const realtimeBatchAll: { adId: string; spent: number; leads: number; impressions: number; clicks: number }[] = [];
        const dailyBatchAll: { adId: string; campaignId?: string; date: string; impressions: number; clicks: number; spent: number; leads: number; vkResult?: number; campaignType?: string; formEvents?: number; reach?: number }[] = [];

        for (const item of stats) {
          const adId = String(item.id);
          for (const row of item.rows) {
            const base = row.base;
            const spent = parseFloat(base.spent || "0") || 0;
            const impressions = base.shows || 0;
            const clicks = base.clicks || 0;
            const baseGoals = Number(base.goals) || 0;
            const vkData = base.vk;
            const vkResult = vkData ? (Number(vkData.result) || 0) : 0;
            const vkGoals = vkData ? (Number(vkData.goals) || 0) : 0;
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
            const leadAdsCount = leadCounts[adId] || 0;
            const leads = Math.max(baseGoals, vkResult, vkGoals, eventsGoals, leadAdsCount);

            console.log(
              `[syncMetrics] Ad ${adId}: clicks=${clicks}, base.goals=${baseGoals}, vk.result=${vkResult}, vk.goals=${vkGoals}, events=${eventsGoals}, leadAds=${leadAdsCount}, leads=${leads}`
            );

            realtimeBatchAll.push({ adId, spent, leads, impressions, clicks });

            const adGroupId = bannerCampaignMap.get(adId);
            dailyBatchAll.push({
              adId, date: row.date, impressions, clicks, spent, leads,
              campaignId: adGroupId,
              vkResult: vkResult > 0 ? vkResult : undefined,
              campaignType: adGroupId ? campaignTypeMap.get(adGroupId) : undefined,
              formEvents: eventsGoals > 0 ? eventsGoals : undefined,
              reach: base.reach,
            });
          }
        }

        // Flush metrics batches
        if (realtimeBatchAll.length > 0) {
          const chunk = realtimeMetricsChunkSize(realtimeBatchAll.length);
          for (let i = 0; i < realtimeBatchAll.length; i += chunk) {
            await ctx.runMutation(internal.metrics.saveRealtimeBatch, {
              accountId: account._id,
              items: realtimeBatchAll.slice(i, i + chunk),
            });
          }
        }
        if (dailyBatchAll.length > 0) {
          const chunk = dailyMetricsChunkSize(dailyBatchAll.length);
          for (let i = 0; i < dailyBatchAll.length; i += chunk) {
            await ctx.runMutation(internal.metrics.saveDailyBatch, {
              accountId: account._id,
              items: dailyBatchAll.slice(i, i + chunk),
            });
          }
        }

        // Collect video stats for linked creatives
        try {
          const linkedVideos = await ctx.runQuery(internal.videos.listLinkedVideos, {});
          const accountVideos = linkedVideos.filter((vid) => vid.accountId === account._id);

          if (accountVideos.length > 0) {
            const videoAdIds = accountVideos
              .map((vid) => vid.vkAdId)
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
                const linkedVideo = accountVideos.find((vid) => vid.vkAdId === adId);

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

        if (isTokenExpiredError(msg)) {
          // TOKEN_EXPIRED — centralized handler owns the full flow:
          // verify token → recover → set status. handleTokenExpired returns boolean (never throws).
          let recovered = false;
          try {
            recovered = await ctx.runAction(internal.tokenRecovery.handleTokenExpired, {
              accountId: account._id,
            });
          } catch (handleErr) {
            console.log(`[syncMetrics] handleTokenExpired for ${account._id} threw: ${handleErr}`);
          }
          if (!recovered) {
            await ctx.runMutation(api.adAccounts.updateStatus, {
              accountId: account._id,
              status: "error",
              lastError: `Sync failed: ${msg}`,
            });
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
const EMPTY_ACCOUNT_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1h for accounts with 3+ consecutive empty syncs

export const listActiveAccounts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("adAccounts").collect();
    // NOTE: "deleting", "paused", "archived" are excluded by this active/error-only filter.
    const active = accounts.filter((a) => a.status === "active" || a.status === "error");
    const now = Date.now();

    // Prioritize: oldest lastSyncAt first, skip recently synced
    return active
      .filter((a) => {
        if (!a.lastSyncAt) return true;
        const interval = (a.consecutiveEmptySyncs ?? 0) >= 3
          ? EMPTY_ACCOUNT_SYNC_INTERVAL_MS
          : SKIP_IF_SYNCED_WITHIN_MS;
        return (now - a.lastSyncAt) > interval;
      })
      .sort((a, b) => (a.lastSyncAt || 0) - (b.lastSyncAt || 0))
      .slice(0, BATCH_SIZE);
  },
});

/** All active/error accounts — no batch limit, for fan-out dispatcher. */
export const listSyncableAccounts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("adAccounts").collect();
    const active = accounts.filter((a) => a.status === "active" || a.status === "error");
    const now = Date.now();

    return active
      .filter((a) => {
        if (!a.lastSyncAt) return true;
        const interval = (a.consecutiveEmptySyncs ?? 0) >= 3
          ? EMPTY_ACCOUNT_SYNC_INTERVAL_MS
          : SKIP_IF_SYNCED_WITHIN_MS;
        return (now - a.lastSyncAt) > interval;
      })
      .sort((a, b) => (a.lastSyncAt || 0) - (b.lastSyncAt || 0))
      .slice(0, 100); // Limit per cycle — all 264 accounts sync within 3 cycles (15 min) via staleness sort
  },
});

/** All active/error accounts with lastSyncAt — for dispatcher health check. */
export const listAllActiveAccountsBasic = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("adAccounts").collect();
    return accounts
      .filter((a) => a.status === "active" || a.status === "error")
      .map((a) => ({ _id: a._id, lastSyncAt: a.lastSyncAt }));
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

/** Schedule escalation alert via adminAlerts.notify (called from action via runMutation). */
export const scheduleEscalationAlert = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    text: v.string(),
    dedupKey: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(0, internal.adminAlerts.notify, {
      category: "criticalErrors",
      dedupKey: args.dedupKey,
      text: args.text,
    });
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

// ─── Alert Dedup Helpers ─────────────────────────────────────────

/** Check if enough time has passed since last alert for this cron. */
export const shouldSendCronAlert = internalQuery({
  args: { cronName: v.string(), cooldownMs: v.number() },
  handler: async (ctx, args) => {
    const hb = await ctx.db
      .query("cronHeartbeats")
      .withIndex("by_name", (q) => q.eq("name", args.cronName))
      .first();
    if (!hb?.lastAlertSentAt) return true;
    return Date.now() - hb.lastAlertSentAt > args.cooldownMs;
  },
});

/** Mark that an alert was sent for this cron (for dedup). */
export const markCronAlertSent = internalMutation({
  args: { cronName: v.string() },
  handler: async (ctx, args) => {
    const hb = await ctx.db
      .query("cronHeartbeats")
      .withIndex("by_name", (q) => q.eq("name", args.cronName))
      .first();
    if (hb) {
      await ctx.db.patch(hb._id, { lastAlertSentAt: Date.now() });
    }
  },
});

// ─── Fan-Out: Sync Dispatch + Worker ─────────────────────────────

const ALERT_COOLDOWN_MS = 30 * 60_000; // 30 min between same alert
const SYNC_ADMIN_CHAT_ID = "325307765";

/** Split accounts into WORKER_COUNT chunks and schedule batch workers. */
export const dispatchSyncBatches = internalMutation({
  args: { accountIds: v.array(v.id("adAccounts")) },
  handler: async (ctx, args) => {
    const chunkSize = Math.ceil(args.accountIds.length / WORKER_COUNT);
    for (let i = 0; i < WORKER_COUNT; i++) {
      const chunk = args.accountIds.slice(i * chunkSize, (i + 1) * chunkSize);
      if (chunk.length === 0) break;
      await ctx.scheduler.runAfter(0, internal.syncMetrics.syncBatchWorker, {
        accountIds: chunk,
        workerIndex: i,
      });
    }
  },
});

/**
 * Per-account sync logic extracted from the former syncOneAccount.
 * Called sequentially by syncBatchWorker for each account in its chunk.
 */
async function syncSingleAccount(
  ctx: ActionCtx,
  accountId: Id<"adAccounts">
): Promise<void> {
    // Load account
    const account = await ctx.runQuery(internal.adAccounts.getInternal, { accountId });
    if (!account) {
      // Account not found — skip silently
      return;
    }
    if (account.status !== "active" && account.status !== "error") {
      return;
    }

    // Auto-abandon: error accounts with unrecoverable token errors for 7+ days
    // Use tokenErrorSince (when account first entered error), NOT lastSyncAt (last successful sync)
    if (
      account.status === "error" &&
      account.tokenErrorSince &&
      Date.now() - account.tokenErrorSince > 7 * 24 * 60 * 60 * 1000 &&
      (account.lastError?.includes("TOKEN_EXPIRED") ||
       account.lastError?.includes("Автовосстановление не удалось") ||
       account.lastError?.includes("refreshToken отсутствует"))
    ) {
      await ctx.runMutation(internal.adAccounts.markAbandoned, { accountId: account._id });

      // One-time Telegram to user
      try {
        const user = await ctx.runQuery(internal.users.getById, { userId: account.userId });
        if (user?.telegramChatId) {
          await ctx.runAction(internal.telegram.sendMessage, {
            chatId: user.telegramChatId,
            text: [
              `Кабинет «${account.name}» отключён от мониторинга`,
              ``,
              `Токен был недействителен более 7 дней, автовосстановление не удалось.`,
              `Переподключите кабинет: https://aipilot.by/accounts`,
            ].join("\n"),
          });
        }
      } catch { /* non-critical */ }

      // One-time admin alert
      try {
        await ctx.runMutation(internal.syncMetrics.scheduleEscalationAlert, {
          accountId: account._id,
          text: [
            `<b>Кабинет переведён в abandoned</b>`,
            ``,
            `<b>Кабинет:</b> ${account.name}`,
            `<b>Причина:</b> ${(account.lastError || "неизвестно").slice(0, 200)}`,
          ].join("\n"),
          dedupKey: `abandoned:${account._id}`,
        });
      } catch { /* non-critical */ }

      return;
    }

    // Escalation: if account stuck in error for >2h, notify admin
    // dedupKey WITHOUT timeSlot — adminAlerts 30-min dedup prevents spam
    if (
      account.status === "error" &&
      account.lastSyncAt &&
      Date.now() - account.lastSyncAt > ERROR_ESCALATION_MS
    ) {
      try {
        // Admin Telegram alert — dedup by accountId only (30-min window in adminAlerts)
        await ctx.runMutation(internal.syncMetrics.scheduleEscalationAlert, {
          accountId: account._id,
          text: [
            `⏰ <b>Эскалация: кабинет в ошибке >2ч</b>`,
            ``,
            `<b>Кабинет:</b> ${account.name}`,
            `<b>Последний синк:</b> ${new Date(account.lastSyncAt).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}`,
            `<b>Ошибка:</b> ${(account.lastError || "неизвестно").slice(0, 200)}`,
          ].join("\n"),
          dedupKey: `escalation:${account._id}`,
        });
      } catch { /* non-critical */ }
    }

    // Double-check SKIP_IF_SYNCED_WITHIN_MS (another worker may have synced it)
    if (account.lastSyncAt && Date.now() - account.lastSyncAt < SKIP_IF_SYNCED_WITHIN_MS) {
      return;
    }

    const date = todayStr();

    try {
      await withTimeout((async () => {
        // Auto-recovery: if account is in error from a transient failure, check if token is alive
        if (
          account.status === "error" &&
          account.lastError &&
          !account.lastError.includes("TOKEN_EXPIRED")
        ) {
          try {
            const alive = await quickTokenCheck(account.accessToken);
            if (alive) {
              // Auto-recovery: token alive, restoring to active
              await ctx.runMutation(api.adAccounts.updateStatus, {
                accountId: account._id,
                status: "active",
              });
              await ctx.runMutation(internal.adAccounts.clearSyncErrors, {
                accountId: account._id,
              });
            } else {
              console.log(`[syncBatch] "${account.name}" in error, token dead -- skipping`);
              return;
            }
          } catch {
            // quickTokenCheck failed — optimistic, try sync anyway
          }
        }

        // Get valid token
        const accessToken = await ctx.runAction(
          internal.auth.getValidTokenForAccount,
          { accountId: account._id }
        );

        // Fetch lightweight banners (only active/blocked). The full `content` payload is
        // intentionally excluded from the hot sync path to avoid V8 carry-over restarts.
        const {
          bannerIds,
          bannerCampaignMap,
          adBatch,
        } = await (async (): Promise<{
          bannerIds: string;
          bannerCampaignMap: Map<string, string>;
          adBatch: AdUpsertPayload[];
        }> => {
          const banners = await ctx.runAction(api.vkApi.getMtBanners, {
            accessToken,
            accountId: account._id,
            fields: SYNC_BANNER_FIELDS,
          });
          const bannerCampaignMap = new Map<string, string>();
          const adBatch: AdUpsertPayload[] = [];
          const ids: string[] = [];
          for (const banner of banners) {
            const id = String(banner.id);
            ids.push(id);
            bannerCampaignMap.set(id, String(banner.campaign_id));
            adBatch.push({
              vkAdId: id,
              campaignVkId: String(banner.campaign_id),
              name: banner.textblocks?.title?.text || `Баннер ${banner.id}`,
              status: banner.status,
              approved: banner.moderation_status,
            });
          }
          return { bannerIds: ids.join(","), bannerCampaignMap, adBatch };
        })();

        // Fetch statistics and lead counts in parallel
        const [stats, leadCounts] = bannerIds
          ? await Promise.all([
              ctx.runAction(api.vkApi.getMtStatistics, {
                accessToken, dateFrom: date, dateTo: date,
                accountId: account._id, bannerIds,
              }),
              ctx.runAction(api.vkApi.getMtLeadCounts, {
                accessToken, dateFrom: date, dateTo: date,
                accountId: account._id,
              }),
            ])
          : [[] as MtStatItem[], {} as Record<string, number>];

        // Fetch campaigns from VK API (no circuit breaker — each worker is independent)
        const {
          groupData,
          adPlanBudgets,
          campaignBatch,
        } = await (async (): Promise<{
          groupData: Map<string, { adPlanId: string | null; dailyBudget: number }>;
          adPlanBudgets: Map<string, number>;
          campaignBatch: CampaignUpsertPayload[];
        }> => {
          let vkCampaigns: MtCampaign[] = [];
          try {
            vkCampaigns = await ctx.runAction(
              internal.vkApi.getCampaignsForAccount, { accessToken }
            );
          } catch (err) {
            console.warn(`[syncBatch] getCampaignsForAccount failed for "${account.name}": ${err}`);
            // Retry once
            try {
              vkCampaigns = await ctx.runAction(
                internal.vkApi.getCampaignsForAccount, { accessToken }
              );
            } catch (retryErr) {
              console.error(`[syncBatch] getCampaignsForAccount retry failed for "${account.name}": ${retryErr}`);
              try { await ctx.runMutation(internal.systemLogger.log, {
                accountId: account._id, level: "error", source: "syncMetrics",
                message: `getCampaignsForAccount failed after retry: ${String(retryErr).slice(0, 180)}`,
              }); } catch { /* non-critical */ }
            }
          }

          const groupData = new Map<string, { adPlanId: string | null; dailyBudget: number }>();
          const campaignBatch: CampaignUpsertPayload[] = [];
          for (const c of vkCampaigns) {
            groupData.set(String(c.id), {
              adPlanId: c.ad_plan_id ? String(c.ad_plan_id) : null,
              dailyBudget: Number(c.budget_limit_day || "0"),
            });
            campaignBatch.push({
              vkCampaignId: String(c.id),
              adPlanId: c.ad_plan_id ? String(c.ad_plan_id) : undefined,
              name: c.name || `Кампания ${c.id}`,
              status: c.status,
              dailyLimit: Number(c.budget_limit_day || "0") || undefined,
              allLimit: Number(c.budget_limit || "0") || undefined,
            });
          }

          const adPlanBudgets = new Map<string, number>();
          try {
            const fetchedAdPlans = await ctx.runAction(api.vkApi.getMtAdPlans, { accessToken });
            for (const plan of fetchedAdPlans) {
              if (plan.budget_limit_day && plan.budget_limit_day > 0) {
                adPlanBudgets.set(String(plan.id), plan.budget_limit_day);
              }
              campaignBatch.push({
                vkCampaignId: String(plan.id),
                name: plan.name || `Кампания ${plan.id}`,
                status: plan.status,
                dailyLimit: plan.budget_limit_day && plan.budget_limit_day > 0 ? plan.budget_limit_day : undefined,
                allLimit: plan.budget_limit && plan.budget_limit > 0 ? plan.budget_limit : undefined,
              });
            }
          } catch (err) {
            console.warn(`[syncBatch] getMtAdPlans failed for "${account.name}": ${err}`);
          }

          return { groupData, adPlanBudgets, campaignBatch };
        })();

        // Build campaignType map
        const campaignTypeMap = new Map<string, string>();
        try {
          const typeMapArray = await ctx.runAction(
            internal.vkApi.getCampaignTypeMap, { accessToken }
          );
          for (const entry of typeMapArray) {
            campaignTypeMap.set(entry.adGroupId, entry.type);
          }
        } catch (err) {
          console.warn(`[syncBatch] getCampaignTypeMap failed for "${account.name}": ${err}`);
        }

        // Build adCampaignMap with cascade: group budget -> ad_plan budget
        const adCampaignMap: Array<{ adId: string; adGroupId: string; adPlanId: string | null; dailyBudget: number }> = [];
        for (const [adId, adGroupId] of bannerCampaignMap) {
          const data = groupData.get(adGroupId);
          let dailyBudget = data?.dailyBudget ?? 0;
          if (dailyBudget <= 0 && data?.adPlanId) {
            dailyBudget = adPlanBudgets.get(data.adPlanId) ?? 0;
          }
          adCampaignMap.push({
            adId, adGroupId,
            adPlanId: data?.adPlanId ?? null,
            dailyBudget,
          });
        }

        // Only log large campaign maps (debug outliers, not spam every account)
        if (adCampaignMap.length > 200) {
          console.log(`[syncBatch] Large campaign map: ${adCampaignMap.length} ads for "${account.name}"`);
        }

        // Auto-upsert campaigns (ad groups) + ad_plans — batched
        if (campaignBatch.length > 0) {
          try {
            const chunk = campaignUpsertChunkSize(campaignBatch.length);
            for (let i = 0; i < campaignBatch.length; i += chunk) {
              await ctx.runMutation(internal.adAccounts.upsertCampaignsBatch, {
                accountId: account._id,
                campaigns: campaignBatch.slice(i, i + chunk),
              });
            }
          } catch (err) {
            console.error(`[syncBatch] upsertCampaignsBatch failed for "${account.name}":`, err);
            try { await ctx.runMutation(internal.systemLogger.log, {
              accountId: account._id, level: "warn", source: "syncMetrics",
              message: `Auto-upsert campaigns batch failed: ${String(err).slice(0, 180)}`,
            }); } catch { /* non-critical */ }
          }
        }

        // Auto-upsert ads from lightweight getMtBanners data — batched
        if (adBatch.length > 0) {
          try {
            const chunk = adUpsertChunkSize(adBatch.length);
            for (let i = 0; i < adBatch.length; i += chunk) {
              await ctx.runMutation(internal.adAccounts.upsertAdsBatch, {
                accountId: account._id,
                ads: adBatch.slice(i, i + chunk),
              });
            }
          } catch (err) {
            console.error(`[syncBatch] upsertAdsBatch failed for "${account.name}":`, err);
            try { await ctx.runMutation(internal.systemLogger.log, {
              accountId: account._id, level: "warn", source: "syncMetrics",
              message: `Auto-upsert ads batch failed: ${String(err).slice(0, 180)}`,
            }); } catch { /* non-critical */ }
          }
        }

        // TODO(auto-link-cron): auto-link-video is temporarily disabled in primary
        // sync because banner.content triggers Convex V8 carry-over restarts.
        // Restore it as a separate low-frequency, per-account-sequential cron.

        if (!stats || stats.length === 0) {
          console.log(`[syncBatch] Empty stats for account ${account._id}, skipping`);
          await ctx.runMutation(internal.adAccounts.incrementEmptySyncs, { accountId: account._id });
          await ctx.runMutation(api.adAccounts.updateSyncTime, { accountId: account._id });
          return;
        }

        // Save metrics for each ad — batched
        const realtimeBatch: { adId: string; spent: number; leads: number; impressions: number; clicks: number }[] = [];
        const dailyBatch: { adId: string; campaignId?: string; date: string; impressions: number; clicks: number; spent: number; leads: number; vkResult?: number; campaignType?: string; formEvents?: number; reach?: number }[] = [];

        for (const item of stats) {
          const adId = String(item.id);
          for (const row of item.rows) {
            const base = row.base;
            const spent = parseFloat(base.spent || "0") || 0;
            const impressions = base.shows || 0;
            const clicks = base.clicks || 0;
            const baseGoals = Number(base.goals) || 0;
            const vkData = base.vk;
            const vkResult = vkData ? (Number(vkData.result) || 0) : 0;
            const vkGoals = vkData ? (Number(vkData.goals) || 0) : 0;
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
            const leadAdsCount = leadCounts[adId] || 0;
            const leads = Math.max(baseGoals, vkResult, vkGoals, eventsGoals, leadAdsCount);

            console.log(
              `[syncBatch] Ad ${adId}: clicks=${clicks}, base.goals=${baseGoals}, vk.result=${vkResult}, vk.goals=${vkGoals}, events=${eventsGoals}, leadAds=${leadAdsCount}, leads=${leads}`
            );

            realtimeBatch.push({ adId, spent, leads, impressions, clicks });

            const adGroupId = bannerCampaignMap.get(adId);
            dailyBatch.push({
              adId, date: row.date, impressions, clicks, spent, leads,
              campaignId: adGroupId,
              vkResult: vkResult > 0 ? vkResult : undefined,
              campaignType: adGroupId ? campaignTypeMap.get(adGroupId) : undefined,
              formEvents: eventsGoals > 0 ? eventsGoals : undefined,
              reach: base.reach,
            });
          }
        }

        // Flush metrics batches
        if (realtimeBatch.length > 0) {
          const chunk = realtimeMetricsChunkSize(realtimeBatch.length);
          for (let i = 0; i < realtimeBatch.length; i += chunk) {
            await ctx.runMutation(internal.metrics.saveRealtimeBatch, {
              accountId: account._id,
              items: realtimeBatch.slice(i, i + chunk),
            });
          }
        }
        if (dailyBatch.length > 0) {
          const chunk = dailyMetricsChunkSize(dailyBatch.length);
          for (let i = 0; i < dailyBatch.length; i += chunk) {
            await ctx.runMutation(internal.metrics.saveDailyBatch, {
              accountId: account._id,
              items: dailyBatch.slice(i, i + chunk),
            });
          }
        }

        // Collect video stats for linked creatives
        try {
          const linkedVideos = await ctx.runQuery(internal.videos.listLinkedVideos, {});
          const accountVideos = linkedVideos.filter((vid: Doc<"videos">) => vid.accountId === account._id);
          if (accountVideos.length > 0) {
            const videoAdIds = accountVideos
              .map((vid: Doc<"videos">) => vid.vkAdId)
              .filter(Boolean)
              .join(",");
            if (videoAdIds) {
              const videoStats = await ctx.runAction(api.vkApi.getMtVideoStatistics, {
                accessToken, dateFrom: date, dateTo: date, bannerIds: videoAdIds,
              });
              for (const item of videoStats) {
                const adId = String(item.id);
                const linkedVideo = accountVideos.find((vid: Doc<"videos">) => vid.vkAdId === adId);
                for (const row of item.rows) {
                  const base = row.base;
                  const vid: MtVideoStats = row.video || {};
                  await ctx.runMutation(internal.creativeAnalytics.saveCreativeStats, {
                    accountId: account._id, videoId: linkedVideo?._id,
                    adId, date: row.date,
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
                `[syncBatch] Account ${account._id}: ${accountVideos.length} video creatives stats synced`
              );
            }
          }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error(`[syncBatch] Error fetching video stats for account ${account._id}:`, errMsg);
          try { await ctx.runMutation(internal.systemLogger.log, {
            accountId: account._id, level: "warn", source: "syncMetrics",
            message: `Video stats fetch failed: ${errMsg.slice(0, 180)}`,
          }); } catch { /* non-critical */ }
        }

        // Update sync time and clear any previous error
        await ctx.runMutation(api.adAccounts.updateSyncTime, { accountId: account._id });
        if (account.lastError) {
          await ctx.runMutation(api.adAccounts.updateStatus, {
            accountId: account._id, status: "active",
          });
        }
        console.log(`[syncBatch] Account ${account._id}: ${stats.length} ads synced`);

        // Run rules for this account
        try {
          await ctx.runAction(internal.ruleEngine.checkRulesForAccount, {
            accountId: account._id,
            adCampaignMap: adCampaignMap.length > 0 ? adCampaignMap : undefined,
          });
        } catch (err) {
          console.error(`[syncBatch] checkRulesForAccount failed for "${account.name}":`, err);
          try { await ctx.runMutation(internal.systemLogger.log, {
            accountId: account._id, level: "error", source: "syncMetrics",
            message: `checkRulesForAccount failed: ${String(err).slice(0, 180)}`,
          }); } catch { /* non-critical */ }
        }
      })(), BATCH_ACCOUNT_TIMEOUT_MS, `syncBatch account ${accountId}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error(`[syncBatch] Error syncing account ${account._id}: ${msg}`);

      if (isTokenExpiredError(msg)) {
        // Try recovery — handleTokenExpired returns boolean (never throws)
        let recovered = false;
        try {
          recovered = await ctx.runAction(internal.tokenRecovery.handleTokenExpired, {
            accountId: account._id,
          });
        } catch (handleErr) {
          console.log(`[syncBatch] handleTokenExpired for ${account._id} threw: ${handleErr}`);
        }
        if (!recovered) {
          await ctx.runMutation(api.adAccounts.updateStatus, {
            accountId: account._id, status: "error",
            lastError: `Sync failed: ${msg}`,
          });
        }
        await ctx.runMutation(internal.adAccounts.clearSyncErrors, {
          accountId: account._id,
        });
        // Recovered → warn (no Telegram), failed → error (sends Telegram)
        try { await ctx.runMutation(internal.systemLogger.log, {
          accountId: account._id,
          level: recovered ? "warn" : "error",
          source: "syncMetrics",
          message: recovered
            ? `Token expired, auto-recovered: ${msg.slice(0, 150)}`
            : `Sync failed (recovery failed): ${msg.slice(0, 150)}`,
        }); } catch { /* non-critical */ }
      } else if (isPermanentError(msg)) {
        await ctx.runMutation(api.adAccounts.updateStatus, {
          accountId: account._id, status: "error",
          lastError: `Sync failed: ${msg}`,
        });
        try { await ctx.runMutation(internal.systemLogger.log, {
          accountId: account._id, level: "error", source: "syncMetrics",
          message: `Sync failed (permanent): ${msg.slice(0, 180)}`,
        }); } catch { /* non-critical */ }
      } else {
        const consecutive = (account.consecutiveSyncErrors ?? 0) + 1;
        await ctx.runMutation(internal.adAccounts.incrementSyncErrors, {
          accountId: account._id, error: msg,
        });
        if (consecutive >= TRANSIENT_ERROR_THRESHOLD) {
          console.warn(`[syncBatch] "${account.name}" ${consecutive} consecutive transient errors -- marking as error`);
          await ctx.runMutation(api.adAccounts.updateStatus, {
            accountId: account._id, status: "error",
            lastError: `Sync failed (${consecutive}x): ${msg}`,
          });
          try { await ctx.runMutation(internal.systemLogger.log, {
            accountId: account._id, level: "error", source: "syncMetrics",
            message: `Sync failed (${consecutive}x transient): ${msg.slice(0, 180)}`,
          }); } catch { /* non-critical */ }
        } else {
          console.log(`[syncBatch] "${account.name}" transient error ${consecutive}/${TRANSIENT_ERROR_THRESHOLD} -- will retry next cycle`);
        }
      }
    }
}

/**
 * Batch worker: processes an array of accounts sequentially.
 * Each account uses syncSingleAccount (same logic as former syncOneAccount).
 * Worker-level timeout ensures we stay within Convex 10-min action limit.
 */
export const syncBatchWorker = internalAction({
  args: {
    accountIds: v.array(v.id("adAccounts")),
    workerIndex: v.number(),
  },
  handler: async (ctx, args) => {
    const workerStart = Date.now();
    let synced = 0;
    let errors = 0;

    for (const accountId of args.accountIds) {
      // Worker-level timeout check: stop if approaching 9 min
      if (Date.now() - workerStart > WORKER_TIMEOUT_MS) {
        console.log(`[syncBatch#${args.workerIndex}] Worker timeout reached after ${synced} accounts, ${args.accountIds.length - synced} remaining`);
        break;
      }

      try {
        await syncSingleAccount(ctx, accountId);
        synced++;
      } catch (err) {
        errors++;
        console.error(`[syncBatch#${args.workerIndex}] Account ${accountId} failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    console.log(`[syncBatch#${args.workerIndex}] Done: ${synced} synced, ${errors} errors out of ${args.accountIds.length}`);
  },
});

/**
 * Batch dispatcher for metrics sync. Replaces fan-out syncAll.
 * Runs every 5 min via cron. Dispatches WORKER_COUNT batch workers.
 */
export const syncDispatch = internalAction({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(internal.syncMetrics.upsertCronHeartbeat, {
      name: "syncDispatch", status: "running",
    });

    let syncError: string | undefined;
    try {
      // Health check: count stale accounts
      const allBasic = await ctx.runQuery(internal.syncMetrics.listAllActiveAccountsBasic);
      const now = Date.now();
      const staleCount = allBasic.filter(
        (a) => !a.lastSyncAt || now - a.lastSyncAt > 20 * 60_000
      ).length;
      const totalCount = allBasic.length;

      // Alert if >20% stale
      if (totalCount > 0 && staleCount > totalCount * 0.2) {
        const canAlert = await ctx.runQuery(internal.syncMetrics.shouldSendCronAlert, {
          cronName: "syncDispatch", cooldownMs: ALERT_COOLDOWN_MS,
        });
        if (canAlert) {
          try {
            await ctx.runAction(internal.telegram.sendMessage, {
              chatId: SYNC_ADMIN_CHAT_ID,
              text: `⚠️ <b>Sync</b>: ${staleCount}/${totalCount} аккаунтов не синхронизированы >20 мин`,
            });
            await ctx.runMutation(internal.syncMetrics.markCronAlertSent, {
              cronName: "syncDispatch",
            });
          } catch { /* non-critical */ }
        }
      }

      // Get accounts to sync (filtered, sorted, no batch limit)
      const accounts = await ctx.runQuery(internal.syncMetrics.listSyncableAccounts);
      if (accounts.length === 0) {
        console.log("[syncDispatch] No accounts to sync");
        return;
      }

      // Dispatch all workers
      const accountIds = accounts.map((a) => a._id);
      await ctx.runMutation(internal.syncMetrics.dispatchSyncBatches, { accountIds });
      console.log(`[syncDispatch] Dispatched ${Math.min(WORKER_COUNT, accountIds.length)} batch workers for ${accountIds.length} accounts`);

      // Poll AI banner moderation (separate from per-account sync)
      try {
        await ctx.runAction(internal.syncMetrics.pollAiBannerModeration, {});
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error("[syncDispatch] Error polling AI banner moderation:", errMsg);
        try { await ctx.runMutation(internal.systemLogger.log, {
          level: "warn", source: "syncMetrics",
          message: `AI banner moderation poll failed: ${errMsg.slice(0, 180)}`,
        }); } catch { /* non-critical */ }
      }

    } catch (err) {
      syncError = err instanceof Error ? err.message : "Unknown error";
      console.error("[syncDispatch] Fatal error:", syncError);
      try { await ctx.runMutation(internal.systemLogger.log, {
        level: "error", source: "syncMetrics",
        message: `Fatal syncDispatch error: ${syncError.slice(0, 180)}`,
      }); } catch { /* non-critical */ }
    } finally {
      await ctx.runMutation(internal.syncMetrics.upsertCronHeartbeat, {
        name: "syncDispatch",
        status: syncError ? "failed" : "completed",
        error: syncError,
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

        // Fetch banners from myTarget for this campaign — request moderation_reason
        // (not in the lightweight default, but cheap to add for this small per-campaign call).
        const mtBanners = await ctx.runAction(api.vkApi.getMtBanners, {
          accessToken,
          campaignId: campaign.vkCampaignId!,
          fields: "id,moderation_status,moderation_reason",
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
              moderationReason: newStatus === "banned" ? (mtBanner as unknown as { moderation_reason?: string }).moderation_reason || "" : undefined,
            });

            // Notify on status changes
            if (newStatus === "banned" || newStatus === "allowed") {
              const user = await ctx.runQuery(internal.users.getById, { userId: campaign.userId });
              if (user?.telegramChatId) {
                const emoji = newStatus === "banned" ? "🚫" : "✅";
                const statusText = newStatus === "banned" ? "отклонён" : "одобрен";
                const moderationReason = (mtBanner as unknown as { moderation_reason?: string }).moderation_reason;
                const message = `${emoji} <b>AI Кабинет</b>\n\nБаннер "${ourBanner.title}" — ${statusText}\nКампания: ${campaign.name}${
                  newStatus === "banned" && moderationReason
                    ? `\nПричина: ${moderationReason}`
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
    const uzRulesSummary = uzRules.map((r) => {
      // uz_budget_manage always has object conditions with budget fields
      const cond = (Array.isArray(r.conditions) ? r.conditions[0] : r.conditions) as Record<string, unknown>;
      return {
      id: r._id,
      name: r.name,
      userId: r.userId,
      initialBudget: cond?.initialBudget as number | undefined,
      budgetStep: cond?.budgetStep as number | undefined,
      maxDailyBudget: cond?.maxDailyBudget as number | undefined,
      targetAccounts: r.targetAccountIds.length,
      targetCampaigns: (r.targetCampaignIds ?? []).length,
      triggerCount: r.triggerCount ?? 0,
      lastTriggeredAt: r.lastTriggeredAt
        ? new Date(r.lastTriggeredAt).toISOString()
        : null,
    };
    });

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
    const rulesInfo = rules.map((r) => {
      const cond = Array.isArray(r.conditions) ? r.conditions[0] : r.conditions;
      return {
      id: r._id,
      name: r.name,
      type: r.type,
      userId: r.userId,
      stopAd: r.actions.stopAd,
      notify: r.actions.notify,
      value: cond?.value,
      timeWindow: cond?.timeWindow,
      isActive: r.isActive,
    };
    });

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

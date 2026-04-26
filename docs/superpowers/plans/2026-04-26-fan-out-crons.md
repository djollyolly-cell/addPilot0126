# Fan-Out Architecture for Heavy Crons — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace sequential cron loops (syncAll, checkUzBudgetRules, proactiveTokenRefresh) with fan-out pattern: lightweight dispatcher + isolated per-account workers scheduled via `ctx.scheduler.runAfter(0, ...)`.

**Architecture:** Each heavy cron splits into dispatcher (internalAction, runs in seconds) + batchDispatch (internalMutation with scheduler access) + worker (internalAction, one unit of work). Dispatchers also run health-check alerts with 30-min dedup. Convex concurrency raised to 32 parallel actions.

**Tech Stack:** Convex (internalAction, internalMutation, scheduler), Docker env var for concurrency.

---

## File Structure

| File | Changes |
|------|---------|
| `convex/schema.ts` | Add `lastAlertSentAt` optional field to `cronHeartbeats` |
| `convex/syncMetrics.ts` | Add `syncOneAccount`, `dispatchSyncBatch`, `syncDispatch`, `listSyncableAccounts`. Modify `listActiveAccounts` (remove BATCH_SIZE). Keep old `syncAll`. |
| `convex/ruleEngine.ts` | Add `uzBudgetOneAccount`, `dispatchUzBatch`, `uzBudgetDispatch`. Keep old `checkUzBudgetRules`. |
| `convex/auth.ts` | Add `tokenRefreshOne`, `dispatchTokenBatch`, `tokenRefreshDispatch`. Remove `scheduleProactiveRetry`. Keep old `proactiveTokenRefresh`. |
| `convex/crons.ts` | Swap 3 entry points, change token refresh interval 4h -> 2h |
| `convex/healthCheck.ts` | Thresholds: sync 10min -> 15min, stale 30min -> 20min |
| `docker/docker-compose.convex-selfhosted.yml` | Add `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=32` |

---

### Task 1: Schema + Alert Helpers

**Files:**
- Modify: `convex/schema.ts:798-804`
- Modify: `convex/syncMetrics.ts:650-691` (add alert helpers near heartbeat code)

- [ ] **Step 1: Add `lastAlertSentAt` to cronHeartbeats schema**

In `convex/schema.ts`, find the `cronHeartbeats` table definition (line 798) and add the optional field:

```typescript
  cronHeartbeats: defineTable({
    name: v.string(),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    status: v.union(v.literal("running"), v.literal("completed"), v.literal("failed")),
    error: v.optional(v.string()),
    lastAlertSentAt: v.optional(v.number()),
  }).index("by_name", ["name"]),
```

- [ ] **Step 2: Add alert dedup helpers to syncMetrics.ts**

Add these after `upsertCronHeartbeat` (after line 691) in `convex/syncMetrics.ts`:

```typescript
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
```

- [ ] **Step 3: Add `listSyncableAccounts` query (no BATCH_SIZE)**

Add after `listActiveAccounts` in `convex/syncMetrics.ts` (after line 648):

```typescript
/** All active/error accounts — no batch limit, for fan-out dispatcher. */
export const listSyncableAccounts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("adAccounts").collect();
    const active = accounts.filter((a) => a.status === "active" || a.status === "error");
    const now = Date.now();

    return active
      .filter((a) => !a.lastSyncAt || (now - a.lastSyncAt) > SKIP_IF_SYNCED_WITHIN_MS)
      .sort((a, b) => (a.lastSyncAt || 0) - (b.lastSyncAt || 0));
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
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: Clean output, no errors.

- [ ] **Step 5: Commit**

```bash
git add convex/schema.ts convex/syncMetrics.ts
git commit -m "feat(fan-out): add cronHeartbeats.lastAlertSentAt, alert helpers, listSyncableAccounts"
```

---

### Task 2: syncMetrics Fan-Out

**Files:**
- Modify: `convex/syncMetrics.ts` — add `syncOneAccount`, `dispatchSyncBatch`, `syncDispatch`

- [ ] **Step 1: Add `dispatchSyncBatch` mutation**

Add after the alert helpers in `convex/syncMetrics.ts`:

```typescript
const ALERT_COOLDOWN_MS = 30 * 60_000; // 30 min between same alert
const ADMIN_CHAT_ID = "325307765";

/** Schedule syncOneAccount workers for each account. Must be mutation for ctx.scheduler. */
export const dispatchSyncBatch = internalMutation({
  args: { accountIds: v.array(v.id("adAccounts")) },
  handler: async (ctx, args) => {
    for (const accountId of args.accountIds) {
      await ctx.scheduler.runAfter(0, internal.syncMetrics.syncOneAccount, { accountId });
    }
  },
});
```

- [ ] **Step 2: Add `syncOneAccount` worker**

This is the extracted per-account logic from `syncAll` lines 64-586. Add as a new `internalAction` in `convex/syncMetrics.ts`:

```typescript
/**
 * Sync metrics for ONE ad account. Scheduled by syncDispatch.
 * Contains the full per-account logic from the former syncAll loop.
 */
export const syncOneAccount = internalAction({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    // Load account
    const account = await ctx.runQuery(internal.adAccounts.getById, { accountId: args.accountId });
    if (!account) {
      console.log(`[syncOne] Account ${args.accountId} not found, skipping`);
      return;
    }
    if (account.status !== "active" && account.status !== "error") {
      return;
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
              console.log(`[syncOne] Auto-recovery: "${account.name}" token alive, restoring to active`);
              await ctx.runMutation(api.adAccounts.updateStatus, {
                accountId: account._id,
                status: "active",
              });
              await ctx.runMutation(internal.adAccounts.clearSyncErrors, {
                accountId: account._id,
              });
            } else {
              console.log(`[syncOne] "${account.name}" in error, token dead -- skipping`);
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

        // Fetch banners (only active/blocked)
        const banners = await ctx.runAction(api.vkApi.getMtBanners, {
          accessToken, accountId: account._id,
        });
        const bannerIds = banners.map((b: { id: number }) => String(b.id)).join(",");

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

        // Build bannerId -> campaignId map
        const bannerCampaignMap = new Map<string, string>();
        for (const b of banners) {
          bannerCampaignMap.set(String(b.id), String(b.campaign_id));
        }

        // Fetch campaigns from VK API (no circuit breaker — each worker is independent)
        let vkCampaigns: MtCampaign[] = [];
        try {
          vkCampaigns = await ctx.runAction(
            internal.vkApi.getCampaignsForAccount, { accessToken }
          );
        } catch (err) {
          console.warn(`[syncOne] getCampaignsForAccount failed for "${account.name}": ${err}`);
          // Retry once
          try {
            vkCampaigns = await ctx.runAction(
              internal.vkApi.getCampaignsForAccount, { accessToken }
            );
          } catch (retryErr) {
            console.error(`[syncOne] getCampaignsForAccount retry failed for "${account.name}": ${retryErr}`);
            try { await ctx.runMutation(internal.systemLogger.log, {
              accountId: account._id, level: "error", source: "syncMetrics",
              message: `getCampaignsForAccount failed after retry: ${String(retryErr).slice(0, 180)}`,
            }); } catch { /* non-critical */ }
          }
        }

        // Build campaign data map: ad_group_id -> { adPlanId, dailyBudget }
        const groupData = new Map<string, { adPlanId: string | null; dailyBudget: number }>();
        for (const c of vkCampaigns) {
          groupData.set(String(c.id), {
            adPlanId: c.ad_plan_id ? String(c.ad_plan_id) : null,
            dailyBudget: Number(c.budget_limit_day || "0"),
          });
        }

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
          console.warn(`[syncOne] getCampaignTypeMap failed for "${account.name}": ${err}`);
        }

        // Fetch ad_plan budgets for cascade fallback
        const adPlanBudgets = new Map<string, number>();
        let fetchedAdPlans: { id: number; name: string; status: string; budget_limit_day: number | null; budget_limit: number | null }[] = [];
        try {
          fetchedAdPlans = await ctx.runAction(api.vkApi.getMtAdPlans, { accessToken });
          for (const plan of fetchedAdPlans) {
            if (plan.budget_limit_day && plan.budget_limit_day > 0) {
              adPlanBudgets.set(String(plan.id), plan.budget_limit_day);
            }
          }
        } catch (err) {
          console.warn(`[syncOne] getMtAdPlans failed for "${account.name}": ${err}`);
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

        if (adCampaignMap.length > 0) {
          console.log(`[syncOne] Live campaign map: ${adCampaignMap.length} ads, ${vkCampaigns.length} campaigns for "${account.name}"`);
        }

        // Auto-upsert campaigns (ad groups)
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
            console.error(`[syncOne] upsertCampaigns failed for "${account.name}":`, err);
            try { await ctx.runMutation(internal.systemLogger.log, {
              accountId: account._id, level: "warn", source: "syncMetrics",
              message: `Auto-upsert campaigns failed: ${String(err).slice(0, 180)}`,
            }); } catch { /* non-critical */ }
          }
        }

        // Auto-upsert ad_plans
        if (fetchedAdPlans.length > 0) {
          try {
            for (const plan of fetchedAdPlans) {
              await ctx.runMutation(api.adAccounts.upsertCampaign, {
                accountId: account._id,
                vkCampaignId: String(plan.id),
                name: plan.name || `Кампания ${plan.id}`,
                status: plan.status,
                dailyLimit: plan.budget_limit_day && plan.budget_limit_day > 0 ? plan.budget_limit_day : undefined,
                allLimit: plan.budget_limit && plan.budget_limit > 0 ? plan.budget_limit : undefined,
              });
            }
          } catch (err) {
            console.warn(`[syncOne] upsert ad_plans failed for "${account.name}": ${err}`);
          }
        }

        // Auto-upsert ads from getMtBanners data
        try {
          for (const banner of banners) {
            const campaignVkId = String(banner.campaign_id);
            const campaign = await ctx.runQuery(api.adAccounts.getCampaignByVkId, {
              accountId: account._id, vkCampaignId: campaignVkId,
            });
            if (campaign) {
              const bannerName = banner.textblocks?.title?.text || `Баннер ${banner.id}`;
              await ctx.runMutation(api.adAccounts.upsertAd, {
                accountId: account._id, campaignId: campaign._id,
                vkAdId: String(banner.id), name: bannerName,
                status: banner.status, approved: banner.moderation_status,
              });
            }
          }
        } catch (err) {
          console.error(`[syncOne] upsertAds failed for "${account.name}":`, err);
          try { await ctx.runMutation(internal.systemLogger.log, {
            accountId: account._id, level: "warn", source: "syncMetrics",
            message: `Auto-upsert ads failed: ${String(err).slice(0, 180)}`,
          }); } catch { /* non-critical */ }
        }

        // Auto-link videos to banners
        try {
          const bannerVideoMap: { bannerId: string; videoMediaId: string }[] = [];
          for (const banner of banners) {
            if (!banner.content) continue;
            for (const slotKey of Object.keys(banner.content)) {
              const slot = banner.content[slotKey];
              const isVideo =
                slot.type === "video" ||
                (slot.variants &&
                  Object.values(slot.variants).some(
                    (variant) => variant.media_type === "video"
                  ));
              if (isVideo && slot.id) {
                bannerVideoMap.push({
                  bannerId: String(banner.id),
                  videoMediaId: String(slot.id),
                });
                break;
              }
            }
          }
          if (bannerVideoMap.length > 0) {
            await ctx.runMutation(internal.videos.autoLinkVideos, {
              accountId: account._id, bannerVideoMap,
            });
          }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error(`[syncOne] Auto-link error for account ${account._id}:`, errMsg);
          try { await ctx.runMutation(internal.systemLogger.log, {
            accountId: account._id, level: "warn", source: "syncMetrics",
            message: `Auto-link videos failed: ${errMsg.slice(0, 180)}`,
          }); } catch { /* non-critical */ }
        }

        if (!stats || stats.length === 0) {
          console.log(`[syncOne] Empty stats for account ${account._id}, skipping`);
          return;
        }

        // Save metrics for each ad
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
              `[syncOne] Ad ${adId}: clicks=${clicks}, base.goals=${baseGoals}, vk.result=${vkResult}, vk.goals=${vkGoals}, events=${eventsGoals}, leadAds=${leadAdsCount}, leads=${leads}`
            );

            await ctx.runMutation(internal.metrics.saveRealtime, {
              accountId: account._id, adId, spent, leads, impressions, clicks,
            });

            const adGroupId = bannerCampaignMap.get(adId);
            await ctx.runMutation(internal.metrics.saveDaily, {
              accountId: account._id, adId,
              campaignId: adGroupId, date: row.date,
              impressions, clicks, spent, leads,
              vkResult: vkResult > 0 ? vkResult : undefined,
              campaignType: adGroupId ? campaignTypeMap.get(adGroupId) : undefined,
              formEvents: eventsGoals > 0 ? eventsGoals : undefined,
              reach: base.reach,
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
                accessToken, dateFrom: date, dateTo: date, bannerIds: videoAdIds,
              });
              for (const item of videoStats) {
                const adId = String(item.id);
                const linkedVideo = accountVideos.find((vid) => vid.vkAdId === adId);
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
                `[syncOne] Account ${account._id}: ${accountVideos.length} video creatives stats synced`
              );
            }
          }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error(`[syncOne] Error fetching video stats for account ${account._id}:`, errMsg);
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
        console.log(`[syncOne] Account ${account._id}: ${stats.length} ads synced`);

        // Run rules for this account
        try {
          await ctx.runAction(internal.ruleEngine.checkRulesForAccount, {
            accountId: account._id,
            adCampaignMap: adCampaignMap.length > 0 ? adCampaignMap : undefined,
          });
        } catch (err) {
          console.error(`[syncOne] checkRulesForAccount failed for "${account.name}":`, err);
          try { await ctx.runMutation(internal.systemLogger.log, {
            accountId: account._id, level: "error", source: "syncMetrics",
            message: `checkRulesForAccount failed: ${String(err).slice(0, 180)}`,
          }); } catch { /* non-critical */ }
        }
      })(), ACCOUNT_TIMEOUT_MS, `syncOne account ${account._id}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error(`[syncOne] Error syncing account ${account._id}: ${msg}`);

      try { await ctx.runMutation(internal.systemLogger.log, {
        accountId: account._id, level: "error", source: "syncMetrics",
        message: `Sync failed: ${msg.slice(0, 180)}`,
      }); } catch { /* non-critical */ }

      if (msg.includes("TOKEN_EXPIRED")) {
        try {
          await ctx.runAction(internal.tokenRecovery.handleTokenExpired, {
            accountId: account._id,
          });
        } catch (handleErr) {
          await ctx.runMutation(api.adAccounts.updateStatus, {
            accountId: account._id, status: "error",
            lastError: `Sync failed: ${msg}`,
          });
          console.log(`[syncOne] handleTokenExpired for ${account._id} failed: ${handleErr}`);
        }
        await ctx.runMutation(internal.adAccounts.clearSyncErrors, {
          accountId: account._id,
        });
      } else if (isPermanentError(msg)) {
        await ctx.runMutation(api.adAccounts.updateStatus, {
          accountId: account._id, status: "error",
          lastError: `Sync failed: ${msg}`,
        });
      } else {
        const consecutive = (account.consecutiveSyncErrors ?? 0) + 1;
        await ctx.runMutation(internal.adAccounts.incrementSyncErrors, {
          accountId: account._id, error: msg,
        });
        if (consecutive >= TRANSIENT_ERROR_THRESHOLD) {
          console.warn(`[syncOne] "${account.name}" ${consecutive} consecutive transient errors -- marking as error`);
          await ctx.runMutation(api.adAccounts.updateStatus, {
            accountId: account._id, status: "error",
            lastError: `Sync failed (${consecutive}x): ${msg}`,
          });
        } else {
          console.log(`[syncOne] "${account.name}" transient error ${consecutive}/${TRANSIENT_ERROR_THRESHOLD} -- will retry next cycle`);
        }
      }
    }
  },
});
```

**Important:** This function needs `internal.adAccounts.getById` internalQuery. Check if it exists already. If not, add it to `convex/adAccounts.ts`:

```typescript
export const getById = internalQuery({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.accountId);
  },
});
```

- [ ] **Step 3: Add `syncDispatch` dispatcher**

Add in `convex/syncMetrics.ts`:

```typescript
/**
 * Fan-out dispatcher for metrics sync. Replaces sequential syncAll.
 * Runs every 5 min via cron. Dispatches syncOneAccount per account.
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
        (a) => !a.lastSyncAt || now - a.lastSyncAt > 15 * 60_000
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
              chatId: ADMIN_CHAT_ID,
              text: `⚠️ <b>Sync</b>: ${staleCount}/${totalCount} аккаунтов не синхронизированы >15 мин`,
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
      await ctx.runMutation(internal.syncMetrics.dispatchSyncBatch, { accountIds });
      console.log(`[syncDispatch] Dispatched ${accountIds.length} sync workers`);

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
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: Clean output. Fix any missing imports or type errors.

- [ ] **Step 5: Commit**

```bash
git add convex/syncMetrics.ts convex/adAccounts.ts
git commit -m "feat(fan-out): add syncOneAccount worker + syncDispatch dispatcher"
```

---

### Task 3: ruleEngine Fan-Out (UZ Budget)

**Files:**
- Modify: `convex/ruleEngine.ts` — add `uzBudgetOneAccount`, `dispatchUzBatch`, `uzBudgetDispatch`

- [ ] **Step 1: Add `dispatchUzBatch` mutation**

Add near the end of `convex/ruleEngine.ts`, after `checkUzBudgetRules`:

```typescript
const ALERT_COOLDOWN_MS = 30 * 60_000;
const UZ_ADMIN_CHAT_ID = "325307765";

/** Schedule uzBudgetOneAccount workers. Must be mutation for ctx.scheduler. */
export const dispatchUzBatch = internalMutation({
  args: { accountIds: v.array(v.id("adAccounts")) },
  handler: async (ctx, args) => {
    for (const accountId of args.accountIds) {
      await ctx.scheduler.runAfter(0, internal.ruleEngine.uzBudgetOneAccount, { accountId });
    }
  },
});
```

- [ ] **Step 2: Add `uzBudgetOneAccount` worker**

This is the per-account logic extracted from `checkUzBudgetRules` lines 2522-2839:

```typescript
/**
 * Process UZ budget rules for ONE account. Scheduled by uzBudgetDispatch.
 */
export const uzBudgetOneAccount = internalAction({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    // Re-fetch UZ rules for this account (lightweight query)
    const allUzRules = await ctx.runQuery(internal.ruleEngine.getActiveUzRules);
    const rulesByAccount = groupRulesByAccount(allUzRules as UzRule[]);
    const accountRules = rulesByAccount.get(args.accountId as string);
    if (!accountRules || accountRules.length === 0) return;

    let totalActions = 0;
    const skipped = { blocked: 0, noBudget: 0, delivering: 0, dedup: 0, maxReached: 0, tokenErr: 0 };

    try {
      await withTimeout((async () => {
        // 1. Get token ONCE per account
        let accessToken: string;
        try {
          accessToken = await ctx.runAction(
            internal.auth.getValidTokenForAccount,
            { accountId: args.accountId }
          );
        } catch (tokenErr) {
          const tokenMsg = tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
          console.error(`[uz_budget] Cannot get token for account ${args.accountId}: ${tokenMsg}`);
          if (tokenMsg.includes("TOKEN_EXPIRED")) {
            try {
              await ctx.runAction(internal.tokenRecovery.handleTokenExpired, {
                accountId: args.accountId,
              });
            } catch (handleErr) {
              console.log(`[uz_budget] handleTokenExpired for ${args.accountId} failed: ${handleErr}`);
            }
          }
          skipped.tokenErr++;
          return;
        }

        // 2. Get campaigns ONCE per account
        let campaigns: VkCampaign[] = [];
        try {
          campaigns = await ctx.runAction(
            internal.vkApi.getCampaignsForAccount, { accessToken }
          ) as VkCampaign[];
        } catch (apiErr) {
          console.error(`[uz_budget] Failed to fetch campaigns for account ${args.accountId}:`, apiErr);
          return;
        }

        // 3. Collect all real campaign IDs that match any rule's targets
        const allMatchedCampaignIds = new Set<string>();
        for (const rule of accountRules) {
          const matched = filterCampaignsForRule(campaigns, rule);
          for (const c of matched) allMatchedCampaignIds.add(String(c.id));
        }

        // 4. Fetch spent for ALL matched campaigns in one batch API call
        const eligibleIds: string[] = [];
        for (const cid of allMatchedCampaignIds) {
          const camp = campaigns.find((c) => String(c.id) === cid);
          if (!camp) continue;
          if (Number(camp.budget_limit_day || "0") <= 0) continue;
          if (camp.status === "deleted") continue;
          eligibleIds.push(cid);
        }

        const spentCache = new Map<string, number>();
        if (eligibleIds.length > 0) {
          try {
            const batchResult = await ctx.runAction(
              internal.vkApi.getCampaignsSpentTodayBatch,
              { accessToken, campaignIds: eligibleIds }
            ) as Record<string, number>;
            for (const [cid, spent] of Object.entries(batchResult)) {
              spentCache.set(cid, spent);
            }
          } catch (err) {
            console.error(`[uz_budget] Batch spent fetch failed for account ${args.accountId}:`, err);
          }
        }

        // 5. Evaluate each rule using cached data
        // (This is the exact same logic as checkUzBudgetRules lines 2597-2833)
        for (const rule of accountRules) {
          try {
            const { initialBudget, budgetStep, maxDailyBudget } = rule.conditions;
            if (!initialBudget || !budgetStep) continue;

            const ruleCampaigns = filterCampaignsForRule(campaigns, rule);

            for (const campaign of ruleCampaigns) {
              const dailyLimitRubles = Number(campaign.budget_limit_day || "0");
              if (dailyLimitRubles <= 0) { skipped.noBudget++; continue; }
              if (campaign.status === "deleted") { skipped.blocked++; continue; }

              const campaignIdStr = String(campaign.id);
              const spentToday = spentCache.get(campaignIdStr);

              // Cascade unblock for blocked campaigns
              if (campaign.status === "blocked") {
                if (spentToday !== undefined) {
                  if (spentToday < dailyLimitRubles) {
                    skipped.blocked++;
                    continue;
                  }
                } else {
                  const lastLog = await ctx.runQuery(
                    internal.ruleEngine.getLastBudgetLogForCampaign,
                    { ruleId: rule._id, campaignId: campaignIdStr }
                  );
                  if (!lastLog || lastLog.newBudget === undefined) {
                    skipped.blocked++;
                    continue;
                  }
                  if (dailyLimitRubles !== lastLog.newBudget) {
                    skipped.blocked++;
                    continue;
                  }
                }
                const spent = spentToday ?? dailyLimitRubles;

                const recentUnblock = await ctx.runQuery(
                  internal.ruleEngine.hasRecentBudgetIncrease,
                  { ruleId: rule._id, campaignId: campaignIdStr, withinMs: 5 * 60 * 1000, currentSpent: spentToday ?? 0, currentBudget: dailyLimitRubles }
                );
                if (recentUnblock) { skipped.dedup++; continue; }

                try {
                  const cappedBudget = calculateNewBudget(dailyLimitRubles, spent, budgetStep, maxDailyBudget);
                  await ctx.runAction(internal.vkApi.setCampaignBudget, {
                    accessToken, campaignId: campaign.id, newLimitRubles: cappedBudget,
                  });
                  const stoppedBannerIds = await ctx.runQuery(
                    internal.ruleEngine.getStoppedBannerIdsForAccount,
                    { accountId: args.accountId }
                  );
                  await ctx.runAction(internal.vkApi.resumeCampaign, {
                    accessToken, campaignId: campaign.id,
                    excludeBannerIds: stoppedBannerIds,
                  });
                  await ctx.runMutation(internal.ruleEngine.logBudgetAction, {
                    userId: rule.userId, ruleId: rule._id,
                    accountId: args.accountId,
                    campaignId: campaignIdStr, campaignName: campaign.name,
                    actionType: "budget_increased" as const,
                    oldBudget: dailyLimitRubles, newBudget: cappedBudget,
                    step: cappedBudget - dailyLimitRubles, spentToday: spent,
                  });
                  console.log(`[uz_budget] Cascade unblock: ${campaign.name} (${campaignIdStr}) budget=${cappedBudget} spent=${spent} excludedBanners=${stoppedBannerIds.length}`);
                  totalActions++;
                } catch (err) {
                  console.error(`[uz_budget] Cascade unblock failed for ${campaignIdStr}:`, err);
                }
                continue;
              }

              // Normal path: not blocked
              if (spentToday === undefined) { skipped.delivering++; continue; }

              if (!shouldTriggerBudgetIncrease(campaign.delivery, campaign.status, spentToday, dailyLimitRubles, budgetStep)) {
                skipped.delivering++;
                continue;
              }

              const recentIncrease = await ctx.runQuery(
                internal.ruleEngine.hasRecentBudgetIncrease,
                { ruleId: rule._id, campaignId: campaignIdStr, withinMs: 5 * 60 * 1000, currentSpent: spentToday, currentBudget: dailyLimitRubles }
              );
              if (recentIncrease) { skipped.dedup++; continue; }

              if (maxDailyBudget && dailyLimitRubles >= maxDailyBudget) {
                skipped.maxReached++;
                if (rule.actions.notifyOnKeyEvents) {
                  try {
                    await ctx.runAction(internal.telegram.sendBudgetNotification, {
                      userId: rule.userId, type: "max_reached" as const,
                      campaignName: campaign.name, currentBudget: dailyLimitRubles,
                      maxBudget: maxDailyBudget,
                    });
                  } catch (notifErr) {
                    console.error(`[uz_budget] Failed to send max_reached notification:`, notifErr);
                  }
                }
                continue;
              }

              const newLimit = calculateNewBudget(dailyLimitRubles, spentToday, budgetStep, maxDailyBudget);

              try {
                await ctx.runAction(internal.vkApi.setCampaignBudget, {
                  accessToken, campaignId: campaign.id, newLimitRubles: newLimit,
                });
                const isFirstToday = await ctx.runQuery(
                  internal.ruleEngine.isFirstBudgetIncreaseToday,
                  { ruleId: rule._id, campaignId: campaignIdStr }
                );
                if (campaign.status !== "active" || campaign.delivery === "not_delivering") {
                  try {
                    const stoppedBannerIds = await ctx.runQuery(
                      internal.ruleEngine.getStoppedBannerIdsForAccount,
                      { accountId: args.accountId }
                    );
                    await ctx.runAction(internal.vkApi.resumeCampaign, {
                      accessToken, campaignId: campaign.id,
                      excludeBannerIds: stoppedBannerIds,
                    });
                  } catch (resumeErr) {
                    console.error(`[uz_budget] Budget set OK but resume failed for campaign ${campaign.id}:`, resumeErr);
                  }
                }

                let verifyFailed = false;
                try {
                  const actual = await ctx.runAction(internal.vkApi.verifyCampaignState, {
                    accessToken, campaignId: campaign.id,
                  });
                  if (actual && actual.budget < newLimit) {
                    console.warn(`[uz_budget] VERIFY FAILED: campaign ${campaign.id} budget=${actual.budget} (expected ${newLimit}), status=${actual.status}`);
                    verifyFailed = true;
                  }
                } catch { /* Verification failed -- don't block */ }

                await ctx.runMutation(internal.ruleEngine.logBudgetAction, {
                  userId: rule.userId, ruleId: rule._id,
                  accountId: args.accountId,
                  campaignId: campaignIdStr, campaignName: campaign.name,
                  actionType: "budget_increased" as const,
                  oldBudget: dailyLimitRubles, newBudget: newLimit,
                  step: newLimit - dailyLimitRubles, spentToday,
                  ...(verifyFailed ? { error: `VK не применил изменение бюджета` } : {}),
                });

                if (rule.actions.notifyOnEveryIncrease ||
                    (rule.actions.notifyOnKeyEvents && isFirstToday)) {
                  try {
                    await ctx.runAction(internal.telegram.sendBudgetNotification, {
                      userId: rule.userId,
                      type: isFirstToday ? ("first_increase" as const) : ("increase" as const),
                      campaignName: campaign.name,
                      oldBudget: dailyLimitRubles, newBudget: newLimit,
                      step: newLimit - dailyLimitRubles,
                    });
                  } catch (notifErr) {
                    console.error(`[uz_budget] Failed to send budget notification:`, notifErr);
                  }
                }
                totalActions++;
              } catch (err) {
                console.error(`[uz_budget] Failed to increase budget for campaign ${campaign.id}:`, err);
                await ctx.runMutation(internal.ruleEngine.logBudgetAction, {
                  userId: rule.userId, ruleId: rule._id,
                  accountId: args.accountId,
                  campaignId: campaignIdStr, campaignName: campaign.name,
                  actionType: "budget_increased" as const,
                  oldBudget: dailyLimitRubles, newBudget: newLimit,
                  step: budgetStep, spentToday,
                  error: err instanceof Error ? err.message : "Unknown error",
                });
              }
            }
          } catch (err) {
            console.error(`[uz_budget] Error processing rule ${rule._id}:`, err);
          }
        }
      })(), ACCOUNT_TIMEOUT_MS, `uz_budget account ${args.accountId}`);
    } catch (accountErr) {
      console.error(`[uz_budget] Account ${args.accountId} timed out or failed:`, accountErr);
    }

    // Summary log
    const skipTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
    if (totalActions > 0 || skipTotal > 0) {
      console.log(
        `[uz_budget] Account ${args.accountId}: ${totalActions} increased` +
        (skipTotal > 0
          ? ` | skipped: ${skipped.delivering} delivering, ${skipped.dedup} dedup, ${skipped.blocked} blocked, ${skipped.maxReached} max, ${skipped.noBudget} no-budget, ${skipped.tokenErr} token-err`
          : "")
      );
    }
  },
});
```

- [ ] **Step 3: Add `uzBudgetDispatch` dispatcher**

```typescript
/**
 * Fan-out dispatcher for UZ budget rules. Replaces sequential checkUzBudgetRules.
 */
export const uzBudgetDispatch = internalAction({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(internal.syncMetrics.upsertCronHeartbeat, {
      name: "uzBudgetDispatch", status: "running",
    });

    let cronError: string | undefined;
    try {
      const uzRules = await ctx.runQuery(internal.ruleEngine.getActiveUzRules);
      if (uzRules.length === 0) {
        console.log("[uzBudgetDispatch] No active UZ rules");
        return;
      }

      // Collect unique accountIds
      const rulesByAccount = groupRulesByAccount(uzRules as UzRule[]);
      const accountIds = [...rulesByAccount.keys()] as Id<"adAccounts">[];

      // Health check: count recent uz_budget errors
      // (lightweight — just check if we should alert)
      const canAlert = await ctx.runQuery(internal.syncMetrics.shouldSendCronAlert, {
        cronName: "uzBudgetDispatch", cooldownMs: ALERT_COOLDOWN_MS,
      });
      if (canAlert) {
        // Check for elevated error rate (optional — log-based)
        // For now, just dispatch workers
      }

      // Dispatch workers
      await ctx.runMutation(internal.ruleEngine.dispatchUzBatch, { accountIds });
      console.log(`[uzBudgetDispatch] Dispatched ${accountIds.length} UZ budget workers for ${uzRules.length} rules`);

    } catch (err) {
      cronError = err instanceof Error ? err.message : "Unknown error";
      console.error("[uzBudgetDispatch] Fatal error:", cronError);
    } finally {
      await ctx.runMutation(internal.syncMetrics.upsertCronHeartbeat, {
        name: "uzBudgetDispatch",
        status: cronError ? "failed" : "completed",
        error: cronError,
      });
    }
  },
});
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: Clean output.

- [ ] **Step 5: Commit**

```bash
git add convex/ruleEngine.ts
git commit -m "feat(fan-out): add uzBudgetOneAccount worker + uzBudgetDispatch dispatcher"
```

---

### Task 4: auth Fan-Out (Token Refresh)

**Files:**
- Modify: `convex/auth.ts` — add `tokenRefreshOne`, `dispatchTokenBatch`, `tokenRefreshDispatch`

- [ ] **Step 1: Add `dispatchTokenBatch` mutation and `tokenRefreshOne` worker**

Add after `proactiveTokenRefresh` in `convex/auth.ts`:

```typescript
const TOKEN_ALERT_COOLDOWN_MS = 30 * 60_000;

/** Schedule tokenRefreshOne workers. Must be mutation for ctx.scheduler. */
export const dispatchTokenBatch = internalMutation({
  args: {
    accounts: v.array(v.object({ type: v.literal("account"), id: v.id("adAccounts") })),
    users: v.array(v.object({ type: v.literal("user_vkads"), id: v.id("users") })),
    vkUsers: v.array(v.object({ type: v.literal("user_vk"), id: v.id("users") })),
  },
  handler: async (ctx, args) => {
    for (const acc of args.accounts) {
      await ctx.scheduler.runAfter(0, internal.auth.tokenRefreshOne, {
        targetType: "account", targetId: acc.id,
      });
    }
    for (const u of args.users) {
      await ctx.scheduler.runAfter(0, internal.auth.tokenRefreshOne, {
        targetType: "user_vkads", targetId: u.id,
      });
    }
    for (const u of args.vkUsers) {
      await ctx.scheduler.runAfter(0, internal.auth.tokenRefreshOne, {
        targetType: "user_vk", targetId: u.id,
      });
    }
  },
});

/**
 * Refresh token for ONE account or user. Scheduled by tokenRefreshDispatch.
 */
export const tokenRefreshOne = internalAction({
  args: {
    targetType: v.union(v.literal("account"), v.literal("user_vkads"), v.literal("user_vk")),
    targetId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    if (args.targetType === "account") {
      const accountId = args.targetId as Id<"adAccounts">;
      // Get account name for logging
      const acc = await ctx.runQuery(internal.adAccounts.getById, { accountId });
      const label = acc?.name || accountId;

      try {
        await ctx.runAction(internal.auth.getValidTokenForAccount, { accountId });
        // Verify
        const updated = await ctx.runQuery(internal.auth.getAccountTokenExpiry, { accountId });
        if (updated && updated > now) {
          console.log(`[tokenRefreshOne] Account "${label}": refreshed, expires ${new Date(updated).toISOString()}`);
        } else {
          console.log(`[tokenRefreshOne] Account "${label}": refresh returned OK but token not updated`);
          // Notify admin
          try {
            await ctx.runAction(internal.telegram.sendMessage, {
              chatId: ADMIN_CHAT_ID,
              text: `🔑 Account "${label}": refresh returned OK but token not updated`,
            });
          } catch { /* non-critical */ }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.log(`[tokenRefreshOne] Account "${label}": failed -- ${errMsg}`);
        if (isUnrecoverable(err)) {
          await ctx.runMutation(internal.auth.clearAccountRefreshToken, { accountId });
          try {
            const recovered = await ctx.runAction(internal.tokenRecovery.tryRecoverToken, { accountId });
            if (recovered) {
              console.log(`[tokenRefreshOne] Account "${label}": recovered via cascade after ${errMsg}`);
            }
          } catch (recoveryErr) {
            console.error(`[tokenRefreshOne] Account "${label}": recovery failed: ${recoveryErr}`);
          }
        }
        // Notify admin on failure
        try {
          await ctx.runAction(internal.telegram.sendMessage, {
            chatId: ADMIN_CHAT_ID,
            text: `🔑 Token refresh failed: Account "${label}": ${errMsg.slice(0, 200)}`,
          });
        } catch { /* non-critical */ }
      }
    } else if (args.targetType === "user_vkads") {
      const userId = args.targetId as Id<"users">;
      const user = await ctx.runQuery(internal.users.getById, { userId });
      const label = user?.name || user?.email || userId;

      try {
        await ctx.runAction(internal.auth.getValidVkAdsToken, { userId });
        const updated = await ctx.runQuery(internal.auth.getUserVkAdsTokenExpiry, { userId });
        if (updated && updated > now) {
          console.log(`[tokenRefreshOne] User "${label}": VK Ads token refreshed, expires ${new Date(updated).toISOString()}`);
        } else {
          console.log(`[tokenRefreshOne] User "${label}": VK Ads refresh OK but token not updated`);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.log(`[tokenRefreshOne] User "${label}": VK Ads refresh failed -- ${errMsg}`);
        if (isUnrecoverable(err)) {
          await ctx.runMutation(internal.auth.clearUserVkAdsRefreshToken, { userId });
        }
        try {
          await ctx.runAction(internal.telegram.sendMessage, {
            chatId: ADMIN_CHAT_ID,
            text: `🔑 VK Ads token refresh failed: User "${label}": ${errMsg.slice(0, 200)}`,
          });
        } catch { /* non-critical */ }
      }
    } else if (args.targetType === "user_vk") {
      const userId = args.targetId as Id<"users">;
      const user = await ctx.runQuery(internal.users.getById, { userId });
      const label = user?.name || user?.email || userId;

      try {
        await ctx.runAction(internal.auth.getValidVkToken, { userId });
        console.log(`[tokenRefreshOne] User "${label}": VK ID token refreshed`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.log(`[tokenRefreshOne] User "${label}": VK ID refresh failed -- ${errMsg}`);
        if (isUnrecoverable(err)) {
          await ctx.runMutation(internal.auth.clearUserVkRefreshToken, { userId });
        }
        try {
          await ctx.runAction(internal.telegram.sendMessage, {
            chatId: ADMIN_CHAT_ID,
            text: `🔑 VK ID token refresh failed: User "${label}": ${errMsg.slice(0, 200)}`,
          });
        } catch { /* non-critical */ }
      }
    }
  },
});
```

- [ ] **Step 2: Add `tokenRefreshDispatch` dispatcher**

```typescript
/**
 * Fan-out dispatcher for proactive token refresh. Replaces sequential proactiveTokenRefresh.
 * Runs every 2h (was 4h). Dispatches tokenRefreshOne per account/user.
 */
export const tokenRefreshDispatch = internalAction({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(internal.syncMetrics.upsertCronHeartbeat, {
      name: "tokenRefreshDispatch", status: "running",
    });

    let cronError: string | undefined;
    try {
      const now = Date.now();
      const threshold = now + PROACTIVE_REFRESH_WINDOW_MS;

      // Health check: accounts with tokenExpiresAt < 1h
      const expiringAccounts = await ctx.runQuery(internal.auth.getExpiringAccounts, { threshold });
      const urgentCount = expiringAccounts.filter(
        (a) => a.tokenExpiresAt && a.tokenExpiresAt > 0 && a.tokenExpiresAt < now + 60 * 60_000
      ).length;

      if (urgentCount > 0) {
        const canAlert = await ctx.runQuery(internal.syncMetrics.shouldSendCronAlert, {
          cronName: "tokenRefreshDispatch", cooldownMs: TOKEN_ALERT_COOLDOWN_MS,
        });
        if (canAlert) {
          try {
            await ctx.runAction(internal.telegram.sendMessage, {
              chatId: ADMIN_CHAT_ID,
              text: `⚠️ <b>Токены</b>: ${urgentCount} аккаунтов истекают < 1ч`,
            });
            await ctx.runMutation(internal.syncMetrics.markCronAlertSent, {
              cronName: "tokenRefreshDispatch",
            });
          } catch { /* non-critical */ }
        }
      }

      // Gather all expiring targets
      const accounts = expiringAccounts.map((a) => ({ type: "account" as const, id: a._id }));
      const users = (await ctx.runQuery(internal.auth.getExpiringUserTokens, { threshold }))
        .map((u) => ({ type: "user_vkads" as const, id: u._id }));
      const vkUsers = (await ctx.runQuery(internal.auth.getExpiringUserVkTokens, { threshold }))
        .map((u) => ({ type: "user_vk" as const, id: u._id }));

      const total = accounts.length + users.length + vkUsers.length;
      if (total === 0) {
        console.log("[tokenRefreshDispatch] No tokens to refresh");
        return;
      }

      // Dispatch all workers
      await ctx.runMutation(internal.auth.dispatchTokenBatch, {
        accounts, users, vkUsers,
      });
      console.log(`[tokenRefreshDispatch] Dispatched ${accounts.length} accounts + ${users.length} VK Ads users + ${vkUsers.length} VK users`);

      // Retry recovery for accounts stuck in error state
      try {
        await ctx.runAction(internal.tokenRecovery.retryRecovery, {});
      } catch (retryErr) {
        console.error(`[tokenRefreshDispatch] retryRecovery failed: ${retryErr}`);
      }

    } catch (err) {
      cronError = err instanceof Error ? err.message : "Unknown error";
      console.error("[tokenRefreshDispatch] Fatal error:", cronError);
    } finally {
      await ctx.runMutation(internal.syncMetrics.upsertCronHeartbeat, {
        name: "tokenRefreshDispatch",
        status: cronError ? "failed" : "completed",
        error: cronError,
      });
    }
  },
});
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: Clean output. Fix any type errors with `Id<>` casts or imports.

- [ ] **Step 4: Commit**

```bash
git add convex/auth.ts
git commit -m "feat(fan-out): add tokenRefreshOne worker + tokenRefreshDispatch dispatcher"
```

---

### Task 5: Wire Up Crons + Health Check Thresholds

**Files:**
- Modify: `convex/crons.ts:7-11, 85-89, 133-139`
- Modify: `convex/healthCheck.ts:124, 303`

- [ ] **Step 1: Update crons.ts entry points**

Replace the three cron entries:

```typescript
// Line 7-11: sync-metrics
crons.interval(
  "sync-metrics",
  { minutes: 5 },
  internal.syncMetrics.syncDispatch
);

// Line 85-89: uz-budget-increase
crons.interval(
  "uz-budget-increase",
  { minutes: 5 },
  internal.ruleEngine.uzBudgetDispatch
);

// Line 133-139: proactive-token-refresh (4h -> 2h, remove empty args)
crons.interval(
  "proactive-token-refresh",
  { hours: 2 },
  internal.auth.tokenRefreshDispatch
);
```

**Note:** The old `scheduleProactiveRetry` mutation in auth.ts is no longer called. Leave it in place for now (spec says old code stays, removed in next deploy after verification).

- [ ] **Step 2: Update healthCheck.ts thresholds**

In `convex/healthCheck.ts`:

**Line 124** — change `10 * 60_000` to `15 * 60_000`:

```typescript
    const syncedCount = activeAccounts.filter((a) => a.lastSyncAt && now - a.lastSyncAt < 15 * 60_000).length;
```

**Line 303** — change `> 30` to `> 20`:

```typescript
      if (minutesAgo(acc.lastSyncAt) > 20) {
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: Clean output.

- [ ] **Step 4: Commit**

```bash
git add convex/crons.ts convex/healthCheck.ts
git commit -m "feat(fan-out): swap cron entry points, update health check thresholds"
```

---

### Task 6: Docker Concurrency + Final Verification

**Files:**
- Modify: `docker/docker-compose.convex-selfhosted.yml:51-58`

- [ ] **Step 1: Add concurrency env var to docker-compose**

In `docker/docker-compose.convex-selfhosted.yml`, add `APPLICATION_MAX_CONCURRENT_V8_ACTIONS=32` to the backend environment section (after line 58, after `DOCUMENT_RETENTION_DELAY`):

```yaml
      - DOCUMENT_RETENTION_DELAY=172800
      - APPLICATION_MAX_CONCURRENT_V8_ACTIONS=32
```

- [ ] **Step 2: Full typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: Clean output, no errors.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: No new errors beyond existing warning budget.

- [ ] **Step 4: Run tests**

Run: `npm run test`
Expected: All existing tests pass. The fan-out changes don't modify pure function logic.

- [ ] **Step 5: Commit**

```bash
git add docker/docker-compose.convex-selfhosted.yml
git commit -m "feat(fan-out): raise concurrent actions to 32"
```

- [ ] **Step 6: Final commit (squash or merge)**

Review all commits from Tasks 1-6. If clean, push to main for deployment:

```bash
git log --oneline -6
# Verify all 6 commits are correct
git push origin main
```

---

## Rollback Plan

If problems detected after deploy:

1. In `convex/crons.ts` — revert 3 entry points to old functions (`syncAll`, `checkUzBudgetRules`, `proactiveTokenRefresh`) + revert token refresh interval to `{ hours: 4 }`
2. In `docker-compose` — remove `APPLICATION_MAX_CONCURRENT_V8_ACTIONS`
3. In `healthCheck.ts` — revert thresholds to 10min/30min
4. One commit, one push, one deploy.

## Post-Deploy Cleanup (Next Session)

After confirming fan-out works for 24h+:
- Remove old `syncAll`, `checkUzBudgetRules`, `proactiveTokenRefresh` functions
- Remove `scheduleProactiveRetry` mutation
- Remove `BATCH_SIZE` constant and old `listActiveAccounts` query
- Remove `consecutiveCampaignApiFailures` circuit breaker references

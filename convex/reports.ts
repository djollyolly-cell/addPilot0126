import { v } from "convex/values";
import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

// ─── myTarget API helper (local copy — callMtApi is not exported from vkApi.ts) ───

const MT_API_BASE = "https://target.my.com";
const MT_MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callMtApi<T>(
  endpoint: string,
  accessToken: string,
  params?: Record<string, string>
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MT_MAX_RETRIES; attempt++) {
    const url = new URL(`${MT_API_BASE}/api/v2/${endpoint}`);
    if (params) {
      Object.entries(params).forEach(([k, val]) => url.searchParams.set(k, val));
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (response.status === 429 && attempt < MT_MAX_RETRIES - 1) {
      await sleep(RETRY_DELAY_MS * (attempt + 1));
      continue;
    }

    if (response.status === 401) {
      throw new Error("TOKEN_EXPIRED");
    }

    if (!response.ok) {
      const text = await response.text();
      lastError = new Error(`VK Ads API Error ${response.status}: ${text}`);
      throw lastError;
    }

    return response.json();
  }

  throw lastError || new Error("VK Ads API request failed after retries");
}

// ─── Types ───────────────────────────────────────────────────────────

interface MtCampaignRaw {
  id: number;
  name: string;
  status: string;
  objective: string;
  budget_limit: string;
  budget_limit_day: string;
}

interface MtBannerRaw {
  id: number;
  campaign_id: number;
  textblocks?: Record<string, { text: string }>;
  status: string;
  moderation_status: string;
}

interface MtStatBase {
  shows: number;
  clicks: number;
  spent: string;
  goals: number;
  vk?: {
    result?: number | string;
    goals?: number | string;
  };
}

interface MtStatRow {
  date: string;
  base: MtStatBase;
  events?: Record<string, { count?: number | string } | number>;
}

interface MtStatItem {
  id: number;
  rows: MtStatRow[];
}

interface MtCampaignStatItem {
  id: number;
  rows: MtStatRow[];
}

interface BannerReport {
  id: number;
  name: string;
  status: string;
  impressions: number;
  clicks: number;
  spent: number;
  leads: number;
  ctr: number;
  cpl: number;
}

interface CampaignReport {
  id: number;
  name: string;
  status: string;
  objective: string;
  impressions: number;
  clicks: number;
  spent: number;
  leads: number;
  ctr: number;
  cpl: number;
  banners: BannerReport[];
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Extract banner display name from textblocks.
 * Tries title_25 first, then any available textblock, falls back to "Ad {id}".
 */
function getBannerName(banner: MtBannerRaw): string {
  if (!banner.textblocks) return `Ad ${banner.id}`;

  if (banner.textblocks.title_25?.text) {
    return banner.textblocks.title_25.text;
  }

  // Try any textblock that has text
  for (const block of Object.values(banner.textblocks)) {
    if (block?.text) return block.text;
  }

  return `Ad ${banner.id}`;
}

/**
 * Count leads from a single stat row using all available sources.
 * Takes Math.max across: base.goals, base.vk.result, base.vk.goals, events.
 */
function countLeadsFromRow(row: MtStatRow): number {
  const base = row.base;
  const baseGoals = Number(base.goals) || 0;

  // VK nested stats (campaign results, lead forms)
  const vk = base.vk;
  const vkResult = vk ? (Number(vk.result) || 0) : 0;
  const vkGoals = vk ? (Number(vk.goals) || 0) : 0;

  // Events section (VK lead forms often report here)
  let eventsGoals = 0;
  if (row.events && typeof row.events === "object") {
    for (const eventData of Object.values(row.events)) {
      if (typeof eventData === "number") {
        eventsGoals += eventData;
      } else if (eventData && typeof eventData === "object" && eventData.count !== undefined) {
        eventsGoals += Number(eventData.count) || 0;
      }
    }
  }

  return Math.max(baseGoals, vkResult, vkGoals, eventsGoals);
}

/**
 * Aggregate stat rows for a banner across all days in the period.
 */
function aggregateBannerStats(rows: MtStatRow[]): {
  impressions: number;
  clicks: number;
  spent: number;
  leads: number;
} {
  let impressions = 0;
  let clicks = 0;
  let spent = 0;
  let leads = 0;

  for (const row of rows) {
    impressions += row.base.shows || 0;
    clicks += row.base.clicks || 0;
    spent += parseFloat(row.base.spent || "0") || 0;
    leads += countLeadsFromRow(row);
  }

  return { impressions, clicks, spent, leads };
}

/**
 * Compute CTR and CPL from aggregated metrics.
 */
function computeDerived(stats: { impressions: number; clicks: number; spent: number; leads: number }) {
  const ctr = stats.impressions > 0 ? (stats.clicks / stats.impressions) * 100 : 0;
  const cpl = stats.leads > 0 ? stats.spent / stats.leads : 0;
  return {
    ctr: Math.round(ctr * 100) / 100,
    cpl: Math.round(cpl * 100) / 100,
  };
}

// ─── Main action ─────────────────────────────────────────────────────

/**
 * Fetch a full report with campaigns, banners, and statistics
 * from VK Ads (myTarget) API for the given date range.
 */
export const fetchReport = action({
  args: {
    userId: v.id("users"),
    dateFrom: v.string(),
    dateTo: v.string(),
    accountId: v.optional(v.id("adAccounts")),
  },
  handler: async (ctx, args): Promise<{ campaigns: CampaignReport[]; dateFrom: string; dateTo: string }> => {
    // Get valid VK Ads token (auto-refreshes if expired)
    const accessToken = await ctx.runAction(
      internal.auth.getValidVkAdsToken,
      { userId: args.userId }
    );

    // If accountId provided, get its campaign IDs from DB for filtering
    let accountCampaignIds: Set<number> | null = null;
    if (args.accountId) {
      const dbCampaigns = await ctx.runQuery(
        internal.reports.getCampaignsByAccount,
        { accountId: args.accountId }
      );
      accountCampaignIds = new Set(dbCampaigns.map((c: { vkCampaignId: string }) => Number(c.vkCampaignId)));
    }

    // Fetch campaigns, banners, and lead counts in parallel
    const [campaignsData, bannersData] = await Promise.all([
      callMtApi<{ items: MtCampaignRaw[]; count: number }>(
        "campaigns.json",
        accessToken,
        { fields: "id,name,status,objective,budget_limit,budget_limit_day" }
      ),
      callMtApi<{ items: MtBannerRaw[]; count: number }>(
        "banners.json",
        accessToken,
        { fields: "id,campaign_id,textblocks,status,moderation_status" }
      ),
    ]);

    // Filter by account if specified
    let campaigns = campaignsData.items || [];
    let banners = bannersData.items || [];
    if (accountCampaignIds) {
      campaigns = campaigns.filter((c) => accountCampaignIds!.has(c.id));
      banners = banners.filter((b) => accountCampaignIds!.has(b.campaign_id));
    }

    if (banners.length === 0) {
      // No banners — return campaigns with zero metrics
      return {
        dateFrom: args.dateFrom,
        dateTo: args.dateTo,
        campaigns: campaigns.map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          objective: c.objective || "",
          impressions: 0,
          clicks: 0,
          spent: 0,
          leads: 0,
          ctr: 0,
          cpl: 0,
          banners: [],
        })),
      };
    }

    // Fetch banner-level statistics for the period
    const bannerIds = banners.map((b) => String(b.id)).join(",");
    const campaignIds = campaigns.map((c) => String(c.id)).join(",");

    // Fetch banner stats, campaign stats, and lead counts in parallel
    const [statsData, campaignStatsData, leadCounts] = await Promise.all([
      callMtApi<{ items: MtStatItem[] }>(
        "statistics/banners/day.json",
        accessToken,
        {
          id: bannerIds,
          date_from: args.dateFrom,
          date_to: args.dateTo,
          metrics: "base,events",
        }
      ),
      callMtApi<{ items: MtCampaignStatItem[] }>(
        "statistics/campaigns/day.json",
        accessToken,
        {
          id: campaignIds,
          date_from: args.dateFrom,
          date_to: args.dateTo,
          metrics: "base,events",
        }
      ),
      fetchLeadCounts(accessToken, args.dateFrom, args.dateTo),
    ]);

    const statItems = statsData.items || [];
    const campaignStatItems = campaignStatsData.items || [];

    // Build a map: bannerId -> stat rows
    const statsMap = new Map<number, MtStatRow[]>();
    for (const item of statItems) {
      statsMap.set(item.id, item.rows || []);
    }

    // Build a map: campaignId -> aggregated campaign stats
    const campaignStatsMap = new Map<number, { impressions: number; clicks: number; spent: number; leads: number }>();
    for (const item of campaignStatItems) {
      const agg = aggregateBannerStats(item.rows || []);
      campaignStatsMap.set(item.id, agg);
    }

    // Build a map: campaignId -> banners
    const campaignBannersMap = new Map<number, MtBannerRaw[]>();
    for (const banner of banners) {
      const list = campaignBannersMap.get(banner.campaign_id) || [];
      list.push(banner);
      campaignBannersMap.set(banner.campaign_id, list);
    }

    // Build campaign reports
    const result: CampaignReport[] = [];

    for (const campaign of campaigns) {
      const campBanners = campaignBannersMap.get(campaign.id) || [];

      // Build banner reports
      const bannerReports: BannerReport[] = [];
      let bannerLeadsTotal = 0;

      for (const banner of campBanners) {
        const rows = statsMap.get(banner.id) || [];
        const agg = aggregateBannerStats(rows);

        // Add Lead Ads API leads (take max with already computed leads per day)
        const leadAdsCount = leadCounts[String(banner.id)] || 0;
        const finalLeads = Math.max(agg.leads, leadAdsCount);

        const derived = computeDerived({ ...agg, leads: finalLeads });

        bannerReports.push({
          id: banner.id,
          name: getBannerName(banner),
          status: banner.status,
          impressions: agg.impressions,
          clicks: agg.clicks,
          spent: Math.round(agg.spent * 100) / 100,
          leads: finalLeads,
          ctr: derived.ctr,
          cpl: derived.cpl,
        });

        bannerLeadsTotal += finalLeads;
      }

      // Use campaign-level stats from API (more accurate than banner aggregation)
      const campStats = campaignStatsMap.get(campaign.id);
      const campImpressions = campStats?.impressions ?? bannerReports.reduce((s, b) => s + b.impressions, 0);
      const campClicks = campStats?.clicks ?? bannerReports.reduce((s, b) => s + b.clicks, 0);
      const campSpent = campStats?.spent ?? bannerReports.reduce((s, b) => s + b.spent, 0);
      // For leads: take max of campaign-level leads and sum of banner leads (with Lead Ads)
      const campLeadsFromApi = campStats?.leads ?? 0;
      const campLeads = Math.max(campLeadsFromApi, bannerLeadsTotal);

      const campDerived = computeDerived({
        impressions: campImpressions,
        clicks: campClicks,
        spent: campSpent,
        leads: campLeads,
      });

      result.push({
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        objective: campaign.objective || "",
        impressions: campImpressions,
        clicks: campClicks,
        spent: Math.round(campSpent * 100) / 100,
        leads: campLeads,
        ctr: campDerived.ctr,
        cpl: campDerived.cpl,
        banners: bannerReports,
      });
    }

    return { campaigns: result, dateFrom: args.dateFrom, dateTo: args.dateTo };
  },
});

// ─── Internal queries ────────────────────────────────────────────────

/** Get campaigns belonging to a specific ad account (for filtering reports). */
export const getCampaignsByAccount = internalQuery({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("campaigns")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();
  },
});

// ─── Lead Ads helper ─────────────────────────────────────────────────

/**
 * Fetch lead counts per banner from VK Lead Ads API.
 * Returns a map: bannerId (string) -> lead count.
 * Non-fatal: returns empty map on error.
 */
async function fetchLeadCounts(
  accessToken: string,
  dateFrom: string,
  dateTo: string
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};

  try {
    // Fetch lead form subscriptions to map form IDs to banner IDs
    const subs = await callMtApi<{
      items: Array<{ id: number; banner_id: number }>;
    }>("lead_ads/vkontakte/subscriptions.json", accessToken, {});

    if (!subs.items || subs.items.length === 0) {
      return result;
    }

    const formToBanner = new Map<number, number>();
    for (const sub of subs.items) {
      formToBanner.set(sub.id, sub.banner_id);
    }

    // Fetch leads for the date range
    const formIds = subs.items.map((s) => s.id).join(",");
    const leads = await callMtApi<{
      items: Array<{
        form_id: number;
        leads: Array<{ id: number; created: string }>;
      }>;
    }>("lead_ads/vkontakte/leads.json", accessToken, {
      form_id: formIds,
      date_from: dateFrom,
      date_to: dateTo,
    });

    if (leads.items) {
      for (const item of leads.items) {
        const bannerId = formToBanner.get(item.form_id);
        if (bannerId) {
          const key = String(bannerId);
          result[key] = (result[key] || 0) + (item.leads?.length || 0);
        }
      }
    }
  } catch (err) {
    // Lead Ads API may not be available for all accounts — log and continue
    console.error(
      `[reports] Lead Ads API error (non-fatal): ${err instanceof Error ? err.message : err}`
    );
  }

  return result;
}

import { v } from "convex/values";
import { action } from "./_generated/server";
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

function getBannerName(banner: MtBannerRaw): string {
  if (!banner.textblocks) return `Ad ${banner.id}`;
  if (banner.textblocks.title_25?.text) return banner.textblocks.title_25.text;
  for (const block of Object.values(banner.textblocks)) {
    if (block?.text) return block.text;
  }
  return `Ad ${banner.id}`;
}

function countLeadsFromRow(row: MtStatRow): number {
  const base = row.base;
  const baseGoals = Number(base.goals) || 0;
  const vk = base.vk;
  const vkResult = vk ? (Number(vk.result) || 0) : 0;
  const vkGoals = vk ? (Number(vk.goals) || 0) : 0;
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

function aggregateBannerStats(rows: MtStatRow[]) {
  let impressions = 0, clicks = 0, spent = 0, leads = 0;
  for (const row of rows) {
    impressions += row.base.shows || 0;
    clicks += row.base.clicks || 0;
    spent += parseFloat(row.base.spent || "0") || 0;
    leads += countLeadsFromRow(row);
  }
  return { impressions, clicks, spent, leads };
}

function computeDerived(stats: { impressions: number; clicks: number; spent: number; leads: number }) {
  const ctr = stats.impressions > 0 ? (stats.clicks / stats.impressions) * 100 : 0;
  const cpl = stats.leads > 0 ? stats.spent / stats.leads : 0;
  return { ctr: Math.round(ctr * 100) / 100, cpl: Math.round(cpl * 100) / 100 };
}

// ─── Fetch data for one token ────────────────────────────────────────

async function fetchAccountData(
  accessToken: string,
  dateFrom: string,
  dateTo: string
): Promise<{
  campaigns: MtCampaignRaw[];
  banners: MtBannerRaw[];
  statsMap: Map<number, MtStatRow[]>;
  campaignStatsMap: Map<number, { impressions: number; clicks: number; spent: number; leads: number }>;
  leadCounts: Record<string, number>;
}> {
  // Fetch campaigns + banners (with pagination for banners)
  const campaignsData = await callMtApi<{ items: MtCampaignRaw[]; count: number }>(
    "campaigns.json", accessToken,
    { fields: "id,name,status,objective,budget_limit,budget_limit_day", limit: "250" }
  );
  const campaigns = campaignsData.items || [];

  let banners: MtBannerRaw[] = [];
  let offset = 0;
  while (true) {
    const bannersData = await callMtApi<{ items: MtBannerRaw[]; count: number }>(
      "banners.json", accessToken,
      { fields: "id,campaign_id,textblocks,status,moderation_status", limit: "250", offset: String(offset) }
    );
    const items = bannersData.items || [];
    banners = banners.concat(items);
    if (banners.length >= bannersData.count || items.length === 0) break;
    offset += items.length;
  }

  if (banners.length === 0) {
    return {
      campaigns, banners,
      statsMap: new Map(),
      campaignStatsMap: new Map(),
      leadCounts: {},
    };
  }

  const bannerIds = banners.map((b) => String(b.id)).join(",");
  const campaignIds = campaigns.map((c) => String(c.id)).join(",");

  // Fetch stats in parallel
  const [statsData, campaignStatsData, leadCounts] = await Promise.all([
    callMtApi<{ items: MtStatItem[] }>(
      "statistics/banners/day.json", accessToken,
      { id: bannerIds, date_from: dateFrom, date_to: dateTo, metrics: "base,events" }
    ),
    campaignIds
      ? callMtApi<{ items: MtStatItem[] }>(
          "statistics/campaigns/day.json", accessToken,
          { id: campaignIds, date_from: dateFrom, date_to: dateTo, metrics: "base,events" }
        )
      : Promise.resolve({ items: [] as MtStatItem[] }),
    fetchLeadCounts(accessToken, dateFrom, dateTo),
  ]);

  const statsMap = new Map<number, MtStatRow[]>();
  for (const item of (statsData.items || [])) {
    statsMap.set(item.id, item.rows || []);
  }

  const campaignStatsMap = new Map<number, { impressions: number; clicks: number; spent: number; leads: number }>();
  for (const item of (campaignStatsData.items || [])) {
    campaignStatsMap.set(item.id, aggregateBannerStats(item.rows || []));
  }

  return { campaigns, banners, statsMap, campaignStatsMap, leadCounts };
}

// ─── Build report from fetched data ──────────────────────────────────

function buildCampaignReports(
  campaigns: MtCampaignRaw[],
  banners: MtBannerRaw[],
  statsMap: Map<number, MtStatRow[]>,
  campaignStatsMap: Map<number, { impressions: number; clicks: number; spent: number; leads: number }>,
  leadCounts: Record<string, number>
): CampaignReport[] {
  // campaignId -> banners
  const campaignBannersMap = new Map<number, MtBannerRaw[]>();
  for (const banner of banners) {
    const list = campaignBannersMap.get(banner.campaign_id) || [];
    list.push(banner);
    campaignBannersMap.set(banner.campaign_id, list);
  }

  const result: CampaignReport[] = [];

  for (const campaign of campaigns) {
    const campBanners = campaignBannersMap.get(campaign.id) || [];
    const bannerReports: BannerReport[] = [];
    let bannerLeadsTotal = 0;

    for (const banner of campBanners) {
      const rows = statsMap.get(banner.id) || [];
      const agg = aggregateBannerStats(rows);
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

    // Campaign-level stats from API (more accurate than banner aggregation)
    const campStats = campaignStatsMap.get(campaign.id);
    const campImpressions = campStats?.impressions ?? bannerReports.reduce((s, b) => s + b.impressions, 0);
    const campClicks = campStats?.clicks ?? bannerReports.reduce((s, b) => s + b.clicks, 0);
    const campSpent = campStats?.spent ?? bannerReports.reduce((s, b) => s + b.spent, 0);
    const campLeadsFromApi = campStats?.leads ?? 0;
    const campLeads = Math.max(campLeadsFromApi, bannerLeadsTotal);

    const campDerived = computeDerived({
      impressions: campImpressions, clicks: campClicks,
      spent: campSpent, leads: campLeads,
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

  return result;
}

// ─── Main action ─────────────────────────────────────────────────────

export const fetchReport = action({
  args: {
    userId: v.id("users"),
    dateFrom: v.string(),
    dateTo: v.string(),
  },
  handler: async (ctx, args): Promise<{ campaigns: CampaignReport[]; dateFrom: string; dateTo: string }> => {
    // Always use user-level token (auto-refreshed, works for all accounts)
    const accessToken = await ctx.runAction(
      internal.auth.getValidVkAdsToken,
      { userId: args.userId }
    );

    // Fetch all data from VK API (single token returns all campaigns/banners)
    const data = await fetchAccountData(accessToken, args.dateFrom, args.dateTo);

    const campaignReports = buildCampaignReports(
      data.campaigns, data.banners, data.statsMap, data.campaignStatsMap, data.leadCounts
    );

    return { campaigns: campaignReports, dateFrom: args.dateFrom, dateTo: args.dateTo };
  },
});

// ─── Internal queries ────────────────────────────────────────────────

// (Account filtering removed — single VK Ads token returns all data)

// ─── Lead Ads helper ─────────────────────────────────────────────────

async function fetchLeadCounts(
  accessToken: string,
  dateFrom: string,
  dateTo: string
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};

  try {
    const subs = await callMtApi<{
      items: Array<{ id: number; banner_id: number }>;
    }>("lead_ads/vkontakte/subscriptions.json", accessToken, {});

    if (!subs.items || subs.items.length === 0) return result;

    const formToBanner = new Map<number, number>();
    for (const sub of subs.items) {
      formToBanner.set(sub.id, sub.banner_id);
    }

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
    console.error(
      `[reports] Lead Ads API error (non-fatal): ${err instanceof Error ? err.message : err}`
    );
  }

  return result;
}

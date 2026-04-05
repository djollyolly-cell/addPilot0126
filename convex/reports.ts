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

// myTarget ad_plans.json = VK Ads Кампании
interface MtAdPlanRaw {
  id: number;
  name: string;
  status: string;
  objective: string;
  budget_limit: number | null;
  budget_limit_day: number | null;
}

// myTarget ad_groups.json (= campaigns.json) = VK Ads Группы
interface MtAdGroupRaw {
  id: number;
  name: string;
  status: string;
  ad_plan_id: number;
  package_id: number;
  budget_limit: number | null;
  budget_limit_day: number | null;
}

interface MtUserInfo {
  id: number;
  username: string;
  status: string;
}

interface MtBannerRaw {
  id: number;
  campaign_id: number; // = ad_group_id
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

// ─── Report types (4 levels: Account → Campaign → Group → Ad) ───────

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

// VK Ads Группа (myTarget ad_group / campaign)
interface GroupReport {
  id: number;
  name: string;
  status: string;
  impressions: number;
  clicks: number;
  spent: number;
  leads: number;
  ctr: number;
  cpl: number;
  banners: BannerReport[];
}

// VK Ads Кампания (myTarget ad_plan)
interface CampaignReport {
  id: number;
  name: string;
  status: string;
  objective: string;
  objectiveLabel: string;
  groups: GroupReport[];
  impressions: number;
  clicks: number;
  spent: number;
  leads: number;
  ctr: number;
  cpl: number;
}

// Кабинет
interface AccountReport {
  id: number;
  name: string;
  campaigns: CampaignReport[];
  impressions: number;
  clicks: number;
  spent: number;
  leads: number;
  ctr: number;
  cpl: number;
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
  // Count only sending_form from events (lead form submissions)
  // Other events (moving_into_group, clicks_on_external_url, likes, etc.) are NOT leads
  let eventsGoals = 0;
  if (row.events && typeof row.events === "object") {
    const sendingForm = (row.events as Record<string, unknown>).sending_form;
    if (typeof sendingForm === "number") {
      eventsGoals = sendingForm;
    } else if (sendingForm && typeof sendingForm === "object") {
      eventsGoals = Number((sendingForm as { count?: number | string }).count) || 0;
    }
  }
  return Math.max(baseGoals, vkResult, vkGoals, eventsGoals);
}

function aggregateStats(rows: MtStatRow[]) {
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

// ─── Objective labels ────────────────────────────────────────────────

const OBJECTIVE_LABELS: Record<string, string> = {
  "traffic": "Трафик",
  "conversions": "Конверсии",
  "reach": "Охват",
  "video_views": "Просмотры видео",
  "messages": "Сообщения",
  "leadads": "Получение лидов",
  "lead_generation": "Лидогенерация",
  "engagement": "Вовлечённость",
  "socialengagement": "Отправка сообщений",
  "app_installs": "Установки приложений",
  "appinstalls": "Установки приложений",
  "product_sales": "Продажи товаров",
  "awareness": "Узнаваемость",
  "promo": "Продвижение",
  "special": "Специальный",
};

function getObjectiveLabel(objective: string): string {
  if (!objective) return "Без цели";
  return OBJECTIVE_LABELS[objective] || objective;
}

// ─── Fetch all data from API ─────────────────────────────────────────

async function fetchAllData(
  accessToken: string,
  dateFrom: string,
  dateTo: string
) {
  // Fetch ad_plans (VK campaigns), ad_groups (VK groups), banners (VK ads), packages in parallel
  const [adPlansData, adGroupsData, packagesData] = await Promise.all([
    callMtApi<{ items: MtAdPlanRaw[]; count: number }>(
      "ad_plans.json", accessToken,
      { fields: "id,name,status,objective,budget_limit,budget_limit_day", limit: "250" }
    ),
    callMtApi<{ items: MtAdGroupRaw[]; count: number }>(
      "ad_groups.json", accessToken,
      { fields: "id,name,status,ad_plan_id,package_id,budget_limit,budget_limit_day", limit: "250" }
    ),
    // packages.json max limit=50 (VK API constraint). Non-fatal: if fails, objectives won't have labels.
    callMtApi<{ items: { id: number; name: string }[] }>(
      "packages.json", accessToken,
      { fields: "id,name", limit: "50" }
    ).catch((err) => {
      console.error("[reports] packages.json failed (non-fatal):", err instanceof Error ? err.message : err);
      return { items: [] as { id: number; name: string }[] };
    }),
  ]);

  const adPlans = adPlansData.items || [];
  const adGroups = adGroupsData.items || [];

  // Build package_id → name mapping for objective resolution
  const packageMap = new Map<number, string>();
  for (const pkg of packagesData.items || []) {
    packageMap.set(pkg.id, pkg.name);
  }

  // Log package mapping for diagnostics
  const uniquePackageIds = [...new Set(adGroups.map((g) => g.package_id))];
  console.log("[reports] Package mapping for active groups:",
    uniquePackageIds.map((id) => `${id}=${packageMap.get(id) || "unknown"}`).join(", ")
  );

  // Fetch banners with pagination
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

  // Fetch statistics for all levels + lead counts in parallel
  const adPlanIds = adPlans.map((p) => String(p.id)).join(",");
  const adGroupIds = adGroups.map((g) => String(g.id)).join(",");
  const bannerIds = banners.map((b) => String(b.id)).join(",");

  const [adPlanStats, adGroupStats, bannerStats, leadCounts] = await Promise.all([
    adPlanIds
      ? callMtApi<{ items: MtStatItem[] }>(
          "statistics/ad_plans/day.json", accessToken,
          { id: adPlanIds, date_from: dateFrom, date_to: dateTo, metrics: "base,events" }
        )
      : Promise.resolve({ items: [] as MtStatItem[] }),
    adGroupIds
      ? callMtApi<{ items: MtStatItem[] }>(
          "statistics/ad_groups/day.json", accessToken,
          { id: adGroupIds, date_from: dateFrom, date_to: dateTo, metrics: "base,events" }
        )
      : Promise.resolve({ items: [] as MtStatItem[] }),
    bannerIds
      ? callMtApi<{ items: MtStatItem[] }>(
          "statistics/banners/day.json", accessToken,
          { id: bannerIds, date_from: dateFrom, date_to: dateTo, metrics: "base,events" }
        )
      : Promise.resolve({ items: [] as MtStatItem[] }),
    fetchLeadCounts(accessToken, dateFrom, dateTo),
  ]);

  // Build lookup maps
  const adPlanStatsMap = new Map<number, MtStatRow[]>();
  for (const item of (adPlanStats.items || [])) {
    adPlanStatsMap.set(item.id, item.rows || []);
  }

  const adGroupStatsMap = new Map<number, MtStatRow[]>();
  for (const item of (adGroupStats.items || [])) {
    adGroupStatsMap.set(item.id, item.rows || []);
  }

  const bannerStatsMap = new Map<number, MtStatRow[]>();
  for (const item of (bannerStats.items || [])) {
    bannerStatsMap.set(item.id, item.rows || []);
  }

  return { adPlans, adGroups, banners, adPlanStatsMap, adGroupStatsMap, bannerStatsMap, leadCounts, packageMap };
}

// ─── Build 4-level report ────────────────────────────────────────────

function buildReport(
  adPlans: MtAdPlanRaw[],
  adGroups: MtAdGroupRaw[],
  banners: MtBannerRaw[],
  adPlanStatsMap: Map<number, MtStatRow[]>,
  adGroupStatsMap: Map<number, MtStatRow[]>,
  bannerStatsMap: Map<number, MtStatRow[]>,
  leadCounts: Record<string, number>,
  packageMap?: Map<number, string>
): CampaignReport[] {
  // adGroupId → banners
  const groupBannersMap = new Map<number, MtBannerRaw[]>();
  for (const banner of banners) {
    const list = groupBannersMap.get(banner.campaign_id) || [];
    list.push(banner);
    groupBannersMap.set(banner.campaign_id, list);
  }

  // adPlanId → adGroups
  const planGroupsMap = new Map<number, MtAdGroupRaw[]>();
  for (const group of adGroups) {
    const list = planGroupsMap.get(group.ad_plan_id) || [];
    list.push(group);
    planGroupsMap.set(group.ad_plan_id, list);
  }

  const campaignReports: CampaignReport[] = [];

  for (const plan of adPlans) {
    const groups = planGroupsMap.get(plan.id) || [];
    const groupReports: GroupReport[] = [];

    for (const group of groups) {
      const grpBanners = groupBannersMap.get(group.id) || [];
      const bannerReports: BannerReport[] = [];
      let bannerLeadsTotal = 0;

      for (const banner of grpBanners) {
        const rows = bannerStatsMap.get(banner.id) || [];
        const agg = aggregateStats(rows);
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

      // Use ad_group stats from API (more accurate) or fallback to sum of banners
      const grpRows = adGroupStatsMap.get(group.id) || [];
      const grpAgg = grpRows.length > 0 ? aggregateStats(grpRows) : {
        impressions: bannerReports.reduce((s, b) => s + b.impressions, 0),
        clicks: bannerReports.reduce((s, b) => s + b.clicks, 0),
        spent: bannerReports.reduce((s, b) => s + b.spent, 0),
        leads: bannerLeadsTotal,
      };
      const grpLeads = Math.max(grpAgg.leads, bannerLeadsTotal);
      const grpDerived = computeDerived({ ...grpAgg, leads: grpLeads });

      groupReports.push({
        id: group.id,
        name: group.name,
        status: group.status,
        impressions: grpAgg.impressions,
        clicks: grpAgg.clicks,
        spent: Math.round(grpAgg.spent * 100) / 100,
        leads: grpLeads,
        ctr: grpDerived.ctr,
        cpl: grpDerived.cpl,
        banners: bannerReports,
      });
    }

    // Use ad_plan stats from API (most accurate) or fallback to sum of groups
    const planRows = adPlanStatsMap.get(plan.id) || [];
    const planAgg = planRows.length > 0 ? aggregateStats(planRows) : {
      impressions: groupReports.reduce((s, g) => s + g.impressions, 0),
      clicks: groupReports.reduce((s, g) => s + g.clicks, 0),
      spent: groupReports.reduce((s, g) => s + g.spent, 0),
      leads: groupReports.reduce((s, g) => s + g.leads, 0),
    };
    const planLeadsFromGroups = groupReports.reduce((s, g) => s + g.leads, 0);
    const planLeads = Math.max(planAgg.leads, planLeadsFromGroups);
    const planDerived = computeDerived({ ...planAgg, leads: planLeads });

    // Determine objective label: prefer package name from first group (more specific)
    // e.g. "Подписка на сообщество" instead of generic "Отправка сообщений"
    const planGroups = planGroupsMap.get(plan.id) || [];
    const firstGroupPackageId = planGroups.length > 0 ? planGroups[0].package_id : undefined;
    const packageName = firstGroupPackageId !== undefined && packageMap
      ? packageMap.get(firstGroupPackageId)
      : undefined;
    const resolvedObjectiveLabel = packageName || getObjectiveLabel(plan.objective || "");

    campaignReports.push({
      id: plan.id,
      name: plan.name,
      status: plan.status,
      objective: plan.objective || "",
      objectiveLabel: resolvedObjectiveLabel,
      groups: groupReports,
      impressions: planAgg.impressions,
      clicks: planAgg.clicks,
      spent: Math.round(planAgg.spent * 100) / 100,
      leads: planLeads,
      ctr: planDerived.ctr,
      cpl: planDerived.cpl,
    });
  }

  return campaignReports;
}

// ─── Internal queries ────────────────────────────────────────────────

/** Get user's ad accounts for report building */
export const getUserAccounts = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
  },
});

// ─── Main action ─────────────────────────────────────────────────────

/** Build a report for a single token, returns an AccountReport */
async function buildAccountReport(
  accessToken: string,
  accountName: string,
  dateFrom: string,
  dateTo: string
): Promise<AccountReport> {
  const [userInfo, data] = await Promise.all([
    callMtApi<MtUserInfo>("user.json", accessToken).catch(() => null),
    fetchAllData(accessToken, dateFrom, dateTo),
  ]);

  const campaignReports = buildReport(
    data.adPlans, data.adGroups, data.banners,
    data.adPlanStatsMap, data.adGroupStatsMap, data.bannerStatsMap,
    data.leadCounts, data.packageMap
  );

  const impressions = campaignReports.reduce((s, c) => s + c.impressions, 0);
  const clicks = campaignReports.reduce((s, c) => s + c.clicks, 0);
  const spent = Math.round(campaignReports.reduce((s, c) => s + c.spent, 0) * 100) / 100;
  const leads = campaignReports.reduce((s, c) => s + c.leads, 0);
  const derived = computeDerived({ impressions, clicks, spent, leads });

  return {
    id: userInfo?.id ?? 0,
    name: accountName || userInfo?.username || "Кабинет",
    campaigns: campaignReports,
    impressions, clicks, spent, leads,
    ctr: derived.ctr,
    cpl: derived.cpl,
  };
}

export const fetchReport = action({
  args: {
    userId: v.id("users"),
    dateFrom: v.string(),
    dateTo: v.string(),
  },
  handler: async (ctx, args): Promise<{
    accounts: AccountReport[];
    dateFrom: string;
    dateTo: string;
  }> => {
    // Get all user's ad accounts
    const adAccounts = await ctx.runQuery(
      internal.reports.getUserAccounts,
      { userId: args.userId }
    );

    if (adAccounts.length === 0) {
      // Fallback: use global token (legacy behavior)
      const accessToken = await ctx.runAction(
        internal.auth.getValidVkAdsToken,
        { userId: args.userId }
      );
      const report = await buildAccountReport(
        accessToken, "", args.dateFrom, args.dateTo
      );
      return { accounts: [report], dateFrom: args.dateFrom, dateTo: args.dateTo };
    }

    const accountReports: AccountReport[] = [];

    // Build report for each account using per-account tokens
    // Group accounts by clientId to avoid duplicate API calls for same credentials
    const processedClientIds = new Set<string>();

    for (const account of adAccounts) {
      const clientKey = account.clientId || account._id;
      if (processedClientIds.has(clientKey)) continue;
      processedClientIds.add(clientKey);

      try {
        const accessToken = await ctx.runAction(
          internal.auth.getValidTokenForAccount,
          { accountId: account._id }
        );
        const report = await buildAccountReport(
          accessToken, account.name, args.dateFrom, args.dateTo
        );
        accountReports.push(report);
      } catch (err) {
        console.error(
          `[reports] Failed to fetch report for account ${account.name}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    return { accounts: accountReports, dateFrom: args.dateFrom, dateTo: args.dateTo };
  },
});

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

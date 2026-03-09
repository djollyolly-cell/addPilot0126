import { v } from "convex/values";
import { action } from "./_generated/server";

// ─── OLD VK API (api.vk.com/method/ads.*) ─────────────────────────
// Kept for backwards compatibility; may work with tokens that have `ads` scope

const VK_API_URL = "https://api.vk.com/method";
const VK_API_VERSION = "5.131";
const RATE_LIMIT_ERROR_CODE = 6;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface VkApiResponse<T> {
  response?: T;
  error?: {
    error_code: number;
    error_msg: string;
  };
}

async function callVkApi<T>(
  method: string,
  accessToken: string,
  params: Record<string, string> = {}
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const urlParams = new URLSearchParams({
      access_token: accessToken,
      v: VK_API_VERSION,
      ...params,
    });

    const response = await fetch(`${VK_API_URL}/${method}?${urlParams.toString()}`);
    const data: VkApiResponse<T> = await response.json();

    if (data.error) {
      if (data.error.error_code === RATE_LIMIT_ERROR_CODE && attempt < MAX_RETRIES - 1) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      if (data.error.error_code === 5) {
        throw new Error("TOKEN_EXPIRED");
      }

      lastError = new Error(`VK API Error: ${data.error.error_msg} (code: ${data.error.error_code})`);
      throw lastError;
    }

    if (data.response === undefined) {
      throw new Error("VK API returned empty response");
    }

    return data.response;
  }

  throw lastError || new Error("VK API request failed after retries");
}

// VK API types (old API)
export interface VkAdAccount {
  account_id: number;
  account_type: string;
  account_status: number;
  account_name: string;
  access_role: string;
}

export interface VkCampaign {
  id: number;
  name: string;
  status: number;
  day_limit: string;
  all_limit: string;
  type: string;
}

export interface VkAd {
  id: number;
  campaign_id: number;
  name: string;
  status: number;
  approved: string;
}

// Old VK API actions (kept for backwards compat)
export const getAccounts = action({
  args: {
    accessToken: v.string(),
  },
  handler: async (_, args): Promise<VkAdAccount[]> => {
    return await callVkApi<VkAdAccount[]>("ads.getAccounts", args.accessToken);
  },
});

export const getCampaigns = action({
  args: {
    accessToken: v.string(),
    accountId: v.string(),
  },
  handler: async (_, args): Promise<VkCampaign[]> => {
    return await callVkApi<VkCampaign[]>("ads.getCampaigns", args.accessToken, {
      account_id: args.accountId,
    });
  },
});

export const getAds = action({
  args: {
    accessToken: v.string(),
    accountId: v.string(),
    campaignIds: v.optional(v.string()),
  },
  handler: async (_, args): Promise<VkAd[]> => {
    const params: Record<string, string> = {
      account_id: args.accountId,
    };
    if (args.campaignIds) {
      params.campaign_ids = args.campaignIds;
    }
    return await callVkApi<VkAd[]>("ads.getAds", args.accessToken, params);
  },
});

// ─── VK ADS API v2 (myTarget / target.my.com) ─────────────────────
// New API for VK Ads (formerly myTarget), uses Bearer token auth

const MT_API_BASE = "https://target.my.com";
const MT_MAX_RETRIES = 3;

// myTarget API types
export interface MtCampaign {
  id: number;
  name: string;
  status: string;
  budget_limit: string;
  budget_limit_day: string;
  created: string;
  updated: string;
}

export interface MtBanner {
  id: number;
  campaign_id: number;
  textblocks?: Record<string, { text: string }>;
  status: string;
  moderation_status: string;
  created: string;
  updated: string;
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

// Get campaigns via myTarget API v2
export const getMtCampaigns = action({
  args: {
    accessToken: v.string(),
  },
  handler: async (_, args): Promise<MtCampaign[]> => {
    const data = await callMtApi<{ items: MtCampaign[]; count: number }>(
      "campaigns.json",
      args.accessToken,
      { fields: "id,name,status,budget_limit,budget_limit_day,created,updated" }
    );
    return data.items || [];
  },
});

// myTarget API types for agency/user
export interface MtUser {
  id: number;
  username: string;
  status: string;
  // Agency flag — present in user response
  agency_id?: number;
}

export interface MtAgencyClient {
  id: number;
  user: {
    id: number;
    username: string;
    status: string;
  };
  status: string;
}

// Get current user info (own account) via myTarget API v2
export const getMtUser = action({
  args: {
    accessToken: v.string(),
  },
  handler: async (_, args): Promise<MtUser> => {
    return await callMtApi<MtUser>("user.json", args.accessToken);
  },
});

// Get agency clients via myTarget API v2
// Returns empty array if not an agency account (403/404)
export const getMtAgencyClients = action({
  args: {
    accessToken: v.string(),
  },
  handler: async (_, args): Promise<MtAgencyClient[]> => {
    try {
      const data = await callMtApi<MtAgencyClient[]>(
        "agency/clients.json",
        args.accessToken,
        { fields: "id,user,status" }
      );
      return data || [];
    } catch (err) {
      // 403/404 means not an agency account — that's fine
      if (
        err instanceof Error &&
        (err.message.includes("403") || err.message.includes("404"))
      ) {
        return [];
      }
      throw err;
    }
  },
});

// myTarget statistics types
// API v2 nests metrics under row.base: { date, base: { shows, clicks, spent, goals, ... } }
// When events metrics requested: row.events: { event_name: { count, ... }, ... }
export interface MtStatBase {
  shows: number;
  clicks: number;
  spent: string; // "250.00"
  goals: number; // leads / conversions
  reach?: number;
  cpa?: string;
  cpc?: string;
  cpm?: string;
  cr?: number;
  ctr?: number;
}

export interface MtStatRow {
  date: string;
  base: MtStatBase;
  events?: Record<string, { count: number; [key: string]: unknown }>;
}

export interface MtStatItem {
  id: number;
  rows: MtStatRow[];
  total?: MtStatRow;
}

// Get banner (ad) statistics via myTarget API v2
// `id` param is required per docs — without it stats return zeros
export const getMtStatistics = action({
  args: {
    accessToken: v.string(),
    dateFrom: v.string(), // "YYYY-MM-DD"
    dateTo: v.string(),   // "YYYY-MM-DD"
    bannerIds: v.optional(v.string()), // comma-separated banner IDs
  },
  handler: async (_, args): Promise<MtStatItem[]> => {
    // If no banner IDs provided, first fetch all banners to get their IDs
    let ids = args.bannerIds;
    if (!ids) {
      const bannersData = await callMtApi<{ items: MtBanner[]; count: number }>(
        "banners.json",
        args.accessToken,
        { fields: "id" }
      );
      const bannerItems = bannersData.items || [];
      if (bannerItems.length === 0) {
        return [];
      }
      ids = bannerItems.map((b: MtBanner) => String(b.id)).join(",");
    }

    const data = await callMtApi<{ items: MtStatItem[]; total: any }>(
      "statistics/banners/day.json",
      args.accessToken,
      {
        id: ids,
        date_from: args.dateFrom,
        date_to: args.dateTo,
        metrics: "base,events",
      }
    );
    return data.items || [];
  },
});

// Stop a banner (ad) via myTarget API v2
export const stopAd = action({
  args: {
    accessToken: v.string(),
    adId: v.string(),
    accountId: v.id("adAccounts"),
  },
  handler: async (_, args): Promise<{ success: boolean }> => {
    const url = `${MT_API_BASE}/api/v2/banners/${args.adId}.json`;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MT_MAX_RETRIES; attempt++) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${args.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "blocked" }),
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
        lastError = new Error(
          `VK Ads API Error ${response.status}: ${text}`
        );
        throw lastError;
      }

      return { success: true };
    }

    throw lastError || new Error("Failed to stop ad after retries");
  },
});

// Restart (unblock) a banner (ad) via myTarget API v2
export const restartAd = action({
  args: {
    accessToken: v.string(),
    adId: v.string(),
    accountId: v.id("adAccounts"),
  },
  handler: async (_, args): Promise<{ success: boolean }> => {
    const url = `${MT_API_BASE}/api/v2/banners/${args.adId}.json`;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MT_MAX_RETRIES; attempt++) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${args.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "active" }),
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
        lastError = new Error(
          `VK Ads API Error ${response.status}: ${text}`
        );
        throw lastError;
      }

      return { success: true };
    }

    throw lastError || new Error("Failed to restart ad after retries");
  },
});

// Get lead counts per banner from myTarget Lead Ads API
// Returns map: bannerId -> lead count
export const getMtLeadCounts = action({
  args: {
    accessToken: v.string(),
    dateFrom: v.string(), // "YYYY-MM-DD"
    dateTo: v.string(),
  },
  handler: async (_, args): Promise<Record<string, number>> => {
    const result: Record<string, number> = {};

    try {
      // Fetch all lead form subscriptions to get form IDs
      const subs = await callMtApi<{ items: Array<{ id: number; banner_id: number }> }>(
        "lead_ads/vkontakte/subscriptions.json",
        args.accessToken,
        {}
      );

      if (!subs.items || subs.items.length === 0) {
        console.log("[vkApi] No lead form subscriptions found");
        return result;
      }

      // Map form IDs to banner IDs
      const formToBanner = new Map<number, number>();
      for (const sub of subs.items) {
        formToBanner.set(sub.id, sub.banner_id);
      }

      // Fetch leads for date range
      const formIds = subs.items.map((s) => s.id).join(",");
      const leads = await callMtApi<{ items: Array<{ form_id: number; leads: Array<{ id: number; created: string }> }> }>(
        "lead_ads/vkontakte/leads.json",
        args.accessToken,
        {
          form_id: formIds,
          date_from: args.dateFrom,
          date_to: args.dateTo,
        }
      );

      if (leads.items) {
        for (const item of leads.items) {
          const bannerId = formToBanner.get(item.form_id);
          if (bannerId) {
            const key = String(bannerId);
            result[key] = (result[key] || 0) + (item.leads?.length || 0);
          }
        }
      }

      console.log(`[vkApi] Lead counts: ${JSON.stringify(result)}`);
    } catch (err) {
      // Lead Ads API might not be available for all accounts — don't fail the sync
      console.warn(
        `[vkApi] Lead Ads API error (non-fatal): ${err instanceof Error ? err.message : err}`
      );
    }

    return result;
  },
});

// Get banners (ads) via myTarget API v2
export const getMtBanners = action({
  args: {
    accessToken: v.string(),
    campaignId: v.optional(v.string()),
  },
  handler: async (_, args): Promise<MtBanner[]> => {
    const params: Record<string, string> = {
      fields: "id,campaign_id,textblocks,status,moderation_status,created,updated",
    };
    if (args.campaignId) {
      params._campaign_id = args.campaignId;
    }
    const data = await callMtApi<{ items: MtBanner[]; count: number }>(
      "banners.json",
      args.accessToken,
      params
    );
    return data.items || [];
  },
});

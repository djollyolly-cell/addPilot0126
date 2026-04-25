import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { action, internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { classifyCampaignPackage } from "./telegram";

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

const FETCH_TIMEOUT_MS = 30_000; // 30s default timeout for VK API requests
const UPLOAD_TIMEOUT_MS = 60_000; // 60s for file uploads

async function fetchWithTimeout(
  url: string | URL,
  options?: RequestInit,
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(url.toString(), { ...options, signal });
  } catch (err: unknown) {
    if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
      throw new Error(`VK_API_TIMEOUT: request timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

// Utility: wrap a promise with a timeout
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT: ${label} exceeded ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
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

    const response = await fetchWithTimeout(`${VK_API_URL}/${method}?${urlParams.toString()}`);
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
  package_id?: number;
  ad_plan_id?: number;
  delivery?: string;
  created: string;
  updated: string;
}

export const UZ_PACKAGE_ID = 960;

export interface MtBannerContentSlot {
  id: number;
  type?: string; // "static" | "video"
  variants?: Record<string, { media_type: string; url?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface MtBanner {
  id: number;
  campaign_id: number;
  textblocks?: Record<string, { text: string }>;
  content?: Record<string, MtBannerContentSlot>;
  status: string;
  moderation_status: string;
  created: string;
  updated: string;
}

/** Return type for rate-limit header extraction. */
export interface RateLimitHeaders {
  rpsLimit?: number;
  rpsRemaining?: number;
  hourlyLimit?: number;
  hourlyRemaining?: number;
  dailyLimit?: number;
  dailyRemaining?: number;
}

/**
 * Extract X-RateLimit-* headers from VK API response.
 * Returns object with all 6 fields, undefined for missing/invalid values.
 * Exported for unit testing.
 */
export function extractRateLimitHeaders(headers: Headers): RateLimitHeaders {
  const num = (key: string): number | undefined => {
    const v = headers.get(key);
    if (v === null) return undefined;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    rpsLimit: num("X-RateLimit-RPS-Limit"),
    rpsRemaining: num("X-RateLimit-RPS-Remaining"),
    hourlyLimit: num("X-RateLimit-Hourly-Limit"),
    hourlyRemaining: num("X-RateLimit-Hourly-Remaining"),
    dailyLimit: num("X-RateLimit-Daily-Limit"),
    dailyRemaining: num("X-RateLimit-Daily-Remaining"),
  };
}

/** Callback info passed to onResponse */
export interface CallMtApiResponseInfo {
  endpoint: string;
  statusCode: number;
  rateLimits: RateLimitHeaders;
}

export async function callMtApi<T>(
  endpoint: string,
  accessToken: string,
  params?: Record<string, string>,
  options?: {
    /** Called after every response (success or error). Fire-and-forget from caller. */
    onResponse?: (info: CallMtApiResponseInfo) => void;
  }
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MT_MAX_RETRIES; attempt++) {
    const url = new URL(`${MT_API_BASE}/api/v2/${endpoint}`);
    if (params) {
      Object.entries(params).forEach(([k, val]) => url.searchParams.set(k, val));
    }

    const response = await fetchWithTimeout(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    // Extract and report rate-limit headers (non-blocking)
    try {
      options?.onResponse?.({
        endpoint,
        statusCode: response.status,
        rateLimits: extractRateLimitHeaders(response.headers),
      });
    } catch {
      // Non-critical: observability callback must never fail the API call
    }

    if (response.status === 429 && attempt < MT_MAX_RETRIES - 1) {
      await sleep(RETRY_DELAY_MS * (attempt + 1));
      continue;
    }

    if (response.status === 401) {
      if (attempt < 1) {
        console.log(`[callMtApi] ${endpoint}: got 401, retrying once in 2s`);
        await sleep(2000);
        continue;
      }
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

// POST helper for myTarget API v2 (create/update resources)
async function postMtApi<T>(
  endpoint: string,
  accessToken: string,
  body: unknown,
  method: "POST" | "DELETE" = "POST"
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MT_MAX_RETRIES; attempt++) {
    const url = `${MT_API_BASE}/api/v2/${endpoint}`;

    const response = await fetchWithTimeout(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (response.status === 429 && attempt < MT_MAX_RETRIES - 1) {
      await sleep(RETRY_DELAY_MS * (attempt + 1));
      continue;
    }

    if (response.status === 401) {
      if (attempt < 1) {
        console.log(`[postMtApi] ${endpoint}: got 401, retrying once in 2s`);
        await sleep(2000);
        continue;
      }
      throw new Error("TOKEN_EXPIRED");
    }

    if (!response.ok) {
      const text = await response.text();
      lastError = new Error(`VK Ads API Error ${response.status}: ${text}`);
      throw lastError;
    }

    return response.json();
  }

  throw lastError || new Error("VK Ads API POST request failed after retries");
}

// Upload file to myTarget content storage (images, videos)
async function uploadMtContent(
  endpoint: string,
  accessToken: string,
  fileData: ArrayBuffer,
  filename: string,
  width?: number,
  height?: number,
): Promise<{ id: number; variants?: Record<string, unknown> }> {
  const formData = new FormData();
  formData.append("file", new Blob([fileData]), filename);
  if (width) formData.append("width", String(width));
  if (height) formData.append("height", String(height));

  const url = `${MT_API_BASE}/api/v2/${endpoint}`;
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: formData,
  }, UPLOAD_TIMEOUT_MS);

  if (response.status === 401) {
    // One retry for upload
    console.log(`[uploadToMt] ${endpoint}: got 401, retrying once in 2s`);
    await sleep(2000);
    const retryResponse = await fetchWithTimeout(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: formData,
    }, UPLOAD_TIMEOUT_MS);
    if (retryResponse.status === 401) throw new Error("TOKEN_EXPIRED");
    if (!retryResponse.ok) {
      const text = await retryResponse.text();
      throw new Error(`VK Ads upload error ${retryResponse.status}: ${text}`);
    }
    return retryResponse.json();
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`VK Ads upload error ${response.status}: ${text}`);
  }

  return response.json();
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
      { fields: "id,name,status,budget_limit,budget_limit_day,package_id,created,updated" }
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
export interface MtStatVk {
  result?: number;
  goals?: number;
  [key: string]: unknown;
}

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
  vk?: MtStatVk;
}

export interface MtStatRow {
  date: string;
  base: MtStatBase;
  events?: Record<string, { count: number; [key: string]: unknown }>;
  video?: MtVideoStats;
}

export interface MtStatItem {
  id: number;
  rows: MtStatRow[];
  total?: MtStatRow;
}

export interface MtVideoStats {
  started?: number;
  first_second?: number;
  viewed_3_seconds?: number;
  viewed_10_seconds?: number;
  viewed_25_percent?: number;
  viewed_50_percent?: number;
  viewed_75_percent?: number;
  viewed_100_percent?: number;
  viewed_3_seconds_rate?: number;
  viewed_25_percent_rate?: number;
  viewed_50_percent_rate?: number;
  viewed_75_percent_rate?: number;
  viewed_100_percent_rate?: number;
  depth_of_view?: number;
  started_cost?: string;
  viewed_3_seconds_cost?: string;
  viewed_100_percent_cost?: string;
}

// Get banner (ad) statistics via myTarget API v2
// `id` param is required per docs — without it stats return zeros
export const getMtStatistics = action({
  args: {
    accessToken: v.string(),
    dateFrom: v.string(), // "YYYY-MM-DD"
    dateTo: v.string(),   // "YYYY-MM-DD"
    bannerIds: v.optional(v.string()), // comma-separated banner IDs
    accountId: v.optional(v.id("adAccounts")),
  },
  handler: async (ctx, args): Promise<MtStatItem[]> => {
    // Rate-limit logger for this account
    const rlOptions = {
      onResponse: (info: CallMtApiResponseInfo) => {
        const hasData =
          info.rateLimits.rpsLimit !== undefined ||
          info.rateLimits.dailyRemaining !== undefined ||
          info.statusCode === 429;
        if (hasData) {
          void ctx.scheduler.runAfter(0, internal.vkApiLimits.recordRateLimit, {
            accountId: args.accountId,
            endpoint: info.endpoint,
            statusCode: info.statusCode,
            ...info.rateLimits,
          });
        }
      },
    };

    // If no banner IDs provided, first fetch all banners to get their IDs
    let ids = args.bannerIds;
    if (!ids) {
      let allBanners: MtBanner[] = [];
      let offset = 0;
      while (true) {
        const bannersData = await callMtApi<{ items: MtBanner[]; count: number }>(
          "banners.json",
          args.accessToken,
          { fields: "id", limit: "250", offset: String(offset) },
          rlOptions
        );
        const items = bannersData.items || [];
        allBanners = allBanners.concat(items);
        if (allBanners.length >= bannersData.count || items.length === 0) break;
        offset += items.length;
      }
      if (allBanners.length === 0) {
        return [];
      }
      ids = allBanners.map((b: MtBanner) => String(b.id)).join(",");
    }

    // Batch IDs into chunks of 200 to avoid 414 URI Too Long
    const CHUNK_SIZE = 200;
    const idArray = ids.split(",");
    const allItems: MtStatItem[] = [];

    for (let i = 0; i < idArray.length; i += CHUNK_SIZE) {
      const chunk = idArray.slice(i, i + CHUNK_SIZE).join(",");
      const data = await callMtApi<{ items: MtStatItem[]; total: MtStatRow | null }>(
        "statistics/banners/day.json",
        args.accessToken,
        {
          id: chunk,
          date_from: args.dateFrom,
          date_to: args.dateTo,
          metrics: "base,events",
        },
        rlOptions
      );
      if (data.items) {
        allItems.push(...data.items);
      }
    }

    return allItems;
  },
});

// Get campaign statistics for today via myTarget API v2
// Returns total spent today (in rubles) for a specific campaign, queried directly from VK API
export const getCampaignSpentToday = internalAction({
  args: {
    accessToken: v.string(),
    campaignId: v.string(), // VK campaign ID (numeric string)
  },
  handler: async (_, args): Promise<number> => {
    // VK API uses Moscow time (UTC+3) for daily stats
    const msk = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const today = msk.toISOString().slice(0, 10);

    try {
      const data = await callMtApi<{ items: MtStatItem[]; total: MtStatRow | null }>(
        "statistics/campaigns/day.json",
        args.accessToken,
        {
          id: args.campaignId,
          date_from: today,
          date_to: today,
          metrics: "base",
        }
      );
      const items = data.items || [];
      if (items.length === 0) return 0;

      // Sum spent across all rows for today
      let totalSpent = 0;
      for (const item of items) {
        for (const row of item.rows || []) {
          totalSpent += parseFloat(row.base?.spent || "0");
        }
      }
      return totalSpent;
    } catch (err) {
      console.error(`[vkApi] getCampaignSpentToday failed for campaign ${args.campaignId}:`, err);
      return 0;
    }
  },
});

/**
 * Batch version: fetch spent today for multiple campaigns in one API call.
 * VK statistics API accepts comma-separated IDs.
 * Chunks into groups of 200 to avoid URL length limits.
 * Returns Map<campaignId, spentRubles>.
 */
export const getCampaignsSpentTodayBatch = internalAction({
  args: {
    accessToken: v.string(),
    campaignIds: v.array(v.string()),
    accountId: v.optional(v.id("adAccounts")),
  },
  handler: async (ctx, args): Promise<Record<string, number>> => {
    if (args.campaignIds.length === 0) return {};

    const msk = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const today = msk.toISOString().slice(0, 10);
    const result: Record<string, number> = {};

    // Rate-limit logger for this account
    const rlOptions = {
      onResponse: (info: CallMtApiResponseInfo) => {
        const hasData =
          info.rateLimits.rpsLimit !== undefined ||
          info.rateLimits.dailyRemaining !== undefined ||
          info.statusCode === 429;
        if (hasData) {
          void ctx.scheduler.runAfter(0, internal.vkApiLimits.recordRateLimit, {
            accountId: args.accountId,
            endpoint: info.endpoint,
            statusCode: info.statusCode,
            ...info.rateLimits,
          });
        }
      },
    };

    // Chunk IDs (200 per request to stay within URL limits)
    const CHUNK_SIZE = 200;
    for (let i = 0; i < args.campaignIds.length; i += CHUNK_SIZE) {
      const chunk = args.campaignIds.slice(i, i + CHUNK_SIZE);
      const idsStr = chunk.join(",");

      try {
        const data = await callMtApi<{ items: MtStatItem[]; total: MtStatRow | null }>(
          "statistics/campaigns/day.json",
          args.accessToken,
          {
            id: idsStr,
            date_from: today,
            date_to: today,
            metrics: "base",
          },
          rlOptions
        );

        for (const item of data.items || []) {
          let totalSpent = 0;
          for (const row of item.rows || []) {
            totalSpent += parseFloat(row.base?.spent || "0");
          }
          result[String(item.id)] = totalSpent;
        }
      } catch (err) {
        console.error(`[vkApi] getCampaignsSpentTodayBatch failed for chunk starting at ${i}:`, err);
        // On error, campaigns in this chunk get 0 (not in result map)
      }
    }

    return result;
  },
});

// Get banner statistics WITH video metrics (started, viewed 25/50/75/100%)
// myTarget API v2: metrics=base,video returns video completion data
// Verified: API returns video.started, video.viewed_25_percent, etc.
export const getMtVideoStatistics = action({
  args: {
    accessToken: v.string(),
    dateFrom: v.string(),
    dateTo: v.string(),
    bannerIds: v.string(), // comma-separated banner IDs (required)
  },
  handler: async (_, args): Promise<MtStatItem[]> => {
    const data = await callMtApi<{ items: MtStatItem[]; total: MtStatRow | null }>(
      "statistics/banners/day.json",
      args.accessToken,
      {
        id: args.bannerIds,
        date_from: args.dateFrom,
        date_to: args.dateTo,
        metrics: "base,video",
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
      const response = await fetchWithTimeout(url, {
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
        if (attempt < 1) {
          console.log(`[stopAd] banner ${args.adId}: got 401, retrying once in 2s`);
          await sleep(2000);
          continue;
        }
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
      const response = await fetchWithTimeout(url, {
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
        if (attempt < 1) {
          console.log(`[restartAd] banner ${args.adId}: got 401, retrying once in 2s`);
          await sleep(2000);
          continue;
        }
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
    accountId: v.optional(v.id("adAccounts")),
  },
  handler: async (ctx, args): Promise<Record<string, number>> => {
    const result: Record<string, number> = {};

    // Rate-limit logger for this account
    const rlOptions = {
      onResponse: (info: CallMtApiResponseInfo) => {
        const hasData =
          info.rateLimits.rpsLimit !== undefined ||
          info.rateLimits.dailyRemaining !== undefined ||
          info.statusCode === 429;
        if (hasData) {
          void ctx.scheduler.runAfter(0, internal.vkApiLimits.recordRateLimit, {
            accountId: args.accountId,
            endpoint: info.endpoint,
            statusCode: info.statusCode,
            ...info.rateLimits,
          });
        }
      },
    };

    try {
      // Fetch all lead form subscriptions to get form IDs
      const subs = await callMtApi<{ items: Array<{ id: number; banner_id: number }> }>(
        "lead_ads/vkontakte/subscriptions.json",
        args.accessToken,
        {},
        rlOptions
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
        },
        rlOptions
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
      // But log as ERROR so it's visible in monitoring
      console.error(
        `[vkApi] Lead Ads API error (non-fatal, leads may be undercounted!): ${err instanceof Error ? err.message : err}`
      );
    }

    return result;
  },
});

// Fetch lead details (phone, email, name) from Lead Ads API
// Plain function (not a Convex action) — called directly from clientReport.buildReport
export async function fetchLeadDetails(
  accessToken: string,
  dateFrom: string,
  dateTo: string,
): Promise<Array<{
  vkLeadId: number;
  formId: number;
  bannerId: number;
  createdAt: number;
  phone?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}>> {
  const subs = await callMtApi<{ items: Array<{ id: number; banner_id: number }> }>(
    "lead_ads/vkontakte/subscriptions.json",
    accessToken,
    { limit: "250" }
  );
  if (!subs.items || subs.items.length === 0) return [];

  const formToBanner = new Map<number, number>();
  for (const sub of subs.items) {
    formToBanner.set(sub.id, sub.banner_id);
  }

  const leads: Array<{
    vkLeadId: number;
    formId: number;
    bannerId: number;
    createdAt: number;
    phone?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
  }> = [];

  const formIds = subs.items.map((s) => s.id).join(",");
  const data = await callMtApi<{
    items: Array<{
      form_id: number;
      leads: Array<{
        id: number;
        created: string;
        banner_id?: number;
        data: Record<string, string>;
      }>;
    }>;
  }>(
    "lead_ads/vkontakte/leads.json",
    accessToken,
    {
      form_id: formIds,
      date_from: dateFrom,
      date_to: dateTo,
      limit: "250",
    }
  );

  for (const form of data.items ?? []) {
    const bannerId = formToBanner.get(form.form_id) ?? 0;
    for (const lead of form.leads ?? []) {
      leads.push({
        vkLeadId: lead.id,
        formId: form.form_id,
        bannerId: lead.banner_id ?? bannerId,
        createdAt: new Date(lead.created).getTime(),
        phone: lead.data?.phone,
        email: lead.data?.email,
        firstName: lead.data?.name,
        lastName: lead.data?.surname,
      });
    }
  }
  return leads;
}

// Get ad_plans (VK Ads campaigns) via myTarget API v2
// This is the authoritative source for campaign data (more complete than campaigns.json)
export const getMtAdPlans = action({
  args: {
    accessToken: v.string(),
  },
  handler: async (_, args): Promise<{
    id: number;
    name: string;
    status: string;
    objective: string;
    budget_limit: number | null;
    budget_limit_day: number | null;
  }[]> => {
    const data = await callMtApi<{ items: { id: number; name: string; status: string; objective: string; budget_limit: number | null; budget_limit_day: number | null }[]; count: number }>(
      "ad_plans.json",
      args.accessToken,
      { fields: "id,name,status,objective,budget_limit,budget_limit_day", limit: "250", _status__in: "active,blocked" }
    );
    return data.items || [];
  },
});

/** Fetch ad_groups (campaigns.json) for ad_group_id → ad_plan_id mapping */
export const getMtAdGroups = internalAction({
  args: { accessToken: v.string() },
  handler: async (_, args): Promise<{ id: number; ad_plan_id: number }[]> => {
    const result: { id: number; ad_plan_id: number }[] = [];
    let offset = 0;
    const LIMIT = 50;
    while (true) {
      const res = await callMtApi<{ items: { id: number; ad_plan_id: number }[] }>(
        "campaigns.json",
        args.accessToken,
        { fields: "id,ad_plan_id", limit: String(LIMIT), offset: String(offset), _status__in: "active,blocked" }
      );
      const items = res.items || [];
      for (const g of items) {
        result.push({ id: g.id, ad_plan_id: g.ad_plan_id });
      }
      if (items.length < LIMIT) break;
      offset += LIMIT;
    }
    return result;
  },
});

// Get banners (ads) via myTarget API v2
export const getMtBanners = action({
  args: {
    accessToken: v.string(),
    campaignId: v.optional(v.string()),
    accountId: v.optional(v.id("adAccounts")),
  },
  handler: async (ctx, args): Promise<MtBanner[]> => {
    // Rate-limit logger for this account
    const rlOptions = {
      onResponse: (info: CallMtApiResponseInfo) => {
        const hasData =
          info.rateLimits.rpsLimit !== undefined ||
          info.rateLimits.dailyRemaining !== undefined ||
          info.statusCode === 429;
        if (hasData) {
          void ctx.scheduler.runAfter(0, internal.vkApiLimits.recordRateLimit, {
            accountId: args.accountId,
            endpoint: info.endpoint,
            statusCode: info.statusCode,
            ...info.rateLimits,
          });
        }
      },
    };

    const params: Record<string, string> = {
      fields: "id,campaign_id,textblocks,status,moderation_status,created,updated,content",
      limit: "250",
      _status__in: "active,blocked",
    };
    if (args.campaignId) {
      params._campaign_id = args.campaignId;
    }
    // Fetch all banners with pagination
    let allBanners: MtBanner[] = [];
    let offset = 0;
    while (true) {
      params.offset = String(offset);
      const data = await callMtApi<{ items: MtBanner[]; count: number }>(
        "banners.json",
        args.accessToken,
        params,
        rlOptions
      );
      const items = data.items || [];
      allBanners = allBanners.concat(items);
      if (allBanners.length >= data.count || items.length === 0) break;
      offset += items.length;
    }
    return allBanners;
  },
});

// ─── DIAGNOSTIC: Raw VK API response for specific ads ─────────────
// Shows exactly what myTarget API returns for goals, events, lead ads
export const diagnosLeads = action({
  args: {
    accessToken: v.string(),
    bannerIds: v.string(), // comma-separated
    dateFrom: v.string(),
    dateTo: v.string(),
  },
  handler: async (_, args) => {
    const result: Record<string, unknown> = {};

    // 1. Raw statistics with ALL available metrics
    try {
      const statsRaw = await callMtApi<unknown>(
        "statistics/banners/day.json",
        args.accessToken,
        {
          id: args.bannerIds,
          date_from: args.dateFrom,
          date_to: args.dateTo,
          metrics: "base,events",
        }
      );
      result.rawStats = statsRaw;
    } catch (e) {
      result.rawStatsError = e instanceof Error ? e.message : String(e);
    }

    // 2. Campaign info with objective
    try {
      const campaigns = await callMtApi<unknown>(
        "campaigns.json",
        args.accessToken,
        {
          fields: "id,name,status,objective,mixing,package_id,pricelist_id,budget_limit,budget_limit_day,created,updated",
        }
      );
      result.campaigns = campaigns;
    } catch (e) {
      result.campaignsError = e instanceof Error ? e.message : String(e);
    }

    // 3. Lead Ads subscriptions
    try {
      const subs = await callMtApi<unknown>(
        "lead_ads/vkontakte/subscriptions.json",
        args.accessToken,
        {}
      );
      result.leadAdsSubs = subs;
    } catch (e) {
      result.leadAdsSubsError = e instanceof Error ? e.message : String(e);
    }

    // 4. Lead Ads leads (no form_id filter — get all)
    try {
      const leads = await callMtApi<unknown>(
        "lead_ads/vkontakte/leads.json",
        args.accessToken,
        {
          date_from: args.dateFrom,
          date_to: args.dateTo,
        }
      );
      result.leadAdsLeads = leads;
    } catch (e) {
      result.leadAdsLeadsError = e instanceof Error ? e.message : String(e);
    }

    return result;
  },
});

// ─── DIAGNOSTIC: Probe myTarget API endpoints for VK Ads campaign level ───
// myTarget campaigns.json = VK Ads groups. Need to find the parent level (VK Ads campaigns).
export const probeVkCampaignEndpoints = action({
  args: {
    accessToken: v.string(),
  },
  handler: async (_, args) => {
    const results: Record<string, unknown> = {};

    const endpoints = [
      { name: "packages", url: "packages.json", params: { fields: "id,name,status,price_list_id,created,updated" } },
      { name: "ad_plans", url: "ad_plans.json", params: { fields: "id,name,status,created,updated" } },
      { name: "project_packages", url: "project_packages.json", params: {} },
      { name: "ad_groups", url: "ad_groups.json", params: {} },
      { name: "campaigns_extended", url: "campaigns.json", params: {
        fields: "id,name,status,objective,package_id,mixing,pricelist_id,budget_limit,budget_limit_day,created,updated",
        limit: "50",
      }},
      { name: "pads", url: "pads.json", params: {} },
    ];

    for (const ep of endpoints) {
      try {
        const url = new URL(`${MT_API_BASE}/api/v2/${ep.url}`);
        Object.entries(ep.params).forEach(([k, v]) => url.searchParams.set(k, v));

        const response = await fetchWithTimeout(url.toString(), {
          headers: { Authorization: `Bearer ${args.accessToken}` },
        });

        const status = response.status;
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          body = await response.text();
        }

        results[ep.name] = { status, body };
      } catch (e) {
        results[ep.name] = { error: e instanceof Error ? e.message : String(e) };
      }
    }

    return results;
  },
});

/** Ad group mapping entry: adGroupId → type + adPlanId */
export interface AdGroupMapping {
  adGroupId: string;
  adPlanId: number;
  type: string;
}

/** Fetch ad group mapping: adGroupId → { adPlanId, type } via ad_groups.json + packages.json */
export const getCampaignTypeMap = internalAction({
  args: {
    accessToken: v.string(),
  },
  handler: async (_, args): Promise<AdGroupMapping[]> => {
    try {
      // packages.json: package_id → name for classification
      const packagesRes = await callMtApi<{ items: { id: number; name: string }[] }>(
        "packages.json", args.accessToken,
        { fields: "id,name", limit: "50" }
      );

      const packageNameMap = new Map<number, string>();
      for (const pkg of packagesRes.items || []) {
        packageNameMap.set(pkg.id, pkg.name);
      }

      // ad_groups.json: id, ad_plan_id, package_id
      // ad_group_id = metricsDaily.campaignId (banner.campaign_id)
      // ad_plan_id = VK Ads Campaign (what user sees in cabinet)
      const result: AdGroupMapping[] = [];
      let offset = 0;
      const LIMIT = 50;
      while (true) {
        const groupsRes = await callMtApi<{ items: { id: number; ad_plan_id: number; package_id: number }[] }>(
          "ad_groups.json", args.accessToken,
          { fields: "id,ad_plan_id,package_id", limit: String(LIMIT), offset: String(offset) }
        );
        const items = groupsRes.items || [];
        for (const g of items) {
          const packageName = packageNameMap.get(g.package_id) || "";
          result.push({
            adGroupId: String(g.id),
            adPlanId: g.ad_plan_id,
            type: classifyCampaignPackage(packageName),
          });
        }
        if (items.length < LIMIT) break;
        offset += LIMIT;
      }

      return result;
    } catch {
      return [];
    }
  },
});

/** Classify specific ad_groups by their IDs — fetches only requested groups via _id__in filter */
export const classifyAdGroupsByIds = internalAction({
  args: {
    accessToken: v.string(),
    adGroupIds: v.array(v.string()),
  },
  handler: async (_, args): Promise<AdGroupMapping[]> => {
    if (args.adGroupIds.length === 0) return [];
    try {
      // packages.json: package_id → name (VK returns all in one call, limit max 50)
      const packagesRes = await callMtApi<{ items: { id: number; name: string }[] }>(
        "packages.json", args.accessToken,
        { fields: "id,name", limit: "50" }
      );
      const packageNameMap = new Map<number, string>();
      for (const pkg of packagesRes.items || []) {
        packageNameMap.set(pkg.id, pkg.name);
      }

      // Batch-fetch ad_groups by specific IDs (50 per request)
      const result: AdGroupMapping[] = [];
      const BATCH = 50;
      for (let i = 0; i < args.adGroupIds.length; i += BATCH) {
        const batch = args.adGroupIds.slice(i, i + BATCH);
        const groupsRes = await callMtApi<{ items: { id: number; ad_plan_id: number; package_id: number }[] }>(
          "ad_groups.json", args.accessToken,
          { fields: "id,ad_plan_id,package_id", _id__in: batch.join(",") }
        );
        for (const g of groupsRes.items || []) {
          const packageName = packageNameMap.get(g.package_id) || "";
          result.push({
            adGroupId: String(g.id),
            adPlanId: g.ad_plan_id,
            type: classifyCampaignPackage(packageName),
          });
        }
      }
      return result;
    } catch {
      return [];
    }
  },
});

/** Fetch ad_plans (VK Ads Campaigns): id → name */
export const getAdPlanNames = internalAction({
  args: {
    accessToken: v.string(),
  },
  handler: async (_, args): Promise<Array<{ id: number; name: string }>> => {
    try {
      const result: Array<{ id: number; name: string }> = [];
      let offset = 0;
      const LIMIT = 50;
      while (true) {
        const res = await callMtApi<{ items: { id: number; name: string }[] }>(
          "ad_plans.json", args.accessToken,
          { fields: "id,name", limit: String(LIMIT), offset: String(offset) }
        );
        const items = res.items || [];
        for (const p of items) {
          result.push({ id: p.id, name: p.name });
        }
        if (items.length < LIMIT) break;
        offset += LIMIT;
      }
      return result;
    } catch {
      return [];
    }
  },
});

// TEMP: Diagnostic — show package_id → name mapping for ad_groups
export const diagnosPackages = action({
  args: {
    accessToken: v.string(),
  },
  handler: async (_, args): Promise<unknown> => {
    const [packagesRes, adPlansRes, adGroupsRes] = await Promise.all([
      callMtApi<{ items: { id: number; name: string; status: string }[] }>(
        "packages.json", args.accessToken,
        { fields: "id,name,status", limit: "200" }
      ),
      callMtApi<{ items: { id: number; name: string; status: string; objective: string }[] }>(
        "ad_plans.json", args.accessToken,
        { fields: "id,name,status,objective", limit: "100" }
      ),
      callMtApi<{ items: { id: number; name: string; status: string; ad_plan_id: number; package_id: number }[] }>(
        "ad_groups.json", args.accessToken,
        { fields: "id,name,status,ad_plan_id,package_id", limit: "100" }
      ),
    ]);

    const packageMap: Record<number, string> = {};
    for (const pkg of packagesRes.items || []) {
      packageMap[pkg.id] = pkg.name;
    }

    const adGroups = (adGroupsRes.items || []).map((g) => ({
      id: g.id,
      name: g.name,
      ad_plan_id: g.ad_plan_id,
      package_id: g.package_id,
      package_name: packageMap[g.package_id] || "unknown",
    }));

    return {
      packageMap,
      ad_plans: (adPlansRes.items || []).map((p) => ({
        id: p.id, name: p.name, status: p.status, objective: p.objective,
      })),
      ad_groups: adGroups,
    };
  },
});

// ─── AI CABINET: Campaign & Banner CRUD ──────────────────────────

export interface MtPackage {
  id: number;
  name: string;
  description?: string;
  status: string;
  price_per_show?: string;
  price_per_click?: string;
  banner_format?: unknown;
  targetings?: unknown;
}

export interface MtRegion {
  id: number;
  name: string;
  level?: number;
  type?: string;
  children?: MtRegion[];
}

// Get available ad packages (formats/objectives)
export const getMtPackages = action({
  args: { accessToken: v.string() },
  handler: async (_, args): Promise<MtPackage[]> => {
    const data = await callMtApi<{ items: MtPackage[]; count: number }>(
      "packages.json",
      args.accessToken,
      { limit: "100" }
    );
    return data.items || [];
  },
});

// Get regions tree for geo targeting
export const getMtRegions = action({
  args: { accessToken: v.string() },
  handler: async (_, args): Promise<MtRegion[]> => {
    return callMtApi<MtRegion[]>("regions.json", args.accessToken);
  },
});

// Create a campaign in myTarget
export const createMtCampaign = action({
  args: {
    accessToken: v.string(),
    name: v.string(),
    packageId: v.number(),
    targetings: v.any(),
    dailyBudget: v.string(),
    url: v.optional(v.string()),
  },
  handler: async (_, args) => {
    const body: Record<string, unknown> = {
      name: args.name,
      package: { id: args.packageId },
      targetings: args.targetings,
      budget_limit_day: args.dailyBudget,
      mixing: "recommended",
      autobidding_mode: "second_price_mean",
    };
    if (args.url) body.url = args.url;

    return postMtApi<MtCampaign>("campaigns.json", args.accessToken, body);
  },
});

// Create a banner (ad) in a campaign
export const createMtBanner = action({
  args: {
    accessToken: v.string(),
    campaignId: v.number(),
    textblocks: v.any(),
    content: v.any(),
    url: v.string(),
  },
  handler: async (_, args) => {
    const body = {
      campaign_id: args.campaignId,
      textblocks: args.textblocks,
      content: args.content,
      url: args.url,
    };
    return postMtApi<MtBanner>("banners.json", args.accessToken, body);
  },
});

// Update campaign (status, budget, targetings)
// Uses fallback for new VK Ads accounts (ad_plans endpoint)
export const updateMtCampaign = action({
  args: {
    accessToken: v.string(),
    campaignId: v.number(),
    data: v.any(),
  },
  handler: async (_, args) => {
    // Convert data to Record<string, string> for postCampaignWithFallback
    const body: Record<string, string> = {};
    for (const [key, val] of Object.entries(args.data as Record<string, unknown>)) {
      body[key] = String(val);
    }
    return postCampaignWithFallback(args.accessToken, args.campaignId, body);
  },
});

// Update banner (status, content, textblocks)
export const updateMtBanner = action({
  args: {
    accessToken: v.string(),
    bannerId: v.number(),
    data: v.any(),
  },
  handler: async (_, args) => {
    return postMtApi<MtBanner>(
      `banners/${args.bannerId}.json`,
      args.accessToken,
      args.data
    );
  },
});

// Upload image to myTarget content storage
export const uploadMtImage = action({
  args: {
    accessToken: v.string(),
    imageData: v.string(), // base64 encoded
    filename: v.string(),
    width: v.number(),
    height: v.number(),
  },
  handler: async (_, args) => {
    // Decode base64 to ArrayBuffer
    const binaryStr = atob(args.imageData);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    return uploadMtContent(
      "content/static.json",
      args.accessToken,
      bytes.buffer,
      args.filename,
      args.width,
      args.height
    );
  },
});

// ─── UZ Budget Management (internal actions for ruleEngine) ──────

/**
 * Get campaigns with package_id field, optionally filtered.
 */
export const getCampaignsForAccount = internalAction({
  args: {
    accessToken: v.string(),
    packageId: v.optional(v.number()),
  },
  handler: async (_, args): Promise<MtCampaign[]> => {
    // Paginate through all campaigns (API default limit is ~20)
    const allCampaigns: MtCampaign[] = [];
    let offset = 0;
    const LIMIT = 250;
    while (true) {
      const data = await callMtApi<{ items: MtCampaign[]; count: number }>(
        "campaigns.json",
        args.accessToken,
        { fields: "id,name,status,package_id,budget_limit,budget_limit_day,delivery,ad_plan_id", limit: String(LIMIT), offset: String(offset), _status__in: "active,blocked" }
      );
      const items = data.items || [];
      allCampaigns.push(...items);
      if (items.length < LIMIT) break;
      offset += LIMIT;
    }
    if (args.packageId !== undefined) {
      return allCampaigns.filter((c) => c.package_id === args.packageId);
    }
    return allCampaigns;
  },
});

/**
 * POST to campaigns or ad_plans endpoint with automatic fallback.
 * New VK Ads accounts use ad_plans (not campaigns) for budget/status changes.
 * Strategy: try campaigns/{id} first (legacy). If "unallowed_value" error →
 * look up ad_plan_id via ad_groups/{id} → retry via ad_plans/{ad_plan_id}.
 */
async function postCampaignWithFallback(
  accessToken: string,
  campaignId: number,
  body: Record<string, string>,
): Promise<MtCampaign> {
  // 1. Try legacy endpoint: campaigns/{id}.json
  const legacyUrl = `${MT_API_BASE}/api/v2/campaigns/${campaignId}.json`;
  const legacyResp = await fetchWithTimeout(legacyUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (legacyResp.status === 401) throw new Error("TOKEN_EXPIRED");

  if (legacyResp.ok) {
    const text = await legacyResp.text();
    if (text.trim()) return JSON.parse(text) as MtCampaign;
    return { id: campaignId } as unknown as MtCampaign;
  }

  // Check if this is a new-format account error
  const errorText = await legacyResp.text();
  if (!errorText.includes("unallowed_value")) {
    throw new Error(`VK Ads API Error ${legacyResp.status}: ${errorText}`);
  }

  // 2. New VK Ads format — try ad_groups/{id}.json first
  // ad_groups is preferred for status changes (no cascade risk).
  const groupPostUrl = `${MT_API_BASE}/api/v2/ad_groups/${campaignId}.json`;
  const groupPostResp = await fetchWithTimeout(groupPostUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (groupPostResp.status === 401) throw new Error("TOKEN_EXPIRED");

  if (groupPostResp.ok) {
    const groupText = await groupPostResp.text();
    if (groupText.trim()) return JSON.parse(groupText) as MtCampaign;
    return { id: campaignId } as unknown as MtCampaign;
  }

  const groupErr = await groupPostResp.text();

  // 3. If ad_groups also fails with unallowed_value AND this is a budget-only write,
  // fall back to ad_plans. Some VK Ads accounts only accept budget at ad_plan level.
  // NEVER write status to ad_plans — it cascades to ALL sibling ad_groups.
  const isBudgetOnly = "budget_limit_day" in body && !("status" in body);
  if (!isBudgetOnly || !groupErr.includes("unallowed_value")) {
    throw new Error(
      `VK Ads API Error ${groupPostResp.status} (ad_group ${campaignId}): ${groupErr}`,
    );
  }

  // Lookup ad_plan_id for this ad_group
  const lookupUrl = new URL(`${MT_API_BASE}/api/v2/ad_groups.json`);
  lookupUrl.searchParams.set("_id", String(campaignId));
  lookupUrl.searchParams.set("fields", "id,ad_plan_id");
  const lookupResp = await fetchWithTimeout(lookupUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (lookupResp.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!lookupResp.ok) {
    throw new Error(
      `Failed to look up ad_group ${campaignId}: ${await lookupResp.text()}`,
    );
  }
  const lookupData = (await lookupResp.json()) as {
    items?: Array<{ id: number; ad_plan_id?: number }>;
  };
  const adPlanId = lookupData.items?.find((g) => g.id === campaignId)?.ad_plan_id;
  if (!adPlanId) {
    throw new Error(
      `ad_group ${campaignId} has no ad_plan_id — cannot set budget via ad_plans`,
    );
  }

  // POST budget to ad_plans (budget only, never status)
  const planUrl = `${MT_API_BASE}/api/v2/ad_plans/${adPlanId}.json`;
  const planResp = await fetchWithTimeout(planUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (planResp.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!planResp.ok) {
    const planErr = await planResp.text();
    throw new Error(
      `VK Ads API Error ${planResp.status} (ad_plan ${adPlanId}): ${planErr}`,
    );
  }
  const planText = await planResp.text();
  if (planText.trim()) return JSON.parse(planText) as MtCampaign;
  return { id: adPlanId } as unknown as MtCampaign;
}

/**
 * Set daily budget on a campaign (group).
 * Supports both legacy myTarget accounts (campaigns endpoint)
 * and new VK Ads accounts (ad_plans endpoint via fallback).
 * @param newLimitRubles — budget in rubles (API accepts rubles directly)
 */
export const setCampaignBudget = internalAction({
  args: {
    accessToken: v.string(),
    campaignId: v.number(),
    newLimitRubles: v.number(),
  },
  handler: async (_, args) => {
    return await postCampaignWithFallback(
      args.accessToken,
      args.campaignId,
      { budget_limit_day: String(Math.round(args.newLimitRubles)) },
    );
  },
});

/**
 * Activate a campaign (resume after budget block).
 * Supports both legacy myTarget and new VK Ads accounts.
 * Also checks parent ad_plan — if it's blocked, activates it too.
 */
export const resumeCampaign = internalAction({
  args: {
    accessToken: v.string(),
    campaignId: v.number(),
    excludeBannerIds: v.optional(v.array(v.string())),
  },
  handler: async (_, args) => {
    const excludeSet = new Set(args.excludeBannerIds ?? []);
    // 1. Activate the campaign/group itself
    const result = await postCampaignWithFallback(
      args.accessToken,
      args.campaignId,
      { status: "active" },
    );

    // 2. Parent ad_plan: do NOT activate it here.
    // Activating ad_plan cascades to ALL sibling ad_groups — dangerous when one ad_plan
    // has many children (e.g. 218 in one user's case). Budget write via
    // postCampaignWithFallback already targets ad_plan level for new accounts,
    // which may auto-unblock it via budget increase.

    // 3. Unblock banners — VK blocks them cascade with ad_plan/group
    try {
      const bannersData = await callMtApi<{ items: Array<{ id: number; status: string }> }>(
        "banners.json",
        args.accessToken,
        { campaign_id: String(args.campaignId), fields: "id,status", limit: "250" }
      );
      const blocked = (bannersData.items || []).filter(b => b.status === "blocked");
      if (blocked.length > 0) {
        let activated = 0;
        let skippedByRule = 0;
        for (const b of blocked) {
          // Skip banners stopped by rules or user — don't override intentional stops
          if (excludeSet.has(String(b.id))) {
            skippedByRule++;
            continue;
          }
          try {
            const bResp = await fetchWithTimeout(`${MT_API_BASE}/api/v2/banners/${b.id}.json`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${args.accessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ status: "active" }),
            });
            if (bResp.ok) activated++;
          } catch { /* best-effort per banner */ }
        }
        if (activated > 0 || skippedByRule > 0) {
          console.log(`[resumeCampaign] Campaign ${args.campaignId}: activated ${activated}, skipped ${skippedByRule} rule-stopped (total blocked: ${blocked.length})`);
        }
      }
    } catch (err) {
      console.warn(`[resumeCampaign] banner unblock failed for campaign ${args.campaignId}:`, err);
    }

    return result;
  },
});

/** Verify campaign budget/status after update — read back from VK API */
export const verifyCampaignState = internalAction({
  args: {
    accessToken: v.string(),
    campaignId: v.number(),
  },
  handler: async (_, args): Promise<{ budget: number; status: string; delivery: string } | null> => {
    try {
      const data = await callMtApi<{ items: MtCampaign[]; count: number }>(
        "campaigns.json",
        args.accessToken,
        { _id: String(args.campaignId), fields: "id,status,budget_limit_day,delivery" }
      );
      const camp = data.items?.[0];
      if (!camp) return null;
      return {
        budget: Number(camp.budget_limit_day || 0),
        status: camp.status || "unknown",
        delivery: (camp as unknown as { delivery?: string }).delivery || "unknown",
      };
    } catch {
      return null;
    }
  },
});

/** Get active accounts for a user (used by fetchUzCampaigns) */
export const getActiveAccountsForUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .filter((q) => q.eq(q.field("status"), "active"))
      .collect();
  },
});

/** TEMP: Debug — find target campaigns + parent ad_plans statuses */
export const debugUzData = action({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const accessToken: string = await ctx.runAction(
      internal.auth.getValidTokenForAccount,
      { accountId: args.accountId }
    );

    // Paginate ALL campaigns to find targets
    const targetIds = [133593859, 133593860, 133593425];
    const allCampaigns: Array<Record<string, unknown>> = [];
    let offset = 0;
    while (true) {
      const res = await callMtApi<{ items: Array<Record<string, unknown>>; count: number }>(
        "campaigns.json", accessToken,
        { fields: "id,name,status,ad_plan_id,budget_limit_day,delivery,efficiency_status", limit: "250", offset: String(offset) }
      );
      const items = res.items || [];
      allCampaigns.push(...items);
      if (items.length < 250) break;
      offset += 250;
    }

    const targets = allCampaigns.filter((c) => targetIds.includes(c.id as number));

    // Get parent ad_plan IDs
    const parentPlanIds = [...new Set(targets.map((c) => c.ad_plan_id as number))];

    // Fetch parent ad_plans by ID
    const adPlansRes = await callMtApi<{ items: Array<Record<string, unknown>> }>(
      "ad_plans.json", accessToken,
      { fields: "id,name,status,budget_limit,budget_limit_day,delivery", _id: parentPlanIds.join(",") }
    );
    let parentPlans = (adPlansRes.items || []).filter((p) => parentPlanIds.includes(p.id as number));
    // If not found, paginate
    if (parentPlans.length === 0) {
      const allPlans: Array<Record<string, unknown>> = [];
      let planOffset = 0;
      while (true) {
        const res = await callMtApi<{ items: Array<Record<string, unknown>> }>(
          "ad_plans.json", accessToken,
          { fields: "id,name,status,budget_limit,budget_limit_day,delivery", limit: "50", offset: String(planOffset) }
        );
        const items = res.items || [];
        allPlans.push(...items);
        if (items.length < 50) break;
        planOffset += 50;
      }
      parentPlans = allPlans.filter((p) => parentPlanIds.includes(p.id as number));
    }

    // Fetch banners (ads) for target campaigns to understand why not_delivering
    const targetCampaignIds = targets.map((c) => c.id as number);
    let allBanners: Array<Record<string, unknown>> = [];
    if (targetCampaignIds.length > 0) {
      try {
        const bannersRes = await callMtApi<{ items: Array<Record<string, unknown>>; count: number }>(
          "banners.json", accessToken,
          { fields: "id,campaign_id,status,moderation_status,delivery,textblocks", _campaign_id: targetCampaignIds.join(","), limit: "50" }
        );
        allBanners = bannersRes.items || [];
      } catch (e) {
        allBanners = [{ error: e instanceof Error ? e.message : "fetch failed" }];
      }
    }

    // Also fetch issues for target campaigns
    const campaignIssues: Array<Record<string, unknown>> = [];
    for (const cid of targetCampaignIds.slice(0, 3)) {
      try {
        const issueRes = await callMtApi<Record<string, unknown>>(
          `campaigns/${cid}.json`, accessToken,
          { fields: "id,name,status,delivery,issues,moderation_status,audit_pixels" }
        );
        campaignIssues.push(issueRes);
      } catch (e) {
        campaignIssues.push({ id: cid, error: e instanceof Error ? e.message : "fetch failed" });
      }
    }

    return {
      total_campaigns: allCampaigns.length,
      target_campaigns: targets,
      parent_ad_plans: parentPlans,
      banners_in_target_campaigns: allBanners,
      campaign_details: campaignIssues,
      all_campaign_statuses: [...new Set(allCampaigns.map((c) => c.status))],
      all_ad_plan_statuses: [...new Set((adPlansRes.items || []).map((p) => p.status))],
    };
  },
});

/** TEMP: Check specific ad_plan details — budget, status, delivery, all fields */
export const diagnosAdPlan = action({
  args: { accountId: v.id("adAccounts"), adPlanIds: v.array(v.number()) },
  handler: async (ctx, args) => {
    const accessToken: string = await ctx.runAction(
      internal.auth.getValidTokenForAccount,
      { accountId: args.accountId }
    );

    const results: Array<Record<string, unknown>> = [];
    // Fetch each ad_plan individually for full detail
    for (const planId of args.adPlanIds) {
      try {
        const url = `${MT_API_BASE}/api/v2/ad_plans/${planId}.json`;
        const resp = await fetchWithTimeout(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!resp.ok) {
          results.push({ id: planId, error: `HTTP ${resp.status}: ${await resp.text()}` });
          continue;
        }
        const data = await resp.json();
        results.push(data);
      } catch (err) {
        results.push({ id: planId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Also fetch ad_groups under these plans
    const groupResults: Array<Record<string, unknown>> = [];
    for (const planId of args.adPlanIds) {
      try {
        const data = await callMtApi<{ items: Array<Record<string, unknown>> }>(
          "ad_groups.json", accessToken,
          { fields: "id,name,status,ad_plan_id,budget_limit_day,budget_limit,delivery", _ad_plan_id: String(planId), limit: "50" }
        );
        groupResults.push({ ad_plan_id: planId, groups: data.items || [] });
      } catch (err) {
        groupResults.push({ ad_plan_id: planId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Fetch banners for first 3 groups
    const bannerResults: Array<Record<string, unknown>> = [];
    const firstGroups = groupResults[0] && !('error' in groupResults[0])
      ? ((groupResults[0] as { groups: Array<{ id: number }> }).groups || []).slice(0, 3)
      : [];
    for (const grp of firstGroups) {
      try {
        const data = await callMtApi<{ items: Array<Record<string, unknown>> }>(
          "banners.json", accessToken,
          { fields: "id,status,moderation_status,delivery,textblocks", _campaign_id: String(grp.id), limit: "20" }
        );
        bannerResults.push({ group_id: grp.id, banners: data.items || [] });
      } catch (err) {
        bannerResults.push({ group_id: grp.id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return { adPlans: results, adGroups: groupResults, banners: bannerResults };
  },
});

/** TEMP: Deep diagnostic — fetch real VK API state for all UZ budget rules of a user.
 * Compares VK state with our actionLogs to find the real reason campaigns are stuck.
 */
export const diagnosUzBudgetRules = action({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    // 1. Get all UZ budget rules for this user
    const rules = await ctx.runQuery(internal.ruleEngine.listUzBudgetRulesForUser, { userId: args.userId });
    if (!rules || rules.length === 0) return { error: "No UZ budget rules found" };

    const results: Array<Record<string, unknown>> = [];

    for (const rule of rules) {
      const cond = (Array.isArray(rule.conditions) ? rule.conditions[0] : rule.conditions) as Record<string, unknown> | undefined;
      const ruleResult: Record<string, unknown> = {
        ruleId: rule._id,
        ruleName: rule.name,
        ruleActive: rule.isActive,
        dailyLimit: cond?.value,
        budgetStep: cond?.budgetStep,
        maxDailyBudget: cond?.maxDailyBudget,
        targetCampaignIds: rule.targetCampaignIds,
        accounts: [],
      };

      for (const accountId of rule.targetAccountIds || []) {
        let accessToken: string;
        try {
          accessToken = await ctx.runAction(internal.auth.getValidTokenForAccount, { accountId: accountId as Id<"adAccounts"> });
        } catch (err) {
          (ruleResult.accounts as Array<Record<string, unknown>>).push({
            accountId,
            error: `Token error: ${err instanceof Error ? err.message : String(err)}`,
          });
          continue;
        }

        // Fetch ALL campaigns from VK
        const allCampaigns: Array<Record<string, unknown>> = [];
        let offset = 0;
        while (true) {
          const res = await callMtApi<{ items: Array<Record<string, unknown>>; count: number }>(
            "campaigns.json", accessToken,
            { fields: "id,name,status,ad_plan_id,budget_limit_day,delivery,budget_limit", limit: "250", offset: String(offset) }
          );
          allCampaigns.push(...(res.items || []));
          if ((res.items || []).length < 250) break;
          offset += 250;
        }

        // Filter to rule's target campaigns (if specified)
        const targetIds = (rule.targetCampaignIds || []).map(Number);
        const targetCampaigns = targetIds.length > 0
          ? allCampaigns.filter(c => targetIds.includes(c.id as number) || targetIds.includes(c.ad_plan_id as number))
          : allCampaigns;

        // Get parent ad_plan IDs
        const parentPlanIds = [...new Set(targetCampaigns.map(c => c.ad_plan_id as number).filter(Boolean))];

        // Fetch parent ad_plans
        let parentPlans: Array<Record<string, unknown>> = [];
        if (parentPlanIds.length > 0) {
          try {
            const plansRes = await callMtApi<{ items: Array<Record<string, unknown>> }>(
              "ad_plans.json", accessToken,
              { fields: "id,name,status,budget_limit,budget_limit_day,delivery", _id: parentPlanIds.join(",") }
            );
            parentPlans = (plansRes.items || []).filter(p => parentPlanIds.includes(p.id as number));
            // Fallback: paginate if _id filter didn't work
            if (parentPlans.length === 0) {
              let pOffset = 0;
              const allPlans: Array<Record<string, unknown>> = [];
              while (true) {
                const res = await callMtApi<{ items: Array<Record<string, unknown>> }>(
                  "ad_plans.json", accessToken,
                  { fields: "id,name,status,budget_limit,budget_limit_day,delivery", limit: "50", offset: String(pOffset) }
                );
                allPlans.push(...(res.items || []));
                if ((res.items || []).length < 50) break;
                pOffset += 50;
              }
              parentPlans = allPlans.filter(p => parentPlanIds.includes(p.id as number));
            }
          } catch (err) {
            parentPlans = [{ error: err instanceof Error ? err.message : "fetch failed" }];
          }
        }

        // Fetch today's spent via statistics API
        const campaignIds = targetCampaigns.map(c => c.id as number);
        let spentData: Array<Record<string, unknown>> = [];
        if (campaignIds.length > 0) {
          try {
            const today = new Date().toISOString().slice(0, 10);
            const statsRes = await callMtApi<{ items: Array<Record<string, unknown>> }>(
              "statistics/campaigns/day.json", accessToken,
              { id: campaignIds.join(","), date_from: today, date_to: today }
            );
            spentData = statsRes.items || [];
          } catch (err) {
            spentData = [{ error: err instanceof Error ? err.message : "fetch failed" }];
          }
        }

        // Fetch ad_groups status/budget for these campaign IDs (new VK Ads accounts use ad_groups)
        let adGroups: Array<Record<string, unknown>> = [];
        if (campaignIds.length > 0) {
          try {
            const groupsRes = await callMtApi<{ items: Array<Record<string, unknown>> }>(
              "ad_groups.json", accessToken,
              { fields: "id,name,status,ad_plan_id,budget_limit_day,delivery", _id: campaignIds.join(",") }
            );
            adGroups = groupsRes.items || [];
          } catch (err) {
            adGroups = [{ error: err instanceof Error ? err.message : "fetch failed" }];
          }
        }

        // Get recent actionLogs for this rule
        const recentLogs = await ctx.runQuery(internal.ruleEngine.getRecentBudgetLogsForRule, {
          ruleId: rule._id,
          limitCount: 20,
        });

        (ruleResult.accounts as Array<Record<string, unknown>>).push({
          accountId,
          totalCampaignsInVK: allCampaigns.length,
          targetCampaignsFound: targetCampaigns.length,
          targetCampaigns: targetCampaigns.map(c => ({
            id: c.id,
            name: c.name,
            status: c.status,
            delivery: c.delivery,
            budget_limit_day: c.budget_limit_day,
            budget_limit: c.budget_limit,
            ad_plan_id: c.ad_plan_id,
          })),
          parentAdPlans: parentPlans.map(p => ({
            id: p.id,
            name: p.name,
            status: p.status,
            delivery: p.delivery,
            budget_limit_day: p.budget_limit_day,
            budget_limit: p.budget_limit,
          })),
          adGroups: adGroups.map(g => ({
            id: g.id,
            name: g.name,
            status: g.status,
            delivery: g.delivery,
            budget_limit_day: g.budget_limit_day,
          })),
          spentToday: spentData,
          recentLogs: (recentLogs || []).map(l => ({
            createdAt: new Date(l.createdAt).toISOString(),
            campaignId: l.adId,
            campaignName: l.campaignName,
            actionType: l.actionType,
            reason: l.reason,
            newBudget: l.metricsSnapshot?.newBudget,
            spentAtLog: l.metricsSnapshot?.spent,
            status: l.status,
          })),
        });
      }

      results.push(ruleResult);
    }

    return { diagnosedAt: new Date().toISOString(), rules: results };
  },
});

/**
 * Fetch all campaigns from VK API for UZ budget rule form UI.
 * Returns all campaigns (no package_id filter — user selects which to manage).
 */
export const fetchUzCampaigns = action({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args): Promise<{
    adPlans: Array<{
      id: string;
      name: string;
      status: string;
      campaigns: Array<{
        id: string;
        name: string;
        status: string;
        budgetLimitDay: number;
      }>;
    }>;
    ungrouped: Array<{
      id: string;
      name: string;
      status: string;
      budgetLimitDay: number;
    }>;
  }> => {
    const accessToken: string = await ctx.runAction(
      internal.auth.getValidTokenForAccount,
      { accountId: args.accountId }
    );

    // Fetch all campaigns (VK "Группы") with ad_plan_id — MUST use fields param
    const allItems: MtCampaign[] = [];
    let offset = 0;
    const LIMIT = 250;
    while (true) {
      const data = await callMtApi<{ items: MtCampaign[]; count: number }>(
        "campaigns.json",
        accessToken,
        { fields: "id,name,status,budget_limit_day,ad_plan_id", limit: String(LIMIT), offset: String(offset) }
      );
      const items = data.items || [];
      allItems.push(...items);
      if (items.length < LIMIT) break;
      offset += LIMIT;
    }

    // Only active and blocked campaigns
    const relevant = allItems.filter((c) => c.status === "active" || c.status === "blocked");

    // Collect unique ad_plan IDs
    const adPlanIds = [...new Set(
      relevant.map((c) => c.ad_plan_id).filter((id): id is number => id !== undefined && id > 0)
    )];

    // Fetch ad_plan names — MUST use fields param (default response has no status)
    const adPlanMap = new Map<number, { name: string; status: string }>();
    if (adPlanIds.length > 0) {
      for (let i = 0; i < adPlanIds.length; i += 50) {
        const batch = adPlanIds.slice(i, i + 50);
        try {
          const plansData = await callMtApi<{ items: Array<{ id: number; name: string; status: string }> }>(
            "ad_plans.json",
            accessToken,
            { fields: "id,name,status", _id: batch.join(",") }
          );
          for (const p of plansData.items || []) {
            adPlanMap.set(p.id, { name: p.name, status: p.status });
          }
        } catch {
          // If batch fetch fails, try fetching all ad_plans without _id filter
        }
      }
      // Fallback: if _id filter didn't work, paginate all ad_plans
      if (adPlanMap.size === 0) {
        let planOffset = 0;
        while (true) {
          try {
            const plansData = await callMtApi<{ items: Array<{ id: number; name: string; status: string }>; count: number }>(
              "ad_plans.json",
              accessToken,
              { fields: "id,name,status", limit: "250", offset: String(planOffset) }
            );
            for (const p of plansData.items || []) {
              if (adPlanIds.includes(p.id)) {
                adPlanMap.set(p.id, { name: p.name, status: p.status });
              }
            }
            if ((plansData.items || []).length < 250) break;
            planOffset += 250;
          } catch {
            break;
          }
        }
      }
    }

    // Group campaigns by ad_plan
    const grouped = new Map<number, MtCampaign[]>();
    const ungroupedList: MtCampaign[] = [];

    for (const c of relevant) {
      if (c.ad_plan_id && c.ad_plan_id > 0 && adPlanMap.has(c.ad_plan_id)) {
        const list = grouped.get(c.ad_plan_id) || [];
        list.push(c);
        grouped.set(c.ad_plan_id, list);
      } else {
        ungroupedList.push(c);
      }
    }

    // Build result — include plans that have active/blocked campaigns
    const adPlanResults = Array.from(grouped.entries()).map(([planId, campaigns]) => ({
      id: String(planId),
      name: adPlanMap.get(planId)?.name || `Кампания ${planId}`,
      status: adPlanMap.get(planId)?.status || "active",
      campaigns: campaigns.map((c) => ({
        id: String(c.id),
        name: c.name,
        status: c.status,
        budgetLimitDay: Number(c.budget_limit_day || "0"),
      })),
    }));

    return {
      adPlans: adPlanResults,
      ungrouped: ungroupedList.map((c) => ({
        id: String(c.id),
        name: c.name,
        status: c.status,
        budgetLimitDay: Number(c.budget_limit_day || "0"),
      })),
    };
  },
});



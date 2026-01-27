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

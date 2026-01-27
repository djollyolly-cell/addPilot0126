import { v } from "convex/values";
import { action } from "./_generated/server";

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

// VK API types
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

// Get all ad accounts accessible by the user
export const getAccounts = action({
  args: {
    accessToken: v.string(),
  },
  handler: async (_, args): Promise<VkAdAccount[]> => {
    return await callVkApi<VkAdAccount[]>("ads.getAccounts", args.accessToken);
  },
});

// Get campaigns for a specific ad account
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

// Get ads for a specific ad account (optionally filtered by campaign)
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

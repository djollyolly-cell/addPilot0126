/**
 * Integration Tests — VK API
 * Sprint 2: Подключение рекламных кабинетов VK
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { convexTest } from 'convex-test';
import schema from '../../convex/schema';
import { api, internal } from '../../convex/_generated/api';

// Mock VK API responses
const mockVkApiResponses = {
  'ads.getAccounts': {
    response: [
      { account_id: 123, account_type: 'general', account_name: 'Account 1' },
      { account_id: 456, account_type: 'general', account_name: 'Account 2' },
      { account_id: 789, account_type: 'agency', account_name: 'Account 3' },
    ],
  },
  'ads.getCampaigns': {
    response: [
      { id: 1001, name: 'Campaign 1', status: 1 },
      { id: 1002, name: 'Campaign 2', status: 1 },
    ],
  },
  'ads.getAds': {
    response: [
      { id: 2001, campaign_id: 1001, name: 'Ad 1', status: 1 },
      { id: 2002, campaign_id: 1001, name: 'Ad 2', status: 1 },
      { id: 2003, campaign_id: 1002, name: 'Ad 3', status: 1 },
    ],
  },
  'ads.getStatistics': {
    response: [
      {
        id: 2001,
        stats: [
          { impressions: 10000, clicks: 150, spent: 1500, leads: 5 },
        ],
      },
    ],
  },
  'ads.updateAds': {
    response: [{ id: 2001 }],
  },
};

describe('VK API Integration', () => {
  let t: ReturnType<typeof convexTest>;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    t = convexTest(schema);

    // Mock fetch for VK API calls
    mockFetch = vi.fn().mockImplementation(async (url: string, options: any) => {
      const body = new URLSearchParams(options.body);
      const method = body.get('method');

      if (method && mockVkApiResponses[method as keyof typeof mockVkApiResponses]) {
        return {
          ok: true,
          json: async () => mockVkApiResponses[method as keyof typeof mockVkApiResponses],
        };
      }

      return {
        ok: false,
        json: async () => ({ error: { error_code: 100, error_msg: 'Unknown method' } }),
      };
    });

    global.fetch = mockFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('vkApi.getAccounts', () => {
    it('should fetch list of VK ad accounts', async () => {
      const result = await t.action(internal.vkApi.getAccounts, {
        accessToken: 'test_token',
      });

      expect(result).toHaveLength(3);
      expect(result[0].account_id).toBe(123);
      expect(result[0].account_name).toBe('Account 1');
    });

    it('should handle VK API error', async () => {
      mockFetch.mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({
          error: { error_code: 5, error_msg: 'User authorization failed' },
        }),
      }));

      await expect(
        t.action(internal.vkApi.getAccounts, {
          accessToken: 'invalid_token',
        })
      ).rejects.toThrow('VK_API_ERROR');
    });
  });

  describe('vkApi.getCampaigns', () => {
    it('should fetch campaigns for account', async () => {
      const result = await t.action(internal.vkApi.getCampaigns, {
        accessToken: 'test_token',
        accountId: '123',
      });

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Campaign 1');
    });
  });

  describe('vkApi.getAds', () => {
    it('should fetch ads for campaign', async () => {
      const result = await t.action(internal.vkApi.getAds, {
        accessToken: 'test_token',
        accountId: '123',
        campaignIds: ['1001'],
      });

      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('vkApi.getStatistics', () => {
    it('should fetch statistics for ads', async () => {
      const result = await t.action(internal.vkApi.getStatistics, {
        accessToken: 'test_token',
        accountId: '123',
        adIds: ['2001'],
        period: 'day',
      });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(2001);
      expect(result[0].stats[0].impressions).toBe(10000);
    });
  });

  describe('vkApi.updateAds (stop ad)', () => {
    it('should stop an ad', async () => {
      const result = await t.action(internal.vkApi.updateAds, {
        accessToken: 'test_token',
        accountId: '123',
        data: [{ ad_id: 2001, status: 0 }],
      });

      expect(result[0].id).toBe(2001);
    });
  });

  describe('vkApi.rateLimiting', () => {
    it('should handle rate limit with exponential backoff', async () => {
      let attempts = 0;
      mockFetch.mockImplementation(async () => {
        attempts++;
        if (attempts < 3) {
          return {
            ok: true,
            json: async () => ({
              error: { error_code: 6, error_msg: 'Too many requests per second' },
            }),
          };
        }
        return {
          ok: true,
          json: async () => mockVkApiResponses['ads.getAccounts'],
        };
      });

      const result = await t.action(internal.vkApi.getAccountsWithRetry, {
        accessToken: 'test_token',
        maxRetries: 5,
      });

      expect(attempts).toBe(3);
      expect(result).toHaveLength(3);
    });

    it('should fail after max retries', async () => {
      mockFetch.mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          error: { error_code: 6, error_msg: 'Too many requests per second' },
        }),
      }));

      await expect(
        t.action(internal.vkApi.getAccountsWithRetry, {
          accessToken: 'test_token',
          maxRetries: 3,
        })
      ).rejects.toThrow('RATE_LIMIT_EXCEEDED');
    });
  });

  describe('vkApi.batchRequests', () => {
    it('should batch up to 2000 ids per request', async () => {
      const adIds = Array.from({ length: 3000 }, (_, i) => `ad_${i}`);

      await t.action(internal.vkApi.getStatisticsBatched, {
        accessToken: 'test_token',
        accountId: '123',
        adIds,
        period: 'day',
      });

      // Should make 2 requests: one with 2000 ids, one with 1000 ids
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});

describe('VK API Error Handling', () => {
  let t: ReturnType<typeof convexTest>;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    t = convexTest(schema);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should handle 500 error', async () => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    global.fetch = mockFetch;

    await expect(
      t.action(internal.vkApi.getAccounts, {
        accessToken: 'test_token',
      })
    ).rejects.toThrow('VK_API_ERROR');
  });

  it('should handle 401 token expired', async () => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        error: { error_code: 5, error_msg: 'User authorization failed: invalid access_token' },
      }),
    });
    global.fetch = mockFetch;

    await expect(
      t.action(internal.vkApi.getAccounts, {
        accessToken: 'expired_token',
      })
    ).rejects.toThrow('TOKEN_EXPIRED');
  });

  it('should handle network timeout', async () => {
    mockFetch = vi.fn().mockRejectedValue(new Error('Network timeout'));
    global.fetch = mockFetch;

    await expect(
      t.action(internal.vkApi.getAccounts, {
        accessToken: 'test_token',
      })
    ).rejects.toThrow();
  });

  it('should handle empty response', async () => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: [] }),
    });
    global.fetch = mockFetch;

    const result = await t.action(internal.vkApi.getAccounts, {
      accessToken: 'test_token',
    });

    expect(result).toEqual([]);
  });
});

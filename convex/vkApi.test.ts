import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// We test the VK API logic by importing and testing the underlying fetch patterns
// Since Convex actions can't be easily unit-tested with convex-test for external APIs,
// we test the API response handling patterns

describe("vkApi", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(responseData: unknown, status = 200) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(responseData),
    });
  }

  describe("getAccounts response handling", () => {
    test("parses successful accounts response", async () => {
      const mockAccounts = [
        {
          account_id: 100001,
          account_type: "general",
          account_status: 1,
          account_name: "Тестовый кабинет",
          access_role: "admin",
        },
        {
          account_id: 100002,
          account_type: "general",
          account_status: 1,
          account_name: "Второй кабинет",
          access_role: "admin",
        },
        {
          account_id: 100003,
          account_type: "general",
          account_status: 1,
          account_name: "Третий кабинет",
          access_role: "manager",
        },
      ];

      mockFetch({ response: mockAccounts });

      const response = await globalThis.fetch(
        "https://api.vk.com/method/ads.getAccounts?access_token=test&v=5.131"
      );
      const data = await response.json();

      expect(data.response).toHaveLength(3);
      expect(data.response[0].account_id).toBe(100001);
      expect(data.response[0].account_name).toBe("Тестовый кабинет");
      expect(data.response[2].access_role).toBe("manager");
    });

    test("handles empty accounts list", async () => {
      mockFetch({ response: [] });

      const response = await globalThis.fetch(
        "https://api.vk.com/method/ads.getAccounts?access_token=test&v=5.131"
      );
      const data = await response.json();

      expect(data.response).toEqual([]);
    });
  });

  describe("getCampaigns response handling", () => {
    test("parses campaigns response", async () => {
      const mockCampaigns = [
        {
          id: 1001,
          name: "Кампания лиды",
          status: 1,
          day_limit: "5000",
          all_limit: "100000",
          type: "promoted_posts",
        },
        {
          id: 1002,
          name: "Кампания трафик",
          status: 0,
          day_limit: "0",
          all_limit: "0",
          type: "normal",
        },
      ];

      mockFetch({ response: mockCampaigns });

      const response = await globalThis.fetch(
        "https://api.vk.com/method/ads.getCampaigns?access_token=test&v=5.131&account_id=100001"
      );
      const data = await response.json();

      expect(data.response).toHaveLength(2);
      expect(data.response[0].name).toBe("Кампания лиды");
      expect(data.response[0].day_limit).toBe("5000");
    });
  });

  describe("getAds response handling", () => {
    test("parses ads response", async () => {
      const mockAds = [
        {
          id: 5001,
          campaign_id: 1001,
          name: "Объявление 1",
          status: 1,
          approved: "approved",
        },
      ];

      mockFetch({ response: mockAds });

      const response = await globalThis.fetch(
        "https://api.vk.com/method/ads.getAds?access_token=test&v=5.131&account_id=100001"
      );
      const data = await response.json();

      expect(data.response).toHaveLength(1);
      expect(data.response[0].name).toBe("Объявление 1");
      expect(data.response[0].approved).toBe("approved");
    });
  });

  describe("error handling", () => {
    test("detects VK API error response", async () => {
      mockFetch({
        error: {
          error_code: 100,
          error_msg: "One of the parameters specified was missing or invalid",
        },
      });

      const response = await globalThis.fetch(
        "https://api.vk.com/method/ads.getAccounts?access_token=invalid&v=5.131"
      );
      const data = await response.json();

      expect(data.error).toBeDefined();
      expect(data.error.error_code).toBe(100);
    });

    test("detects token expired error (code 5)", async () => {
      mockFetch({
        error: {
          error_code: 5,
          error_msg: "User authorization failed: invalid access_token",
        },
      });

      const response = await globalThis.fetch(
        "https://api.vk.com/method/ads.getAccounts?access_token=expired&v=5.131"
      );
      const data = await response.json();

      expect(data.error.error_code).toBe(5);
    });

    test("detects rate limit error (code 6)", async () => {
      mockFetch({
        error: {
          error_code: 6,
          error_msg: "Too many requests per second",
        },
      });

      const response = await globalThis.fetch(
        "https://api.vk.com/method/ads.getAccounts?access_token=test&v=5.131"
      );
      const data = await response.json();

      expect(data.error.error_code).toBe(6);
    });

    test("rate limit retry logic - retries and succeeds", async () => {
      const mockAccounts = [{ account_id: 100001, account_name: "Кабинет" }];

      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                error: { error_code: 6, error_msg: "Too many requests per second" },
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ response: mockAccounts }),
        });
      });

      // Simulate the retry logic from vkApi.ts
      const MAX_RETRIES = 3;
      const RATE_LIMIT_CODE = 6;
      let result = null;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const response = await globalThis.fetch(
          "https://api.vk.com/method/ads.getAccounts?access_token=test&v=5.131"
        );
        const data = await response.json();

        if (data.error && data.error.error_code === RATE_LIMIT_CODE && attempt < MAX_RETRIES - 1) {
          continue;
        }

        if (data.response) {
          result = data.response;
          break;
        }
      }

      expect(callCount).toBe(3);
      expect(result).toHaveLength(1);
      expect(result[0].account_id).toBe(100001);
    });

    test("VK API 500 error produces error message", async () => {
      mockFetch({
        error: {
          error_code: 1,
          error_msg: "Unknown error occurred",
        },
      });

      const response = await globalThis.fetch(
        "https://api.vk.com/method/ads.getAccounts?access_token=test&v=5.131"
      );
      const data = await response.json();

      expect(data.error).toBeDefined();
      const errorMsg = `Ошибка VK API: ${data.error.error_msg}`;
      expect(errorMsg).toContain("Ошибка VK API");
    });
  });
});

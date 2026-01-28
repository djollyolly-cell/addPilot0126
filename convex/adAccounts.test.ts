import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

// Helper to create a test user
async function createTestUser(t: ReturnType<typeof convexTest>) {
  return await t.mutation(api.users.create, {
    email: "test@example.com",
    vkId: "12345",
    name: "Test User",
  });
}

describe("adAccounts", () => {
  describe("list", () => {
    test("returns empty array for user with no accounts", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);

      const accounts = await t.query(api.adAccounts.list, { userId });
      expect(accounts).toEqual([]);
    });

    test("returns accounts for user", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);

      // Connect two accounts
      await t.mutation(api.adAccounts.connect, {
        userId,
        vkAccountId: "100001",
        name: "Кабинет 1",
        accessToken: "token_1",
      });

      // Need to upgrade to add more than 1
      await t.mutation(api.users.updateTier, { userId, tier: "start" });

      await t.mutation(api.adAccounts.connect, {
        userId,
        vkAccountId: "100002",
        name: "Кабинет 2",
        accessToken: "token_2",
      });

      const accounts = await t.query(api.adAccounts.list, { userId });
      expect(accounts).toHaveLength(2);
      expect(accounts[0].name).toBe("Кабинет 1");
      expect(accounts[1].name).toBe("Кабинет 2");
    });

    test("does not return accounts of other users", async () => {
      const t = convexTest(schema);
      const userId1 = await createTestUser(t);

      const userId2 = await t.mutation(api.users.create, {
        email: "other@example.com",
        vkId: "67890",
        name: "Other User",
      });

      await t.mutation(api.adAccounts.connect, {
        userId: userId1,
        vkAccountId: "100001",
        name: "Кабинет 1",
        accessToken: "token_1",
      });

      const accounts = await t.query(api.adAccounts.list, { userId: userId2 });
      expect(accounts).toEqual([]);
    });
  });

  describe("connect", () => {
    test("connects a new ad account", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);

      const accountId = await t.mutation(api.adAccounts.connect, {
        userId,
        vkAccountId: "100001",
        name: "Тестовый кабинет",
        accessToken: "vk_token_123",
      });

      expect(accountId).toBeDefined();

      const account = await t.query(api.adAccounts.get, { accountId });
      expect(account).toBeDefined();
      expect(account?.vkAccountId).toBe("100001");
      expect(account?.name).toBe("Тестовый кабинет");
      expect(account?.status).toBe("active");
    });

    test("updates existing account if same user reconnects", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);

      const accountId1 = await t.mutation(api.adAccounts.connect, {
        userId,
        vkAccountId: "100001",
        name: "Кабинет v1",
        accessToken: "old_token",
      });

      const accountId2 = await t.mutation(api.adAccounts.connect, {
        userId,
        vkAccountId: "100001",
        name: "Кабинет v2",
        accessToken: "new_token",
      });

      // Should return same ID (upsert)
      expect(accountId2).toEqual(accountId1);

      const account = await t.query(api.adAccounts.get, { accountId: accountId1 });
      expect(account?.name).toBe("Кабинет v2");
      expect(account?.accessToken).toBe("new_token");
    });

    test("throws error when tier limit reached (freemium = 1)", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);

      // Connect first account (limit for freemium is 1)
      await t.mutation(api.adAccounts.connect, {
        userId,
        vkAccountId: "100001",
        name: "Кабинет 1",
        accessToken: "token_1",
      });

      // Try to connect second
      await expect(
        t.mutation(api.adAccounts.connect, {
          userId,
          vkAccountId: "100002",
          name: "Кабинет 2",
          accessToken: "token_2",
        })
      ).rejects.toThrow("Лимит кабинетов");
    });

    test("allows more accounts after tier upgrade", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);

      await t.mutation(api.adAccounts.connect, {
        userId,
        vkAccountId: "100001",
        name: "Кабинет 1",
        accessToken: "token_1",
      });

      // Upgrade to start (limit = 3)
      await t.mutation(api.users.updateTier, { userId, tier: "start" });

      const accountId = await t.mutation(api.adAccounts.connect, {
        userId,
        vkAccountId: "100002",
        name: "Кабинет 2",
        accessToken: "token_2",
      });

      expect(accountId).toBeDefined();
    });

    test("throws error when start tier limit reached (start = 3)", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);

      // Upgrade to start (limit = 3)
      await t.mutation(api.users.updateTier, { userId, tier: "start" });

      await t.mutation(api.adAccounts.connect, {
        userId,
        vkAccountId: "200001",
        name: "Кабинет 1",
        accessToken: "token_1",
      });
      await t.mutation(api.adAccounts.connect, {
        userId,
        vkAccountId: "200002",
        name: "Кабинет 2",
        accessToken: "token_2",
      });
      await t.mutation(api.adAccounts.connect, {
        userId,
        vkAccountId: "200003",
        name: "Кабинет 3",
        accessToken: "token_3",
      });

      // 4th should fail
      await expect(
        t.mutation(api.adAccounts.connect, {
          userId,
          vkAccountId: "200004",
          name: "Кабинет 4",
          accessToken: "token_4",
        })
      ).rejects.toThrow("Лимит кабинетов");
    });

    test("pro tier allows unlimited accounts", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);

      // Upgrade to pro
      await t.mutation(api.users.updateTier, { userId, tier: "pro" });

      // Connect 10 accounts — all should succeed
      for (let i = 1; i <= 10; i++) {
        const accountId = await t.mutation(api.adAccounts.connect, {
          userId,
          vkAccountId: `300${String(i).padStart(3, "0")}`,
          name: `Кабинет ${i}`,
          accessToken: `token_${i}`,
        });
        expect(accountId).toBeDefined();
      }

      const accounts = await t.query(api.adAccounts.list, { userId });
      expect(accounts).toHaveLength(10);
    });

    test("throws when another user tries to connect same account", async () => {
      const t = convexTest(schema);
      const userId1 = await createTestUser(t);

      const userId2 = await t.mutation(api.users.create, {
        email: "other@example.com",
        vkId: "67890",
        name: "Other User",
      });

      await t.mutation(api.adAccounts.connect, {
        userId: userId1,
        vkAccountId: "100001",
        name: "Кабинет 1",
        accessToken: "token_1",
      });

      await expect(
        t.mutation(api.adAccounts.connect, {
          userId: userId2,
          vkAccountId: "100001",
          name: "Кабинет 1",
          accessToken: "token_other",
        })
      ).rejects.toThrow("уже подключён другим пользователем");
    });
  });

  describe("disconnect", () => {
    test("disconnects and deletes an account", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);

      const accountId = await t.mutation(api.adAccounts.connect, {
        userId,
        vkAccountId: "100001",
        name: "Тестовый кабинет",
        accessToken: "token_1",
      });

      const result = await t.mutation(api.adAccounts.disconnect, {
        accountId,
        userId,
      });

      expect(result.success).toBe(true);

      const account = await t.query(api.adAccounts.get, { accountId });
      expect(account).toBeNull();
    });

    test("throws when disconnecting another user's account", async () => {
      const t = convexTest(schema);
      const userId1 = await createTestUser(t);

      const userId2 = await t.mutation(api.users.create, {
        email: "other@example.com",
        vkId: "67890",
        name: "Other User",
      });

      const accountId = await t.mutation(api.adAccounts.connect, {
        userId: userId1,
        vkAccountId: "100001",
        name: "Кабинет 1",
        accessToken: "token_1",
      });

      await expect(
        t.mutation(api.adAccounts.disconnect, {
          accountId,
          userId: userId2,
        })
      ).rejects.toThrow("Нет доступа");
    });

    test("deletes related campaigns and ads on disconnect", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);

      const accountId = await t.mutation(api.adAccounts.connect, {
        userId,
        vkAccountId: "100001",
        name: "Кабинет",
        accessToken: "token_1",
      });

      // Add campaign
      const campaignId = await t.mutation(api.adAccounts.upsertCampaign, {
        accountId,
        vkCampaignId: "C001",
        name: "Кампания 1",
        status: "1",
      });

      // Add ad
      await t.mutation(api.adAccounts.upsertAd, {
        accountId,
        campaignId,
        vkAdId: "A001",
        name: "Объявление 1",
        status: "1",
      });

      // Disconnect
      await t.mutation(api.adAccounts.disconnect, { accountId, userId });

      // Verify cascade delete
      const campaign = await t.query(api.adAccounts.getCampaignByVkId, {
        accountId,
        vkCampaignId: "C001",
      });
      expect(campaign).toBeNull();
    });
  });

  describe("updateStatus", () => {
    test("updates account status to error", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);

      const accountId = await t.mutation(api.adAccounts.connect, {
        userId,
        vkAccountId: "100001",
        name: "Кабинет",
        accessToken: "token_1",
      });

      await t.mutation(api.adAccounts.updateStatus, {
        accountId,
        status: "error",
        lastError: "Токен истёк",
      });

      const account = await t.query(api.adAccounts.get, { accountId });
      expect(account?.status).toBe("error");
      expect(account?.lastError).toBe("Токен истёк");
    });
  });

  describe("upsertCampaign", () => {
    test("creates a new campaign", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);

      const accountId = await t.mutation(api.adAccounts.connect, {
        userId,
        vkAccountId: "100001",
        name: "Кабинет",
        accessToken: "token_1",
      });

      const campaignId = await t.mutation(api.adAccounts.upsertCampaign, {
        accountId,
        vkCampaignId: "C001",
        name: "Тестовая кампания",
        status: "1",
        dailyLimit: 1000,
      });

      expect(campaignId).toBeDefined();

      const campaign = await t.query(api.adAccounts.getCampaignByVkId, {
        accountId,
        vkCampaignId: "C001",
      });
      expect(campaign?.name).toBe("Тестовая кампания");
      expect(campaign?.dailyLimit).toBe(1000);
    });

    test("updates existing campaign", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);

      const accountId = await t.mutation(api.adAccounts.connect, {
        userId,
        vkAccountId: "100001",
        name: "Кабинет",
        accessToken: "token_1",
      });

      await t.mutation(api.adAccounts.upsertCampaign, {
        accountId,
        vkCampaignId: "C001",
        name: "Старое имя",
        status: "1",
      });

      await t.mutation(api.adAccounts.upsertCampaign, {
        accountId,
        vkCampaignId: "C001",
        name: "Новое имя",
        status: "0",
      });

      const campaign = await t.query(api.adAccounts.getCampaignByVkId, {
        accountId,
        vkCampaignId: "C001",
      });
      expect(campaign?.name).toBe("Новое имя");
      expect(campaign?.status).toBe("0");
    });
  });

  describe("upsertAd", () => {
    test("creates a new ad", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);

      const accountId = await t.mutation(api.adAccounts.connect, {
        userId,
        vkAccountId: "100001",
        name: "Кабинет",
        accessToken: "token_1",
      });

      const campaignId = await t.mutation(api.adAccounts.upsertCampaign, {
        accountId,
        vkCampaignId: "C001",
        name: "Кампания",
        status: "1",
      });

      const adId = await t.mutation(api.adAccounts.upsertAd, {
        accountId,
        campaignId,
        vkAdId: "A001",
        name: "Тестовое объявление",
        status: "1",
        approved: "approved",
      });

      expect(adId).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Sprint 21 — Settings: API tab queries
  // ═══════════════════════════════════════════════════════════

  describe("getSyncErrors (S21)", () => {
    // S21-DoD#8: Sync errors table shows accounts with lastError
    test("S21-DoD#8: returns accounts with lastError set", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);

      // Upgrade to start to allow multiple accounts
      await t.mutation(api.users.updateTier, { userId, tier: "start" });

      const acc1 = await t.mutation(api.adAccounts.connect, {
        userId,
        vkAccountId: "S21_001",
        name: "Кабинет OK",
        accessToken: "token_ok",
      });
      const acc2 = await t.mutation(api.adAccounts.connect, {
        userId,
        vkAccountId: "S21_002",
        name: "Кабинет Error",
        accessToken: "token_err",
      });

      // Set error on second account
      await t.mutation(api.adAccounts.updateStatus, {
        accountId: acc2,
        status: "error",
        lastError: "Токен VK Ads истёк",
      });

      const errors = await t.query(api.adAccounts.getSyncErrors, { userId });
      expect(errors).toHaveLength(1);
      expect(errors[0].name).toBe("Кабинет Error");
      expect(errors[0].lastError).toBe("Токен VK Ads истёк");
    });

    // S21-DoD#12: Empty sync errors — "Всё работает"
    test("S21-DoD#12: returns empty array when no errors", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);

      await t.mutation(api.adAccounts.connect, {
        userId,
        vkAccountId: "S21_003",
        name: "Кабинет OK",
        accessToken: "token_ok",
      });

      const errors = await t.query(api.adAccounts.getSyncErrors, { userId });
      expect(errors).toHaveLength(0);
    });

    test("S21: returns empty array for user with no accounts", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);

      const errors = await t.query(api.adAccounts.getSyncErrors, { userId });
      expect(errors).toEqual([]);
    });
  });

  describe("getVkApiStatus (S21)", () => {
    // S21-DoD#7: VK status "Активно" when token present and not expired
    test("S21-DoD#7: returns connected=true when user has VK token", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);

      // Simulate storing a VK Ads token
      await t.run(async (ctx) => {
        await ctx.db.patch(userId, {
          vkAdsAccessToken: "valid_token",
          vkAdsTokenExpiresAt: Date.now() + 3600000, // expires in 1h
        });
      });

      const status = await t.query(api.adAccounts.getVkApiStatus, { userId });
      expect(status.connected).toBe(true);
      expect(status.expired).toBe(false);
    });

    // S21-DoD#13: Token expired — "Переавторизуйтесь"
    test("S21-DoD#13: returns expired=true when token is expired", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);

      // Simulate expired VK Ads token
      await t.run(async (ctx) => {
        await ctx.db.patch(userId, {
          vkAdsAccessToken: "expired_token",
          vkAdsTokenExpiresAt: Date.now() - 3600000, // expired 1h ago
        });
      });

      const status = await t.query(api.adAccounts.getVkApiStatus, { userId });
      expect(status.connected).toBe(true);
      expect(status.expired).toBe(true);
    });

    test("S21: returns connected=false when no token", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);

      const status = await t.query(api.adAccounts.getVkApiStatus, { userId });
      expect(status.connected).toBe(false);
      expect(status.expired).toBe(false);
    });
  });
});

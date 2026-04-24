import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

async function createTestUser(t: ReturnType<typeof convexTest>) {
  return await t.mutation(api.users.create, {
    email: "test@example.com",
    vkId: "12345",
    name: "Test User",
  });
}

const validProfile = {
  vkGroupId: 123,
  vkGroupName: "Test Group",
  vkGroupAvatarUrl: "https://example.com/photo.jpg",
  vkCommunityToken: "token_abc",
  senlerApiKey: "senler_key",
};

describe("communityProfiles", () => {
  describe("list", () => {
    test("returns empty array for user with no profiles", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);
      const profiles = await t.query(api.communityProfiles.list, { userId });
      expect(profiles).toEqual([]);
    });
  });

  describe("create", () => {
    test("creates a profile for a user", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);
      const id = await t.mutation(api.communityProfiles.create, {
        userId,
        ...validProfile,
      });
      expect(id).toBeDefined();
      const list = await t.query(api.communityProfiles.list, { userId });
      expect(list).toHaveLength(1);
      expect(list[0].vkGroupId).toBe(123);
    });

    test("rejects duplicate vkGroupId for same user", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);
      await t.mutation(api.communityProfiles.create, { userId, ...validProfile });
      await expect(
        t.mutation(api.communityProfiles.create, { userId, ...validProfile })
      ).rejects.toThrow("добавлено");
    });

    test("rejects 51st profile (limit 50)", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);
      for (let i = 0; i < 50; i++) {
        await t.mutation(api.communityProfiles.create, {
          userId,
          ...validProfile,
          vkGroupId: 1000 + i,
        });
      }
      await expect(
        t.mutation(api.communityProfiles.create, {
          userId,
          ...validProfile,
          vkGroupId: 1050,
        })
      ).rejects.toThrow(/Лимит/);
    });
  });

  describe("update", () => {
    test("updates senler key of existing profile", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);
      const id = await t.mutation(api.communityProfiles.create, {
        userId,
        vkGroupId: 123,
        vkGroupName: "G",
        vkCommunityToken: "t1",
      });
      await t.mutation(api.communityProfiles.update, {
        id,
        userId,
        senlerApiKey: "new_senler",
      });
      const list = await t.query(api.communityProfiles.list, { userId });
      expect(list[0].senlerApiKey).toBe("new_senler");
    });

    test("rejects update from non-owner", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);
      const id = await t.mutation(api.communityProfiles.create, {
        userId,
        vkGroupId: 123,
        vkGroupName: "G",
        vkCommunityToken: "t1",
      });
      const otherUser = await t.mutation(api.users.create, {
        email: "other@e.com",
        vkId: "99",
        name: "Other",
      });
      await expect(
        t.mutation(api.communityProfiles.update, {
          id,
          userId: otherUser,
          senlerApiKey: "hack",
        })
      ).rejects.toThrow(/Нет доступа/);
    });
  });

  describe("remove", () => {
    test("removes own profile", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);
      const id = await t.mutation(api.communityProfiles.create, {
        userId, vkGroupId: 1, vkGroupName: "G", vkCommunityToken: "t",
      });
      await t.mutation(api.communityProfiles.remove, { id, userId });
      const list = await t.query(api.communityProfiles.list, { userId });
      expect(list).toEqual([]);
    });

    test("rejects remove by non-owner", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);
      const id = await t.mutation(api.communityProfiles.create, {
        userId, vkGroupId: 1, vkGroupName: "G", vkCommunityToken: "t",
      });
      const otherUser = await t.mutation(api.users.create, {
        email: "a@b.c", vkId: "2", name: "A",
      });
      await expect(
        t.mutation(api.communityProfiles.remove, { id, userId: otherUser })
      ).rejects.toThrow(/Нет доступа/);
    });
  });
});

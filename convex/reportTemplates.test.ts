import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

async function createTestUser(t: ReturnType<typeof convexTest>) {
  return await t.mutation(api.users.create, {
    email: "t@e.com", vkId: "1", name: "T",
  });
}

async function createTestAccount(t: ReturnType<typeof convexTest>, userId: ReturnType<typeof createTestUser> extends Promise<infer U> ? U : never) {
  // Insert directly to avoid org/billing checks in adAccounts.connect
  return await t.run(async (ctx) => {
    return await ctx.db.insert("adAccounts", {
      userId,
      vkAccountId: "a1",
      name: "Cab1",
      accessToken: "tok",
      status: "active" as const,
    });
  });
}

const validTemplate = {
  name: "Test template",
  granularity: "day" as const,
  fields: ["date", "weekday", "spent"],
};

describe("reportTemplates", () => {
  test("list returns empty array", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);
    expect(await t.query(api.reportTemplates.list, { userId })).toEqual([]);
  });

  test("create adds a template", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);
    const accountId = await createTestAccount(t, userId);
    const id = await t.mutation(api.reportTemplates.create, {
      userId,
      ...validTemplate,
      filters: { accountIds: [accountId] },
    });
    const list = await t.query(api.reportTemplates.list, { userId });
    expect(list).toHaveLength(1);
    expect(list[0]._id).toBe(id);
  });

  test("create rejects 11th template (limit 10)", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);
    const accountId = await createTestAccount(t, userId);
    for (let i = 0; i < 10; i++) {
      await t.mutation(api.reportTemplates.create, {
        userId,
        ...validTemplate,
        name: `t${i}`,
        filters: { accountIds: [accountId] },
      });
    }
    await expect(
      t.mutation(api.reportTemplates.create, {
        userId,
        ...validTemplate,
        name: "t11",
        filters: { accountIds: [accountId] },
      })
    ).rejects.toThrow("Лимит");
  });

  test("create rejects duplicate name", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);
    const accountId = await createTestAccount(t, userId);
    await t.mutation(api.reportTemplates.create, {
      userId, ...validTemplate, filters: { accountIds: [accountId] },
    });
    await expect(
      t.mutation(api.reportTemplates.create, {
        userId, ...validTemplate, filters: { accountIds: [accountId] },
      })
    ).rejects.toThrow("существует");
  });

  test("create rejects unknown field", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);
    const accountId = await createTestAccount(t, userId);
    await expect(
      t.mutation(api.reportTemplates.create, {
        userId,
        name: "Bad",
        granularity: "day",
        fields: ["date", "xxx_unknown"],
        filters: { accountIds: [accountId] },
      })
    ).rejects.toThrow("Неизвестные поля");
  });

  test("update changes fields", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);
    const accountId = await createTestAccount(t, userId);
    const id = await t.mutation(api.reportTemplates.create, {
      userId, ...validTemplate, filters: { accountIds: [accountId] },
    });
    await t.mutation(api.reportTemplates.update, {
      id, userId, name: "New name", granularity: "day",
      filters: { accountIds: [accountId] },
      fields: ["date", "clicks"],
    });
    const list = await t.query(api.reportTemplates.list, { userId });
    expect(list[0].name).toBe("New name");
    expect(list[0].fields).toEqual(["date", "clicks"]);
  });

  test("update rejects non-owner", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);
    const accountId = await createTestAccount(t, userId);
    const id = await t.mutation(api.reportTemplates.create, {
      userId, ...validTemplate, filters: { accountIds: [accountId] },
    });
    const other = await t.mutation(api.users.create, {
      email: "o@e.com", vkId: "2", name: "O",
    });
    await expect(
      t.mutation(api.reportTemplates.update, {
        id, userId: other, name: "hack", granularity: "day",
        filters: { accountIds: [accountId] },
        fields: ["date"],
      })
    ).rejects.toThrow("Нет доступа");
  });

  test("remove deletes own template", async () => {
    const t = convexTest(schema);
    const userId = await createTestUser(t);
    const accountId = await createTestAccount(t, userId);
    const id = await t.mutation(api.reportTemplates.create, {
      userId, ...validTemplate, filters: { accountIds: [accountId] },
    });
    await t.mutation(api.reportTemplates.remove, { id, userId });
    expect(await t.query(api.reportTemplates.list, { userId })).toEqual([]);
  });
});

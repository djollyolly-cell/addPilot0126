# Community Profiles Implementation Plan (Plan A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать пользователю возможность подключать VK-сообщества (VK community token) и Senler-аккаунты, с ежедневной автоматической валидацией токенов. Это фундамент для будущего построителя отчёта (Plan B).

**Architecture:** Новая Convex-таблица `communityProfiles` хранит токены per сообщество. Backend делит логику на CRUD-файл (`communityProfiles.ts`) и два API-клиента (`vkCommunityApi.ts`, `senlerApi.ts`). UI живёт в `SettingsPage` — список профилей + модалка-мастер для добавления/редактирования. Cron раз в сутки валидирует токены всех профилей.

**Tech Stack:** Convex (queries/mutations/actions/internalActions), React + TypeScript, shadcn/ui, Vitest + convex-test для тестов бэкенда.

**Спек:** [docs/superpowers/specs/2026-04-19-client-report-builder-design.md](../specs/2026-04-19-client-report-builder-design.md) — раздел «UI профилей сообществ» + первая таблица в «Новые таблицы Convex».

---

## File Structure

**Backend (создаём):**
- `convex/vkCommunityApi.ts` — клиент VK API (`api.vk.com`); в Plan A только `groupsGetById`
- `convex/senlerApi.ts` — клиент Senler API; в Plan A только `validateKey`
- `convex/communityProfiles.ts` — CRUD + validate actions + cron action

**Backend (модифицируем):**
- `convex/schema.ts` — добавляем таблицу `communityProfiles`
- `convex/crons.ts` — регистрируем daily cron

**Backend (тесты):**
- `convex/communityProfiles.test.ts` — unit-тесты на мутации (create/update/remove) + лимит

**Frontend (создаём):**
- `src/components/CommunityProfilesSection.tsx` — карточка со списком
- `src/components/CommunityProfileModal.tsx` — 3-шаговая модалка
- `src/components/CommunityProfileCard.tsx` — маленький компонент карточки одного профиля

**Frontend (модифицируем):**
- `src/pages/SettingsPage.tsx` — добавить секцию

---

## Task 1: Добавить таблицу `communityProfiles` в схему

**Files:**
- Modify: `convex/schema.ts`

- [ ] **Step 1: Открыть `convex/schema.ts` и добавить таблицу после `payments`**

Добавить перед закрывающей строкой `}, { schemaValidation: false });` (строка ~993, после таблицы `loadUnitsHistory`):

```typescript
  communityProfiles: defineTable({
    userId: v.id("users"),
    vkGroupId: v.number(),
    vkGroupName: v.string(),
    vkGroupAvatarUrl: v.optional(v.string()),
    vkCommunityToken: v.string(),
    senlerApiKey: v.optional(v.string()),
    lastValidatedAt: v.number(),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_userId_group", ["userId", "vkGroupId"]),
```

- [ ] **Step 2: Запустить typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS (нет ошибок)

- [ ] **Step 3: Commit**

```bash
git add convex/schema.ts
git commit -m "feat(schema): add communityProfiles table for VK community + Senler credentials"
```

---

## Task 2: VK Community API клиент (groupsGetById)

VK API — это `api.vk.com/method/*`, параметры в query-string, токен через `access_token`. Версия API `v=5.199` (актуальная на 2026).

**Files:**
- Create: `convex/vkCommunityApi.ts`

- [ ] **Step 1: Создать `convex/vkCommunityApi.ts`**

```typescript
// VK API client — separate from vkApi.ts (myTarget API, uses target.my.com)
// This file uses VK API (api.vk.com) for community methods (groups, messages)
// Version 5.199 required for groups.getById new response format { groups: [...] }
// (vkApi.ts uses 5.131 for myTarget — different API, different versioning)
// Docs: https://dev.vk.com/ru/method
const VK_API_BASE = "https://api.vk.com/method";
const VK_API_VERSION = "5.199";

export type VkApiError = { code: number; message: string };

const VK_MAX_RETRIES = 3;
const VK_RETRY_DELAY_MS = 400;

async function callVkApi<T>(
  method: string,
  accessToken: string,
  params: Record<string, string | number> = {}
): Promise<T> {
  for (let attempt = 0; attempt < VK_MAX_RETRIES; attempt++) {
    const url = new URL(`${VK_API_BASE}/${method}`);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
    url.searchParams.set("access_token", accessToken);
    url.searchParams.set("v", VK_API_VERSION);

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`VK API HTTP ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { response?: T; error?: VkApiError };
    if (json.error) {
      // Code 6 = Too many requests per second — retry with backoff
      if (json.error.code === 6 && attempt < VK_MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, VK_RETRY_DELAY_MS * (attempt + 1)));
        continue;
      }
      throw new Error(`VK API error ${json.error.code}: ${json.error.message}`);
    }
    return json.response as T;
  }
  throw new Error("VK API: max retries exceeded");
}

export interface VkGroupInfo {
  id: number;
  name: string;
  photo_100: string;
  screen_name: string;
}

/**
 * Валидация токена через groups.getById.
 * Если токен сообщества — возвращает инфу о самом сообществе.
 * Бросает Error с кодом VK при проблемах.
 */
export async function groupsGetById(
  accessToken: string
): Promise<VkGroupInfo> {
  // Для токена сообщества groups.getById без параметров возвращает текущее сообщество
  const res = await callVkApi<{ groups: VkGroupInfo[] }>(
    "groups.getById",
    accessToken,
    { fields: "screen_name" }
  );
  if (!res.groups || res.groups.length === 0) {
    throw new Error("VK API: groups.getById returned empty result");
  }
  return res.groups[0];
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add convex/vkCommunityApi.ts
git commit -m "feat(vkCommunityApi): add VK API client with groupsGetById for token validation"
```

---

## Task 3: Senler API клиент (validateKey)

Senler API: `https://senler.ru/api/` (POST с JSON body). Метод `subscribers.get` с `group_id` — если возвращает не ошибку, ключ валиден. `group_id` для валидации — используем любой, т.к. метод вернёт ошибку про сам group если его нет, но это нормально — главное, ключ сам не отвалился.

Для валидации ключа проще — вызвать `subscriptions.get` без параметров. Если ключ невалиден — вернётся `error_code: 1`.

**Files:**
- Create: `convex/senlerApi.ts`

- [ ] **Step 1: Создать `convex/senlerApi.ts`**

```typescript
// Senler API client
// Docs: https://help.senler.ru/sender/dev/api
const SENLER_API_BASE = "https://senler.ru/api";

export interface SenlerError {
  error_code: number;
  error_message: string;
}

async function callSenlerApi<T>(
  method: string,
  apiKey: string,
  body: Record<string, unknown> = {}
): Promise<T> {
  const res = await fetch(`${SENLER_API_BASE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      access_token: apiKey,
      ...body,
    }),
  });
  if (!res.ok) {
    throw new Error(`Senler API HTTP ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { success?: boolean; error?: SenlerError } & T;
  if (json.error) {
    throw new Error(`Senler API error ${json.error.error_code}: ${json.error.error_message}`);
  }
  return json;
}

/**
 * Ping для валидации ключа. Senler требует хотя бы group_id — используем subscriptions.get,
 * если ключ валиден — получаем список групп подписчиков. Если ключ невалиден — ошибка.
 */
export async function validateSenlerKey(apiKey: string): Promise<void> {
  await callSenlerApi<{ items: unknown[] }>("subscriptions/get", apiKey);
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add convex/senlerApi.ts
git commit -m "feat(senlerApi): add Senler API client with validateKey"
```

---

## Task 4: `communityProfiles.list` query

**Files:**
- Create: `convex/communityProfiles.ts`
- Create: `convex/communityProfiles.test.ts`

- [ ] **Step 1: Написать failing тест**

Создать `convex/communityProfiles.test.ts`:

```typescript
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

describe("communityProfiles", () => {
  describe("list", () => {
    test("returns empty array for user with no profiles", async () => {
      const t = convexTest(schema);
      const userId = await createTestUser(t);
      const profiles = await t.query(api.communityProfiles.list, { userId });
      expect(profiles).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Запустить тест — должен упасть**

Run: `npx vitest run convex/communityProfiles.test.ts`
Expected: FAIL — `api.communityProfiles.list` не существует

- [ ] **Step 3: Создать `convex/communityProfiles.ts` с list query**

```typescript
import { v } from "convex/values";
import { query } from "./_generated/server";

export const list = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("communityProfiles")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .order("desc")
      .collect();
  },
});
```

- [ ] **Step 4: Запустить тест — должен пройти**

Run: `npx vitest run convex/communityProfiles.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add convex/communityProfiles.ts convex/communityProfiles.test.ts
git commit -m "feat(communityProfiles): add list query"
```

---

## Task 5: `validateCommunityToken` action

**Files:**
- Modify: `convex/communityProfiles.ts`

- [ ] **Step 1: Добавить action в `convex/communityProfiles.ts`**

В начало файла добавить импорт:
```typescript
import { action } from "./_generated/server";
import { groupsGetById } from "./vkCommunityApi";
```

В конец файла добавить:

```typescript
/**
 * Валидирует VK community token и возвращает инфу о сообществе.
 * Не сохраняет в БД — это делает `create` / `update` mutation после того,
 * как UI получил подтверждение.
 */
export const validateCommunityToken = action({
  args: { token: v.string() },
  handler: async (_ctx, args) => {
    const trimmed = args.token.trim();
    if (trimmed.length === 0) {
      throw new Error("Введите токен");
    }
    try {
      const info = await groupsGetById(trimmed);
      return {
        vkGroupId: info.id,
        vkGroupName: info.name,
        vkGroupAvatarUrl: info.photo_100,
        screenName: info.screen_name,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("error 5")) {
        throw new Error("Токен не подходит — проверьте, что это access_token сообщества");
      }
      if (msg.includes("error 15")) {
        throw new Error("У токена нет прав для этого сообщества");
      }
      throw new Error(`Ошибка VK API: ${msg}`);
    }
  },
});
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Commit**

Тест для action не пишем — делает реальные HTTP-запросы, валидируется руками через UI.

```bash
git add convex/communityProfiles.ts
git commit -m "feat(communityProfiles): add validateCommunityToken action"
```

---

## Task 6: `validateSenlerKey` action

**Files:**
- Modify: `convex/communityProfiles.ts`

- [ ] **Step 1: Добавить импорт и action**

В импорт `vkCommunityApi` добавить импорт senler:

```typescript
import { validateSenlerKey as senlerValidate } from "./senlerApi";
```

Добавить action:

```typescript
export const validateSenlerKey = action({
  args: { apiKey: v.string() },
  handler: async (_ctx, args) => {
    const trimmed = args.apiKey.trim();
    if (trimmed.length === 0) throw new Error("Введите API-ключ");
    try {
      await senlerValidate(trimmed);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Ключ Senler не подходит: ${msg}`);
    }
  },
});
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add convex/communityProfiles.ts
git commit -m "feat(communityProfiles): add validateSenlerKey action"
```

---

## Task 7: `create` mutation с дедупом и лимитом

**Files:**
- Modify: `convex/communityProfiles.ts`
- Modify: `convex/communityProfiles.test.ts`

- [ ] **Step 1: Написать failing тесты**

В `communityProfiles.test.ts` внутри `describe("communityProfiles", ...)` добавить новый блок:

```typescript
  describe("create", () => {
    const validProfile = {
      vkGroupId: 123,
      vkGroupName: "Test Group",
      vkGroupAvatarUrl: "https://example.com/photo.jpg",
      vkCommunityToken: "token_abc",
      senlerApiKey: "senler_key",
    };

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
      ).rejects.toThrow(/уже добавлено/);
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
```

- [ ] **Step 2: Запустить — должны упасть**

Run: `npx vitest run convex/communityProfiles.test.ts`
Expected: FAIL — mutation не существует

- [ ] **Step 3: Добавить mutation в `convex/communityProfiles.ts`**

В импорт добавить `mutation`:

```typescript
import { mutation, query, action } from "./_generated/server";
```

В конец файла добавить:

```typescript
const PROFILE_LIMIT = 50;

export const create = mutation({
  args: {
    userId: v.id("users"),
    vkGroupId: v.number(),
    vkGroupName: v.string(),
    vkGroupAvatarUrl: v.optional(v.string()),
    vkCommunityToken: v.string(),
    senlerApiKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Лимит
    const existing = await ctx.db
      .query("communityProfiles")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    if (existing.length >= PROFILE_LIMIT) {
      throw new Error(`Лимит профилей: ${PROFILE_LIMIT} на пользователя`);
    }
    // Дедуп
    const dup = existing.find((p) => p.vkGroupId === args.vkGroupId);
    if (dup) {
      throw new Error("Это сообщество уже добавлено");
    }
    const now = Date.now();
    return await ctx.db.insert("communityProfiles", {
      ...args,
      lastValidatedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  },
});
```

- [ ] **Step 4: Запустить тесты — должны пройти**

Run: `npx vitest run convex/communityProfiles.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add convex/communityProfiles.ts convex/communityProfiles.test.ts
git commit -m "feat(communityProfiles): add create mutation with dedup + limit 50"
```

---

## Task 8: `update` mutation

**Files:**
- Modify: `convex/communityProfiles.ts`
- Modify: `convex/communityProfiles.test.ts`

- [ ] **Step 1: Написать failing тест**

В `describe("communityProfiles", ...)` добавить:

```typescript
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
```

- [ ] **Step 2: Запустить — должны упасть**

Run: `npx vitest run convex/communityProfiles.test.ts`
Expected: FAIL

- [ ] **Step 3: Добавить mutation**

```typescript
export const update = mutation({
  args: {
    id: v.id("communityProfiles"),
    userId: v.id("users"),
    vkCommunityToken: v.optional(v.string()),
    senlerApiKey: v.optional(v.string()),
    // Для случая смены токена — фронт отдельно валидирует и передаёт новую инфу о группе
    vkGroupName: v.optional(v.string()),
    vkGroupAvatarUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Профиль не найден");
    if (existing.userId !== args.userId) throw new Error("Нет доступа");

    const patch: Partial<typeof existing> = { updatedAt: Date.now() };
    if (args.vkCommunityToken !== undefined) {
      patch.vkCommunityToken = args.vkCommunityToken;
      patch.lastValidatedAt = Date.now();
      patch.lastError = undefined;
    }
    if (args.senlerApiKey !== undefined) patch.senlerApiKey = args.senlerApiKey;
    if (args.vkGroupName !== undefined) patch.vkGroupName = args.vkGroupName;
    if (args.vkGroupAvatarUrl !== undefined) patch.vkGroupAvatarUrl = args.vkGroupAvatarUrl;

    await ctx.db.patch(args.id, patch);
  },
});
```

- [ ] **Step 4: Тест**

Run: `npx vitest run convex/communityProfiles.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add convex/communityProfiles.ts convex/communityProfiles.test.ts
git commit -m "feat(communityProfiles): add update mutation with ownership check"
```

---

## Task 9: `remove` mutation

**Files:**
- Modify: `convex/communityProfiles.ts`
- Modify: `convex/communityProfiles.test.ts`

- [ ] **Step 1: Failing тест**

```typescript
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
```

- [ ] **Step 2: Запустить — упадут**

Run: `npx vitest run convex/communityProfiles.test.ts`
Expected: FAIL

- [ ] **Step 3: Добавить mutation**

```typescript
export const remove = mutation({
  args: { id: v.id("communityProfiles"), userId: v.id("users") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Профиль не найден");
    if (existing.userId !== args.userId) throw new Error("Нет доступа");
    await ctx.db.delete(args.id);
  },
});
```

- [ ] **Step 4: Тесты — PASS**

Run: `npx vitest run convex/communityProfiles.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add convex/communityProfiles.ts convex/communityProfiles.test.ts
git commit -m "feat(communityProfiles): add remove mutation with ownership check"
```

---

## Task 10: Daily validation cron

Cron ежедневно в 04:00 UTC проходит по всем профилям и валидирует VK + Senler токены. Результат пишется в `lastValidatedAt` + `lastError`.

**Files:**
- Modify: `convex/communityProfiles.ts`
- Modify: `convex/crons.ts`

- [ ] **Step 1: Добавить internal-action и вспомогательную internal-mutation в `communityProfiles.ts`**

В импорты добавить:

```typescript
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
```

Добавить в конец файла:

```typescript
// ─── Internal: cron daily validation ──────────────────────────

export const _listAllForValidation = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("communityProfiles").collect();
  },
});

export const _markValidated = internalMutation({
  args: {
    id: v.id("communityProfiles"),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      lastValidatedAt: Date.now(),
      lastError: args.error,
    });
  },
});

export const dailyValidateAll = internalAction({
  args: {},
  handler: async (ctx) => {
    const profiles = await ctx.runQuery(internal.communityProfiles._listAllForValidation);
    for (const p of profiles) {
      let errorParts: string[] = [];
      try {
        await groupsGetById(p.vkCommunityToken);
      } catch (err) {
        errorParts.push(`VK: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (p.senlerApiKey) {
        try {
          await senlerValidate(p.senlerApiKey);
        } catch (err) {
          errorParts.push(`Senler: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      await ctx.runMutation(internal.communityProfiles._markValidated, {
        id: p._id,
        error: errorParts.length ? errorParts.join(" | ") : undefined,
      });
      // Мягкий rate-limit: 300ms между профилями
      await new Promise((r) => setTimeout(r, 300));
    }
  },
});
```

- [ ] **Step 2: Зарегистрировать cron в `convex/crons.ts`**

В конец файла (перед `export default crons;`) добавить:

```typescript
// Daily validation of community profile tokens (VK + Senler) at 04:45 UTC
// (offset 45 min from cleanup-old-ai-generations cron)
crons.cron(
  "validate-community-profiles",
  "45 4 * * *",
  internal.communityProfiles.dailyValidateAll
);
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add convex/communityProfiles.ts convex/crons.ts
git commit -m "feat(communityProfiles): add daily validation cron (04:45 UTC)"
```

---

## Task 11: Frontend — `CommunityProfileCard` компонент

Маленький компонент для одной карточки — отображение + кнопки. Выносим в отдельный файл, чтобы основная секция была проще.

**Files:**
- Create: `src/components/CommunityProfileCard.tsx`

- [ ] **Step 1: Создать компонент**

```tsx
import { Button } from "@/components/ui/button";
import { formatRelativeTime } from "@/lib/utils";
import { AlertCircle, CheckCircle, Pencil, Trash2 } from "lucide-react";
import { Id } from "../../convex/_generated/dataModel";

export interface CommunityProfile {
  _id: Id<"communityProfiles">;
  vkGroupId: number;
  vkGroupName: string;
  vkGroupAvatarUrl?: string;
  senlerApiKey?: string;
  lastValidatedAt: number;
  lastError?: string;
}

export function CommunityProfileCard({
  profile,
  onEdit,
  onRemove,
}: {
  profile: CommunityProfile;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const hasError = Boolean(profile.lastError);
  return (
    <div
      className="flex items-center gap-3 py-3 border-b border-border last:border-b-0"
      data-testid={`community-profile-${profile.vkGroupId}`}
    >
      {profile.vkGroupAvatarUrl ? (
        <img
          src={profile.vkGroupAvatarUrl}
          alt={profile.vkGroupName}
          className="h-10 w-10 rounded-full object-cover"
        />
      ) : (
        <div className="h-10 w-10 rounded-full bg-muted" />
      )}
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{profile.vkGroupName}</div>
        <div className="text-sm text-muted-foreground flex items-center gap-2">
          <a
            href={`https://vk.com/club${profile.vkGroupId}`}
            target="_blank"
            rel="noreferrer"
            className="hover:underline"
          >
            vk.com/club{profile.vkGroupId}
          </a>
          <span>·</span>
          {hasError ? (
            <span className="flex items-center gap-1 text-destructive">
              <AlertCircle className="h-3 w-3" />
              Ошибка токена
            </span>
          ) : (
            <span className="flex items-center gap-1 text-success">
              <CheckCircle className="h-3 w-3" />
              Токен проверен {formatRelativeTime(profile.lastValidatedAt)}
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          Senler: {profile.senlerApiKey ? "подключён" : "не подключён"}
        </div>
        {hasError && (
          <div className="text-xs text-destructive mt-1">{profile.lastError}</div>
        )}
      </div>
      <div className="flex gap-1">
        <Button variant="ghost" size="icon" onClick={onEdit} aria-label="Редактировать">
          <Pencil className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={onRemove} aria-label="Удалить">
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck frontend**

Run: `npx tsc --noEmit`
Expected: PASS (в новом файле не должно быть ошибок)

- [ ] **Step 3: Commit**

```bash
git add src/components/CommunityProfileCard.tsx
git commit -m "feat(settings/community-profiles): add CommunityProfileCard component"
```

---

## Task 12: Frontend — `CommunityProfileModal` (3-шаговый мастер)

**Files:**
- Create: `src/components/CommunityProfileModal.tsx`

- [ ] **Step 1: Создать компонент (единый файл с внутренним стейт-машиной шагов)**

```tsx
import { useState } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, AlertCircle, CheckCircle } from "lucide-react";

type Step = "vk_token" | "senler" | "confirm";

interface ValidatedGroup {
  vkGroupId: number;
  vkGroupName: string;
  vkGroupAvatarUrl?: string;
}

export function CommunityProfileModal({
  userId,
  existingProfileId,
  initialToken,
  initialSenlerKey,
  onClose,
  onSaved,
}: {
  userId: Id<"users">;
  existingProfileId?: Id<"communityProfiles">;
  initialToken?: string;
  initialSenlerKey?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [step, setStep] = useState<Step>("vk_token");
  const [vkToken, setVkToken] = useState(initialToken ?? "");
  const [senlerKey, setSenlerKey] = useState(initialSenlerKey ?? "");
  const [skipSenler, setSkipSenler] = useState(!initialSenlerKey);
  const [validated, setValidated] = useState<ValidatedGroup | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validateToken = useAction(api.communityProfiles.validateCommunityToken);
  const validateSenler = useAction(api.communityProfiles.validateSenlerKey);
  const createProfile = useMutation(api.communityProfiles.create);
  const updateProfile = useMutation(api.communityProfiles.update);

  async function handleValidateVk() {
    setError(null);
    setLoading(true);
    try {
      const info = await validateToken({ token: vkToken });
      setValidated(info);
      setStep("senler");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setLoading(false);
    }
  }

  async function handleValidateSenler() {
    if (skipSenler) {
      setStep("confirm");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await validateSenler({ apiKey: senlerKey });
      setStep("confirm");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!validated) return;
    setError(null);
    setLoading(true);
    try {
      if (existingProfileId) {
        await updateProfile({
          id: existingProfileId,
          userId,
          vkCommunityToken: vkToken,
          vkGroupName: validated.vkGroupName,
          vkGroupAvatarUrl: validated.vkGroupAvatarUrl,
          senlerApiKey: skipSenler ? undefined : senlerKey,
        });
      } else {
        await createProfile({
          userId,
          vkGroupId: validated.vkGroupId,
          vkGroupName: validated.vkGroupName,
          vkGroupAvatarUrl: validated.vkGroupAvatarUrl,
          vkCommunityToken: vkToken,
          senlerApiKey: skipSenler ? undefined : senlerKey,
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка сохранения");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      data-testid="community-profile-modal"
    >
      <div className="bg-background rounded-lg shadow-lg w-full max-w-md p-6 space-y-4">
        <h2 className="text-xl font-bold">
          {existingProfileId ? "Редактировать профиль" : "Добавить сообщество"}
        </h2>

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {step === "vk_token" && (
          <div className="space-y-3">
            <div>
              <Label htmlFor="vk-token">Токен VK-сообщества</Label>
              <Input
                id="vk-token"
                type="password"
                value={vkToken}
                onChange={(e) => setVkToken(e.target.value)}
                placeholder="vk1.a..."
                data-testid="vk-token-input"
              />
              <a
                href="https://dev.vk.com/ru/api/access-token/community-token/getting-started"
                target="_blank"
                rel="noreferrer"
                className="text-xs text-primary hover:underline mt-1 inline-block"
              >
                Как получить токен сообщества?
              </a>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={onClose}>Отмена</Button>
              <Button
                onClick={handleValidateVk}
                disabled={loading || !vkToken.trim()}
                data-testid="validate-vk-btn"
              >
                {loading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Проверить
              </Button>
            </div>
          </div>
        )}

        {step === "senler" && validated && (
          <div className="space-y-3">
            <div className="p-3 rounded-lg bg-success/10 text-success text-sm flex items-center gap-2">
              <CheckCircle className="h-4 w-4" />
              Сообщество: <strong>{validated.vkGroupName}</strong>
            </div>
            <div>
              <Label htmlFor="senler-key">API-ключ Senler (опционально)</Label>
              <Input
                id="senler-key"
                type="password"
                value={senlerKey}
                onChange={(e) => { setSenlerKey(e.target.value); setSkipSenler(false); }}
                placeholder="..."
                disabled={skipSenler}
                data-testid="senler-key-input"
              />
              <label className="flex items-center gap-2 mt-2 text-sm">
                <input
                  type="checkbox"
                  checked={skipSenler}
                  onChange={(e) => setSkipSenler(e.target.checked)}
                  data-testid="skip-senler-checkbox"
                />
                У меня нет Senler — пропустить
              </label>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setStep("vk_token")}>Назад</Button>
              <Button
                onClick={handleValidateSenler}
                disabled={loading || (!skipSenler && !senlerKey.trim())}
                data-testid="validate-senler-btn"
              >
                {loading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                {skipSenler ? "Пропустить" : "Проверить"}
              </Button>
            </div>
          </div>
        )}

        {step === "confirm" && validated && (
          <div className="space-y-3">
            <div className="p-3 rounded-lg bg-muted text-sm space-y-1">
              <div>Сообщество: <strong>{validated.vkGroupName}</strong></div>
              <div>VK токен: <span className="text-success">ok</span></div>
              <div>Senler: {skipSenler ? "не подключён" : <span className="text-success">ok</span>}</div>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setStep("senler")}>Назад</Button>
              <Button
                onClick={handleSave}
                disabled={loading}
                data-testid="save-profile-btn"
              >
                {loading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Сохранить
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck frontend**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/components/CommunityProfileModal.tsx
git commit -m "feat(settings/community-profiles): add 3-step CommunityProfileModal wizard"
```

---

## Task 13: Frontend — `CommunityProfilesSection` + Wire into `SettingsPage`

**Files:**
- Create: `src/components/CommunityProfilesSection.tsx`
- Modify: `src/pages/SettingsPage.tsx`

- [ ] **Step 1: Создать секцию**

```tsx
import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { useAuth } from "@/lib/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Loader2, Users } from "lucide-react";
import { CommunityProfileCard } from "@/components/CommunityProfileCard";
import { CommunityProfileModal } from "@/components/CommunityProfileModal";

const PROFILE_LIMIT = 50;

export function CommunityProfilesSection() {
  const { user } = useAuth();
  const userId = user?.userId as Id<"users"> | undefined;
  const profiles = useQuery(
    api.communityProfiles.list,
    userId ? { userId } : "skip"
  );
  const removeProfile = useMutation(api.communityProfiles.remove);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<Id<"communityProfiles"> | undefined>();

  const isLoading = profiles === undefined;

  async function handleRemove(id: Id<"communityProfiles">, name: string) {
    if (!userId) return;
    if (!confirm(`Удалить профиль сообщества «${name}»?`)) return;
    await removeProfile({ id, userId });
  }

  return (
    <Card data-testid="community-profiles-section">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Users className="h-5 w-5 text-primary" />
          Профили сообществ
        </CardTitle>
        <Button
          size="sm"
          onClick={() => { setEditingId(undefined); setModalOpen(true); }}
          disabled={isLoading || (profiles && profiles.length >= PROFILE_LIMIT)}
          data-testid="add-community-profile-btn"
        >
          <Plus className="h-4 w-4 mr-1" /> Добавить
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : profiles.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4">
            Нет подключённых сообществ. Добавьте первое, чтобы подтягивать диалоги
            и Senler-подписки в отчёты клиентам.
          </div>
        ) : (
          <div>
            {profiles.map((p) => (
              <CommunityProfileCard
                key={p._id}
                profile={p}
                onEdit={() => { setEditingId(p._id); setModalOpen(true); }}
                onRemove={() => handleRemove(p._id, p.vkGroupName)}
              />
            ))}
            <div className="text-xs text-muted-foreground mt-3">
              Подключено: {profiles.length} / {PROFILE_LIMIT}
            </div>
          </div>
        )}
      </CardContent>
      {modalOpen && userId && (
        <CommunityProfileModal
          userId={userId}
          existingProfileId={editingId}
          initialToken={editingId
            ? profiles?.find((p) => p._id === editingId)?.vkCommunityToken
            : undefined}
          initialSenlerKey={editingId
            ? profiles?.find((p) => p._id === editingId)?.senlerApiKey
            : undefined}
          onClose={() => setModalOpen(false)}
          onSaved={() => setModalOpen(false)}
        />
      )}
    </Card>
  );
}
```

- [ ] **Step 2: Wire секцию в `SettingsPage.tsx`**

Открыть `src/pages/SettingsPage.tsx`.

**2a.** Добавить импорт вверху:

```tsx
import { CommunityProfilesSection } from "@/components/CommunityProfilesSection";
```

**2b.** SettingsPage использует inline union type прямо в `useState` (строка 58). **Нет отдельного type-alias.** Расширить union, добавив `'communities'`:

```tsx
// Было (строка 58):
const [activeTab, setActiveTab] = useState<'profile' | 'telegram' | 'api' | 'business' | 'referral'>(initialTab as 'profile' | 'telegram' | 'api' | 'business' | 'referral');
// Стало:
const [activeTab, setActiveTab] = useState<'profile' | 'telegram' | 'api' | 'business' | 'referral' | 'communities'>(initialTab as 'profile' | 'telegram' | 'api' | 'business' | 'referral' | 'communities');
```

**2c.** Найти блок с кнопками-вкладками — это `<button>` элементы (НЕ `<Button>`) с паттерном `border-b-2` внутри `<nav className="flex gap-4">` (строки 82-142). Добавить **после** последнего `</button>` (строка 142) новую вкладку в том же стиле:

```tsx
          <button
            data-testid="tab-communities"
            onClick={() => setActiveTab('communities')}
            className={cn(
              'pb-3 px-1 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5',
              activeTab === 'communities'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <Users className="w-4 h-4" />
            Сообщества
          </button>
```

(Добавить `Users` в импорт `lucide-react`, если его ещё нет.)

**2d.** Найти блок рендера контента (строки 147-157) — это **цепочка тернаров**, не набор `&&`-блоков. Добавить ветку `communities` **перед** финальным `else` (BusinessTab). Было:

```tsx
      ) : activeTab === 'referral' ? (
        <ReferralTab userId={user.userId} />
      ) : (
        <BusinessTab userId={user.userId} />
      )}
```

Стало:

```tsx
      ) : activeTab === 'referral' ? (
        <ReferralTab userId={user.userId} />
      ) : activeTab === 'communities' ? (
        <CommunityProfilesSection />
      ) : (
        <BusinessTab userId={user.userId} />
      )}
```

- [ ] **Step 3: Запустить dev-сервер и проверить вручную**

```bash
npm run dev
```

Перейти на `http://localhost:5174/settings`, убедиться:
- Раздел «Профили сообществ» виден
- Кнопка «Добавить» открывает модалку
- Модалка валидирует шаги (без реальных токенов будет ошибка — это ок)
- `npx tsc --noEmit` — без ошибок

- [ ] **Step 4: Typecheck + lint**

```bash
npx tsc --noEmit && npm run lint
```
Expected: PASS (не более 50 warnings)

- [ ] **Step 5: Commit**

```bash
git add src/components/CommunityProfilesSection.tsx src/pages/SettingsPage.tsx
git commit -m "feat(settings): wire CommunityProfilesSection into SettingsPage"
```

---

## Task 14: Deploy + ручная валидация

- [ ] **Step 1: Убедиться, что все тесты проходят**

```bash
npx vitest run convex/communityProfiles.test.ts
```
Expected: PASS (10+ тестов)

- [ ] **Step 2: Полный typecheck и lint**

```bash
npx tsc --noEmit -p convex/tsconfig.json && npx tsc --noEmit && npm run lint
```
Expected: PASS

- [ ] **Step 3: Финальный commit не нужен — все taskи уже закоммичены. Проверить git log**

```bash
git log --oneline -15
```

Ожидаем ~13 коммитов с префиксом `feat(communityProfiles...)`, `feat(schema)`, `feat(settings...)`, `feat(vkCommunityApi)`, `feat(senlerApi)`.

- [ ] **Step 4: Manual smoke test (с реальными токенами)**

1. `npm run dev`
2. Войти в приложение
3. Перейти в Settings → Профили сообществ
4. Нажать «Добавить»
5. Вставить реальный community token (из VK: Настройки сообщества → Работа с API → Создать ключ → доступ к `messages`) → Проверить → должна показать имя сообщества
6. Опционально Senler key → Проверить / Пропустить → Сохранить
7. Увидеть карточку в списке с «Токен проверен только что»
8. Нажать Редактировать → сменить Senler key → сохранить → карточка обновится
9. Нажать Удалить → подтвердить → карточка исчезнет

Если всё это работает — Plan A готов.

---

## Task 14: Каскадное удаление при deleteUser

**Files:**
- Modify: `convex/users.ts`

- [ ] **Step 1: Добавить удаление communityProfiles в `deleteUser`**

В `convex/users.ts`, функция `deleteUser` (строка ~587). Добавить блок **перед** `// Finally delete the user` (строка ~646):

```typescript
    // Delete community profiles
    const communityProfiles = await ctx.db
      .query("communityProfiles")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    for (const profile of communityProfiles) {
      await ctx.db.delete(profile._id);
    }
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add convex/users.ts
git commit -m "fix(users): cascade delete communityProfiles on user deletion"
```

---

## Done criteria

- [ ] Схема содержит таблицу `communityProfiles` с двумя индексами
- [ ] VK + Senler API клиенты валидируют токены
- [ ] CRUD mutations работают, с проверками owner / limit / dedup
- [ ] Daily cron зарегистрирован и валидирует токены
- [ ] UI позволяет добавить/редактировать/удалить профиль
- [ ] `deleteUser` каскадно удаляет communityProfiles
- [ ] Все unit-тесты проходят, typecheck/lint — без ошибок
- [ ] Задеплоено в продакшен (или dev convex) и проверено вручную

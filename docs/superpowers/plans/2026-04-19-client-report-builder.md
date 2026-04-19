# Client Report Builder Implementation Plan (Plan B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Dependencies:** Plan A (`2026-04-19-community-profiles.md`) должен быть полностью реализован — эта фича использует `communityProfiles.list` query и полагается на существующие `vkCommunityApi.ts` и `senlerApi.ts`.

**Goal:** Новая вкладка «Отчёт клиенту» в `ReportsPage`: настраиваемый конструктор с полями, гранулярностью, фильтрами, шаблонами (10 на пользователя). Данные собираются on-demand при нажатии «Применить», без хранения диалогов/сообщений. Выгрузка в Excel.

**Architecture:** Backend делит работу между каталогом полей (`lib/reportFieldCatalog.ts`), парсером номеров (`lib/phoneExtractor.ts`), расширенными API-клиентами VK и Senler, и монолитным action'ом `buildReport` в `clientReport.ts`. Frontend — один крупный компонент `ClientReportTab` + три вспомогательных (FieldPicker, TemplateSelector, PhonesDrawer) + утилита экспорта в Excel.

**Tech Stack:** Convex actions/mutations/queries, `xlsx` для Excel, React/TypeScript, shadcn/ui.

**Спек:** [docs/superpowers/specs/2026-04-19-client-report-builder-design.md](../specs/2026-04-19-client-report-builder-design.md) — секции «Каталог полей», «UI построителя», «Data fetching», «Excel-экспорт», «CRUD шаблонов».

---

## File Structure

**Backend (создаём):**
- `convex/lib/reportFieldCatalog.ts` — каталог полей (общий для backend+frontend)
- `convex/lib/phoneExtractor.ts` — regex + нормализация
- `convex/reportTemplates.ts` — CRUD шаблонов
- `convex/clientReport.ts` — главный action `buildReport`

**Backend (модифицируем):**
- `convex/schema.ts` — добавить `reportTemplates`
- `convex/vkCommunityApi.ts` — добавить `messagesGetConversations`, `messagesGetHistory`, `usersGet`
- `convex/senlerApi.ts` — добавить `getSubscribersByDateRange`

**Backend (тесты):**
- `convex/lib/phoneExtractor.test.ts` — юнит-тесты регекса/нормализации
- `convex/reportTemplates.test.ts` — лимит/уникальность/ownership

**Frontend (создаём):**
- `src/pages/reports/ClientReportTab.tsx` — главная страница вкладки
- `src/pages/reports/components/FieldPicker.tsx`
- `src/pages/reports/components/TemplateSelector.tsx`
- `src/pages/reports/components/PhonesDrawer.tsx`
- `src/pages/reports/lib/exportToExcel.ts` — утилита экспорта
- `src/pages/reports/lib/reportFieldCatalog.ts` — re-export backend каталога для UI (или симлинк/копия)

**Frontend (модифицируем):**
- `src/pages/ReportsPage.tsx` — добавить вкладки

---

## Task 1: Добавить `reportTemplates` в схему

**Files:**
- Modify: `convex/schema.ts`

- [ ] **Step 1: Добавить таблицу в `convex/schema.ts`**

Сразу после добавленной в Plan A таблицы `communityProfiles`:

```typescript
  reportTemplates: defineTable({
    userId: v.id("users"),
    name: v.string(),
    description: v.optional(v.string()),
    filters: v.object({
      accountIds: v.array(v.id("adAccounts")),
      campaignIds: v.optional(v.array(v.number())),
      groupIds: v.optional(v.array(v.number())),
      communityIds: v.optional(v.array(v.number())),
      campaignStatus: v.optional(v.string()),
    }),
    granularity: v.union(
      v.literal("day"),
      v.literal("day_campaign"),
      v.literal("day_group"),
      v.literal("day_banner")
    ),
    fields: v.array(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_userId", ["userId"]),
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add convex/schema.ts
git commit -m "feat(schema): add reportTemplates table"
```

---

## Task 2: Каталог полей отчёта

**Files:**
- Create: `convex/lib/reportFieldCatalog.ts`

- [ ] **Step 1: Создать файл**

```typescript
// Единый каталог полей отчёта — shared backend + frontend.
// ID полей используется в reportTemplates.fields.

export type FieldCategory = "time" | "ads" | "community";

export interface FieldDefinition {
  id: string;
  label: string;
  category: FieldCategory;
  /** Поля, которые должны быть включены вместе с этим */
  dependencies?: string[];
  /** Нужен ли communityProfile для вычисления */
  requiresCommunityProfile?: boolean;
}

export const FIELD_CATALOG: FieldDefinition[] = [
  // Time
  { id: "date", label: "Дата", category: "time" },
  { id: "weekday", label: "День недели", category: "time" },

  // Ads metrics
  { id: "impressions", label: "Показы", category: "ads" },
  { id: "clicks", label: "Переходы", category: "ads" },
  { id: "spent", label: "Бюджет без НДС", category: "ads" },
  { id: "spent_with_vat", label: "Бюджет с НДС", category: "ads" },
  { id: "cpc", label: "CPC", category: "ads", dependencies: ["clicks", "spent"] },
  { id: "ctr", label: "CTR", category: "ads", dependencies: ["clicks", "impressions"] },
  { id: "cpm", label: "CPM", category: "ads", dependencies: ["impressions", "spent"] },
  { id: "leads", label: "Лиды (формы)", category: "ads" },
  { id: "cpl", label: "CPL", category: "ads", dependencies: ["leads", "spent"] },

  // Community
  { id: "group_joinings", label: "Подписки на группу", category: "community" },
  { id: "message_starts", label: "Старты сообщений", category: "community", requiresCommunityProfile: true },
  { id: "phones_count", label: "Номеров найдено", category: "community", requiresCommunityProfile: true },
  { id: "phones_detail", label: "Номера: детали", category: "community", dependencies: ["phones_count"], requiresCommunityProfile: true },
  { id: "senler_subs", label: "Подписки Senler", category: "community", requiresCommunityProfile: true },
];

export const DEFAULT_TEMPLATE_FIELDS = [
  "date", "weekday",
  "spent", "spent_with_vat",
  "impressions", "clicks",
  "cpc", "ctr",
];

export function getField(id: string): FieldDefinition | undefined {
  return FIELD_CATALOG.find((f) => f.id === id);
}

export function isValidField(id: string): boolean {
  return FIELD_CATALOG.some((f) => f.id === id);
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add convex/lib/reportFieldCatalog.ts
git commit -m "feat(reports): add field catalog shared between backend and frontend"
```

---

## Task 3: Phone extractor с тестами

**Files:**
- Create: `convex/lib/phoneExtractor.ts`
- Create: `convex/lib/phoneExtractor.test.ts`

- [ ] **Step 1: Failing тесты**

```typescript
// convex/lib/phoneExtractor.test.ts
import { describe, test, expect } from "vitest";
import { extractPhones, normalizePhone } from "./phoneExtractor";

describe("normalizePhone", () => {
  test("8 (XXX) XXX-XX-XX → +7XXXXXXXXXX", () => {
    expect(normalizePhone("8 (900) 123-45-67")).toBe("+79001234567");
  });
  test("+375 29 123 45 67 → +375291234567", () => {
    expect(normalizePhone("+375 29 123 45 67")).toBe("+375291234567");
  });
  test("380501234567 → +380501234567", () => {
    expect(normalizePhone("380501234567")).toBe("+380501234567");
  });
});

describe("extractPhones", () => {
  test("extracts single phone", () => {
    const r = extractPhones("Позвоните +375 29 123-45-67 после 18:00");
    expect(r.map((p) => p.phone)).toEqual(["+375291234567"]);
  });
  test("extracts multiple phones", () => {
    const r = extractPhones("+7 900 111 22 33 или 8(495)555-66-77");
    expect(r.map((p) => p.phone).sort()).toEqual(
      ["+74955556677", "+79001112233"].sort()
    );
  });
  test("handles sloppy formatting", () => {
    const r = extractPhones("тел: 80291234567");
    expect(r.map((p) => p.phone)).toEqual(["+375291234567"]);
  });
  test("returns empty for text without phones", () => {
    expect(extractPhones("просто текст без цифр")).toEqual([]);
  });
});
```

- [ ] **Step 2: Запустить — упадут**

Run: `npx vitest run convex/lib/phoneExtractor.test.ts`
Expected: FAIL

- [ ] **Step 3: Реализовать**

```typescript
// convex/lib/phoneExtractor.ts

const PHONE_REGEX = /(?:\+?(?:375|380|7)|8)[\s\-\(\)\.]?\d{2,3}[\s\-\(\)\.]?\d{3}[\s\-\.]?\d{2}[\s\-\.]?\d{2}/g;

export interface ExtractedPhone {
  phone: string;   // normalized: "+375291234567"
  raw: string;     // as found in text
}

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  // BY: 8029... → +375 29...
  if (digits.startsWith("80") && digits.length === 11) {
    return "+375" + digits.slice(2);
  }
  if (digits.startsWith("8") && digits.length === 11) {
    return "+7" + digits.slice(1);
  }
  if (digits.startsWith("375") || digits.startsWith("380") || digits.startsWith("7")) {
    return "+" + digits;
  }
  // Fallback — just prefix +
  return "+" + digits;
}

export function extractPhones(text: string): ExtractedPhone[] {
  if (!text) return [];
  const matches = text.match(PHONE_REGEX);
  if (!matches) return [];
  const seen = new Set<string>();
  const result: ExtractedPhone[] = [];
  for (const m of matches) {
    const normalized = normalizePhone(m);
    // Sanity check — must be at least 11 digits after +
    if (normalized.replace(/\D/g, "").length < 10) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push({ phone: normalized, raw: m });
  }
  return result;
}
```

- [ ] **Step 4: Тесты должны пройти**

Run: `npx vitest run convex/lib/phoneExtractor.test.ts`
Expected: PASS (7 тестов)

- [ ] **Step 5: Commit**

```bash
git add convex/lib/phoneExtractor.ts convex/lib/phoneExtractor.test.ts
git commit -m "feat(reports): add phone extractor for Russia/Belarus/Ukraine formats"
```

---

## Task 4: Расширить VK Community API

Добавляем методы для чтения диалогов, истории и пользователей.

**Files:**
- Modify: `convex/vkCommunityApi.ts`

- [ ] **Step 1: Дополнить файл**

После `groupsGetById` в `convex/vkCommunityApi.ts` добавить:

```typescript
// ─── Conversations / messages ──────────────────────────────

export interface VkConversation {
  peer: { id: number; type: string };
  last_message_id: number;
  in_read: number;
  out_read: number;
  /** Первое сообщение диалога с user → community */
  last_message: { date: number; from_id: number; text: string; id: number };
}

export interface VkConversationsResponse {
  count: number;
  items: Array<{
    conversation: VkConversation;
    last_message?: { id: number; date: number; from_id: number; text: string };
  }>;
}

/**
 * Список диалогов сообщества, отсортированных по активности (новые первые).
 * offset и count — пагинация, max count=200.
 */
export async function messagesGetConversations(
  accessToken: string,
  offset: number,
  count: number = 200
): Promise<VkConversationsResponse> {
  return await callVkApi<VkConversationsResponse>(
    "messages.getConversations",
    accessToken,
    { offset, count, filter: "all", extended: 0 }
  );
}

// ─── History of a dialog ───────────────────────────────────

export interface VkMessage {
  id: number;
  date: number;         // unix seconds
  from_id: number;      // negative = community, positive = user
  text: string;
  peer_id: number;
}

export async function messagesGetHistory(
  accessToken: string,
  peerId: number,
  count: number = 50,
  rev: 0 | 1 = 1
): Promise<{ count: number; items: VkMessage[] }> {
  return await callVkApi<{ count: number; items: VkMessage[] }>(
    "messages.getHistory",
    accessToken,
    { peer_id: peerId, count, rev }
  );
}

// ─── Users info ────────────────────────────────────────────

export interface VkUser {
  id: number;
  first_name: string;
  last_name: string;
  photo_100?: string;
}

/**
 * Батчевое получение инфы о пользователях. Max 1000 ID за вызов,
 * но для безопасности ограничиваем 100.
 */
export async function usersGet(
  accessToken: string,
  userIds: number[]
): Promise<VkUser[]> {
  if (userIds.length === 0) return [];
  if (userIds.length > 100) {
    throw new Error("usersGet: max 100 IDs per call");
  }
  return await callVkApi<VkUser[]>(
    "users.get",
    accessToken,
    { user_ids: userIds.join(","), fields: "photo_100" }
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add convex/vkCommunityApi.ts
git commit -m "feat(vkCommunityApi): add getConversations, getHistory, usersGet for report building"
```

---

## Task 5: Расширить Senler API

Добавляем метод для получения числа подписок за период.

**Files:**
- Modify: `convex/senlerApi.ts`

- [ ] **Step 1: Добавить функцию**

В `convex/senlerApi.ts` в конец файла:

```typescript
export interface SenlerSubscriber {
  vk_user_id: number;
  date_subscribe: number;   // unix seconds
  subscription_id: number;
}

/**
 * Получает список подписчиков, подписавшихся в заданном диапазоне unix-timestamps.
 * Внутри — вызывает subscribers/get с фильтром по дате. Пагинирует по 1000.
 */
export async function getSubscribersByDateRange(
  apiKey: string,
  fromTs: number,  // unix seconds
  toTs: number
): Promise<SenlerSubscriber[]> {
  const all: SenlerSubscriber[] = [];
  let offset = 0;
  const COUNT = 1000;
  for (let page = 0; page < 50; page++) {
    const res = await callSenlerApi<{ items: SenlerSubscriber[] }>(
      "subscribers/get",
      apiKey,
      {
        count: COUNT,
        offset,
        date_subscribe_from: fromTs,
        date_subscribe_to: toTs,
      }
    );
    if (!res.items || res.items.length === 0) break;
    all.push(...res.items);
    if (res.items.length < COUNT) break;
    offset += COUNT;
  }
  return all;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add convex/senlerApi.ts
git commit -m "feat(senlerApi): add getSubscribersByDateRange for report stats"
```

---

## Task 6: `reportTemplates` CRUD — list + create

**Files:**
- Create: `convex/reportTemplates.ts`
- Create: `convex/reportTemplates.test.ts`

- [ ] **Step 1: Failing тесты**

```typescript
// convex/reportTemplates.test.ts
import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

async function createTestUser(t: ReturnType<typeof convexTest>) {
  return await t.mutation(api.users.create, {
    email: "t@e.com", vkId: "1", name: "T",
  });
}

async function createTestAccount(t: ReturnType<typeof convexTest>, userId: any) {
  return await t.mutation(api.adAccounts.connect, {
    userId, vkAccountId: "a1", name: "Cab1", accessToken: "tok",
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
    ).rejects.toThrow(/Лимит/);
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
    ).rejects.toThrow(/уже существует/);
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
    ).rejects.toThrow(/Неизвестные поля/);
  });
});
```

- [ ] **Step 2: Запустить — упадут**

Run: `npx vitest run convex/reportTemplates.test.ts`
Expected: FAIL

- [ ] **Step 3: Создать `convex/reportTemplates.ts`**

```typescript
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { isValidField } from "./lib/reportFieldCatalog";

const TEMPLATE_LIMIT = 10;

const filtersValidator = v.object({
  accountIds: v.array(v.id("adAccounts")),
  campaignIds: v.optional(v.array(v.number())),
  groupIds: v.optional(v.array(v.number())),
  communityIds: v.optional(v.array(v.number())),
  campaignStatus: v.optional(v.string()),
});

const granularityValidator = v.union(
  v.literal("day"),
  v.literal("day_campaign"),
  v.literal("day_group"),
  v.literal("day_banner")
);

export const list = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("reportTemplates")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .order("desc")
      .collect();
  },
});

export const create = mutation({
  args: {
    userId: v.id("users"),
    name: v.string(),
    description: v.optional(v.string()),
    filters: filtersValidator,
    granularity: granularityValidator,
    fields: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.name.trim().length === 0) throw new Error("Введите имя шаблона");
    if (args.name.length > 60) throw new Error("Имя шаблона — максимум 60 символов");
    if (args.filters.accountIds.length === 0) {
      throw new Error("Выберите хотя бы один кабинет");
    }
    const invalid = args.fields.filter((f) => !isValidField(f));
    if (invalid.length > 0) {
      throw new Error(`Неизвестные поля: ${invalid.join(", ")}`);
    }

    const existing = await ctx.db
      .query("reportTemplates")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    if (existing.length >= TEMPLATE_LIMIT) {
      throw new Error(`Лимит шаблонов: ${TEMPLATE_LIMIT} на пользователя`);
    }
    if (existing.some((t) => t.name === args.name)) {
      throw new Error("Шаблон с таким именем уже существует");
    }

    const now = Date.now();
    return await ctx.db.insert("reportTemplates", {
      ...args,
      createdAt: now,
      updatedAt: now,
    });
  },
});
```

- [ ] **Step 4: Тесты должны пройти**

Run: `npx vitest run convex/reportTemplates.test.ts`
Expected: PASS (5 тестов)

- [ ] **Step 5: Commit**

```bash
git add convex/reportTemplates.ts convex/reportTemplates.test.ts
git commit -m "feat(reportTemplates): add list query + create mutation with limit/dedup/validation"
```

---

## Task 7: `reportTemplates` — update + remove

**Files:**
- Modify: `convex/reportTemplates.ts`
- Modify: `convex/reportTemplates.test.ts`

- [ ] **Step 1: Failing тесты**

Добавить в `describe("reportTemplates", ...)`:

```typescript
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
    ).rejects.toThrow(/Нет доступа/);
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
```

- [ ] **Step 2: Запустить — упадут**

Run: `npx vitest run convex/reportTemplates.test.ts`
Expected: FAIL

- [ ] **Step 3: Добавить mutations в `convex/reportTemplates.ts`**

```typescript
export const update = mutation({
  args: {
    id: v.id("reportTemplates"),
    userId: v.id("users"),
    name: v.string(),
    description: v.optional(v.string()),
    filters: filtersValidator,
    granularity: granularityValidator,
    fields: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Шаблон не найден");
    if (existing.userId !== args.userId) throw new Error("Нет доступа");

    if (args.name.trim().length === 0) throw new Error("Введите имя шаблона");
    if (args.name.length > 60) throw new Error("Имя шаблона — максимум 60 символов");
    if (args.filters.accountIds.length === 0) {
      throw new Error("Выберите хотя бы один кабинет");
    }
    const invalid = args.fields.filter((f) => !isValidField(f));
    if (invalid.length > 0) {
      throw new Error(`Неизвестные поля: ${invalid.join(", ")}`);
    }

    // Уникальность имени (исключая текущий шаблон)
    const others = await ctx.db
      .query("reportTemplates")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    if (others.some((t) => t._id !== args.id && t.name === args.name)) {
      throw new Error("Шаблон с таким именем уже существует");
    }

    await ctx.db.patch(args.id, {
      name: args.name,
      description: args.description,
      filters: args.filters,
      granularity: args.granularity,
      fields: args.fields,
      updatedAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { id: v.id("reportTemplates"), userId: v.id("users") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Шаблон не найден");
    if (existing.userId !== args.userId) throw new Error("Нет доступа");
    await ctx.db.delete(args.id);
  },
});
```

- [ ] **Step 4: Тесты должны пройти**

Run: `npx vitest run convex/reportTemplates.test.ts`
Expected: PASS (8 тестов всего)

- [ ] **Step 5: Commit**

```bash
git add convex/reportTemplates.ts convex/reportTemplates.test.ts
git commit -m "feat(reportTemplates): add update + remove with ownership checks"
```

---

## Task 8: `buildReport` action — скелет и ad metrics

Начинаем собирать главный action. В этой задаче — только ad metrics из существующей `metricsDaily`, без сообществ/Senler. Проверяем, что структура работает.

**Files:**
- Create: `convex/clientReport.ts`

- [ ] **Step 1: Создать файл со структурой**

```typescript
import { v } from "convex/values";
import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

// ─── Types ─────────────────────────────────────────────────

export type Granularity = "day" | "day_campaign" | "day_group" | "day_banner";

export interface ReportRow {
  date: string;
  weekday?: string;
  campaignId?: number;
  campaignName?: string;
  groupId?: number;
  groupName?: string;
  adId?: number;
  adName?: string;
  communityId?: number;
  communityName?: string;
  // Метрики (заполняются в зависимости от fields)
  impressions?: number;
  clicks?: number;
  spent?: number;
  spent_with_vat?: number;
  cpc?: number;
  ctr?: number;
  cpm?: number;
  leads?: number;
  cpl?: number;
  group_joinings?: number;
  message_starts?: number;
  phones_count?: number;
  senler_subs?: number;
}

export interface PhoneEntry {
  date: string;
  leftAt: number;
  phone: string;
  firstName: string;
  lastName: string;
  dialogUrl?: string;
  source: "vk_dialog" | "lead_ad";
  // Контекст в зависимости от гранулярности
  campaignId?: number;
  groupId?: number;
  adId?: number;
}

export interface ReportResult {
  dateFrom: string;
  dateTo: string;
  rows: ReportRow[];
  totals: Partial<ReportRow>;
  phonesDetail: PhoneEntry[];
  communitySummary?: Array<{
    communityId: number;
    name: string;
    newDialogs: number;
    phonesFound: number;
    senlerSubs: number;
  }>;
  partialErrors: string[];
}

const WEEKDAYS = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

function weekday(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  return WEEKDAYS[d.getUTCDay()];
}

function* dateRange(from: string, to: string): Generator<string> {
  const start = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    yield d.toISOString().slice(0, 10);
  }
}

// ─── Internal query: read metricsDaily ─────────────────────

export const _readAdMetrics = internalQuery({
  args: {
    accountIds: v.array(v.id("adAccounts")),
    dateFrom: v.string(),
    dateTo: v.string(),
  },
  handler: async (ctx, args) => {
    const results = [];
    for (const accountId of args.accountIds) {
      const rows = await ctx.db
        .query("metricsDaily")
        .withIndex("by_accountId_date", (q) =>
          q.eq("accountId", accountId)
            .gte("date", args.dateFrom)
            .lte("date", args.dateTo)
        )
        .collect();
      results.push({ accountId, rows });
    }
    return results;
  },
});

// ─── Public action: buildReport ────────────────────────────

export const buildReport = action({
  args: {
    userId: v.id("users"),
    accountIds: v.array(v.id("adAccounts")),
    campaignIds: v.optional(v.array(v.number())),
    groupIds: v.optional(v.array(v.number())),
    communityIds: v.optional(v.array(v.number())),
    campaignStatus: v.optional(v.string()),
    granularity: v.union(
      v.literal("day"),
      v.literal("day_campaign"),
      v.literal("day_group"),
      v.literal("day_banner")
    ),
    fields: v.array(v.string()),
    dateFrom: v.string(),
    dateTo: v.string(),
  },
  handler: async (ctx, args): Promise<ReportResult> => {
    const partialErrors: string[] = [];

    // 1. Ad metrics
    const metricsData = await ctx.runQuery(
      internal.clientReport._readAdMetrics,
      {
        accountIds: args.accountIds,
        dateFrom: args.dateFrom,
        dateTo: args.dateTo,
      }
    );

    // Aggregate by granularity key
    const rowMap = new Map<string, ReportRow>();
    for (const { rows } of metricsData) {
      for (const m of rows) {
        // Filter by campaign/group/ad
        if (args.campaignIds?.length && m.campaignId && !args.campaignIds.includes(m.campaignId)) continue;
        // groupId/adId filtering requires joining with ads table — optional, skip for simplicity in v1

        const key = buildKey(args.granularity, m);
        const existing = rowMap.get(key) ?? initRow(args.granularity, m);
        existing.impressions = (existing.impressions ?? 0) + m.impressions;
        existing.clicks = (existing.clicks ?? 0) + m.clicks;
        existing.spent = (existing.spent ?? 0) + m.spent;
        existing.leads = (existing.leads ?? 0) + m.leads;
        rowMap.set(key, existing);
      }
    }

    // Derived metrics per row
    const rows: ReportRow[] = [];
    for (const r of rowMap.values()) {
      if (args.fields.includes("spent_with_vat") && r.spent !== undefined) {
        r.spent_with_vat = Math.round(r.spent * 1.2 * 100) / 100;
      }
      if (args.fields.includes("cpc") && r.clicks && r.spent) {
        r.cpc = Math.round((r.spent / r.clicks) * 100) / 100;
      }
      if (args.fields.includes("ctr") && r.impressions && r.clicks !== undefined) {
        r.ctr = Math.round((r.clicks / r.impressions) * 10000) / 100;
      }
      if (args.fields.includes("cpm") && r.impressions && r.spent) {
        r.cpm = Math.round((r.spent / r.impressions) * 1000 * 100) / 100;
      }
      if (args.fields.includes("cpl") && r.leads && r.spent) {
        r.cpl = Math.round((r.spent / r.leads) * 100) / 100;
      }
      if (args.fields.includes("weekday")) {
        r.weekday = weekday(r.date);
      }
      rows.push(r);
    }
    rows.sort((a, b) => a.date.localeCompare(b.date));

    // 2-4. Community dialogs, Lead Ads, Senler — filled by later tasks

    // Totals
    const totals = computeTotals(rows, args.fields);

    return {
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
      rows,
      totals,
      phonesDetail: [],
      partialErrors,
    };
  },
});

// ─── Helpers ───────────────────────────────────────────────

function buildKey(
  granularity: Granularity,
  m: { date: string; campaignId?: number; adId: string }
): string {
  switch (granularity) {
    case "day": return m.date;
    case "day_campaign": return `${m.date}|c${m.campaignId ?? 0}`;
    case "day_group": return `${m.date}|c${m.campaignId ?? 0}|g`;
    case "day_banner": return `${m.date}|a${m.adId}`;
  }
}

function initRow(
  granularity: Granularity,
  m: { date: string; campaignId?: number; adId: string }
): ReportRow {
  const row: ReportRow = { date: m.date };
  if (granularity === "day_campaign" || granularity === "day_group" || granularity === "day_banner") {
    row.campaignId = m.campaignId;
  }
  if (granularity === "day_banner") {
    row.adId = Number(m.adId);
  }
  return row;
}

function computeTotals(rows: ReportRow[], fields: string[]): Partial<ReportRow> {
  const totals: Partial<ReportRow> = {};
  let impressions = 0, clicks = 0, spent = 0, leads = 0;
  let messageStarts = 0, phonesCount = 0, senlerSubs = 0, groupJoinings = 0;
  for (const r of rows) {
    impressions += r.impressions ?? 0;
    clicks += r.clicks ?? 0;
    spent += r.spent ?? 0;
    leads += r.leads ?? 0;
    messageStarts += r.message_starts ?? 0;
    phonesCount += r.phones_count ?? 0;
    senlerSubs += r.senler_subs ?? 0;
    groupJoinings += r.group_joinings ?? 0;
  }
  if (fields.includes("impressions")) totals.impressions = impressions;
  if (fields.includes("clicks")) totals.clicks = clicks;
  if (fields.includes("spent")) totals.spent = Math.round(spent * 100) / 100;
  if (fields.includes("spent_with_vat")) totals.spent_with_vat = Math.round(spent * 1.2 * 100) / 100;
  if (fields.includes("leads")) totals.leads = leads;
  if (fields.includes("cpc") && clicks) totals.cpc = Math.round((spent / clicks) * 100) / 100;
  if (fields.includes("ctr") && impressions) totals.ctr = Math.round((clicks / impressions) * 10000) / 100;
  if (fields.includes("cpm") && impressions) totals.cpm = Math.round((spent / impressions) * 1000 * 100) / 100;
  if (fields.includes("cpl") && leads) totals.cpl = Math.round((spent / leads) * 100) / 100;
  if (fields.includes("message_starts")) totals.message_starts = messageStarts;
  if (fields.includes("phones_count")) totals.phones_count = phonesCount;
  if (fields.includes("senler_subs")) totals.senler_subs = senlerSubs;
  if (fields.includes("group_joinings")) totals.group_joinings = groupJoinings;
  return totals;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add convex/clientReport.ts
git commit -m "feat(clientReport): buildReport skeleton with ad metrics aggregation"
```

---

## Task 9: `buildReport` — интеграция диалогов сообщества

Расширяем `buildReport` чтением диалогов через community token + парсинг номеров.

**Files:**
- Modify: `convex/clientReport.ts`

- [ ] **Step 1: Добавить internal helpers и блок сбора диалогов**

В `convex/clientReport.ts` сразу после `_readAdMetrics` добавить:

```typescript
export const _readCommunityProfiles = internalQuery({
  args: { userId: v.id("users"), vkGroupIds: v.array(v.number()) },
  handler: async (ctx, args) => {
    const profiles = await ctx.db
      .query("communityProfiles")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    return profiles.filter((p) => args.vkGroupIds.includes(p.vkGroupId));
  },
});
```

В импорт клиента VK добавить:

```typescript
import { messagesGetConversations, messagesGetHistory, usersGet } from "./vkCommunityApi";
import { extractPhones, normalizePhone } from "./lib/phoneExtractor";
```

В теле `buildReport`, после Ad metrics секции, добавить:

```typescript
    // 2. Community dialogs (если выбраны соответствующие поля)
    const needsDialogs = args.fields.some((f) =>
      ["message_starts", "phones_count", "phones_detail"].includes(f)
    );
    const phonesDetail: PhoneEntry[] = [];

    if (needsDialogs && args.communityIds && args.communityIds.length > 0) {
      const profiles = await ctx.runQuery(
        internal.clientReport._readCommunityProfiles,
        { userId: args.userId, vkGroupIds: args.communityIds }
      );
      const fromTs = Date.parse(args.dateFrom + "T00:00:00Z") / 1000;
      const toTs = Date.parse(args.dateTo + "T23:59:59Z") / 1000;

      for (const profile of profiles) {
        try {
          // Пагинируем диалоги, пока не уйдём за dateFrom
          const newDialogs: Array<{ peerId: number; firstMessageDate: number }> = [];
          let offset = 0;
          for (let page = 0; page < 50; page++) {
            const res = await messagesGetConversations(
              profile.vkCommunityToken, offset, 200
            );
            if (!res.items || res.items.length === 0) break;
            let allOlder = true;
            for (const item of res.items) {
              const lastDate = item.last_message?.date ?? item.conversation.last_message?.date;
              if (lastDate === undefined) continue;
              if (lastDate >= fromTs) allOlder = false;
              if (lastDate >= fromTs && lastDate <= toTs) {
                newDialogs.push({
                  peerId: item.conversation.peer.id,
                  firstMessageDate: lastDate,
                });
              }
            }
            if (allOlder) break;
            offset += 200;
            await new Promise((r) => setTimeout(r, 400));
          }

          // Для каждого диалога: messages.getHistory rev=1, phone extraction
          const peerIds = Array.from(new Set(newDialogs.map((d) => d.peerId)));
          const peerInfo = new Map<number, { firstName: string; lastName: string }>();
          // Batch fetch users
          for (let i = 0; i < peerIds.length; i += 100) {
            const batch = peerIds.slice(i, i + 100).filter((id) => id > 0);
            if (batch.length === 0) continue;
            const users = await usersGet(profile.vkCommunityToken, batch);
            for (const u of users) {
              peerInfo.set(u.id, { firstName: u.first_name, lastName: u.last_name });
            }
            await new Promise((r) => setTimeout(r, 400));
          }

          // Счётчик стартов диалогов по дате
          const dialogStartsByDate = new Map<string, number>();
          for (const d of newDialogs) {
            const dateStr = new Date(d.firstMessageDate * 1000).toISOString().slice(0, 10);
            dialogStartsByDate.set(dateStr, (dialogStartsByDate.get(dateStr) ?? 0) + 1);
          }

          // Читаем историю каждого диалога и извлекаем номера
          for (const d of newDialogs) {
            try {
              const hist = await messagesGetHistory(
                profile.vkCommunityToken, d.peerId, 50, 1
              );
              const groupIdAbs = Math.abs(profile.vkGroupId);
              const inbound = hist.items.filter(
                (m) => m.from_id !== -groupIdAbs && m.from_id > 0
              );
              for (const msg of inbound) {
                const phones = extractPhones(msg.text);
                for (const p of phones) {
                  const info = peerInfo.get(d.peerId) ?? { firstName: "", lastName: "" };
                  const leftAtMs = msg.date * 1000;
                  phonesDetail.push({
                    date: new Date(leftAtMs).toISOString().slice(0, 10),
                    leftAt: leftAtMs,
                    phone: p.phone,
                    firstName: info.firstName,
                    lastName: info.lastName,
                    dialogUrl: `https://vk.me/gim${Math.abs(profile.vkGroupId)}?sel=${d.peerId}`,
                    source: "vk_dialog",
                  });
                }
              }
              await new Promise((r) => setTimeout(r, 400));
            } catch (err) {
              // Проблема с одним диалогом — не рушим весь отчёт
              partialErrors.push(
                `Сообщество ${profile.vkGroupName}, peer ${d.peerId}: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }

          // Добавляем message_starts в строки
          if (args.fields.includes("message_starts")) {
            for (const [date, count] of dialogStartsByDate) {
              const key = buildKeyFromDate(args.granularity, date);
              const existing = rowMap.get(key);
              if (existing) {
                existing.message_starts = (existing.message_starts ?? 0) + count;
              } else {
                const newRow: ReportRow = { date, message_starts: count };
                if (args.fields.includes("weekday")) newRow.weekday = weekday(date);
                rowMap.set(key, newRow);
              }
            }
          }
        } catch (err) {
          partialErrors.push(
            `Сообщество ${profile.vkGroupName}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
```

Добавить helper `buildKeyFromDate` рядом с `buildKey`:

```typescript
function buildKeyFromDate(granularity: Granularity, date: string): string {
  // Для community-агрегатов у нас нет campaignId/adId — возвращаем по дате
  return granularity === "day" ? date : `${date}|community`;
}
```

В return'е заменить `phonesDetail: []` на `phonesDetail` (переменную).

Пересобрать `rows` после добавления community-строк (должно быть после всех источников; пока это не критично, т.к. Lead Ads и Senler — следующие таски):

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add convex/clientReport.ts
git commit -m "feat(clientReport): fetch dialogs, extract phones, count message starts per day"
```

---

## Task 10: `buildReport` — Lead Ads контакты

Получаем детали телефонов из форм VK (через существующий myTarget endpoint).

**Files:**
- Modify: `convex/clientReport.ts`
- Modify: `convex/vkApi.ts` (если потребуется экспорт)

- [ ] **Step 1: Проверить, есть ли в `vkApi.ts` функция для получения деталей лидов**

Run: `grep -n "lead_ads\|getMtLeadCounts\|leads.json" convex/vkApi.ts`
Expected: найти `getMtLeadCounts` (уже есть для подсчёта).

Нам нужны **детали** лидов (имя, телефон), а не только счётчики. Расширяем.

- [ ] **Step 2: Добавить новую функцию в `vkApi.ts`**

После `getMtLeadCounts` добавить:

```typescript
// Get lead details (with contact info) per banner
export const getMtLeadDetails = internalAction({
  args: {
    accessToken: v.string(),
    dateFrom: v.string(),   // "YYYY-MM-DD"
    dateTo: v.string(),
  },
  handler: async (_ctx, args) => {
    // Сначала получаем все form_id по subscriptions
    const subs = await callMtApi<{ items: Array<{ id: number; banner_id: number }> }>(
      "lead_ads/vkontakte/subscriptions.json",
      args.accessToken,
      { limit: "250" }
    );
    const formIds = Array.from(new Set(subs.items.map((s) => s.id)));

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

    for (const formId of formIds) {
      const data = await callMtApi<{
        items: Array<{
          form_id: number;
          leads: Array<{
            id: number;
            created: string;
            banner_id: number;
            data: Record<string, string>;
          }>;
        }>;
      }>(
        "lead_ads/vkontakte/leads.json",
        args.accessToken,
        {
          form_id: String(formId),
          date_from: args.dateFrom,
          date_to: args.dateTo,
          limit: "250",
        }
      );
      for (const form of data.items) {
        for (const lead of form.leads) {
          leads.push({
            vkLeadId: lead.id,
            formId: form.form_id,
            bannerId: lead.banner_id,
            createdAt: new Date(lead.created).getTime(),
            phone: lead.data.phone,
            email: lead.data.email,
            firstName: lead.data.name,
            lastName: lead.data.surname,
          });
        }
      }
    }
    return leads;
  },
});
```

(Добавить `internalAction` в импорты, если его нет.)

- [ ] **Step 3: В `clientReport.ts` — дёрнуть lead details**

После блока community-диалогов, перед `totals`:

```typescript
    // 3. Lead Ads контакты (если phones_detail или phones_count)
    if (needsDialogs) {
      // Для каждого accountId — свой accessToken
      const accounts = await ctx.runQuery(internal.clientReport._readAccounts, {
        accountIds: args.accountIds,
      });
      for (const acc of accounts) {
        if (!acc.accessToken) continue;
        try {
          const leads = await ctx.runAction(internal.vkApi.getMtLeadDetails, {
            accessToken: acc.accessToken,
            dateFrom: args.dateFrom,
            dateTo: args.dateTo,
          });
          for (const lead of leads) {
            if (lead.phone) {
              phonesDetail.push({
                date: new Date(lead.createdAt).toISOString().slice(0, 10),
                leftAt: lead.createdAt,
                phone: normalizePhone(lead.phone),
                firstName: lead.firstName ?? "",
                lastName: lead.lastName ?? "",
                source: "lead_ad",
                adId: lead.bannerId,
              });
            }
          }
        } catch (err) {
          partialErrors.push(
            `Кабинет ${acc.name} (Lead Ads): ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
```

И добавить `_readAccounts` internalQuery:

```typescript
export const _readAccounts = internalQuery({
  args: { accountIds: v.array(v.id("adAccounts")) },
  handler: async (ctx, args) => {
    const out = [];
    for (const id of args.accountIds) {
      const acc = await ctx.db.get(id);
      if (acc) out.push(acc);
    }
    return out;
  },
});
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add convex/clientReport.ts convex/vkApi.ts
git commit -m "feat(clientReport): add Lead Ads details fetching for phones_detail"
```

---

## Task 11: `buildReport` — Senler подписки + агрегаты `phones_count`

**Files:**
- Modify: `convex/clientReport.ts`

- [ ] **Step 1: Добавить Senler-блок и финализирующую логику**

После Lead Ads блока, перед totals:

```typescript
    // 4. Senler subs
    if (args.fields.includes("senler_subs") && args.communityIds && args.communityIds.length > 0) {
      const profiles = await ctx.runQuery(
        internal.clientReport._readCommunityProfiles,
        { userId: args.userId, vkGroupIds: args.communityIds }
      );
      const fromTs = Date.parse(args.dateFrom + "T00:00:00Z") / 1000;
      const toTs = Date.parse(args.dateTo + "T23:59:59Z") / 1000;
      for (const profile of profiles) {
        if (!profile.senlerApiKey) continue;
        try {
          const { getSubscribersByDateRange } = await import("./senlerApi");
          const subs = await getSubscribersByDateRange(
            profile.senlerApiKey, fromTs, toTs
          );
          for (const sub of subs) {
            const date = new Date(sub.date_subscribe * 1000).toISOString().slice(0, 10);
            const key = buildKeyFromDate(args.granularity, date);
            const existing = rowMap.get(key);
            if (existing) {
              existing.senler_subs = (existing.senler_subs ?? 0) + 1;
            } else {
              const newRow: ReportRow = { date, senler_subs: 1 };
              if (args.fields.includes("weekday")) newRow.weekday = weekday(date);
              rowMap.set(key, newRow);
            }
          }
        } catch (err) {
          partialErrors.push(
            `Senler ${profile.vkGroupName}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    // 5. phones_count per-row (из phonesDetail)
    if (args.fields.includes("phones_count")) {
      const countsByDate = new Map<string, number>();
      for (const p of phonesDetail) {
        countsByDate.set(p.date, (countsByDate.get(p.date) ?? 0) + 1);
      }
      for (const [date, count] of countsByDate) {
        const key = buildKeyFromDate(args.granularity, date);
        const existing = rowMap.get(key);
        if (existing) {
          existing.phones_count = (existing.phones_count ?? 0) + count;
        } else {
          const newRow: ReportRow = { date, phones_count: count };
          if (args.fields.includes("weekday")) newRow.weekday = weekday(date);
          rowMap.set(key, newRow);
        }
      }
    }
```

- [ ] **Step 2: Заменить блок `const rows: ReportRow[] = [];` на пересборку после всех источников**

Убедиться, что сортировка/финальное формирование `rows` происходит **после** всех блоков (community, Lead Ads, Senler). Оригинальный блок `rows.push(...)` должен быть перемещён в конец, перед `const totals = ...`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add convex/clientReport.ts
git commit -m "feat(clientReport): add Senler subs fetching and phones_count aggregation"
```

---

## Task 12: Frontend — Каталог полей (re-export для UI)

**Files:**
- Create: `src/pages/reports/lib/reportFieldCatalog.ts`

- [ ] **Step 1: Создать файл, дублирующий backend-каталог**

Т.к. convex/lib не импортируется в frontend (разные tsconfig), дублируем каталог:

```typescript
// Mirror of convex/lib/reportFieldCatalog.ts
// Держать в синхронизации вручную — изменения в backend отражать здесь.

export type FieldCategory = "time" | "ads" | "community";

export interface FieldDefinition {
  id: string;
  label: string;
  category: FieldCategory;
  dependencies?: string[];
  requiresCommunityProfile?: boolean;
}

export const FIELD_CATALOG: FieldDefinition[] = [
  { id: "date", label: "Дата", category: "time" },
  { id: "weekday", label: "День недели", category: "time" },
  { id: "impressions", label: "Показы", category: "ads" },
  { id: "clicks", label: "Переходы", category: "ads" },
  { id: "spent", label: "Бюджет без НДС", category: "ads" },
  { id: "spent_with_vat", label: "Бюджет с НДС", category: "ads" },
  { id: "cpc", label: "CPC", category: "ads", dependencies: ["clicks", "spent"] },
  { id: "ctr", label: "CTR", category: "ads", dependencies: ["clicks", "impressions"] },
  { id: "cpm", label: "CPM", category: "ads", dependencies: ["impressions", "spent"] },
  { id: "leads", label: "Лиды (формы)", category: "ads" },
  { id: "cpl", label: "CPL", category: "ads", dependencies: ["leads", "spent"] },
  { id: "group_joinings", label: "Подписки на группу", category: "community" },
  { id: "message_starts", label: "Старты сообщений", category: "community", requiresCommunityProfile: true },
  { id: "phones_count", label: "Номеров найдено", category: "community", requiresCommunityProfile: true },
  { id: "phones_detail", label: "Номера: детали", category: "community", dependencies: ["phones_count"], requiresCommunityProfile: true },
  { id: "senler_subs", label: "Подписки Senler", category: "community", requiresCommunityProfile: true },
];

export const DEFAULT_TEMPLATE_FIELDS = [
  "date", "weekday",
  "spent", "spent_with_vat",
  "impressions", "clicks",
  "cpc", "ctr",
];

export const CATEGORY_LABELS: Record<FieldCategory, string> = {
  time: "Время",
  ads: "Реклама",
  community: "Сообщество",
};
```

- [ ] **Step 2: Typecheck frontend**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/pages/reports/lib/reportFieldCatalog.ts
git commit -m "feat(reports): add frontend field catalog (mirror of backend)"
```

---

## Task 13: Frontend — `FieldPicker` компонент

**Files:**
- Create: `src/pages/reports/components/FieldPicker.tsx`

- [ ] **Step 1: Создать компонент**

```tsx
import { FIELD_CATALOG, CATEGORY_LABELS, FieldCategory } from "../lib/reportFieldCatalog";

export function FieldPicker({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const selectedSet = new Set(selected);

  function toggle(id: string) {
    const field = FIELD_CATALOG.find((f) => f.id === id);
    if (!field) return;

    const next = new Set(selectedSet);
    if (next.has(id)) {
      next.delete(id);
      // Unselecting — remove dependents (fields that depend on this one)
      for (const dependent of FIELD_CATALOG) {
        if (dependent.dependencies?.includes(id) && next.has(dependent.id)) {
          next.delete(dependent.id);
        }
      }
    } else {
      next.add(id);
      // Selecting — add dependencies
      for (const dep of field.dependencies ?? []) {
        next.add(dep);
      }
    }
    onChange(Array.from(next));
  }

  const grouped: Record<FieldCategory, typeof FIELD_CATALOG> = {
    time: [], ads: [], community: [],
  };
  for (const f of FIELD_CATALOG) grouped[f.category].push(f);

  return (
    <div className="space-y-4" data-testid="field-picker">
      <div className="text-sm text-muted-foreground">
        Выбрано: {selected.length} из {FIELD_CATALOG.length}
      </div>
      {(Object.keys(grouped) as FieldCategory[]).map((cat) => (
        <div key={cat}>
          <div className="text-sm font-medium mb-2">{CATEGORY_LABELS[cat]}</div>
          <div className="grid grid-cols-2 gap-2">
            {grouped[cat].map((f) => (
              <label
                key={f.id}
                className="flex items-center gap-2 text-sm cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selectedSet.has(f.id)}
                  onChange={() => toggle(f.id)}
                  data-testid={`field-checkbox-${f.id}`}
                />
                <span>{f.label}</span>
                {f.requiresCommunityProfile && (
                  <span className="text-xs text-muted-foreground">·</span>
                )}
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/pages/reports/components/FieldPicker.tsx
git commit -m "feat(reports): add FieldPicker with auto-dependency resolution"
```

---

## Task 14: Frontend — `TemplateSelector`

**Files:**
- Create: `src/pages/reports/components/TemplateSelector.tsx`

- [ ] **Step 1: Создать компонент**

```tsx
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Id, Doc } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Save, Plus, Trash2 } from "lucide-react";

type Template = Doc<"reportTemplates">;

export function TemplateSelector({
  userId,
  currentFilters,
  currentGranularity,
  currentFields,
  onTemplateLoad,
}: {
  userId: Id<"users">;
  currentFilters: Template["filters"];
  currentGranularity: Template["granularity"];
  currentFields: string[];
  onTemplateLoad: (template: Template) => void;
}) {
  const templates = useQuery(api.reportTemplates.list, { userId });
  const create = useMutation(api.reportTemplates.create);
  const update = useMutation(api.reportTemplates.update);
  const remove = useMutation(api.reportTemplates.remove);

  const [selectedId, setSelectedId] = useState<Id<"reportTemplates"> | "">("");
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!selectedId) return;
    setError(null);
    try {
      const t = templates?.find((x) => x._id === selectedId);
      if (!t) return;
      await update({
        id: selectedId,
        userId,
        name: t.name,
        description: t.description,
        filters: currentFilters,
        granularity: currentGranularity,
        fields: currentFields,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка сохранения");
    }
  }

  async function handleCreate() {
    setError(null);
    try {
      const id = await create({
        userId, name: newName,
        filters: currentFilters,
        granularity: currentGranularity,
        fields: currentFields,
      });
      setSelectedId(id);
      setShowSaveModal(false);
      setNewName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    }
  }

  async function handleDelete() {
    if (!selectedId) return;
    if (!confirm("Удалить шаблон?")) return;
    try {
      await remove({ id: selectedId, userId });
      setSelectedId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    }
  }

  function handleChange(id: string) {
    if (id === "") {
      setSelectedId("");
      return;
    }
    const t = templates?.find((x) => x._id === (id as Id<"reportTemplates">));
    if (t) {
      setSelectedId(t._id);
      onTemplateLoad(t);
    }
  }

  return (
    <div className="flex items-center gap-2" data-testid="template-selector">
      <select
        className="px-3 py-2 border border-border rounded-md bg-background text-sm"
        value={selectedId}
        onChange={(e) => handleChange(e.target.value)}
        data-testid="template-dropdown"
      >
        <option value="">Без шаблона</option>
        {templates?.map((t) => (
          <option key={t._id} value={t._id}>{t.name}</option>
        ))}
      </select>
      <Button
        variant="outline" size="icon"
        onClick={handleSave} disabled={!selectedId}
        aria-label="Сохранить"
        data-testid="save-template-btn"
      >
        <Save className="h-4 w-4" />
      </Button>
      <Button
        variant="outline" size="icon"
        onClick={() => setShowSaveModal(true)}
        disabled={templates && templates.length >= 10}
        aria-label="Новый шаблон"
        data-testid="new-template-btn"
      >
        <Plus className="h-4 w-4" />
      </Button>
      <Button
        variant="outline" size="icon"
        onClick={handleDelete} disabled={!selectedId}
        aria-label="Удалить"
        data-testid="delete-template-btn"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}

      {showSaveModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-background rounded-lg p-6 w-full max-w-md space-y-4">
            <h3 className="font-bold">Новый шаблон</h3>
            <div>
              <Label htmlFor="tpl-name">Имя шаблона</Label>
              <Input
                id="tpl-name" value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={60}
                data-testid="new-template-name"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowSaveModal(false)}>
                Отмена
              </Button>
              <Button onClick={handleCreate} disabled={!newName.trim()}>
                Создать
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/pages/reports/components/TemplateSelector.tsx
git commit -m "feat(reports): add TemplateSelector with save/load/delete"
```

---

## Task 15: Frontend — `PhonesDrawer`

**Files:**
- Create: `src/pages/reports/components/PhonesDrawer.tsx`

- [ ] **Step 1: Создать**

```tsx
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

interface PhoneEntry {
  date: string;
  leftAt: number;
  phone: string;
  firstName: string;
  lastName: string;
  dialogUrl?: string;
  source: "vk_dialog" | "lead_ad";
}

export function PhonesDrawer({
  phones,
  onClose,
}: {
  phones: PhoneEntry[];
  onClose: () => void;
}) {
  return (
    <div
      className="fixed right-0 top-0 h-full w-full max-w-md bg-background border-l border-border shadow-xl z-40 flex flex-col"
      data-testid="phones-drawer"
    >
      <div className="flex items-center justify-between p-4 border-b border-border">
        <h3 className="font-bold">Номера ({phones.length})</h3>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {phones.length === 0 && (
          <div className="text-sm text-muted-foreground">Номеров нет.</div>
        )}
        {phones.map((p, i) => (
          <div
            key={i}
            className="p-3 border border-border rounded-md text-sm space-y-1"
          >
            <div className="font-mono">{p.phone}</div>
            <div className="text-muted-foreground">
              {p.firstName} {p.lastName}
            </div>
            <div className="text-xs text-muted-foreground flex gap-2">
              <span>{new Date(p.leftAt).toLocaleString("ru-RU")}</span>
              <span>·</span>
              <span>{p.source === "vk_dialog" ? "VK сообщения" : "Lead Ads"}</span>
              {p.dialogUrl && (
                <>
                  <span>·</span>
                  <a
                    href={p.dialogUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                  >
                    диалог
                  </a>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: PASS

```bash
git add src/pages/reports/components/PhonesDrawer.tsx
git commit -m "feat(reports): add PhonesDrawer for phones_detail display"
```

---

## Task 16: Excel export утилита

**Files:**
- Create: `src/pages/reports/lib/exportToExcel.ts`

- [ ] **Step 1: Реализовать**

```typescript
import * as XLSX from "xlsx";
import { FIELD_CATALOG } from "./reportFieldCatalog";

interface ReportRow {
  date: string;
  [key: string]: unknown;
}

interface ExportParams {
  dateFrom: string;
  dateTo: string;
  accountNames: string[];
  granularity: string;
  userEmail: string;
  fields: string[];
  rows: ReportRow[];
  totals: Record<string, unknown>;
  phonesDetail?: Array<{
    date: string; leftAt: number; phone: string;
    firstName: string; lastName: string;
    dialogUrl?: string; source: string;
  }>;
}

export function exportReportToExcel(p: ExportParams): void {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Сводка
  const metaData = [
    ["Отчёт клиенту"],
    ["Период", `${p.dateFrom} — ${p.dateTo}`],
    ["Кабинеты", p.accountNames.join(", ")],
    ["Гранулярность", p.granularity],
    ["Построен", new Date().toLocaleString("ru-RU")],
    ["Пользователь", p.userEmail],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(metaData), "Сводка");

  // Sheet 2: Отчёт
  const visibleFields = p.fields.filter((f) => f !== "phones_detail");
  const fieldDefs = visibleFields.map((f) => FIELD_CATALOG.find((c) => c.id === f)).filter(Boolean);
  const headers = fieldDefs.map((f) => f!.label);
  const dataRows = p.rows.map((r) => visibleFields.map((f) => r[f] ?? ""));
  const totalsRow = ["Итого", ...visibleFields.slice(1).map((f) => p.totals[f] ?? "")];
  const reportSheet = XLSX.utils.aoa_to_sheet([headers, ...dataRows, totalsRow]);
  XLSX.utils.book_append_sheet(wb, reportSheet, "Отчёт");

  // Sheet 3: Номера (если есть)
  if (p.phonesDetail && p.phonesDetail.length > 0) {
    const phoneHeaders = ["Дата", "Время", "Номер", "Имя", "Фамилия", "Источник", "Ссылка на диалог"];
    const phoneRows = p.phonesDetail.map((ph) => [
      ph.date,
      new Date(ph.leftAt).toLocaleTimeString("ru-RU"),
      ph.phone,
      ph.firstName,
      ph.lastName,
      ph.source === "vk_dialog" ? "VK сообщения" : "Lead Ads",
      ph.dialogUrl ?? "",
    ]);
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([phoneHeaders, ...phoneRows]),
      "Номера"
    );
  }

  const fn = `report_${p.dateFrom}_${p.dateTo}_${p.accountNames[0] || "report"}.xlsx`;
  XLSX.writeFile(wb, fn);
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: PASS

```bash
git add src/pages/reports/lib/exportToExcel.ts
git commit -m "feat(reports): add Excel export with summary + data + phones sheets"
```

---

## Task 17: Frontend — `ClientReportTab` (главный компонент)

**Files:**
- Create: `src/pages/reports/ClientReportTab.tsx`

**Scope note:** В этой задаче делаем фильтры «Кабинеты + Сообщества + Статус», без явных dropdowns для кампаний/групп. Backend `buildReport` уже принимает `campaignIds` / `groupIds` — их UI добавим в follow-up PR после первого фидбэка пользователей (избегаем раздувания первой итерации). Для MVP «пусто = все» работает.

- [ ] **Step 1: Создать компонент (объединяет все блоки)**

Файл получится большим. Разбиваем его на секции.

```tsx
import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id, Doc } from "../../../convex/_generated/dataModel";
import { useAuth } from "@/lib/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, AlertCircle, Download } from "lucide-react";
import { FieldPicker } from "./components/FieldPicker";
import { TemplateSelector } from "./components/TemplateSelector";
import { PhonesDrawer } from "./components/PhonesDrawer";
import { FIELD_CATALOG, DEFAULT_TEMPLATE_FIELDS } from "./lib/reportFieldCatalog";
import { exportReportToExcel } from "./lib/exportToExcel";

type Granularity = "day" | "day_campaign" | "day_group" | "day_banner";

function todayStr(): string { return new Date().toISOString().slice(0, 10); }
function weekAgoStr(): string {
  const d = new Date(); d.setDate(d.getDate() - 6);
  return d.toISOString().slice(0, 10);
}

export function ClientReportTab() {
  const { user } = useAuth();
  const userId = user?.userId as Id<"users"> | undefined;

  const accounts = useQuery(api.adAccounts.list, userId ? { userId } : "skip");
  const communities = useQuery(
    api.communityProfiles.list,
    userId ? { userId } : "skip"
  );

  const [dateFrom, setDateFrom] = useState(weekAgoStr());
  const [dateTo, setDateTo] = useState(todayStr());
  const [selectedAccountIds, setSelectedAccountIds] = useState<Id<"adAccounts">[]>([]);
  const [selectedCommunityIds, setSelectedCommunityIds] = useState<number[]>([]);
  const [campaignStatus, setCampaignStatus] = useState("all");
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [fields, setFields] = useState<string[]>(DEFAULT_TEMPLATE_FIELDS);
  const [building, setBuilding] = useState(false);
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPhones, setShowPhones] = useState(false);

  const buildReport = useAction(api.clientReport.buildReport);

  function handleTemplateLoad(t: Doc<"reportTemplates">) {
    setSelectedAccountIds(t.filters.accountIds);
    setSelectedCommunityIds(t.filters.communityIds ?? []);
    setCampaignStatus(t.filters.campaignStatus ?? "all");
    setGranularity(t.granularity);
    setFields(t.fields);
  }

  async function handleApply() {
    if (!userId) return;
    if (selectedAccountIds.length === 0) {
      setError("Выберите хотя бы один кабинет");
      return;
    }
    if (dateFrom > dateTo) {
      setError("Дата начала не может быть позже даты окончания");
      return;
    }
    setError(null);
    setBuilding(true);
    try {
      const result = await buildReport({
        userId,
        accountIds: selectedAccountIds,
        communityIds: selectedCommunityIds.length ? selectedCommunityIds : undefined,
        campaignStatus,
        granularity,
        fields,
        dateFrom,
        dateTo,
      });
      setReport(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка построения");
    } finally {
      setBuilding(false);
    }
  }

  function handleExport() {
    if (!report) return;
    const accountNames = (accounts ?? [])
      .filter((a) => selectedAccountIds.includes(a._id))
      .map((a) => a.name);
    exportReportToExcel({
      dateFrom, dateTo, accountNames, granularity,
      userEmail: user?.email ?? "",
      fields, rows: report.rows, totals: report.totals,
      phonesDetail: fields.includes("phones_detail") ? report.phonesDetail : undefined,
    });
  }

  const currentFilters = {
    accountIds: selectedAccountIds,
    communityIds: selectedCommunityIds.length ? selectedCommunityIds : undefined,
    campaignStatus: campaignStatus !== "all" ? campaignStatus : undefined,
  };

  return (
    <div className="space-y-4" data-testid="client-report-tab">
      {/* Template + error banner */}
      <div className="flex items-center gap-4">
        <span className="text-sm text-muted-foreground">Шаблон:</span>
        {userId && (
          <TemplateSelector
            userId={userId}
            currentFilters={currentFilters}
            currentGranularity={granularity}
            currentFields={fields}
            onTemplateLoad={handleTemplateLoad}
          />
        )}
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}

      {/* Filters */}
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium">Период с</label>
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
                className="w-full mt-1 px-3 py-2 border rounded" />
            </div>
            <div>
              <label className="text-sm font-medium">по</label>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
                className="w-full mt-1 px-3 py-2 border rounded" />
            </div>
          </div>

          <div>
            <label className="text-sm font-medium">Кабинеты</label>
            <div className="mt-1 space-y-1 max-h-40 overflow-y-auto border rounded p-2">
              {accounts?.map((a) => (
                <label key={a._id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox"
                    checked={selectedAccountIds.includes(a._id)}
                    onChange={(e) => {
                      if (e.target.checked) setSelectedAccountIds([...selectedAccountIds, a._id]);
                      else setSelectedAccountIds(selectedAccountIds.filter((x) => x !== a._id));
                    }} />
                  {a.name}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="text-sm font-medium">Сообщества</label>
            <div className="mt-1 space-y-1 max-h-32 overflow-y-auto border rounded p-2">
              {communities?.length === 0 && (
                <span className="text-sm text-muted-foreground">
                  Нет подключённых. Добавьте в Настройках.
                </span>
              )}
              {communities?.map((c) => (
                <label key={c._id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox"
                    checked={selectedCommunityIds.includes(c.vkGroupId)}
                    onChange={(e) => {
                      if (e.target.checked) setSelectedCommunityIds([...selectedCommunityIds, c.vkGroupId]);
                      else setSelectedCommunityIds(selectedCommunityIds.filter((x) => x !== c.vkGroupId));
                    }} />
                  {c.vkGroupName}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="text-sm font-medium">Гранулярность</label>
            <div className="mt-1 space-y-1">
              {[
                { v: "day", l: "По дням" },
                { v: "day_campaign", l: "По дням × кампании" },
                { v: "day_group", l: "По дням × группы" },
                { v: "day_banner", l: "По дням × баннеры" },
              ].map((opt) => (
                <label key={opt.v} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="gran" value={opt.v}
                    checked={granularity === opt.v}
                    onChange={() => setGranularity(opt.v as Granularity)} />
                  {opt.l}
                </label>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Field picker */}
      <Card>
        <CardContent className="pt-6">
          <FieldPicker selected={fields} onChange={setFields} />
        </CardContent>
      </Card>

      {/* Apply */}
      <Button onClick={handleApply} disabled={building} data-testid="apply-btn">
        {building && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
        Применить
      </Button>

      {/* Report */}
      {report && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex justify-between items-center mb-4">
              <div>
                <div className="font-bold">Отчёт</div>
                <div className="text-sm text-muted-foreground">
                  {report.dateFrom} — {report.dateTo}
                </div>
              </div>
              <div className="flex gap-2">
                {fields.includes("phones_detail") && (
                  <Button variant="outline" onClick={() => setShowPhones(true)}>
                    Номера ({report.phonesDetail?.length ?? 0})
                  </Button>
                )}
                <Button onClick={handleExport}>
                  <Download className="h-4 w-4 mr-1" /> Скачать Excel
                </Button>
              </div>
            </div>

            {report.partialErrors.length > 0 && (
              <div className="mb-4 p-3 rounded bg-amber-500/10 text-amber-700 text-sm">
                Частичные ошибки:
                <ul className="list-disc ml-5 mt-1">
                  {report.partialErrors.map((e: string, i: number) =>
                    <li key={i}>{e}</li>
                  )}
                </ul>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    {fields.filter((f) => f !== "phones_detail").map((f) => (
                      <th key={f} className="text-left py-2 px-3">
                        {FIELD_CATALOG.find((c) => c.id === f)?.label ?? f}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.rows.slice(0, 500).map((r: any, i: number) => (
                    <tr key={i} className="border-b border-border">
                      {fields.filter((f) => f !== "phones_detail").map((f) => (
                        <td key={f} className="py-2 px-3">{String(r[f] ?? "—")}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-bold border-t-2 border-border">
                    {fields.filter((f) => f !== "phones_detail").map((f, i) => (
                      <td key={f} className="py-2 px-3">
                        {i === 0 ? "Итого" : String(report.totals[f] ?? "")}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {showPhones && report && (
        <PhonesDrawer phones={report.phonesDetail ?? []} onClose={() => setShowPhones(false)} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/pages/reports/ClientReportTab.tsx
git commit -m "feat(reports): add ClientReportTab main component"
```

---

## Task 18: Wire tabs в `ReportsPage`

**Files:**
- Modify: `src/pages/ReportsPage.tsx`

- [ ] **Step 1: Обернуть существующую логику в новый компонент**

Текущий экспорт `ReportsPage` уже возвращает страницу с иерархией. Нам нужно добавить переключение между двумя вкладками.

Открыть `src/pages/ReportsPage.tsx`. Сразу после импортов вверху добавить:

```tsx
import { useState } from "react";
import { ClientReportTab } from "./reports/ClientReportTab";
```

Найти `export function ReportsPage()` — в текущей версии там всё содержимое. Переименовать внутреннюю функцию в `HierarchyReportTab`:

```tsx
function HierarchyReportTab() {
  // ... весь текущий код функции ReportsPage
}
```

Добавить новую обёртку с вкладками:

```tsx
export function ReportsPage() {
  const [tab, setTab] = useState<"hierarchy" | "client">("hierarchy");
  return (
    <div className="space-y-4">
      <div className="flex items-center border-b border-border">
        <button
          onClick={() => setTab("hierarchy")}
          className={`px-4 py-2 text-sm font-medium ${
            tab === "hierarchy" ? "border-b-2 border-primary text-primary" : "text-muted-foreground"
          }`}
          data-testid="tab-hierarchy"
        >
          Иерархия
        </button>
        <button
          onClick={() => setTab("client")}
          className={`px-4 py-2 text-sm font-medium ${
            tab === "client" ? "border-b-2 border-primary text-primary" : "text-muted-foreground"
          }`}
          data-testid="tab-client"
        >
          Отчёт клиенту
        </button>
      </div>
      {tab === "hierarchy" ? <HierarchyReportTab /> : <ClientReportTab />}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: PASS

- [ ] **Step 3: Запустить dev и убедиться, что обе вкладки работают**

```bash
npm run dev
```
Перейти на `/reports`. Проверить:
- Вкладка «Иерархия» работает как раньше
- Вкладка «Отчёт клиенту» открывается, показывает фильтры + поля

- [ ] **Step 4: Commit**

```bash
git add src/pages/ReportsPage.tsx
git commit -m "feat(reports): add tabs (Hierarchy / Client report) to ReportsPage"
```

---

## Task 19: Финальная проверка + ручной smoke test

- [ ] **Step 1: Прогнать все новые тесты**

```bash
npx vitest run convex/lib/phoneExtractor.test.ts convex/reportTemplates.test.ts
```
Expected: PASS (всего ~15 тестов новых)

- [ ] **Step 2: Существующие тесты не сломались**

```bash
npm run test
```
Expected: PASS

- [ ] **Step 3: Полный typecheck + lint**

```bash
npx tsc --noEmit -p convex/tsconfig.json && npx tsc --noEmit && npm run lint
```
Expected: PASS (≤ 50 warnings)

- [ ] **Step 4: Manual smoke test**

1. `npm run dev`
2. Залогиниться, настроить минимум: один рекламный кабинет + один профиль сообщества (из Plan A)
3. Перейти в «Отчёты» → «Отчёт клиенту»
4. Выбрать период (последние 7 дней), кабинет, сообщество, оставить дефолтные поля
5. Добавить поля: `message_starts`, `phones_count`, `phones_detail`, `senler_subs`
6. Нажать «Применить» — проверить, что строится (может быть долго, следить за прогрессом)
7. Убедиться, что таблица содержит корректные данные (проверить итоги)
8. Нажать «Номера» — открывается drawer со списком
9. Нажать «Скачать Excel» — файл скачивается, открывается, содержит листы «Сводка», «Отчёт», «Номера»
10. Создать шаблон, закрыть страницу, вернуться — шаблон виден в dropdown, загружается корректно
11. Удалить шаблон

Если пункты 1-11 работают — Plan B готов.

---

## Done criteria

- [ ] Схема содержит `reportTemplates` с индексом
- [ ] Каталог полей (17 позиций) в backend + frontend
- [ ] Phone extractor с тестами покрывает RU/BY/UA
- [ ] VK API расширен (getConversations, getHistory, usersGet)
- [ ] Senler API расширен (getSubscribersByDateRange)
- [ ] `reportTemplates` CRUD (limit 10, ownership, field validation)
- [ ] `buildReport` action собирает ad metrics + community dialogs + lead ads + Senler
- [ ] UI: ClientReportTab + FieldPicker + TemplateSelector + PhonesDrawer
- [ ] Excel export (3 листа)
- [ ] Вкладки в ReportsPage работают
- [ ] Все тесты проходят, typecheck/lint — clean
- [ ] Ручная проверка на реальных данных

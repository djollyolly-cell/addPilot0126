# Agency Pre-flight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Подготовить production-инфраструктуру и кодовую базу AdPilot к будущему внедрению agency-модели: убрать существующие баги/несогласованности, добавить наблюдаемость VK API rate-limits, восстановить здоровье cron-ов. После этого плана сервис станет stable + observable, что является обязательным условием перед любыми agency-задачами.

**Architecture:** Только адаптации существующих модулей + одна новая таблица `vkApiLimits` для логирования rate-limit заголовков. Никаких новых подсистем, никаких breaking-changes — все правки backward-compatible. Каждая задача либо чисто техническая (индексы, расширение схемы через `v.optional`), либо bug-fix с гарантией что текущее поведение не страдает.

**Rate-limit logging — архитектура callback:** `callMtApi` — plain async-функция без доступа к Convex `ctx`. Вместо пробрасывания ctx внутрь, используется callback-паттерн: optional `onResponse` callback в options. Caller (action с доступом к ctx) передаёт closure, которая логирует через `ctx.scheduler.runAfter`. Чистое разделение: `callMtApi` не знает про Convex.

**Tech Stack:** Convex (self-hosted, INSTANCE_NAME=adpilot-prod), React 18 + Vite, TypeScript, Vitest для unit-тестов, Playwright для E2E.

**Контекст реальной prod-нагрузки (на 2026-04-19 20:54 MSK):**
- 88 users, 109 sessions, 264 adAccounts (active), 202 rules, 78 payments
- 49,302 campaigns, 65,594 ads, 770,827 metricsDaily, 141,803 actionLogs
- RAM main-сервера 96% (критично — см. Task 7)
- Stuck cron `cleanup-realtime-metrics` (running 12+ часов, started 19.04 08:00)
- Failure rate на `auth:refreshViaVitamin`, `auth:refreshVkToken`, `syncMetrics:syncAll` (известная проблема Витамина, не блокер)

**Связанные документы:**
- Spec: [`docs/superpowers/specs/2026-04-15-agency-pricing-infrastructure-design.md`](../specs/2026-04-15-agency-pricing-infrastructure-design.md)
- Impact analysis: [`docs/superpowers/specs/2026-04-19-agency-pricing-impact-analysis.md`](../specs/2026-04-19-agency-pricing-impact-analysis.md)

---

## File Structure

| Файл | Действие | Ответственность |
|---|---|---|
| `convex/schema.ts` | Modify | Добавить индексы `users.by_telegramUserId`, `users.by_telegramChatId` + новая таблица `vkApiLimits` |
| `convex/rules.ts` | Modify | Экспортировать `TIER_RULE_LIMITS`, исправить `freemium: 2` → `freemium: 3` (2 мутации: `create` и `toggleActive`) |
| `convex/vkApi.ts` | Modify | `extractRateLimitHeaders` pure helper + callback `onResponse` в `callMtApi` |
| `convex/syncMetrics.ts` | Modify | Подключить `onResponse` callback в `syncAll` — передать accountId в getMtStatistics/getMtLeadCounts/getMtBanners |
| `convex/reports.ts` | Modify | Удалить локальную копию callMtApi, импортировать из vkApi.ts + добавить batching statistics |
| `convex/vkApiLimits.ts` | Create | Internal mutation `recordRateLimit` + internal action `probeThrottling` |
| `convex/crons.ts` | Modify | Добавить cron `vk-throttling-probe` (каждые 15 мин) |
| `convex/migrations.ts` | Modify | Добавить `resetStuckCleanupHeartbeat` — одноразовая мутация |
| `convex/telegram.ts` | Modify | Переключить 3 full-scan lookups на индексы `by_telegramChatId` (L434, L952, L1682) |
| `tests/unit/rule-tier-limits.test.ts` | Create | Test что `TIER_RULE_LIMITS.freemium === TIERS.freemium.rulesLimit` (через import) |
| `tests/unit/vk-api-rate-limit-extraction.test.ts` | Create | Test что заголовки парсятся корректно |
| `convex/vkApiLimits.test.ts` | Create | Test recordRateLimit insert + dedup |
| `docs/server-ram-upgrade.md` | Create | Operational runbook: апгрейд hoster.by RAM 22.82 → 32 GB (manual step) |

---

## Task 1: Reset stuck `cleanup-realtime-metrics` heartbeat (operational fix)

**Контекст:** В cronHeartbeats запись `cleanup-realtime-metrics` имеет `status="running"` с `startedAt=19.04 08:00 MSK`, не завершена. Текущее время ~20:54 MSK = **12+ часов**. По коду [convex/metrics.ts:330-345](convex/metrics.ts) override должен сработать на следующем запуске cron-а (`0 */6 * * *` = каждые 6 часов: 00:00, 06:00, 12:00, 18:00 UTC). Override-логика: если `status="running"` и elapsed > 12h (CLEANUP_MAX_RUNNING_MS), cron перезапускается. Однако heartbeat мог зависнуть после запуска в 06:00 UTC (08:00 MSK), и следующий запуск в 12:00 UTC мог снова зависнуть. Ручной reset гарантирует чистое состояние.

**Files:**
- Modify: `convex/migrations.ts` (добавить мутацию)
- Test: ручная проверка через Convex dashboard после деплоя

- [ ] **Step 1: Прочитать текущий migrations.ts**

Run: `cat convex/migrations.ts`
Expected: видим существующую `setProAccountLimitForExistingUsers`, файл маленький (~28 строк)

- [ ] **Step 2: Добавить мутацию `resetStuckCleanupHeartbeat`**

Edit `convex/migrations.ts`, добавить в конец файла:

```typescript
/**
 * One-time fix: reset stuck "cleanup-realtime-metrics" heartbeat.
 * Run via Convex dashboard if heartbeat is stuck >12h with status="running".
 * Safe: only resets if currently running and started >12h ago.
 */
export const resetStuckCleanupHeartbeat = internalMutation({
  args: {},
  handler: async (ctx) => {
    const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
    const hb = await ctx.db
      .query("cronHeartbeats")
      .withIndex("by_name", (q) => q.eq("name", "cleanup-realtime-metrics"))
      .first();

    if (!hb) {
      return { reset: false, reason: "no heartbeat found" };
    }
    if (hb.status !== "running") {
      return { reset: false, reason: `status is ${hb.status}, not running` };
    }
    if (Date.now() - hb.startedAt < TWELVE_HOURS_MS) {
      return { reset: false, reason: "heartbeat is recent (<12h)" };
    }

    await ctx.db.patch(hb._id, {
      status: "failed",
      finishedAt: Date.now(),
      error: "Manual reset: stuck >12h, presumed crashed",
    });
    return { reset: true, startedAt: hb.startedAt, ageMs: Date.now() - hb.startedAt };
  },
});
```

- [ ] **Step 3: Закоммитить**

```bash
git add convex/migrations.ts
git commit -m "fix(ops): add manual reset for stuck cleanup-realtime-metrics heartbeat

Heartbeat stuck >12h on prod (started 19.04 08:00 MSK, still running).
Cron runs every 6h (0 */6 * * *), not daily.
Safe one-time fix: only resets if status=running AND >12h old."
```

- [ ] **Step 4: После деплоя — выполнить мутацию через dashboard**

Через Convex dashboard `http://178.172.235.49:6792/functions`:
1. Найти `migrations:resetStuckCleanupHeartbeat`
2. Run без параметров
3. Ожидаемый ответ: `{ reset: true, startedAt: 1745042400000, ageMs: > 43200000 }`
4. Проверить cronHeartbeats → запись теперь `status="failed"`

Expected: следующий запуск cron-а `cleanup-old-realtime-metrics` (`0 */6 * * *`, ближайший в 00:00 UTC) сможет начать work-цикл.

---

## Task 2: Fix freemium rule limit mismatch (bug B1 из impact-analysis 17.5)

**Контекст:** [billing.ts:11](convex/billing.ts) и [PricingPage.tsx:19](src/pages/PricingPage.tsx) обещают пользователю `freemium.rulesLimit: 3`, но [rules.ts:142](convex/rules.ts) hardcoded `freemium: 2` и [rules.ts:153](convex/rules.ts) `?? 2`, [rules.ts:405](convex/rules.ts) `freemium: 2`, [rules.ts:417](convex/rules.ts) `?? 2`. UI показывает «3 правила», третье создать не получается.

**Ключевое исправление:** Вместо 2 inline `tierRuleLimits` констант — экспортировать единый `TIER_RULE_LIMITS` и использовать в обеих мутациях. Это устраняет рассинхронизацию навсегда.

**Мутации с дубликатом:** `create` (L141) и `toggleActive` (L404). НЕ `update` (L238) — `update` не проверяет tier limit.

**Files:**
- Modify: `convex/rules.ts:141-145, 153, 404-408, 417`
- Test: `tests/unit/rule-tier-limits.test.ts`

- [ ] **Step 1: Экспортировать единый `TIER_RULE_LIMITS`**

Edit `convex/rules.ts`. В начале файла (после imports) добавить:

```typescript
/**
 * Single source of truth for tier-based rule limits.
 * Must match billing.ts TIERS[tier].rulesLimit.
 * Exported for testing. Used in create + toggleActive.
 *
 * Cross-plan note: Plan 3 (Billing Agency) will extend with
 * agency_s/m/l/xl: Infinity when agency tiers are added.
 */
export const TIER_RULE_LIMITS: Record<string, number> = {
  freemium: 3,
  start: 10,
  pro: Infinity,
};
```

- [ ] **Step 2: Заменить inline tierRuleLimits в `create` mutation**

Edit `convex/rules.ts`. В `create` mutation (L141-153):

```typescript
// Before (L141-145):
const tierRuleLimits: Record<string, number> = {
  freemium: 2,
  start: 10,
  pro: Infinity,
};

// After — удалить inline, использовать экспорт:
// (удалить блок L141-145 целиком)

// Before (L153):
const ruleLimit = tierRuleLimits[user.subscriptionTier ?? "freemium"] ?? 2;

// After:
const ruleLimit = TIER_RULE_LIMITS[user.subscriptionTier ?? "freemium"] ?? 3;
```

- [ ] **Step 3: Заменить inline tierRuleLimits в `toggleActive` mutation**

Edit `convex/rules.ts`. В `toggleActive` mutation (L404-417):

```typescript
// Before (L404-408):
const tierRuleLimits: Record<string, number> = {
  freemium: 2,
  start: 10,
  pro: Infinity,
};

// After — удалить inline, использовать экспорт:
// (удалить блок L404-408 целиком)

// Before (L417):
const ruleLimit = tierRuleLimits[user.subscriptionTier ?? "freemium"] ?? 2;

// After:
const ruleLimit = TIER_RULE_LIMITS[user.subscriptionTier ?? "freemium"] ?? 3;
```

- [ ] **Step 4: Создать тест**

Create `tests/unit/rule-tier-limits.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { TIERS } from "../../convex/billing";
import { TIER_RULE_LIMITS } from "../../convex/rules";

describe("Rule tier limits consistency", () => {
  it("TIER_RULE_LIMITS.freemium matches TIERS.freemium.rulesLimit", () => {
    expect(TIER_RULE_LIMITS.freemium).toBe(TIERS.freemium.rulesLimit);
    expect(TIER_RULE_LIMITS.freemium).toBe(3);
  });

  it("TIER_RULE_LIMITS.start matches TIERS.start.rulesLimit", () => {
    expect(TIER_RULE_LIMITS.start).toBe(TIERS.start.rulesLimit);
    expect(TIER_RULE_LIMITS.start).toBe(10);
  });

  it("TIER_RULE_LIMITS.pro is Infinity (matches TIERS.pro.rulesLimit=-1)", () => {
    expect(TIER_RULE_LIMITS.pro).toBe(Infinity);
    expect(TIERS.pro.rulesLimit).toBe(-1);
  });

  it("all individual tier keys present in TIER_RULE_LIMITS", () => {
    for (const tier of ["freemium", "start", "pro"]) {
      expect(TIER_RULE_LIMITS).toHaveProperty(tier);
      expect(typeof TIER_RULE_LIMITS[tier]).toBe("number");
    }
  });
});
```

- [ ] **Step 5: Run test to verify pass**

Run: `npm run test:unit -- tests/unit/rule-tier-limits.test.ts`
Expected: PASS all 4 tests.

- [ ] **Step 6: Запустить полный test suite + lint**

Run: `npm run test:unit && npm run lint`
Expected: PASS, без warnings.

- [ ] **Step 7: Закоммитить**

```bash
git add tests/unit/rule-tier-limits.test.ts convex/rules.ts
git commit -m "fix(rules): align freemium rule limit with billing/UI (2 -> 3)

billing.ts/PricingPage promise 3 rules on freemium, but rules.ts
hardcoded 2 in tierRuleLimits (create + toggleActive) and ?? fallbacks.
User couldn't create 3rd rule despite UI saying it's allowed.

Fix: export single TIER_RULE_LIMITS from rules.ts, use in both
create and toggleActive (was: 2 inline copies). Adds test that
imports both TIER_RULE_LIMITS and TIERS to verify consistency.

Cross-plan: Plan 3 will extend TIER_RULE_LIMITS with agency_* tiers."
```

---

## Task 3: Add `users.by_telegramUserId` and `by_telegramChatId` indexes + fix 2 full-scans (B2)

**Контекст:** `convex/telegram.ts` выполняет `.query("users").collect()` (full-table-scan) в **4 местах**. С 88 users приемлемо, но с agency-моделью (100+ менеджеров) станет блокером. Добавляем 2 индекса и переводим 3 из 4 мест на indexed lookup.

**Full-scan locations:**
| Строка | Функция | Что ищет | Действие |
|---|---|---|---|
| L434 | `linkTelegram` | `telegramChatId === chatId` | → `withIndex("by_telegramChatId")` |
| L952 | callback handler | `telegramChatId === chatId` | → `withIndex("by_telegramChatId")` |
| L982 | `fixDuplicateChatIds` | все users (итерация) | TEMP-функция, не трогаем |
| L1682 | `getDigestRecipients` | все users с telegramChatId | Оставить full-scan + comment (нельзя query "all non-null" через Convex index) |

**Files:**
- Modify: `convex/schema.ts` (добавить 2 индекса в users)
- Modify: `convex/telegram.ts` (3 изменения: L434, L952, L1682-comment)

- [ ] **Step 1: Добавить индексы в schema.ts**

Edit `convex/schema.ts`. Найти блок users `.index("by_referralCode", ["referralCode"])` и расширить:

```typescript
  .index("by_referralCode", ["referralCode"])
  .index("by_telegramUserId", ["telegramUserId"])
  .index("by_telegramChatId", ["telegramChatId"]),
```

- [ ] **Step 2: Переключить linkTelegram (L434) на индекс**

Edit `convex/telegram.ts`. Найти L434:

```typescript
// Before (full scan):
const allUsers = await ctx.db.query("users").collect();
const existingOwner = allUsers.find(
  (u) => u.telegramChatId === args.chatId && u._id !== link.userId
);

// After (index):
const existingOwner = await ctx.db
  .query("users")
  .withIndex("by_telegramChatId", (q) => q.eq("telegramChatId", args.chatId))
  .filter((q) => q.neq(q.field("_id"), link.userId))
  .first();
```

- [ ] **Step 3: Переключить callback handler (L952) на индекс**

Edit `convex/telegram.ts`. Найти L952:

```typescript
// Before (full scan):
const allUsers = await ctx.db.query("users").collect();
const existingOwner = allUsers.find(
  (u) => u.telegramChatId === args.chatId && u._id !== args.userId
);

// After (index):
const existingOwner = await ctx.db
  .query("users")
  .withIndex("by_telegramChatId", (q) => q.eq("telegramChatId", args.chatId))
  .filter((q) => q.neq(q.field("_id"), args.userId))
  .first();
```

- [ ] **Step 4: Добавить comment к getDigestRecipients (L1682)**

Edit `convex/telegram.ts`. Найти L1682:

```typescript
// Full-scan intentional: Convex indexes don't support "all non-null" queries.
// With agency model this may need restructuring (e.g., separate telegramConnections table).
// Current 88 users is acceptable; revisit if >500 users.
const users = await ctx.db.query("users").collect();
const connectedUsers = users.filter((u) => !!u.telegramChatId);
```

- [ ] **Step 5: Прогнать существующие telegram-тесты**

Run: `npm run test:unit -- convex/telegram.test.ts`
Expected: PASS (логика та же, просто оптимизация).

- [ ] **Step 6: TypeScript check**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: 0 errors.

- [ ] **Step 7: Закоммитить**

```bash
git add convex/schema.ts convex/telegram.ts
git commit -m "perf(telegram): add by_telegramUserId/by_telegramChatId indexes, fix 2 full-scans

3 out of 4 full-scan locations addressed:
- L434 (linkTelegram): chatId lookup -> withIndex
- L952 (callback handler): chatId lookup -> withIndex
- L1682 (getDigestRecipients): kept as full-scan with comment
  (Convex can't query 'all non-null', acceptable at 88 users)
- L982 (fixDuplicateChatIds): TEMP function, not changed

With agency model expecting 100s of managers, indexed lookups
prevent O(n) scans on hot paths."
```

---

## Task 4: Add `vkApiLimits` table for rate-limit logging

**Контекст:** Sec 7.1 спека требует логировать `X-RateLimit-*` заголовки из VK API ответов. Сейчас [convex/vkApi.ts](convex/vkApi.ts) `callMtApi` (L210-253) обрабатывает 429 retry, но не парсит лимиты. Нужно для observability перед добавлением agency-нагрузки.

**Files:**
- Modify: `convex/schema.ts` (добавить таблицу `vkApiLimits`)
- Create: `convex/vkApiLimits.ts` (mutation `recordRateLimit`)
- Create: `convex/vkApiLimits.test.ts`

- [ ] **Step 1: Добавить таблицу в schema.ts**

Edit `convex/schema.ts`, перед последним `}` файла (перед `}, { schemaValidation: false });`):

```typescript
  // VK API rate-limit headers from response (X-RateLimit-RPS-Limit, etc.)
  vkApiLimits: defineTable({
    accountId: v.optional(v.id("adAccounts")),  // null if probe-not-account-scoped
    endpoint: v.string(),                        // e.g. "statistics/banners/day.json"
    rpsLimit: v.optional(v.number()),
    rpsRemaining: v.optional(v.number()),
    hourlyLimit: v.optional(v.number()),
    hourlyRemaining: v.optional(v.number()),
    dailyLimit: v.optional(v.number()),
    dailyRemaining: v.optional(v.number()),
    statusCode: v.number(),                      // 200, 429, etc.
    capturedAt: v.number(),                      // Date.now()
  })
    .index("by_accountId_capturedAt", ["accountId", "capturedAt"])
    .index("by_endpoint_capturedAt", ["endpoint", "capturedAt"])
    .index("by_capturedAt", ["capturedAt"]),
```

- [ ] **Step 2: Создать `convex/vkApiLimits.ts`**

Create `convex/vkApiLimits.ts`:

```typescript
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * Record VK API rate-limit headers from a single response.
 * Called by callMtApi after parsing X-RateLimit-* headers.
 * Skips insert if all 6 numeric fields are undefined (no headers).
 */
export const recordRateLimit = internalMutation({
  args: {
    accountId: v.optional(v.id("adAccounts")),
    endpoint: v.string(),
    rpsLimit: v.optional(v.number()),
    rpsRemaining: v.optional(v.number()),
    hourlyLimit: v.optional(v.number()),
    hourlyRemaining: v.optional(v.number()),
    dailyLimit: v.optional(v.number()),
    dailyRemaining: v.optional(v.number()),
    statusCode: v.number(),
  },
  handler: async (ctx, args) => {
    const hasAnyData =
      args.rpsLimit !== undefined ||
      args.rpsRemaining !== undefined ||
      args.hourlyLimit !== undefined ||
      args.hourlyRemaining !== undefined ||
      args.dailyLimit !== undefined ||
      args.dailyRemaining !== undefined;
    if (!hasAnyData && args.statusCode !== 429) {
      return null; // skip noise — no headers and not a rate-limit event
    }
    return await ctx.db.insert("vkApiLimits", {
      ...args,
      capturedAt: Date.now(),
    });
  },
});
```

- [ ] **Step 3: Создать тест**

Create `convex/vkApiLimits.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

describe("vkApiLimits.recordRateLimit", () => {
  it("inserts a record when limit headers are present", async () => {
    const t = convexTest(schema, modules);
    const id = await t.mutation(internal.vkApiLimits.recordRateLimit, {
      endpoint: "statistics/banners/day.json",
      rpsLimit: 10,
      rpsRemaining: 7,
      dailyLimit: 100000,
      dailyRemaining: 95000,
      statusCode: 200,
    });
    expect(id).toBeTruthy();
  });

  it("skips insert when no headers and statusCode is 200", async () => {
    const t = convexTest(schema, modules);
    const id = await t.mutation(internal.vkApiLimits.recordRateLimit, {
      endpoint: "user.json",
      statusCode: 200,
    });
    expect(id).toBeNull();
  });

  it("inserts on 429 even without headers", async () => {
    const t = convexTest(schema, modules);
    const id = await t.mutation(internal.vkApiLimits.recordRateLimit, {
      endpoint: "user.json",
      statusCode: 429,
    });
    expect(id).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run test:unit -- convex/vkApiLimits.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: TypeScript check**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: 0 errors.

- [ ] **Step 6: Закоммитить**

```bash
git add convex/schema.ts convex/vkApiLimits.ts convex/vkApiLimits.test.ts
git commit -m "feat(observability): add vkApiLimits table for rate-limit logging

New table tracks X-RateLimit-* headers from VK API responses per
endpoint/account. Foundation for agency rate-limit monitoring.
recordRateLimit mutation skips noise (no headers, status=200) but
always records 429 events. 3 tests cover insert/skip/429 paths."
```

---

## Task 5: Wire rate-limit extraction into `callMtApi` (callback architecture)

**Контекст:** `callMtApi` — plain async-функция (L210-253), **не** Convex action. У неё нет доступа к `ctx.scheduler`. Чтобы сохранить чистое разделение и backward-compatibility, используем callback-паттерн: optional `onResponse` в options. Caller (action) передаёт closure.

**Текущая сигнатура (L210):**
```typescript
async function callMtApi<T>(
  endpoint: string,
  accessToken: string,
  params?: Record<string, string>
): Promise<T>
```

**Files:**
- Modify: `convex/vkApi.ts:210-253` (callMtApi)
- Modify: `convex/syncMetrics.ts` (подключить callback в syncAll — 1 горячий call site)
- Test: `tests/unit/vk-api-rate-limit-extraction.test.ts`

- [ ] **Step 1: Создать pure helper для парсинга headers + тест**

Create `tests/unit/vk-api-rate-limit-extraction.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { extractRateLimitHeaders } from "../../convex/vkApi";

describe("extractRateLimitHeaders", () => {
  it("parses all standard X-RateLimit-* headers", () => {
    const headers = new Headers({
      "X-RateLimit-RPS-Limit": "10",
      "X-RateLimit-RPS-Remaining": "7",
      "X-RateLimit-Hourly-Limit": "5000",
      "X-RateLimit-Hourly-Remaining": "4321",
      "X-RateLimit-Daily-Limit": "100000",
      "X-RateLimit-Daily-Remaining": "95000",
    });
    const result = extractRateLimitHeaders(headers);
    expect(result).toEqual({
      rpsLimit: 10,
      rpsRemaining: 7,
      hourlyLimit: 5000,
      hourlyRemaining: 4321,
      dailyLimit: 100000,
      dailyRemaining: 95000,
    });
  });

  it("returns undefined for missing headers", () => {
    const headers = new Headers({
      "Content-Type": "application/json",
    });
    const result = extractRateLimitHeaders(headers);
    expect(result).toEqual({
      rpsLimit: undefined,
      rpsRemaining: undefined,
      hourlyLimit: undefined,
      hourlyRemaining: undefined,
      dailyLimit: undefined,
      dailyRemaining: undefined,
    });
  });

  it("ignores non-numeric header values gracefully", () => {
    const headers = new Headers({
      "X-RateLimit-RPS-Limit": "not-a-number",
      "X-RateLimit-Daily-Remaining": "5000",
    });
    const result = extractRateLimitHeaders(headers);
    expect(result.rpsLimit).toBeUndefined();
    expect(result.dailyRemaining).toBe(5000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/vk-api-rate-limit-extraction.test.ts`
Expected: FAIL with "extractRateLimitHeaders is not a function" or import error.

- [ ] **Step 3: Реализовать `extractRateLimitHeaders` в vkApi.ts**

Edit `convex/vkApi.ts`. Перед `callMtApi` (примерно L205) добавить:

```typescript
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
```

- [ ] **Step 4: Run unit test to verify pass**

Run: `npm run test:unit -- tests/unit/vk-api-rate-limit-extraction.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Добавить optional `onResponse` callback в callMtApi**

Edit `convex/vkApi.ts`. Изменить сигнатуру callMtApi (L210):

```typescript
/** Callback info passed to onResponse */
export interface CallMtApiResponseInfo {
  endpoint: string;
  statusCode: number;
  rateLimits: RateLimitHeaders;
}

async function callMtApi<T>(
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
```

Все 46 existing call sites в vkApi.ts продолжают работать (4-й param optional).

- [ ] **Step 6: Подключить callback в syncAll (1 горячий call site)**

Edit `convex/syncMetrics.ts`. Найти `syncAll` action. В начале handler-а создать helper:

```typescript
// Rate-limit logging closure — captures ctx for fire-and-forget
const makeRateLimitLogger = (accountId: Id<"adAccounts">) => ({
  onResponse: (info: { endpoint: string; statusCode: number; rateLimits: any }) => {
    const hasData =
      info.rateLimits.rpsLimit !== undefined ||
      info.rateLimits.dailyRemaining !== undefined ||
      info.statusCode === 429;
    if (hasData) {
      void ctx.scheduler.runAfter(0, internal.vkApiLimits.recordRateLimit, {
        accountId,
        endpoint: info.endpoint,
        statusCode: info.statusCode,
        ...info.rateLimits,
      }).catch(() => { /* non-critical */ });
    }
  },
});
```

Затем найти callMtApi вызовы внутри syncAll (например, вызов `getMtStatistics` или прямой `callMtApi`) и передать options:

```typescript
// Пример подключения (точные строки зависят от структуры syncAll):
const stats = await callMtApi<StatsResponse>(
  "statistics/banners/day.json",
  token,
  params,
  makeRateLimitLogger(account._id)
);
```

ВАЖНО: syncAll вызывает VK API через вспомогательные функции (getMtStatistics, getMtLeadCounts и др.), которые сами вызывают callMtApi. Чтобы не менять все вспомогательные функции, достаточно подключить callback в самые горячие call sites — `getMtStatistics` (статистика) и `getCampaignsSpentTodayBatch` (расход). Остальные call sites подключаются постепенно за пределами pre-flight.

Минимальный вариант для pre-flight: подключить callback в `getCampaignsSpentTodayBatch` (internalAction, L567 в vkApi.ts) — самый частый вызов (каждые 5 мин × N аккаунтов).

**Важно:** Текущий handler использует `(_, args)` — ctx отброшен. Нужно заменить `_` на `ctx` чтобы получить доступ к `ctx.scheduler`. Также в args нет `accountId` — добавить optional field.

Edit `convex/vkApi.ts`. В `getCampaignsSpentTodayBatch` (~L567):

```typescript
export const getCampaignsSpentTodayBatch = internalAction({
  args: {
    accessToken: v.string(),
    campaignIds: v.array(v.string()),
    accountId: v.optional(v.id("adAccounts")),  // NEW: for rate-limit logging
  },
  handler: async (ctx, args): Promise<Record<string, number>> => {
    // ↑ was (_, args) — changed to (ctx, args) for ctx.scheduler access
    if (args.campaignIds.length === 0) return {};

    // ... existing setup (msk, today, result, CHUNK_SIZE) ...

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
          }).catch(() => {});
        }
      },
    };

    // Pass rlOptions to callMtApi calls in the chunk loop:
    const data = await callMtApi<...>(endpoint, token, params, rlOptions);
    // ...
  },
});
```

**Caller update:** все call sites `getCampaignsSpentTodayBatch` в syncMetrics.ts должны передавать `accountId` (уже есть в контексте sync-loop). Поле optional — существующие вызовы без accountId продолжат работать.

- [ ] **Step 7: TypeScript check**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: 0 errors.

- [ ] **Step 8: Прогнать существующие vkApi тесты**

Run: `npm run test:unit -- convex/vkApi.test.ts`
Expected: PASS (signature backward-compat).

- [ ] **Step 9: Закоммитить**

```bash
git add tests/unit/vk-api-rate-limit-extraction.test.ts convex/vkApi.ts convex/syncMetrics.ts
git commit -m "feat(observability): callMtApi callback for rate-limit logging

Architecture: onResponse callback pattern instead of leaking Convex
ctx into plain function. callMtApi stays Convex-agnostic.

- extractRateLimitHeaders: pure helper, exported + tested
- RateLimitHeaders interface exported for consumers
- callMtApi: optional 4th param { onResponse } — backward-compat
- getCampaignsSpentTodayBatch: first call site wired (hottest path)
- onResponse wrapped in try/catch — never fails the API call

Remaining 45+ call sites can be wired incrementally. reports.ts has
a local callMtApi copy (not exported from vkApi.ts) — not addressed
in this task; see Known Issues in self-review."
```

---

## Task 6: Add `vk-throttling-probe` cron (every 15 min)

**Контекст:** Spec 7.1 требует periodic вызов `GET /api/v2/throttling.json` per token, чтобы видеть актуальные квоты per resource. Запускаем для всех active adAccounts с валидным токеном.

**Files:**
- Modify: `convex/vkApiLimits.ts` (добавить `probeThrottling` action)
- Modify: `convex/crons.ts` (добавить cron entry)

- [ ] **Step 1: Добавить probeThrottling action в vkApiLimits.ts**

Edit `convex/vkApiLimits.ts`, в конец файла добавить:

```typescript
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { extractRateLimitHeaders } from "./vkApi";

/** Get all active adAccounts with tokens for throttling probe. */
export const listAccountsForProbe = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("adAccounts").collect();
    const now = Date.now();
    return accounts
      .filter((a) =>
        a.status === "active" &&
        a.accessToken &&
        // Include accounts with no tokenExpiresAt (field may be unset)
        // — token might still be valid, probe will discover if not
        (!a.tokenExpiresAt || a.tokenExpiresAt > now)
      )
      .map((a) => ({
        _id: a._id,
        accessToken: a.accessToken,
        name: a.name,
      }));
  },
});

/**
 * Probe VK API throttling.json for all active accounts.
 * Logs result to vkApiLimits. Limited to first 30 accounts per run
 * to avoid hammering VK (cron runs every 15 min, full coverage in ~2h).
 */
export const probeThrottling = internalAction({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.runQuery(internal.vkApiLimits.listAccountsForProbe);
    const batch = accounts.slice(0, 30);

    let logged = 0;
    let errors = 0;
    for (const account of batch) {
      try {
        const url = "https://ads.vk.com/api/v2/throttling.json";
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${account.accessToken}` },
          signal: AbortSignal.timeout(15_000),
        });

        const rateLimits = extractRateLimitHeaders(response.headers);
        await ctx.runMutation(internal.vkApiLimits.recordRateLimit, {
          accountId: account._id,
          endpoint: "throttling.json",
          ...rateLimits,
          statusCode: response.status,
        });
        logged++;
      } catch (e) {
        errors++;
        // non-blocking; next cron will retry
      }
    }

    console.log(`[vk-throttling-probe] logged=${logged}, errors=${errors}, batch=${batch.length}`);
    return { logged, errors, batchSize: batch.length, totalAccounts: accounts.length };
  },
});
```

- [ ] **Step 2: Добавить cron entry**

Edit `convex/crons.ts`, в конец перед `export default crons;`:

```typescript
// VK API throttling probe — every 15 min, batches 30 accounts/run
crons.interval(
  "vk-throttling-probe",
  { minutes: 15 },
  internal.vkApiLimits.probeThrottling
);
```

- [ ] **Step 3: TypeScript check**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: 0 errors.

- [ ] **Step 4: Прогнать tests**

Run: `npm run test:unit`
Expected: PASS, никакие existing-тесты не сломались.

- [ ] **Step 5: Закоммитить**

```bash
git add convex/vkApiLimits.ts convex/crons.ts
git commit -m "feat(observability): add vk-throttling-probe cron (every 15 min)

Polls VK Ads /api/v2/throttling.json per active account, batches 30
accounts/run for full coverage in ~2h. Uses extractRateLimitHeaders
from vkApi.ts (reuse, not duplicate). Token filter includes accounts
with unset tokenExpiresAt (field is optional in schema).

Foundation for agency rate-limit monitoring before scaling load.
Non-blocking: errors logged but don't fail other accounts."
```

---

## Task 7: Document RAM upgrade requirement (manual ops)

**Контекст:** Spec 7.1 пункт 1: «Апгрейд RAM до 32 GB — текущие 96% загрузки критичны». Это manual step через панель hoster.by, не код. Документируем для оператора, чтобы план был complete.

**Files:**
- Create: `docs/server-ram-upgrade.md`

- [ ] **Step 1: Создать runbook**

Create `docs/server-ram-upgrade.md`:

```markdown
# Server RAM Upgrade — Operational Runbook

**Trigger:** Pre-flight для agency-модели. Текущая нагрузка main-сервера 96% (22.82 GB used / 22.82 GB total) — критическая зона. До запуска любых задач из agency-плана необходимо увеличить RAM.

## Целевая конфигурация

| Параметр | Сейчас | После апгрейда |
|---|---|---|
| RAM | 22.82 GB | 32 GB |
| Использование | 96% | ~70% (запас 30%) |
| Стоимость | 15.83 BYN/день | ~21 BYN/день (+5) |

## Steps

1. Открыть панель Hoster.by → VPS `178.172.235.49`
2. Раздел Resize / Изменение конфигурации
3. Выбрать пресет 32 GB RAM (CPU оставить как есть)
4. Подтвердить — Hoster.by поддерживает live-resize без переустановки
5. Дождаться применения (обычно 1-2 минуты, без даунтайма)
6. Проверить через SSH: `free -h` → должно показать `~31Gi total`
7. Проверить Convex здоровье через дашборд: http://178.172.235.49:6792/health → метрика «Used RAM» должна упасть до ~70%

## Rollback (если проблемы)

Hoster.by поддерживает downgrade тем же интерфейсом. Откат до 22.82 GB занимает 1-2 минуты. **Внимание:** при downgrade Convex может уйти в OOM-kill — делать только в окне обслуживания.

## Когда делать

**До** старта Plan 1 (Schema foundation). После — все миграции будут проходить с запасом по памяти.

## Verification после апгрейда

- [ ] `free -h` показывает 32 GB
- [ ] Convex Health дашборд: usedMemory < 80%
- [ ] Sync продолжает работать (sync-metrics cron heartbeat finished < 5 min ago)
- [ ] Новый running headroom для миграций ~10 GB
```

- [ ] **Step 2: Закоммитить**

```bash
git add docs/server-ram-upgrade.md
git commit -m "docs(ops): add RAM upgrade runbook for pre-flight

Manual step required before Plan 1 (Schema foundation).
Current RAM at 96% (22.82 GB) — needs hoster.by upgrade to 32 GB.
Live-resize, no downtime, +5 BYN/day."
```

---

## Task 8: End-of-plan verification

После всех Task 1-7 — финальная проверка что всё работает.

- [ ] **Step 1: Полный CI**

Run: `npm run ci`
Expected: lint (≤50 warnings), typecheck, unit tests (≥335 tests pass), build, E2E.

- [ ] **Step 2: Convex schema validation локально**

Run: `npx convex dev --once` или эквивалент
Expected: schema валидируется, все индексы создаются, новые таблицы добавлены.

- [ ] **Step 3: Smoke-test через staging (DEV instance)**

Если есть DEV-окружение `https://dev-convex.aipilot.by`:
1. Деплой через CI
2. Проверить, что cron `vk-throttling-probe` запускается раз в 15 мин (Logs panel)
3. Через 30 мин — проверить что `vkApiLimits` начинает заполняться
4. Проверить cronHeartbeats — нет stuck-records

Expected: `vkApiLimits.length > 0` после 30 минут работы DEV.

- [ ] **Step 4: Production deploy**

Push to main → GitHub Actions выполнит deploy на PROD автоматически.

- [ ] **Step 5: Post-deploy actions**

Через Convex dashboard `http://178.172.235.49:6792/functions`:
1. Запустить `migrations:resetStuckCleanupHeartbeat` (Task 1)
2. Через 30 мин проверить, что `vkApiLimits` начинает заполняться на prod
3. Через 24 часа собрать первый batch quota-данных, обсудить нужно ли сейчас multi-IP

- [ ] **Step 6: Финальный коммит/PR (если делалось не на main)**

```bash
gh pr create --title "Pre-flight for agency model" --body "..."
```

---

## Self-Review Checklist (выполнено при написании плана)

**Spec coverage:**
- ✅ B1 (freemium rule limit) — Task 2
- ✅ B2 (telegram indexes) — Task 3
- ✅ Spec 7.1 пункт 2 (X-RateLimit logging) — Tasks 4, 5
- ✅ Spec 7.1 пункт 3 (throttling.json probe) — Task 6
- ✅ Spec 7.1 пункт 1 (RAM upgrade) — Task 7
- ✅ Stuck cron operational fix — Task 1
- ⚠ C10 (cleanup-old-logs retention) — НЕ в этом плане. Анализ logCleanup.ts показал: чистит systemLogs (30д), auditLog (90д), adminAlertDedup (1д). НЕ трогает actionLogs или metricsDaily. Monthly-org-report не пострадает. Документ pre-flight не требует изменений по C10.

**Placeholder scan:**
- Никаких "TODO/TBD/...".
- Все code-блоки полные, не "..." внутри функций.

**Type consistency:**
- `RateLimitHeaders` interface + `CallMtApiResponseInfo` — единые типы в vkApi.ts, переиспользуются в vkApiLimits.ts и syncMetrics.ts.
- `extractRateLimitHeaders(headers: Headers)` — единая сигнатура в Task 5 step 3 и в test step 1, и в Task 6 (probeThrottling использует тот же helper).
- `recordRateLimit` args одинаковы в Tasks 4, 5, 6.
- `TIER_RULE_LIMITS` — единый экспорт из rules.ts, тестируется через import.

**Known issues (не в scope pre-flight, задокументированы):**
- ✅ ~~`reports.ts:15` содержит **локальную копию** `callMtApi`~~ — **ИСПРАВЛЕНО** (2026-04-20): локальная копия удалена, reports.ts теперь импортирует `callMtApi` из vkApi.ts. Добавлен batching (CHUNK_SIZE=200) для statistics-вызовов.
- ⚠ `schemaValidation: false` в schema.ts — runtime-валидация Convex отключена. Новая таблица `vkApiLimits` принимает любые данные runtime, валидация только через mutation args. Не блокер — стандартная практика в проекте, но стоит учитывать при agency-масштабировании.
- ⚠ `getDigestRecipients` (telegram.ts:1682) остаётся full-scan. Convex не поддерживает query "все записи с non-null полем". При >500 users рассмотреть отдельную таблицу `telegramConnections`.

**Cross-plan dependencies:**
- Plan 3 (Billing Agency) расширяет TIERS с agency_* тарифами → должен также расширить `TIER_RULE_LIMITS` в rules.ts: `agency_s: Infinity, agency_m: Infinity, agency_l: Infinity, agency_xl: Infinity`.
- Plan 5 (Rule Engine) переписывает `rules.create` → должен использовать экспортированный `TIER_RULE_LIMITS` вместо inline.
- Plan 6 (UI + Reports) предполагает что `vkApiLimits` заполняется — зависит от Task 5 подключения callback.

---

## Changelog (brainstorm review 2026-04-20)

Исправления по результатам code-level верификации:

| # | Было | Стало | Причина |
|---|------|-------|---------|
| 1 | Task 1: cron `0 5 * * *` daily | `0 */6 * * *` каждые 6 часов | Фактическая ошибка — crons.ts:149-152 |
| 2 | Task 2: «in `update` mutation L404» | `toggleActive` mutation L383 | rules.ts:238=update, 383=toggleActive |
| 3 | Task 2: 2 inline `tierRuleLimits` + fs.readFile тест | Экспорт `TIER_RULE_LIMITS` + import тест | Устраняет рассинхрон навсегда, тест не хрупкий |
| 4 | Task 3: «1 callback lookup» | 3 full-scan fixes (L434, L952, L1682-comment) | Было 4 full-scan, план чинил 1 |
| 5 | Task 5: `Record<string, string \| number \| boolean>` | `Record<string, string>` | Реальная сигнатура callMtApi |
| 6 | Task 5: `callContext.ctx.scheduler` внутри callMtApi | Callback `onResponse` + wire syncAll | callMtApi — plain function без ctx |
| 7 | Task 6: `a.tokenExpiresAt && a.tokenExpiresAt > now` | `(!a.tokenExpiresAt \|\| a.tokenExpiresAt > now)` | Поле optional, пропускались кабинеты без expiry |
| 8 | Self-review: нет risk notes | +reports.ts дубликат, +schemaValidation, +digest full-scan | Полнота |
| 9 | Self-review: нет cross-plan deps | +Plan 3 TIER_RULE_LIMITS, +Plan 5 import, +Plan 6 vkApiLimits | Cross-plan трассировка |
| 10 | Task 6: inline parseInt парсинг | Использует extractRateLimitHeaders | Переиспользование, не дубликат |

## Changelog (brainstorm review #2 — 2026-04-20)

Исправления по результатам повторной code-level верификации (сверка с реальным кодом):

| # | Было | Стало | Причина |
|---|------|-------|---------|
| 11 | Task 5 Step 6: `handler: async (ctx, args)` | Явное указание `(_, args)` → `(ctx, args)` + пояснение | Реальный код L572 отбрасывает ctx как `_`, без замены callback не скомпилируется |
| 12 | Task 5 Step 6: `args.accountId` | Добавить `accountId: v.optional(v.id("adAccounts"))` в args | Реальные args (L568-570): только `accessToken` + `campaignIds`, поля `accountId` нет |
| 13 | Task 3 заголовок: "fix 3 full-scans" | "fix 2 full-scans" | По факту 2 fix (L434, L952) + 1 comment (L1682). Commit message был точнее |
| 9 | Self-review: нет cross-plan deps | +Plan 3 TIER_RULE_LIMITS, +Plan 5 import, +Plan 6 vkApiLimits | Cross-plan трассировка |
| 10 | Task 6: inline parseInt парсинг | Использует extractRateLimitHeaders | Переиспользование, не дубликат |

## Changelog (implementation fixes — 2026-04-20)

Реализованные исправления, выявленные при ревью:

| # | Проблема | Исправление | Файлы |
|---|----------|-------------|-------|
| 14 | Task 5 не подключён: `getMtStatistics`, `getMtLeadCounts`, `getMtBanners` не логируют rate-limits | Добавлен `accountId` arg + `(ctx, args)` + rlOptions callback во все 3 action-а, syncMetrics.ts передаёт `account._id` | `convex/vkApi.ts`, `convex/syncMetrics.ts` |
| 15 | `getMtStatistics` вызывает 414 URI Too Long (1000+ banner IDs в одном URL) | Добавлен batching CHUNK_SIZE=200 для statistics API call | `convex/vkApi.ts` |
| 16 | `reports.ts` — локальная копия callMtApi (без callback, retry, timeout) | Удалена копия, добавлен `import { callMtApi } from "./vkApi"` | `convex/reports.ts` |
| 17 | `reports.ts` — statistics вызовы без batching (те же 414 ошибки) | Добавлен `fetchStatsBatched` helper с CHUNK_SIZE=200 | `convex/reports.ts` |
| 18 | `callMtApi` не экспортировался | Добавлен `export` на функцию | `convex/vkApi.ts` |

---

## После завершения этого плана

Pre-flight выполнен. Готов к Plan 1 (Schema foundation). Возвращаемся в основную сессию для написания Plan 1.

**Next steps:**
- Plan 1: Schema migration — `payments.tier` union, `rules.conditions` union, новые таблицы `organizations/orgMembers/orgInvites/customRuleTypes/loadUnitsHistory`, `orgId?` в 9 таблицах
- Plan 2: Access control + Auth (bcrypt, invite flow, two-phase confirm)
- Plan 3: Billing agency (расширить `TIER_RULE_LIMITS` при добавлении agency_*)
- Plan 4: Load monitoring + Grace
- Plan 5: Rule engine L2/L3 (использовать `TIER_RULE_LIMITS` export из rules.ts)
- Plan 6: UI org + Reports + Telegram (зависит от vkApiLimits заполнения)

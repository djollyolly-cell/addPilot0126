# Правило «Работа с УЗ» — План реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить новый тип правила `uz_budget_manage` для автоматического управления дневным бюджетом групп с форматом «Универсальная запись» (package_id=960).

**Architecture:** Новый тип правила в существующем rule engine. Отличается от остальных 8 типов: не останавливает объявления, а изменяет бюджет группы через VK API. Требует новый крон для ежедневного сброса бюджета и новые actionType в логах. UI — отдельная форма с полями бюджета вместо стандартного поля threshold.

**Tech Stack:** Convex (backend), React + Tailwind (frontend), myTarget API v2

**Spec:** `docs/superpowers/specs/2026-04-01-uz-budget-manage-design.md`

---

## Файловая структура

| Файл | Действие | Ответственность |
|---|---|---|
| `convex/schema.ts` | Modify | Добавить `uz_budget_manage` в type union, новые actionType, расширить conditions |
| `convex/rules.ts` | Modify | Валидация и CRUD для нового типа |
| `convex/ruleEngine.ts` | Modify | Логика проверки бюджетной остановки + увеличение бюджета |
| `convex/vkApi.ts` | Modify | Новые функции: `getCampaignsByPackage()`, `updateCampaignBudget()`, `activateCampaign()` |
| `convex/uzBudgetCron.ts` | Create | Крон сброса бюджета + проверка бюджетных правил |
| `convex/crons.ts` | Modify | Зарегистрировать новый крон |
| `convex/telegram.ts` | Modify | Шаблоны уведомлений для бюджетных событий |
| `src/pages/RulesPage.tsx` | Modify | Форма для нового типа правила |

---

### Task 1: Расширить схему БД

**Files:**
- Modify: `convex/schema.ts:116-125` (rule type union)
- Modify: `convex/schema.ts:126-138` (conditions object)
- Modify: `convex/schema.ts:164-168` (actionType union)

- [ ] **Step 1: Добавить `uz_budget_manage` в type union правил**

В `convex/schema.ts` строка 116-125, изменить:

```typescript
    type: v.union(
      v.literal("cpl_limit"),
      v.literal("min_ctr"),
      v.literal("fast_spend"),
      v.literal("spend_no_leads"),
      v.literal("budget_limit"),
      v.literal("low_impressions"),
      v.literal("clicks_no_leads"),
      v.literal("new_lead"),
      v.literal("uz_budget_manage")
    ),
```

- [ ] **Step 2: Расширить conditions для бюджетных параметров**

В `convex/schema.ts` строка 126-138, изменить объект conditions:

```typescript
    conditions: v.object({
      metric: v.string(),
      operator: v.string(),
      value: v.number(),
      minSamples: v.optional(v.number()),
      timeWindow: v.optional(
        v.union(
          v.literal("daily"),
          v.literal("since_launch"),
          v.literal("24h")
        )
      ),
      // uz_budget_manage fields
      initialBudget: v.optional(v.number()),
      budgetStep: v.optional(v.number()),
      maxDailyBudget: v.optional(v.number()),
      resetDaily: v.optional(v.boolean()),
    }),
```

- [ ] **Step 3: Расширить actions для настроек уведомлений**

В `convex/schema.ts` строка 139-144, добавить поля в actions:

```typescript
    actions: v.object({
      stopAd: v.boolean(),
      notify: v.boolean(),
      notifyChannel: v.optional(v.string()),
      customMessage: v.optional(v.string()),
      // uz_budget_manage notification options
      notifyOnEveryIncrease: v.optional(v.boolean()),
      notifyOnKeyEvents: v.optional(v.boolean()),
    }),
```

- [ ] **Step 4: Добавить новые actionType в actionLogs**

В `convex/schema.ts` строка 164-168, изменить:

```typescript
    actionType: v.union(
      v.literal("stopped"),
      v.literal("notified"),
      v.literal("stopped_and_notified"),
      v.literal("budget_increased"),
      v.literal("budget_reset")
    ),
```

- [ ] **Step 5: Typecheck Convex**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: 0 errors (или ошибки только в файлах, которые ещё не обновлены — rules.ts, ruleEngine.ts)

- [ ] **Step 6: Commit**

```bash
git add convex/schema.ts
git commit -m "feat(schema): add uz_budget_manage rule type, budget conditions, new actionTypes"
```

---

### Task 2: VK API — функции управления бюджетом групп

**Files:**
- Modify: `convex/vkApi.ts`

- [ ] **Step 1: Добавить функцию получения групп по package_id**

Добавить в `convex/vkApi.ts` после существующих функций:

```typescript
const UZ_PACKAGE_ID = 960;

interface MtCampaign {
  id: number;
  name: string;
  status: string;
  package_id: number;
  daily_limit: number; // в копейках
}

/**
 * Получить группы (campaigns) аккаунта, опционально фильтруя по package_id.
 */
export async function getMtCampaigns(
  accessToken: string,
  packageId?: number
): Promise<MtCampaign[]> {
  const data = await callMtApi<MtCampaign[]>(
    "campaigns.json?fields=id,name,status,package_id,daily_limit",
    accessToken
  );
  if (!Array.isArray(data)) return [];
  if (packageId !== undefined) {
    return data.filter((c) => c.package_id === packageId);
  }
  return data;
}

/**
 * Обновить дневной бюджет группы (campaign).
 * @param newLimitRubles — новый лимит в рублях
 */
export async function updateCampaignBudget(
  accessToken: string,
  campaignId: number,
  newLimitRubles: number
): Promise<void> {
  const newLimitKopecks = Math.round(newLimitRubles * 100);
  const resp = await fetch("https://target.my.com/api/v2/campaigns.json", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([{ id: campaignId, daily_limit: newLimitKopecks }]),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Ошибка обновления бюджета группы ${campaignId}: ${resp.status} ${text}`);
  }
}

/**
 * Активировать группу (снять блокировку по бюджету).
 */
export async function activateCampaign(
  accessToken: string,
  campaignId: number
): Promise<void> {
  const resp = await fetch("https://target.my.com/api/v2/campaigns.json", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([{ id: campaignId, status: "active" }]),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Ошибка активации группы ${campaignId}: ${resp.status} ${text}`);
  }
}
```

- [ ] **Step 2: Экспортировать UZ_PACKAGE_ID**

Добавить экспорт константы:
```typescript
export const UZ_PACKAGE_ID = 960;
```

- [ ] **Step 3: Добавить Convex action-обёртки**

Добавить action-обёртки для вызова из ruleEngine:

```typescript
export const getCampaignsForAccount = internalAction({
  args: {
    accessToken: v.string(),
    packageId: v.optional(v.number()),
  },
  handler: async (_ctx, args) => {
    return await getMtCampaigns(args.accessToken, args.packageId);
  },
});

export const setBudget = internalAction({
  args: {
    accessToken: v.string(),
    campaignId: v.number(),
    newLimitRubles: v.number(),
  },
  handler: async (_ctx, args) => {
    await updateCampaignBudget(args.accessToken, args.campaignId, args.newLimitRubles);
  },
});

export const resumeCampaign = internalAction({
  args: {
    accessToken: v.string(),
    campaignId: v.number(),
  },
  handler: async (_ctx, args) => {
    await activateCampaign(args.accessToken, args.campaignId);
  },
});
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`

- [ ] **Step 5: Commit**

```bash
git add convex/vkApi.ts
git commit -m "feat(vkApi): add campaign budget management functions for uz_budget_manage"
```

---

### Task 3: Валидация и CRUD для нового типа

**Files:**
- Modify: `convex/rules.ts:5-17` (RULE_TYPE_DEFAULTS)
- Modify: `convex/rules.ts:20-33` (validateRuleValue)
- Modify: `convex/rules.ts:59-72` (create mutation args type union)

- [ ] **Step 1: Добавить defaults для uz_budget_manage**

В `convex/rules.ts` строка 5-17, добавить в `RULE_TYPE_DEFAULTS`:

```typescript
const RULE_TYPE_DEFAULTS: Record<
  string,
  { metric: string; operator: string }
> = {
  cpl_limit: { metric: "cpl", operator: ">" },
  min_ctr: { metric: "ctr", operator: "<" },
  fast_spend: { metric: "spent_speed", operator: ">" },
  spend_no_leads: { metric: "spent_no_leads", operator: ">" },
  budget_limit: { metric: "spent", operator: ">" },
  low_impressions: { metric: "impressions", operator: "<" },
  clicks_no_leads: { metric: "clicks_no_leads", operator: ">=" },
  new_lead: { metric: "leads", operator: ">" },
  uz_budget_manage: { metric: "budget_manage", operator: ">" },
};
```

- [ ] **Step 2: Обновить валидацию**

В `convex/rules.ts` строка 20-33, обновить `validateRuleValue`:

```typescript
function validateRuleValue(
  type: string,
  value: number
): string | null {
  if (type === "new_lead") return null;
  if (type === "uz_budget_manage") return null; // uses initialBudget/budgetStep instead
  if (value <= 0) {
    return "Значение должно быть больше 0";
  }
  if (type === "min_ctr" && value > 100) {
    return "CTR не может быть больше 100%";
  }
  return null;
}
```

- [ ] **Step 3: Добавить uz_budget_manage в type union мутации create**

В `convex/rules.ts` строка 63-72, добавить литерал:

```typescript
    type: v.union(
      v.literal("cpl_limit"),
      v.literal("min_ctr"),
      v.literal("fast_spend"),
      v.literal("spend_no_leads"),
      v.literal("budget_limit"),
      v.literal("low_impressions"),
      v.literal("clicks_no_leads"),
      v.literal("new_lead"),
      v.literal("uz_budget_manage")
    ),
```

- [ ] **Step 4: Добавить новые аргументы в create мутацию**

В args мутации create добавить опциональные поля:

```typescript
    initialBudget: v.optional(v.number()),
    budgetStep: v.optional(v.number()),
    maxDailyBudget: v.optional(v.number()),
    resetDaily: v.optional(v.boolean()),
    notifyOnEveryIncrease: v.optional(v.boolean()),
    notifyOnKeyEvents: v.optional(v.boolean()),
```

- [ ] **Step 5: Добавить валидацию бюджетных полей в handler create**

В handler мутации create, после существующей валидации, добавить:

```typescript
    // Validate uz_budget_manage specific fields
    if (args.type === "uz_budget_manage") {
      if (!args.initialBudget || args.initialBudget <= 0) {
        throw new Error("Укажите начальный бюджет (> 0)");
      }
      if (!args.budgetStep || args.budgetStep <= 0) {
        throw new Error("Укажите шаг увеличения (> 0)");
      }
      if (args.maxDailyBudget !== undefined && args.maxDailyBudget <= args.initialBudget) {
        throw new Error("Максимальный бюджет должен быть больше начального");
      }
      if (!args.targetCampaignIds || args.targetCampaignIds.length === 0) {
        throw new Error("Выберите группы для правила «Работа с УЗ»");
      }
    }
```

- [ ] **Step 6: Передавать бюджетные поля в conditions/actions при вставке**

При вставке правила в DB, для типа `uz_budget_manage` добавить поля в conditions и actions:

```typescript
    const conditions = {
      metric: defaults.metric,
      operator: defaults.operator,
      value: args.type === "uz_budget_manage" ? 0 : args.value,
      ...(args.minSamples !== undefined && { minSamples: args.minSamples }),
      ...(args.timeWindow && { timeWindow: args.timeWindow }),
      // uz_budget_manage fields
      ...(args.initialBudget !== undefined && { initialBudget: args.initialBudget }),
      ...(args.budgetStep !== undefined && { budgetStep: args.budgetStep }),
      ...(args.maxDailyBudget !== undefined && { maxDailyBudget: args.maxDailyBudget }),
      ...(args.resetDaily !== undefined && { resetDaily: args.resetDaily }),
    };

    const actions = {
      ...actionModeFlags,
      ...(args.notifyOnEveryIncrease !== undefined && { notifyOnEveryIncrease: args.notifyOnEveryIncrease }),
      ...(args.notifyOnKeyEvents !== undefined && { notifyOnKeyEvents: args.notifyOnKeyEvents }),
    };
```

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`

- [ ] **Step 8: Commit**

```bash
git add convex/rules.ts
git commit -m "feat(rules): add uz_budget_manage validation and CRUD"
```

---

### Task 4: Логика проверки и увеличения бюджета в ruleEngine

**Files:**
- Modify: `convex/ruleEngine.ts`

- [ ] **Step 1: Добавить case в evaluateCondition**

В `convex/ruleEngine.ts` функция `evaluateCondition()`, добавить case:

```typescript
  // uz_budget_manage: never triggers via standard evaluate — handled separately
  if (ruleType === "uz_budget_manage") return false;
```

- [ ] **Step 2: Создать функцию checkUzBudgetRules**

Добавить новую internalAction в `convex/ruleEngine.ts`:

```typescript
import { internal } from "./_generated/api";

/**
 * Проверить все активные правила uz_budget_manage.
 * Вызывается из syncAll после обновления метрик.
 */
export const checkUzBudgetRules = internalAction({
  args: {},
  handler: async (ctx) => {
    // 1. Получить все активные правила uz_budget_manage
    const uzRules = await ctx.runQuery(internal.ruleEngine.getActiveUzRules);
    if (uzRules.length === 0) return;

    for (const rule of uzRules) {
      try {
        await processUzRule(ctx, rule);
      } catch (err) {
        console.error(`[uz_budget] Error processing rule ${rule._id}:`, err);
      }
    }
  },
});

async function processUzRule(ctx: any, rule: any) {
  const { initialBudget, budgetStep, maxDailyBudget } = rule.conditions;
  if (!initialBudget || !budgetStep) return;

  for (const accountId of rule.targetAccountIds) {
    // Получить access token
    let accessToken: string;
    try {
      accessToken = await ctx.runAction(
        internal.auth.getValidTokenForAccount,
        { accountId }
      );
    } catch {
      console.error(`[uz_budget] Cannot get token for account ${accountId}`);
      continue;
    }

    // Получить группы (campaigns) из VK API
    const campaigns = await ctx.runAction(
      internal.vkApi.getCampaignsForAccount,
      { accessToken }
    );

    // Фильтровать по targetCampaignIds
    const targetIds = rule.targetCampaignIds || [];
    const targetCampaigns = campaigns.filter(
      (c: any) => targetIds.includes(String(c.id))
    );

    for (const campaign of targetCampaigns) {
      const dailyLimitRubles = campaign.daily_limit / 100;

      // Определить «приостановлена по бюджету»:
      // status == "blocked" И spent >= dailyLimit
      if (campaign.status !== "blocked") continue;

      // Получить spent за сегодня из metricsDaily
      const spentToday = await ctx.runQuery(
        internal.ruleEngine.getCampaignSpentToday,
        { accountId, campaignId: String(campaign.id) }
      );

      if (spentToday < dailyLimitRubles * 0.95) continue; // не бюджетная остановка

      // Проверить дедупликацию: не увеличивали ли бюджет в последние 5 минут
      const recentIncrease = await ctx.runQuery(
        internal.ruleEngine.hasRecentBudgetIncrease,
        { ruleId: rule._id, campaignId: String(campaign.id), withinMs: 5 * 60 * 1000 }
      );
      if (recentIncrease) continue;

      // Проверить максимальный бюджет
      if (maxDailyBudget && dailyLimitRubles >= maxDailyBudget) {
        // Достигнут максимум — уведомить и пропустить
        if (rule.actions.notifyOnKeyEvents) {
          await ctx.runAction(internal.telegram.sendBudgetNotification, {
            userId: rule.userId,
            type: "max_reached",
            campaignName: campaign.name,
            currentBudget: dailyLimitRubles,
            maxBudget: maxDailyBudget,
          });
        }
        continue;
      }

      // Увеличить бюджет
      let newLimit = dailyLimitRubles + budgetStep;
      if (maxDailyBudget) {
        newLimit = Math.min(newLimit, maxDailyBudget);
      }

      try {
        await ctx.runAction(internal.vkApi.setBudget, {
          accessToken,
          campaignId: campaign.id,
          newLimitRubles: newLimit,
        });

        // Активировать группу после увеличения бюджета
        await ctx.runAction(internal.vkApi.resumeCampaign, {
          accessToken,
          campaignId: campaign.id,
        });

        // Записать в actionLogs
        await ctx.runMutation(internal.ruleEngine.logBudgetAction, {
          userId: rule.userId,
          ruleId: rule._id,
          accountId,
          campaignId: String(campaign.id),
          campaignName: campaign.name,
          actionType: "budget_increased" as const,
          oldBudget: dailyLimitRubles,
          newBudget: newLimit,
          step: budgetStep,
        });

        // Уведомить
        const isFirstToday = await ctx.runQuery(
          internal.ruleEngine.isFirstBudgetIncreaseToday,
          { ruleId: rule._id, campaignId: String(campaign.id) }
        );

        if (rule.actions.notifyOnEveryIncrease ||
            (rule.actions.notifyOnKeyEvents && isFirstToday)) {
          await ctx.runAction(internal.telegram.sendBudgetNotification, {
            userId: rule.userId,
            type: isFirstToday ? "first_increase" : "increase",
            campaignName: campaign.name,
            oldBudget: dailyLimitRubles,
            newBudget: newLimit,
            step: budgetStep,
          });
        }

        // Increment trigger count
        await ctx.runMutation(internal.ruleEngine.incrementTriggerCount, {
          ruleId: rule._id,
        });

      } catch (err) {
        console.error(`[uz_budget] Failed to increase budget for campaign ${campaign.id}:`, err);
        await ctx.runMutation(internal.ruleEngine.logBudgetAction, {
          userId: rule.userId,
          ruleId: rule._id,
          accountId,
          campaignId: String(campaign.id),
          campaignName: campaign.name,
          actionType: "budget_increased" as const,
          oldBudget: dailyLimitRubles,
          newBudget: newLimit,
          step: budgetStep,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }
  }
}
```

- [ ] **Step 3: Добавить вспомогательные query/mutation**

```typescript
export const getActiveUzRules = internalQuery({
  args: {},
  handler: async (ctx) => {
    const allRules = await ctx.db.query("rules").collect();
    return allRules.filter(
      (r) => r.type === "uz_budget_manage" && r.isActive
    );
  },
});

export const getCampaignSpentToday = internalQuery({
  args: {
    accountId: v.id("adAccounts"),
    campaignId: v.string(),
  },
  handler: async (ctx, args) => {
    const today = new Date().toISOString().slice(0, 10);
    const metrics = await ctx.db
      .query("metricsDaily")
      .withIndex("by_accountId_date", (q) =>
        q.eq("accountId", args.accountId).eq("date", today)
      )
      .collect();
    // Суммировать spent по всем объявлениям этой группы
    const campaignMetrics = metrics.filter((m) => m.campaignId === args.campaignId);
    return campaignMetrics.reduce((sum, m) => sum + (m.spent || 0), 0);
  },
});

export const hasRecentBudgetIncrease = internalQuery({
  args: {
    ruleId: v.id("rules"),
    campaignId: v.string(),
    withinMs: v.number(),
  },
  handler: async (ctx, args) => {
    const since = Date.now() - args.withinMs;
    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_ruleId", (q) => q.eq("ruleId", args.ruleId))
      .filter((q) =>
        q.and(
          q.eq(q.field("actionType"), "budget_increased"),
          q.eq(q.field("adId"), args.campaignId),
          q.gte(q.field("createdAt"), since),
          q.eq(q.field("status"), "success")
        )
      )
      .first();
    return logs !== null;
  },
});

export const isFirstBudgetIncreaseToday = internalQuery({
  args: {
    ruleId: v.id("rules"),
    campaignId: v.string(),
  },
  handler: async (ctx, args) => {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_ruleId", (q) => q.eq("ruleId", args.ruleId))
      .filter((q) =>
        q.and(
          q.eq(q.field("actionType"), "budget_increased"),
          q.eq(q.field("adId"), args.campaignId),
          q.gte(q.field("createdAt"), todayStart.getTime()),
          q.eq(q.field("status"), "success")
        )
      )
      .first();
    return logs === null; // true если нет увеличений сегодня
  },
});

export const logBudgetAction = internalMutation({
  args: {
    userId: v.id("users"),
    ruleId: v.id("rules"),
    accountId: v.id("adAccounts"),
    campaignId: v.string(),
    campaignName: v.string(),
    actionType: v.union(v.literal("budget_increased"), v.literal("budget_reset")),
    oldBudget: v.number(),
    newBudget: v.number(),
    step: v.number(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("actionLogs", {
      userId: args.userId,
      ruleId: args.ruleId,
      accountId: args.accountId,
      adId: args.campaignId, // Используем adId для хранения campaignId
      adName: args.campaignName,
      campaignName: args.campaignName,
      actionType: args.actionType,
      reason: args.actionType === "budget_increased"
        ? `Бюджет увеличен: ${args.oldBudget}₽ → ${args.newBudget}₽ (+${args.step}₽)`
        : `Бюджет сброшен до ${args.newBudget}₽`,
      metricsSnapshot: {
        spent: args.oldBudget,
        leads: 0,
      },
      savedAmount: args.step,
      status: args.error ? "failed" as const : "success" as const,
      errorMessage: args.error,
      createdAt: Date.now(),
    });
  },
});

export const incrementTriggerCount = internalMutation({
  args: { ruleId: v.id("rules") },
  handler: async (ctx, args) => {
    const rule = await ctx.db.get(args.ruleId);
    if (!rule) return;
    await ctx.db.patch(args.ruleId, {
      triggerCount: rule.triggerCount + 1,
      lastTriggeredAt: Date.now(),
    });
  },
});
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`

- [ ] **Step 5: Commit**

```bash
git add convex/ruleEngine.ts
git commit -m "feat(ruleEngine): add uz_budget_manage check logic with budget increase and dedup"
```

---

### Task 5: Крон сброса бюджета

**Files:**
- Create: `convex/uzBudgetCron.ts`
- Modify: `convex/crons.ts`

- [ ] **Step 1: Создать uzBudgetCron.ts**

```typescript
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Крон сброса бюджета.
 * Запускается каждые 30 минут, проверяет timezone пользователя,
 * и сбрасывает бюджет если наступили новые сутки (00:00 в timezone пользователя).
 */
export const resetBudgets = internalAction({
  args: {},
  handler: async (ctx) => {
    const uzRules = await ctx.runQuery(internal.ruleEngine.getActiveUzRules);
    const resetRules = uzRules.filter((r: any) => r.conditions.resetDaily);
    if (resetRules.length === 0) return;

    for (const rule of resetRules) {
      try {
        // Получить timezone пользователя
        const settings = await ctx.runQuery(internal.uzBudgetCron.getUserTimezone, {
          userId: rule.userId,
        });
        const tz = settings?.timezone || "UTC";

        // Проверить: сейчас 00:00-00:29 в timezone пользователя?
        const now = new Date();
        const userTime = new Date(now.toLocaleString("en-US", { timeZone: tz }));
        const hour = userTime.getHours();
        const minute = userTime.getMinutes();

        // Крон запускается каждые 30 минут → ловим окно 00:00-00:29
        if (hour !== 0 || minute >= 30) continue;

        // Проверить, не сбрасывали ли уже сегодня
        const todayStr = userTime.toISOString().slice(0, 10);
        const alreadyReset = await ctx.runQuery(
          internal.uzBudgetCron.hasResetToday,
          { ruleId: rule._id, dateStr: todayStr }
        );
        if (alreadyReset) continue;

        // Сбросить бюджет для каждой целевой группы
        const { initialBudget } = rule.conditions;
        if (!initialBudget) continue;

        for (const accountId of rule.targetAccountIds) {
          let accessToken: string;
          try {
            accessToken = await ctx.runAction(
              internal.auth.getValidTokenForAccount,
              { accountId }
            );
          } catch {
            continue;
          }

          const targetIds = rule.targetCampaignIds || [];
          for (const campaignIdStr of targetIds) {
            const campaignId = parseInt(campaignIdStr);
            if (isNaN(campaignId)) continue;

            try {
              await ctx.runAction(internal.vkApi.setBudget, {
                accessToken,
                campaignId,
                newLimitRubles: initialBudget,
              });

              await ctx.runMutation(internal.ruleEngine.logBudgetAction, {
                userId: rule.userId,
                ruleId: rule._id,
                accountId,
                campaignId: campaignIdStr,
                campaignName: `Campaign ${campaignIdStr}`,
                actionType: "budget_reset" as const,
                oldBudget: 0,
                newBudget: initialBudget,
                step: 0,
              });
            } catch (err) {
              console.error(`[uz_budget_reset] Failed for campaign ${campaignId}:`, err);
            }
          }

          // Уведомить о сбросе
          if (rule.actions.notifyOnKeyEvents) {
            await ctx.runAction(internal.telegram.sendBudgetNotification, {
              userId: rule.userId,
              type: "reset",
              campaignName: `${targetIds.length} групп(а)`,
              oldBudget: 0,
              newBudget: initialBudget,
              step: 0,
            });
          }
        }
      } catch (err) {
        console.error(`[uz_budget_reset] Error processing rule ${rule._id}:`, err);
      }
    }
  },
});
```

- [ ] **Step 2: Добавить вспомогательные queries**

В том же файле `convex/uzBudgetCron.ts`:

```typescript
import { internalQuery } from "./_generated/server";
import { v } from "convex/values";

export const getUserTimezone = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const settings = await ctx.db
      .query("userSettings")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
    return settings;
  },
});

export const hasResetToday = internalQuery({
  args: {
    ruleId: v.id("rules"),
    dateStr: v.string(),
  },
  handler: async (ctx, args) => {
    // Ищем budget_reset лог за сегодня
    const dayStart = new Date(args.dateStr).getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    const log = await ctx.db
      .query("actionLogs")
      .withIndex("by_ruleId", (q) => q.eq("ruleId", args.ruleId))
      .filter((q) =>
        q.and(
          q.eq(q.field("actionType"), "budget_reset"),
          q.gte(q.field("createdAt"), dayStart),
          q.lt(q.field("createdAt"), dayEnd)
        )
      )
      .first();
    return log !== null;
  },
});
```

- [ ] **Step 3: Зарегистрировать крон**

В `convex/crons.ts` добавить перед `export default crons;`:

```typescript
// Reset UZ budget daily (checks user timezone, runs every 30 min)
crons.interval(
  "uz-budget-reset",
  { minutes: 30 },
  internal.uzBudgetCron.resetBudgets
);
```

- [ ] **Step 4: Интегрировать checkUzBudgetRules в syncAll**

В `convex/syncMetrics.ts`, в конце функции `syncAll`, после вызова `checkAllRules`, добавить:

```typescript
// Check uz_budget_manage rules (separate from standard rules)
await ctx.runAction(internal.ruleEngine.checkUzBudgetRules);
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`

- [ ] **Step 6: Commit**

```bash
git add convex/uzBudgetCron.ts convex/crons.ts convex/syncMetrics.ts
git commit -m "feat: add uz_budget_manage cron for daily reset and integrate with syncAll"
```

---

### Task 6: Уведомления в Telegram

**Files:**
- Modify: `convex/telegram.ts`

- [ ] **Step 1: Добавить функцию sendBudgetNotification**

В `convex/telegram.ts` добавить internalAction:

```typescript
export const sendBudgetNotification = internalAction({
  args: {
    userId: v.id("users"),
    type: v.union(
      v.literal("increase"),
      v.literal("first_increase"),
      v.literal("max_reached"),
      v.literal("reset")
    ),
    campaignName: v.string(),
    oldBudget: v.optional(v.number()),
    newBudget: v.optional(v.number()),
    step: v.optional(v.number()),
    currentBudget: v.optional(v.number()),
    maxBudget: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Получить chatId пользователя
    const user = await ctx.runQuery(internal.users.getById, { userId: args.userId });
    if (!user?.telegramChatId) return;

    let message = "";
    switch (args.type) {
      case "increase":
        message = `📊 *Бюджет увеличен*\nГруппа: ${args.campaignName}\nБюджет: ${args.oldBudget}₽ → ${args.newBudget}₽ (+${args.step}₽)`;
        break;
      case "first_increase":
        message = `📊 *Первое увеличение бюджета за день*\nГруппа: ${args.campaignName}\nБюджет: ${args.oldBudget}₽ → ${args.newBudget}₽`;
        break;
      case "max_reached":
        message = `⚠️ *Достигнут максимальный бюджет*\nГруппа: ${args.campaignName}\nТекущий бюджет: ${args.currentBudget}₽ / ${args.maxBudget}₽`;
        break;
      case "reset":
        message = `🔄 *Бюджет сброшен*\nГруппа: ${args.campaignName}\nБюджет: ${args.newBudget}₽`;
        break;
    }

    await sendTelegramMessage(user.telegramChatId, message);
  },
});
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`

- [ ] **Step 3: Commit**

```bash
git add convex/telegram.ts
git commit -m "feat(telegram): add budget notification templates for uz_budget_manage"
```

---

### Task 7: Frontend — форма правила

**Files:**
- Modify: `src/pages/RulesPage.tsx`

- [ ] **Step 1: Добавить тип в RuleType и labels**

В `src/pages/RulesPage.tsx` строка 15:

```typescript
type RuleType = 'cpl_limit' | 'min_ctr' | 'fast_spend' | 'spend_no_leads' | 'budget_limit' | 'low_impressions' | 'clicks_no_leads' | 'new_lead' | 'uz_budget_manage';
```

Добавить в `RULE_TYPE_LABELS` (строка 24-33):
```typescript
  uz_budget_manage: 'Работа с УЗ',
```

Добавить в `RULE_TYPE_DESCRIPTIONS` (строка 35-44):
```typescript
  uz_budget_manage: 'Управление дневным бюджетом группы: автоматическое увеличение при приостановке и сброс в начале суток',
```

Добавить в `RULE_TYPE_UNITS` (строка 46-55):
```typescript
  uz_budget_manage: '',
```

- [ ] **Step 2: Добавить state для бюджетных полей**

После существующих useState (около строки 66-70), добавить:

```typescript
  // uz_budget_manage specific state
  const [initialBudget, setInitialBudget] = useState<number>(100);
  const [budgetStep, setBudgetStep] = useState<number>(1);
  const [maxDailyBudget, setMaxDailyBudget] = useState<string>('');
  const [resetDaily, setResetDaily] = useState<boolean>(true);
  const [notifyOnEveryIncrease, setNotifyOnEveryIncrease] = useState<boolean>(false);
  const [notifyOnKeyEvents, setNotifyOnKeyEvents] = useState<boolean>(true);
```

- [ ] **Step 3: Добавить query для загрузки групп УЗ**

```typescript
  // Fetch UZ campaigns for uz_budget_manage rule type
  const uzCampaigns = useQuery(
    api.vkApi.getUzCampaigns,
    user?.userId && selectedType === 'uz_budget_manage'
      ? { userId: user.userId as Id<"users"> }
      : 'skip'
  );
```

- [ ] **Step 4: Добавить UI полей бюджета в форму**

В JSX формы, после стандартных полей, добавить условный блок:

```tsx
{selectedType === 'uz_budget_manage' && (
  <div className="space-y-4">
    {/* Начальный бюджет */}
    <div>
      <label className="text-sm font-medium">Начальный бюджет</label>
      <div className="flex items-center gap-2 mt-1">
        <input
          type="number"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          placeholder="100"
          value={initialBudget}
          onChange={(e) => setInitialBudget(Number(e.target.value))}
          min={1}
        />
        <span className="text-sm text-muted-foreground shrink-0">₽</span>
      </div>
    </div>

    {/* Шаг увеличения */}
    <div>
      <label className="text-sm font-medium">Шаг увеличения</label>
      <div className="flex items-center gap-2 mt-1">
        <input
          type="number"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          placeholder="1"
          value={budgetStep}
          onChange={(e) => setBudgetStep(Number(e.target.value))}
          min={1}
        />
        <span className="text-sm text-muted-foreground shrink-0">₽</span>
      </div>
    </div>

    {/* Максимальный бюджет */}
    <div>
      <label className="text-sm font-medium">Максимальный бюджет (опционально)</label>
      <div className="flex items-center gap-2 mt-1">
        <input
          type="number"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          placeholder="Без ограничений"
          value={maxDailyBudget}
          onChange={(e) => setMaxDailyBudget(e.target.value)}
          min={1}
        />
        <span className="text-sm text-muted-foreground shrink-0">₽</span>
      </div>
    </div>

    {/* Сброс бюджета */}
    <div className="flex items-center justify-between">
      <label className="text-sm font-medium">Сбрасывать бюджет ежедневно</label>
      <button
        type="button"
        onClick={() => setResetDaily(!resetDaily)}
        className={cn(
          'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
          resetDaily ? 'bg-primary' : 'bg-muted'
        )}
      >
        <span className={cn(
          'inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform',
          resetDaily ? 'translate-x-4.5' : 'translate-x-0.5'
        )} />
      </button>
    </div>

    {/* Уведомления */}
    <div className="space-y-2">
      <label className="text-sm font-medium">Уведомления</label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={notifyOnEveryIncrease}
          onChange={(e) => setNotifyOnEveryIncrease(e.target.checked)}
          className="rounded border-border"
        />
        При каждом увеличении
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={notifyOnKeyEvents}
          onChange={(e) => setNotifyOnKeyEvents(e.target.checked)}
          className="rounded border-border"
        />
        Только ключевые события
      </label>
    </div>
  </div>
)}
```

- [ ] **Step 5: Обновить handleSubmit для передачи бюджетных полей**

В функции handleSubmit, при вызове `createRule`, добавить поля:

```typescript
      await createRule({
        userId: user.userId as Id<"users">,
        name,
        type: selectedType,
        value: selectedType === 'uz_budget_manage' ? 0 : value,
        // ... existing fields ...
        // uz_budget_manage fields
        ...(selectedType === 'uz_budget_manage' && {
          initialBudget,
          budgetStep,
          ...(maxDailyBudget && { maxDailyBudget: Number(maxDailyBudget) }),
          resetDaily,
          notifyOnEveryIncrease,
          notifyOnKeyEvents,
        }),
      });
```

- [ ] **Step 6: Скрыть стандартное поле value для uz_budget_manage**

В JSX, обернуть стандартное поле «Значение» в условие:

```tsx
{selectedType !== 'uz_budget_manage' && selectedType !== 'new_lead' && (
  // existing value input
)}
```

- [ ] **Step 7: Скрыть ActionRadio для uz_budget_manage**

Тип `uz_budget_manage` не останавливает объявления — скрыть выбор stop/notify:

```tsx
{selectedType !== 'uz_budget_manage' && (
  <ActionRadio ... />
)}
```

- [ ] **Step 8: Build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 9: Commit**

```bash
git add src/pages/RulesPage.tsx
git commit -m "feat(ui): add uz_budget_manage rule form with budget fields"
```

---

### Task 8: API endpoint для получения групп УЗ

**Files:**
- Modify: `convex/vkApi.ts`

- [ ] **Step 1: Добавить query getUzCampaigns**

В `convex/vkApi.ts` добавить публичный query для использования из фронтенда:

```typescript
export const getUzCampaigns = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    // Получить все аккаунты пользователя
    const accounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .filter((q) => q.eq(q.field("status"), "active"))
      .collect();

    // Для каждого аккаунта — вернуть кешированные кампании
    // (реальный fetch через action, но для UI нужен query)
    // TODO: Кешировать кампании в отдельной таблице или использовать campaigns table
    const campaigns = await ctx.db.query("campaigns").collect();
    return campaigns.filter((c: any) =>
      accounts.some((a) => a._id === c.accountId)
    );
  },
});
```

Примечание: в текущей схеме таблица `campaigns` уже содержит синхронизированные кампании (группы). Нужно проверить наличие поля `packageId` или добавить его при следующей синхронизации.

- [ ] **Step 2: Commit**

```bash
git add convex/vkApi.ts
git commit -m "feat(vkApi): add getUzCampaigns query for rule form UI"
```

---

### Task 9: Финальная интеграция и тест

**Files:**
- All modified files

- [ ] **Step 1: Полный typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: 0 errors

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: Max 50 warnings

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: Success

- [ ] **Step 4: Тест на dev**

1. Открыть https://aipilot.by/rules
2. Нажать "Создать правило"
3. Выбрать тип "Работа с УЗ"
4. Заполнить: начальный бюджет 100₽, шаг 1₽, сброс включён
5. Выбрать группу
6. Сохранить

- [ ] **Step 5: Финальный commit и deploy**

```bash
git push origin main
```

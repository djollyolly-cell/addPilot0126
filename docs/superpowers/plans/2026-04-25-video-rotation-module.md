# Video Rotation Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a campaign rotation module that sequentially runs selected campaigns for configurable time slots, with daily budget transfer, quiet hours, and admin-gated access.

**Architecture:** New rule type `video_rotation` in existing `rules` table + new `rotationState` table for live state. Execution logic in `convex/videoRotation.ts`, triggered by its own cron every 5 minutes. Validations in `convex/rules.ts`. Admin module toggle via new "Modules" tab.

**Tech Stack:** Convex (backend), React + Tailwind (frontend), VK Ads myTarget API v2

**Spec:** `docs/superpowers/specs/2026-04-25-video-rotation-module-design.md`

---

### Task 1: Schema changes

**Files:**
- Modify: `convex/schema.ts`

- [ ] **Step 1: Add `video_rotation` to rules type union**

In `convex/schema.ts`, find the `rules` table `type` field (line 171-184) and add `video_rotation`:

```typescript
// In rules table, type field — add after custom_l3:
v.literal("custom_l3"),              // L3 per-agency handler (dispatch via customRuleTypeCode)
v.literal("video_rotation")          // Campaign rotation module
```

- [ ] **Step 2: Add rotation conditions to the conditions union**

The `conditions` field currently accepts a single object or array. Add a third variant for rotation:

```typescript
conditions: v.union(
  // Existing: single condition (L1 standard types + L3 custom_*)
  v.object({
    metric: v.string(),
    operator: v.string(),
    value: v.number(),
    minSamples: v.optional(v.number()),
    timeWindow: v.optional(
      v.union(
        v.literal("daily"),
        v.literal("since_launch"),
        v.literal("24h"),
        v.literal("1h"),
        v.literal("6h")
      )
    ),
    // uz_budget_manage fields
    initialBudget: v.optional(v.number()),
    budgetStep: v.optional(v.number()),
    maxDailyBudget: v.optional(v.number()),
    resetDaily: v.optional(v.boolean()),
    // cpc_limit fields
    minSpent: v.optional(v.number()),
    // video_rotation fields
    slotDurationHours: v.optional(v.number()),
    dailyBudget: v.optional(v.number()),
    quietHoursEnabled: v.optional(v.boolean()),
    quietHoursStart: v.optional(v.string()),
    quietHoursEnd: v.optional(v.string()),
    campaignOrder: v.optional(v.array(v.string())),
  }),
  // New: array of conditions for L2 constructor (AND)
  v.array(v.object({
    metric: v.string(),
    operator: v.string(),
    value: v.number(),
    minSamples: v.optional(v.number()),
    timeWindow: v.optional(
      v.union(
        v.literal("daily"),
        v.literal("since_launch"),
        v.literal("24h"),
        v.literal("1h"),
        v.literal("6h")
      )
    ),
  }))
),
```

Note: We add the rotation fields as optional to the existing single-condition object variant. This avoids a third union branch and keeps schema compatible. Only `video_rotation` rules will populate these fields.

- [ ] **Step 3: Add `rotation_*` action types to actionLogs**

In `convex/schema.ts`, find the `actionLogs` table `actionType` field (line 260-267) and add rotation types:

```typescript
actionType: v.union(
  v.literal("stopped"),
  v.literal("notified"),
  v.literal("stopped_and_notified"),
  v.literal("budget_increased"),
  v.literal("budget_reset"),
  v.literal("zero_spend_alert"),
  v.literal("rotation_switch"),
  v.literal("rotation_paused"),
  v.literal("rotation_resumed"),
  v.literal("rotation_cycle_complete"),
  v.literal("rotation_started"),
  v.literal("rotation_stopped")
),
```

- [ ] **Step 4: Make actionLogs.metricsSnapshot flexible for rotation**

The current `metricsSnapshot` is a strict object. Rotation logs need different fields. Change it to `v.any()`:

```typescript
// In actionLogs table, change metricsSnapshot from strict object to any:
metricsSnapshot: v.any(),
```

This allows rotation logs to store `{ from, to, slotHours, budgetRemaining }` etc. Existing code is unaffected since it still passes objects.

- [ ] **Step 5: Add `rotationState` table**

Add after the `actionLogs` table definition:

```typescript
rotationState: defineTable({
  ruleId: v.id("rules"),
  accountId: v.id("adAccounts"),
  currentIndex: v.number(),
  currentCampaignId: v.string(),
  slotStartedAt: v.number(),
  dailyBudgetRemaining: v.number(),
  budgetDayStart: v.string(),
  cycleNumber: v.number(),
  status: v.union(
    v.literal("running"),
    v.literal("paused_quiet_hours"),
    v.literal("paused_intervention"),
    v.literal("stopped")
  ),
  pausedAt: v.optional(v.number()),
  pausedElapsed: v.optional(v.number()),
  consecutiveErrors: v.optional(v.number()),
  lastError: v.optional(v.string()),
})
  .index("by_ruleId", ["ruleId"])
  .index("by_accountId", ["accountId"]),
```

- [ ] **Step 6: Add `videoRotationEnabled` to users table**

In the `users` table definition (line 5-65), add after `isAdmin`:

```typescript
isAdmin: v.optional(v.boolean()),
videoRotationEnabled: v.optional(v.boolean()),
```

- [ ] **Step 7: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: Clean output (no errors). Schema changes are additive — existing code should compile.

- [ ] **Step 8: Commit**

```bash
git add convex/schema.ts
git commit -m "feat(schema): add video_rotation rule type, rotationState table, rotation actionLog types"
```

---

### Task 2: Core rotation logic — `convex/videoRotation.ts`

**Files:**
- Create: `convex/videoRotation.ts`

- [ ] **Step 1: Create the module with helper functions and types**

Create `convex/videoRotation.ts`:

```typescript
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

// ---- Helper: today's date string in UTC ----
function todayStr(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// ---- Helper: check if current time is in quiet hours ----
function isInQuietHours(nowMs: number, startHHMM: string, endHHMM: string): boolean {
  const d = new Date(nowMs);
  const nowMinutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  const [sh, sm] = startHHMM.split(":").map(Number);
  const [eh, em] = endHHMM.split(":").map(Number);
  const startMinutes = sh * 60 + sm;
  const endMinutes = eh * 60 + em;

  if (startMinutes === endMinutes) return false; // disabled
  if (startMinutes < endMinutes) {
    // Same day: e.g. 02:00-06:00
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  // Overnight: e.g. 23:00-07:00
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

// ---- Exported for testing ----
export { todayStr as _todayStr, isInQuietHours as _isInQuietHours };
```

- [ ] **Step 2: Add DB query/mutation helpers**

Append to the same file:

```typescript
// ---- Internal queries ----

/** Get all active rotation states */
export const listActiveRotations = internalQuery({
  args: {},
  handler: async (ctx) => {
    // Get all rotationState rows where status != "stopped"
    const allStates = await ctx.db.query("rotationState").collect();
    return allStates.filter((s) => s.status !== "stopped");
  },
});

/** Get rotationState by ruleId */
export const getByRuleId = internalQuery({
  args: { ruleId: v.id("rules") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("rotationState")
      .withIndex("by_ruleId", (q) => q.eq("ruleId", args.ruleId))
      .first();
  },
});

/** Get all rotating campaign IDs for an account (for ruleEngine skip) */
export const getRotatingCampaignIds = internalQuery({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const states = await ctx.db
      .query("rotationState")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();
    const activeStates = states.filter((s) => s.status !== "stopped");
    const campaignIds: string[] = [];
    for (const state of activeStates) {
      const rule = await ctx.db.get(state.ruleId);
      if (rule && rule.targetCampaignIds) {
        campaignIds.push(...rule.targetCampaignIds);
      }
    }
    return campaignIds;
  },
});

/** Get today's spent for a campaign (sum of metricsDaily.spent for all ads in campaign) */
export const getCampaignSpentToday = internalQuery({
  args: { accountId: v.id("adAccounts"), campaignId: v.string(), date: v.string() },
  handler: async (ctx, args) => {
    const metrics = await ctx.db
      .query("metricsDaily")
      .withIndex("by_accountId_date", (q) =>
        q.eq("accountId", args.accountId).eq("date", args.date)
      )
      .collect();
    let spent = 0;
    for (const m of metrics) {
      if (m.campaignId === args.campaignId) {
        spent += m.spent;
      }
    }
    return Math.round(spent * 100) / 100;
  },
});

// ---- Internal mutations ----

/** Create a new rotationState */
export const createState = internalMutation({
  args: {
    ruleId: v.id("rules"),
    accountId: v.id("adAccounts"),
    currentIndex: v.number(),
    currentCampaignId: v.string(),
    slotStartedAt: v.number(),
    dailyBudgetRemaining: v.number(),
    budgetDayStart: v.string(),
    cycleNumber: v.number(),
    status: v.union(
      v.literal("running"),
      v.literal("paused_quiet_hours"),
      v.literal("paused_intervention"),
      v.literal("stopped")
    ),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("rotationState", {
      ...args,
      consecutiveErrors: 0,
    });
  },
});

/** Update rotationState fields */
export const updateState = internalMutation({
  args: {
    stateId: v.id("rotationState"),
    patch: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.stateId, args.patch);
  },
});

/** Delete rotationState */
export const deleteState = internalMutation({
  args: { stateId: v.id("rotationState") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.stateId);
  },
});

/** Log a rotation action to actionLogs */
export const logRotationAction = internalMutation({
  args: {
    userId: v.id("users"),
    ruleId: v.id("rules"),
    accountId: v.id("adAccounts"),
    adName: v.string(),
    actionType: v.string(),
    reason: v.string(),
    metricsSnapshot: v.any(),
    status: v.union(v.literal("success"), v.literal("failed")),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("actionLogs", {
      userId: args.userId,
      ruleId: args.ruleId,
      accountId: args.accountId,
      adId: "",
      adName: args.adName,
      actionType: args.actionType as "rotation_switch" | "rotation_paused" | "rotation_resumed" | "rotation_cycle_complete" | "rotation_started" | "rotation_stopped",
      reason: args.reason,
      metricsSnapshot: args.metricsSnapshot,
      savedAmount: 0,
      status: args.status,
      errorMessage: args.errorMessage,
      createdAt: Date.now(),
    });
  },
});
```

- [ ] **Step 3: Add the `activate` action**

Append to `convex/videoRotation.ts`:

```typescript
/** Activate rotation: stop all campaigns, start first one */
export const activate = internalAction({
  args: {
    ruleId: v.id("rules"),
  },
  handler: async (ctx, args) => {
    const rule = await ctx.runQuery(internal.rules.getRule, { ruleId: args.ruleId });
    if (!rule || rule.type !== "video_rotation") {
      throw new Error("Правило не найдено или имеет неверный тип");
    }
    const conditions = rule.conditions as {
      slotDurationHours: number;
      dailyBudget: number;
      campaignOrder: string[];
      quietHoursEnabled?: boolean;
      quietHoursStart?: string;
      quietHoursEnd?: string;
    };
    const { campaignOrder, dailyBudget, slotDurationHours } = conditions;
    if (!campaignOrder || campaignOrder.length < 2) {
      throw new Error("Минимум 2 кампании для ротации");
    }

    const accountId = rule.targetAccountIds[0];
    const accessToken = await ctx.runAction(
      internal.auth.getValidTokenForAccount,
      { accountId }
    );

    // Stop all target campaigns
    const campaigns = await ctx.runAction(
      internal.vkApi.getCampaignsForAccount,
      { accessToken }
    ) as Array<{ id: number; name: string; status: string }>;

    const targetSet = new Set(rule.targetCampaignIds ?? []);
    for (const c of campaigns) {
      if (targetSet.has(String(c.id)) && c.status === "active") {
        await ctx.runAction(internal.vkApi.updateMtCampaign, {
          accessToken,
          campaignId: c.id,
          data: { status: "blocked" },
        });
      }
    }

    // Start the first campaign
    const firstCampaignId = Number(campaignOrder[0]);
    await ctx.runAction(internal.vkApi.updateMtCampaign, {
      accessToken,
      campaignId: firstCampaignId,
      data: { status: "active" },
    });
    await ctx.runAction(internal.vkApi.setCampaignBudget, {
      accessToken,
      campaignId: firstCampaignId,
      newLimitRubles: dailyBudget,
    });

    // Create rotationState
    await ctx.runMutation(internal.videoRotation.createState, {
      ruleId: args.ruleId,
      accountId,
      currentIndex: 0,
      currentCampaignId: campaignOrder[0],
      slotStartedAt: Date.now(),
      dailyBudgetRemaining: dailyBudget,
      budgetDayStart: todayStr(),
      cycleNumber: 1,
      status: "running",
    });

    // Find campaign name for notification
    const firstCampaign = campaigns.find((c) => String(c.id) === campaignOrder[0]);
    const firstName = firstCampaign?.name ?? campaignOrder[0];

    // Log
    await ctx.runMutation(internal.videoRotation.logRotationAction, {
      userId: rule.userId,
      ruleId: args.ruleId,
      accountId,
      adName: firstName,
      actionType: "rotation_started",
      reason: `Ротация запущена: ${campaignOrder.length} кампаний, слот ${slotDurationHours}ч, бюджет ${dailyBudget} руб./сутки`,
      metricsSnapshot: { totalCampaigns: campaignOrder.length, slotHours: slotDurationHours, dailyBudget },
      status: "success",
    });

    // Telegram
    const user = await ctx.runQuery(internal.users.getById, { userId: rule.userId });
    if (user?.telegramChatId) {
      await ctx.runAction(internal.telegram.sendMessage, {
        chatId: user.telegramChatId,
        text: `<b>Ротация запущена</b>\n\n${rule.name}\n${campaignOrder.length} кампаний, слот ${slotDurationHours}ч\nБюджет: ${dailyBudget} руб./сутки\nПервая: ${firstName}`,
      });
    }
  },
});
```

- [ ] **Step 4: Add the `deactivate` action**

Append to `convex/videoRotation.ts`:

```typescript
/** Deactivate rotation: stop current campaign, set state to stopped */
export const deactivate = internalAction({
  args: {
    ruleId: v.id("rules"),
  },
  handler: async (ctx, args) => {
    const state = await ctx.runQuery(internal.videoRotation.getByRuleId, { ruleId: args.ruleId });
    if (!state) return;

    const rule = await ctx.runQuery(internal.rules.getRule, { ruleId: args.ruleId });
    if (!rule) return;

    const accountId = state.accountId;

    // Stop current campaign if running or paused
    if (state.status === "running" || state.status === "paused_quiet_hours") {
      try {
        const accessToken = await ctx.runAction(
          internal.auth.getValidTokenForAccount,
          { accountId }
        );
        await ctx.runAction(internal.vkApi.updateMtCampaign, {
          accessToken,
          campaignId: Number(state.currentCampaignId),
          data: { status: "blocked" },
        });
      } catch (err) {
        console.error(`[videoRotation.deactivate] Failed to stop campaign ${state.currentCampaignId}:`, err);
      }
    }

    // Delete state
    await ctx.runMutation(internal.videoRotation.deleteState, { stateId: state._id });

    // Log
    await ctx.runMutation(internal.videoRotation.logRotationAction, {
      userId: rule.userId,
      ruleId: args.ruleId,
      accountId,
      adName: state.currentCampaignId,
      actionType: "rotation_stopped",
      reason: "Ротация остановлена, все кампании выключены",
      metricsSnapshot: { cycleNumber: state.cycleNumber, lastCampaignId: state.currentCampaignId },
      status: "success",
    });

    // Telegram
    const user = await ctx.runQuery(internal.users.getById, { userId: rule.userId });
    if (user?.telegramChatId) {
      await ctx.runAction(internal.telegram.sendMessage, {
        chatId: user.telegramChatId,
        text: `<b>Ротация остановлена</b>\n\n${rule.name}\nВсе кампании выключены.`,
      });
    }
  },
});
```

- [ ] **Step 5: Add the `tick` action (main loop)**

Append to `convex/videoRotation.ts`:

```typescript
/** Main tick — called every 5 minutes by cron. Processes all active rotations. */
export const tick = internalAction({
  args: {},
  handler: async (ctx) => {
    const activeStates = await ctx.runQuery(internal.videoRotation.listActiveRotations);

    for (const state of activeStates) {
      try {
        await processRotation(ctx, state);
      } catch (err) {
        console.error(`[videoRotation.tick] Error processing rotation ${state.ruleId}:`, err);
      }
    }
  },
});

async function processRotation(
  ctx: { runQuery: Function; runMutation: Function; runAction: Function },
  state: {
    _id: Id<"rotationState">;
    ruleId: Id<"rules">;
    accountId: Id<"adAccounts">;
    currentIndex: number;
    currentCampaignId: string;
    slotStartedAt: number;
    dailyBudgetRemaining: number;
    budgetDayStart: string;
    cycleNumber: number;
    status: string;
    pausedAt?: number;
    pausedElapsed?: number;
    consecutiveErrors?: number;
    lastError?: string;
  }
) {
  const rule = await ctx.runQuery(internal.rules.getRule, { ruleId: state.ruleId });
  if (!rule || !rule.isActive || rule.type !== "video_rotation") {
    // Rule deleted or deactivated — clean up state
    await ctx.runMutation(internal.videoRotation.deleteState, { stateId: state._id });
    return;
  }

  const conditions = rule.conditions as {
    slotDurationHours: number;
    dailyBudget: number;
    campaignOrder: string[];
    quietHoursEnabled?: boolean;
    quietHoursStart?: string;
    quietHoursEnd?: string;
  };

  let accessToken: string;
  try {
    accessToken = await ctx.runAction(
      internal.auth.getValidTokenForAccount,
      { accountId: state.accountId }
    );
  } catch (err) {
    await handleApiError(ctx, state, rule, "Не удалось получить токен");
    return;
  }

  const now = Date.now();

  // ---- Handle paused_intervention: do nothing, wait for admin ----
  if (state.status === "paused_intervention") {
    return;
  }

  // ---- Handle paused_quiet_hours: check if quiet hours ended ----
  if (state.status === "paused_quiet_hours") {
    const qhEnabled = conditions.quietHoursEnabled ?? false;
    const inQH = qhEnabled && isInQuietHours(now, conditions.quietHoursStart ?? "23:00", conditions.quietHoursEnd ?? "07:00");
    if (!inQH) {
      // Resume
      try {
        await ctx.runAction(internal.vkApi.updateMtCampaign, {
          accessToken,
          campaignId: Number(state.currentCampaignId),
          data: { status: "active" },
        });
      } catch (err) {
        await handleApiError(ctx, state, rule, `Не удалось возобновить кампанию ${state.currentCampaignId}`);
        return;
      }

      const elapsed = state.pausedElapsed ?? 0;
      await ctx.runMutation(internal.videoRotation.updateState, {
        stateId: state._id,
        patch: {
          status: "running",
          slotStartedAt: now - elapsed,
          pausedAt: undefined,
          pausedElapsed: undefined,
          consecutiveErrors: 0,
        },
      });

      await ctx.runMutation(internal.videoRotation.logRotationAction, {
        userId: rule.userId,
        ruleId: rule._id,
        accountId: state.accountId,
        adName: state.currentCampaignId,
        actionType: "rotation_resumed",
        reason: "Тихие часы закончились, ротация возобновлена",
        metricsSnapshot: { campaignId: state.currentCampaignId, remainingSlotMinutes: Math.round((conditions.slotDurationHours * 3600000 - elapsed) / 60000) },
        status: "success",
      });
      return;
    }
    // Still in quiet hours — do nothing
    return;
  }

  // ---- Status: running ----

  // 1. Check external intervention
  const campaigns = await ctx.runAction(
    internal.vkApi.getCampaignsForAccount,
    { accessToken }
  ) as Array<{ id: number; name: string; status: string }>;

  const currentCampaign = campaigns.find((c) => String(c.id) === state.currentCampaignId);
  if (currentCampaign && currentCampaign.status !== "active") {
    // External intervention detected
    await ctx.runMutation(internal.videoRotation.updateState, {
      stateId: state._id,
      patch: {
        status: "paused_intervention",
        pausedAt: now,
        lastError: `Кампания ${currentCampaign.name} была остановлена извне`,
      },
    });

    await ctx.runMutation(internal.videoRotation.logRotationAction, {
      userId: rule.userId,
      ruleId: rule._id,
      accountId: state.accountId,
      adName: currentCampaign.name ?? state.currentCampaignId,
      actionType: "rotation_paused",
      reason: "Кампания была остановлена извне",
      metricsSnapshot: { reason: "intervention", campaignId: state.currentCampaignId },
      status: "success",
    });

    // Telegram critical
    const user = await ctx.runQuery(internal.users.getById, { userId: rule.userId });
    if (user?.telegramChatId) {
      await ctx.runAction(internal.telegram.sendMessage, {
        chatId: user.telegramChatId,
        text: `<b>Ротация приостановлена</b>\n\n${rule.name}\nКампания "${currentCampaign.name}" была остановлена извне.\nДля возобновления — включите правило заново.`,
      });
    }
    return;
  }

  // 2. Check quiet hours
  const qhEnabled = conditions.quietHoursEnabled ?? false;
  if (qhEnabled && isInQuietHours(now, conditions.quietHoursStart ?? "23:00", conditions.quietHoursEnd ?? "07:00")) {
    // Enter quiet hours
    try {
      await ctx.runAction(internal.vkApi.updateMtCampaign, {
        accessToken,
        campaignId: Number(state.currentCampaignId),
        data: { status: "blocked" },
      });
    } catch (err) {
      await handleApiError(ctx, state, rule, `Не удалось остановить кампанию для тихих часов`);
      return;
    }

    const elapsed = now - state.slotStartedAt;
    await ctx.runMutation(internal.videoRotation.updateState, {
      stateId: state._id,
      patch: {
        status: "paused_quiet_hours",
        pausedAt: now,
        pausedElapsed: elapsed,
      },
    });

    await ctx.runMutation(internal.videoRotation.logRotationAction, {
      userId: rule.userId,
      ruleId: rule._id,
      accountId: state.accountId,
      adName: state.currentCampaignId,
      actionType: "rotation_paused",
      reason: "Тихие часы",
      metricsSnapshot: { reason: "quiet_hours", campaignId: state.currentCampaignId },
      status: "success",
    });
    return;
  }

  // 3. Check slot time
  const elapsed = now - state.slotStartedAt;
  const slotDurationMs = conditions.slotDurationHours * 3600 * 1000;

  if (elapsed >= slotDurationMs) {
    await switchToNext(ctx, state, rule, conditions, campaigns, accessToken);
  }
  // Else: slot still active, nothing to do
}

async function switchToNext(
  ctx: { runQuery: Function; runMutation: Function; runAction: Function },
  state: {
    _id: Id<"rotationState">;
    ruleId: Id<"rules">;
    accountId: Id<"adAccounts">;
    currentIndex: number;
    currentCampaignId: string;
    dailyBudgetRemaining: number;
    budgetDayStart: string;
    cycleNumber: number;
  },
  rule: { _id: Id<"rules">; userId: Id<"users">; name: string },
  conditions: {
    slotDurationHours: number;
    dailyBudget: number;
    campaignOrder: string[];
  },
  campaigns: Array<{ id: number; name: string; status: string }>,
  accessToken: string
) {
  const now = Date.now();
  const today = todayStr();
  const { campaignOrder, dailyBudget } = conditions;

  // 1. Stop current campaign
  try {
    await ctx.runAction(internal.vkApi.updateMtCampaign, {
      accessToken,
      campaignId: Number(state.currentCampaignId),
      data: { status: "blocked" },
    });
  } catch (err) {
    await handleApiError(ctx, state, rule, `Не удалось остановить кампанию ${state.currentCampaignId}`);
    return;
  }

  // 2. Calculate remaining budget
  let remaining = state.dailyBudgetRemaining;
  const spent = await ctx.runQuery(internal.videoRotation.getCampaignSpentToday, {
    accountId: state.accountId,
    campaignId: state.currentCampaignId,
    date: today,
  });
  remaining = Math.round((remaining - spent) * 100) / 100;
  if (remaining < 0) remaining = 0;

  // 3. Check day change
  if (state.budgetDayStart !== today) {
    remaining = dailyBudget;
  }

  // 4. Advance index
  const nextIndex = (state.currentIndex + 1) % campaignOrder.length;
  const nextCampaignId = campaignOrder[nextIndex];
  let newCycleNumber = state.cycleNumber;

  // 5. Cycle complete?
  if (nextIndex === 0) {
    newCycleNumber++;
    await ctx.runMutation(internal.videoRotation.logRotationAction, {
      userId: rule.userId,
      ruleId: rule._id,
      accountId: state.accountId,
      adName: "",
      actionType: "rotation_cycle_complete",
      reason: `Цикл ротации #${state.cycleNumber} завершён (${campaignOrder.length} кампаний)`,
      metricsSnapshot: { cycleNumber: state.cycleNumber, totalCampaigns: campaignOrder.length },
      status: "success",
    });

    const user = await ctx.runQuery(internal.users.getById, { userId: rule.userId });
    if (user?.telegramChatId) {
      await ctx.runAction(internal.telegram.sendMessage, {
        chatId: user.telegramChatId,
        text: `<b>Цикл ротации завершён</b>\n\n${rule.name}\nЦикл #${state.cycleNumber} (${campaignOrder.length} кампаний)\nЗапускаю заново.`,
      });
    }
  }

  // 6. Start next campaign
  try {
    await ctx.runAction(internal.vkApi.updateMtCampaign, {
      accessToken,
      campaignId: Number(nextCampaignId),
      data: { status: "active" },
    });
    await ctx.runAction(internal.vkApi.setCampaignBudget, {
      accessToken,
      campaignId: Number(nextCampaignId),
      newLimitRubles: remaining > 0 ? remaining : dailyBudget,
    });
  } catch (err) {
    // Campaign might be deleted — skip to next
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[videoRotation.switchToNext] Failed to start campaign ${nextCampaignId}:`, errMsg);

    const user = await ctx.runQuery(internal.users.getById, { userId: rule.userId });
    if (user?.telegramChatId) {
      await ctx.runAction(internal.telegram.sendMessage, {
        chatId: user.telegramChatId,
        text: `<b>Ротация: ошибка</b>\n\n${rule.name}\nНе удалось запустить кампанию ${nextCampaignId}.\nПропускаю, перехожу к следующей.`,
      });
    }
    // Don't return — update state to next so it tries the one after on next tick
  }

  // 7. Update state
  const nextCampaign = campaigns.find((c) => String(c.id) === nextCampaignId);
  const nextName = nextCampaign?.name ?? nextCampaignId;
  const prevCampaign = campaigns.find((c) => String(c.id) === state.currentCampaignId);
  const prevName = prevCampaign?.name ?? state.currentCampaignId;

  await ctx.runMutation(internal.videoRotation.updateState, {
    stateId: state._id,
    patch: {
      currentIndex: nextIndex,
      currentCampaignId: nextCampaignId,
      slotStartedAt: now,
      dailyBudgetRemaining: remaining > 0 ? remaining : dailyBudget,
      budgetDayStart: today,
      cycleNumber: newCycleNumber,
      consecutiveErrors: 0,
    },
  });

  // 8. Log switch
  await ctx.runMutation(internal.videoRotation.logRotationAction, {
    userId: rule.userId,
    ruleId: rule._id,
    accountId: state.accountId,
    adName: nextName,
    actionType: "rotation_switch",
    reason: `Переключение: ${prevName} -> ${nextName}`,
    metricsSnapshot: { from: prevName, to: nextName, slotHours: conditions.slotDurationHours, budgetRemaining: remaining },
    status: "success",
  });

  // 9. Telegram
  const user = await ctx.runQuery(internal.users.getById, { userId: rule.userId });
  if (user?.telegramChatId) {
    await ctx.runAction(internal.telegram.sendMessage, {
      chatId: user.telegramChatId,
      text: `<b>Ротация: переключение</b>\n\n${rule.name}\n${prevName} -> ${nextName}\nСлот: ${conditions.slotDurationHours}ч\nБюджет: ${remaining > 0 ? remaining : dailyBudget} руб.`,
    });
  }
}

async function handleApiError(
  ctx: { runQuery: Function; runMutation: Function; runAction: Function },
  state: { _id: Id<"rotationState">; ruleId: Id<"rules">; accountId: Id<"adAccounts">; currentCampaignId: string; consecutiveErrors?: number },
  rule: { _id: Id<"rules">; userId: Id<"users">; name: string },
  errorMsg: string
) {
  const errors = (state.consecutiveErrors ?? 0) + 1;

  if (errors >= 3) {
    // Pause after 3 consecutive errors
    await ctx.runMutation(internal.videoRotation.updateState, {
      stateId: state._id,
      patch: {
        status: "paused_intervention",
        consecutiveErrors: errors,
        lastError: errorMsg,
        pausedAt: Date.now(),
      },
    });

    await ctx.runMutation(internal.videoRotation.logRotationAction, {
      userId: rule.userId,
      ruleId: rule._id,
      accountId: state.accountId,
      adName: state.currentCampaignId,
      actionType: "rotation_paused",
      reason: errorMsg,
      metricsSnapshot: { reason: "api_error", consecutiveErrors: errors },
      status: "failed",
      errorMessage: errorMsg,
    });

    const user = await ctx.runQuery(internal.users.getById, { userId: rule.userId });
    if (user?.telegramChatId) {
      await ctx.runAction(internal.telegram.sendMessage, {
        chatId: user.telegramChatId,
        text: `<b>Ротация приостановлена</b>\n\n${rule.name}\n${errorMsg}\n3 ошибки подряд. Проверьте кабинет.`,
      });
    }
  } else {
    // Just increment error counter, retry on next tick
    await ctx.runMutation(internal.videoRotation.updateState, {
      stateId: state._id,
      patch: {
        consecutiveErrors: errors,
        lastError: errorMsg,
      },
    });
  }
}
```

- [ ] **Step 6: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: Clean output. Fix any type errors.

- [ ] **Step 7: Commit**

```bash
git add convex/videoRotation.ts
git commit -m "feat(videoRotation): add core rotation logic — activate, deactivate, tick, switchToNext"
```

---

### Task 3: Add cron job for rotation tick

**Files:**
- Modify: `convex/crons.ts`

- [ ] **Step 1: Add rotation tick cron**

In `convex/crons.ts`, add after the uz-budget-reset cron (line 96):

```typescript
// Video rotation tick — every 5 minutes, processes all active rotations
crons.interval(
  "video-rotation-tick",
  { minutes: 5 },
  internal.videoRotation.tick
);
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: Clean output.

- [ ] **Step 3: Commit**

```bash
git add convex/crons.ts
git commit -m "feat(crons): add video-rotation-tick every 5 minutes"
```

---

### Task 4: Validation in rules.ts

**Files:**
- Modify: `convex/rules.ts`

- [ ] **Step 1: Add rotation validation helper**

At the top of `convex/rules.ts`, after the `RULE_TYPE_DEFAULTS` definition (line 39), add:

```typescript
/** Check if any campaigns overlap with an active video_rotation rule */
async function validateRotationConflicts(
  ctx: { db: any; runQuery?: any },
  userId: Id<"users">,
  targetCampaignIds: string[] | undefined,
  targetAccountIds: Id<"adAccounts">[],
  excludeRuleId?: Id<"rules">
): Promise<string | null> {
  const allRules = await ctx.db
    .query("rules")
    .withIndex("by_userId", (q: any) => q.eq("userId", userId))
    .collect();

  const activeRules = allRules.filter(
    (r: any) => r.isActive && (!excludeRuleId || r._id !== excludeRuleId)
  );

  // Check 1: rotation campaigns must not be in any other rule's targetCampaignIds/targetAdIds
  // Check 2: no account-level rules (without targetCampaignIds) on same account
  // Check 3: no overlap with other video_rotation rules

  for (const r of activeRules) {
    if (r.type === "video_rotation") {
      // Check overlap with other rotations
      if (targetCampaignIds) {
        const otherCampaigns = new Set(r.targetCampaignIds ?? []);
        for (const cId of targetCampaignIds) {
          if (otherCampaigns.has(cId)) {
            return `Кампания ${cId} уже участвует в ротации "${r.name}"`;
          }
        }
      }
    }
  }

  return null;
}

/** Check that rotation campaigns are not covered by any other rule on same accounts */
async function validateNoConflictingRules(
  ctx: { db: any },
  userId: Id<"users">,
  targetAccountIds: Id<"adAccounts">[],
  targetCampaignIds: string[],
  excludeRuleId?: Id<"rules">
): Promise<string | null> {
  const allRules = await ctx.db
    .query("rules")
    .withIndex("by_userId", (q: any) => q.eq("userId", userId))
    .collect();

  const activeRules = allRules.filter(
    (r: any) => r.isActive && r.type !== "video_rotation" && (!excludeRuleId || r._id !== excludeRuleId)
  );

  const accountSet = new Set(targetAccountIds.map(String));
  const campaignSet = new Set(targetCampaignIds);

  for (const r of activeRules) {
    // Check: account-level rule without campaign filter on same account
    const rAccountIds = (r.targetAccountIds ?? []).map(String);
    const hasOverlappingAccount = rAccountIds.some((aId: string) => accountSet.has(aId));

    if (hasOverlappingAccount && (!r.targetCampaignIds || r.targetCampaignIds.length === 0)) {
      return `На аккаунте есть правило "${r.name}" без фильтра кампаний — ротация невозможна`;
    }

    // Check: campaign-level overlap
    if (r.targetCampaignIds) {
      for (const cId of r.targetCampaignIds) {
        if (campaignSet.has(cId)) {
          return `Кампания ${cId} используется в правиле "${r.name}" — ротация невозможна`;
        }
      }
    }
    if (r.targetAdIds) {
      // We can't easily check ad-to-campaign mapping here, but at minimum flag it
      // This is a simplified check
    }
  }

  return null;
}

/** Reverse check: when creating a non-rotation rule, check if campaigns are in rotation */
async function validateNotInRotation(
  ctx: { db: any },
  userId: Id<"users">,
  targetAccountIds: Id<"adAccounts">[],
  targetCampaignIds: string[] | undefined,
  excludeRuleId?: Id<"rules">
): Promise<string | null> {
  const allRules = await ctx.db
    .query("rules")
    .withIndex("by_userId", (q: any) => q.eq("userId", userId))
    .collect();

  const activeRotations = allRules.filter(
    (r: any) => r.isActive && r.type === "video_rotation" && (!excludeRuleId || r._id !== excludeRuleId)
  );

  if (activeRotations.length === 0) return null;

  const accountSet = new Set(targetAccountIds.map(String));

  for (const rot of activeRotations) {
    const rotAccountIds = (rot.targetAccountIds ?? []).map(String);
    const hasOverlappingAccount = rotAccountIds.some((aId: string) => accountSet.has(aId));

    if (!hasOverlappingAccount) continue;

    // Account-level rule (no campaign filter) conflicts with rotation
    if (!targetCampaignIds || targetCampaignIds.length === 0) {
      return `На аккаунте есть активная ротация "${rot.name}" — правило без фильтра кампаний невозможно`;
    }

    // Campaign-level overlap
    const rotCampaigns = new Set(rot.targetCampaignIds ?? []);
    for (const cId of targetCampaignIds) {
      if (rotCampaigns.has(cId)) {
        return `Кампания ${cId} участвует в ротации "${rot.name}" — назначение правил запрещено`;
      }
    }
  }

  return null;
}
```

- [ ] **Step 2: Add video_rotation to L1_TYPES and validation in `create` mutation**

In `convex/rules.ts`, in the `create` mutation handler (line 126+):

After line 146 (`const L1_TYPES = [...]`), add `"video_rotation"` to the array but handle it separately. Instead, change the approach — keep L1_TYPES as-is and add a new check:

Find the line (around 151):
```typescript
if (!isL1 && !isL2 && !isL3) {
  throw new Error(`Неизвестный тип правила: ${args.type}`);
}
```

Replace with:
```typescript
const isRotation = args.type === "video_rotation";
if (!isL1 && !isL2 && !isL3 && !isRotation) {
  throw new Error(`Неизвестный тип правила: ${args.type}`);
}
```

Then, after the `uz_budget_manage` validation block (around line 216), add:

```typescript
// Validate video_rotation specific fields
if (isRotation) {
  // Check module access
  if (!user.isAdmin && !user.videoRotationEnabled) {
    throw new Error("Модуль ротации не активирован");
  }

  const campaignOrder = args.conditionsArray
    ? undefined
    : (args as any).campaignOrder;
  const slotDurationHours = (args as any).slotDurationHours;
  const rotationDailyBudget = (args as any).rotationDailyBudget;

  if (!slotDurationHours || slotDurationHours < 1 || slotDurationHours > 24 || !Number.isInteger(slotDurationHours)) {
    throw new Error("Время слота: от 1 до 24 часов (целое число)");
  }
  if (!rotationDailyBudget || rotationDailyBudget <= 0) {
    throw new Error("Бюджет на сутки должен быть больше 0");
  }
  if (!args.targetCampaignIds || args.targetCampaignIds.length < 2) {
    throw new Error("Минимум 2 кампании для ротации");
  }
  if (args.targetCampaignIds.length > 50) {
    throw new Error("Максимум 50 кампаний в ротации");
  }

  // Conflict checks
  const rotConflict = await validateRotationConflicts(ctx, args.userId, args.targetCampaignIds, args.targetAccountIds);
  if (rotConflict) throw new Error(rotConflict);

  const ruleConflict = await validateNoConflictingRules(ctx, args.userId, args.targetAccountIds, args.targetCampaignIds);
  if (ruleConflict) throw new Error(ruleConflict);
}
```

**Important:** The `create` mutation args need to be extended. Add these new optional args after `minSpent` (line 124):

```typescript
// video_rotation specific fields
slotDurationHours: v.optional(v.number()),
rotationDailyBudget: v.optional(v.number()),
campaignOrder: v.optional(v.array(v.string())),
rotationQuietHoursEnabled: v.optional(v.boolean()),
rotationQuietHoursStart: v.optional(v.string()),
rotationQuietHoursEnd: v.optional(v.string()),
```

And in the conditions builder (around line 280), add the rotation branch:

```typescript
if (isRotation) {
  conditions = {
    metric: "rotation",
    operator: ">",
    value: 0,
    slotDurationHours: args.slotDurationHours,
    dailyBudget: args.rotationDailyBudget,
    quietHoursEnabled: args.rotationQuietHoursEnabled ?? false,
    quietHoursStart: args.rotationQuietHoursStart,
    quietHoursEnd: args.rotationQuietHoursEnd,
    campaignOrder: args.campaignOrder ?? args.targetCampaignIds,
  };
}
```

And in the `type` cast for insert (line 307), add `"video_rotation"`:

```typescript
type: args.type as "cpl_limit" | "min_ctr" | "fast_spend" | "spend_no_leads" | "budget_limit" | "low_impressions" | "clicks_no_leads" | "new_lead" | "uz_budget_manage" | "custom" | "custom_l3" | "video_rotation",
```

- [ ] **Step 3: Add reverse validation to non-rotation rule creation**

In the `create` mutation, after the duplicate name check (around line 246), add:

```typescript
// Check if campaigns are in an active rotation (reverse validation)
if (!isRotation) {
  const rotCheck = await validateNotInRotation(ctx, args.userId, args.targetAccountIds, args.targetCampaignIds);
  if (rotCheck) throw new Error(rotCheck);
}
```

- [ ] **Step 4: Integrate activate/deactivate in `toggleActive` mutation**

In the `toggleActive` mutation (line 535-587), after the `await ctx.db.patch(...)` line (571), add:

```typescript
// Handle video_rotation activation/deactivation
if (rule.type === "video_rotation") {
  if (newActive) {
    // Validate conflicts before activating
    const rotConflict = await validateRotationConflicts(ctx, args.userId, rule.targetCampaignIds, rule.targetAccountIds, args.ruleId);
    if (rotConflict) throw new Error(rotConflict);
    const ruleConflict = await validateNoConflictingRules(ctx, args.userId, rule.targetAccountIds, rule.targetCampaignIds ?? [], args.ruleId);
    if (ruleConflict) throw new Error(ruleConflict);
    // Schedule activation (action must run outside mutation)
    await ctx.scheduler.runAfter(0, internal.videoRotation.activate, { ruleId: args.ruleId });
  } else {
    // Schedule deactivation
    await ctx.scheduler.runAfter(0, internal.videoRotation.deactivate, { ruleId: args.ruleId });
  }
}
```

- [ ] **Step 5: Handle rotation rule deletion**

In the `remove` mutation (line 590-616), before `await ctx.db.delete(args.ruleId)` (line 613), add:

```typescript
// Deactivate rotation if active
if (rule.type === "video_rotation" && rule.isActive) {
  await ctx.scheduler.runAfter(0, internal.videoRotation.deactivate, { ruleId: args.ruleId });
}

// Clean up rotationState
const rotState = await ctx.db
  .query("rotationState")
  .withIndex("by_ruleId", (q) => q.eq("ruleId", args.ruleId))
  .first();
if (rotState) {
  await ctx.db.delete(rotState._id);
}
```

- [ ] **Step 6: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: Clean output.

- [ ] **Step 7: Commit**

```bash
git add convex/rules.ts
git commit -m "feat(rules): add video_rotation validations, conflict checks, activate/deactivate on toggle"
```

---

### Task 5: Skip rotation campaigns in ruleEngine

**Files:**
- Modify: `convex/ruleEngine.ts`

- [ ] **Step 1: Import and use getRotatingCampaignIds**

Find the `checkRulesForAccount` function in `convex/ruleEngine.ts`. Near the beginning of its handler, after fetching account data and metrics, add:

```typescript
// Get campaigns in active rotations — skip them in rule evaluation
const rotatingCampaignIds = new Set(
  await ctx.runQuery(internal.videoRotation.getRotatingCampaignIds, { accountId: args.accountId })
);
```

Then, in the per-banner evaluation loop, add a skip before `evaluateCondition`:

```typescript
// Skip banners whose campaign is in an active rotation
if (rotatingCampaignIds.size > 0) {
  const bannerCampaignId = bannerCampaignMap.get(String(banner.id));
  if (bannerCampaignId && rotatingCampaignIds.has(bannerCampaignId)) {
    continue;
  }
}
```

Note: The exact location depends on the loop structure. Find where individual banners are evaluated and add the skip there.

- [ ] **Step 2: Add import**

Add at the top of `convex/ruleEngine.ts`:

```typescript
// videoRotation is imported via internal.videoRotation — no direct import needed
```

(The `internal` import already exists at the top of the file.)

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: Clean output.

- [ ] **Step 4: Commit**

```bash
git add convex/ruleEngine.ts
git commit -m "feat(ruleEngine): skip campaigns in active rotation during rule evaluation"
```

---

### Task 6: deleteUser cascade for rotationState

**Files:**
- Modify: `convex/users.ts`

- [ ] **Step 1: Add rotationState cleanup to deleteUser**

In `convex/users.ts`, in the `deleteUser` mutation handler, after the rules deletion block (line 617), add:

```typescript
// Delete rotation states (linked via rules, but also clean up directly)
for (const rule of rules) {
  const rotState = await ctx.db
    .query("rotationState")
    .withIndex("by_ruleId", (q) => q.eq("ruleId", rule._id))
    .first();
  if (rotState) {
    await ctx.db.delete(rotState._id);
  }
}
```

Note: This must be added BEFORE the rules are deleted (before line 616 `await ctx.db.delete(rule._id)`), since we need the rule._id to find rotationState.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: Clean output.

- [ ] **Step 3: Commit**

```bash
git add convex/users.ts
git commit -m "fix(users): add rotationState to deleteUser cascade"
```

---

### Task 7: Admin module toggle

**Files:**
- Modify: `convex/admin.ts`

- [ ] **Step 1: Add toggleVideoRotation mutation**

In `convex/admin.ts`, add a new mutation after the existing ones:

```typescript
/** Toggle video rotation module for a user */
export const toggleVideoRotation = mutation({
  args: {
    sessionToken: v.string(),
    targetUserId: v.id("users"),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    await assertAdmin(ctx, args.sessionToken);

    const user = await ctx.db.get(args.targetUserId);
    if (!user) throw new Error("Пользователь не найден");

    await ctx.db.patch(args.targetUserId, {
      videoRotationEnabled: args.enabled,
      updatedAt: Date.now(),
    });

    return { success: true };
  },
});

/** List all users with their module flags (for admin Modules tab) */
export const listUsersModules = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    // Verify admin
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", args.sessionToken))
      .first();
    if (!session) throw new Error("Не авторизован");
    const user = await ctx.db.get(session.userId);
    if (!user) throw new Error("Не авторизован");
    const ADMIN_EMAILS = ["13632013@vk.com", "786709647@vk.com"];
    if (!user.isAdmin && !ADMIN_EMAILS.includes(user.email)) {
      throw new Error("Нет доступа");
    }

    const users = await ctx.db.query("users").collect();
    return users.map((u) => ({
      _id: u._id,
      name: u.name ?? u.email,
      email: u.email,
      videoRotationEnabled: u.videoRotationEnabled ?? false,
    }));
  },
});
```

- [ ] **Step 2: Add missing imports if needed**

Make sure `query` is imported at the top of `convex/admin.ts`:

```typescript
import { mutation, query, action, internalQuery } from "./_generated/server";
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: Clean output.

- [ ] **Step 4: Commit**

```bash
git add convex/admin.ts
git commit -m "feat(admin): add toggleVideoRotation and listUsersModules"
```

---

### Task 8: Rotation state query for frontend

**Files:**
- Modify: `convex/videoRotation.ts`

- [ ] **Step 1: Add public query for rotation status**

Add a public query to `convex/videoRotation.ts` for the frontend to display rotation status:

```typescript
import { query } from "./_generated/server";

/** Get rotation state for a rule (frontend display) */
export const getRotationStatus = query({
  args: { ruleId: v.id("rules") },
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("rotationState")
      .withIndex("by_ruleId", (q) => q.eq("ruleId", args.ruleId))
      .first();
    if (!state) return null;

    // Get campaign name
    const campaigns = await ctx.db
      .query("campaigns")
      .withIndex("by_accountId", (q) => q.eq("accountId", state.accountId))
      .collect();

    const currentCampaign = campaigns.find(
      (c) => c.vkCampaignId === state.currentCampaignId
    );

    // Get rule for total campaign count
    const rule = await ctx.db.get(args.ruleId);
    const conditions = rule?.conditions as { campaignOrder?: string[] } | undefined;
    const totalCampaigns = conditions?.campaignOrder?.length ?? 0;

    return {
      status: state.status,
      currentIndex: state.currentIndex,
      currentCampaignName: currentCampaign?.name ?? state.currentCampaignId,
      totalCampaigns,
      cycleNumber: state.cycleNumber,
      slotStartedAt: state.slotStartedAt,
      lastError: state.lastError,
    };
  },
});
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: Clean output.

- [ ] **Step 3: Commit**

```bash
git add convex/videoRotation.ts
git commit -m "feat(videoRotation): add getRotationStatus public query for frontend"
```

---

### Task 9: Admin Modules Tab UI

**Files:**
- Create: `src/pages/admin/AdminModulesTab.tsx`
- Modify: `src/pages/admin/AdminPage.tsx`

- [ ] **Step 1: Create AdminModulesTab component**

Create `src/pages/admin/AdminModulesTab.tsx`:

```tsx
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Loader2, Blocks } from 'lucide-react';
import { Id } from '../../../convex/_generated/dataModel';

interface AdminModulesTabProps {
  sessionToken: string;
}

export function AdminModulesTab({ sessionToken }: AdminModulesTabProps) {
  const users = useQuery(api.admin.listUsersModules, { sessionToken });
  const toggleRotation = useMutation(api.admin.toggleVideoRotation);

  if (users === undefined) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Blocks className="h-5 w-5 text-primary" />
          Модули пользователей
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 px-3 font-medium text-muted-foreground">Пользователь</th>
                <th className="text-left py-2 px-3 font-medium text-muted-foreground">Email</th>
                <th className="text-center py-2 px-3 font-medium text-muted-foreground">Ротация кампаний</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u._id} className="border-b border-border/50 hover:bg-muted/50">
                  <td className="py-2 px-3">{u.name}</td>
                  <td className="py-2 px-3 text-muted-foreground">{u.email}</td>
                  <td className="py-2 px-3 text-center">
                    <button
                      onClick={() =>
                        toggleRotation({
                          sessionToken,
                          targetUserId: u._id as Id<"users">,
                          enabled: !u.videoRotationEnabled,
                        })
                      }
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        u.videoRotationEnabled ? 'bg-primary' : 'bg-muted'
                      }`}
                      data-testid={`toggle-rotation-${u._id}`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          u.videoRotationEnabled ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Add Modules tab to AdminPage**

In `src/pages/admin/AdminPage.tsx`:

Add import at the top:
```typescript
import { AdminModulesTab } from './admin/AdminModulesTab';
```

Wait — the file is at `src/pages/admin/AdminPage.tsx`, so the import should be:
```typescript
import { AdminModulesTab } from './AdminModulesTab';
```

Add to TABS array (line 16-24), after `rules-diagnostic`:
```typescript
{ id: 'modules', label: 'Модули', icon: Blocks },
```

Add `Blocks` to the lucide-react import.

Add conditional render in the tab content section:
```tsx
{activeTab === 'modules' && <AdminModulesTab sessionToken={sessionToken} />}
```

- [ ] **Step 3: Run build check**

Run: `npm run build`
Expected: Clean build.

- [ ] **Step 4: Commit**

```bash
git add src/pages/admin/AdminModulesTab.tsx src/pages/admin/AdminPage.tsx
git commit -m "feat(admin): add Modules tab with video rotation toggle per user"
```

---

### Task 10: Video rotation form in RulesPage

**Files:**
- Modify: `src/pages/RulesPage.tsx`

- [ ] **Step 1: Add video_rotation to type definitions**

In `src/pages/RulesPage.tsx`:

Add `'video_rotation'` to the `RuleType` union (line 18):
```typescript
type RuleType = 'cpl_limit' | 'min_ctr' | 'fast_spend' | 'spend_no_leads' | 'budget_limit' | 'low_impressions' | 'clicks_no_leads' | 'cpc_limit' | 'new_lead' | 'uz_budget_manage' | 'custom' | 'custom_l3' | 'video_rotation';
```

Add to `RULE_TYPE_LABELS` (line 29-42):
```typescript
video_rotation: 'Ротация кампаний',
```

Add to `RULE_TYPE_DESCRIPTIONS` (line 44-57):
```typescript
video_rotation: 'Последовательный запуск выбранных кампаний по расписанию. Каждая кампания работает фиксированное время, затем автоматически переключается на следующую.',
```

Add to `RULE_TYPE_UNITS` (line 59-72):
```typescript
video_rotation: '',
```

- [ ] **Step 2: Add rotation-specific state to RuleForm**

In the `RuleForm` function (line 533+), add state variables after `minSpent` state (line 568):

```typescript
// video_rotation state
const [slotDurationHours, setSlotDurationHours] = useState('4');
const [rotationDailyBudget, setRotationDailyBudget] = useState('');
const [rotationQuietHoursEnabled, setRotationQuietHoursEnabled] = useState(false);
const [rotationQuietHoursStart, setRotationQuietHoursStart] = useState('23:00');
const [rotationQuietHoursEnd, setRotationQuietHoursEnd] = useState('07:00');
```

- [ ] **Step 3: Add rotation validation in handleSubmit**

In the `handleSubmit` function, after the `cpc_limit` validation block (line 612), add:

```typescript
} else if (type === 'video_rotation') {
  const slot = Number(slotDurationHours);
  const budget = Number(rotationDailyBudget);
  if (!slot || slot < 1 || slot > 24 || !Number.isInteger(slot)) {
    setFormError('Время слота: от 1 до 24 часов (целое число)');
    return;
  }
  if (!budget || budget <= 0) {
    setFormError('Бюджет на сутки должен быть больше 0');
    return;
  }
  if (targets.campaignIds.length < 2) {
    setFormError('Выберите минимум 2 кампании для ротации');
    return;
  }
  if (targets.campaignIds.length > 50) {
    setFormError('Максимум 50 кампаний');
    return;
  }
```

- [ ] **Step 4: Add rotation fields to submit payload**

In the submit handler, add a new branch for `video_rotation` (alongside the constructor and regular branches):

```typescript
} else if (type === 'video_rotation') {
  await onSubmit({
    name: name.trim(),
    type: 'video_rotation',
    value: 0,
    actions: { stopAd: false, notify: true },
    targetAccountIds: targets.accountIds as Id<"adAccounts">[],
    targetCampaignIds: targets.campaignIds,
    slotDurationHours: Number(slotDurationHours),
    rotationDailyBudget: Number(rotationDailyBudget),
    campaignOrder: targets.campaignIds, // Order matches selection order
    rotationQuietHoursEnabled: rotationQuietHoursEnabled,
    rotationQuietHoursStart: rotationQuietHoursEnabled ? rotationQuietHoursStart : undefined,
    rotationQuietHoursEnd: rotationQuietHoursEnabled ? rotationQuietHoursEnd : undefined,
  });
```

- [ ] **Step 5: Add rotation form fields in JSX**

In the form JSX, after the `cpc_limit` fields block, add a new conditional block:

```tsx
{type === 'video_rotation' && (
  <div className="space-y-4">
    <div>
      <label className="text-sm font-medium">Время слота (часов)</label>
      <select
        value={slotDurationHours}
        onChange={(e) => setSlotDurationHours(e.target.value)}
        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
      >
        {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
          <option key={h} value={h}>{h} ч</option>
        ))}
      </select>
    </div>
    <div>
      <label className="text-sm font-medium">Бюджет на сутки, руб.</label>
      <input
        type="number"
        min="1"
        value={rotationDailyBudget}
        onChange={(e) => setRotationDailyBudget(e.target.value)}
        placeholder="6000"
        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
      />
    </div>
    <div className="flex items-center gap-2">
      <input
        type="checkbox"
        id="rotation-quiet-hours"
        checked={rotationQuietHoursEnabled}
        onChange={(e) => setRotationQuietHoursEnabled(e.target.checked)}
        className="rounded border-border"
      />
      <label htmlFor="rotation-quiet-hours" className="text-sm">Тихие часы</label>
    </div>
    {rotationQuietHoursEnabled && (
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">с</span>
        <input
          type="time"
          value={rotationQuietHoursStart}
          onChange={(e) => setRotationQuietHoursStart(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1 text-sm"
        />
        <span className="text-sm text-muted-foreground">до</span>
        <input
          type="time"
          value={rotationQuietHoursEnd}
          onChange={(e) => setRotationQuietHoursEnd(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1 text-sm"
        />
        <span className="text-xs text-muted-foreground">(UTC)</span>
      </div>
    )}
    <p className="text-xs text-muted-foreground">
      Кампании будут откручиваться последовательно. Порядок определяется порядком выбора в дереве кампаний.
    </p>
  </div>
)}
```

- [ ] **Step 6: Conditionally show video_rotation type**

The type selector should only show `video_rotation` if user has `videoRotationEnabled` or `isAdmin`. Add a check in the type dropdown rendering:

```tsx
// Filter available rule types
const availableTypes = Object.entries(RULE_TYPE_LABELS).filter(([key]) => {
  if (key === 'video_rotation') {
    // Show only if module enabled or admin
    return true; // Frontend shows it — backend validates access
  }
  if (key === 'custom_l3') return false; // Hidden from regular users
  return true;
});
```

Note: The actual access control happens in the backend `create` mutation. Frontend can show the option — if the user tries to create it without access, the backend will reject.

- [ ] **Step 7: Add rotation status display in rule card**

In the rule list rendering, after the badge showing rule type, add a rotation status indicator. Find where individual rule cards are rendered and add:

```tsx
{rule.type === 'video_rotation' && (
  <RotationStatusBadge ruleId={rule._id} />
)}
```

Create the `RotationStatusBadge` component inline (or as a separate function in the same file):

```tsx
function RotationStatusBadge({ ruleId }: { ruleId: Id<"rules"> }) {
  const status = useQuery(api.videoRotation.getRotationStatus, { ruleId });

  if (!status) return null;

  const statusLabels: Record<string, string> = {
    running: 'Активна',
    paused_quiet_hours: 'Пауза (тихие часы)',
    paused_intervention: 'Приостановлена',
    stopped: 'Остановлена',
  };

  const statusColors: Record<string, string> = {
    running: 'text-green-600',
    paused_quiet_hours: 'text-yellow-600',
    paused_intervention: 'text-red-600',
    stopped: 'text-muted-foreground',
  };

  return (
    <div className="text-xs mt-1">
      <span className={statusColors[status.status] ?? 'text-muted-foreground'}>
        {statusLabels[status.status] ?? status.status}
      </span>
      {status.status === 'running' && (
        <span className="text-muted-foreground ml-1">
          — {status.currentCampaignName} ({status.currentIndex + 1}/{status.totalCampaigns}, цикл #{status.cycleNumber})
        </span>
      )}
      {status.lastError && status.status === 'paused_intervention' && (
        <span className="text-destructive ml-1">— {status.lastError}</span>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Hide value/action fields for rotation type**

In the form JSX, the value input and action radio should be hidden for `video_rotation`:

Find the value input section and wrap it:
```tsx
{type !== 'new_lead' && type !== 'uz_budget_manage' && type !== 'video_rotation' && (
  // existing value input
)}
```

Find the ActionRadio section and wrap it:
```tsx
{type !== 'video_rotation' && (
  <ActionRadio ... />
)}
```

Find the timeWindow selector and add `video_rotation` to exclusion:
```tsx
{(type === 'clicks_no_leads' || type === 'low_impressions') && type !== 'video_rotation' && (
  // existing time window selector
)}
```

- [ ] **Step 9: Run build check**

Run: `npm run build`
Expected: Clean build.

- [ ] **Step 10: Commit**

```bash
git add src/pages/RulesPage.tsx
git commit -m "feat(rules-ui): add video_rotation form, status badge, and type filtering"
```

---

### Task 11: Full integration typecheck and lint

**Files:**
- All modified files

- [ ] **Step 1: Run Convex typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: Clean output.

- [ ] **Step 2: Run frontend build**

Run: `npm run build`
Expected: Clean build.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: Max 50 warnings, no errors.

- [ ] **Step 4: Fix any issues found**

Address any type errors, lint issues, or build failures.

- [ ] **Step 5: Commit fixes if any**

```bash
git add -A
git commit -m "fix: resolve typecheck and lint issues for video rotation module"
```

---

### Task 12: Manual integration test checklist

This task has no code — it's a verification checklist for the implementer to run manually.

- [ ] **Step 1: Deploy to dev environment**

Run Convex deploy to dev.

- [ ] **Step 2: Verify admin can toggle module**

1. Go to `/admin` > "Модули" tab
2. Enable rotation for a test user
3. Verify the toggle persists

- [ ] **Step 3: Verify rule creation**

1. Login as the enabled user
2. Go to `/rules`
3. Create a new rule with type "Ротация кампаний"
4. Select an account, 2+ campaigns, set slot to 1 hour, budget to 100 rub
5. Save and verify rule appears in the list

- [ ] **Step 4: Verify activation**

1. Toggle the rule active
2. Check Telegram — should receive "Ротация запущена" message
3. Check VK Ads — first campaign should be active, others blocked

- [ ] **Step 5: Verify conflict validation**

1. Try creating a regular rule (`cpl_limit`) on the same account without campaign filter
2. Should get error: "На аккаунте есть активная ротация..."
3. Try creating a rule on a campaign in rotation
4. Should get error: "Кампания участвует в ротации..."

- [ ] **Step 6: Verify deactivation**

1. Toggle the rotation rule inactive
2. Check Telegram — should receive "Ротация остановлена"
3. Check VK Ads — all campaigns should be blocked

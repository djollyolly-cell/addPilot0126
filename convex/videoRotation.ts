import { v } from "convex/values";
import { action, query, internalAction, internalMutation, internalQuery } from "./_generated/server";
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

// ---- Internal queries ----

/** Get all active rotation states */
export const listActiveRotations = internalQuery({
  args: {},
  handler: async (ctx) => {
    const allStates = await ctx.db.query("rotationState").collect();
    return allStates.filter((s) => s.status !== "stopped");
  },
});

/** Find active video_rotation rules that have no rotationState (orphaned) */
export const listOrphanedRotationRules = internalQuery({
  args: {},
  handler: async (ctx) => {
    const allRules = await ctx.db.query("rules").collect();
    const rotationRules = allRules.filter(
      (r) => r.type === "video_rotation" && r.isActive
    );
    if (rotationRules.length === 0) return [];

    const allStates = await ctx.db.query("rotationState").collect();
    const ruleIdsWithState = new Set(allStates.map((s) => s.ruleId));

    return rotationRules
      .filter((r) => !ruleIdsWithState.has(r._id))
      .map((r) => r._id);
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

// ---- Types ----

interface RotationConditions {
  slotDurationHours: number;
  dailyBudget: number;
  campaignOrder: string[];
  quietHoursEnabled?: boolean;
  quietHoursStart?: string;
  quietHoursEnd?: string;
}

interface VkCampaign {
  id: number;
  name: string;
  status: string;
}

// ---- Actions ----

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
    const conditions = rule.conditions as RotationConditions;
    const { campaignOrder, dailyBudget, slotDurationHours } = conditions;
    if (!campaignOrder || campaignOrder.length < 2) {
      throw new Error("Минимум 2 кампании для ротации");
    }

    const accountId = rule.targetAccountIds[0];
    const accessToken = await ctx.runAction(
      internal.auth.getValidTokenForAccount,
      { accountId }
    );

    // Stop all target ad_plans (targetCampaignIds = ad_plan IDs)
    const adPlans = await ctx.runAction(
      internal.vkApi.getAdPlansForAccount,
      { accessToken }
    ) as VkCampaign[];

    const targetSet = new Set(rule.targetCampaignIds ?? []);
    for (const c of adPlans) {
      if (targetSet.has(String(c.id)) && c.status === "active") {
        await ctx.runAction(internal.vkApi.updateAdPlanStatus, {
          accessToken,
          adPlanId: c.id,
          status: "blocked",
        });
      }
    }

    // Start the first ad_plan
    const firstCampaignId = Number(campaignOrder[0]);
    // Try to set budget (non-fatal: campaigns with budget optimization reject this)
    try {
      await ctx.runAction(internal.vkApi.setAdPlanBudget, {
        accessToken,
        adPlanId: firstCampaignId,
        newLimitRubles: dailyBudget,
      });
    } catch (err) {
      console.warn(`[videoRotation.activate] Budget set failed for ${firstCampaignId}, continuing:`, err instanceof Error ? err.message : err);
    }
    await ctx.runAction(internal.vkApi.updateAdPlanStatus, {
      accessToken,
      adPlanId: firstCampaignId,
      status: "active",
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
    const firstCampaign = adPlans.find((c) => String(c.id) === campaignOrder[0]);
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
        text: `<b>Ротация запущена</b>\n\n${rule.name}\n${campaignOrder.length} кампаний, слот ${slotDurationHours}ч\nБюджет: ${dailyBudget} руб./сутк��\nПервая: ${firstName}`,
      });
    }
  },
});

/** Deactivate rotation: stop current campaign, delete state */
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
        await ctx.runAction(internal.vkApi.updateAdPlanStatus, {
          accessToken,
          adPlanId: Number(state.currentCampaignId),
          status: "blocked",
        });
      } catch (err) {
        console.error(`[videoRotation.deactivate] Failed to stop ad_plan ${state.currentCampaignId}:`, err);
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

    // Self-healing: find active video_rotation rules without rotationState
    // This handles cases where activate() failed on initial creation/toggle
    const orphanedRuleIds = await ctx.runQuery(internal.videoRotation.listOrphanedRotationRules);
    for (const ruleId of orphanedRuleIds) {
      try {
        console.log(`[videoRotation.tick] Self-healing: activating orphaned rule ${ruleId}`);
        await ctx.runAction(internal.videoRotation.activate, { ruleId });
      } catch (err) {
        console.error(`[videoRotation.tick] Self-healing failed for rule ${ruleId}:`, err);
      }
    }
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ActionCtx = { runQuery: any; runMutation: any; runAction: any };

interface RotationStateRow {
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

async function processRotation(ctx: ActionCtx, state: RotationStateRow) {
  const rule = await ctx.runQuery(internal.rules.getRule, { ruleId: state.ruleId });
  if (!rule || !rule.isActive || rule.type !== "video_rotation") {
    // Rule deleted or deactivated — clean up state
    await ctx.runMutation(internal.videoRotation.deleteState, { stateId: state._id });
    return;
  }

  const conditions = rule.conditions as RotationConditions;

  let accessToken: string;
  try {
    accessToken = await ctx.runAction(
      internal.auth.getValidTokenForAccount,
      { accountId: state.accountId }
    );
  } catch {
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
        await ctx.runAction(internal.vkApi.updateAdPlanStatus, {
          accessToken,
          adPlanId: Number(state.currentCampaignId),
          status: "active",
        });
      } catch {
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
  const adPlans = await ctx.runAction(
    internal.vkApi.getAdPlansForAccount,
    { accessToken }
  ) as VkCampaign[];

  const currentCampaign = adPlans.find((c) => String(c.id) === state.currentCampaignId);
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
      await ctx.runAction(internal.vkApi.updateAdPlanStatus, {
        accessToken,
        adPlanId: Number(state.currentCampaignId),
        status: "blocked",
      });
    } catch {
      await handleApiError(ctx, state, rule, "Не удалось остановить кампанию для тихих часов");
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
    await switchToNext(ctx, state, rule, conditions, adPlans, accessToken);
  }
  // Else: slot still active, nothing to do
}

async function switchToNext(
  ctx: ActionCtx,
  state: RotationStateRow,
  rule: { _id: Id<"rules">; userId: Id<"users">; name: string },
  conditions: RotationConditions,
  campaigns: VkCampaign[],
  accessToken: string
) {
  const now = Date.now();
  const today = todayStr();
  const { campaignOrder, dailyBudget } = conditions;

  // 1. Stop current ad_plan
  try {
    await ctx.runAction(internal.vkApi.updateAdPlanStatus, {
      accessToken,
      adPlanId: Number(state.currentCampaignId),
      status: "blocked",
    });
  } catch {
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

  // 6. Set budget (non-fatal) then start next ad_plan
  try {
    await ctx.runAction(internal.vkApi.setAdPlanBudget, {
      accessToken,
      adPlanId: Number(nextCampaignId),
      newLimitRubles: remaining > 0 ? remaining : dailyBudget,
    });
  } catch (budgetErr) {
    // Budget optimization campaigns reject this — continue without budget change
    console.warn(`[videoRotation.switchToNext] Budget set failed for ${nextCampaignId}, continuing:`, budgetErr instanceof Error ? budgetErr.message : budgetErr);
  }
  try {
    await ctx.runAction(internal.vkApi.updateAdPlanStatus, {
      accessToken,
      adPlanId: Number(nextCampaignId),
      status: "active",
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
  ctx: ActionCtx,
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

// ---- Public queries ----

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

// TEMP: Public action to manually trigger activate for debugging
export const debugActivate = action({
  args: { ruleId: v.id("rules") },
  handler: async (ctx, args) => {
    try {
      const rule = await ctx.runQuery(internal.rules.getRule, { ruleId: args.ruleId });
      if (!rule || rule.type !== "video_rotation") {
        return { error: "Правило не найдено или имеет неверный тип" };
      }
      const conditions = rule.conditions as RotationConditions;
      const { campaignOrder, dailyBudget } = conditions;
      if (!campaignOrder || campaignOrder.length < 2) {
        return { error: "Минимум 2 кампании", conditions };
      }

      const accountId = rule.targetAccountIds[0];
      console.log("[debugActivate] accountId:", accountId);

      const accessToken = await ctx.runAction(
        internal.auth.getValidTokenForAccount,
        { accountId }
      );
      console.log("[debugActivate] got token, length:", accessToken?.length);

      const adPlans = await ctx.runAction(
        internal.vkApi.getAdPlansForAccount,
        { accessToken }
      ) as VkCampaign[];
      console.log("[debugActivate] ad_plans from VK:", adPlans.length);

      const targetSet = new Set(rule.targetCampaignIds ?? []);
      const matched = adPlans.filter(c => targetSet.has(String(c.id)));
      console.log("[debugActivate] matched target ad_plans:", matched.map(c => ({ id: c.id, name: c.name, status: c.status })));

      // Try to set budget (non-fatal: campaigns with budget optimization reject this)
      const firstCampaignId = Number(campaignOrder[0]);
      console.log("[debugActivate] starting ad_plan:", firstCampaignId);

      try {
        await ctx.runAction(internal.vkApi.setAdPlanBudget, {
          accessToken,
          adPlanId: firstCampaignId,
          newLimitRubles: dailyBudget,
        });
        console.log("[debugActivate] budget set OK");
      } catch (budgetErr: any) {
        console.warn("[debugActivate] budget set failed (non-fatal):", budgetErr.message);
      }
      await ctx.runAction(internal.vkApi.updateAdPlanStatus, {
        accessToken,
        adPlanId: firstCampaignId,
        status: "active",
      });
      console.log("[debugActivate] ad_plan started successfully");

      // Create state
      await ctx.runMutation(internal.videoRotation.createState, {
        ruleId: args.ruleId,
        accountId,
        currentIndex: 0,
        currentCampaignId: campaignOrder[0],
        slotStartedAt: Date.now(),
        dailyBudgetRemaining: dailyBudget,
        budgetDayStart: todayStr(),
        cycleNumber: 1,
        status: "running" as const,
      });
      console.log("[debugActivate] state created");

      return { success: true, startedCampaign: firstCampaignId };
    } catch (e: any) {
      console.error("[debugActivate] ERROR:", e);
      return { error: e.message, stack: e.stack };
    }
  },
});

import { v } from "convex/values";
import { mutation, internalAction, internalQuery, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * AI Recommendations engine for AI Cabinet campaigns.
 * Analyzes metrics and generates actionable recommendations.
 * Runs every 6 hours via cron for active campaigns.
 */

// ─── Cron entry point ────────────────────────────────────────────

export const checkAllCampaigns = internalAction({
  args: {},
  handler: async (ctx) => {
    // Get all active AI campaigns
    const campaigns = await ctx.runQuery(internal.aiRecommendations.listActiveCampaigns);
    if (campaigns.length === 0) return;

    for (const campaign of campaigns) {
      try {
        await analyzeAndRecommend(ctx, campaign);
      } catch (error) {
        console.error(
          `[aiRecommendations] Error for campaign ${campaign._id}:`,
          error instanceof Error ? error.message : error
        );
      }
    }
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function analyzeAndRecommend(ctx: any, campaign: any) {
  // Get campaign's VK campaign ID to find metrics
  if (!campaign.vkCampaignId) return;

  // Get daily metrics for this campaign's ads (last 3 days)
  const metrics = await ctx.runQuery(internal.aiRecommendations.getCampaignMetrics, {
    campaignId: campaign.vkCampaignId,
    accountId: campaign.accountId,
  });

  if (!metrics || metrics.totalSpent === 0) return;

  // Get existing pending recommendations to avoid duplicates
  const existing = await ctx.runQuery(internal.aiRecommendations.getPendingRecommendations, {
    campaignId: campaign._id,
  });
  const existingTypes = new Set(existing.map((r: { type: string }) => r.type));

  const recommendations: { type: string; message: string; actionData?: unknown }[] = [];

  // Analyze: high CPL (> 2x budget/expected)
  if (metrics.totalLeads > 0 && metrics.cpl > campaign.dailyBudget * 0.5) {
    if (!existingTypes.has("decrease_budget")) {
      recommendations.push({
        type: "decrease_budget",
        message: `CPL ${Math.round(metrics.cpl)}₽ выше целевого. Рекомендуем сузить аудиторию или снизить бюджет.`,
        actionData: { currentCpl: metrics.cpl, dailyBudget: campaign.dailyBudget },
      });
    }
  }

  // Analyze: good CPL, can scale
  if (metrics.totalLeads >= 3 && metrics.cpl < campaign.dailyBudget * 0.15) {
    if (!existingTypes.has("increase_budget")) {
      const suggestedBudget = Math.round(campaign.dailyBudget * 1.5);
      recommendations.push({
        type: "increase_budget",
        message: `Отличный CPL ${Math.round(metrics.cpl)}₽! Рекомендуем увеличить бюджет до ${suggestedBudget}₽/день для масштабирования.`,
        actionData: { suggestedBudget, currentCpl: metrics.cpl },
      });
    }
  }

  // Analyze: spending without leads
  if (metrics.totalSpent > campaign.dailyBudget * 2 && metrics.totalLeads === 0) {
    if (!existingTypes.has("decrease_budget")) {
      recommendations.push({
        type: "decrease_budget",
        message: `Потрачено ${Math.round(metrics.totalSpent)}₽ без лидов. Рекомендуем поставить на паузу и пересмотреть таргетинги.`,
        actionData: { totalSpent: metrics.totalSpent },
      });
    }
  }

  // Analyze: low CTR
  if (metrics.totalImpressions > 1000 && metrics.ctr < 0.3) {
    if (!existingTypes.has("regenerate")) {
      recommendations.push({
        type: "regenerate",
        message: `CTR ${metrics.ctr.toFixed(2)}% ниже среднего. Рекомендуем перегенерировать баннеры с новыми текстами.`,
        actionData: { ctr: metrics.ctr },
      });
    }
  }

  // Analyze: small audience (low impressions relative to budget)
  if (metrics.totalSpent > campaign.dailyBudget * 0.8 && metrics.totalImpressions < 500) {
    if (!existingTypes.has("expand_geo")) {
      recommendations.push({
        type: "expand_geo",
        message: `Мало показов (${metrics.totalImpressions}) при полном расходе бюджета. Рекомендуем расширить географию.`,
        actionData: { impressions: metrics.totalImpressions },
      });
    }
  }

  // Save recommendations and notify
  for (const rec of recommendations) {
    await ctx.runMutation(internal.aiRecommendations.createRecommendation, {
      campaignId: campaign._id,
      type: rec.type,
      message: rec.message,
      actionData: rec.actionData,
    });

    // Notify via Telegram
    const user = await ctx.runQuery(internal.users.getById, { userId: campaign.userId });
    if (user?.telegramChatId) {
      await ctx.runAction(internal.telegram.sendMessage, {
        chatId: user.telegramChatId,
        text: `💡 <b>AI рекомендация</b>\n\nКампания: ${campaign.name}\n${rec.message}`,
      });
    }
  }

  if (recommendations.length > 0) {
    console.log(
      `[aiRecommendations] Campaign ${campaign._id}: ${recommendations.length} new recommendations`
    );
  }
}

// ─── Queries ─────────────────────────────────────────────────────

export const listActiveCampaigns = internalQuery({
  args: {},
  handler: async (ctx) => {
    return ctx.db
      .query("aiCampaigns")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect();
  },
});

export const getCampaignMetrics = internalQuery({
  args: {
    campaignId: v.string(), // vkCampaignId
    accountId: v.id("adAccounts"),
  },
  handler: async (ctx, args) => {
    // Get metrics for the last 3 days for ads in this campaign
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    const dateFrom = threeDaysAgo.toISOString().slice(0, 10);

    const allMetrics = await ctx.db
      .query("metricsDaily")
      .withIndex("by_accountId_date", (q) =>
        q.eq("accountId", args.accountId).gte("date", dateFrom)
      )
      .collect();

    // Filter to this campaign's ads
    const campaignMetrics = allMetrics.filter(
      (m) => m.campaignId === args.campaignId
    );

    let totalSpent = 0;
    let totalLeads = 0;
    let totalClicks = 0;
    let totalImpressions = 0;

    for (const m of campaignMetrics) {
      totalSpent += m.spent;
      totalLeads += m.leads;
      totalClicks += m.clicks;
      totalImpressions += m.impressions;
    }

    return {
      totalSpent,
      totalLeads,
      totalClicks,
      totalImpressions,
      cpl: totalLeads > 0 ? totalSpent / totalLeads : 0,
      ctr: totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0,
    };
  },
});

export const getPendingRecommendations = internalQuery({
  args: { campaignId: v.id("aiCampaigns") },
  handler: async (ctx, args) => {
    return ctx.db
      .query("aiRecommendations")
      .withIndex("by_campaignId", (q) => q.eq("campaignId", args.campaignId))
      .filter((q) => q.eq(q.field("status"), "pending"))
      .collect();
  },
});

// ─── Mutations ───────────────────────────────────────────────────

export const createRecommendation = internalMutation({
  args: {
    campaignId: v.id("aiCampaigns"),
    type: v.string(),
    message: v.string(),
    actionData: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return ctx.db.insert("aiRecommendations", {
      campaignId: args.campaignId,
      type: args.type,
      message: args.message,
      actionData: args.actionData,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

export const applyRecommendation = internalMutation({
  args: { id: v.id("aiRecommendations") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { status: "applied" });
  },
});

export const rejectRecommendation = internalMutation({
  args: { id: v.id("aiRecommendations") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { status: "rejected" });
  },
});

// ─── Public mutations (callable from frontend) ──────────────────

export const applyRecommendationPublic = mutation({
  args: { id: v.id("aiRecommendations"), userId: v.id("users") },
  handler: async (ctx, args) => {
    const rec = await ctx.db.get(args.id);
    if (!rec) throw new Error("Рекомендация не найдена");
    // Verify ownership through campaign
    const campaign = await ctx.db.get(rec.campaignId);
    if (!campaign || campaign.userId !== args.userId) throw new Error("Нет доступа");
    await ctx.db.patch(args.id, { status: "applied" });
  },
});

export const rejectRecommendationPublic = mutation({
  args: { id: v.id("aiRecommendations"), userId: v.id("users") },
  handler: async (ctx, args) => {
    const rec = await ctx.db.get(args.id);
    if (!rec) throw new Error("Рекомендация не найдена");
    const campaign = await ctx.db.get(rec.campaignId);
    if (!campaign || campaign.userId !== args.userId) throw new Error("Нет доступа");
    await ctx.db.patch(args.id, { status: "rejected" });
  },
});

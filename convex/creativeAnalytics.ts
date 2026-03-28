import { v } from "convex/values";
import { internalMutation, internalQuery, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

// Save/update creative stats for a specific ad+date
export const saveCreativeStats = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    videoId: v.optional(v.id("videos")),
    adId: v.string(),
    date: v.string(),
    impressions: v.number(),
    clicks: v.number(),
    spent: v.number(),
    videoStarted: v.optional(v.number()),
    videoViewed3s: v.optional(v.number()),
    videoViewed10s: v.optional(v.number()),
    videoViewed25: v.optional(v.number()),
    videoViewed50: v.optional(v.number()),
    videoViewed75: v.optional(v.number()),
    videoViewed100: v.optional(v.number()),
    depthOfView: v.optional(v.number()),
    viewed3sRate: v.optional(v.number()),
    viewed25Rate: v.optional(v.number()),
    viewed50Rate: v.optional(v.number()),
    viewed75Rate: v.optional(v.number()),
    viewed100Rate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("creativeStats")
      .withIndex("by_adId_date", (q) =>
        q.eq("adId", args.adId).eq("date", args.date)
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        impressions: args.impressions,
        clicks: args.clicks,
        spent: args.spent,
        videoStarted: args.videoStarted,
        videoViewed3s: args.videoViewed3s,
        videoViewed10s: args.videoViewed10s,
        videoViewed25: args.videoViewed25,
        videoViewed50: args.videoViewed50,
        videoViewed75: args.videoViewed75,
        videoViewed100: args.videoViewed100,
        depthOfView: args.depthOfView,
        viewed3sRate: args.viewed3sRate,
        viewed25Rate: args.viewed25Rate,
        viewed50Rate: args.viewed50Rate,
        viewed75Rate: args.viewed75Rate,
        viewed100Rate: args.viewed100Rate,
      });
      return existing._id;
    }

    return await ctx.db.insert("creativeStats", {
      accountId: args.accountId,
      videoId: args.videoId,
      adId: args.adId,
      date: args.date,
      impressions: args.impressions,
      clicks: args.clicks,
      spent: args.spent,
      videoStarted: args.videoStarted,
      videoViewed3s: args.videoViewed3s,
      videoViewed10s: args.videoViewed10s,
      videoViewed25: args.videoViewed25,
      videoViewed50: args.videoViewed50,
      videoViewed75: args.videoViewed75,
      videoViewed100: args.videoViewed100,
      depthOfView: args.depthOfView,
      viewed3sRate: args.viewed3sRate,
      viewed25Rate: args.viewed25Rate,
      viewed50Rate: args.viewed50Rate,
      viewed75Rate: args.viewed75Rate,
      viewed100Rate: args.viewed100Rate,
      createdAt: Date.now(),
    });
  },
});

// Get accumulated stats for a video across all dates
export const getStatsByVideo = internalQuery({
  args: { videoId: v.id("videos") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("creativeStats")
      .withIndex("by_videoId", (q) => q.eq("videoId", args.videoId))
      .collect();
  },
});

// Get videos ready for analysis:
// - linked to an ad (vkAdId set)
// - active, uploaded
// - created 24h+ ago
// - never analyzed OR last analyzed 7+ days ago (re-analysis)
export const getVideosReadyForAnalysis = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

    const allVideos = await ctx.db.query("videos").collect();
    const candidates = allVideos.filter(
      (v) =>
        v.vkAdId &&
        v.isActive &&
        v.uploadStatus === "ready" &&
        v.createdAt < twentyFourHoursAgo &&
        (!v.lastAnalyzedAt || v.lastAnalyzedAt < sevenDaysAgo)
    );

    const results = [];
    for (const video of candidates) {
      const stats = await ctx.db
        .query("creativeStats")
        .withIndex("by_videoId", (q) => q.eq("videoId", video._id))
        .collect();

      // Must have at least some video start data
      const hasVideoData = stats.some((s) => (s.videoStarted || 0) > 0);
      if (hasVideoData) {
        results.push({ video, stats });
      }
    }

    return results;
  },
});

// Mark video as analyzed (update lastAnalyzedAt)
export const markVideoAnalyzed = internalMutation({
  args: { videoId: v.id("videos") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.videoId, {
      lastAnalyzedAt: Date.now(),
    });
  },
});

// Save AI analysis results to creativeStats
export const saveWatchAnalysis = internalMutation({
  args: {
    creativeStatsId: v.id("creativeStats"),
    aiWatchScore: v.number(),
    aiWatchScoreLabel: v.string(),
    aiRecommendations: v.array(v.object({
      issue: v.string(),
      suggestion: v.string(),
      priority: v.string(),
    })),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.creativeStatsId, {
      aiAnalyzedAt: Date.now(),
      aiWatchScore: args.aiWatchScore,
      aiWatchScoreLabel: args.aiWatchScoreLabel,
      aiRecommendations: args.aiRecommendations,
    });
  },
});

// AI analysis of video watch rates — called by cron
export const analyzeWatchRates = internalAction({
  args: {
    videoId: v.id("videos"),
  },
  handler: async (ctx, args) => {
    const video = await ctx.runQuery(internal.videos.getInternal, { id: args.videoId });
    if (!video) return;

    const stats = await ctx.runQuery(internal.creativeAnalytics.getStatsByVideo, {
      videoId: args.videoId,
    });
    if (stats.length === 0) return;

    // Aggregate stats across all dates
    const totals = stats.reduce(
      (acc, s) => ({
        impressions: acc.impressions + s.impressions,
        clicks: acc.clicks + s.clicks,
        spent: acc.spent + s.spent,
        videoStarted: acc.videoStarted + (s.videoStarted || 0),
        videoViewed3s: acc.videoViewed3s + (s.videoViewed3s || 0),
        videoViewed10s: acc.videoViewed10s + (s.videoViewed10s || 0),
        videoViewed25: acc.videoViewed25 + (s.videoViewed25 || 0),
        videoViewed50: acc.videoViewed50 + (s.videoViewed50 || 0),
        videoViewed75: acc.videoViewed75 + (s.videoViewed75 || 0),
        videoViewed100: acc.videoViewed100 + (s.videoViewed100 || 0),
      }),
      {
        impressions: 0, clicks: 0, spent: 0,
        videoStarted: 0, videoViewed3s: 0, videoViewed10s: 0,
        videoViewed25: 0, videoViewed50: 0, videoViewed75: 0, videoViewed100: 0,
      }
    );

    if (totals.videoStarted === 0) return;

    // Calculate retention percentages
    const pct = (val: number) => Math.round((val / totals.videoStarted) * 100);
    const retention = {
      p3s: pct(totals.videoViewed3s),
      p10s: pct(totals.videoViewed10s),
      p25: pct(totals.videoViewed25),
      p50: pct(totals.videoViewed50),
      p75: pct(totals.videoViewed75),
      p100: pct(totals.videoViewed100),
    };

    const isReanalysis = !!video.lastAnalyzedAt;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("[creativeAnalytics] ANTHROPIC_API_KEY не настроен");
      return;
    }

    const systemPrompt = `Ты — эксперт по видеорекламе VK Ads. Проанализируй воронку досмотров видеокреатива и дай рекомендации по улучшению досматриваемости.

Отвечай ТОЛЬКО JSON, без пояснений:
{
  "score": число 0-100 (общая оценка удержания),
  "scoreLabel": "Плохо" | "Средне" | "Хорошо" | "Отлично",
  "recommendations": [
    {
      "issue": "описание проблемы на русском",
      "suggestion": "конкретное предложение по исправлению на русском",
      "priority": "high" | "medium" | "low"
    }
  ]
}

Ориентиры для VK Ads видео:
- Хорошее удержание на 3 сек: >70% (хук работает)
- Хорошее удержание на 25%: >60%
- Хорошее удержание на 50%: >35%
- Хорошее удержание на 75%: >20%
- Хорошее удержание на 100%: >10%

Паттерны проблем:
- Падение на 3 сек >30% = слабый хук, первый кадр не цепляет
- Падение 3с→10с резкое = контент не оправдывает обещание хука
- Равномерное падение = контент не держит внимание, нет динамики
- Падение перед финалом = нет CTA / видео слишком длинное
- Глубина просмотра <30% = видео не соответствует аудитории`;

    // Add business context if available
    let businessCtx = "";
    try {
      const account = await ctx.runQuery(internal.adAccounts.getInternal, { accountId: video.accountId });
      if (account?.companyName || account?.industry) {
        const parts: string[] = [];
        if (account.companyName) parts.push(`Компания: ${account.companyName}`);
        if (account.industry) parts.push(`Ниша: ${account.industry}`);

        const allDirections = await ctx.runQuery(internal.businessDirections.listInternal, { accountId: video.accountId });
        if (allDirections.length > 0) {
          const dir = allDirections[0];
          if (dir.name) parts.push(`Направление: ${dir.name}`);
          if (dir.targetAudience) parts.push(`ЦА: ${dir.targetAudience}`);
        }

        businessCtx = `\n\nКонтекст бизнеса: ${parts.join(", ")}`;
      }
    } catch {
      // Business context is optional
    }

    const systemPromptFinal = systemPrompt + businessCtx;

    const userMessage = `${isReanalysis ? "ПОВТОРНЫЙ АНАЛИЗ (через 7 дней). Сравни с предыдущими ориентирами и оцени динамику.\n\n" : ""}Видео: "${video.filename}"
${video.transcription ? `Транскрипция (первые 500 символов): ${video.transcription.slice(0, 500)}` : "Транскрипция недоступна"}

Статистика за ${stats.length} дней:
- Показы: ${totals.impressions}
- Клики: ${totals.clicks} (CTR: ${totals.impressions > 0 ? ((totals.clicks / totals.impressions) * 100).toFixed(2) : 0}%)
- Расход: ${totals.spent.toFixed(2)}₽

Воронка досмотров:
- Старт видео: ${totals.videoStarted} (100%)
- 3 секунды: ${totals.videoViewed3s} (${retention.p3s}%)
- 10 секунд: ${totals.videoViewed10s} (${retention.p10s}%)
- 25%: ${totals.videoViewed25} (${retention.p25}%)
- 50%: ${totals.videoViewed50} (${retention.p50}%)
- 75%: ${totals.videoViewed75} (${retention.p75}%)
- 100%: ${totals.videoViewed100} (${retention.p100}%)`;

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: systemPromptFinal,
          messages: [{ role: "user", content: userMessage }],
        }),
      });

      if (!response.ok) {
        console.error(`[creativeAnalytics] Claude API error: ${response.status}`);
        return;
      }

      const data = await response.json();
      const text = data.content?.[0]?.text || "";
      const analysis = JSON.parse(text);

      // Save analysis to the latest creativeStats record
      const latestStat = stats.sort((a, b) => b.createdAt - a.createdAt)[0];
      await ctx.runMutation(internal.creativeAnalytics.saveWatchAnalysis, {
        creativeStatsId: latestStat._id,
        aiWatchScore: analysis.score,
        aiWatchScoreLabel: analysis.scoreLabel,
        aiRecommendations: analysis.recommendations || [],
      });

      // Update the video record with watch rates for UI display
      await ctx.runMutation(internal.videos.saveAnalysis, {
        id: args.videoId,
        aiScore: analysis.score,
        aiScoreLabel: analysis.scoreLabel,
        aiAnalysis: {
          watchRates: {
            p25: totals.videoViewed25,
            p50: totals.videoViewed50,
            p75: totals.videoViewed75,
            p95: totals.videoViewed100, // schema uses p95, we map p100 here
          },
          totalViews: totals.videoStarted,
          recommendations: (analysis.recommendations || []).map((r: any) => ({
            field: r.priority === "high" ? "Критично" : r.priority === "medium" ? "Важно" : "Совет",
            original: r.issue,
            suggested: r.suggestion,
            reason: undefined,
          })),
          transcriptMatch: undefined,
        },
      });

      // Mark video as analyzed (for re-analysis scheduling)
      await ctx.runMutation(internal.creativeAnalytics.markVideoAnalyzed, {
        videoId: args.videoId,
      });

      console.log(`[creativeAnalytics] Video ${video.filename}: score=${analysis.score} (${isReanalysis ? "re-analysis" : "first analysis"})`);

      // Send Telegram notification
      try {
        const user = await ctx.runQuery(internal.users.getById, { userId: video.userId });
        if (user?.telegramChatId) {
          let shouldNotify = false;
          let prevScore: number | undefined;

          if (!isReanalysis) {
            // First analysis — always notify
            shouldNotify = true;
          } else {
            // Re-analysis — notify only if score changed ≥15 points
            prevScore = latestStat.aiWatchScore ?? undefined;
            if (prevScore !== undefined) {
              shouldNotify = Math.abs(analysis.score - prevScore) >= 15;
            } else {
              shouldNotify = true; // no previous score, treat as first
            }
          }

          if (shouldNotify) {
            const funnel = `100% → ${retention.p3s}% (3с) → ${retention.p25}% (25%) → ${retention.p50}% (50%) → ${retention.p100}% (100%)`;

            let text: string;
            if (!isReanalysis) {
              const recs = (analysis.recommendations || [])
                .slice(0, 3)
                .map((r: any) => `• ${r.issue}`)
                .join("\n");

              text = `📊 <b>Анализ видео «${video.filename}»</b>\n\nОценка удержания: <b>${analysis.score}/100 — ${analysis.scoreLabel}</b>\nВоронка: ${funnel}${recs ? `\n\n⚠️ Рекомендации:\n${recs}` : ""}`;
            } else {
              const diff = analysis.score - (prevScore || 0);
              const sign = diff > 0 ? "+" : "";
              const emoji = diff > 0 ? "📈" : "📉";

              text = `📊 <b>Ре-анализ видео «${video.filename}»</b>\n\nОценка удержания: <b>${analysis.score}/100 — ${analysis.scoreLabel}</b>\n${emoji} Изменение: ${prevScore} → ${analysis.score} (${sign}${diff} за 7 дней)\nВоронка: ${funnel}`;
            }

            await ctx.runAction(internal.telegram.sendMessage, {
              chatId: user.telegramChatId,
              text,
            });
          }
        }
      } catch (tgError) {
        console.error(
          `[creativeAnalytics] Telegram notification error:`,
          tgError instanceof Error ? tgError.message : tgError
        );
      }
    } catch (error) {
      console.error(
        `[creativeAnalytics] Error analyzing video ${args.videoId}:`,
        error instanceof Error ? error.message : error
      );
    }
  },
});

// Cron handler: check all videos 24h+ old, fetch stats, run AI analysis
// Also re-analyzes videos every 7 days for updated recommendations
export const checkNewCreatives = internalAction({
  args: {},
  handler: async (ctx) => {
    const readyVideos = await ctx.runQuery(
      internal.creativeAnalytics.getVideosReadyForAnalysis,
      {}
    );

    if (readyVideos.length === 0) {
      return;
    }

    console.log(`[creativeAnalytics] Found ${readyVideos.length} videos to analyze`);

    for (const { video } of readyVideos) {
      try {
        await ctx.runAction(internal.creativeAnalytics.analyzeWatchRates, {
          videoId: video._id,
        });
      } catch (error) {
        console.error(
          `[creativeAnalytics] Failed to analyze ${video._id}:`,
          error instanceof Error ? error.message : error
        );
      }
    }
  },
});

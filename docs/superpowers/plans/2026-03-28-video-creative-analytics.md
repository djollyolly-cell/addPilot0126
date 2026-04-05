# Video Creative Analytics — Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Автоматический анализ досмотренности видеокреативов через 24ч после запуска с рекомендациями по улучшению, плюс накопление статистики по креативам для будущего AI-режима.

**Architecture:**
- Связываем видео (`videos`) с объявлениями (`ads`) через `vkAdId` — автоматически через сопоставление `vkMediaId` с `banners[].content.video_id`
- Расширяем sync метрик: запрашиваем video-метрики из myTarget API (`statistics/banners/day.json` с `metrics=base,video`)
- Новая таблица `creativeStats` копит статистику в разрезе креативов
- Cron через 24ч после загрузки проверяет статистику и запускает Claude-анализ досмотренности
- Повторный анализ через 7 дней для уточнения рекомендаций

**Tech Stack:** Convex (backend), myTarget API v2 (статистика видео), Claude API (анализ), React (фронтенд)

**Проверено:** myTarget API v2 подтверждённо возвращает video-метрики. Реальные имена полей:
- `video.started`, `video.viewed_3_seconds`, `video.viewed_10_seconds`
- `video.viewed_25_percent`, `video.viewed_50_percent`, `video.viewed_75_percent`, `video.viewed_100_percent`
- `video.viewed_*_rate` (проценты), `video.viewed_*_cost` (стоимость за просмотр)
- `video.depth_of_view` (средняя глубина просмотра)

---

## Файловая структура

| Файл | Действие | Ответственность |
|------|----------|-----------------|
| `convex/schema.ts` | Modify | Добавить таблицу `creativeStats`, расширить `videos` полями `vkAdId`, `lastAnalyzedAt` |
| `convex/creativeAnalytics.ts` | Create | Сбор video-метрик, AI-анализ досмотренности, cron-обработчик, авто-привязка |
| `convex/vkApi.ts` | Modify | Добавить action `getMtVideoStatistics` с video-метриками |
| `convex/syncMetrics.ts` | Modify | Сохранять video-метрики при sync |
| `convex/crons.ts` | Modify | Добавить cron `analyze-new-creatives` (каждые 2 часа) |
| `convex/videos.ts` | Modify | Добавить `linkToAd` mutation, `listLinkedVideos` query |
| `src/components/VideoItem.tsx` | Modify | Показывать реальные watchRates + AI-рекомендации по досмотренности |
| `src/components/WatchRateChart.tsx` | Create | Визуализация воронки досмотров (старт→3сек→25%→50%→75%→100%) |

---

### Task 1: Расширить схему БД

**Files:**
- Modify: `convex/schema.ts`

- [ ] **Step 1: Добавить поля в таблицу `videos`**

В `convex/schema.ts`, в определении таблицы `videos`, добавить после `vkMediaUrl`:

```typescript
vkAdId: v.optional(v.string()),         // Links video to VK ad (banner) for stats
lastAnalyzedAt: v.optional(v.number()), // When AI last analyzed this video's watch rates
```

- [ ] **Step 2: Добавить таблицу `creativeStats`**

В `convex/schema.ts`, перед `credentialHistory`, добавить:

```typescript
// Creative performance statistics (accumulated from VK API)
creativeStats: defineTable({
  accountId: v.id("adAccounts"),
  videoId: v.optional(v.id("videos")),
  adId: v.string(),           // VK banner ID
  date: v.string(),           // "YYYY-MM-DD"
  impressions: v.number(),
  clicks: v.number(),
  spent: v.number(),
  // Video watch funnel (from myTarget API: statistics/banners/day.json?metrics=base,video)
  videoStarted: v.optional(v.number()),
  videoViewed3s: v.optional(v.number()),
  videoViewed10s: v.optional(v.number()),
  videoViewed25: v.optional(v.number()),
  videoViewed50: v.optional(v.number()),
  videoViewed75: v.optional(v.number()),
  videoViewed100: v.optional(v.number()),
  depthOfView: v.optional(v.number()),   // avg % of video watched
  // Pre-calculated rates from API (0-100%)
  viewed3sRate: v.optional(v.number()),
  viewed25Rate: v.optional(v.number()),
  viewed50Rate: v.optional(v.number()),
  viewed75Rate: v.optional(v.number()),
  viewed100Rate: v.optional(v.number()),
  // AI analysis results
  aiAnalyzedAt: v.optional(v.number()),
  aiWatchScore: v.optional(v.number()),        // 0-100
  aiWatchScoreLabel: v.optional(v.string()),   // "Плохо" | "Средне" | "Хорошо" | "Отлично"
  aiRecommendations: v.optional(v.array(v.object({
    issue: v.string(),
    suggestion: v.string(),
    priority: v.string(),   // "high" | "medium" | "low"
  }))),
  createdAt: v.number(),
})
  .index("by_adId_date", ["adId", "date"])
  .index("by_videoId", ["videoId"])
  .index("by_accountId_date", ["accountId", "date"]),
```

- [ ] **Step 3: Сгенерировать типы и проверить typecheck**

Run:
```bash
ADMIN_KEY=$(CONVEX_INSTANCE_SECRET=2de125637ad4cefdbb60e5e350aa0894545bc813a4bc296fcdbd3e3506490e19 node gen_key.cjs) && \
CONVEX_SELF_HOSTED_URL="https://convex.aipilot.by" \
CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY" \
npx convex codegen && \
npx tsc --noEmit -p convex/tsconfig.json
```
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add convex/schema.ts convex/_generated/api.d.ts
git commit -m "feat: add creativeStats table and vkAdId/lastAnalyzedAt to videos schema"
```

---

### Task 2: Получение video-метрик из VK API

**Files:**
- Modify: `convex/vkApi.ts`

- [ ] **Step 1: Добавить интерфейс для video-метрик**

В `convex/vkApi.ts`, после интерфейса `MtStatBase` (примерно строка 280), добавить:

```typescript
export interface MtVideoStats {
  started?: number;
  first_second?: number;
  viewed_3_seconds?: number;
  viewed_10_seconds?: number;
  viewed_25_percent?: number;
  viewed_50_percent?: number;
  viewed_75_percent?: number;
  viewed_100_percent?: number;
  viewed_3_seconds_rate?: number;
  viewed_25_percent_rate?: number;
  viewed_50_percent_rate?: number;
  viewed_75_percent_rate?: number;
  viewed_100_percent_rate?: number;
  depth_of_view?: number;
  started_cost?: string;
  viewed_3_seconds_cost?: string;
  viewed_100_percent_cost?: string;
}
```

- [ ] **Step 2: Добавить action `getMtVideoStatistics`**

После `getMtStatistics` action, добавить:

```typescript
// Get banner statistics WITH video metrics (started, viewed 25/50/75/100%)
// myTarget API v2: metrics=base,video returns video completion data
// Verified: API returns video.started, video.viewed_25_percent, etc.
export const getMtVideoStatistics = action({
  args: {
    accessToken: v.string(),
    dateFrom: v.string(),
    dateTo: v.string(),
    bannerIds: v.string(), // comma-separated banner IDs (required)
  },
  handler: async (_, args): Promise<MtStatItem[]> => {
    const data = await callMtApi<{ items: MtStatItem[]; total: any }>(
      "statistics/banners/day.json",
      args.accessToken,
      {
        id: args.bannerIds,
        date_from: args.dateFrom,
        date_to: args.dateTo,
        metrics: "base,video",
      }
    );
    return data.items || [];
  },
});
```

- [ ] **Step 3: Commit**

```bash
git add convex/vkApi.ts
git commit -m "feat: add getMtVideoStatistics action with video completion metrics"
```

---

### Task 3: Привязка видео к объявлению

**Files:**
- Modify: `convex/videos.ts`

- [ ] **Step 1: Добавить mutation `linkToAd`**

В `convex/videos.ts`, после `update` mutation, добавить:

```typescript
// Link video to a VK ad (banner) for statistics tracking
export const linkToAd = mutation({
  args: {
    videoId: v.id("videos"),
    vkAdId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.videoId, {
      vkAdId: args.vkAdId,
      updatedAt: Date.now(),
    });
  },
});
```

- [ ] **Step 2: Добавить internalQuery `listLinkedVideos`**

```typescript
// Get all videos linked to ads (have vkAdId) that need stats check
export const listLinkedVideos = internalQuery({
  args: {},
  handler: async (ctx) => {
    const allVideos = await ctx.db.query("videos").collect();
    return allVideos.filter(
      (v) => v.vkAdId && v.isActive && v.uploadStatus === "ready"
    );
  },
});
```

- [ ] **Step 3: Commit**

```bash
git add convex/videos.ts
git commit -m "feat: add linkToAd mutation and listLinkedVideos query"
```

---

### Task 4: Модуль аналитики креативов (backend)

**Files:**
- Create: `convex/creativeAnalytics.ts`

- [ ] **Step 1: Создать файл с импортами и saveStats mutation**

```typescript
import { v } from "convex/values";
import { internalMutation, internalQuery, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";

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
```

- [ ] **Step 2: Добавить queries для аналитики**

```typescript
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
      updatedAt: Date.now(),
    });
  },
});
```

- [ ] **Step 3: Добавить AI-анализ досмотренности**

```typescript
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
          system: systemPrompt,
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
    } catch (error) {
      console.error(
        `[creativeAnalytics] Error analyzing video ${args.videoId}:`,
        error instanceof Error ? error.message : error
      );
    }
  },
});
```

- [ ] **Step 4: Добавить cron-обработчик**

```typescript
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
```

- [ ] **Step 5: Commit**

```bash
git add convex/creativeAnalytics.ts
git commit -m "feat: add creativeAnalytics module with watch rate analysis and re-analysis"
```

---

### Task 5: Сбор video-метрик в syncMetrics

**Files:**
- Modify: `convex/syncMetrics.ts`

- [ ] **Step 1: Добавить сбор video-метрик после основного sync**

В `convex/syncMetrics.ts`, в handler `syncAll`, после блока `// Update sync time` (перед `await ctx.runMutation(api.adAccounts.updateSyncTime`), добавить:

```typescript
// Collect video stats for linked creatives
try {
  const linkedVideos = await ctx.runQuery(internal.videos.listLinkedVideos, {});
  const accountVideos = linkedVideos.filter((v: any) => v.accountId === account._id);

  if (accountVideos.length > 0) {
    const videoAdIds = accountVideos
      .map((v: any) => v.vkAdId)
      .filter(Boolean)
      .join(",");

    if (videoAdIds) {
      const videoStats = await ctx.runAction(api.vkApi.getMtVideoStatistics, {
        accessToken,
        dateFrom: date,
        dateTo: date,
        bannerIds: videoAdIds,
      });

      for (const item of videoStats) {
        const adId = String(item.id);
        const linkedVideo = accountVideos.find((v: any) => v.vkAdId === adId);

        for (const row of item.rows) {
          const base = (row as any).base || row;
          const vid = (row as any).video || {};

          await ctx.runMutation(internal.creativeAnalytics.saveCreativeStats, {
            accountId: account._id,
            videoId: linkedVideo?._id,
            adId,
            date: row.date,
            impressions: base.shows || 0,
            clicks: base.clicks || 0,
            spent: parseFloat(base.spent || "0") || 0,
            // Absolute counts (from API: video.started, video.viewed_25_percent, etc.)
            videoStarted: vid.started || undefined,
            videoViewed3s: vid.viewed_3_seconds || undefined,
            videoViewed10s: vid.viewed_10_seconds || undefined,
            videoViewed25: vid.viewed_25_percent || undefined,
            videoViewed50: vid.viewed_50_percent || undefined,
            videoViewed75: vid.viewed_75_percent || undefined,
            videoViewed100: vid.viewed_100_percent || undefined,
            depthOfView: vid.depth_of_view || undefined,
            // Pre-calculated rates from API (already in %)
            viewed3sRate: vid.viewed_3_seconds_rate || undefined,
            viewed25Rate: vid.viewed_25_percent_rate || undefined,
            viewed50Rate: vid.viewed_50_percent_rate || undefined,
            viewed75Rate: vid.viewed_75_percent_rate || undefined,
            viewed100Rate: vid.viewed_100_percent_rate || undefined,
          });
        }
      }

      console.log(
        `[syncMetrics] Account ${account._id}: ${accountVideos.length} video creatives stats synced`
      );
    }
  }
} catch (error) {
  console.error(
    `[syncMetrics] Error fetching video stats for account ${account._id}:`,
    error instanceof Error ? error.message : error
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add convex/syncMetrics.ts
git commit -m "feat: collect video watch metrics during sync (correct API field names)"
```

---

### Task 6: Добавить cron для анализа креативов

**Files:**
- Modify: `convex/crons.ts`

- [ ] **Step 1: Добавить cron**

В `convex/crons.ts`, перед `export default crons;`, добавить:

```typescript
// Analyze video creatives 24h+ after upload, re-analyze every 7 days — every 2 hours
crons.interval(
  "analyze-new-creatives",
  { hours: 2 },
  internal.creativeAnalytics.checkNewCreatives
);
```

- [ ] **Step 2: Codegen и typecheck**

Run:
```bash
ADMIN_KEY=$(CONVEX_INSTANCE_SECRET=2de125637ad4cefdbb60e5e350aa0894545bc813a4bc296fcdbd3e3506490e19 node gen_key.cjs) && \
CONVEX_SELF_HOSTED_URL="https://convex.aipilot.by" \
CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY" \
npx convex codegen && \
npx tsc --noEmit -p convex/tsconfig.json
```
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add convex/crons.ts
git commit -m "feat: add cron for auto-analyzing video creatives after 24h"
```

---

### Task 7: Компонент воронки досмотров

**Files:**
- Create: `src/components/WatchRateChart.tsx`

- [ ] **Step 1: Создать компонент воронки**

```tsx
import { cn } from '@/lib/utils';

interface WatchRateChartProps {
  videoStarted: number;
  viewed3s?: number;
  p25: number;
  p50: number;
  p75: number;
  p100: number;
}

export function WatchRateChart({ videoStarted, viewed3s, p25, p50, p75, p100 }: WatchRateChartProps) {
  if (videoStarted === 0) return null;

  const pct = (val: number) => Math.round((val / videoStarted) * 100);

  const rates = [
    { label: 'Старт', value: videoStarted, pct: 100 },
    ...(viewed3s !== undefined ? [{ label: '3 сек', value: viewed3s, pct: pct(viewed3s) }] : []),
    { label: '25%', value: p25, pct: pct(p25) },
    { label: '50%', value: p50, pct: pct(p50) },
    { label: '75%', value: p75, pct: pct(p75) },
    { label: '100%', value: p100, pct: pct(p100) },
  ];

  const getColor = (val: number, idx: number) => {
    if (idx === 0) return 'bg-primary';
    if (val >= 50) return 'bg-green-500';
    if (val >= 25) return 'bg-amber-500';
    return 'bg-destructive';
  };

  return (
    <div className="space-y-2" data-testid="watch-rate-chart">
      <p className="text-sm font-medium">Воронка досмотров</p>
      <div className="space-y-1.5">
        {rates.map((rate, i) => (
          <div key={rate.label} className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-10 text-right shrink-0">
              {rate.label}
            </span>
            <div className="flex-1 h-5 bg-muted rounded-full overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all', getColor(rate.pct, i))}
                style={{ width: `${rate.pct}%` }}
              />
            </div>
            <span className="text-xs font-medium w-10 shrink-0">
              {rate.pct}%
            </span>
            <span className="text-xs text-muted-foreground w-16 shrink-0 hidden sm:block">
              {rate.value.toLocaleString('ru-RU')}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/WatchRateChart.tsx
git commit -m "feat: add WatchRateChart funnel component with 3s/25/50/75/100 steps"
```

---

### Task 8: Интеграция воронки в VideoItem

**Files:**
- Modify: `src/components/VideoItem.tsx`

- [ ] **Step 1: Импортировать WatchRateChart**

В начале файла добавить:

```typescript
import { WatchRateChart } from './WatchRateChart';
```

- [ ] **Step 2: Заменить блок watchRates на WatchRateChart**

В `VideoItem.tsx`, заменить блок `{/* Watch rates */}` (строки 201-223) на:

```tsx
{/* Watch rates funnel */}
{video.aiAnalysis?.watchRates && video.aiAnalysis?.totalViews && (
  <WatchRateChart
    videoStarted={video.aiAnalysis.totalViews}
    p25={video.aiAnalysis.watchRates.p25 || 0}
    p50={video.aiAnalysis.watchRates.p50 || 0}
    p75={video.aiAnalysis.watchRates.p75 || 0}
    p100={video.aiAnalysis.watchRates.p95 || 0}
  />
)}
```

- [ ] **Step 3: Добавить блок оценки удержания**

После блока `{/* Recommendations */}` (после строки 251), добавить:

```tsx
{/* Watch score */}
{video.aiAnalysis?.watchRates && video.aiScore !== undefined && (
  <div className="bg-muted/50 rounded-lg p-3">
    <p className="text-sm">
      <span className="text-muted-foreground">Оценка удержания: </span>
      <span className={cn(
        'font-bold',
        video.aiScore >= 61 ? 'text-green-600' :
        video.aiScore >= 41 ? 'text-amber-600' : 'text-destructive'
      )}>
        {video.aiScore}/100 — {video.aiScoreLabel}
      </span>
    </p>
  </div>
)}
```

- [ ] **Step 4: Commit**

```bash
git add src/components/VideoItem.tsx
git commit -m "feat: integrate WatchRateChart and watch score into VideoItem"
```

---

### Task 9: Deploy и проверка

**Files:**
- All modified files

- [ ] **Step 1: Полный typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: Max 50 warnings

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: Build success

- [ ] **Step 4: Deploy Convex**

```bash
ADMIN_KEY=$(CONVEX_INSTANCE_SECRET=2de125637ad4cefdbb60e5e350aa0894545bc813a4bc296fcdbd3e3506490e19 node gen_key.cjs) && \
CONVEX_SELF_HOSTED_URL="https://convex.aipilot.by" \
CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY" \
npx convex deploy --yes
```

- [ ] **Step 5: Final commit и push**

```bash
git add -A
git commit -m "feat: video creative analytics with watch rate analysis"
git push
```

---

## Изменения по сравнению с v1

1. **Исправлены имена полей API:** `video.viewed_25_percent` вместо `video.viewed_25` (проверено реальным запросом к myTarget API)
2. **Добавлены метрики 3с и 10с:** `viewed_3_seconds`, `viewed_10_seconds` — критичны для оценки хука
3. **Добавлен `depth_of_view`:** средняя глубина просмотра из API
4. **Сохраняются `*_rate` из API:** проценты напрямую от VK, не считаем вручную
5. **Повторный анализ через 7 дней:** поле `lastAnalyzedAt` в `videos`, cron проверяет и обновляет рекомендации
6. **Улучшен промт:** добавлены паттерны проблем для 3с и 10с, пометка повторного анализа
7. **Компонент воронки:** добавлен шаг "3 сек" в визуализацию

## Будущее развитие (не в этом плане)

1. **Авто-привязка видео к объявлению** — при создании объявления с видео-креативом автоматически проставлять `vkAdId` через сопоставление `videos.vkMediaId` с `banners[].content.video_id` из API
2. **Фото-креативы** — аналогичная статистика для баннеров (без video-метрик, но с CTR/CPL анализом)
3. **AI-режим создания кампаний** — используя накопленные `creativeStats`, AI выбирает лучшие креативы, формирует кампании, ставит бюджеты и запускает
4. **Telegram-уведомление** — "Видео X отработало 24ч, досмотренность 15% — рекомендуем переснять хук"
5. **Сравнение креативов** — таблица/график сравнения воронок нескольких видео

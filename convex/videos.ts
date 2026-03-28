import { v } from "convex/values";
import { query, mutation, action, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

// List videos for an account
export const list = query({
  args: {
    userId: v.id("users"),
    accountId: v.id("adAccounts"),
  },
  handler: async (ctx, args) => {
    const videos = await ctx.db
      .query("videos")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();
    return videos
      .filter((v) => v.userId === args.userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  },
});

// Get single video
export const get = query({
  args: { id: v.id("videos") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

// Create video record (queued for upload)
export const create = mutation({
  args: {
    userId: v.id("users"),
    accountId: v.id("adAccounts"),
    filename: v.string(),
    fileSize: v.optional(v.number()),
    direction: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("videos", {
      userId: args.userId,
      accountId: args.accountId,
      filename: args.filename,
      fileSize: args.fileSize,
      direction: args.direction,
      isActive: true,
      uploadStatus: "queued",
      createdAt: now,
      updatedAt: now,
    });
  },
});

// Update video metadata
export const update = mutation({
  args: {
    id: v.id("videos"),
    direction: v.optional(v.string()),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { id, ...updates } = args;
    await ctx.db.patch(id, { ...updates, updatedAt: Date.now() });
  },
});

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

// Delete single video
export const deleteVideo = mutation({
  args: { id: v.id("videos") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});

// Delete all videos for an account
export const deleteAll = mutation({
  args: {
    userId: v.id("users"),
    accountId: v.id("adAccounts"),
  },
  handler: async (ctx, args) => {
    const videos = await ctx.db
      .query("videos")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();
    const userVideos = videos.filter((v) => v.userId === args.userId);
    for (const video of userVideos) {
      await ctx.db.delete(video._id);
    }
    return userVideos.length;
  },
});

// Generate upload URL for temporary storage
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

// Update upload status
export const updateUploadStatus = internalMutation({
  args: {
    id: v.id("videos"),
    uploadStatus: v.union(
      v.literal("queued"),
      v.literal("uploading"),
      v.literal("processing"),
      v.literal("ready"),
      v.literal("failed")
    ),
    uploadProgress: v.optional(v.number()),
    vkMediaId: v.optional(v.string()),
    vkMediaUrl: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { id, ...updates } = args;
    await ctx.db.patch(id, { ...updates, updatedAt: Date.now() });
  },
});

// Upload video to VK via myTarget API
export const uploadToVk = action({
  args: {
    videoId: v.id("videos"),
    storageId: v.id("_storage"),
    accessToken: v.string(),
  },
  handler: async (ctx, args) => {
    // Mark as uploading
    await ctx.runMutation(internal.videos.updateUploadStatus, {
      id: args.videoId,
      uploadStatus: "uploading",
      uploadProgress: 0,
    });

    try {
      // Get file from Convex storage
      const fileUrl = await ctx.storage.getUrl(args.storageId);
      if (!fileUrl) throw new Error("Файл не найден в хранилище");

      const fileResponse = await fetch(fileUrl);
      if (!fileResponse.ok) throw new Error("Не удалось скачать файл из хранилища");

      const fileBlob = await fileResponse.blob();

      // Upload to myTarget API
      const formData = new FormData();
      const video = await ctx.runQuery(internal.videos.getInternal, { id: args.videoId });
      formData.append("file", fileBlob, video?.filename || "video.mp4");

      const mtResponse = await fetch(
        "https://target.my.com/api/v2/content/video.json",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${args.accessToken}`,
          },
          body: formData,
        }
      );

      if (!mtResponse.ok) {
        const errorText = await mtResponse.text();
        throw new Error(`VK API error: ${mtResponse.status} ${errorText}`);
      }

      const data = await mtResponse.json();

      // Update video record with VK media ID
      await ctx.runMutation(internal.videos.updateUploadStatus, {
        id: args.videoId,
        uploadStatus: "processing",
        uploadProgress: 100,
        vkMediaId: String(data.id || ""),
        vkMediaUrl: data.url || data.preview_url || "",
      });

      // Clean up temp storage
      await ctx.storage.delete(args.storageId);

      // Mark as ready
      await ctx.runMutation(internal.videos.updateUploadStatus, {
        id: args.videoId,
        uploadStatus: "ready",
      });

    } catch (error) {
      await ctx.runMutation(internal.videos.updateUploadStatus, {
        id: args.videoId,
        uploadStatus: "failed",
        errorMessage: error instanceof Error ? error.message : "Ошибка загрузки",
      });
      // Clean up temp storage on error
      try { await ctx.storage.delete(args.storageId); } catch { /* ignore cleanup errors */ }
      throw error;
    }
  },
});

// Internal get for actions
export const getInternal = internalQuery({
  args: { id: v.id("videos") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

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

// Auto-link videos to ads by matching vkMediaId with banner content.video_id
export const autoLinkVideos = internalMutation({
  args: {
    accountId: v.id("adAccounts"),
    bannerVideoMap: v.array(v.object({
      bannerId: v.string(),
      videoMediaId: v.string(),
    })),
  },
  handler: async (ctx, args) => {
    if (args.bannerVideoMap.length === 0) return;

    // Get all videos for this account that don't have vkAdId yet
    const allVideos = await ctx.db
      .query("videos")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();

    const unlinkedVideos = allVideos.filter(
      (v) => !v.vkAdId && v.vkMediaId && v.uploadStatus === "ready"
    );

    if (unlinkedVideos.length === 0) return;

    let linked = 0;
    for (const mapping of args.bannerVideoMap) {
      const video = unlinkedVideos.find(
        (v) => v.vkMediaId === mapping.videoMediaId
      );
      if (video) {
        await ctx.db.patch(video._id, {
          vkAdId: mapping.bannerId,
          updatedAt: Date.now(),
        });
        linked++;
        console.log(
          `[autoLink] Linked video "${video.filename}" → banner ${mapping.bannerId}`
        );
      }
    }

    if (linked > 0) {
      console.log(
        `[autoLink] Account ${args.accountId}: auto-linked ${linked} videos`
      );
    }
  },
});

// List all ads for an account (for manual linking dropdown)
export const listAdsByAccount = query({
  args: {
    accountId: v.id("adAccounts"),
  },
  handler: async (ctx, args) => {
    const ads = await ctx.db
      .query("ads")
      .withIndex("by_accountId_vkAdId", (q) => q.eq("accountId", args.accountId))
      .collect();
    return ads
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((ad) => ({
        _id: ad._id,
        vkAdId: ad.vkAdId,
        name: ad.name,
        status: ad.status,
      }));
  },
});

// Transcribe video using Whisper API
export const transcribeVideo = action({
  args: {
    videoId: v.id("videos"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const video = await ctx.runQuery(internal.videos.getInternal, { id: args.videoId });
    if (!video?.vkMediaUrl) throw new Error("Видео ещё не загружено в VK");

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY не настроен");

    try {
      // Download video from VK
      const videoResponse = await fetch(video.vkMediaUrl);
      if (!videoResponse.ok) throw new Error("Не удалось скачать видео для транскрибации");

      const videoBlob = await videoResponse.blob();

      // Send to Whisper
      const formData = new FormData();
      formData.append("file", videoBlob, video.filename);
      formData.append("model", "whisper-1");
      formData.append("language", "ru");

      const whisperResponse = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
      });

      if (!whisperResponse.ok) {
        const errorText = await whisperResponse.text();
        throw new Error(`Whisper API error: ${whisperResponse.status} ${errorText}`);
      }

      const data = await whisperResponse.json();
      const transcription = data.text || "";

      // Save transcription
      await ctx.runMutation(internal.videos.saveTranscription, {
        id: args.videoId,
        transcription,
      });

      return transcription;
    } catch (error) {
      throw new Error(
        `Ошибка транскрибации: ${error instanceof Error ? error.message : "Неизвестная ошибка"}`
      );
    }
  },
});

// Save transcription
export const saveTranscription = internalMutation({
  args: {
    id: v.id("videos"),
    transcription: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      transcription: args.transcription,
      updatedAt: Date.now(),
    });
  },
});

// AI analyze video using Claude
export const analyzeVideo = action({
  args: {
    videoId: v.id("videos"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    // Check limits
    const usage = await ctx.runQuery(internal.aiLimits.getUsageInternal, {
      userId: args.userId,
      type: "analysis",
    });
    const user = await ctx.runQuery(internal.users.getById, { userId: args.userId });
    const tier = user?.subscriptionTier || "freemium";
    const limits: Record<string, number> = { freemium: 0, start: 5, pro: 20 };
    if (usage >= (limits[tier] || 0)) {
      throw new Error("Лимит AI-анализов исчерпан. Обновите тариф.");
    }

    const video = await ctx.runQuery(internal.videos.getInternal, { id: args.videoId });
    if (!video?.transcription) throw new Error("Сначала выполните транскрибацию видео");

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY не настроен");

    const systemPrompt = `Ты — эксперт по рекламным видео для VK Ads. Проанализируй транскрипцию рекламного видео и выдай JSON с оценкой.

Формат ответа (только JSON, без пояснений):
{
  "score": число от 0 до 100,
  "scoreLabel": "Плохо" | "Средне" | "Хорошо" | "Отлично",
  "transcriptMatch": "low" | "medium" | "high",
  "recommendations": [
    {
      "field": "Видео" | "Текст" | "CTA" | "Структура",
      "original": "цитата из транскрипции",
      "suggested": "предложенная замена",
      "reason": "почему нужно изменить"
    }
  ]
}

Критерии оценки:
- Захватывает ли внимание в первые 3 секунды
- Есть ли чёткий оффер
- Есть ли призыв к действию
- Структура: боль → решение → выгода → CTA
- Длина и плотность контента`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{
          role: "user",
          content: `Транскрипция видео "${video.filename}":\n\n${video.transcription}`,
        }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Claude API error: ${response.status} ${text}`);
    }

    const data = await response.json();
    const responseText = data.content?.[0]?.text || "";

    try {
      const analysis = JSON.parse(responseText);

      await ctx.runMutation(internal.videos.saveAnalysis, {
        id: args.videoId,
        aiScore: analysis.score,
        aiScoreLabel: analysis.scoreLabel,
        aiAnalysis: {
          transcriptMatch: analysis.transcriptMatch,
          recommendations: analysis.recommendations || [],
        },
      });

      // Record usage
      await ctx.runMutation(internal.aiLimits.recordGeneration, {
        userId: args.userId,
        type: "analysis",
      });

      return analysis;
    } catch {
      throw new Error("Ошибка парсинга ответа AI");
    }
  },
});

// Save AI analysis
export const saveAnalysis = internalMutation({
  args: {
    id: v.id("videos"),
    aiScore: v.number(),
    aiScoreLabel: v.string(),
    aiAnalysis: v.object({
      watchRates: v.optional(v.object({
        p25: v.optional(v.number()),
        p50: v.optional(v.number()),
        p75: v.optional(v.number()),
        p95: v.optional(v.number()),
      })),
      avgWatchTime: v.optional(v.number()),
      totalViews: v.optional(v.number()),
      recommendations: v.optional(v.array(v.object({
        field: v.string(),
        original: v.string(),
        suggested: v.string(),
        reason: v.optional(v.string()),
      }))),
      transcriptMatch: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const { id, ...updates } = args;
    await ctx.db.patch(id, { ...updates, updatedAt: Date.now() });
  },
});

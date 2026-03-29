import { v } from "convex/values";
import { query, mutation, action, internalMutation, internalQuery } from "./_generated/server";
import { api, internal } from "./_generated/api";

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
    storageId: v.optional(v.id("_storage")),
    vkMediaId: v.optional(v.string()),
    vkMediaUrl: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { id, ...updates } = args;
    await ctx.db.patch(id, { ...updates, updatedAt: Date.now() });
  },
});

// Get account access token and advertiser ID (internal)
export const getAccountToken = internalQuery({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return null;
    return {
      accessToken: account.accessToken || null,
      vkAccountId: account.vkAccountId || null,
      mtAdvertiserId: account.mtAdvertiserId || null,
    };
  },
});

// Get account credentials (clientId, clientSecret) for VK Ads API auth
export const getAccountCredentials = internalQuery({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return null;
    return {
      clientId: account.clientId || null,
      clientSecret: account.clientSecret || null,
      accessToken: account.accessToken,
    };
  },
});

// myTarget API base — the actual API backend for VK Ads
const MT_API_BASE = "https://target.my.com";

// Upload video to VK Ads media library via myTarget API v3
export const uploadToVk = action({
  args: {
    videoId: v.id("videos"),
    storageId: v.id("_storage"),
    accountId: v.id("adAccounts"),
  },
  handler: async (ctx, args) => {
    // Get stored access token and VK account ID
    const accountInfo = await ctx.runQuery(internal.videos.getAccountToken, {
      accountId: args.accountId,
    });
    if (!accountInfo?.accessToken) throw new Error("Нет токена доступа для аккаунта. Переподключите аккаунт.");

    const { accessToken } = accountInfo;
    let mtAdvertiserId = accountInfo.mtAdvertiserId;

    // Auto-discover mtAdvertiserId if missing
    if (!mtAdvertiserId) {
      console.log(`[video upload] mtAdvertiserId missing, trying auto-discovery...`);
      // Get video record to find userId
      const video = await ctx.runQuery(internal.videos.getInternal, { id: args.videoId });
      if (video?.userId) {
        try {
          const vkTokens = await ctx.runQuery(internal.users.getVkTokens, {
            userId: video.userId,
          });
          if (vkTokens?.accessToken) {
            const adsResp = await fetch("https://api.vk.com/method/ads.getAccounts?v=5.131", {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: `access_token=${vkTokens.accessToken}`,
            });
            const adsData = await adsResp.json();
            if (adsData.response && Array.isArray(adsData.response) && adsData.response.length > 0) {
              mtAdvertiserId = String(adsData.response[0].account_id);
              // Save for future use
              await ctx.runMutation(internal.adAccounts.setMtAdvertiserId, {
                accountId: args.accountId,
                mtAdvertiserId,
              });
              console.log(`[video upload] Auto-discovered mtAdvertiserId=${mtAdvertiserId}`);
            }
          }
        } catch (e) {
          console.log(`[video upload] Auto-discovery failed: ${e}`);
        }
      }
    }

    if (!mtAdvertiserId) throw new Error("Не указан ID рекламного кабинета (mtAdvertiserId). Укажите его в настройках аккаунта.");

    // Mark as uploading and save storageId for transcription
    await ctx.runMutation(internal.videos.updateUploadStatus, {
      id: args.videoId,
      uploadStatus: "uploading",
      uploadProgress: 0,
      storageId: args.storageId,
    });

    try {
      // Get file from Convex storage
      const fileUrl = await ctx.storage.getUrl(args.storageId);
      if (!fileUrl) throw new Error("Файл не найден в хранилище");

      const video = await ctx.runQuery(internal.videos.getInternal, { id: args.videoId });
      const filename = video?.filename || "video.mp4";
      const fileSize = video?.fileSize || 0;

      const endpoint = `${MT_API_BASE}/api/v3/content/video.json?account=${mtAdvertiserId}`;
      console.log(`[video upload] Uploading ${filename} (${(fileSize / (1024*1024)).toFixed(1)} MB) to ${endpoint}`);

      // Step 1: Download file from Convex storage
      console.log(`[video upload] Step 1: downloading from storage...`);
      const dlStart = Date.now();
      const fileResponse = await fetch(fileUrl);
      if (!fileResponse.ok) throw new Error(`Не удалось скачать файл из хранилища: ${fileResponse.status}`);
      const fileBlob = await fileResponse.blob();
      console.log(`[video upload] Step 1 done: ${(fileBlob.size / (1024*1024)).toFixed(1)} MB downloaded in ${Date.now() - dlStart}ms`);

      // Step 2: Upload to myTarget API
      console.log(`[video upload] Step 2: uploading to myTarget...`);
      const ulStart = Date.now();
      const formData = new FormData();
      formData.append("file", fileBlob, filename);
      formData.append("data", JSON.stringify({ width: 0, height: 0 }));

      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: formData,
      });

      const respText = await resp.text();
      console.log(`[video upload] Step 2 done in ${Date.now() - ulStart}ms: status=${resp.status} body=${respText.substring(0, 500)}`);

      if (!resp.ok) {
        throw new Error(`VK Ads API: ${resp.status} ${respText}`);
      }

      const uploadData = JSON.parse(respText);
      console.log(`[video upload] Success, id=${uploadData?.id}`);

      // Update video record with VK media ID
      await ctx.runMutation(internal.videos.updateUploadStatus, {
        id: args.videoId,
        uploadStatus: "processing",
        uploadProgress: 100,
        vkMediaId: String(uploadData.id || ""),
        vkMediaUrl: uploadData.url || uploadData.preview_url || "",
      });

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

// Save pre-extracted frame storageIds on a video record
export const saveFrameStorageIds = mutation({
  args: {
    videoId: v.id("videos"),
    frameStorageIds: v.array(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.videoId, {
      frameStorageIds: args.frameStorageIds,
      updatedAt: Date.now(),
    });
  },
});

// Get storage URL for a video (for client-side audio extraction)
export const getStorageUrl = query({
  args: { videoId: v.id("videos") },
  handler: async (ctx, args) => {
    const video = await ctx.db.get(args.videoId);
    if (!video?.storageId) return null;
    return await ctx.storage.getUrl(video.storageId);
  },
});

// Full transcription: audio (Whisper) + video frames (Claude Vision)
export const transcribeVideo = action({
  args: {
    videoId: v.id("videos"),
    userId: v.id("users"),
    audioStorageId: v.optional(v.id("_storage")),
    frameStorageIds: v.optional(v.array(v.id("_storage"))),
  },
  handler: async (ctx, args) => {
    const video = await ctx.runQuery(internal.videos.getInternal, { id: args.videoId });
    if (!video) {
      throw new Error("Видео не найдено");
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    const openaiBaseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com";
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";

    try {
      // Step 1: Audio transcription via Whisper
      let audioText = "";
      const effectiveAudioId = args.audioStorageId || video.storageId;
      if (effectiveAudioId && openaiKey) {
        const fileUrl = await ctx.storage.getUrl(effectiveAudioId);
        if (fileUrl) {
          const fileResponse = await fetch(fileUrl);
          if (fileResponse.ok) {
            const fileBlob = await fileResponse.blob();
            const formData = new FormData();
            formData.append("file", fileBlob, args.audioStorageId ? "audio.wav" : (video.filename || "video.mp4"));
            formData.append("model", "whisper-1");
            formData.append("language", "ru");

            const whisperHeaders: Record<string, string> = {
              Authorization: `Bearer ${openaiKey}`,
            };
            if (process.env.OPENAI_BASE_URL) whisperHeaders["x-target-api"] = "openai";

            const whisperResponse = await fetch(`${openaiBaseUrl}/v1/audio/transcriptions`, {
              method: "POST",
              headers: whisperHeaders,
              body: formData,
            });

            if (whisperResponse.ok) {
              const data = await whisperResponse.json();
              audioText = data.text || "";
            } else {
              const errText = await whisperResponse.text().catch(() => "");
              console.error(`[transcribeVideo] Whisper API error ${whisperResponse.status}: ${errText}`);
            }
          }
        }
      }

      // Step 2: Video frames analysis via Claude Vision
      let videoDescription = "";
      if (args.frameStorageIds && args.frameStorageIds.length > 0 && anthropicKey) {
        const frameImages: Array<{ type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } }> = [];
        for (const storageId of args.frameStorageIds) {
          try {
            const url = await ctx.storage.getUrl(storageId);
            if (!url) continue;
            const resp = await fetch(url);
            if (!resp.ok) continue;
            const buffer = await resp.arrayBuffer();
            const base64 = btoa(
              new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), "")
            );
            frameImages.push({
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: base64 },
            });
          } catch (frameErr) {
            console.error(`[transcribeVideo] Failed to load frame ${storageId}:`, frameErr);
          }
        }

        if (frameImages.length > 0) {
          type ContentBlock = { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } };
          const userContent: ContentBlock[] = [
            { type: "text", text: `Это ключевые кадры рекламного видео "${video.filename || "video"}" (${frameImages.length} кадров по порядку). Опиши подробно что происходит в каждом кадре.` },
            ...frameImages,
          ];

          if (audioText) {
            userContent.push({
              type: "text",
              text: `\nАудиодорожка видео (распознанная речь):\n${audioText}`,
            });
          }

          const visionResponse = await fetch(`${anthropicBaseUrl}/v1/messages`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": anthropicKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: "claude-sonnet-4-20250514",
              max_tokens: 2000,
              system: `Ты транскрибируешь рекламное видео. Тебе даны ключевые кадры и аудио-дорожка.
Создай полную транскрибацию в формате:

**Видеоряд:**
Кадр 1 (0 сек): [описание: что на экране, текст, люди, графика]
Кадр 2 (3 сек): [описание]
...

**Аудио:**
[Полный текст того, что говорится в видео. Если голоса нет — напиши "Голос отсутствует"]

**Текст на экране:**
[Весь текст, который виден на кадрах: заголовки, субтитры, CTA, надписи]

**Резюме:**
[2-3 предложения: о чём это видео, что рекламирует, какой посыл]

Пиши на русском. Будь конкретным — описывай то, что видишь, без домыслов.`,
              messages: [{ role: "user", content: userContent }],
            }),
          });

          if (visionResponse.ok) {
            const visionData = await visionResponse.json();
            videoDescription = (visionData.content?.[0]?.text || "").trim();
          } else {
            const errText = await visionResponse.text().catch(() => "");
            console.error(`[transcribeVideo] Claude Vision API error ${visionResponse.status}: ${errText}`);
          }
        }
      }

      // Step 3: Combine results
      let transcription = "";
      if (videoDescription) {
        transcription = videoDescription;
      } else if (audioText) {
        transcription = `**Аудио:**\n${audioText}\n\n**Видеоряд:**\nКадры не были извлечены`;
      } else {
        throw new Error("Не удалось получить ни аудио, ни видеоряд");
      }

      // Save transcription
      await ctx.runMutation(internal.videos.saveTranscription, {
        id: args.videoId,
        transcription,
      });

      // Clean up temporary audio file (frames are kept on the video record for re-use)
      if (args.audioStorageId) {
        try { await ctx.storage.delete(args.audioStorageId); } catch (err) {
          console.warn(`[transcribeVideo] Failed to delete temp audio ${args.audioStorageId}:`, err);
        }
      }

      return transcription;
    } catch (error) {
      // Clean up temporary audio on error (frames belong to video record)
      if (args.audioStorageId) {
        try { await ctx.storage.delete(args.audioStorageId); } catch (err) {
          console.warn(`[transcribeVideo] Failed to delete temp audio on error:`, err);
        }
      }
      throw new Error(
        `Ошибка транскрибации: ${error instanceof Error ? error.message : "Неизвестная ошибка"}`
      );
    }
  },
});

// Save transcription (keep storage file for re-transcription and frame extraction)
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

// AI analyze video using Claude Vision (frames + transcription)
export const analyzeVideo = action({
  args: {
    videoId: v.id("videos"),
    userId: v.id("users"),
    frameStorageIds: v.optional(v.array(v.id("_storage"))),
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

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY не настроен");

    // Load frames as base64 for Claude Vision
    const frameImages: Array<{ type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } }> = [];
    if (args.frameStorageIds && args.frameStorageIds.length > 0) {
      for (const storageId of args.frameStorageIds) {
        const url = await ctx.storage.getUrl(storageId);
        if (!url) continue;
        const resp = await fetch(url);
        if (!resp.ok) continue;
        const buffer = await resp.arrayBuffer();
        const base64 = btoa(
          new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), "")
        );
        frameImages.push({
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: base64 },
        });
      }
    }

    const hasFrames = frameImages.length > 0;
    const hasTranscription = !!video?.transcription;

    if (!hasFrames && !hasTranscription) {
      throw new Error("Нет данных для анализа. Загрузите видео и выполните транскрибацию или извлеките кадры.");
    }

    const systemPrompt = `Ты — эксперт по рекламным видео для VK Ads. Проанализируй рекламное видео и выдай JSON с оценкой.

${hasFrames ? "Тебе предоставлены ключевые кадры видео (скриншоты через каждые несколько секунд)." : ""}
${hasTranscription ? "Также предоставлена транскрипция аудио-дорожки." : "Аудио-дорожки нет или она пустая — анализируй только визуальный ряд."}

ЧТО АНАЛИЗИРОВАТЬ:
${hasFrames ? `- Визуальный ряд: композиция кадров, текст на экране, CTA-элементы, брендинг
- Первый кадр: захватывает ли внимание? Есть ли визуальный крючок?
- Текст на экране: читаемый ли? Достаточно ли крупный? Контраст с фоном?
- Общая динамика: меняются ли кадры или статичная картинка?
- CTA: есть ли визуальный призыв к действию (кнопка, стрелка, текст)?` : ""}
${hasTranscription ? `- Голос/текст: структура повествования (боль → решение → выгода → CTA)
- Оффер: чёткий ли? Есть ли конкретика (цифры, сроки, результаты)?
- Темп: не слишком быстро/медленно?` : ""}

Формат ответа (только JSON, без пояснений):
{
  "score": число от 0 до 100,
  "scoreLabel": "Плохо" | "Средне" | "Хорошо" | "Отлично",
  "transcriptMatch": "low" | "medium" | "high",
  "recommendations": [
    {
      "field": "Видеоряд" | "Текст на экране" | "Голос/текст" | "CTA" | "Структура" | "Первый кадр",
      "original": "что сейчас (описание или цитата)",
      "suggested": "что нужно изменить",
      "reason": "почему это важно для конверсии/досмотра"
    }
  ]
}`;

    // Build message content with frames + transcription
    const userContent: Array<any> = [];

    if (hasFrames) {
      userContent.push({ type: "text", text: `Ключевые кадры видео "${video?.filename || "video"}" (${frameImages.length} кадров по порядку):` });
      for (const frame of frameImages) {
        userContent.push(frame);
      }
    }

    if (hasTranscription) {
      userContent.push({
        type: "text",
        text: `${hasFrames ? "\n" : ""}Транскрипция аудио:\n\n${video!.transcription}`,
      });
    }

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{
          role: "user",
          content: userContent,
        }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Claude API error: ${response.status} ${text}`);
    }

    const data = await response.json();
    let responseText = (data.content?.[0]?.text || "").trim();
    responseText = responseText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");

    // Clean up frame storage
    if (args.frameStorageIds) {
      for (const storageId of args.frameStorageIds) {
        try { await ctx.storage.delete(storageId); } catch { /* ignore */ }
      }
    }

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

// DIAGNOSTIC: discover advertiser ID via VK API ads.getAccounts
export const discoverAdvertiserId = action({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const results: Record<string, any> = {};

    // Get user's VK access token (from VK ID login)
    const vkTokens = await ctx.runQuery(internal.users.getVkTokens, {
      userId: args.userId,
    });

    if (vkTokens?.accessToken) {
      // Try VK API ads.getAccounts — returns list of ad cabinets
      try {
        const r = await fetch("https://api.vk.com/method/ads.getAccounts?v=5.131", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `access_token=${vkTokens.accessToken}`,
        });
        results["ads.getAccounts"] = await r.json();
      } catch (e) { results["ads.getAccounts"] = { error: String(e) }; }

      // Try VK API ads.getClients
      try {
        const r = await fetch("https://api.vk.com/method/ads.getClients?v=5.131&account_id=0", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `access_token=${vkTokens.accessToken}`,
        });
        results["ads.getClients"] = await r.json();
      } catch (e) { results["ads.getClients"] = { error: String(e) }; }
    } else {
      results["vkToken"] = "no VK access token found";
    }

    // Also try myTarget user.json for reference
    const accounts = await ctx.runQuery(api.adAccounts.list, {
      userId: args.userId,
    });

    if (accounts.length > 0 && accounts[0].accessToken) {
      const mtToken = accounts[0].accessToken;
      try {
        const r = await fetch("https://target.my.com/api/v2/user.json", {
          headers: { Authorization: `Bearer ${mtToken}` },
        });
        results["mt_user.json"] = await r.json();
      } catch (e) { results["mt_user.json"] = { error: String(e) }; }

      // Try POST to content/video.json WITHOUT ?account= (maybe it works for non-agency)
      try {
        const formData = new FormData();
        formData.append("data", JSON.stringify({ url: "https://example.com/test.mp4" }));
        const r = await fetch("https://target.my.com/api/v3/content/video.json", {
          method: "POST",
          headers: { Authorization: `Bearer ${mtToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ url: "https://example.com/test.mp4", name: "test.mp4" }),
        });
        results["content_upload_no_account"] = { status: r.status, body: await r.text() };
      } catch (e) { results["content_upload_no_account"] = { error: String(e) }; }
    }

    console.log("[discoverAdvertiserId] RESULTS:", JSON.stringify(results, null, 2));
    return results;
  },
});

// Set myTarget advertiser ID for an account
export const setAdvertiserId = mutation({
  args: {
    accountId: v.id("adAccounts"),
    mtAdvertiserId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.accountId, {
      mtAdvertiserId: args.mtAdvertiserId,
    });
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

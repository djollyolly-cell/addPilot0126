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

// Get account with userId for cross-referencing
export const getAccountForUser = internalQuery({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return null;
    return { userId: account.userId };
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

    // Determine ?account= parameter.
    // VK Ads ALWAYS sends ?account=<advertiser_id> to the proxy, even for direct advertisers.
    // Use stored mtAdvertiserId first, fall back to myTarget user ID from API.
    let accountParam: string | null = accountInfo.mtAdvertiserId || null;

    if (!accountParam) {
      try {
        const userResp = await fetch(`${MT_API_BASE}/api/v2/user.json`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (userResp.ok) {
          const userData = await userResp.json();
          accountParam = String(userData.id);
          console.log(`[video upload] Got account from user.json: ${accountParam}`);
        }
      } catch (e) {
        console.log(`[video upload] Failed to get user id: ${e}`);
      }
    }
    console.log(`[video upload] Using ?account=${accountParam}`);

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

      // Build endpoint: v3 (as used by VK Ads frontend), always include ?account=
      const endpoint = accountParam
        ? `${MT_API_BASE}/api/v3/content/video.json?account=${accountParam}`
        : `${MT_API_BASE}/api/v3/content/video.json`;
      console.log(`[video upload] Uploading ${filename} (${(fileSize / (1024*1024)).toFixed(1)} MB) to ${endpoint}`);

      // Step 1: Download file from Convex storage
      console.log(`[video upload] Step 1: downloading from storage...`);
      const dlStart = Date.now();
      const fileResponse = await fetch(fileUrl);
      if (!fileResponse.ok) throw new Error(`Не удалось скачать файл из хранилища: ${fileResponse.status}`);
      const fileBlob = await fileResponse.blob();
      console.log(`[video upload] Step 1 done: ${(fileBlob.size / (1024*1024)).toFixed(1)} MB downloaded in ${Date.now() - dlStart}ms`);

      // Step 2: Upload to myTarget API v3 (as used by VK Ads frontend)
      console.log(`[video upload] Step 2: uploading to myTarget v3...`);
      const ulStart = Date.now();
      const formData = new FormData();
      formData.append("file", fileBlob, filename);
      // Per official docs: width/height must be in a JSON "data" field
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

      const mediaId = String(uploadData.id || "");

      // Update video record with VK media ID
      await ctx.runMutation(internal.videos.updateUploadStatus, {
        id: args.videoId,
        uploadStatus: "processing",
        uploadProgress: 100,
        vkMediaId: mediaId,
        vkMediaUrl: uploadData.url || uploadData.preview_url || "",
      });

      // Post-upload verification: check that the video appears in the content listing
      if (mediaId) {
        try {
          const verifyUrl = accountParam
            ? `${MT_API_BASE}/api/v3/content/videos.json?_id=${mediaId}&account=${accountParam}`
            : `${MT_API_BASE}/api/v3/content/videos.json?_id=${mediaId}`;
          const verifyResp = await fetch(verifyUrl, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (verifyResp.ok) {
            const verifyData = await verifyResp.json();
            const found = verifyData.items?.some((v: { id: number }) => String(v.id) === mediaId);
            console.log(`[video upload] Verification: video ${mediaId} ${found ? "FOUND" : "NOT FOUND"} in content listing`);
          } else {
            console.log(`[video upload] Verification request failed: ${verifyResp.status}`);
          }
        } catch (e) {
          console.log(`[video upload] Verification check failed: ${e}`);
        }
      }

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

// DIAGNOSTIC: test which ?account= value makes video appear in correct Медиатека
export const discoverAdvertiserId = action({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const results: Record<string, any> = {};

    const accounts = await ctx.runQuery(api.adAccounts.list, {
      userId: args.userId,
    });

    if (accounts.length > 0 && accounts[0].accessToken) {
      const mtToken = accounts[0].accessToken;
      const mtAdvertiserId = accounts[0].mtAdvertiserId;
      results["account"] = { name: accounts[0].name, vkAccountId: accounts[0].vkAccountId, mtAdvertiserId };

      // 1. user.json — get myTarget user info
      try {
        const r = await fetch("https://target.my.com/api/v2/user.json", {
          headers: { Authorization: `Bearer ${mtToken}` },
        });
        results["user.json"] = await r.json();
      } catch (e) { results["user.json"] = { error: String(e) }; }

      // 2. agency/clients.json
      try {
        const r = await fetch("https://target.my.com/api/v2/agency/clients.json", {
          headers: { Authorization: `Bearer ${mtToken}` },
        });
        results["agency_clients"] = { status: r.status, body: (await r.text()).substring(0, 500) };
      } catch (e) { results["agency_clients"] = { error: String(e) }; }

      // 3. manager/clients.json
      try {
        const r = await fetch("https://target.my.com/api/v2/manager/clients.json", {
          headers: { Authorization: `Bearer ${mtToken}` },
        });
        results["manager_clients"] = { status: r.status, body: (await r.text()).substring(0, 500) };
      } catch (e) { results["manager_clients"] = { error: String(e) }; }

      // 4. List videos v2 (no ?account=)
      try {
        const r = await fetch("https://target.my.com/api/v2/content/videos.json?limit=5", {
          headers: { Authorization: `Bearer ${mtToken}` },
        });
        results["v2_videos_no_account"] = { status: r.status, body: (await r.text()).substring(0, 500) };
      } catch (e) { results["v2_videos_no_account"] = { error: String(e) }; }

      // 5. List videos v3 (no ?account=)
      try {
        const r = await fetch("https://target.my.com/api/v3/content/videos.json?limit=5", {
          headers: { Authorization: `Bearer ${mtToken}` },
        });
        results["v3_videos_no_account"] = { status: r.status, body: (await r.text()).substring(0, 500) };
      } catch (e) { results["v3_videos_no_account"] = { error: String(e) }; }

      // 6. List videos v3 WITH ?account=myTargetUserId
      const userIdFromJson = results["user.json"]?.id;
      if (userIdFromJson) {
        try {
          const r = await fetch(`https://target.my.com/api/v3/content/videos.json?limit=5&account=${userIdFromJson}`, {
            headers: { Authorization: `Bearer ${mtToken}` },
          });
          results[`v3_videos_account_userId_${userIdFromJson}`] = { status: r.status, body: (await r.text()).substring(0, 500) };
        } catch (e) { results[`v3_videos_account_userId_${userIdFromJson}`] = { error: String(e) }; }
      }

      // 7. List videos v3 WITH ?account=mtAdvertiserId (292358)
      if (mtAdvertiserId) {
        try {
          const r = await fetch(`https://target.my.com/api/v3/content/videos.json?limit=5&account=${mtAdvertiserId}`, {
            headers: { Authorization: `Bearer ${mtToken}` },
          });
          results[`v3_videos_account_mtAdv_${mtAdvertiserId}`] = { status: r.status, body: (await r.text()).substring(0, 500) };
        } catch (e) { results[`v3_videos_account_mtAdv_${mtAdvertiserId}`] = { error: String(e) }; }
      }

      // 8. Try VK API ads.getVideoUploadUrl using myTarget token
      try {
        const r = await fetch("https://api.vk.com/method/ads.getVideoUploadUrl?v=5.131", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `access_token=${mtToken}`,
        });
        results["vk_getVideoUploadUrl_mtToken"] = await r.json();
      } catch (e) { results["vk_getVideoUploadUrl_mtToken"] = { error: String(e) }; }

      // 9. Try VK API ads.getAccounts using myTarget token
      try {
        const r = await fetch("https://api.vk.com/method/ads.getAccounts?v=5.131", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `access_token=${mtToken}`,
        });
        results["vk_getAccounts_mtToken"] = await r.json();
      } catch (e) { results["vk_getAccounts_mtToken"] = { error: String(e) }; }

      // 10. Try target.vk.ru instead of target.my.com for content upload
      try {
        const r = await fetch("https://target.vk.ru/api/v3/content/videos.json?limit=3", {
          headers: { Authorization: `Bearer ${mtToken}` },
        });
        results["target_vk_ru_videos"] = { status: r.status, body: (await r.text()).substring(0, 300) };
      } catch (e) { results["target_vk_ru_videos"] = { error: String(e) }; }
    }

    // VK API ads.getAccounts
    const vkTokens = await ctx.runQuery(internal.users.getVkTokens, { userId: args.userId });
    if (vkTokens?.accessToken) {
      try {
        const r = await fetch("https://api.vk.com/method/ads.getAccounts?v=5.131", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `access_token=${vkTokens.accessToken}`,
        });
        results["vk_ads_getAccounts"] = await r.json();
      } catch (e) { results["vk_ads_getAccounts"] = { error: String(e) }; }
    } else {
      results["vk_token"] = "expired or missing";
    }

    // User record
    const user = await ctx.runQuery(internal.users.getById, { userId: args.userId });
    results["user_record"] = { vkAdsCabinetId: user?.vkAdsCabinetId || "not set" };

    console.log("[discoverAdvertiserId] RESULTS:", JSON.stringify(results, null, 2));
    return results;
  },
});

// TEMP: Test video upload/listing on multiple API domains
export const verifyVideoInVk = action({
  args: { accountId: v.id("adAccounts"), mediaId: v.string() },
  handler: async (ctx, args) => {
    const accountInfo = await ctx.runQuery(internal.adAccounts.getInternal, { accountId: args.accountId });
    if (!accountInfo?.accessToken) throw new Error("No token");
    const token = accountInfo.accessToken;
    const results: Record<string, any> = {};

    const domains = [
      { name: "target.my.com", base: "https://target.my.com" },
      { name: "target.vk.ru", base: "https://target.vk.ru" },
      { name: "target.vk.com", base: "https://target.vk.com" },
    ];

    for (const domain of domains) {
      const d: Record<string, any> = {};

      // user.json
      try {
        const r = await fetch(`${domain.base}/api/v2/user.json`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        d.user = r.status;
      } catch (e) { d.user = String(e).substring(0, 80); }

      // content/videos listing
      try {
        const r = await fetch(`${domain.base}/api/v2/content/videos.json?limit=3`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        d.videosList = { status: r.status, body: (await r.text()).substring(0, 200) };
      } catch (e) { d.videosList = String(e).substring(0, 80); }

      // content/video by ID
      try {
        const r = await fetch(`${domain.base}/api/v2/content/videos.json?_id=${args.mediaId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        d.videoById = { status: r.status, body: (await r.text()).substring(0, 200) };
      } catch (e) { d.videoById = String(e).substring(0, 80); }

      // content/statics listing
      try {
        const r = await fetch(`${domain.base}/api/v2/content/statics.json?limit=3`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        d.staticsList = { status: r.status, body: (await r.text()).substring(0, 200) };
      } catch (e) { d.staticsList = String(e).substring(0, 80); }

      results[domain.name] = d;
    }

    // Try ads.vk.com API patterns
    const adsVkTests: Record<string, any> = {};

    // ads.vk.com/api/* patterns
    const adsEndpoints = [
      "https://ads.vk.com/api/v1/me",
      "https://ads.vk.com/api/v2/me",
      "https://ads.vk.com/api/v1/media.json",
      "https://ads.vk.com/api/v2/media.json",
      "https://ads.vk.com/api/v1/creatives.json",
      "https://ads.vk.com/api/v2/creatives.json",
      "https://api.ads.vk.com/api/v1/me",
    ];
    for (const url of adsEndpoints) {
      try {
        const r = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        adsVkTests[url] = { status: r.status, body: (await r.text()).substring(0, 150) };
      } catch (e) { adsVkTests[url] = String(e).substring(0, 80); }
    }
    results["ads.vk.com"] = adsVkTests;

    console.log("[verifyVideo] RESULTS:", JSON.stringify(results, null, 2));
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

// TEMP: Diagnose VK token refresh + test video upload APIs
export const diagVkAdsApi = action({
  args: { accountId: v.id("adAccounts"), userId: v.id("users") },
  handler: async (ctx, args) => {
    const results: Record<string, any> = {};

    // 1. Check what tokens are in DB
    const vkTokens = await ctx.runQuery(internal.users.getVkTokens, { userId: args.userId });
    results["db_tokens"] = {
      hasAccessToken: !!vkTokens?.accessToken,
      hasRefreshToken: !!vkTokens?.refreshToken,
      expiresAt: vkTokens?.expiresAt ? new Date(vkTokens.expiresAt).toISOString() : "not set",
      isExpired: vkTokens?.expiresAt ? vkTokens.expiresAt < Date.now() : "unknown",
      now: new Date().toISOString(),
    };

    // 2. Try getValidVkToken (auto-refresh)
    let vkToken = "";
    try {
      vkToken = await ctx.runAction(internal.auth.getValidVkToken, { userId: args.userId });
      results["getValidVkToken"] = `OK, token=${vkToken.substring(0, 10)}...`;
    } catch (e) {
      results["getValidVkToken"] = `FAILED: ${e instanceof Error ? e.message : e}`;

      // 3. If auto-refresh failed, try manual refresh to see exact VK error
      if (vkTokens?.refreshToken) {
        const clientId = process.env.VK_CLIENT_ID;
        results["VK_CLIENT_ID"] = clientId ? `SET (${clientId})` : "NOT SET!";

        try {
          const params = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: vkTokens.refreshToken,
            client_id: clientId || "",
          });
          const resp = await fetch("https://id.vk.com/oauth2/auth", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params.toString(),
          });
          const body = await resp.text();
          results["manual_refresh"] = {
            status: resp.status,
            body: body.substring(0, 500),
          };
          // If refresh succeeded, use the new token
          try {
            const data = JSON.parse(body);
            if (data.access_token) {
              vkToken = data.access_token;
              results["manual_refresh_result"] = "GOT NEW TOKEN!";
              // Save it
              await ctx.runMutation(internal.users.updateVkTokens, {
                userId: args.userId,
                accessToken: data.access_token,
                refreshToken: data.refresh_token,
                expiresIn: data.expires_in || 0,
              });
            }
          } catch { /* parse failed, already logged body */ }
        } catch (e) {
          results["manual_refresh"] = `fetch error: ${e}`;
        }
      } else {
        results["manual_refresh"] = "SKIPPED: no refresh_token in DB";
      }

      // 4. Try using the expired access token directly anyway
      if (vkTokens?.accessToken) {
        vkToken = vkTokens.accessToken;
        results["using_expired_token"] = true;
      }
    }

    // Get myTarget token
    const accountInfo = await ctx.runQuery(internal.videos.getAccountToken, { accountId: args.accountId });
    const mtToken = accountInfo?.accessToken || "";

    // 5. Test VK API methods with whatever VK token we have
    if (vkToken) {
      // ads.getAccounts
      try {
        const r = await fetch(`https://api.vk.com/method/ads.getAccounts?v=5.131&access_token=${vkToken}`);
        const t = await r.text();
        results["vk_getAccounts"] = JSON.parse(t);
      } catch (e) { results["vk_getAccounts"] = `err: ${e}`; }

      // ads.getVideoUploadURL
      try {
        const r = await fetch(`https://api.vk.com/method/ads.getVideoUploadURL?v=5.131&access_token=${vkToken}`);
        const t = await r.text();
        results["vk_getVideoUploadURL"] = JSON.parse(t);
      } catch (e) { results["vk_getVideoUploadURL"] = `err: ${e}`; }

      // video.save
      try {
        const r = await fetch(`https://api.vk.com/method/video.save?v=5.131&access_token=${vkToken}&name=test_diag&is_private=1`);
        const t = await r.text();
        results["vk_videoSave"] = JSON.parse(t);
      } catch (e) { results["vk_videoSave"] = `err: ${e}`; }
    } else {
      results["vk_api_tests"] = "SKIPPED: no VK token available";
    }

    // 6. Test myTarget content listing (should work with mtToken)
    if (mtToken) {
      try {
        const r = await fetch("https://target.my.com/api/v2/content/videos.json?limit=3", {
          headers: { Authorization: `Bearer ${mtToken}` },
        });
        const t = await r.text();
        results["mt_videos_listing"] = { status: r.status, body: t.substring(0, 300) };
      } catch (e) { results["mt_videos_listing"] = `err: ${e}`; }
    }

    console.log("[diagVkAdsApi] Results:", JSON.stringify(results, null, 2));
    return results;
  },
});

// TEMP: Test myTarget content listing to verify uploaded videos are accessible
export const testRealUpload = action({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    const results: Record<string, unknown> = {};

    const accountInfo = await ctx.runQuery(internal.videos.getAccountToken, { accountId: args.accountId });
    const mtToken = accountInfo?.accessToken || "";
    if (!mtToken) { results["error"] = "no myTarget token"; return results; }

    const accountParam = accountInfo?.mtAdvertiserId || "292358";

    // myTarget API v2: GET /api/v2/content/video.json = list uploaded videos
    // This is the standard REST pattern: same URL for GET(list) and POST(create)
    const endpoints = [
      { name: "GET_v2_video_singular", url: `https://target.my.com/api/v2/content/video.json` },
      { name: "GET_v2_video_with_account", url: `https://target.my.com/api/v2/content/video.json?account=${accountParam}` },
      { name: "GET_v2_videos_plural", url: `https://target.my.com/api/v2/content/videos.json` },
      { name: "GET_v2_videos_with_account", url: `https://target.my.com/api/v2/content/videos.json?account=${accountParam}` },
      { name: "GET_v3_video_singular", url: `https://target.my.com/api/v3/content/video.json` },
      { name: "GET_v3_videos_plural", url: `https://target.my.com/api/v3/content/videos.json` },
    ];

    for (const ep of endpoints) {
      try {
        const resp = await fetch(ep.url, {
          headers: { Authorization: `Bearer ${mtToken}` },
        });
        const body = await resp.text();
        results[ep.name] = { status: resp.status, body: body.substring(0, 500) };
      } catch (e) {
        results[ep.name] = `err: ${e}`;
      }
    }

    console.log("[testContentListing] Results:", JSON.stringify(results, null, 2));
    return results;
  },
});

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { selectStyle } from "./bannerStyles";

// Generate banner text variants for an AI campaign
// Returns headline/subtitle/bullets (for banner image) + adTitle/adText (for VK Ads)
export const generateBannerTexts = action({
  args: {
    userId: v.id("users"),
    businessDirection: v.string(),
    objective: v.string(),
    targetUrl: v.string(),
    targetAudience: v.optional(v.string()),
    usp: v.optional(v.string()),
    context: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Check limits
    const usage = await ctx.runQuery(internal.aiLimits.getUsageInternal, {
      userId: args.userId,
      type: "text",
    });
    const user = await ctx.runQuery(internal.users.getById, { userId: args.userId });
    const tier = user?.subscriptionTier || "freemium";
    const limits: Record<string, number> = { freemium: 5, start: 50, pro: 200 };
    if (usage >= (limits[tier] || 5)) {
      throw new Error("Лимит генераций текста исчерпан. Обновите тариф.");
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY не настроен");

    // Try to fetch page content for context
    let pageContext = args.context || "";
    if (!pageContext && args.targetUrl) {
      try {
        const resp = await fetch(args.targetUrl, {
          headers: { "User-Agent": "AdPilot/1.0" },
          signal: AbortSignal.timeout(5000),
        });
        if (resp.ok) {
          const html = await resp.text();
          pageContext = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .substring(0, 1000);
        }
      } catch {
        // Ignore fetch errors
      }
    }

    const objectiveNames: Record<string, string> = {
      traffic: "Трафик на сайт",
      social: "Вступления в сообщество",
      messages: "Сообщения (лиды)",
      video_views: "Просмотры видео",
      engagement: "Продвижение поста",
    };

    const systemPrompt = "Ты — агрессивный direct-response копирайтер для VK Ads.\n" +
      "Генерируй два типа текста:\n" +
      "1. Текст НА баннере (headline, subtitle, bullets) — крупный, читается за секунду\n" +
      "2. Текст ДЛЯ VK Ads (adTitle, adText) — текст объявления в ленте\n\n" +
      "ЖЁСТКИЕ ОГРАНИЧЕНИЯ:\n" +
      "- headline: до 35 символов (заголовок НА баннере, крупный шрифт)\n" +
      "- subtitle: до 60 символов (подзаголовок НА баннере, опционально)\n" +
      "- bullets: 2-4 штуки, каждый до 40 символов (буллеты НА баннере)\n" +
      "- adTitle: СТРОГО до 25 символов (заголовок для VK Ads)\n" +
      "- adText: СТРОГО до 90 символов (текст для VK Ads)\n\n" +
      "Считай символы! Если длиннее — обрежь и перефразируй.\n\n" +
      "Бизнес: " + args.businessDirection + "\n" +
      "Цель: " + (objectiveNames[args.objective] || args.objective) + "\n" +
      "URL: " + args.targetUrl +
      (args.targetAudience ? "\nЦелевая аудитория: " + args.targetAudience : "") +
      (args.usp ? "\nУТП: " + args.usp : "") +
      (pageContext ? "\nКонтент страницы: " + pageContext : "") + "\n\n" +
      "Принципы:\n" +
      "- Бей в боль или желание ЦА\n" +
      "- Используй цифры и факты\n" +
      "- Каждое слово работает — убирай воду\n" +
      "- Пиши на русском";

    const response = await fetch(baseUrl + "/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 800,
        system: systemPrompt,
        messages: [{
          role: "user",
          content: "Сгенерируй 3 варианта баннера для A/B тестирования.\n\n" +
            "Ответ строго в JSON формате (без markdown):\n" +
            '[\n  {\n    "headline": "...",\n    "subtitle": "...",\n    "bullets": ["...", "...", "..."],\n    "adTitle": "...",\n    "adText": "..."\n  }\n]',
        }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error("Claude API error: " + response.status + " " + text);
    }

    const data = await response.json();
    const raw = data.content?.[0]?.text || "[]";

    interface BannerTextVariant {
      headline: string;
      subtitle?: string;
      bullets: string[];
      adTitle: string;
      adText: string;
    }

    let banners: BannerTextVariant[];
    try {
      const cleaned = raw.replace(/```json?\s*/g, "").replace(/```\s*/g, "").trim();
      banners = JSON.parse(cleaned);
    } catch {
      throw new Error("AI вернул некорректный формат. Попробуйте ещё раз.");
    }

    // Enforce length limits
    banners = banners.map((b: BannerTextVariant) => ({
      headline: (b.headline || "").substring(0, 35),
      subtitle: b.subtitle ? b.subtitle.substring(0, 60) : undefined,
      bullets: (b.bullets || []).slice(0, 4).map((bl: string) => bl.substring(0, 40)),
      adTitle: (b.adTitle || b.headline || "").substring(0, 25),
      adText: (b.adText || "").substring(0, 90),
    }));

    // Record usage
    await ctx.runMutation(internal.aiLimits.recordGeneration, {
      userId: args.userId,
      type: "text",
    });

    return banners;
  },
});

// Generate image for a banner using Haiku (style prompt) + FLUX Ultra
export const generateBannerImage = action({
  args: {
    userId: v.id("users"),
    businessDirection: v.string(),
    title: v.string(),
    text: v.string(),
    niche: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Check limits
    const usage = await ctx.runQuery(internal.aiLimits.getUsageInternal, {
      userId: args.userId,
      type: "image",
    });
    const user = await ctx.runQuery(internal.users.getById, { userId: args.userId });
    const tier = user?.subscriptionTier || "freemium";
    const limits: Record<string, number> = { freemium: 2, start: 20, pro: 50 };
    if (usage >= (limits[tier] || 2)) {
      throw new Error("Лимит генераций изображений исчерпан. Обновите тариф.");
    }

    const bflApiKey = process.env.BFL_API_KEY;
    if (!bflApiKey) throw new Error("BFL_API_KEY не настроен");

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY не настроен");

    // Step 1: Select style based on niche/businessDirection
    const style = selectStyle(args.niche || args.businessDirection);

    // Step 2: Generate FLUX prompt via Claude Haiku with style system prompt
    const promptResp = await fetch(baseUrl + "/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: style.systemPrompt,
        messages: [{
          role: "user",
          content: args.businessDirection + ". " + args.title + ". " + args.text,
        }],
      }),
    });

    if (!promptResp.ok) throw new Error("Ошибка генерации промпта");
    const promptData = await promptResp.json();
    const visualKeywords = promptData.content?.[0]?.text || "Professional commercial photography scene";
    const imagePrompt = visualKeywords + " " + style.suffix;

    // Step 3: Submit to FLUX Ultra (square, raw)
    const fluxResp = await fetch("https://api.bfl.ai/v1/flux-pro-1.1-ultra", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-key": bflApiKey,
      },
      body: JSON.stringify({
        prompt: imagePrompt,
        aspect_ratio: "1:1",
        raw: true,
      }),
    });

    if (!fluxResp.ok) {
      const t = await fluxResp.text();
      throw new Error("FLUX Ultra API error: " + fluxResp.status + " " + t);
    }

    const fluxData = await fluxResp.json();
    const taskId = fluxData.id;
    if (!taskId) throw new Error("FLUX не вернул task ID");

    // Step 4: Poll for result (Ultra takes ~90 sec, max 60 iterations × 3 sec = 3 min)
    let imageUrl = "";
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const pollResp = await fetch("https://api.bfl.ai/v1/get_result?id=" + taskId, {
        headers: { "x-key": bflApiKey },
      });
      if (pollResp.ok) {
        const pollData = await pollResp.json();
        if (pollData.status === "Ready" && pollData.result?.sample) {
          imageUrl = pollData.result.sample;
          break;
        }
        if (pollData.status === "Error" || pollData.status === "Failed") {
          throw new Error("FLUX генерация не удалась");
        }
      }
    }

    if (!imageUrl) throw new Error("Таймаут генерации изображения (3 мин)");

    // Step 5: Download and store in Convex
    const imgResp = await fetch(imageUrl);
    if (!imgResp.ok) throw new Error("Не удалось скачать изображение");
    const blob = await imgResp.blob();
    const storageId = await ctx.storage.store(blob);

    // Record usage
    await ctx.runMutation(internal.aiLimits.recordGeneration, {
      userId: args.userId,
      type: "image",
    });

    return { storageId, imageUrl, style: style.code };
  },
});

// Improve a single text field via AI
export const improveTextField = action({
  args: {
    userId: v.id("users"),
    businessDirection: v.string(),
    objective: v.string(),
    targetAudience: v.optional(v.string()),
    usp: v.optional(v.string()),
    field: v.union(
      v.literal("title"), v.literal("text"),
      v.literal("headline"), v.literal("subtitle"), v.literal("bullet"),
      v.literal("adTitle"), v.literal("adText")
    ),
    currentValue: v.string(),
  },
  handler: async (ctx, args) => {
    // Check limits
    const usage = await ctx.runQuery(internal.aiLimits.getUsageInternal, {
      userId: args.userId,
      type: "text",
    });
    const user = await ctx.runQuery(internal.users.getById, { userId: args.userId });
    const tier = user?.subscriptionTier || "freemium";
    const limits: Record<string, number> = { freemium: 5, start: 50, pro: 200 };
    if (usage >= (limits[tier] || 5)) {
      throw new Error("Лимит генераций текста исчерпан. Обновите тариф.");
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY не настроен");

    const fieldMap: Record<string, { maxLen: number; name: string }> = {
      title: { maxLen: 25, name: "заголовок VK Ads (title)" },
      text: { maxLen: 90, name: "текст VK Ads (text)" },
      headline: { maxLen: 35, name: "заголовок на баннере" },
      subtitle: { maxLen: 60, name: "подзаголовок на баннере" },
      bullet: { maxLen: 40, name: "буллет на баннере" },
      adTitle: { maxLen: 25, name: "заголовок VK Ads" },
      adText: { maxLen: 90, name: "текст VK Ads" },
    };

    const config = fieldMap[args.field] || { maxLen: 90, name: args.field };

    const objectiveNames: Record<string, string> = {
      traffic: "Трафик на сайт",
      social: "Вступления в сообщество",
      messages: "Сообщения (лиды)",
      video_views: "Просмотры видео",
      engagement: "Продвижение поста",
    };

    const response = await fetch(baseUrl + "/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 100,
        system: "Ты — direct-response копирайтер для VK Ads. Улучши " + config.name + ".\n" +
          "СТРОГО до " + config.maxLen + " символов. Считай символы!\n" +
          "Бизнес: " + args.businessDirection + "\n" +
          "Цель: " + (objectiveNames[args.objective] || args.objective) +
          (args.targetAudience ? "\nЦА: " + args.targetAudience : "") +
          (args.usp ? "\nУТП: " + args.usp : "") +
          "\nОтвет — ТОЛЬКО улучшенный текст, без кавычек и пояснений.",
        messages: [{
          role: "user",
          content: 'Улучши: "' + args.currentValue + '"',
        }],
      }),
    });

    if (!response.ok) {
      throw new Error("Ошибка AI улучшения текста");
    }

    const data = await response.json();
    const improved = (data.content?.[0]?.text || args.currentValue)
      .replace(/^["«]|["»]$/g, "")
      .trim()
      .substring(0, config.maxLen);

    await ctx.runMutation(internal.aiLimits.recordGeneration, {
      userId: args.userId,
      type: "text",
    });

    return improved;
  },
});

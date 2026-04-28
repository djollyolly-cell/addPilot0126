# Multi-Provider Image Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GPT Image 2 as an alternative to FLUX Ultra for banner generation, with user settings for provider and text overlay mode, plus download button on creatives.

**Architecture:** Two image generation pipelines (FLUX Ultra and GPT Image 2) selected via user settings. Both use Haiku for prompt generation but with different system prompts — short for FLUX, detailed structured for GPT Image 2. Text overlay has 3 modes: none, pillow (canvas compositor), native (GPT Image 2 renders text). Settings stored in `userSettings` table.

**Tech Stack:** Convex (backend), React + Tailwind (frontend), OpenAI Images API (`gpt-image-2`), BFL API (FLUX Ultra), Claude Haiku (prompt generation)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `convex/schema.ts` | Modify | Add `imageProvider`, `imageTextOverlay` to `userSettings`; add `imageProvider` to `creatives` |
| `convex/imageProviders.ts` | Create | Provider-specific API call functions (GPT Image 2, FLUX) |
| `convex/bannerStyles.ts` | Modify | Add `systemPromptGpt` field to each style config |
| `convex/creatives.ts` | Modify | Refactor `generateImage` to use provider selection |
| `convex/userSettings.ts` | Modify | Add `updateImageSettings` mutation |
| `src/pages/SettingsPage.tsx` | Modify | Add "Генерация изображений" tab |
| `src/components/CreativeGallery.tsx` | Modify | Add download button |
| `tests/unit/imageProviders.test.ts` | Create | Unit tests for prompt building and provider selection |

---

### Task 1: Schema — add image settings fields

**Files:**
- Modify: `convex/schema.ts:431-444` (userSettings table)
- Modify: `convex/schema.ts:511-537` (creatives table)

- [ ] **Step 1: Add fields to `userSettings` table in schema**

In `convex/schema.ts`, find the `userSettings` table definition (line ~431) and add two new optional fields before `createdAt`:

```typescript
  userSettings: defineTable({
    userId: v.id("users"),
    quietHoursEnabled: v.boolean(),
    quietHoursStart: v.optional(v.string()),
    quietHoursEnd: v.optional(v.string()),
    timezone: v.string(),
    digestEnabled: v.boolean(),
    digestTime: v.string(),
    language: v.string(),
    activeAccountId: v.optional(v.id("adAccounts")),
    imageProvider: v.optional(v.union(v.literal("gpt-image-2"), v.literal("flux"))),
    imageTextOverlay: v.optional(v.union(v.literal("none"), v.literal("pillow"), v.literal("native"))),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_userId", ["userId"]),
```

- [ ] **Step 2: Add `imageProvider` field to `creatives` table**

In `convex/schema.ts`, find the `creatives` table definition (line ~512) and add `imageProvider` field after `errorMessage`:

```typescript
    errorMessage: v.optional(v.string()),
    imageProvider: v.optional(v.union(v.literal("gpt-image-2"), v.literal("flux"))),
    orgId: v.optional(v.id("organizations")),
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: Clean output, no errors.

- [ ] **Step 4: Commit**

```bash
git add convex/schema.ts
git commit -m "feat(schema): add imageProvider and imageTextOverlay fields to userSettings and creatives"
```

---

### Task 2: Backend — `userSettings.updateImageSettings` mutation

**Files:**
- Modify: `convex/userSettings.ts`

- [ ] **Step 1: Write the `updateImageSettings` mutation**

Add at the end of `convex/userSettings.ts`:

```typescript
// Update image generation settings
export const updateImageSettings = mutation({
  args: {
    userId: v.id("users"),
    imageProvider: v.union(v.literal("gpt-image-2"), v.literal("flux")),
    imageTextOverlay: v.union(v.literal("none"), v.literal("pillow"), v.literal("native")),
  },
  handler: async (ctx, args) => {
    // Validate: "native" only with "gpt-image-2"
    if (args.imageTextOverlay === "native" && args.imageProvider === "flux") {
      throw new Error("Встроенный текст доступен только для GPT Image 2");
    }

    const settings = await ctx.db
      .query("userSettings")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();

    if (!settings) {
      await ctx.db.insert("userSettings", {
        userId: args.userId,
        quietHoursEnabled: false,
        timezone: "Europe/Moscow",
        digestEnabled: true,
        digestTime: "09:00",
        language: "ru",
        imageProvider: args.imageProvider,
        imageTextOverlay: args.imageTextOverlay,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return { success: true };
    }

    await ctx.db.patch(settings._id, {
      imageProvider: args.imageProvider,
      imageTextOverlay: args.imageTextOverlay,
      updatedAt: Date.now(),
    });

    return { success: true };
  },
});
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: Clean output.

- [ ] **Step 3: Commit**

```bash
git add convex/userSettings.ts
git commit -m "feat(userSettings): add updateImageSettings mutation"
```

---

### Task 3: Backend — GPT Image 2 system prompts in `bannerStyles.ts`

**Files:**
- Modify: `convex/bannerStyles.ts`

- [ ] **Step 1: Add `systemPromptGpt` field to `StyleConfig` interface**

In `convex/bannerStyles.ts`, update the interface (line ~4):

```typescript
export interface StyleConfig {
  code: string;
  systemPrompt: string;       // For FLUX (short 2-3 sentence output)
  systemPromptGpt: string;    // For GPT Image 2 (detailed structured output)
  suffix: string;
  nicheKeywords: string[];
}
```

- [ ] **Step 2: Add `systemPromptGpt` to CINEMATIC style**

Add after the `systemPrompt` field in the `CINEMATIC` constant:

```typescript
  systemPromptGpt: `You create detailed image prompts for GPT Image 2 to generate VK advertising banners.
Given Russian ad copy, create a dramatic cinematic metaphor for the product benefit.

Output a STRUCTURED prompt with these sections:

Scene: [Detailed scene description — specific location, objects, people, actions. Be concrete: "inside a car stuck in traffic jam" not "transportation scene"]

Camera: [Angle, perspective, distance — e.g. "from passenger seat perspective, cinematic and natural"]

Lighting: [Type, mood, shadows — e.g. "harsh sunlight, warm tones, realistic shadows, glare from sun"]

Atmosphere: [Emotional feeling — e.g. "heat, discomfort, tension. Viewer should almost feel the heat"]

Style: photorealistic, not stylized, looks like real photography (DSLR or smartphone).

Composition:
Leave clean empty space on the left or top for text overlay.
[Subject placement — e.g. "Focus on the driver on the right side of the frame"]

People rules:
- People allowed but secondary to the scene.
- From behind, side, silhouette, or far away. Always in action, never posed.
- Do NOT show faces or direct eye contact.
- People must wear plain clothes, no logos, no patches, no badges.

NO logos, NO branding, NO text, NO letters, NO UI elements.
Focus on realism and emotional impact.

Output ONLY the structured prompt in English.`,
```

- [ ] **Step 3: Add `systemPromptGpt` to LIFESTYLE_CANDID style**

```typescript
  systemPromptGpt: `You create detailed image prompts for GPT Image 2 to generate VK advertising banners.
Given Russian ad copy, create a natural, candid lifestyle scene.

Output a STRUCTURED prompt with these sections:

Scene: [Detailed real-life scene — specific person, age, appearance, what they're doing, environment. Be concrete and specific.]

Camera: [Angle, perspective — e.g. "eye level, slightly off-center, as if captured by a friend"]

Lighting: [Natural, warm, authentic — e.g. "soft window light, golden hour, indoor ambient"]

Atmosphere: [Mood — e.g. "relaxed, genuine, everyday moment captured naturally"]

Style: photorealistic, not stylized, looks like real photography. Shot on iPhone or smartphone feel. Visible skin pores, natural imperfections, no beauty filter, slight camera grain.

Composition:
Leave clean empty space on the left or top for text overlay.
[Person placement — medium shot, person occupies ~40% of frame]

People rules:
- People ARE the focus. Show them naturally in context.
- Faces and eye contact ARE allowed.
- Candid expressions, genuine emotions. No stiff poses.
- Plain clothes, no logos, no patches.

NO logos, NO branding, NO text, NO letters, NO UI elements.

Output ONLY the structured prompt in English.`,
```

- [ ] **Step 4: Add `systemPromptGpt` to PRODUCT_FOCUS style**

```typescript
  systemPromptGpt: `You create detailed image prompts for GPT Image 2 to generate VK advertising banners.
Given Russian ad copy, create a clean product-focused visual.

Output a STRUCTURED prompt with these sections:

Scene: [Product description — what it looks like, material, color, placed on what surface. Be specific.]

Camera: [Angle — e.g. "45-degree angle from above, macro detail visible"]

Lighting: [Studio quality — e.g. "clean studio lighting, soft shadows, subtle reflections on surface"]

Atmosphere: [Premium, clean, professional]

Style: photorealistic studio photography, high contrast, sharp focus on product.

Composition:
Product centered or rule-of-thirds, occupies ~40% of frame.
Leave clean empty space on the left or top for text overlay.
Dark, neutral, or contextually relevant background.

No people. No clutter. Minimal props if any.

NO logos, NO branding, NO text, NO letters, NO UI elements.

Output ONLY the structured prompt in English.`,
```

- [ ] **Step 5: Add `systemPromptGpt` to RESULT_VISUAL style**

```typescript
  systemPromptGpt: `You create detailed image prompts for GPT Image 2 to generate VK advertising banners.
Given Russian ad copy, create a visual representing the end result or transformation.

Output a STRUCTURED prompt with these sections:

Scene: [Concrete outcome visualization — achievement, transformation, milestone. Be specific: "person standing on mountain summit at sunrise" not "achievement scene"]

Camera: [Perspective — e.g. "wide shot from slightly below, emphasizing grandeur"]

Lighting: [Optimistic, energetic — e.g. "golden sunrise light, warm tones, long shadows"]

Atmosphere: [Triumph, relief, satisfaction — "the feeling of 'I made it'"]

Style: photorealistic, not stylized, looks like real photography (DSLR or smartphone).

Composition:
Leave clean empty space on the left or top for text overlay.
[Subject placement — medium or wide shot, subject ~40% of frame]

People optional. If shown, they express satisfaction, relief, or confidence.
People must wear plain clothes, no logos.

NO logos, NO branding, NO text, NO letters, NO numbers, NO UI elements.

Output ONLY the structured prompt in English.`,
```

- [ ] **Step 6: Add `systemPromptGpt` to LOCATION style**

```typescript
  systemPromptGpt: `You create detailed image prompts for GPT Image 2 to generate VK advertising banners.
Given Russian ad copy, create a recognisable location or environment visual.

Output a STRUCTURED prompt with these sections:

Scene: [Specific location — describe the place, interior/exterior, what makes it recognizable. E.g. "cozy coffee shop interior with exposed brick walls, wooden tables, warm lighting"]

Camera: [Wide or medium shot — e.g. "wide angle, slightly elevated perspective showing the full space"]

Lighting: [Atmospheric — e.g. "warm ambient lighting from pendant lamps, soft daylight from windows"]

Atmosphere: [Mood of the space — e.g. "inviting, familiar, comfortable"]

Style: photorealistic, architectural or environmental photography feel.

Composition:
Environment is the hero. Wide shot preferred.
Leave clean empty space on the left or top for text overlay.

People optional. If present, they are part of the scene, not the focus.

NO logos, NO branding, NO text, NO letters, NO signs with readable words, NO UI elements.

Output ONLY the structured prompt in English.`,
```

- [ ] **Step 7: Add `systemPromptGpt` to MINIMAL_3D style**

```typescript
  systemPromptGpt: `You create detailed image prompts for GPT Image 2 to generate VK advertising banners.
Given Russian ad copy, create a clean minimalist 3D visual.

Output a STRUCTURED prompt with these sections:

Scene: [One hero object — describe the 3D form, shape, material, color. E.g. "glossy dark blue sphere with metallic gold accents floating above a matte dark surface"]

Camera: [Clean angle — e.g. "straight on, slightly elevated, centered"]

Lighting: [Studio — e.g. "clean studio lighting, soft ambient shadows, subtle rim light on object edges"]

Atmosphere: [Premium, modern, minimal]

Style: high-quality 3D render, clean minimal aesthetic. Dark or gradient background.

Composition:
Object centered, occupies ~30% of frame. At least 40% negative space.
Leave clean space on the left or top for text overlay.

No people. No clutter. 1-2 accent colors maximum.

NO logos, NO branding, NO text, NO letters, NO UI elements.

Output ONLY the structured prompt in English.`,
```

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: Clean output.

- [ ] **Step 9: Commit**

```bash
git add convex/bannerStyles.ts
git commit -m "feat(bannerStyles): add GPT Image 2 system prompts for all 6 visual styles"
```

---

### Task 4: Backend — `imageProviders.ts` (provider API calls)

**Files:**
- Create: `convex/imageProviders.ts`

- [ ] **Step 1: Create `convex/imageProviders.ts`**

```typescript
// Image generation provider API calls
// Supports: GPT Image 2 (OpenAI) and FLUX Ultra (BFL)

/**
 * Generate image via OpenAI GPT Image 2.
 * Synchronous — returns image blob directly, no polling needed.
 */
export async function generateWithGptImage2(
  prompt: string,
  openaiApiKey: string,
  size: "1024x1024" | "1536x1024" | "1024x1536" = "1024x1024",
): Promise<Blob> {
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiApiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-image-2",
      prompt,
      size,
      quality: "high",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GPT Image 2 API error: ${response.status} ${text}`);
  }

  const data = await response.json();
  // GPT Image 2 returns base64 encoded image
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("GPT Image 2: ответ не содержит изображения");
  }

  // Convert base64 to blob
  const binaryStr = atob(b64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return new Blob([bytes], { type: "image/png" });
}

/**
 * Generate image via FLUX Ultra (BFL API).
 * Asynchronous — submits job then polls for result (~90 seconds).
 */
export async function generateWithFlux(
  prompt: string,
  bflApiKey: string,
): Promise<Blob> {
  // Submit generation request
  const submitResp = await fetch("https://api.bfl.ai/v1/flux-pro-1.1-ultra", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-key": bflApiKey,
    },
    body: JSON.stringify({
      prompt,
      aspect_ratio: "1:1",
      raw: true,
    }),
  });

  if (!submitResp.ok) {
    const text = await submitResp.text();
    throw new Error("FLUX Ultra API error: " + submitResp.status + " " + text);
  }

  const submitData = await submitResp.json();
  const taskId = submitData.id;

  // Poll for result (Ultra ~90 sec, max 60 x 3 sec = 3 min)
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const pollResp = await fetch("https://api.bfl.ai/v1/get_result?id=" + taskId, {
      headers: { "x-key": bflApiKey },
    });
    if (!pollResp.ok) continue;
    const pollData = await pollResp.json();
    if (pollData.status === "Ready") {
      const imageUrl = pollData.result?.sample;
      if (!imageUrl) throw new Error("FLUX: ответ Ready без URL изображения");
      const imgResp = await fetch(imageUrl);
      if (!imgResp.ok) throw new Error("Не удалось скачать изображение от FLUX");
      const imgBlob = await imgResp.blob();
      return new Blob([await imgBlob.arrayBuffer()], { type: imgBlob.type || "image/jpeg" });
    }
    if (pollData.status === "Error" || pollData.status === "Failed") {
      throw new Error("FLUX генерация не удалась: " + pollData.status);
    }
  }

  throw new Error("FLUX: таймаут генерации изображения (3 мин)");
}

/**
 * Build the TEXT OVERLAY block for GPT Image 2 native text rendering.
 */
export function buildTextOverlayBlock(
  headline: string,
  bullets: string,
  benefit: string,
  cta: string,
): string {
  const parts: string[] = [
    "",
    "TEXT OVERLAY (important):",
    "Add bold, clean, high-contrast Russian text in modern sans-serif font.",
    "",
  ];

  if (headline) {
    parts.push(`Main headline (large, left or top):`);
    parts.push(`"${headline}"`);
    parts.push("");
  }

  const subParts: string[] = [];
  if (bullets) subParts.push(bullets);
  if (benefit) subParts.push(benefit);
  if (subParts.length > 0) {
    parts.push(`Subheadline (medium size, below):`);
    parts.push(`"${subParts.join(". ")}"`);
    parts.push("");
  }

  if (cta) {
    parts.push(`CTA line (small, bottom):`);
    parts.push(`"${cta}"`);
    parts.push("");
  }

  parts.push("Text must be:");
  parts.push("- perfectly readable");
  parts.push("- no distortion");
  parts.push("- aligned cleanly");
  parts.push("- high contrast with background (white text on darker overlay or shadow)");

  return parts.join("\n");
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: Clean output.

- [ ] **Step 3: Commit**

```bash
git add convex/imageProviders.ts
git commit -m "feat(imageProviders): add GPT Image 2 and FLUX Ultra provider functions"
```

---

### Task 5: Backend — refactor `generateImage` in `creatives.ts`

**Files:**
- Modify: `convex/creatives.ts:225-358`

- [ ] **Step 1: Refactor `generateImage` action**

Replace the entire `generateImage` action (lines 225-358) in `convex/creatives.ts` with:

```typescript
// Generate banner image using selected provider (GPT Image 2 or FLUX Ultra)
export const generateImage = action({
  args: {
    creativeId: v.id("creatives"),
    userId: v.id("users"),
    offer: v.string(),
    bullets: v.string(),
    benefit: v.string(),
    cta: v.string(),
    businessContext: v.optional(v.string()),
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

    // Get user settings for provider choice
    const settings = await ctx.runQuery(internal.userSettings.getInternal, {
      userId: args.userId,
    });
    const provider = settings?.imageProvider || "gpt-image-2";
    const textOverlay = settings?.imageTextOverlay || "pillow";

    // Set status to generating
    await ctx.runMutation(internal.creatives.markGenerating, { id: args.creativeId });

    try {
      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      const anthropicBase = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
      if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY не настроен");

      // Step 1: Select style based on business context
      const style = selectStyle(args.businessContext || args.offer);

      // Step 2: Generate prompt via Haiku (different system prompt per provider)
      const systemPrompt = provider === "gpt-image-2"
        ? style.systemPromptGpt
        : style.systemPrompt;

      const userContent = [
        args.offer,
        args.bullets,
        args.benefit,
        args.businessContext || "",
      ].filter(Boolean).join(". ");

      const translateResp = await fetch(anthropicBase + "/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 500,
          system: systemPrompt,
          messages: [{ role: "user", content: userContent }],
        }),
      });

      let generatedPrompt = "Professional commercial photography scene";
      if (translateResp.ok) {
        const trData = await translateResp.json();
        generatedPrompt = trData.content?.[0]?.text || generatedPrompt;
      }

      // Step 3: Build final prompt
      let finalPrompt: string;
      if (provider === "flux") {
        finalPrompt = generatedPrompt + " " + style.suffix;
      } else {
        // GPT Image 2: use structured prompt as-is
        finalPrompt = generatedPrompt;
        // Add text overlay block if "native" mode
        if (textOverlay === "native") {
          const { buildTextOverlayBlock } = await import("./imageProviders");
          finalPrompt += "\n" + buildTextOverlayBlock(
            args.offer,
            args.bullets,
            args.benefit,
            args.cta,
          );
        }
      }

      // Step 4: Call provider API
      let imageBlob: Blob;
      if (provider === "gpt-image-2") {
        const openaiKey = process.env.OPENAI_API_KEY;
        if (!openaiKey) throw new Error("OPENAI_API_KEY не настроен");
        const { generateWithGptImage2 } = await import("./imageProviders");
        imageBlob = await generateWithGptImage2(finalPrompt, openaiKey, "1024x1024");
      } else {
        const bflApiKey = process.env.BFL_API_KEY;
        if (!bflApiKey) throw new Error("BFL_API_KEY не настроен");
        const { generateWithFlux } = await import("./imageProviders");
        imageBlob = await generateWithFlux(finalPrompt, bflApiKey);
      }

      // Step 5: Store image
      const storageId = await ctx.storage.store(imageBlob);

      // Save to creative (with provider info)
      await ctx.runMutation(internal.creatives.saveGeneratedImage, {
        id: args.creativeId,
        storageId,
        imageProvider: provider,
      });

      // Record usage
      await ctx.runMutation(internal.aiLimits.recordGeneration, {
        userId: args.userId,
        type: "image",
      });

    } catch (error) {
      await ctx.runMutation(internal.creatives.markFailed, {
        id: args.creativeId,
        errorMessage: error instanceof Error ? error.message : "Ошибка генерации",
      });
      throw error;
    }
  },
});
```

- [ ] **Step 2: Update `saveGeneratedImage` mutation to accept `imageProvider`**

Replace the `saveGeneratedImage` mutation (line ~98):

```typescript
// Save generated image (called internally after image generation)
export const saveGeneratedImage = internalMutation({
  args: {
    id: v.id("creatives"),
    storageId: v.id("_storage"),
    imageProvider: v.optional(v.union(v.literal("gpt-image-2"), v.literal("flux"))),
  },
  handler: async (ctx, args) => {
    const url = await ctx.storage.getUrl(args.storageId);
    await ctx.db.patch(args.id, {
      storageId: args.storageId,
      imageUrl: url ?? undefined,
      status: "ready" as const,
      imageProvider: args.imageProvider,
    });
  },
});
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: Clean output.

- [ ] **Step 4: Run tests**

Run: `npm run test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add convex/creatives.ts
git commit -m "feat(creatives): refactor generateImage to support GPT Image 2 and FLUX providers"
```

---

### Task 6: Unit tests for provider selection and prompt building

**Files:**
- Create: `tests/unit/imageProviders.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect } from "vitest";
import { buildTextOverlayBlock } from "../../convex/imageProviders";
import { selectStyle, ALL_STYLES } from "../../convex/bannerStyles";

describe("buildTextOverlayBlock", () => {
  it("includes headline, bullets, benefit, and cta", () => {
    const result = buildTextOverlayBlock(
      "Получите 300 заявок",
      "Быстро • Дёшево • Надёжно",
      "Окупаемость за 3 дня",
      "Попробовать бесплатно",
    );
    expect(result).toContain("Получите 300 заявок");
    expect(result).toContain("Быстро • Дёшево • Надёжно");
    expect(result).toContain("Окупаемость за 3 дня");
    expect(result).toContain("Попробовать бесплатно");
    expect(result).toContain("TEXT OVERLAY");
    expect(result).toContain("Main headline");
    expect(result).toContain("CTA line");
  });

  it("handles empty fields gracefully", () => {
    const result = buildTextOverlayBlock("Заголовок", "", "", "");
    expect(result).toContain("Заголовок");
    expect(result).not.toContain("Subheadline");
    expect(result).not.toContain("CTA line");
  });

  it("combines bullets and benefit in subheadline", () => {
    const result = buildTextOverlayBlock("Заголовок", "Буллет 1", "Выгода", "");
    expect(result).toContain("Буллет 1. Выгода");
  });
});

describe("bannerStyles GPT prompts", () => {
  it("all styles have systemPromptGpt field", () => {
    for (const [code, style] of Object.entries(ALL_STYLES)) {
      expect(style.systemPromptGpt, `${code} missing systemPromptGpt`).toBeTruthy();
      expect(style.systemPromptGpt.length).toBeGreaterThan(100);
    }
  });

  it("GPT prompts instruct structured output", () => {
    for (const [code, style] of Object.entries(ALL_STYLES)) {
      expect(style.systemPromptGpt, `${code} missing 'Scene:'`).toContain("Scene:");
      expect(style.systemPromptGpt, `${code} missing 'Composition'`).toContain("Composition");
    }
  });

  it("selectStyle returns style with both prompt types", () => {
    const style = selectStyle("лидогенерация для малого бизнеса");
    expect(style.code).toBe("cinematic");
    expect(style.systemPrompt).toBeTruthy();
    expect(style.systemPromptGpt).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm run test -- tests/unit/imageProviders.test.ts`
Expected: All pass.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/imageProviders.test.ts
git commit -m "test: add unit tests for image provider prompt building and style selection"
```

---

### Task 7: Frontend — Settings tab "Генерация изображений"

**Files:**
- Modify: `src/pages/SettingsPage.tsx`

- [ ] **Step 1: Add 'ai' tab to SettingsPage tabs**

In `SettingsPage.tsx`, update the `activeTab` state type (line ~60) to include `'ai'`:

```typescript
const [activeTab, setActiveTab] = useState<'profile' | 'telegram' | 'api' | 'business' | 'referral' | 'communities' | 'ai'>(initialTab as any);
```

- [ ] **Step 2: Add tab button in the nav (before closing `</nav>`)**

After the "Сообщества" button (line ~157), add:

```tsx
          <button
            data-testid="tab-ai"
            onClick={() => setActiveTab('ai')}
            className={cn(
              'pb-3 px-1 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5',
              activeTab === 'ai'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <Sparkles className="w-4 h-4" />
            AI
          </button>
```

Add `Sparkles` to the lucide-react imports at the top of the file.

- [ ] **Step 3: Add tab content routing**

In the tab content section (line ~162), update the conditional rendering. Replace the existing chain with:

```tsx
      {activeTab === 'profile' ? (
        <ProfileTab user={user} />
      ) : activeTab === 'telegram' ? (
        <TelegramTab userId={user.userId as Id<'users'>} />
      ) : activeTab === 'api' ? (
        <ApiTab userId={user.userId as Id<'users'>} />
      ) : activeTab === 'referral' ? (
        <ReferralTab userId={user.userId} />
      ) : activeTab === 'communities' ? (
        <CommunityProfilesSection />
      ) : activeTab === 'ai' ? (
        <AiSettingsTab userId={user.userId as Id<'users'>} />
      ) : (
        <BusinessTab userId={user.userId} />
      )}
```

- [ ] **Step 4: Create `AiSettingsTab` component**

Add at the bottom of `SettingsPage.tsx`, before the final export (or after the last tab component):

```tsx
function AiSettingsTab({ userId }: { userId: Id<'users'> }) {
  const settings = useQuery(api.userSettings.get, { userId });
  const updateImageSettings = useMutation(api.userSettings.updateImageSettings);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  const [provider, setProvider] = useState<'gpt-image-2' | 'flux'>('gpt-image-2');
  const [textOverlay, setTextOverlay] = useState<'none' | 'pillow' | 'native'>('pillow');

  // Sync with loaded settings
  useEffect(() => {
    if (settings) {
      setProvider((settings.imageProvider as 'gpt-image-2' | 'flux') || 'gpt-image-2');
      setTextOverlay((settings.imageTextOverlay as 'none' | 'pillow' | 'native') || 'pillow');
    }
  }, [settings]);

  // Auto-reset native to pillow when switching to FLUX
  const handleProviderChange = (val: 'gpt-image-2' | 'flux') => {
    setProvider(val);
    if (val === 'flux' && textOverlay === 'native') {
      setTextOverlay('pillow');
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateImageSettings({ userId, imageProvider: provider, imageTextOverlay: textOverlay });
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch {
      // Error shown by Convex
    } finally {
      setSaving(false);
    }
  };

  if (settings === undefined) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div data-testid="ai-settings-tab" className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Sparkles className="w-5 h-5" />
            Генерация изображений
          </CardTitle>
          <CardDescription>
            Выберите модель и режим наложения текста для генерации баннеров
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Provider selection */}
          <div className="space-y-2">
            <Label>Модель генерации</Label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => handleProviderChange('gpt-image-2')}
                className={cn(
                  'p-3 rounded-lg border text-left transition-colors',
                  provider === 'gpt-image-2'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-muted-foreground/50'
                )}
              >
                <p className="font-medium text-sm">GPT Image 2</p>
                <p className="text-xs text-muted-foreground mt-1">OpenAI, быстрая генерация</p>
              </button>
              <button
                type="button"
                onClick={() => handleProviderChange('flux')}
                className={cn(
                  'p-3 rounded-lg border text-left transition-colors',
                  provider === 'flux'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-muted-foreground/50'
                )}
              >
                <p className="font-medium text-sm">FLUX Ultra</p>
                <p className="text-xs text-muted-foreground mt-1">BFL, детальная фотография</p>
              </button>
            </div>
          </div>

          {/* Text overlay selection */}
          <div className="space-y-2">
            <Label>Текст на баннере</Label>
            <div className="space-y-2">
              <label className="flex items-start gap-3 p-3 rounded-lg border border-border hover:border-muted-foreground/50 cursor-pointer transition-colors">
                <input
                  type="radio"
                  name="textOverlay"
                  checked={textOverlay === 'none'}
                  onChange={() => setTextOverlay('none')}
                  className="mt-0.5"
                />
                <div>
                  <p className="text-sm font-medium">Без текста</p>
                  <p className="text-xs text-muted-foreground">Чистое изображение без надписей</p>
                </div>
              </label>
              <label className="flex items-start gap-3 p-3 rounded-lg border border-border hover:border-muted-foreground/50 cursor-pointer transition-colors">
                <input
                  type="radio"
                  name="textOverlay"
                  checked={textOverlay === 'pillow'}
                  onChange={() => setTextOverlay('pillow')}
                  className="mt-0.5"
                />
                <div>
                  <p className="text-sm font-medium">Наложение текста</p>
                  <p className="text-xs text-muted-foreground">Текст накладывается поверх изображения программно</p>
                </div>
              </label>
              <label className={cn(
                "flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
                provider === 'flux'
                  ? 'border-border opacity-50 cursor-not-allowed'
                  : 'border-border hover:border-muted-foreground/50'
              )}>
                <input
                  type="radio"
                  name="textOverlay"
                  checked={textOverlay === 'native'}
                  onChange={() => setTextOverlay('native')}
                  disabled={provider === 'flux'}
                  className="mt-0.5"
                />
                <div>
                  <p className="text-sm font-medium">Встроенный в изображение</p>
                  <p className="text-xs text-muted-foreground">
                    GPT Image 2 рендерит текст прямо на картинке
                    {provider === 'flux' && ' (недоступно для FLUX)'}
                  </p>
                </div>
              </label>
            </div>
          </div>

          {/* Save button */}
          <div className="flex items-center gap-3">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Сохранение...</>
              ) : (
                'Сохранить'
              )}
            </Button>
            {success && (
              <span className="text-sm text-green-600 dark:text-green-400">Настройки сохранены</span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 5: Verify imports**

Make sure `Sparkles` is imported from `lucide-react` and `useEffect` from `react` at the top of the file. The file already imports `useState`, `useQuery`, `useMutation`, `Card`, `CardContent`, `CardHeader`, `CardTitle`, `CardDescription`, `Label`, `Button`, `Loader2`, `cn`, `Id`, so those are covered.

- [ ] **Step 6: Typecheck and build**

Run: `npx tsc --noEmit` and `npm run build`
Expected: Clean output.

- [ ] **Step 7: Commit**

```bash
git add src/pages/SettingsPage.tsx
git commit -m "feat(settings): add AI image generation settings tab"
```

---

### Task 8: Frontend — download button on creative cards

**Files:**
- Modify: `src/components/CreativeGallery.tsx`

- [ ] **Step 1: Add Download icon import**

Update imports at the top of `CreativeGallery.tsx`:

```typescript
import { Trash2, Loader2, AlertCircle, ImageIcon, Download } from 'lucide-react';
```

- [ ] **Step 2: Add download button in the footer section**

In the footer `div` (line ~88), add a download button next to the delete button. Replace the footer section:

```tsx
            {/* Footer */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <StatusBadge status={creative.status} />
                <span className="text-xs text-muted-foreground">
                  {formatRelativeTime(creative.createdAt)}
                </span>
              </div>
              <div className="flex items-center gap-1">
                {creative.status === 'ready' && creative.imageUrl && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-primary"
                    onClick={() => handleDownload(creative.imageUrl!, creative._id)}
                    data-testid={`download-creative-${creative._id}`}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  onClick={() => onDelete(creative._id)}
                  disabled={deleting === creative._id}
                >
                  {deleting === creative._id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
```

- [ ] **Step 3: Add download handler function**

Add this function inside the `CreativeGallery` component, before the return statement:

```typescript
  const handleDownload = async (url: string, id: string) => {
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `creative-${id}.jpg`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
    } catch {
      // Fallback: open in new tab
      window.open(url, '_blank');
    }
  };
```

- [ ] **Step 4: Build check**

Run: `npm run build`
Expected: Clean output.

- [ ] **Step 5: Commit**

```bash
git add src/components/CreativeGallery.tsx
git commit -m "feat(creatives): add download button to creative cards"
```

---

### Task 9: Final integration check

- [ ] **Step 1: Full typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: Clean output.

- [ ] **Step 2: Run all tests**

Run: `npm run test`
Expected: All tests pass.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: Clean output.

- [ ] **Step 4: Verify data chain**

Verify the full chain manually:
1. `schema.ts` has `imageProvider` and `imageTextOverlay` in `userSettings`
2. `userSettings.ts` has `updateImageSettings` mutation
3. `bannerStyles.ts` has `systemPromptGpt` on all 6 styles
4. `imageProviders.ts` exports `generateWithGptImage2`, `generateWithFlux`, `buildTextOverlayBlock`
5. `creatives.ts` `generateImage` reads settings and routes to correct provider
6. `creatives.ts` `saveGeneratedImage` accepts `imageProvider` arg
7. `SettingsPage.tsx` has `AiSettingsTab` that calls `updateImageSettings`
8. `CreativeGallery.tsx` has download button

- [ ] **Step 5: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "feat: multi-provider image generation (GPT Image 2 + FLUX Ultra)"
```

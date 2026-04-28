# Multi-Provider Image Generation Design

## Summary

Add GPT Image 2 (`gpt-image-2`) as an alternative image generation provider alongside existing FLUX Ultra. Users choose provider and text overlay mode in Settings. GPT Image 2 becomes the default for new users.

## Current State

- `convex/creatives.ts` → `generateImage` action: Haiku generates FLUX prompt → FLUX Ultra (BFL API, polling) renders background → stored in Convex
- `convex/bannerStyles.ts` → 6 visual styles with system prompts for Haiku, niche-to-style mapping
- Python script `.cursor/skills/vk-banner/scripts/banner_pipeline.py` → standalone pipeline with Pillow text overlay (not in production Convex flow)
- Text overlay (Pillow) is NOT used in production — Convex `generateImage` stores raw FLUX output
- Env vars: `BFL_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (already exists for Whisper)

## Architecture

### Two Pipelines

| Step | FLUX Ultra | GPT Image 2 |
|---|---|---|
| 1. Prompt | Haiku → short FLUX prompt (2-3 sentences) | Haiku → detailed structured prompt (Scene/Camera/Lighting/Atmosphere/Style/Composition + optional TEXT OVERLAY) |
| 2. Render | BFL API, polling (~90s) | OpenAI Images API, sync |
| 3. Text | Pillow overlay or none | Pillow overlay / native in image / none |
| Env | `BFL_API_KEY` + `ANTHROPIC_API_KEY` | `OPENAI_API_KEY` + `ANTHROPIC_API_KEY` |
| Cost | ~$0.067/banner | ~$0.02-0.08/banner (size-dependent) |

### Text Overlay Modes

| Mode | Value | Description | Available for |
|---|---|---|---|
| No text | `"none"` | Clean image, no text at all | FLUX, GPT Image 2 |
| Pillow overlay | `"pillow"` (default) | Image without text, Pillow composites headline/bullets/cta | FLUX, GPT Image 2 |
| Native text | `"native"` | GPT Image 2 renders text directly on image via prompt | GPT Image 2 only |

## Data Changes

### `userSettings` table — 2 new optional fields

```typescript
imageProvider: v.optional(v.union(v.literal("gpt-image-2"), v.literal("flux"))),
// Default: "gpt-image-2"

imageTextOverlay: v.optional(v.union(v.literal("none"), v.literal("pillow"), v.literal("native"))),
// Default: "pillow"
// "native" only valid when imageProvider === "gpt-image-2"
```

No schema migration needed — fields are optional with code-level defaults.

### `creatives` table — 1 new optional field

```typescript
imageProvider: v.optional(v.union(v.literal("gpt-image-2"), v.literal("flux"))),
// Records which provider was used for this creative (for diagnostics)
```

## Backend Changes

### New: `convex/imageProviders.ts`

Encapsulates provider-specific API calls:

```typescript
// GPT Image 2 via OpenAI Images API
export async function generateWithGptImage2(prompt: string, size: string): Promise<Blob>
// - Calls POST https://api.openai.com/v1/images/generations
// - model: "gpt-image-2"
// - size: "1024x1024" (square format)
// - Returns image blob directly (no polling)

// FLUX Ultra via BFL API (extracted from current creatives.ts)
export async function generateWithFlux(prompt: string): Promise<Blob>
// - Current FLUX code moved here
// - BFL API with polling
// - aspect_ratio: "1:1", raw: true
```

### Modified: `convex/bannerStyles.ts`

Add GPT Image 2 system prompts alongside existing FLUX prompts. Each style gets a second prompt template that instructs Haiku to output a structured format:

```
Scene: [detailed scene description]
Camera: [angle, perspective]
Lighting: [type, mood]
Atmosphere: [feeling, tension]
Style: photorealistic, not stylized, looks like real photography (DSLR or smartphone).
Composition: [subject placement, space for text]
```

For "native" text overlay mode, Haiku also generates a TEXT OVERLAY section:

```
TEXT OVERLAY (important):
Add bold, clean, high-contrast Russian text in modern sans-serif font.
Main headline (large, left or top): "[headline]"
Subheadline (medium size, below): "[bullets/benefit]"
CTA line (small, bottom): "[cta]"
Text must be: perfectly readable, no distortion, aligned cleanly, high contrast with background (white text on darker overlay or shadow).
NO logos, NO branding.
```

Structure per style:
```typescript
export interface StyleConfig {
  code: string;
  systemPrompt: string;       // existing: for FLUX (short output)
  systemPromptGpt: string;    // new: for GPT Image 2 (structured output)
  suffix: string;             // existing: appended to FLUX prompt
  nicheKeywords: string[];
}
```

### Modified: `convex/creatives.ts` → `generateImage`

Refactored flow:

1. Read `userSettings` for `imageProvider` and `imageTextOverlay`
2. Select style via `selectStyle(businessContext)` (unchanged)
3. Call Haiku with appropriate system prompt:
   - FLUX provider → `style.systemPrompt` (current behavior)
   - GPT Image 2 → `style.systemPromptGpt`
4. If `imageTextOverlay === "native"` and provider is `gpt-image-2`:
   - Append TEXT OVERLAY block to prompt with actual headline/bullets/cta
5. Call provider API:
   - FLUX → `generateWithFlux(prompt)`
   - GPT Image 2 → `generateWithGptImage2(prompt, "1024x1024")`
6. Store result in Convex storage
7. Save `imageProvider` field on creative record

Args change: add optional `textOverlay` mode (read from settings, but could be overridden per-call in future).

### Modified: `convex/userSettings.ts`

Add mutation to update image generation settings:

```typescript
export const updateImageSettings = mutation({
  args: {
    userId: v.id("users"),
    imageProvider: v.optional(v.union(v.literal("gpt-image-2"), v.literal("flux"))),
    imageTextOverlay: v.optional(v.union(v.literal("none"), v.literal("pillow"), v.literal("native"))),
  },
  handler: async (ctx, args) => {
    // Validate: "native" only with "gpt-image-2"
    if (args.imageTextOverlay === "native" && args.imageProvider === "flux") {
      throw new Error("Нативный текст доступен только для GPT Image 2");
    }
    // ... patch userSettings
  },
});
```

## Frontend Changes

### `/settings` page — new section "Генерация изображений"

Below existing settings sections:

```
Генерация изображений
---------------------
Модель генерации:    [GPT Image 2 v]  / [FLUX Ultra]
Текст на баннере:    [Без текста] / [Наложение (Pillow)] / [Встроенный в изображение]
                     ^^ "Встроенный" disabled when FLUX selected
```

- Select for provider (2 options)
- Select for text overlay (3 options, "native" disabled when provider is FLUX)
- Save via `updateImageSettings` mutation

### `/creatives` page — download button

Add download button on each creative card (when status === "ready"):

- Icon: `Download` from lucide-react
- Click → triggers browser download of `imageUrl` with filename `creative-{id}.jpg`
- Uses `<a href={imageUrl} download>` or fetch + blob approach

### No other UI changes

CreativesPage generate flow stays the same — settings are read from backend automatically.

## Defaults

| Setting | Default | Reason |
|---|---|---|
| `imageProvider` | `"gpt-image-2"` | Newer, simpler API, no polling |
| `imageTextOverlay` | `"pillow"` | Safest for VK moderation (coverage check), consistent rendering |

## Validation Rules

- `imageTextOverlay === "native"` requires `imageProvider === "gpt-image-2"` — enforce in mutation and UI
- If user switches from GPT Image 2 to FLUX while `imageTextOverlay === "native"`, auto-reset to `"pillow"`

## Files Changed

| File | Change |
|---|---|
| `convex/schema.ts` | Add 2 fields to `userSettings`, 1 field to `creatives` |
| `convex/imageProviders.ts` | **New** — provider API calls (GPT Image 2 + FLUX extracted) |
| `convex/bannerStyles.ts` | Add `systemPromptGpt` to each style |
| `convex/creatives.ts` | Refactor `generateImage` to use provider selection |
| `convex/userSettings.ts` | Add `updateImageSettings` mutation |
| `src/pages/SettingsPage.tsx` | Add "Генерация изображений" section |
| `src/pages/CreativesPage.tsx` | Add download button on creative cards |

## What Does NOT Change

- `bannerStyles.ts` niche-to-style mapping logic
- `aiLimits.ts` generation limits (same limits regardless of provider)
- Python standalone script (`banner_pipeline.py`)
- Cron cleanup of expired creatives
- FLUX API key and BFL integration code (preserved, moved to `imageProviders.ts`)

## GPT Image 2 API Call Reference

```typescript
const response = await fetch("https://api.openai.com/v1/images/generations", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${openaiApiKey}`,
  },
  body: JSON.stringify({
    model: "gpt-image-2",
    prompt: fullPrompt,
    size: "1024x1024",
    quality: "high",
  }),
});
// Response contains base64 image data or URL
```

## GPT Image 2 Prompt Structure (example)

Generated by Haiku with `systemPromptGpt`:

```
Scene: inside a car stuck in a heavy traffic jam in a Russian city, hot summer day, +30C.
A 30-45 year old male driver, sweating heavily, wiping his forehead, looking tired and uncomfortable.

Camera: from passenger seat perspective, cinematic and natural.

Outside the windshield: dense traffic, cars bumper-to-bumper, strong sunlight, heat haze.

Lighting: harsh sunlight, warm tones, realistic shadows, glare from sun.
Atmosphere: heat, discomfort, tension.

Style: photorealistic, not stylized, looks like real photography (DSLR or smartphone).

Composition:
Leave clean empty space on the left or top for text overlay.
Focus on the driver on the right side of the frame.

NO logos, NO branding.
Focus on realism, discomfort, and emotional impact.
```

For "native" text overlay, Haiku appends:

```
TEXT OVERLAY (important):
Add bold, clean, high-contrast Russian text in modern sans-serif font.

Main headline (large, left or top):
"+30. Пробка. Кондиционер не работает."

Subheadline (medium size, below):
"Сейчас: 1500-3000 Р. Потом: до 20 000 Р"

CTA line (small, bottom):
"Сделай сейчас - потом поздно"

Text must be:
- perfectly readable
- no distortion
- aligned cleanly
- high contrast with background (white text on darker overlay or shadow)
```

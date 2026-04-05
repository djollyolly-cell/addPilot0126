---
name: vk-banner
description: Generate VK ad banners by creating a FLUX background prompt via Claude Haiku, compositing headline/subtitle/bullets with Pillow, enforcing <=18% text coverage, and auto-fitting. Use when asked to create, render, or assemble a VK banner with text over an AI-generated background.
---

# VK Banner Generation

Use this skill when the user asks to generate a VK banner (link post, square feed post, or stories) with text overlay on top of an AI-generated background.

## What the user provides
- `headline` (string): main title rendered on the banner
- `subtitle` (string | empty): secondary line rendered on the banner
- `bullets` (array of strings, up to 5): bullet points rendered on the banner
- `offer_context` (string): context for Claude Haiku scene generation only (never rendered as text)
- `niche` (string): used to pick the visual style (lifestyle, product, cinematic, etc.)
- `banner_format` (string): `link` (1200x628), `square` (1080x1080), or `stories` (1080x1920)
- Optional:
  - `style_override` (one of `lifestyle_candid`, `product_focus`, `result_visual`, `location`, `cinematic`, `minimal_3d`)
  - `layout_override` (one of `bottom_left`, `left_half`, `top_left`, `card_overlay`, `center`)

## Pipeline (full end-to-end)
1. Select visual style from `niche` (or apply `style_override`).
2. Ask Claude Haiku for a FLUX-ready background prompt:
   - uses `offer_context` + the ad text (`headline`, `subtitle`, `bullets`)
   - prompt must contain: darker text zone in the target area
   - prompt must NOT include any text/logos/UI
3. Render the FLUX background (no text on it).
4. Composite text layers (headline/subtitle/bullets) with Python/Pillow:
   - safe padding: 60px
   - gradient/dark overlay in the text zone (layout-aware)
   - headline plaque behind the headline for readability
5. Enforce VK text coverage rule:
   - VK official limit is 20%
   - this pipeline enforces `<= 18%` with a conservative buffer
6. If coverage is too high, auto-fit:
   - reduce font sizes
   - remove the last bullet
   - optionally remove subtitle
   - truncate headline if needed

## Runnable code
The skill includes a ready-to-run Python script:

- `scripts/banner_pipeline.py`

It can be executed by the agent (or locally) to produce `output` image and print a JSON report to stdout.

## Required environment variables (recommended)
- `ANTHROPIC_API_KEY`
- `FLUX_API_KEY`

## Example CLI invocation
```bash
python3 scripts/banner_pipeline.py \
  --headline "Получите 300 заявок за 30 дней" \
  --subtitle "Автоматизированная воронка продаж под ключ" \
  --bullets '["Настройка за 3 дня","Гарантия результата","Оплата после первых заявок"]' \
  --offer_context "Агентство лидогенерации для малого бизнеса" \
  --niche "лидогенерация" \
  --banner_format link \
  --output output/banner_link.jpg
```


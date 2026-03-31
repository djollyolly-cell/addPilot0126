---
name: vk-banner
description: Use this skill whenever you need to generate advertising banners for VKontakte (VK). Covers the full pipeline: generating a FLUX background prompt via Claude Haiku (with niche-appropriate visual style), compositing text layers (headline, subtitle, bullets) onto the image using Python/Pillow, and enforcing the 18% text coverage rule. Use when asked to create, render, or assemble a VK ad banner with text overlaid on an AI-generated background.
---

# VK Banner Generation Skill

## Overview

Full pipeline for creating VK ad banners:
1. Service passes: headline, subtitle, bullets, niche, offer_context
2. Claude Haiku selects visual style based on niche, uses offer_context to generate a FLUX image prompt
3. FLUX renders the background (no text in image)
4. Python compositor overlays headline, subtitle, bullets
5. Text coverage checker enforces <=18% rule (VK official limit is 20%; we use 18% as a safe buffer)
6. Auto-fit reduces text if limit exceeded

**Key distinction**: offer_context is context for Haiku only (never rendered). headline/subtitle/bullets are text rendered on the banner.

## Dependencies

```bash
pip install Pillow requests --break-system-packages
```

No custom fonts required — uses system fonts with fallback chain.

---

## VK Banner Specifications

| Format | Size | Use case |
|---|---|---|
| Link post | 1200×628 | Ads with external link |
| Square | 1080×1080 | Feed post, carousel |
| Stories | 1080×1920 | Stories ads |

**Safe zone**: 60px padding on all sides. Never place text outside this zone.

**Text zone**: Bottom 38% of banner height. FLUX prompt must generate darker area here.

---

## Visual Style System

VK audience dislikes glossy Instagram-style visuals and heavy design. The most effective creatives feel natural, direct, and contextually relevant. Style must be chosen based on niche — not applied universally.

### 6 Visual Styles

| Style | Code | Best for | What FLUX generates |
|---|---|---|---|
| Lifestyle candid | `lifestyle_candid` | B2C services, fitness, beauty, food, education | Real person in a natural situation using the product. Candid feel, not posed. Faces and direct eye contact allowed. |
| Product focus | `product_focus` | E-commerce, goods, tech, gadgets | Product large and sharp, neutral or dark background, studio or natural light. No clutter. |
| Result visual | `result_visual` | Education, coaching, finance, weight loss | Visual representation of the outcome: achievement, transformation, a concrete number or milestone. |
| Location | `location` | Local business, real estate, restaurants, events | Recognisable environment or place associated with the niche. Creates "I know this place" effect. |
| Cinematic | `cinematic` | B2B, digital services, SaaS, finance, lead gen | Dramatic metaphorical scene representing the core benefit. High contrast, dark background, volumetric light. |
| Minimal 3D | `minimal_3d` | Tech, apps, abstract services, premium products | Clean 3D object or abstract form on a minimal background. No clutter, strong negative space. |

### Niche → Style Mapping

Use this table as the default. Override only when the client specifies otherwise.

| Niche | Primary style | Secondary style |
|---|---|---|
| Fitness, sport, health | `lifestyle_candid` | `result_visual` |
| Beauty, cosmetics | `lifestyle_candid` | `product_focus` |
| Food, restaurants, delivery | `lifestyle_candid` | `location` |
| Education, courses, coaching | `result_visual` | `lifestyle_candid` |
| Finance, investments | `cinematic` | `result_visual` |
| Lead generation, marketing | `cinematic` | `minimal_3d` |
| B2B, SaaS, digital services | `minimal_3d` | `cinematic` |
| E-commerce, goods | `product_focus` | `lifestyle_candid` |
| Real estate | `location` | `lifestyle_candid` |
| Local business | `location` | `lifestyle_candid` |
| Events, entertainment | `lifestyle_candid` | `location` |

---

## Input Data: offer_context

`offer_context` is the primary source of meaning for Haiku. The richer it is, the more accurate and relevant the generated visual will be. It is separate from the text that appears on the banner — it is context passed to Haiku only, never rendered on the image.

### What to put in offer_context

Include any combination of the following. More detail = better visual:

| Field | Description | Example |
|---|---|---|
| Product / service | What exactly is being sold | "Automated lead generation funnel" |
| Target audience | Who sees this ad | "SMB owners 30–50 years old" |
| Core pain | Problem the product solves | "No stable flow of new clients" |
| Core benefit | Main result the client gets | "200–400 applications per month, guaranteed" |
| Tone / mood | How the brand wants to feel | "Confident, results-oriented, no fluff" |
| Context / trigger | When/why the person needs this | "Business is stagnating, tired of cold outreach" |

None of these fields are mandatory — even a single sentence works. But a richer context produces a more targeted visual.

### Minimal input (works, but generic visual)

```python
offer_context = "Агентство лидогенерации для малого бизнеса"
```

### Recommended input (produces accurate, niche visual)

```python
offer_context = (
    "Агентство лидогенерации для малого бизнеса. "
    "Целевая аудитория: владельцы бизнеса 30-50 лет. "
    "Боль: нет стабильного потока клиентов, устали от сарафанного радио. "
    "Решение: автоматизированная воронка с гарантией заявок за 30 дней. "
    "Тон: уверенный, конкретный, без воды."
)
```

### Full input (best results)

```python
offer_context = (
    "Продукт: онлайн-курс по таргетированной рекламе в ВК для начинающих. "
    "Аудитория: фрилансеры и начинающие маркетологи 20-35 лет. "
    "Боль: не могут найти клиентов, не знают с чего начать, боятся слить бюджет. "
    "Результат: первый оплачиваемый клиент за 30 дней после курса. "
    "Формат: 6 недель, практические задания, обратная связь от наставника. "
    "Тон: поддерживающий, практичный, без обещаний миллионов."
)
```

### What offer_context does NOT affect

- Text rendered on the banner (headline, subtitle, bullets come separately)
- Visual style selection (controlled by `niche` field)
- Text coverage calculation

offer_context feeds only into Haiku's scene generation. It is never shown to the user.

---

## Step 1 — Generate FLUX Prompt (Claude Haiku)

Haiku receives the ad copy, offer_context, and visual style, returns a FLUX-ready scene description.

```python
STYLE_PROMPTS = {

    "lifestyle_candid": """
You create image prompts for VK advertising banners.
Given Russian ad copy, create a natural, candid lifestyle scene.

People rules:
- People ARE the focus. Show them naturally in context of using the product or service.
- Faces looking at camera ARE allowed and work well in VK.
- Candid expressions, genuine emotions. No stiff poses.
- Show real situations: at a desk, in a gym, in a cafe, with a product in hand.
- Avoid stock photo cliches: no thumbs up, no forced smiles at nothing.

Visual rules:
- Natural, warm, authentic lighting. Not overly dramatic.
- Background contextually relevant but not distracting (slightly blurred).
- Colors vibrant but realistic, not cinematic color grading.
- Bottom 38% of image noticeably darker for text overlay.
- NEVER include: text, letters, logos, UI, screens, charts, icons.

Output ONLY the prompt (2-3 sentences).
""",

    "product_focus": """
You create image prompts for VK advertising banners.
Given Russian ad copy, create a clean product-focused visual.

Visual rules:
- The product is the hero: large, sharp, well-lit, centered or rule-of-thirds.
- Background: dark, neutral, or contextually relevant surface (marble, wood, concrete).
- Lighting: studio-quality. Clear reflections or shadows that add depth.
- No people. No clutter. Minimal props if any.
- Colors: product real colors should pop. High contrast with background.
- Bottom 38% of image noticeably darker for text overlay.
- NEVER include: text, letters, logos, UI, screens, charts, icons.

Output ONLY the prompt (2-3 sentences).
""",

    "result_visual": """
You create image prompts for VK advertising banners.
Given Russian ad copy, create a visual that represents the end result or transformation.

Visual rules:
- Show the OUTCOME, not the process: achievement, success, transformation, a milestone reached.
- Can be metaphorical: a mountain summit, a finish line, a before/after expressed through light,
  a person expressing relief or confidence after completing something hard.
- People optional. If shown, they express satisfaction, relief, or confidence.
- Dramatic but clear. The feeling of "I got there" should be immediate.
- Colors: optimistic, energetic. Warm tones for personal achievement, cool/bold for business results.
- Bottom 38% of image noticeably darker for text overlay.
- NEVER include: text, letters, numbers, logos, UI, screens, charts with labels, icons.

Output ONLY the prompt (2-3 sentences).
""",

    "location": """
You create image prompts for VK advertising banners.
Given Russian ad copy, create a recognisable location or environment visual.

Visual rules:
- Show a place the target audience knows and relates to: a neighbourhood, interior, city, venue type.
- The location should immediately signal the niche: a gym interior, a cozy cafe, a business district,
  a residential area, a construction site, a school classroom.
- Atmosphere is key: time of day, weather, mood of the space.
- People optional. If present, they are part of the scene, not the focus.
- Bottom 38% of image noticeably darker for text overlay.
- NEVER include: text, letters, logos, UI, screens, signs with readable words, icons.

Output ONLY the prompt (2-3 sentences).
""",

    "cinematic": """
You create image prompts for VK advertising banners.
Given Russian ad copy, create a dramatic cinematic metaphor for the product benefit.

Examples of metaphors:
- Lead generation -> powerful magnet pulling golden coins from dark misty air, volumetric light
- Growth/scaling -> rocket launching from a launchpad, trail of fire, dramatic dusk sky
- Speed/efficiency -> sleek sports car in motion blur on empty highway at sunset
- Marketing -> giant bullseye target with arrow in center, sparks flying, epic lighting
- Education -> person from behind looking at a vast library, warm golden light flooding in

People rules:
- People allowed but secondary to the scene.
- From behind, side, silhouette, or far away. Always in action, never posed.
- Do NOT show faces or direct eye contact in cinematic style.

Visual rules:
- Bold saturated colors, very high contrast, dark or blurred backgrounds.
- Dramatic lighting: volumetric light, rim light, golden hour, or deep shadows.
- Cinematic photography or high-quality 3D render style.
- Bottom 38% of image significantly darker for text overlay.
- NEVER include: text, letters, words, logos, screens, phones, UI, charts, icons.

Output ONLY the prompt (2-3 sentences).
""",

    "minimal_3d": """
You create image prompts for VK advertising banners.
Given Russian ad copy, create a clean minimalist 3D visual.

Visual rules:
- One hero object: abstract 3D form, geometric shape, or stylised product representation.
- Plenty of negative space around the object, at least 40% empty.
- Background: solid dark, gradient dark, or very softly lit neutral surface.
- Lighting: clean studio or subtle ambient. Soft shadows. No dramatic rays.
- Colors: 1-2 accent colors maximum. The object should feel premium and modern.
- No people. No clutter. Nothing competing with the main object.
- Bottom 38% of image noticeably darker for text overlay.
- NEVER include: text, letters, logos, UI, screens, charts, icons.

Output ONLY the prompt (2-3 sentences).
"""
}

FLUX_SUFFIX = (
    "Professional commercial photography or high-quality 3D render. "
    "Bottom area significantly darker for text overlay. "
    "No text, no letters, no words, no watermarks, no logos, no UI elements."
)


def select_visual_style(niche: str, style_override: str = None) -> str:
    """Select visual style based on niche keyword matching. Returns style code."""
    if style_override and style_override in STYLE_PROMPTS:
        return style_override

    NICHE_MAP = {
        "фитнес": "lifestyle_candid", "спорт": "lifestyle_candid",
        "красота": "lifestyle_candid", "косметика": "lifestyle_candid",
        "еда": "lifestyle_candid", "ресторан": "lifestyle_candid",
        "доставка": "lifestyle_candid", "кафе": "lifestyle_candid",
        "мероприятие": "lifestyle_candid", "ивент": "lifestyle_candid",
        "товар": "product_focus", "интернет-магазин": "product_focus",
        "гаджет": "product_focus", "электроника": "product_focus",
        "одежда": "product_focus",
        "обучение": "result_visual", "курс": "result_visual",
        "коучинг": "result_visual", "похудение": "result_visual",
        "инвестиции": "result_visual",
        "недвижимость": "location", "аренда": "location",
        "локальный": "location",
        "лидогенерация": "cinematic", "маркетинг": "cinematic",
        "реклама": "cinematic", "финансы": "cinematic",
        "кредит": "cinematic", "страхование": "cinematic",
        "saas": "minimal_3d", "приложение": "minimal_3d",
        "сервис": "minimal_3d", "b2b": "minimal_3d",
        "it": "minimal_3d", "разработка": "minimal_3d",
    }

    niche_lower = niche.lower()
    for keyword, style in NICHE_MAP.items():
        if keyword in niche_lower:
            return style

    return "cinematic"  # Default fallback


def generate_flux_prompt(
    headline: str,
    subtitle: str,
    bullets: list[str],
    offer_context: str,
    niche: str,
    client,
    style_override: str = None
) -> tuple[str, str]:
    """Returns (flux_prompt, style_used)."""
    style = select_visual_style(niche, style_override)
    system_prompt = STYLE_PROMPTS[style]

    user_msg = f"{offer_context}. {headline}."
    if subtitle:
        user_msg += f" {subtitle}."
    if bullets:
        user_msg += f" {'. '.join(bullets)}."

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=300,
        system=system_prompt,
        messages=[{"role": "user", "content": user_msg}]
    )
    visual_keywords = response.content[0].text.strip()
    flux_prompt = f"{visual_keywords} {FLUX_SUFFIX}"
    return flux_prompt, style
```

---

## Step 2 — Call FLUX API

```python
import requests
import time

def generate_background(flux_prompt: str, width: int, height: int, flux_api_key: str) -> bytes:
    """
    Call FLUX API and return image bytes.
    Adjust endpoint/payload to your FLUX provider (BFL, fal.ai, Replicate, etc.)
    """
    headers = {
        "x-key": flux_api_key,
        "Content-Type": "application/json"
    }
    payload = {
        "prompt": flux_prompt,
        "width": width,
        "height": height,
        "steps": 28,
        "guidance": 3.5,
        "output_format": "jpeg"
    }

    resp = requests.post(
        "https://api.bfl.ml/v1/flux-pro-1.1",
        json=payload,
        headers=headers
    )
    resp.raise_for_status()
    request_id = resp.json()["id"]

    for _ in range(60):
        time.sleep(2)
        poll = requests.get(
            "https://api.bfl.ml/v1/get_result",
            params={"id": request_id},
            headers=headers
        )
        result = poll.json()
        if result.get("status") == "Ready":
            image_url = result["result"]["sample"]
            img_resp = requests.get(image_url)
            return img_resp.content
        elif result.get("status") == "failed":
            raise RuntimeError(f"FLUX generation failed: {result}")

    raise TimeoutError("FLUX generation timed out after 120s")
```

---

## Step 3 — Font Loading (System Fonts, Cyrillic-safe)

```python
import os
from PIL import ImageFont

FONT_SEARCH_PATHS = [
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/ubuntu/Ubuntu-B.ttf",
    "/usr/share/fonts/truetype/ubuntu/Ubuntu-R.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/arial.ttf",
]

def find_font(bold: bool = False) -> str:
    candidates = [p for p in FONT_SEARCH_PATHS if ("Bold" in p or "bd" in p) == bold]
    candidates += [p for p in FONT_SEARCH_PATHS if ("Bold" in p or "bd" in p) != bold]
    for path in candidates:
        if os.path.exists(path):
            return path
    return None

def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    path = find_font(bold)
    if path:
        return ImageFont.truetype(path, size)
    return ImageFont.load_default()
```

---

## Step 4 — Text Layout Engine

```python
from PIL import Image, ImageDraw, ImageFont
from dataclasses import dataclass
from typing import Optional

@dataclass
class BannerConfig:
    width: int = 1200
    height: int = 628
    padding: int = 60
    text_zone_top_ratio: float = 0.62
    headline_size: int = 54
    subtitle_size: int = 32
    bullet_size: int = 30
    headline_color: tuple = (255, 255, 255)
    subtitle_color: tuple = (220, 220, 220)
    bullet_color: tuple = (200, 200, 200)
    bullet_marker: str = "•"
    overlay_opacity: int = 160
    line_spacing: int = 10
    layout: str = "bottom_left"          # See Layout System section
    plaque_color: tuple = (0, 0, 0)      # Headline plaque background
    plaque_opacity: int = 180            # 0-255
    accent_color: tuple = (74, 144, 226) # Accent line color (RGB)


@dataclass
class TextBlock:
    text: str
    x: int
    y: int
    w: int
    h: int


def wrap_text(text: str, font: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    words = text.split()
    lines = []
    current = ""
    for word in words:
        test = f"{current} {word}".strip()
        bbox = font.getbbox(test)
        if bbox[2] - bbox[0] <= max_width:
            current = test
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def scale_config(cfg: BannerConfig) -> BannerConfig:
    base_w, base_h = 1200, 628
    scale = min(cfg.width / base_w, cfg.height / base_h)
    cfg.headline_size = max(28, int(cfg.headline_size * scale))
    cfg.subtitle_size = max(18, int(cfg.subtitle_size * scale))
    cfg.bullet_size   = max(16, int(cfg.bullet_size * scale))
    cfg.padding       = max(40, int(cfg.padding * scale))
    return cfg
```

---

## Step 5 — Layout System

### 5 layouts — auto-selected by style, or override manually

| Layout code | Text position | Auto-used by styles |
|---|---|---|
| `bottom_left` | Bottom 38%, left-aligned | `cinematic`, `result_visual` |
| `left_half` | Left 52%, vertically centered | `product_focus`, `minimal_3d` |
| `top_left` | Top 40%, left-aligned | `lifestyle_candid` |
| `card_overlay` | Bottom floating card, full width | `location`, `lifestyle_candid` |
| `center` | Centered, vertically middle | Stories format |

### Style → Layout auto-mapping

```python
STYLE_TO_LAYOUT = {
    "cinematic":        "bottom_left",
    "result_visual":    "bottom_left",
    "product_focus":    "left_half",
    "minimal_3d":       "left_half",
    "lifestyle_candid": "top_left",
    "location":         "card_overlay",
}

def resolve_layout(style: str, layout_override: str = None) -> str:
    if layout_override:
        return layout_override
    return STYLE_TO_LAYOUT.get(style, "bottom_left")
```

### Gradient overlay (layout-aware)

Each layout darkens only its own text zone so the rest of the image stays clean.

```python
def apply_text_zone_overlay(image: Image.Image, cfg: BannerConfig) -> Image.Image:
    img = image.convert("RGBA")
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    layout = cfg.layout

    if layout == "bottom_left":
        # Gradient from transparent at 62% to overlay_opacity at bottom
        zone_top = int(cfg.height * cfg.text_zone_top_ratio)
        zone_height = cfg.height - zone_top
        for y in range(zone_height):
            alpha = int((y / zone_height) * cfg.overlay_opacity)
            draw.line([(0, zone_top + y), (cfg.width, zone_top + y)], fill=(0, 0, 0, alpha))

    elif layout == "left_half":
        # Gradient from left edge to 55% width
        zone_w = int(cfg.width * 0.55)
        for x in range(zone_w):
            alpha = int(((zone_w - x) / zone_w) * cfg.overlay_opacity)
            draw.line([(x, 0), (x, cfg.height)], fill=(0, 0, 0, alpha))

    elif layout == "top_left":
        # Gradient from top down to 42% height
        zone_h = int(cfg.height * 0.42)
        for y in range(zone_h):
            alpha = int(((zone_h - y) / zone_h) * cfg.overlay_opacity)
            draw.line([(0, y), (cfg.width, y)], fill=(0, 0, 0, alpha))

    elif layout == "card_overlay":
        # No full-zone overlay — card plaque handles contrast
        pass

    elif layout == "center":
        # Soft vignette over the whole image
        for y in range(cfg.height):
            dist = abs(y - cfg.height / 2) / (cfg.height / 2)
            alpha = int(dist * cfg.overlay_opacity * 0.6)
            draw.line([(0, y), (cfg.width, y)], fill=(0, 0, 0, alpha))

    composited = Image.alpha_composite(img, overlay)
    return composited.convert("RGB")
```

---

## Step 6 — Composite Text Layers

Text position and plaque rendering are driven by `cfg.layout`.

Each layout has a **plaque under the headline**: a semi-transparent rounded rectangle drawn before the text, improving legibility on any background.

```python
def _get_text_origin(cfg: BannerConfig) -> tuple[int, int]:
    """Return (x, y) start position for text block based on layout."""
    layout = cfg.layout
    if layout == "bottom_left":
        return cfg.padding, int(cfg.height * cfg.text_zone_top_ratio) + 16
    elif layout == "left_half":
        # Vertically centered in left half
        text_zone_h = cfg.height - cfg.padding * 2
        return cfg.padding, cfg.padding + int(text_zone_h * 0.25)
    elif layout == "top_left":
        return cfg.padding, cfg.padding + 12
    elif layout == "card_overlay":
        card_top = int(cfg.height * 0.72)
        return cfg.padding, card_top + 14
    elif layout == "center":
        return cfg.width // 2, int(cfg.height * 0.35)
    return cfg.padding, int(cfg.height * cfg.text_zone_top_ratio) + 16


def _max_text_width(cfg: BannerConfig) -> int:
    """Return max pixel width for text lines based on layout."""
    if cfg.layout == "left_half":
        return int(cfg.width * 0.50) - cfg.padding
    elif cfg.layout == "center":
        return int(cfg.width * 0.75)
    return cfg.width - cfg.padding * 2


def draw_plaque(draw, x: int, y: int, w: int, h: int, cfg: BannerConfig):
    """
    Draw semi-transparent rounded rectangle behind headline block.
    Plaque extends 12px beyond text on each side, 8px above and below.
    """
    pad_x, pad_y = 12, 8
    rx, ry = x - pad_x, y - pad_y
    rw, rh = w + pad_x * 2, h + pad_y * 2

    # Draw on RGBA layer then composite
    from PIL import Image as PILImage
    plaque_layer = PILImage.new("RGBA", (cfg.width, cfg.height), (0, 0, 0, 0))
    pd = PILImage.Draw(plaque_layer) if False else __import__('PIL.ImageDraw', fromlist=['ImageDraw']).ImageDraw.Draw(plaque_layer)
    r = cfg.plaque_color + (cfg.plaque_opacity,)
    pd.rounded_rectangle([rx, ry, rx + rw, ry + rh], radius=6, fill=r)
    return plaque_layer


def composite_text(
    background_bytes: bytes,
    headline: str,
    subtitle: Optional[str],
    bullets: list[str],
    cfg: Optional[BannerConfig] = None
) -> tuple[Image.Image, list[TextBlock]]:
    if cfg is None:
        cfg = BannerConfig()
    cfg = scale_config(cfg)

    from io import BytesIO
    from PIL import ImageDraw as PIDraw
    bg = Image.open(BytesIO(background_bytes)).convert("RGBA")
    bg = bg.resize((cfg.width, cfg.height), Image.LANCZOS)

    # Apply layout-aware gradient overlay
    overlay_img = apply_text_zone_overlay(bg.convert("RGB"), cfg).convert("RGBA")
    bg = Image.alpha_composite(bg, Image.new("RGBA", bg.size, (0,0,0,0)))
    bg = overlay_img.convert("RGBA")

    font_headline = load_font(cfg.headline_size, bold=True)
    font_subtitle  = load_font(cfg.subtitle_size, bold=False)
    font_bullet    = load_font(cfg.bullet_size, bold=False)

    max_w = _max_text_width(cfg)
    start_x, start_y = _get_text_origin(cfg)
    text_blocks: list[TextBlock] = []
    current_y = start_y

    # --- CARD OVERLAY: draw full-width dark card first ---
    if cfg.layout == "card_overlay":
        card_top = int(cfg.height * 0.70)
        card_layer = Image.new("RGBA", (cfg.width, cfg.height), (0, 0, 0, 0))
        cd = PIDraw.Draw(card_layer)
        cd.rounded_rectangle(
            [cfg.padding // 2, card_top, cfg.width - cfg.padding // 2, cfg.height - cfg.padding // 2],
            radius=10,
            fill=cfg.plaque_color + (cfg.plaque_opacity,)
        )
        bg = Image.alpha_composite(bg, card_layer)
        current_y = card_top + 14

    # --- HEADLINE with plaque ---
    headline_lines = wrap_text(headline, font_headline, max_w)
    headline_line_heights = []
    for line in headline_lines:
        bbox = font_headline.getbbox(line)
        headline_line_heights.append(bbox[3] - bbox[1])

    total_headline_h = sum(headline_line_heights) + cfg.line_spacing * (len(headline_lines) - 1)
    max_headline_w = max((font_headline.getbbox(l)[2] - font_headline.getbbox(l)[0]) for l in headline_lines)

    # Draw plaque only for non-card layouts
    if cfg.layout != "card_overlay":
        plaque_layer = Image.new("RGBA", (cfg.width, cfg.height), (0, 0, 0, 0))
        pd = PIDraw.Draw(plaque_layer)
        px, py = start_x - 12, current_y - 8
        pw, ph = max_headline_w + 24, total_headline_h + 16
        pd.rounded_rectangle([px, py, px + pw, py + ph], radius=6,
                              fill=cfg.plaque_color + (cfg.plaque_opacity,))
        # Accent line: 3px wide, full plaque height, left edge
        pd.rectangle([px, py + 4, px + 3, py + ph - 4],
                     fill=cfg.accent_color + (255,))
        bg = Image.alpha_composite(bg, plaque_layer)

    # Draw headline text
    draw = PIDraw.Draw(bg)
    for line, line_h in zip(headline_lines, headline_line_heights):
        tx = start_x if cfg.layout != "center" else cfg.width // 2
        anchor = "la" if cfg.layout != "center" else "ma"
        draw.text((tx, current_y), line, font=font_headline, fill=cfg.headline_color,
                  anchor=anchor if hasattr(font_headline, "getbbox") else None)
        if cfg.layout != "center":
            draw.text((start_x, current_y), line, font=font_headline, fill=cfg.headline_color)
        else:
            draw.text((cfg.width // 2, current_y), line, font=font_headline,
                      fill=cfg.headline_color, anchor="mm")
        text_blocks.append(TextBlock(line, start_x, current_y,
                                     font_headline.getbbox(line)[2] - font_headline.getbbox(line)[0],
                                     line_h))
        current_y += line_h + cfg.line_spacing
    current_y += 8

    # --- SUBTITLE ---
    if subtitle:
        for line in wrap_text(subtitle, font_subtitle, max_w):
            bbox = font_subtitle.getbbox(line)
            line_h = bbox[3] - bbox[1]
            draw.text((start_x, current_y), line, font=font_subtitle, fill=cfg.subtitle_color)
            text_blocks.append(TextBlock(line, start_x, current_y, bbox[2] - bbox[0], line_h))
            current_y += line_h + cfg.line_spacing
        current_y += 6

    # --- BULLETS ---
    for bullet in bullets[:5]:
        bullet_text = f"{cfg.bullet_marker}  {bullet}"
        for line in wrap_text(bullet_text, font_bullet, max_w):
            bbox = font_bullet.getbbox(line)
            line_h = bbox[3] - bbox[1]
            draw.text((start_x, current_y), line, font=font_bullet, fill=cfg.bullet_color)
            text_blocks.append(TextBlock(line, start_x, current_y, bbox[2] - bbox[0], line_h))
            current_y += line_h + cfg.line_spacing

    return bg.convert("RGB"), text_blocks
```

---

## Step 7 — Text Coverage Check (≤18% Rule)

**Why 18% and not 20%:** VK's official policy allows up to 20% text coverage. We enforce 18% as a conservative buffer to avoid borderline rejections and keep the visual clean. Document this if clients ask.

```python
TEXT_COVERAGE_LIMIT = 18.0  # Conservative buffer. VK official limit is 20%.

def calculate_text_coverage(
    text_blocks: list[TextBlock],
    banner_w: int,
    banner_h: int,
    method: str = "pixel"
) -> float:
    if method == "bbox":
        total = sum(b.w * b.h for b in text_blocks)
        return (total / (banner_w * banner_h)) * 100
    mask = Image.new("L", (banner_w, banner_h), 0)
    draw = ImageDraw.Draw(mask)
    for b in text_blocks:
        draw.rectangle([b.x, b.y, b.x + b.w, b.y + b.h], fill=255)
    covered = sum(1 for p in mask.getdata() if p > 0)
    return (covered / (banner_w * banner_h)) * 100


def check_coverage(text_blocks, banner_w, banner_h) -> dict:
    pct = calculate_text_coverage(text_blocks, banner_w, banner_h)
    return {
        "coverage_pct": round(pct, 2),
        "passes": pct <= TEXT_COVERAGE_LIMIT,
        "limit": TEXT_COVERAGE_LIMIT,
        "over_by": max(0.0, round(pct - TEXT_COVERAGE_LIMIT, 2))
    }
```

---

## Step 8 — Auto-Fit When Coverage Exceeds Limit

```python
def autofit_and_composite(
    background_bytes: bytes,
    headline: str,
    subtitle: Optional[str],
    bullets: list[str],
    cfg: Optional[BannerConfig] = None,
    max_attempts: int = 6
) -> tuple[Image.Image, dict]:
    if cfg is None:
        cfg = BannerConfig()

    current_bullets = bullets[:5]
    current_subtitle = subtitle
    current_headline = headline
    font_scale = 1.0

    for attempt in range(max_attempts):
        attempt_cfg = BannerConfig(
            width=cfg.width,
            height=cfg.height,
            padding=cfg.padding,
            text_zone_top_ratio=cfg.text_zone_top_ratio,
            headline_size=int(cfg.headline_size * font_scale),
            subtitle_size=int(cfg.subtitle_size * font_scale),
            bullet_size=int(cfg.bullet_size * font_scale),
            overlay_opacity=cfg.overlay_opacity,
            layout=cfg.layout,
            plaque_color=cfg.plaque_color,
            plaque_opacity=cfg.plaque_opacity,
            accent_color=cfg.accent_color,
        )
        image, text_blocks = composite_text(
            background_bytes, current_headline, current_subtitle, current_bullets, attempt_cfg
        )
        report = check_coverage(text_blocks, cfg.width, cfg.height)
        report["attempt"] = attempt + 1
        report["bullets_shown"] = len(current_bullets)
        report["subtitle_shown"] = current_subtitle is not None
        report["font_scale"] = round(font_scale, 2)

        if report["passes"]:
            return image, report

        if attempt == 0:
            font_scale *= 0.90
        elif attempt == 1:
            font_scale *= 0.90
        elif attempt == 2 and len(current_bullets) > 0:
            current_bullets = current_bullets[:-1]
        elif attempt == 3 and current_subtitle:
            current_subtitle = None
        elif attempt == 4:
            if len(current_headline) > 40:
                current_headline = current_headline[:37] + "…"
            font_scale *= 0.85
        else:
            font_scale *= 0.80

    report["warning"] = "Could not reach ≤18% after max attempts. Returning closest result."
    return image, report
```

---

## Step 9 — Full Pipeline (Entry Point)

```python
import anthropic
from io import BytesIO

def generate_vk_banner(
    headline: str,
    subtitle: Optional[str],
    bullets: list[str],
    offer_context: str,
    niche: str,
    anthropic_api_key: str,
    flux_api_key: str,
    banner_format: str = "link",
    style_override: str = None,
    layout_override: str = None,   # Force layout: bottom_left|left_half|top_left|card_overlay|center
    output_path: str = "banner.jpg"
) -> dict:
    FORMATS = {
        "link":    BannerConfig(width=1200, height=628),
        "square":  BannerConfig(width=1080, height=1080),
        "stories": BannerConfig(width=1080, height=1920),
    }
    cfg = FORMATS.get(banner_format, FORMATS["link"])

    anthropic_client = anthropic.Anthropic(api_key=anthropic_api_key)
    flux_prompt, style_used = generate_flux_prompt(
        headline, subtitle, bullets, offer_context, niche, anthropic_client, style_override
    )

    # Auto-resolve layout from style, unless overridden
    cfg.layout = resolve_layout(style_used, layout_override)

    # Stories format always uses center layout
    if banner_format == "stories":
        cfg.layout = layout_override or "center"

    bg_bytes = generate_background(flux_prompt, cfg.width, cfg.height, flux_api_key)

    final_image, report = autofit_and_composite(bg_bytes, headline, subtitle, bullets, cfg)

    final_image.save(output_path, "JPEG", quality=92)
    report["output_path"] = output_path
    report["flux_prompt"] = flux_prompt
    report["style_used"] = style_used
    report["layout_used"] = cfg.layout
    report["format"] = banner_format
    report["dimensions"] = f"{cfg.width}x{cfg.height}"

    return report


# --- USAGE EXAMPLE ---
if __name__ == "__main__":
    report = generate_vk_banner(
        headline="Получите 300 заявок за 30 дней",
        subtitle="Автоматизированная воронка продаж под ключ",
        bullets=[
            "Настройка за 3 дня",
            "Гарантия результата",
            "Оплата после первых заявок",
        ],
        offer_context="Агентство лидогенерации для малого бизнеса",
        niche="лидогенерация",
        anthropic_api_key="YOUR_ANTHROPIC_KEY",
        flux_api_key="YOUR_FLUX_KEY",
        banner_format="link",
        output_path="output/banner_link.jpg"
    )

    print(f"Style used:    {report['style_used']}")
    print(f"Coverage:      {report['coverage_pct']}% ({'OK' if report['passes'] else 'OVER LIMIT'})")
    print(f"Font scale:    {report['font_scale']}")
    print(f"Bullets shown: {report['bullets_shown']}")
    print(f"Saved to:      {report['output_path']}")
```

---

## Text Coverage Reference

VK official policy: text must not exceed **20%** of image area. We enforce **18%** as a conservative buffer.

| Element | Typical coverage | Notes |
|---|---|---|
| 1-line headline | 3–5% | Depends on text length |
| 2-line headline | 6–9% | Wrapping increases fast |
| Subtitle (1 line) | 2–3% | — |
| 3 bullets | 4–6% | Each bullet ~1.5–2% |
| 5 bullets | 6–9% | Near limit without headline |
| Headline + 3 bullets | 9–13% | Safe zone |
| Headline + subtitle + 3 bullets | 12–16% | Usually passes |
| Headline + subtitle + 5 bullets | 15–20% | Triggers auto-fit |

**Auto-fit reduction order:**
1. Reduce fonts 10%
2. Reduce fonts 10% again
3. Remove last bullet
4. Remove subtitle
5. Truncate headline + reduce fonts 15%
6. Aggressive font reduction 20%

---

## Integration Notes

**Calling from Node.js service:**

```javascript
const { execFile } = require('child_process');
const path = require('path');

function generateBanner(params) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'banner_pipeline.py');
    const args = [
      '--headline',  params.headline,
      '--subtitle',  params.subtitle || '',
      '--bullets',   JSON.stringify(params.bullets),
      '--offer',     params.offerContext,
      '--niche',     params.niche,
      '--format',    params.format || 'link',
      '--style',     params.styleOverride || '',
      '--output',    params.outputPath
    ];
    execFile('python3', [scriptPath, ...args], (err, stdout) => {
      if (err) return reject(err);
      resolve(JSON.parse(stdout));
    });
  });
}
```

**Or expose as a Python FastAPI endpoint** and call it from Node via HTTP — cleaner for production.

---

## Troubleshooting

**Wrong visual style selected:**
Pass `style_override` explicitly: one of `lifestyle_candid`, `product_focus`, `result_visual`, `location`, `cinematic`, `minimal_3d`.

**Text appears outside safe zone:**
Increase `text_zone_top_ratio` in BannerConfig (e.g. 0.65) to push text lower.

**Cyrillic renders as boxes/squares:**
Install: `sudo apt-get install fonts-liberation` or `fonts-ubuntu`.

**Coverage always reports 0%:**
`font.getbbox()` requires Pillow >= 9.2.0. Run `pip show Pillow` to verify.

**FLUX returns flat image with no depth:**
Add to FLUX prompt suffix: `"dramatic volumetric lighting, strong contrast between light and shadow"`.

**lifestyle_candid looks too posed:**
Ensure the Haiku output describes a specific realistic situation, not a generic one.
E.g. "woman at a gym checking her phone after a workout" not "woman in a gym smiling".

**Banner looks cluttered:**
Reduce to headline + max 3 bullets. Drop subtitle. Increase `text_zone_top_ratio` to 0.68.

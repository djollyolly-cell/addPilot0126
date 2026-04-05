#!/usr/bin/env python3
import argparse
import json
import os
import time
from dataclasses import dataclass
from io import BytesIO
from typing import Optional

import requests
from PIL import Image, ImageDraw, ImageFont


try:
    import anthropic  # type: ignore
except Exception:  # pragma: no cover
    anthropic = None


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
""",
}

FLUX_SUFFIX = (
    "Professional commercial photography or high-quality 3D render. "
    "Bottom area significantly darker for text overlay. "
    "No text, no letters, no words, no watermarks, no logos, no UI elements."
)


NICHE_MAP = {
    "фитнес": "lifestyle_candid",
    "спорт": "lifestyle_candid",
    "здоров": "lifestyle_candid",
    "красота": "lifestyle_candid",
    "косметика": "lifestyle_candid",
    "еда": "lifestyle_candid",
    "ресторан": "lifestyle_candid",
    "доставка": "lifestyle_candid",
    "кафе": "lifestyle_candid",
    "мероприятие": "lifestyle_candid",
    "ивент": "lifestyle_candid",
    "товар": "product_focus",
    "интернет-магазин": "product_focus",
    "гаджет": "product_focus",
    "электроника": "product_focus",
    "одежда": "product_focus",
    "обучение": "result_visual",
    "курс": "result_visual",
    "коучинг": "result_visual",
    "похудение": "result_visual",
    "инвестиции": "result_visual",
    "финансы": "cinematic",
    "маркетинг": "cinematic",
    "реклама": "cinematic",
    "лидогенерация": "cinematic",
    "кредит": "cinematic",
    "страхование": "cinematic",
    "недвижимость": "location",
    "аренда": "location",
    "локальный": "location",
    "events": "lifestyle_candid",
    "it": "minimal_3d",
    "saas": "minimal_3d",
    "приложение": "minimal_3d",
    "сервис": "minimal_3d",
    "b2b": "minimal_3d",
    "разработка": "minimal_3d",
    "курсы": "result_visual",
}


STYLE_TO_LAYOUT = {
    "cinematic": "bottom_left",
    "result_visual": "bottom_left",
    "product_focus": "left_half",
    "minimal_3d": "left_half",
    "lifestyle_candid": "top_left",
    "location": "card_overlay",
}


@dataclass
class BannerConfig:
    width: int
    height: int
    padding: int = 60
    text_zone_top_ratio: float = 0.62  # bottom 38% is intended for text

    headline_size: int = 54
    subtitle_size: int = 32
    bullet_size: int = 30

    headline_color: tuple[int, int, int] = (255, 255, 255)
    subtitle_color: tuple[int, int, int] = (220, 220, 220)
    bullet_color: tuple[int, int, int] = (200, 200, 200)

    bullet_marker: str = "•"
    line_spacing: int = 10

    overlay_opacity: int = 160
    plaque_color: tuple[int, int, int] = (0, 0, 0)
    plaque_opacity: int = 180
    accent_color: tuple[int, int, int] = (74, 144, 226)

    # Layout codes:
    # bottom_left, left_half, top_left, card_overlay, center
    layout: str = "bottom_left"


@dataclass
class TextBlock:
    text: str
    x: int
    y: int
    w: int
    h: int


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
    "/Library/Fonts/Arial.ttf",
]


def select_visual_style(niche: str, style_override: Optional[str] = None) -> str:
    if style_override:
        if style_override in STYLE_PROMPTS:
            return style_override
    niche_lower = (niche or "").lower()
    for keyword, style in NICHE_MAP.items():
        if keyword in niche_lower:
            return style
    return "cinematic"


def resolve_layout(style: str, layout_override: Optional[str] = None) -> str:
    if layout_override:
        return layout_override
    return STYLE_TO_LAYOUT.get(style, "bottom_left")


def find_font(bold: bool) -> Optional[str]:
    candidates = [p for p in FONT_SEARCH_PATHS if (("Bold" in p) or ("bd" in p)) == bold]
    if not candidates:
        candidates = FONT_SEARCH_PATHS
    for p in candidates:
        if os.path.exists(p):
            return p
    return None


def load_font(size: int, bold: bool) -> ImageFont.FreeTypeFont:
    path = find_font(bold=bold)
    if path:
        return ImageFont.truetype(path, size)
    # Fallback: may be less ideal for Cyrillic, but keeps the pipeline functional.
    return ImageFont.load_default()


def scale_config(cfg: BannerConfig, font_scale: float) -> BannerConfig:
    # Keep layout + colors; only scale geometry-ish values relevant for legibility.
    scaled = BannerConfig(
        width=cfg.width,
        height=cfg.height,
        padding=cfg.padding,
        text_zone_top_ratio=cfg.text_zone_top_ratio,
        headline_size=max(20, int(cfg.headline_size * font_scale)),
        subtitle_size=max(14, int(cfg.subtitle_size * font_scale)),
        bullet_size=max(12, int(cfg.bullet_size * font_scale)),
        headline_color=cfg.headline_color,
        subtitle_color=cfg.subtitle_color,
        bullet_color=cfg.bullet_color,
        bullet_marker=cfg.bullet_marker,
        line_spacing=max(6, int(cfg.line_spacing * font_scale)),
        overlay_opacity=cfg.overlay_opacity,
        plaque_color=cfg.plaque_color,
        plaque_opacity=cfg.plaque_opacity,
        accent_color=cfg.accent_color,
        layout=cfg.layout,
    )
    return scaled


def measure_text_wh(font: ImageFont.FreeTypeFont, text: str) -> tuple[int, int]:
    bbox = font.getbbox(text)
    w = int(bbox[2] - bbox[0])
    h = int(bbox[3] - bbox[1])
    return max(1, w), max(1, h)


def wrap_text(text: str, font: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    # Word wrapping by pixel width. Works well enough for RU with whitespace-separated words.
    words = (text or "").strip().split()
    if not words:
        return []
    lines: list[str] = []
    current = words[0]
    for word in words[1:]:
        test = f"{current} {word}".strip()
        w, _ = measure_text_wh(font, test)
        if w <= max_width:
            current = test
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


def apply_text_zone_overlay(image: Image.Image, cfg: BannerConfig) -> Image.Image:
    img = image.convert("RGBA")
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    layout = cfg.layout
    zone_alpha = cfg.overlay_opacity

    if layout == "bottom_left":
        zone_top = int(cfg.height * cfg.text_zone_top_ratio)
        zone_height = max(1, cfg.height - zone_top)
        for dy in range(zone_height):
            alpha = int((dy / zone_height) * zone_alpha)
            y = zone_top + dy
            draw.line([(0, y), (cfg.width, y)], fill=(0, 0, 0, alpha))

    elif layout == "left_half":
        zone_w = int(cfg.width * 0.55)
        zone_w = max(1, zone_w)
        for dx in range(zone_w):
            alpha = int(((zone_w - dx) / zone_w) * zone_alpha)
            x = dx
            draw.line([(x, 0), (x, cfg.height)], fill=(0, 0, 0, alpha))

    elif layout == "top_left":
        zone_h = int(cfg.height * 0.42)
        zone_h = max(1, zone_h)
        for dy in range(zone_h):
            alpha = int(((zone_h - dy) / zone_h) * zone_alpha)
            y = dy
            draw.line([(0, y), (cfg.width, y)], fill=(0, 0, 0, alpha))

    elif layout == "card_overlay":
        # Card plaque gives most contrast; still add a light vignette.
        for dy in range(cfg.height):
            dist = abs(dy - cfg.height / 2) / (cfg.height / 2)
            alpha = int(dist * zone_alpha * 0.25)
            draw.line([(0, dy), (cfg.width, dy)], fill=(0, 0, 0, alpha))

    elif layout == "center":
        for dy in range(cfg.height):
            dist = abs(dy - cfg.height / 2) / (cfg.height / 2)
            alpha = int(dist * zone_alpha * 0.35)
            draw.line([(0, dy), (cfg.width, dy)], fill=(0, 0, 0, alpha))

    return Image.alpha_composite(img, overlay).convert("RGB")


def _get_text_origin(cfg: BannerConfig) -> tuple[int, int]:
    layout = cfg.layout
    if layout == "bottom_left":
        return cfg.padding, int(cfg.height * cfg.text_zone_top_ratio) + 16
    if layout == "left_half":
        text_zone_h = cfg.height - cfg.padding * 2
        return cfg.padding, cfg.padding + int(text_zone_h * 0.18)
    if layout == "top_left":
        return cfg.padding, cfg.padding + 12
    if layout == "card_overlay":
        card_top = int(cfg.height * 0.72)
        return cfg.padding, card_top + 14
    if layout == "center":
        return cfg.width // 2, int(cfg.height * 0.33)
    return cfg.padding, int(cfg.height * cfg.text_zone_top_ratio) + 16


def _max_text_width(cfg: BannerConfig) -> int:
    if cfg.layout == "left_half":
        return int(cfg.width * 0.50) - cfg.padding
    if cfg.layout == "center":
        return int(cfg.width * 0.75)
    return cfg.width - cfg.padding * 2


def check_coverage(text_blocks: list[TextBlock], banner_w: int, banner_h: int) -> float:
    # Approximate coverage by drawing solid rectangles for each line bounding box.
    # This matches the "auto-fit" behavior without expensive OCR-based measurement.
    mask = Image.new("L", (banner_w, banner_h), 0)
    draw = ImageDraw.Draw(mask)
    for b in text_blocks:
        draw.rectangle([b.x, b.y, b.x + b.w, b.y + b.h], fill=255)
    hist = mask.histogram()
    covered = hist[255] if len(hist) > 255 else 0
    return (covered / (banner_w * banner_h)) * 100.0


TEXT_COVERAGE_LIMIT = 18.0


def composite_text(
    background_bytes: bytes,
    headline: str,
    subtitle: Optional[str],
    bullets: list[str],
    cfg: BannerConfig,
) -> tuple[Image.Image, list[TextBlock]]:
    bg = Image.open(BytesIO(background_bytes)).convert("RGB")
    bg = bg.resize((cfg.width, cfg.height), Image.LANCZOS)

    bg = apply_text_zone_overlay(bg, cfg).convert("RGBA")

    font_headline = load_font(cfg.headline_size, bold=True)
    font_subtitle = load_font(cfg.subtitle_size, bold=False)
    font_bullet = load_font(cfg.bullet_size, bold=False)

    max_w = _max_text_width(cfg)
    start_x, current_y = _get_text_origin(cfg)

    text_blocks: list[TextBlock] = []

    draw = ImageDraw.Draw(bg)

    # Optional full-width card for card_overlay layout
    if cfg.layout == "card_overlay":
        card_top = int(cfg.height * 0.70)
        card_layer = Image.new("RGBA", (cfg.width, cfg.height), (0, 0, 0, 0))
        cd = ImageDraw.Draw(card_layer)
        cd.rounded_rectangle(
            [cfg.padding // 2, card_top, cfg.width - cfg.padding // 2, cfg.height - cfg.padding // 2],
            radius=10,
            fill=cfg.plaque_color + (cfg.plaque_opacity,),
        )
        bg = Image.alpha_composite(bg, card_layer)
        draw = ImageDraw.Draw(bg)
        current_y = card_top + 14

    # Headline
    headline_lines = wrap_text(headline, font_headline, max_w)
    headline_line_wh: list[tuple[int, int]] = [measure_text_wh(font_headline, l) for l in headline_lines]

    total_headline_h = sum(h for _, h in headline_line_wh)
    if len(headline_line_wh) > 1:
        total_headline_h += cfg.line_spacing * (len(headline_line_wh) - 1)

    max_headline_w = max((w for w, _ in headline_line_wh), default=0)

    if cfg.layout != "card_overlay":
        plaque_padding_x = 12
        plaque_padding_y = 8
        plaque_w = max_headline_w + plaque_padding_x * 2
        plaque_h = total_headline_h + plaque_padding_y * 2
        if cfg.layout == "center":
            plaque_x = start_x - plaque_w // 2
        else:
            plaque_x = start_x - plaque_padding_x
        plaque_y = current_y - plaque_padding_y
        plaque_layer = Image.new("RGBA", (cfg.width, cfg.height), (0, 0, 0, 0))
        pd = ImageDraw.Draw(plaque_layer)
        pd.rounded_rectangle(
            [plaque_x, plaque_y, plaque_x + plaque_w, plaque_y + plaque_h],
            radius=6,
            fill=cfg.plaque_color + (cfg.plaque_opacity,),
        )
        # Accent strip on left edge of plaque
        pd.rectangle(
            [plaque_x, plaque_y + 4, plaque_x + 3, plaque_y + plaque_h - 4],
            fill=cfg.accent_color + (255,),
        )
        bg = Image.alpha_composite(bg, plaque_layer)
        draw = ImageDraw.Draw(bg)

    for (line, (line_w, line_h)) in zip(headline_lines, headline_line_wh):
        if cfg.layout == "center":
            x = start_x - line_w // 2
        else:
            x = start_x
        draw.text((x, current_y), line, font=font_headline, fill=cfg.headline_color)
        text_blocks.append(TextBlock(text=line, x=x, y=current_y, w=line_w, h=line_h))
        current_y += line_h + cfg.line_spacing

    current_y += 6

    # Subtitle
    if subtitle:
        subtitle_lines = wrap_text(subtitle, font_subtitle, max_w)
        for line in subtitle_lines:
            line_w, line_h = measure_text_wh(font_subtitle, line)
            if cfg.layout == "center":
                x = start_x - line_w // 2
            else:
                x = start_x
            draw.text((x, current_y), line, font=font_subtitle, fill=cfg.subtitle_color)
            text_blocks.append(TextBlock(text=line, x=x, y=current_y, w=line_w, h=line_h))
            current_y += line_h + cfg.line_spacing
        current_y += 4

    # Bullets
    for bullet in bullets[:5]:
        bullet_text = f"{cfg.bullet_marker} {bullet}".strip()
        bullet_lines = wrap_text(bullet_text, font_bullet, max_w)
        for line in bullet_lines:
            line_w, line_h = measure_text_wh(font_bullet, line)
            if cfg.layout == "center":
                x = start_x - line_w // 2
            else:
                x = start_x
            draw.text((x, current_y), line, font=font_bullet, fill=cfg.bullet_color)
            text_blocks.append(TextBlock(text=line, x=x, y=current_y, w=line_w, h=line_h))
            current_y += line_h + cfg.line_spacing

    return bg.convert("RGB"), text_blocks


def generate_flux_prompt_via_haiku(
    *,
    headline: str,
    subtitle: Optional[str],
    bullets: list[str],
    offer_context: str,
    niche: str,
    anthropic_api_key: str,
    style_override: Optional[str] = None,
    model: str = "claude-haiku-4-5-20251001",
    max_tokens: int = 250,
) -> tuple[str, str]:
    if anthropic is None:
        raise RuntimeError("anthropic package is not installed. Install `anthropic` to use this skill.")

    style = select_visual_style(niche=niche, style_override=style_override)
    system_prompt = STYLE_PROMPTS[style]

    user_msg = f"{offer_context.strip()}. {headline.strip()}."
    if subtitle:
        user_msg += f" {subtitle.strip()}."
    if bullets:
        user_msg += f" {' '.join(b.strip() for b in bullets if b.strip())}."

    client = anthropic.Anthropic(api_key=anthropic_api_key)
    response = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        system=system_prompt,
        messages=[{"role": "user", "content": user_msg}],
    )

    visual_keywords = (response.content[0].text or "").strip()
    flux_prompt = f"{visual_keywords} {FLUX_SUFFIX}".strip()
    return flux_prompt, style


def generate_background_bfl(
    *,
    flux_prompt: str,
    width: int,
    height: int,
    flux_api_key: str,
    submit_url: str = "https://api.bfl.ml/v1/flux-pro-1.1",
    result_url: str = "https://api.bfl.ml/v1/get_result",
    steps: int = 28,
    guidance: float = 3.5,
    timeout_s: int = 120,
    poll_every_s: int = 2,
) -> bytes:
    headers = {"x-key": flux_api_key, "Content-Type": "application/json"}
    payload = {
        "prompt": flux_prompt,
        "width": width,
        "height": height,
        "steps": steps,
        "guidance": guidance,
        "output_format": "jpeg",
    }

    resp = requests.post(submit_url, json=payload, headers=headers, timeout=60)
    resp.raise_for_status()
    request_id = resp.json().get("id")
    if not request_id:
        raise RuntimeError(f"FLUX submit response missing id: {resp.text}")

    deadline = time.time() + timeout_s
    while time.time() < deadline:
        time.sleep(poll_every_s)
        poll = requests.get(result_url, params={"id": request_id}, headers=headers, timeout=60)
        poll.raise_for_status()
        result = poll.json()
        status = result.get("status")
        if status == "Ready":
            image_url = result.get("result", {}).get("sample")
            if not image_url:
                raise RuntimeError(f"FLUX Ready response missing sample url: {result}")
            img_resp = requests.get(image_url, timeout=60)
            img_resp.raise_for_status()
            return img_resp.content
        if status == "failed":
            raise RuntimeError(f"FLUX generation failed: {result}")

    raise TimeoutError(f"FLUX generation timed out after {timeout_s} seconds")


def autofit_and_composite(
    *,
    background_bytes: bytes,
    headline: str,
    subtitle: Optional[str],
    bullets: list[str],
    cfg: BannerConfig,
    max_attempts: int = 6,
) -> tuple[Image.Image, dict]:
    font_scale = 1.0
    current_bullets = bullets[:5]
    current_subtitle = subtitle

    report: dict = {}

    for attempt in range(max_attempts):
        attempt_cfg = scale_config(cfg, font_scale=font_scale)
        image, text_blocks = composite_text(
            background_bytes=background_bytes,
            headline=headline,
            subtitle=current_subtitle,
            bullets=current_bullets,
            cfg=attempt_cfg,
        )
        pct = check_coverage(text_blocks, cfg.width, cfg.height)
        passes = pct <= TEXT_COVERAGE_LIMIT

        report = {
            "attempt": attempt + 1,
            "coverage_pct": round(pct, 2),
            "passes": passes,
            "limit": TEXT_COVERAGE_LIMIT,
            "over_by": round(max(0.0, pct - TEXT_COVERAGE_LIMIT), 2),
            "font_scale": round(font_scale, 2),
            "bullets_shown": len(current_bullets),
            "subtitle_shown": current_subtitle is not None and str(current_subtitle).strip() != "",
        }

        if passes:
            return image, report

        # Auto-fit strategy (mirrors the described order)
        if attempt == 0 or attempt == 1:
            font_scale *= 0.90
        elif attempt == 2 and len(current_bullets) > 0:
            current_bullets = current_bullets[:-1]
        elif attempt == 3 and current_subtitle:
            current_subtitle = None
        elif attempt == 4:
            if len(headline) > 40:
                # Russian ellipsis
                headline = headline[:37] + "…"
            font_scale *= 0.85
        else:
            font_scale *= 0.80

    report["warning"] = "Could not reach <=18% after max attempts. Returning closest result."
    return image, report


def parse_bullets(val: str) -> list[str]:
    try:
        parsed = json.loads(val)
        if isinstance(parsed, list):
            return [str(x) for x in parsed if str(x).strip()]
    except Exception:
        pass
    # Fallback: allow comma-separated
    return [s.strip() for s in val.split(",") if s.strip()]


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate VK banner with FLUX background + Pillow text overlay.")
    parser.add_argument("--headline", required=True, type=str)
    parser.add_argument("--subtitle", default="", type=str)
    parser.add_argument("--bullets", required=True, type=str, help='JSON array string, e.g. ["a","b"]')
    parser.add_argument("--offer_context", required=True, type=str)
    parser.add_argument("--niche", required=True, type=str)

    parser.add_argument("--banner_format", default="link", type=str, choices=["link", "square", "stories"])
    parser.add_argument("--style_override", default="", type=str)
    parser.add_argument("--layout_override", default="", type=str)
    parser.add_argument("--output", default="output/banner.jpg", type=str)

    parser.add_argument("--anthropic_api_key", default="", type=str)
    parser.add_argument("--flux_api_key", default="", type=str)

    parser.add_argument("--haiku_model", default="claude-haiku-4-5-20251001", type=str)
    parser.add_argument("--bfl_steps", default="28", type=int)
    parser.add_argument("--bfl_guidance", default="3.5", type=float)

    args = parser.parse_args()

    anthropic_api_key = args.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY", "")
    flux_api_key = args.flux_api_key or os.environ.get("FLUX_API_KEY", "")
    if not anthropic_api_key:
        raise RuntimeError("Missing ANTHROPIC_API_KEY. Pass --anthropic_api_key or set env var.")
    if not flux_api_key:
        raise RuntimeError("Missing FLUX_API_KEY. Pass --flux_api_key or set env var.")

    subtitle = args.subtitle.strip() or None
    bullets = parse_bullets(args.bullets)[:5]

    FORMATS: dict[str, BannerConfig] = {
        "link": BannerConfig(width=1200, height=628),
        "square": BannerConfig(width=1080, height=1080),
        "stories": BannerConfig(width=1080, height=1920),
    }
    cfg = FORMATS[args.banner_format]

    style_override = args.style_override.strip() or None
    flux_prompt, style_used = generate_flux_prompt_via_haiku(
        headline=args.headline,
        subtitle=subtitle,
        bullets=bullets,
        offer_context=args.offer_context,
        niche=args.niche,
        anthropic_api_key=anthropic_api_key,
        style_override=style_override,
        model=args.haiku_model,
    )

    layout_override = args.layout_override.strip() or None
    cfg.layout = "center" if args.banner_format == "stories" else resolve_layout(style_used, layout_override)
    if layout_override:
        cfg.layout = layout_override

    background_bytes = generate_background_bfl(
        flux_prompt=flux_prompt,
        width=cfg.width,
        height=cfg.height,
        flux_api_key=flux_api_key,
        steps=args.bfl_steps,
        guidance=args.bfl_guidance,
    )

    final_image, report = autofit_and_composite(
        background_bytes=background_bytes,
        headline=args.headline,
        subtitle=subtitle,
        bullets=bullets,
        cfg=cfg,
    )

    out_path = args.output
    out_dir = os.path.dirname(out_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    final_image.save(out_path, "JPEG", quality=92)

    result = {
        "output_path": out_path,
        "dimensions": f"{cfg.width}x{cfg.height}",
        "format": args.banner_format,
        "style_used": style_used,
        "layout_used": cfg.layout,
        "flux_prompt": flux_prompt,
        **report,
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()


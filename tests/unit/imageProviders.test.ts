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

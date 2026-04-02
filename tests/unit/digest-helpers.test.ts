import { describe, test, expect } from "vitest";
import { isSubscriptionPackage, formatDelta } from "../../convex/telegram";

function formatNum(n: number): string {
  return n.toLocaleString("ru-RU");
}

describe("isSubscriptionPackage", () => {
  test("detects Russian subscription keyword", () => {
    expect(isSubscriptionPackage("Подписка на сообщество")).toBe(true);
    expect(isSubscriptionPackage("подписка")).toBe(true);
  });

  test("detects English keywords", () => {
    expect(isSubscriptionPackage("Subscribe to community")).toBe(true);
    expect(isSubscriptionPackage("Join community")).toBe(true);
    expect(isSubscriptionPackage("Community subscription")).toBe(true);
  });

  test("returns false for non-subscription packages", () => {
    expect(isSubscriptionPackage("Отправка сообщений")).toBe(false);
    expect(isSubscriptionPackage("Трафик")).toBe(false);
    expect(isSubscriptionPackage("Получение лидов")).toBe(false);
    expect(isSubscriptionPackage("Конверсии")).toBe(false);
  });
});

describe("formatDelta", () => {
  test("positive delta", () => {
    expect(formatDelta(112, 100)).toBe(" (↑12%)");
  });

  test("negative delta", () => {
    expect(formatDelta(88, 100)).toBe(" (↓12%)");
  });

  test("zero delta", () => {
    expect(formatDelta(100, 100)).toBe("");
  });

  test("zero previous", () => {
    expect(formatDelta(100, 0)).toBe("");
  });
});

describe("formatNum", () => {
  test("formats with spaces", () => {
    const result = formatNum(106989);
    // Node may use non-breaking space (U+00A0) for ru-RU
    expect(result.replace(/\s/g, " ")).toBe("106 989");
  });
});

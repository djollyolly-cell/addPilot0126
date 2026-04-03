import { describe, test, expect } from "vitest";
import { isSubscriptionPackage, formatDelta, formatDigestMessage, splitTelegramMessage } from "../../convex/telegram";
import type { DigestData } from "../../convex/telegram";

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

describe("formatDigestMessage", () => {
  const sampleData: DigestData = {
    accounts: [{
      name: "Сервис Парк",
      metrics: {
        impressions: 106989,
        clicks: 278,
        spent: 6418,
        leads: 9,
        messages: 0,
        subscriptions: 571,
        cpl: 768,
        costPerMsg: 0,
        costPerSub: 52,
      },
      ruleEvents: [
        { ruleName: "Клики без лидов", count: 2 },
        { ruleName: "CPL лимит", count: 1 },
      ],
      savedAmount: 1200,
    }],
    totals: {
      impressions: 106989,
      clicks: 278,
      spent: 6418,
      leads: 9,
      messages: 0,
      subscriptions: 571,
      cpl: 768,
      costPerMsg: 0,
      costPerSub: 52,
    },
  };

  test("daily format includes account name", () => {
    const msg = formatDigestMessage("daily", sampleData, "01.04.2026");
    expect(msg).toContain("Сервис Парк");
    expect(msg).toContain("Дайджест за 01.04.2026");
  });

  test("daily format separates leads and subscriptions", () => {
    const msg = formatDigestMessage("daily", sampleData, "01.04.2026");
    expect(msg).toContain("Лиды: 9");
    expect(msg).toContain("Подписки: 571");
  });

  test("daily format groups rule events", () => {
    const msg = formatDigestMessage("daily", sampleData, "01.04.2026");
    expect(msg).toContain("Клики без лидов — 2");
    expect(msg).toContain("CPL лимит — 1");
  });

  test("hides leads line when leads = 0", () => {
    const noLeads: DigestData = {
      accounts: [{
        ...sampleData.accounts[0],
        metrics: { ...sampleData.accounts[0].metrics, leads: 0, cpl: 0 },
      }],
      totals: { ...sampleData.totals, leads: 0, cpl: 0 },
    };
    const msg = formatDigestMessage("daily", noLeads, "01.04.2026");
    expect(msg).not.toContain("Лиды:");
    expect(msg).toContain("Подписки: 571");
  });

  test("weekly format includes comparison header", () => {
    const dataWithPrev: DigestData = {
      ...sampleData,
      prevTotals: {
        impressions: 95000, clicks: 250, spent: 5900,
        leads: 8, messages: 0, subscriptions: 520, cpl: 800, costPerMsg: 0, costPerSub: 50,
      },
      accounts: [{
        ...sampleData.accounts[0],
        prevMetrics: {
          impressions: 95000, clicks: 250, spent: 5900,
          leads: 8, messages: 0, subscriptions: 520, cpl: 800, costPerMsg: 0, costPerSub: 50,
        },
      }],
    };
    const msg = formatDigestMessage("weekly", dataWithPrev, "24.03 — 30.03.2026", "17.03 — 23.03");
    expect(msg).toContain("Сравнение с прошлой неделей");
    expect(msg).toContain("↑");
  });

  test("totals line at the end", () => {
    const msg = formatDigestMessage("daily", sampleData, "01.04.2026");
    expect(msg).toContain("Итого:");
    // Check that spent is formatted with locale
    const normalized = msg.replace(/\s/g, " ");
    expect(normalized).toContain("расход 6 418₽");
  });
});

describe("splitTelegramMessage", () => {
  test("does not split short messages", () => {
    const msg = "Short message";
    expect(splitTelegramMessage(msg)).toEqual([msg]);
  });

  test("splits long messages at line boundaries", () => {
    const lines = Array(100).fill("A".repeat(50));
    const msg = lines.join("\n");
    const parts = splitTelegramMessage(msg, 200);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(200);
    }
  });
});

import { describe, test, expect } from "vitest";
import { isSubscriptionPackage, classifyCampaignPackage, formatDelta, formatDigestMessage, splitTelegramMessage } from "../../convex/telegram";
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

describe("classifyCampaignPackage", () => {
  test("subscription keywords", () => {
    expect(classifyCampaignPackage("or_tt_crossdevice_community_vk_ocpm_socialengagement_pricedGoals_join")).toBe("subscription");
    expect(classifyCampaignPackage("Subscribe to community")).toBe("subscription");
  });

  test("message keywords", () => {
    expect(classifyCampaignPackage("or_tt_crossdevice_community_vk_ocpс_socialengagement_pricedGoals_contact")).toBe("message");
    expect(classifyCampaignPackage("or_tt_crossdevice_vk_socialvideo_cpm")).toBe("message");
  });

  test("awareness keywords — branding before video_and_live", () => {
    // This package has BOTH "video_and_live" and "branding" — branding must win
    expect(classifyCampaignPackage("or_tt_crossdevice_vk_video_and_live_cpm_branding_general")).toBe("awareness");
    expect(classifyCampaignPackage("or_tt_community_vk_promopost_cpm_branding_general")).toBe("awareness");
  });

  test("lead by default", () => {
    expect(classifyCampaignPackage("or_tt_crossdevice_community_vk_post_cpc_socialengagement_site_conversions")).toBe("lead");
    expect(classifyCampaignPackage("Трафик")).toBe("lead");
    expect(classifyCampaignPackage("")).toBe("lead");
  });

  test("video_and_live without branding = message", () => {
    expect(classifyCampaignPackage("or_tt_crossdevice_vk_video_and_live_cpm_socialengagement")).toBe("message");
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
      campaigns: [
        { adPlanId: 15791809, adPlanName: "подписка ДТП", type: "subscription", impressions: 50000, clicks: 100, spent: 3000, results: 571, costPerResult: 5 },
        { adPlanId: 13038509, adPlanName: "СС_ключи_кузовной", type: "message", impressions: 30000, clicks: 80, spent: 2000, results: 9, costPerResult: 222 },
        { adPlanId: 19044564, adPlanName: "узнаваемость пост", type: "awareness", impressions: 26989, clicks: 98, spent: 1418, results: 20, costPerResult: 71 },
      ],
      metrics: {
        impressions: 106989,
        clicks: 278,
        spent: 6418,
        leads: 0,
        messages: 9,
        subscriptions: 571,
        views: 20,
        cpl: 0,
        costPerMsg: 222,
        costPerSub: 5,
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
      leads: 0,
      messages: 9,
      subscriptions: 571,
      views: 20,
      cpl: 0,
      costPerMsg: 222,
      costPerSub: 5,
    },
  };

  test("daily format includes account name", () => {
    const msg = formatDigestMessage("daily", sampleData, "01.04.2026");
    expect(msg).toContain("Сервис Парк");
    expect(msg).toContain("Дайджест за 01.04.2026");
  });

  test("daily format shows per-campaign breakdown", () => {
    const msg = formatDigestMessage("daily", sampleData, "01.04.2026");
    expect(msg).toContain("подписка ДТП — подписки: 571");
    expect(msg).toContain("СС_ключи_кузовной — сообщения: 9");
    expect(msg).toContain("узнаваемость пост — просмотры: 20");
  });

  test("daily format groups rule events", () => {
    const msg = formatDigestMessage("daily", sampleData, "01.04.2026");
    expect(msg).toContain("Клики без лидов — 2");
    expect(msg).toContain("CPL лимит — 1");
  });

  test("totals include views", () => {
    const msg = formatDigestMessage("daily", sampleData, "01.04.2026");
    expect(msg).toContain("просмотры 20");
    expect(msg).toContain("подписки 571");
  });

  test("fallback to aggregate when no campaigns", () => {
    const noCampaigns: DigestData = {
      accounts: [{
        ...sampleData.accounts[0],
        campaigns: [],
        metrics: { ...sampleData.accounts[0].metrics, leads: 5, cpl: 100 },
      }],
      totals: { ...sampleData.totals, leads: 5, cpl: 100 },
    };
    const msg = formatDigestMessage("daily", noCampaigns, "01.04.2026");
    expect(msg).toContain("Лиды: 5");
  });

  test("weekly format includes comparison header", () => {
    const dataWithPrev: DigestData = {
      ...sampleData,
      prevTotals: {
        impressions: 95000, clicks: 250, spent: 5900,
        leads: 0, messages: 8, subscriptions: 520, views: 15, cpl: 0, costPerMsg: 200, costPerSub: 50,
      },
      accounts: [{
        ...sampleData.accounts[0],
        prevMetrics: {
          impressions: 95000, clicks: 250, spent: 5900,
          leads: 0, messages: 8, subscriptions: 520, views: 15, cpl: 0, costPerMsg: 200, costPerSub: 50,
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

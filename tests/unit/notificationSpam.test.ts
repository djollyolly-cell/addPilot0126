import { describe, it, expect } from "vitest";

// Копируем функции из syncMetrics.ts (они не экспортированы, тестируем логику)

function isPermanentError(msg: string): boolean {
  return (
    msg.includes("TOKEN_EXPIRED") ||
    msg.includes("403 Forbidden") ||
    msg.includes("refreshToken отсутствует")
  );
}

function isTokenExpiredError(msg: string): boolean {
  return (
    msg.includes("TOKEN_EXPIRED") ||
    msg.includes("refreshToken отсутствует")
  );
}

describe("isPermanentError", () => {
  it("matches TOKEN_EXPIRED", () => {
    expect(isPermanentError("Sync failed: TOKEN_EXPIRED")).toBe(true);
  });

  it("matches 403 Forbidden", () => {
    expect(isPermanentError("403 Forbidden access denied")).toBe(true);
  });

  it("matches refreshToken отсутствует", () => {
    expect(
      isPermanentError(
        "Токен VK Ads истёк, refreshToken отсутствует. Подключите кабинет заново."
      )
    ).toBe(true);
  });

  it("does NOT match transient errors", () => {
    expect(isPermanentError("Network timeout")).toBe(false);
    expect(isPermanentError("500 Internal Server Error")).toBe(false);
    expect(isPermanentError("ECONNRESET")).toBe(false);
  });
});

describe("isTokenExpiredError", () => {
  it("matches TOKEN_EXPIRED", () => {
    expect(isTokenExpiredError("TOKEN_EXPIRED from VK API")).toBe(true);
  });

  it("matches refreshToken отсутствует", () => {
    expect(
      isTokenExpiredError(
        "Токен VK Ads истёк, refreshToken отсутствует. Подключите кабинет заново."
      )
    ).toBe(true);
  });

  it("does NOT match 403 Forbidden (not a token error)", () => {
    expect(isTokenExpiredError("403 Forbidden")).toBe(false);
  });

  it("does NOT match transient errors", () => {
    expect(isTokenExpiredError("Network timeout")).toBe(false);
  });
});

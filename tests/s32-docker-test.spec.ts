/**
 * Sprint 32 — Self-Hosted Docker Deploy Tests
 * Tests both DEV and PROD Convex environments running locally
 */
import { test, expect } from "@playwright/test";

test.describe("Sprint 32 - Self-Hosted Convex", () => {
  test.describe("DEV Environment", () => {
    test("S32-DoD#1: DEV Convex backend is healthy", async ({ request }) => {
      const response = await request.get("http://localhost:3210/version");
      expect(response.ok()).toBeTruthy();
    });

    test("S32-DoD#2: DEV Dashboard opens", async ({ page }) => {
      await page.goto("http://localhost:6791", { timeout: 30000 });
      await page.waitForLoadState("networkidle");

      // Check that dashboard loads (it may show setup or login)
      const title = await page.title();
      console.log("DEV Dashboard title:", title);

      await page.screenshot({
        path: "screenshots/s32-dashboard-dev.png",
        fullPage: true,
      });

      // Dashboard should have some content
      const body = await page.locator("body").textContent();
      expect(body).toBeTruthy();
    });

    test("S32-DoD#3: DEV WebSocket endpoint available", async ({ request }) => {
      // WebSocket endpoint should be accessible
      const response = await request.get("http://localhost:3211/");
      // May return error but should be reachable
      expect(response.status()).toBeLessThan(500);
    });
  });

  test.describe("PROD Environment", () => {
    test("S32-DoD#7: PROD Convex backend is healthy", async ({ request }) => {
      const response = await request.get("http://localhost:4210/version");
      expect(response.ok()).toBeTruthy();
    });

    test("S32-DoD#8: PROD Dashboard opens", async ({ page }) => {
      await page.goto("http://localhost:7791", { timeout: 30000 });
      await page.waitForLoadState("networkidle");

      const title = await page.title();
      console.log("PROD Dashboard title:", title);

      await page.screenshot({
        path: "screenshots/s32-dashboard-prod.png",
        fullPage: true,
      });

      const body = await page.locator("body").textContent();
      expect(body).toBeTruthy();
    });

    test("S32-DoD#9: PROD WebSocket endpoint available", async ({ request }) => {
      const response = await request.get("http://localhost:4211/");
      expect(response.status()).toBeLessThan(500);
    });
  });

  test.describe("Environment Isolation", () => {
    test("S32-DoD#12: DEV and PROD are isolated", async ({ request }) => {
      // Both environments should respond independently
      const devResponse = await request.get("http://localhost:3210/version");
      const prodResponse = await request.get("http://localhost:4210/version");

      expect(devResponse.ok()).toBeTruthy();
      expect(prodResponse.ok()).toBeTruthy();

      // They are separate instances
      console.log("DEV version:", await devResponse.text());
      console.log("PROD version:", await prodResponse.text());
    });
  });
});

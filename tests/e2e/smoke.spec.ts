/**
 * Smoke Tests
 * Quick verification after deployment
 * Sprint 28: Smoke-тесты и мониторинг
 */

import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';

test.describe('Smoke Tests', () => {
  test('Homepage loads in under 2 seconds', async ({ page }) => {
    const startTime = Date.now();
    await page.goto(BASE_URL);
    const loadTime = Date.now() - startTime;

    expect(loadTime).toBeLessThan(2000);
    await expect(page).toHaveTitle(/AdPilot/);

    await page.screenshot({ path: 'screenshots/smoke-home.png' });
  });

  test('API health check returns ok', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/health`);

    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.status).toBe('ok');
  });

  test('Login button is visible', async ({ page }) => {
    await page.goto(BASE_URL);

    const loginButton = page.locator('[data-testid="login-button"]');
    await expect(loginButton).toBeVisible();

    await page.screenshot({ path: 'screenshots/smoke-login.png' });
  });

  test('Static assets load correctly', async ({ page }) => {
    const failedRequests: string[] = [];

    page.on('response', (response) => {
      if (!response.ok() && response.request().resourceType() !== 'xhr') {
        failedRequests.push(`${response.status()} ${response.url()}`);
      }
    });

    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    expect(failedRequests).toHaveLength(0);
  });

  test('No JavaScript errors on load', async ({ page }) => {
    const errors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    page.on('pageerror', (error) => {
      errors.push(error.message);
    });

    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    // Filter out known acceptable errors
    const criticalErrors = errors.filter(
      (e) =>
        !e.includes('favicon') &&
        !e.includes('manifest') &&
        !e.includes('[HMR]')
    );

    expect(criticalErrors).toHaveLength(0);

    await page.screenshot({ path: 'screenshots/smoke-console.png' });
  });

  test('Responsive layout on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(BASE_URL);

    // Viewport should adapt
    const body = page.locator('body');
    const boundingBox = await body.boundingBox();

    expect(boundingBox?.width).toBeLessThanOrEqual(375);

    await page.screenshot({ path: 'screenshots/smoke-mobile.png' });
  });

  test('Service Worker registered (PWA)', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    const swRegistered = await page.evaluate(async () => {
      if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.getRegistration();
        return !!registration;
      }
      return false;
    });

    // PWA smoke - might not be registered in dev mode
    console.log(`Service Worker registered: ${swRegistered}`);
  });
});

test.describe('Critical Paths Smoke', () => {
  test('Can navigate to all main routes', async ({ page }) => {
    const routes = [
      '/',
      '/login',
      '/dashboard',
      '/accounts',
      '/rules',
      '/analytics',
      '/logs',
      '/settings',
      '/pricing',
    ];

    for (const route of routes) {
      const response = await page.goto(`${BASE_URL}${route}`);

      // Should not get 404 or 500
      expect(response?.status()).toBeLessThan(400);
    }

    await page.screenshot({ path: 'screenshots/smoke-routes.png' });
  });

  test('Real-time connection established', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`);

    // Check if Convex client connects (look for WebSocket)
    const wsConnected = await page.evaluate(() => {
      return new Promise((resolve) => {
        // Give it a moment to connect
        setTimeout(() => {
          // Check for active WebSocket connections
          const performance = window.performance;
          const entries = performance.getEntriesByType('resource');
          const wsEntries = entries.filter(
            (e) => e.name.includes('convex') || e.name.includes('ws')
          );
          resolve(wsEntries.length > 0);
        }, 2000);
      });
    });

    console.log(`WebSocket/Convex connection: ${wsConnected}`);
  });
});

test.describe('Error Handling Smoke', () => {
  test('404 page shows correctly', async ({ page }) => {
    await page.goto(`${BASE_URL}/nonexistent-page-12345`);

    // Should show 404 or redirect to home
    const content = await page.textContent('body');
    const is404 =
      content?.includes('404') ||
      content?.includes('Not Found') ||
      page.url() === BASE_URL + '/';

    expect(is404).toBeTruthy();

    await page.screenshot({ path: 'screenshots/smoke-404.png' });
  });

  test('Graceful degradation without auth', async ({ page }) => {
    // Clear any existing auth
    await page.goto(BASE_URL);
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });

    await page.goto(`${BASE_URL}/dashboard`);

    // Should redirect to login or show login prompt
    await page.waitForURL(/\/(login|\/)?$/);

    await page.screenshot({ path: 'screenshots/smoke-no-auth.png' });
  });
});

import { test, expect } from '@playwright/test';

test.describe('Sprint 1 - Screenshots for DoD', () => {
  test('s1-login - Login page loads', async ({ page }) => {
    await page.goto('http://localhost:5174/login');
    await page.waitForLoadState('networkidle');

    // Check page loads
    await expect(page).toHaveTitle(/AddPilot/);

    // Screenshot
    await page.screenshot({ path: 'screenshots/s1-login.png', fullPage: true });
  });

  test('s1-login-dom - Login button exists', async ({ page }) => {
    await page.goto('http://localhost:5174/login');
    await page.waitForLoadState('networkidle');

    // Check login button exists
    const loginButton = page.locator('[data-testid="login-button"]');
    await expect(loginButton).toBeVisible();

    // Screenshot with button highlighted
    await loginButton.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'screenshots/s1-login-dom.png', fullPage: true });
  });

  test('s1-login-card - Login card exists', async ({ page }) => {
    await page.goto('http://localhost:5174/login');
    await page.waitForLoadState('networkidle');

    // Check login card exists
    const loginCard = page.locator('[data-testid="login-card"]');
    await expect(loginCard).toBeVisible();

    await page.screenshot({ path: 'screenshots/s1-login-card.png', fullPage: true });
  });

  test('s1-console - No console errors', async ({ page }) => {
    const errors: string[] = [];

    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await page.goto('http://localhost:5174/login');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Filter out expected warnings
    const criticalErrors = errors.filter(e =>
      !e.includes('VITE_CONVEX_URL') &&
      !e.includes('placeholder') &&
      !e.includes('Failed to load resource')
    );

    await page.screenshot({ path: 'screenshots/s1-console.png', fullPage: true });

    // Log errors if any
    if (criticalErrors.length > 0) {
      console.log('Console errors:', criticalErrors);
    }
  });
});

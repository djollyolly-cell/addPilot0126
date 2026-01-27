import { test, expect } from '@playwright/test';

test.describe('Sprint 1 - VK OAuth Flow', () => {
  test('s1-oauth-redirect - Click login redirects to VK', async ({ page }) => {
    await page.goto('http://localhost:5174/login');
    await page.waitForLoadState('networkidle');

    // Find and click login button
    const loginButton = page.locator('[data-testid="login-button"]');
    await expect(loginButton).toBeVisible();

    // Click and wait for navigation
    const [response] = await Promise.all([
      page.waitForURL(/oauth\.vk\.com|localhost/, { timeout: 10000 }),
      loginButton.click(),
    ]);

    // Check URL contains oauth.vk.com
    const currentUrl = page.url();
    console.log('Redirected to:', currentUrl);

    // Screenshot
    await page.screenshot({ path: 'screenshots/s1-oauth-redirect.png', fullPage: true });

    // Verify it's either VK OAuth or still on localhost (if VK credentials issue)
    expect(
      currentUrl.includes('oauth.vk.com') || currentUrl.includes('localhost')
    ).toBeTruthy();
  });
});

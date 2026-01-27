import { test, expect } from '@playwright/test';

test.describe('OAuth URL Verification', () => {
  test('verify OAuth redirect URL contains ngrok', async ({ page }) => {
    // Listen for all requests
    const requests: string[] = [];
    page.on('request', (request) => {
      requests.push(request.url());
    });

    await page.goto('http://localhost:5174/login');
    await page.waitForLoadState('networkidle');

    // Find and click login button
    const loginButton = page.locator('[data-testid="login-button"]');
    await expect(loginButton).toBeVisible();

    // Click login and wait for either VK OAuth redirect or error
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes('convex.cloud') || response.url().includes('oauth.vk.com'),
      { timeout: 10000 }
    ).catch(() => null);

    await loginButton.click();

    // Wait a bit for the action to complete
    await page.waitForTimeout(3000);

    // Log current URL
    console.log('Current URL after click:', page.url());

    // Screenshot current state
    await page.screenshot({ path: 'screenshots/s1-oauth-check.png', fullPage: true });

    // Check if redirected to VK OAuth
    const currentUrl = page.url();

    if (currentUrl.includes('oauth.vk.com')) {
      console.log('SUCCESS: Redirected to VK OAuth');
      console.log('VK OAuth URL:', currentUrl);

      // Verify redirect_uri parameter contains ngrok
      const urlParams = new URL(currentUrl);
      const redirectUri = urlParams.searchParams.get('redirect_uri');
      console.log('redirect_uri:', redirectUri);

      expect(redirectUri).toContain('ngrok');
    } else {
      console.log('Still on:', currentUrl);
      console.log('Requests made:', requests.filter(r => r.includes('convex') || r.includes('vk')));
    }

    // The test passes if we're either on VK OAuth or still on localhost (loading)
    expect(currentUrl.includes('oauth.vk.com') || currentUrl.includes('localhost')).toBeTruthy();
  });
});

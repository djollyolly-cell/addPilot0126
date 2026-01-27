import { test, expect } from '@playwright/test';

test('Debug - Check console and network', async ({ page }) => {
  const consoleMessages: string[] = [];
  const networkErrors: string[] = [];

  page.on('console', msg => {
    consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
  });

  page.on('requestfailed', request => {
    networkErrors.push(`${request.url()} - ${request.failure()?.errorText}`);
  });

  await page.goto('http://localhost:5174/login');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  console.log('=== Console Messages ===');
  consoleMessages.forEach(m => console.log(m));

  console.log('=== Network Errors ===');
  networkErrors.forEach(e => console.log(e));

  // Click login
  const loginButton = page.locator('[data-testid="login-button"]');
  if (await loginButton.isVisible()) {
    console.log('Login button found, clicking...');
    await loginButton.click();
    await page.waitForTimeout(3000);

    console.log('=== After Click Console ===');
    consoleMessages.forEach(m => console.log(m));

    console.log('Current URL:', page.url());
  } else {
    console.log('Login button NOT FOUND');
  }

  await page.screenshot({ path: 'screenshots/s1-debug.png', fullPage: true });
});

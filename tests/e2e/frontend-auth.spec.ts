import { test, expect } from '@playwright/test';

test('Check frontend auth flow', async ({ page }) => {
  // Go to frontend
  await page.goto('http://localhost:5173');
  await page.waitForLoadState('networkidle');

  // Screenshot landing
  await page.screenshot({ path: 'tests/screenshots/frontend-01-landing.png' });

  // Click on auth button
  const authButton = page.locator('button:has-text("Подключить"), a:has-text("Подключить"), button:has-text("Войти"), a:has-text("Войти")').first();

  if (await authButton.isVisible()) {
    await authButton.click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'tests/screenshots/frontend-02-after-auth-click.png' });
  }

  // Try to navigate to dashboard directly
  await page.goto('http://localhost:5173/dashboard');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'tests/screenshots/frontend-03-dashboard.png' });

  // Try login page
  await page.goto('http://localhost:5173/login');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'tests/screenshots/frontend-04-login.png' });

  console.log('Auth flow check completed');
});

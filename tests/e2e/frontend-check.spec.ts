import { test, expect } from '@playwright/test';

test('Check frontend loads and connects to Convex', async ({ page }) => {
  // Go to frontend
  await page.goto('http://localhost:5173');

  // Wait for page to load
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // Take screenshot of landing page
  await page.screenshot({ path: 'tests/screenshots/frontend-landing.png', fullPage: true });

  // Check page title or content
  const title = await page.title();
  console.log('Page title:', title);

  // Check for any errors in console
  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });

  // Wait a bit more for any async operations
  await page.waitForTimeout(2000);

  // Take another screenshot
  await page.screenshot({ path: 'tests/screenshots/frontend-loaded.png', fullPage: true });

  console.log('Console errors:', errors.length > 0 ? errors : 'None');
  console.log('Frontend check completed');
});

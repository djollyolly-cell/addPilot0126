import { test, expect } from '@playwright/test';

test('Check Convex connection', async ({ page }) => {
  const consoleMessages: string[] = [];
  const consoleErrors: string[] = [];

  page.on('console', msg => {
    const text = msg.text();
    consoleMessages.push(`[${msg.type()}] ${text}`);
    if (msg.type() === 'error') {
      consoleErrors.push(text);
    }
  });

  // Go to frontend
  await page.goto('http://localhost:5173');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000);

  // Check network requests to Convex
  const convexRequests: string[] = [];
  page.on('request', request => {
    if (request.url().includes('localhost:3210') || request.url().includes('convex')) {
      convexRequests.push(`${request.method()} ${request.url()}`);
    }
  });

  // Navigate to trigger Convex queries
  await page.goto('http://localhost:5173/login');
  await page.waitForTimeout(3000);

  console.log('\n=== Console Messages ===');
  consoleMessages.forEach(m => console.log(m));

  console.log('\n=== Console Errors ===');
  console.log(consoleErrors.length > 0 ? consoleErrors.join('\n') : 'No errors');

  console.log('\n=== Convex Requests ===');
  console.log(convexRequests.length > 0 ? convexRequests.join('\n') : 'No Convex requests detected');

  await page.screenshot({ path: 'tests/screenshots/frontend-convex-check.png' });
});

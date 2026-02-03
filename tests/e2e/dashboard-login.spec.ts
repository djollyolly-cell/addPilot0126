import { test, expect } from '@playwright/test';

test('Login to Convex Dashboard with admin key', async ({ page }) => {
  const DEPLOYMENT_URL = 'http://localhost:4210';
  const ADMIN_KEY = 'convex-self-hosted|012c93ccdfc286acc637d8f676dd0e68e1b0fced67773fb46dad5569c93260acd8fc531c26';

  // Go to Dashboard (PROD on port 7791)
  await page.goto('http://localhost:7791');

  // Wait for page to load
  await page.waitForLoadState('networkidle');

  // Take screenshot before login
  await page.screenshot({ path: 'tests/screenshots/dashboard-before-login.png' });

  // Fill Deployment URL field
  const deploymentUrlInput = page.locator('input').first();
  await deploymentUrlInput.waitFor({ timeout: 10000 });
  await deploymentUrlInput.clear();
  await deploymentUrlInput.fill(DEPLOYMENT_URL);

  // Fill Admin Key field
  const adminKeyInput = page.locator('input').nth(1);
  await adminKeyInput.fill(ADMIN_KEY);

  // Wait for button to be enabled
  await page.waitForTimeout(500);

  // Click Log In button
  const loginButton = page.locator('button:has-text("Log In")');
  await loginButton.click({ timeout: 10000 });

  // Wait for dashboard to load
  await page.waitForTimeout(2000);

  // Take screenshot after login
  await page.screenshot({ path: 'tests/screenshots/dashboard-health.png' });

  // Check Data tab
  await page.click('text=Data');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'tests/screenshots/dashboard-data.png' });

  // Check Functions tab
  await page.click('text=Functions');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'tests/screenshots/dashboard-functions.png' });

  // Check Logs tab
  await page.click('text=Logs');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'tests/screenshots/dashboard-logs.png' });

  console.log('Dashboard verification completed');
});

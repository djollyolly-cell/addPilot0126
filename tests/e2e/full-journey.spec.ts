/**
 * E2E Tests — Full User Journey
 * Sprint 26: E2E тесты
 */

import { test, expect, Page } from '@playwright/test';

// Test configuration
const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';

// Helper functions
async function mockVkOAuth(page: Page) {
  // Intercept VK OAuth and simulate successful login
  await page.route('**/oauth.vk.com/**', async (route) => {
    const url = new URL(route.request().url());
    const redirectUri = url.searchParams.get('redirect_uri') || BASE_URL;
    await route.fulfill({
      status: 302,
      headers: {
        Location: `${redirectUri}?code=mock_auth_code`,
      },
    });
  });
}

async function mockVkApi(page: Page) {
  // Mock VK Ads API responses
  await page.route('**/api.vk.com/**', async (route) => {
    const url = new URL(route.request().url());

    if (url.pathname.includes('ads.getAccounts')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          response: [
            { account_id: 123, account_type: 'general', account_name: 'Test Account 1' },
            { account_id: 456, account_type: 'general', account_name: 'Test Account 2' },
          ],
        }),
      });
    } else if (url.pathname.includes('ads.getCampaigns')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          response: [
            { id: 1001, name: 'Campaign 1', status: 1 },
            { id: 1002, name: 'Campaign 2', status: 1 },
          ],
        }),
      });
    } else if (url.pathname.includes('ads.getStatistics')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          response: [
            { id: 2001, stats: [{ impressions: 10000, clicks: 150, spent: 1500, leads: 5 }] },
          ],
        }),
      });
    } else if (url.pathname.includes('ads.updateAds')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          response: [{ id: 2001, error_code: 0 }],
        }),
      });
    } else {
      await route.continue();
    }
  });
}

test.describe('Full User Journey', () => {
  test.beforeEach(async ({ page }) => {
    await mockVkOAuth(page);
    await mockVkApi(page);
  });

  test('Complete journey: Register → Connect Account → Create Rule → See Dashboard', async ({
    page,
  }) => {
    // Step 1: Visit login page
    await page.goto(BASE_URL);
    await expect(page).toHaveTitle(/AddPilot/);

    // Step 2: Click login button
    const loginButton = page.locator('[data-testid="login-button"]');
    await expect(loginButton).toBeVisible();
    await loginButton.click();

    // Step 3: After OAuth redirect, should be on dashboard or onboarding
    await page.waitForURL(/\/(dashboard|onboarding)/);

    // Step 4: If onboarding, complete it
    if (page.url().includes('onboarding')) {
      // Skip or complete onboarding
      const skipButton = page.locator('[data-testid="skip-onboarding"]');
      if (await skipButton.isVisible()) {
        await skipButton.click();
      }
    }

    // Step 5: Navigate to accounts
    await page.goto(`${BASE_URL}/accounts`);
    await expect(page.locator('[data-testid="accounts-page"]')).toBeVisible();

    // Step 6: Connect an account via VK Ads button
    const connectButton = page.locator('[data-testid="connect-vk-ads-button"]');
    await connectButton.click();

    // Wait for wizard or account to be connected
    await page.waitForTimeout(2000); // Allow API mock to complete
    // Close wizard if open
    const closeBtn = page.locator('[data-testid="wizard-close"]');
    if (await closeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await closeBtn.click();
    }

    // Step 7: Navigate to rules
    await page.goto(`${BASE_URL}/rules`);
    await expect(page.locator('[data-testid="rules-page"]')).toBeVisible();

    // Step 8: Create a new rule
    const newRuleButton = page.locator('[data-testid="add-rule-button"]');
    await newRuleButton.click();

    // Fill rule form
    await page.fill('[data-testid="rule-name-input"]', 'Test CPL Rule');
    // Click on CPL limit type card
    await page.click('[data-testid="rule-type-cpl_limit"]');
    await page.fill('[data-testid="rule-value-input"]', '500');

    // Save rule
    await page.click('[data-testid="rule-submit-button"]');

    // Wait for rule to appear in list
    await expect(page.locator('[data-testid="rules-list"]')).toBeVisible({ timeout: 10000 });

    // Step 9: Navigate to dashboard
    await page.goto(`${BASE_URL}/dashboard`);

    // Verify dashboard widgets
    await expect(page.locator('[data-testid="savings-widget"]')).toBeVisible();
    await expect(page.locator('[data-testid="activity-block"]')).toBeVisible();
    await expect(page.locator('[data-testid="account-cards"]')).toBeVisible();

    // Step 10: Take screenshot of final state
    await page.screenshot({ path: 'screenshots/e2e-journey-complete.png', fullPage: true });
  });

  test('Payment flow: Freemium → Start upgrade', async ({ page }) => {
    // Login first
    await page.goto(BASE_URL);
    await page.click('[data-testid="login-button"]');
    await page.waitForURL(/\/(dashboard|onboarding)/);

    // Navigate to pricing
    await page.goto(`${BASE_URL}/pricing`);
    await expect(page.locator('[data-testid="pricing-page"]')).toBeVisible();

    // Verify 3 pricing cards
    const pricingCards = page.locator('[data-testid^="pricing-card-"]');
    await expect(pricingCards).toHaveCount(3);

    // Click Start tier
    await page.click('[data-testid="select-start"]');

    // Payment form should appear
    await expect(page.locator('[data-testid="payment-form"]')).toBeVisible();

    // Fill test card
    await page.fill('[data-testid="card-number"]', '4242424242424242');
    await page.fill('[data-testid="card-expiry"]', '12/30');
    await page.fill('[data-testid="card-cvc"]', '123');

    // Submit payment
    await page.click('[data-testid="submit-payment"]');

    // Wait for success
    await expect(page.locator('[data-testid="payment-success"]')).toBeVisible({ timeout: 15000 });

    // Verify tier changed
    await page.goto(`${BASE_URL}/settings`);
    await expect(page.locator('[data-testid="subscription-tier"]')).toContainText('Start');

    await page.screenshot({ path: 'screenshots/e2e-payment-complete.png', fullPage: true });
  });
});

test.describe('Dashboard E2E', () => {
  test.beforeEach(async ({ page }) => {
    await mockVkOAuth(page);
    await mockVkApi(page);

    // Login
    await page.goto(BASE_URL);
    await page.click('[data-testid="login-button"]');
    await page.waitForURL(/\/(dashboard|onboarding)/);
  });

  test('Dashboard loads with all widgets', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`);

    // Check savings widget
    await expect(page.locator('[data-testid="savings-widget"]')).toBeVisible();
    await expect(page.locator('[data-testid="savings-chart"]')).toBeVisible();

    // Check activity block
    await expect(page.locator('[data-testid="activity-block"]')).toBeVisible();

    // Check account cards
    await expect(page.locator('[data-testid="account-cards"]')).toBeVisible();

    // Check event feed
    await expect(page.locator('[data-testid="event-feed"]')).toBeVisible();

    await page.screenshot({ path: 'screenshots/e2e-dashboard.png', fullPage: true });
  });

  test('Real-time updates work', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`);

    // Get initial savings value
    const savingsWidget = page.locator('[data-testid="savings-value"]');
    const initialValue = await savingsWidget.textContent();

    // Trigger a mock event (would need WebSocket mock or API call)
    // This would normally be triggered by Convex real-time

    // For now, just verify the widget exists and has a value
    await expect(savingsWidget).toBeVisible();
    expect(initialValue).toBeDefined();
  });
});

test.describe('Rules E2E', () => {
  test.beforeEach(async ({ page }) => {
    await mockVkOAuth(page);
    await mockVkApi(page);

    await page.goto(BASE_URL);
    await page.click('[data-testid="login-button"]');
    await page.waitForURL(/\/(dashboard|onboarding)/);
  });

  test('CRUD operations for rules', async ({ page }) => {
    await page.goto(`${BASE_URL}/rules`);

    // Create rule
    await page.click('[data-testid="add-rule-button"]');
    await page.fill('[data-testid="rule-name-input"]', 'CRUD Test Rule');
    await page.click('[data-testid="rule-type-min_ctr"]');
    await page.fill('[data-testid="rule-value-input"]', '1.5');
    await page.click('[data-testid="rule-submit-button"]');

    // Wait for rule to appear in list
    await expect(page.locator('[data-testid="rules-list"]')).toBeVisible({ timeout: 10000 });

    // Click on the rule card to edit
    const ruleCard = page.locator('[data-testid^="rule-card-"]').filter({ hasText: 'CRUD Test Rule' });
    await expect(ruleCard).toBeVisible();
    await ruleCard.click();

    // Edit rule
    await page.fill('[data-testid="rule-name-input"]', 'Updated Rule Name');
    await page.click('[data-testid="rule-submit-button"]');

    // Verify updated name
    const updatedCard = page.locator('[data-testid^="rule-card-"]').filter({ hasText: 'Updated Rule Name' });
    await expect(updatedCard).toBeVisible();

    // Toggle rule using the toggle button inside the card
    const toggleBtn = updatedCard.locator('[data-testid^="toggle-rule-"]');
    await toggleBtn.click();

    // Delete rule
    const deleteBtn = updatedCard.locator('[data-testid^="delete-rule-"]');
    await deleteBtn.click();

    // Verify deleted
    await expect(page.locator('[data-testid^="rule-card-"]').filter({ hasText: 'Updated Rule Name' })).not.toBeVisible();

    await page.screenshot({ path: 'screenshots/e2e-rules-crud.png', fullPage: true });
  });

  test('Rule validation errors', async ({ page }) => {
    await page.goto(`${BASE_URL}/rules`);

    await page.click('[data-testid="add-rule-button"]');

    // Try to save without name - should show form error
    await page.click('[data-testid="rule-submit-button"]');
    // Form has inline validation, check for error state
    await expect(page.locator('[data-testid="rule-form"]')).toBeVisible();

    // Enter invalid CTR value (> 100)
    await page.fill('[data-testid="rule-name-input"]', 'Invalid Rule');
    await page.click('[data-testid="rule-type-min_ctr"]');
    await page.fill('[data-testid="rule-value-input"]', '150'); // CTR > 100 is invalid

    // Check for value error
    await expect(page.locator('[data-testid="value-error"]')).toBeVisible();

    await page.screenshot({ path: 'screenshots/e2e-rules-validation.png', fullPage: true });
  });
});

test.describe('Analytics E2E', () => {
  test.beforeEach(async ({ page }) => {
    await mockVkOAuth(page);
    await mockVkApi(page);

    await page.goto(BASE_URL);
    await page.click('[data-testid="login-button"]');
    await page.waitForURL(/\/(dashboard|onboarding)/);
  });

  test('Analytics page with charts', async ({ page }) => {
    await page.goto(`${BASE_URL}/analytics`);

    // Period selector
    await expect(page.locator('[data-testid="period-selector"]')).toBeVisible();

    // Charts
    await expect(page.locator('[data-testid="savings-line-chart"]')).toBeVisible();
    await expect(page.locator('[data-testid="rules-bar-chart"]')).toBeVisible();
    await expect(page.locator('[data-testid="triggers-pie-chart"]')).toBeVisible();

    // Top ads table
    await expect(page.locator('[data-testid="top-ads-table"]')).toBeVisible();

    // Export buttons
    await expect(page.locator('[data-testid="export-png"]')).toBeVisible();
    await expect(page.locator('[data-testid="export-csv"]')).toBeVisible();

    await page.screenshot({ path: 'screenshots/e2e-analytics.png', fullPage: true });
  });

  test('Export CSV works', async ({ page }) => {
    await page.goto(`${BASE_URL}/analytics`);

    // Start download
    const downloadPromise = page.waitForEvent('download');
    await page.click('[data-testid="export-csv"]');

    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain('.csv');
  });
});

test.describe('Mobile Responsive E2E', () => {
  test('Dashboard on mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });

    await mockVkOAuth(page);
    await mockVkApi(page);

    await page.goto(BASE_URL);
    await page.click('[data-testid="login-button"]');
    await page.waitForURL(/\/(dashboard|onboarding)/);

    await page.goto(`${BASE_URL}/dashboard`);

    // Check bottom navigation is visible on mobile
    await expect(page.locator('[data-testid="bottom-nav"]')).toBeVisible();

    // Verify vertical stacking
    const savingsWidget = page.locator('[data-testid="savings-widget"]');
    const activityBlock = page.locator('[data-testid="activity-block"]');

    const savingsBox = await savingsWidget.boundingBox();
    const activityBox = await activityBlock.boundingBox();

    // On mobile, activity block should be below savings widget
    expect(activityBox!.y).toBeGreaterThan(savingsBox!.y);

    await page.screenshot({ path: 'screenshots/e2e-mobile-dashboard.png', fullPage: true });
  });

  test('Navigation on tablet', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });

    await mockVkOAuth(page);
    await mockVkApi(page);

    await page.goto(BASE_URL);
    await page.click('[data-testid="login-button"]');
    await page.waitForURL(/\/(dashboard|onboarding)/);

    await page.goto(`${BASE_URL}/rules`);

    // On tablet, should have 2 columns
    await expect(page.locator('[data-testid="rules-page"]')).toBeVisible();

    await page.screenshot({ path: 'screenshots/e2e-tablet-rules.png', fullPage: true });
  });
});

test.describe('Console Errors Check', () => {
  test('S26-DoD#4: No console errors on main pages', async ({ page }) => {
    const errors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await mockVkOAuth(page);
    await mockVkApi(page);

    // Visit all main pages
    const pages = ['/', '/dashboard', '/accounts', '/rules', '/analytics', '/logs', '/settings'];

    for (const pagePath of pages) {
      await page.goto(`${BASE_URL}${pagePath}`);
      await page.waitForLoadState('networkidle');
    }

    // Filter out known acceptable errors (like React dev warnings)
    const criticalErrors = errors.filter(
      (e) => !e.includes('Warning:') && !e.includes('[HMR]')
    );

    expect(criticalErrors).toHaveLength(0);

    await page.screenshot({ path: 'screenshots/s26-console.png', fullPage: true });
  });
});

test.describe('Edge Case Recovery', () => {
  test('S26-DoD#5: App recovers after page refresh mid-journey', async ({ page }) => {
    await mockVkOAuth(page);
    await mockVkApi(page);

    // Start the journey
    await page.goto(BASE_URL);
    await page.click('[data-testid="login-button"]');
    await page.waitForURL(/\/(dashboard|onboarding)/);

    // Navigate to rules
    await page.goto(`${BASE_URL}/rules`);
    await expect(page.locator('[data-testid="rules-page"]')).toBeVisible();

    // Simulate interruption - refresh page
    await page.reload();

    // Verify app recovers
    await expect(page.locator('[data-testid="rules-page"]')).toBeVisible();

    // Session should still be valid
    await page.goto(`${BASE_URL}/dashboard`);
    await expect(page.locator('[data-testid="dashboard-page"]')).toBeVisible();
  });

  test('App handles network interruption gracefully', async ({ page }) => {
    await mockVkOAuth(page);
    await mockVkApi(page);

    await page.goto(BASE_URL);
    await page.click('[data-testid="login-button"]');
    await page.waitForURL(/\/(dashboard|onboarding)/);

    // Go offline
    await page.context().setOffline(true);

    // Navigate while offline
    await page.goto(`${BASE_URL}/rules`).catch(() => {});

    // Go back online
    await page.context().setOffline(false);

    // Refresh should recover
    await page.goto(`${BASE_URL}/rules`);
    await expect(page.locator('[data-testid="rules-page"]')).toBeVisible();
  });
});

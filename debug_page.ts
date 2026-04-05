import { chromium } from '@playwright/test';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

  try {
    await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
    await page.screenshot({ path: 'debug_screenshot.png', fullPage: true });
    console.log('Screenshot saved to debug_screenshot.png');
  } catch (error) {
    console.error('Error capturing page:', error);
  } finally {
    await browser.close();
  }
})();

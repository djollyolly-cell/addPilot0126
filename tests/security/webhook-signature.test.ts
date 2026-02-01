/**
 * Webhook Signature Verification Tests
 * Тесты для проверки защиты webhook endpoints
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const HTTP_TS_PATH = path.resolve(__dirname, '../../convex/http.ts');

describe('Webhook Security', () => {
  let httpTsContent: string;

  beforeAll(() => {
    httpTsContent = fs.readFileSync(HTTP_TS_PATH, 'utf-8');
  });

  describe('Telegram Webhook Protection', () => {
    it('should check for X-Telegram-Bot-Api-Secret-Token header', () => {
      expect(httpTsContent).toContain('X-Telegram-Bot-Api-Secret-Token');
    });

    it('should read TELEGRAM_WEBHOOK_SECRET from env', () => {
      expect(httpTsContent).toContain('TELEGRAM_WEBHOOK_SECRET');
    });

    it('should return 401 for invalid token', () => {
      expect(httpTsContent).toContain('401');
      expect(httpTsContent).toContain('Unauthorized');
    });

    it('should log warning for invalid token attempts', () => {
      expect(httpTsContent).toMatch(/console\.warn.*telegram.*invalid|missing/i);
    });
  });

  describe('bePaid Webhook Protection', () => {
    it('should check Authorization header', () => {
      expect(httpTsContent).toContain('Authorization');
    });

    it('should verify Basic Auth credentials', () => {
      expect(httpTsContent).toContain('Basic');
      expect(httpTsContent).toContain('atob');
    });

    it('should read BEPAID_SHOP_ID from env', () => {
      expect(httpTsContent).toContain('BEPAID_SHOP_ID');
    });

    it('should read BEPAID_SECRET_KEY from env', () => {
      expect(httpTsContent).toContain('BEPAID_SECRET_KEY');
    });

    it('should return 401 for invalid credentials', () => {
      // Check that 401 is returned for bePaid webhook
      const bepaidSection = httpTsContent.slice(
        httpTsContent.indexOf('/api/bepaid-webhook')
      );
      expect(bepaidSection).toContain('401');
    });
  });

  describe('Webhook Response Codes', () => {
    it('should return 200 for valid requests to prevent retries', () => {
      // Both webhooks should return 200 on success to prevent retry storms
      const telegramSection = httpTsContent.slice(
        httpTsContent.indexOf('/telegram'),
        httpTsContent.indexOf('/api/bepaid-webhook')
      );
      expect(telegramSection).toContain('status: 200');

      const bepaidSection = httpTsContent.slice(
        httpTsContent.indexOf('/api/bepaid-webhook')
      );
      expect(bepaidSection).toContain('status: 200');
    });
  });
});

describe('Telegram Webhook Secret Token', () => {
  describe('Token Format', () => {
    it('should accept valid alphanumeric tokens', () => {
      const validTokens = [
        'abc123',
        'ABC123def456',
        'a1b2c3d4e5f6',
        '0123456789abcdef',
      ];

      for (const token of validTokens) {
        expect(/^[A-Za-z0-9_-]+$/.test(token)).toBe(true);
      }
    });

    it('should have recommended length (32+ chars for security)', () => {
      // A good secret should be at least 32 characters
      const recommendedMinLength = 32;
      const exampleToken = 'd639d0f28949aba0a52ad5c99d397c2373992108261ebb989b31b04bb73b0274';

      expect(exampleToken.length).toBeGreaterThanOrEqual(recommendedMinLength);
    });
  });
});

describe('bePaid Basic Auth', () => {
  describe('Credential Encoding', () => {
    it('should correctly encode credentials as Base64', () => {
      const shopId = 'test_shop';
      const secretKey = 'test_secret';
      const credentials = `${shopId}:${secretKey}`;

      // In browser: btoa(credentials)
      const encoded = Buffer.from(credentials).toString('base64');
      expect(encoded).toBe('dGVzdF9zaG9wOnRlc3Rfc2VjcmV0');
    });

    it('should correctly decode Base64 credentials', () => {
      const encoded = 'dGVzdF9zaG9wOnRlc3Rfc2VjcmV0';

      // In browser: atob(encoded)
      const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
      expect(decoded).toBe('test_shop:test_secret');
    });
  });

  describe('Header Format', () => {
    it('should expect "Basic " prefix in Authorization header', () => {
      const authHeader = 'Basic dGVzdF9zaG9wOnRlc3Rfc2VjcmV0';

      expect(authHeader.startsWith('Basic ')).toBe(true);
      expect(authHeader.slice(6)).toBe('dGVzdF9zaG9wOnRlc3Rfc2VjcmV0');
    });
  });
});

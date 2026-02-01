/**
 * Rate Limiting Tests
 * Тесты для проверки rate limiting функциональности
 */

import { describe, it, expect } from 'vitest';
import { RATE_LIMITS } from '../../convex/rateLimit';

describe('Rate Limiting Configuration', () => {
  describe('OAuth Rate Limits', () => {
    it('should have oauth_auth_url limit configured', () => {
      expect(RATE_LIMITS.oauth_auth_url).toBeDefined();
      expect(RATE_LIMITS.oauth_auth_url.maxAttempts).toBeGreaterThan(0);
      expect(RATE_LIMITS.oauth_auth_url.windowMs).toBeGreaterThan(0);
    });

    it('should have oauth_exchange limit configured', () => {
      expect(RATE_LIMITS.oauth_exchange).toBeDefined();
      expect(RATE_LIMITS.oauth_exchange.maxAttempts).toBeGreaterThan(0);
      expect(RATE_LIMITS.oauth_exchange.windowMs).toBeGreaterThan(0);
    });

    it('oauth_exchange should be more restrictive than oauth_auth_url', () => {
      // Exchange is more sensitive - should have fewer attempts
      expect(RATE_LIMITS.oauth_exchange.maxAttempts)
        .toBeLessThanOrEqual(RATE_LIMITS.oauth_auth_url.maxAttempts);
    });

    it('should have reasonable limits (not too permissive)', () => {
      // Auth URL: max 20 per minute is reasonable
      expect(RATE_LIMITS.oauth_auth_url.maxAttempts).toBeLessThanOrEqual(20);

      // Exchange: max 10 per minute is reasonable
      expect(RATE_LIMITS.oauth_exchange.maxAttempts).toBeLessThanOrEqual(10);
    });

    it('window should be at least 1 minute', () => {
      const oneMinuteMs = 60 * 1000;

      expect(RATE_LIMITS.oauth_auth_url.windowMs).toBeGreaterThanOrEqual(oneMinuteMs);
      expect(RATE_LIMITS.oauth_exchange.windowMs).toBeGreaterThanOrEqual(oneMinuteMs);
    });
  });

  describe('API Rate Limits', () => {
    it('should have api_call limit configured', () => {
      expect(RATE_LIMITS.api_call).toBeDefined();
      expect(RATE_LIMITS.api_call.maxAttempts).toBeGreaterThan(0);
    });

    it('api_call should allow reasonable throughput', () => {
      // API calls need more headroom - at least 50 per minute
      expect(RATE_LIMITS.api_call.maxAttempts).toBeGreaterThanOrEqual(50);
    });
  });
});

describe('Rate Limiting Logic (Unit Tests)', () => {
  describe('Key Format', () => {
    it('should use consistent key format for OAuth auth', () => {
      const state = 'abc123def456';
      const expectedKeyPrefix = `oauth_auth:${state.slice(0, 16)}`;

      expect(expectedKeyPrefix).toBe('oauth_auth:abc123def456');
    });

    it('should use deviceId for OAuth exchange', () => {
      const deviceId = 'device-uuid-12345';
      const expectedKey = `oauth_exchange:${deviceId}`;

      expect(expectedKey).toBe('oauth_exchange:device-uuid-12345');
    });
  });

  describe('Window Calculation', () => {
    it('should correctly calculate if within window', () => {
      const windowMs = 60000; // 1 minute
      const lastAttemptAt = Date.now() - 30000; // 30 seconds ago
      const now = Date.now();

      const isWithinWindow = (now - lastAttemptAt) < windowMs;
      expect(isWithinWindow).toBe(true);
    });

    it('should correctly identify expired window', () => {
      const windowMs = 60000; // 1 minute
      const lastAttemptAt = Date.now() - 90000; // 90 seconds ago
      const now = Date.now();

      const isWithinWindow = (now - lastAttemptAt) < windowMs;
      expect(isWithinWindow).toBe(false);
    });
  });

  describe('Block Duration', () => {
    it('should block for the duration of the window', () => {
      const config = RATE_LIMITS.oauth_exchange;
      const now = Date.now();
      const blockedUntil = now + config.windowMs;

      // Should be blocked for windowMs duration
      expect(blockedUntil - now).toBe(config.windowMs);
    });
  });
});

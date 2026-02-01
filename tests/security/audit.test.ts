/**
 * Security Audit Tests
 * Проверка отсутствия секретов в коде и правильной конфигурации .gitignore
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT_DIR = path.resolve(__dirname, '../..');

// Patterns that might indicate secrets in code
const SECRET_PATTERNS = [
  /(['"])sk[-_]live[-_][a-zA-Z0-9]{20,}\1/gi, // Stripe live keys
  /(['"])pk[-_]live[-_][a-zA-Z0-9]{20,}\1/gi, // Stripe public keys
  /(['"])[a-f0-9]{64}\1/gi, // 64-char hex (potential API keys)
  /password\s*[:=]\s*(['"])[^'"]{8,}\1/gi, // Hardcoded passwords
  /api[-_]?key\s*[:=]\s*(['"])[^'"]{16,}\1/gi, // API keys
  /secret\s*[:=]\s*(['"])[^'"]{16,}\1/gi, // Secrets
  /token\s*[:=]\s*(['"])[a-zA-Z0-9_-]{20,}\1/gi, // Tokens
];

// Files/dirs to skip
const SKIP_PATTERNS = [
  'node_modules',
  '.git',
  'dist',
  '.env',
  'package-lock.json',
  '.test.ts', // Test files may have mock secrets
  '.spec.ts',
];

function shouldSkipFile(filePath: string): boolean {
  return SKIP_PATTERNS.some(pattern => filePath.includes(pattern));
}

function scanFileForSecrets(filePath: string): string[] {
  const issues: string[] = [];

  try {
    const content = fs.readFileSync(filePath, 'utf-8');

    for (const pattern of SECRET_PATTERNS) {
      const matches = content.match(pattern);
      if (matches) {
        // Filter out false positives (test values, examples)
        const realMatches = matches.filter(m =>
          !m.includes('your_') &&
          !m.includes('example') &&
          !m.includes('test') &&
          !m.includes('mock') &&
          !m.includes('fake') &&
          !m.includes('process.env')
        );

        if (realMatches.length > 0) {
          issues.push(`${filePath}: Potential secret found - ${pattern.source}`);
        }
      }
    }
  } catch {
    // Ignore read errors
  }

  return issues;
}

function walkDir(dir: string, callback: (filePath: string) => void) {
  try {
    const files = fs.readdirSync(dir);

    for (const file of files) {
      const filePath = path.join(dir, file);

      if (shouldSkipFile(filePath)) continue;

      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        walkDir(filePath, callback);
      } else if (stat.isFile() && /\.(ts|tsx|js|jsx|json)$/.test(file)) {
        callback(filePath);
      }
    }
  } catch {
    // Ignore errors
  }
}

describe('Security Audit', () => {
  describe('Secrets in Code', () => {
    it('should not have hardcoded secrets in source files', () => {
      const issues: string[] = [];

      walkDir(path.join(ROOT_DIR, 'src'), (filePath) => {
        issues.push(...scanFileForSecrets(filePath));
      });

      walkDir(path.join(ROOT_DIR, 'convex'), (filePath) => {
        if (!filePath.includes('.test.')) {
          issues.push(...scanFileForSecrets(filePath));
        }
      });

      expect(issues).toEqual([]);
    });
  });

  describe('.gitignore Configuration', () => {
    it('should have .gitignore file', () => {
      const gitignorePath = path.join(ROOT_DIR, '.gitignore');
      expect(fs.existsSync(gitignorePath)).toBe(true);
    });

    it('should ignore .env files', () => {
      const gitignore = fs.readFileSync(path.join(ROOT_DIR, '.gitignore'), 'utf-8');

      expect(gitignore).toMatch(/\.env/);
    });

    it('should ignore node_modules', () => {
      const gitignore = fs.readFileSync(path.join(ROOT_DIR, '.gitignore'), 'utf-8');

      expect(gitignore).toMatch(/node_modules/);
    });

    it('should ignore dist folder', () => {
      const gitignore = fs.readFileSync(path.join(ROOT_DIR, '.gitignore'), 'utf-8');

      expect(gitignore).toMatch(/dist/);
    });
  });

  describe('Environment Variables', () => {
    it('should have .env.example file', () => {
      const envExamplePath = path.join(ROOT_DIR, '.env.example');
      expect(fs.existsSync(envExamplePath)).toBe(true);
    });

    it('.env.example should not contain real values', () => {
      const envExample = fs.readFileSync(path.join(ROOT_DIR, '.env.example'), 'utf-8');

      // Should contain placeholder values
      expect(envExample).toMatch(/your_|example|placeholder/i);

      // Should NOT contain real-looking keys
      expect(envExample).not.toMatch(/[a-f0-9]{32,}/i);
    });
  });

  describe('Security Headers Configuration', () => {
    it('should have serve.json with security headers', () => {
      const serveJsonPath = path.join(ROOT_DIR, 'serve.json');
      expect(fs.existsSync(serveJsonPath)).toBe(true);

      const serveJson = JSON.parse(fs.readFileSync(serveJsonPath, 'utf-8'));
      expect(serveJson.headers).toBeDefined();

      // Check for essential security headers
      const headerConfig = JSON.stringify(serveJson.headers);
      expect(headerConfig).toContain('X-Frame-Options');
      expect(headerConfig).toContain('X-Content-Type-Options');
      expect(headerConfig).toContain('Content-Security-Policy');
    });
  });
});

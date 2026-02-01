/**
 * CI/CD Configuration Tests
 * Sprint 27 — Docker и CI/CD
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT_DIR = process.cwd();

describe('Sprint 27 - Docker Configuration', () => {
  it('S27-DoD#1: Dockerfile exists and is valid', () => {
    const dockerfilePath = join(ROOT_DIR, 'Dockerfile');
    expect(existsSync(dockerfilePath)).toBe(true);

    const content = readFileSync(dockerfilePath, 'utf-8');

    // Check for multi-stage build
    expect(content).toContain('FROM node:');
    expect(content).toContain('AS deps');
    expect(content).toContain('AS builder');
    expect(content).toContain('AS runner');

    // Check for production optimizations
    expect(content).toContain('NODE_ENV=production');
    expect(content).toContain('EXPOSE 3000');
    expect(content).toContain('HEALTHCHECK');
  });

  it('S27-DoD#2: .dockerignore excludes unnecessary files', () => {
    const dockerignorePath = join(ROOT_DIR, '.dockerignore');
    expect(existsSync(dockerignorePath)).toBe(true);

    const content = readFileSync(dockerignorePath, 'utf-8');

    // Should exclude common directories
    expect(content).toContain('node_modules');
    expect(content).toContain('.git');
    expect(content).toContain('coverage');
    expect(content).toContain('.env');
  });
});

describe('Sprint 27 - GitHub Actions CI', () => {
  it('S27-DoD#3: CI workflow exists', () => {
    const ciPath = join(ROOT_DIR, '.github/workflows/ci.yml');
    expect(existsSync(ciPath)).toBe(true);
  });

  it('CI workflow has required jobs', () => {
    const ciPath = join(ROOT_DIR, '.github/workflows/ci.yml');
    const content = readFileSync(ciPath, 'utf-8');

    // Check for required jobs
    expect(content).toContain('lint:');
    expect(content).toContain('test-unit:');
    expect(content).toContain('build:');
    expect(content).toContain('docker:');
  });

  it('CI workflow triggers on PR', () => {
    const ciPath = join(ROOT_DIR, '.github/workflows/ci.yml');
    const content = readFileSync(ciPath, 'utf-8');

    expect(content).toContain('pull_request:');
    expect(content).toContain('branches: [main');
  });

  it('CI workflow uses correct Node version', () => {
    const ciPath = join(ROOT_DIR, '.github/workflows/ci.yml');
    const content = readFileSync(ciPath, 'utf-8');

    expect(content).toContain("NODE_VERSION: '20'");
  });
});

describe('Sprint 27 - GitHub Actions CD', () => {
  it('S27-DoD#5: Deploy workflow exists', () => {
    const deployPath = join(ROOT_DIR, '.github/workflows/deploy.yml');
    expect(existsSync(deployPath)).toBe(true);
  });

  it('Deploy workflow triggers on main push', () => {
    const deployPath = join(ROOT_DIR, '.github/workflows/deploy.yml');
    const content = readFileSync(deployPath, 'utf-8');

    expect(content).toContain('push:');
    expect(content).toContain('branches: [main]');
  });

  it('Deploy workflow has Vercel integration', () => {
    const deployPath = join(ROOT_DIR, '.github/workflows/deploy.yml');
    const content = readFileSync(deployPath, 'utf-8');

    expect(content).toContain('VERCEL_');
    expect(content).toContain('vercel deploy');
  });

  it('Deploy workflow has Convex deployment', () => {
    const deployPath = join(ROOT_DIR, '.github/workflows/deploy.yml');
    const content = readFileSync(deployPath, 'utf-8');

    expect(content).toContain('convex deploy');
    expect(content).toContain('CONVEX_DEPLOY_KEY');
  });

  it('Deploy workflow has smoke test', () => {
    const deployPath = join(ROOT_DIR, '.github/workflows/deploy.yml');
    const content = readFileSync(deployPath, 'utf-8');

    expect(content).toContain('smoke-test:');
    expect(content).toContain('Health check');
  });
});

describe('Sprint 27 - Package.json Scripts', () => {
  it('Has CI script', () => {
    const packagePath = join(ROOT_DIR, 'package.json');
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8'));

    expect(packageJson.scripts.ci).toBeDefined();
    expect(packageJson.scripts.ci).toContain('lint');
    expect(packageJson.scripts.ci).toContain('test');
    expect(packageJson.scripts.ci).toContain('build');
  });

  it('Has typecheck script', () => {
    const packagePath = join(ROOT_DIR, 'package.json');
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8'));

    expect(packageJson.scripts.typecheck).toBeDefined();
  });

  it('Has convex deploy script', () => {
    const packagePath = join(ROOT_DIR, 'package.json');
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8'));

    expect(packageJson.scripts['convex:deploy']).toBeDefined();
  });
});

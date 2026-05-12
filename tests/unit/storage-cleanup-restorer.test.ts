import { createRequire } from 'module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const restorer = require('../../scripts/storage-cleanup-restorer.cjs');

describe('storage cleanup restorer safety decisions', () => {
  const targetRunId = '1778525039989-605b8ed53962';

  it('restores env only for the matching terminal target row', () => {
    const decision = restorer.getRestorerDecision({
      targetRunId,
      nowMs: 1_000,
      row: {
        runId: targetRunId,
        state: 'completed',
        isActive: false,
      },
    });

    expect(decision).toMatchObject({
      action: 'restore_env',
      reason: 'target_terminal',
      shouldRestoreEnv: true,
      shouldContinue: false,
    });
  });

  it('waits for matching active target row without mutating env', () => {
    const decision = restorer.getRestorerDecision({
      targetRunId,
      nowMs: 1_000,
      row: {
        runId: targetRunId,
        state: 'running',
        isActive: true,
      },
    });

    expect(decision).toMatchObject({
      action: 'wait',
      reason: 'target_not_terminal',
      shouldRestoreEnv: false,
      shouldContinue: true,
    });
  });

  it('does not restore env for a different terminal runId', () => {
    const decision = restorer.getRestorerDecision({
      targetRunId,
      nowMs: 1_000,
      row: {
        runId: 'some-other-run',
        state: 'completed',
        isActive: false,
      },
    });

    expect(decision).toMatchObject({
      action: 'wait',
      reason: 'non_target_row_visible',
      shouldRestoreEnv: false,
      shouldContinue: true,
    });
  });

  it('halts and alerts after failsafe when target row is still active', () => {
    const decision = restorer.getRestorerDecision({
      targetRunId,
      nowMs: 2_500,
      expectedTerminalAtMs: 1_000,
      failsafeBufferMs: 1_000,
      row: {
        runId: targetRunId,
        state: 'running',
        isActive: true,
      },
    });

    expect(decision).toMatchObject({
      action: 'halt_alert',
      reason: 'target_active_after_failsafe',
      shouldRestoreEnv: false,
      shouldContinue: false,
    });
  });

  it('halts and alerts after failsafe when target row is unknown', () => {
    const decision = restorer.getRestorerDecision({
      targetRunId,
      nowMs: 2_500,
      expectedTerminalAtMs: 1_000,
      failsafeBufferMs: 1_000,
      row: undefined,
    });

    expect(decision).toMatchObject({
      action: 'halt_alert',
      reason: 'target_unknown_after_failsafe',
      shouldRestoreEnv: false,
      shouldContinue: false,
    });
  });

  it('finds target row among recent cleanupRunState rows', () => {
    const row = restorer.findTargetRow(
      [
        { runId: 'newer-organic-run', state: 'running', isActive: true },
        { runId: targetRunId, state: 'completed', isActive: false },
      ],
      targetRunId,
    );

    expect(row).toMatchObject({
      runId: targetRunId,
      state: 'completed',
    });
  });
});

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Sync ad metrics every 5 minutes (fan-out: dispatch + per-account workers)
crons.interval(
  "sync-metrics",
  { minutes: 5 },
  internal.syncMetrics.syncDispatch
);

// Daily digest at 06:00 UTC (09:00 MSK)
crons.cron(
  "daily-digest",
  "0 6 * * *",
  internal.telegram.sendDailyDigest
);

// Weekly digest — runs every 30 min, checks user's timezone for Monday 08:30
crons.interval(
  "weekly-digest",
  { minutes: 30 },
  internal.telegram.sendWeeklyDigest
);

// Monthly digest — runs every hour, checks user's timezone for 1st of month 09:00
crons.interval(
  "monthly-digest",
  { hours: 1 },
  internal.telegram.sendMonthlyDigest
);

// Check expiring subscriptions daily at 08:00 UTC (11:00 MSK)
crons.cron(
  "check-expiring-subscriptions",
  "0 8 * * *",
  internal.billing.checkExpiringSubscriptions
);

// Process expired subscriptions hourly (downgrade and update limits)
crons.interval(
  "process-expired-subscriptions",
  { hours: 1 },
  internal.billing.processExpiredSubscriptions
);

// Clean up expired creatives (banners older than 2 days) — every 6 hours
crons.interval(
  "cleanup-expired-creatives",
  { hours: 6 },
  internal.creatives.cleanupExpired
);

// Clean up old AI generation records (older than 35 days, was 60) — daily at 04:00 UTC
crons.cron(
  "cleanup-old-ai-generations",
  "0 4 * * *",
  internal.aiLimits.cleanupOldRecords
);

// Clean up old token history (older than 10 days) — daily at 03:00 UTC
crons.cron(
  "cleanup-credential-history",
  "0 3 * * *",
  internal.credentialHistory.cleanupOldTokenHistory
);

// Analyze video creatives 24h+ after upload, re-analyze every 7 days — every 2 hours
crons.interval(
  "analyze-new-creatives",
  { hours: 2 },
  internal.creativeAnalytics.checkNewCreatives
);

// AI Cabinet: analyze campaigns and generate recommendations every 6 hours
crons.interval(
  "ai-recommendations",
  { hours: 6 },
  internal.aiRecommendations.checkAllCampaigns
);

// UZ budget increase — fan-out: dispatch + per-account workers
// Runs every 5 min to catch budget-exhausted campaigns quickly
crons.interval(
  "uz-budget-increase",
  { minutes: 5 },
  internal.ruleEngine.uzBudgetDispatch
);

// UZ budget reset — every 30 min, checks user timezone for midnight reset
crons.interval(
  "uz-budget-reset",
  { minutes: 30 },
  internal.uzBudgetCron.resetBudgets
);

// Video rotation tick — every 5 minutes, processes all active rotations
crons.interval(
  "video-rotation-tick",
  { minutes: 5 },
  internal.videoRotation.tick
);

// Agency token health check — every 6 hours, test tokens and notify on failure
crons.interval(
  "agency-token-health",
  { hours: 6 },
  internal.adAccounts.checkAgencyTokenHealth
);

// System health check — every 6 hours
crons.cron(
  "system-health-check",
  "0 0,6,12,18 * * *",
  internal.healthCheck.runSystemCheck
);

// Budget health check — every 6 hours, offset 30 min from system check
crons.cron(
  "budget-health-check",
  "30 0,6,12,18 * * *",
  internal.budgetHealthCheck.runBudgetHealthCheck
);

// Function verification — every 12 hours (03:00 and 15:00 UTC)
crons.cron(
  "function-verification",
  "0 3,15 * * *",
  internal.healthCheck.runFunctionCheck
);

// Proactive token refresh — every 2 hours (fan-out), refreshes tokens expiring within 12h
crons.interval(
  "proactive-token-refresh",
  { hours: 2 },
  internal.auth.tokenRefreshDispatch
);

// Cleanup stuck pending payments — every 2 hours
crons.interval(
  "cleanup-stuck-payments",
  { hours: 2 },
  internal.billing.cleanupStuckPayments
);

// Clean up old audit/system logs — daily at 02:00 UTC
crons.cron(
  "cleanup-old-logs",
  "0 2 * * *",
  internal.logCleanup.runDaily
);

// Clean up old actionLogs (older than 90 days) — daily at 02:30 UTC
crons.cron(
  "cleanup-old-action-logs",
  "30 2 * * *",
  internal.logCleanup.cleanupOldActionLogs
);

// Clean up old metricsDaily (older than 90 days) — every 15 min, 500/batch (gradual)
// 48K deletes/day = 3% of metricsRealtime churn. Backlog ~720K clears in ~15 days.
crons.interval(
  "cleanup-old-metrics-daily",
  { minutes: 15 },
  internal.logCleanup.cleanupOldMetricsDaily
);

// Clean up old metricsRealtime records (older than 2 days, was 4) — every 6 hours
crons.cron(
  "cleanup-old-realtime-metrics",
  "0 */6 * * *",
  internal.metrics.cleanupOldRealtimeMetrics,
  {}
);

// VK API throttling probe — every 15 min, batches 30 accounts/run
crons.interval(
  "vk-throttling-probe",
  { minutes: 15 },
  internal.vkApiLimits.probeThrottling
);

// Cleanup expired org invites — daily at 05:30 UTC
crons.cron(
  "cleanup-expired-invites",
  "30 5 * * *",
  internal.orgAuth.cleanupExpiredInvites
);

// Daily load units recalc — 01:00 UTC (04:00 MSK)
crons.cron(
  "load-units-daily",
  "0 1 * * *",
  internal.loadUnits.recalculateAll
);

// Overage detection — 02:00 UTC (after recalculateAll at 01:00)
crons.cron(
  "check-load-overage",
  "0 2 * * *",
  internal.loadUnits.checkOverage
);

// Expired grace progression — daily 03:00 UTC (after overage at 02:00)
// Daily is sufficient: phases are 14/31/15 days. Hourly would waste resources.
crons.cron(
  "progress-expired-grace",
  "0 3 * * *",
  internal.loadUnits.progressExpiredGrace
);

// Cold delete archived org data after 150 days total — daily 04:30 UTC
crons.cron(
  "cold-delete-archived-orgs",
  "30 4 * * *",
  internal.loadUnits.coldDeleteArchived
);

// Daily validation of community profile tokens (VK + Senler) at 04:45 UTC
crons.cron(
  "validate-community-profiles",
  "45 4 * * *",
  internal.communityProfiles.dailyValidateAll
);

export default crons;

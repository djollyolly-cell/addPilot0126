import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Sync ad metrics every 5 minutes
crons.interval(
  "sync-metrics",
  { minutes: 5 },
  internal.syncMetrics.syncAll
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

// Clean up old AI generation records (older than 60 days) — daily at 04:00 UTC
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

// UZ budget increase — independent cron, not tied to syncAll
// Runs every 5 min to catch budget-exhausted campaigns quickly
crons.interval(
  "uz-budget-increase",
  { minutes: 5 },
  internal.ruleEngine.checkUzBudgetRules
);

// UZ budget reset — every 30 min, checks user timezone for midnight reset
crons.interval(
  "uz-budget-reset",
  { minutes: 30 },
  internal.uzBudgetCron.resetBudgets
);

export default crons;

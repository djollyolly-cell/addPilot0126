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

export default crons;

# Service Diagnostic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automated two-cycle monitoring system that checks AdPilot health (crons, tokens, sync, payments) every 6h and verifies all functions per-user (rules, VK API, budgets, leads) every 12h, with Telegram reports and admin UI.

**Architecture:** Convex-native healthCheck.ts orchestrates all checks via internalAction/internalQuery. healthReport.ts formats Telegram messages. External bash ping script on server provides independent uptime monitoring. Admin UI adds diagnostic buttons and result history.

**Tech Stack:** Convex (query/mutation/action), Telegram Bot API, bash/curl (external ping)

**Spec:** `docs/superpowers/specs/2026-04-08-service-diagnostic-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `convex/schema.ts` | Modify | Add `healthCheckResults` table |
| `convex/healthCheck.ts` | Create | All check logic (Cycle 1 + Cycle 2), cron handlers, manual triggers |
| `convex/healthReport.ts` | Create | Telegram message formatting for system/function/user reports |
| `convex/crons.ts` | Modify | Add 2 new cron jobs |
| `src/pages/AdminPage.tsx` | Modify | Diagnostic buttons + results display |
| `scripts/external-ping.sh` | Create | External uptime ping script |

---

### Task 1: Schema — healthCheckResults table

**Files:**
- Modify: `convex/schema.ts:669` (before closing `}, { schemaValidation: false }`)

- [ ] **Step 1: Add healthCheckResults table to schema**

In `convex/schema.ts`, before the closing `}, { schemaValidation: false });`, add:

```typescript
  // Health check results — diagnostic history
  healthCheckResults: defineTable({
    type: v.union(v.literal("system"), v.literal("function"), v.literal("user")),
    targetUserId: v.optional(v.id("users")),
    status: v.union(v.literal("ok"), v.literal("warning"), v.literal("error")),
    summary: v.string(),
    details: v.any(),
    checkedUsers: v.number(),
    checkedAccounts: v.number(),
    checkedRules: v.number(),
    warnings: v.number(),
    errors: v.number(),
    duration: v.number(),
    createdAt: v.number(),
  })
    .index("by_type", ["type", "createdAt"])
    .index("by_createdAt", ["createdAt"]),
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add convex/schema.ts
git commit -m "feat(health): add healthCheckResults table to schema"
```

---

### Task 2: healthReport.ts — Telegram report formatting

**Files:**
- Create: `convex/healthReport.ts`

This file is pure formatting — no DB access, no side effects. Build it first so healthCheck.ts can import it.

- [ ] **Step 1: Create healthReport.ts with type definitions and formatters**

```typescript
// convex/healthReport.ts
// Telegram report formatting for health checks

export type CheckStatus = "ok" | "warning" | "error";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  details?: string[];
}

export interface UserCheckResult {
  userId: string;
  userName: string;
  email: string;
  tier: string;
  accounts: number;
  rules: number;
  status: CheckStatus;
  checks: CheckResult[];
}

export interface SystemReport {
  type: "system";
  status: CheckStatus;
  blocks: CheckResult[];
  warnings: number;
  errors: number;
  duration: number;
}

export interface FunctionReport {
  type: "function" | "user";
  status: CheckStatus;
  users: UserCheckResult[];
  checkedUsers: number;
  checkedAccounts: number;
  checkedRules: number;
  warnings: number;
  errors: number;
  duration: number;
}

const STATUS_ICON: Record<CheckStatus, string> = {
  ok: "\u2705",      // green checkmark
  warning: "\u26a0\ufe0f", // warning sign
  error: "\ud83d\uded1",   // stop sign
};

function overallIcon(status: CheckStatus): string {
  if (status === "error") return "\ud83d\udd34"; // red circle
  if (status === "warning") return "\ud83d\udfe1"; // yellow circle
  return "\ud83d\udfe2"; // green circle
}

export function formatSystemReport(report: SystemReport): string {
  const lines: string[] = [];

  if (report.status === "ok") {
    // Silent when green — return empty to signal "don't send"
    return "";
  }

  const problemCount = report.warnings + report.errors;
  lines.push(
    `${overallIcon(report.status)} <b>Здоровье системы</b> — ${problemCount} ${problemWord(problemCount)}\n`
  );

  for (const block of report.blocks) {
    lines.push(`${STATUS_ICON[block.status]} ${block.name}: ${block.message}`);
    if (block.details && block.status !== "ok") {
      for (const d of block.details.slice(0, 5)) {
        lines.push(`  ${d}`);
      }
    }
  }

  lines.push(`\n\u23f1 ${Math.round(report.duration / 1000)}сек`);
  return lines.join("\n");
}

export function formatFunctionReport(report: FunctionReport): string {
  const lines: string[] = [];
  const now = new Date();
  const dateStr = now.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const timeStr = now.toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  });

  const isUserReport = report.type === "user";

  if (isUserReport && report.users.length === 1) {
    return formatSingleUserReport(report.users[0], report.duration);
  }

  lines.push(
    `\ud83d\udcca <b>Диагностика функций</b> — ${dateStr} ${timeStr}\n`
  );
  lines.push(
    `\ud83d\udc64 Проверено: ${report.checkedUsers} польз., ${report.checkedAccounts} каб., ${report.checkedRules} правил\n`
  );

  for (const u of report.users) {
    const icon = STATUS_ICON[u.status];
    const suffix = u.status === "ok" ? "ок" : `${countProblems(u.checks)} ${problemWord(countProblems(u.checks))}`;
    lines.push(`${icon} ${u.userName} (${u.accounts} каб, ${u.rules} правил) — ${suffix}`);

    if (u.status !== "ok") {
      for (const c of u.checks.filter((ch) => ch.status !== "ok")) {
        lines.push(`  ${STATUS_ICON[c.status]} ${c.message}`);
        if (c.details) {
          for (const d of c.details.slice(0, 3)) {
            lines.push(`    ${d}`);
          }
        }
      }
    }
  }

  lines.push(`\n\u23f1 ${Math.round(report.duration / 1000)}сек`);
  return lines.join("\n");
}

function formatSingleUserReport(u: UserCheckResult, duration: number): string {
  const lines: string[] = [];

  lines.push(`\ud83d\udccb <b>Диагностика: ${u.userName}</b>\n`);
  lines.push(`\ud83d\udc64 Тариф: ${u.tier} | ${u.accounts} каб. | ${u.rules} правил\n`);

  for (const c of u.checks) {
    lines.push(`${STATUS_ICON[c.status]} ${c.message}`);
    if (c.details) {
      for (const d of c.details) {
        lines.push(`  ${d}`);
      }
    }
  }

  lines.push(`\n\u23f1 ${Math.round(duration / 1000)}сек`);
  return lines.join("\n");
}

function countProblems(checks: CheckResult[]): number {
  return checks.filter((c) => c.status !== "ok").length;
}

function problemWord(n: number): string {
  if (n % 10 === 1 && n % 100 !== 11) return "проблема";
  if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) return "проблемы";
  return "проблем";
}

export function worstStatus(statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes("error")) return "error";
  if (statuses.includes("warning")) return "warning";
  return "ok";
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add convex/healthReport.ts
git commit -m "feat(health): add Telegram report formatting"
```

---

### Task 3: healthCheck.ts — Cycle 1 (System Health)

**Files:**
- Create: `convex/healthCheck.ts`

This is the core file. Start with Cycle 1 checks (blocks 1.1-1.6) — internal data only, no VK API.

- [ ] **Step 1: Create healthCheck.ts with imports, helpers, and Cycle 1 blocks**

```typescript
// convex/healthCheck.ts
import { v } from "convex/values";
import {
  query,
  action,
  internalAction,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Id, Doc } from "./_generated/dataModel";
import {
  CheckResult,
  CheckStatus,
  SystemReport,
  FunctionReport,
  UserCheckResult,
  worstStatus,
  formatSystemReport,
  formatFunctionReport,
} from "./healthReport";

// ─── Constants ───

const ADMIN_CHAT_ID = "325307765";
const TIER_LIMITS: Record<string, { accounts: number; rules: number }> = {
  freemium: { accounts: 1, rules: 2 },
  start: { accounts: 3, rules: 10 },
  pro: { accounts: 999, rules: 999 },
};

// ─── Helpers ───

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function hoursAgo(ts: number): number {
  return Math.round((Date.now() - ts) / 3_600_000);
}

function minutesAgo(ts: number): number {
  return Math.round((Date.now() - ts) / 60_000);
}

// ─── Block 1.1: Cron Health (heartbeat + results) ───

export const checkCronHealth = internalQuery({
  args: {},
  handler: async (ctx): Promise<CheckResult> => {
    const heartbeats = await ctx.db.query("cronHeartbeats").collect();
    const issues: string[] = [];
    let status: CheckStatus = "ok";

    const CRON_CONFIGS: Array<{
      name: string;
      label: string;
      maxStaleMin?: number;
    }> = [
      { name: "syncAll", label: "sync-metrics", maxStaleMin: 10 },
      { name: "checkUzBudgetRules", label: "uz-budget-increase", maxStaleMin: 15 },
      { name: "resetBudgets", label: "uz-budget-reset" },
      { name: "sendDailyDigest", label: "daily-digest" },
      { name: "sendWeeklyDigest", label: "weekly-digest" },
      { name: "sendMonthlyDigest", label: "monthly-digest" },
      { name: "checkAgencyTokenHealth", label: "agency-token-health" },
    ];

    for (const cfg of CRON_CONFIGS) {
      const hb = heartbeats.find((h) => h.name === cfg.name);
      if (!hb) continue;

      // Stuck check
      if (hb.status === "running" && minutesAgo(hb.startedAt) > 10) {
        issues.push(`${cfg.label}: STUCK (${minutesAgo(hb.startedAt)} мин)`);
        status = "error";
        continue;
      }

      // Error check
      if (hb.error) {
        issues.push(`${cfg.label}: ошибка — ${hb.error.slice(0, 80)}`);
        status = "error";
        continue;
      }

      // Staleness check
      if (cfg.maxStaleMin && hb.finishedAt && minutesAgo(hb.finishedAt) > cfg.maxStaleMin) {
        issues.push(`${cfg.label}: отстаёт (${minutesAgo(hb.finishedAt)} мин)`);
        if (status === "ok") status = "warning";
      }
    }

    // ── Result verification ──

    // sync-metrics: count synced accounts
    const allAccounts = await ctx.db.query("adAccounts").collect();
    const activeAccounts = allAccounts.filter(
      (a) => a.status === "active" || a.status === "error"
    );
    const now = Date.now();
    const syncedCount = activeAccounts.filter(
      (a) => a.lastSyncAt && now - a.lastSyncAt < 10 * 60_000
    ).length;

    if (activeAccounts.length > 0 && syncedCount < activeAccounts.length) {
      issues.push(
        `sync: ${syncedCount}/${activeAccounts.length} синхронизированы`
      );
      if (status === "ok") status = "warning";
    }

    // uz-budget-reset: check for today's resets
    const today = todayStr();
    const todayStart = new Date(today).getTime();
    const uzRules = await ctx.db.query("rules").collect();
    const resetRules = uzRules.filter(
      (r) =>
        r.type === "uz_budget_manage" &&
        r.isActive &&
        r.conditions.resetDaily === true
    );

    if (resetRules.length > 0) {
      const todayLogs = await ctx.db.query("actionLogs").collect();
      const resetLogs = todayLogs.filter(
        (l) => l.actionType === "budget_reset" && l.createdAt >= todayStart
      );

      for (const rule of resetRules) {
        const ruleResetCount = resetLogs.filter(
          (l) => l.ruleId === rule._id
        ).length;
        const targetCount = rule.targetCampaignIds?.length ?? 0;
        if (targetCount > 0 && ruleResetCount === 0) {
          issues.push(`Ресет "${rule.name}": не выполнен (0/${targetCount})`);
          status = "error";
        } else if (targetCount > 0 && ruleResetCount < targetCount) {
          issues.push(
            `Ресет "${rule.name}": частичный (${ruleResetCount}/${targetCount})`
          );
          status = "error";
        }
      }
    }

    // daily-digest: check sent
    const digestHb = heartbeats.find((h) => h.name === "sendDailyDigest");
    if (digestHb?.finishedAt && digestHb.finishedAt >= todayStart) {
      const settings = await ctx.db.query("userSettings").collect();
      const digestUsers = settings.filter((s) => s.digestEnabled);
      const sentNotifs = await ctx.db
        .query("notifications")
        .withIndex("by_status")
        .collect();
      const todayDigests = sentNotifs.filter(
        (n) =>
          n.type === "digest" &&
          n.createdAt >= todayStart &&
          n.status === "sent"
      );

      if (digestUsers.length > 0 && todayDigests.length === 0) {
        issues.push(
          `Дайджест: ${digestUsers.length} пользователей ожидали, 0 отправлено`
        );
        if (status === "ok") status = "warning";
      }
    }

    const message =
      status === "ok"
        ? `все кроны в норме`
        : `${issues.length} ${issues.length === 1 ? "проблема" : "проблем"}`;

    return {
      name: "Кроны",
      status,
      message,
      details: issues,
    };
  },
});

// ─── Block 1.2: User Token Health ───

export const checkTokenHealth = internalQuery({
  args: {},
  handler: async (ctx): Promise<CheckResult> => {
    const users = await ctx.db.query("users").collect();
    const accounts = await ctx.db.query("adAccounts").collect();
    const usersWithAccounts = users.filter((u) =>
      accounts.some((a) => a.userId === u._id)
    );

    const now = Date.now();
    const DAY = 24 * 3600_000;
    const expired: string[] = [];
    const expiring: string[] = [];
    const noRefresh: string[] = [];

    for (const u of usersWithAccounts) {
      const label = u.name || u.email;
      if (u.vkAdsTokenExpiresAt && u.vkAdsTokenExpiresAt < now) {
        expired.push(`${label}: VK Ads токен истёк ${hoursAgo(u.vkAdsTokenExpiresAt)}ч назад`);
      } else if (u.vkAdsTokenExpiresAt && u.vkAdsTokenExpiresAt < now + DAY) {
        expiring.push(`${label}: VK Ads истекает через ${Math.round((u.vkAdsTokenExpiresAt - now) / 3_600_000)}ч`);
      }
      if (!u.vkAdsRefreshToken && u.vkAdsTokenExpiresAt) {
        noRefresh.push(`${label}: нет refresh token`);
      }
    }

    const issues = [...expired, ...expiring, ...noRefresh];
    let status: CheckStatus = "ok";
    if (expired.length > 0) status = "error";
    else if (expiring.length > 0 || noRefresh.length > 0) status = "warning";

    const total = usersWithAccounts.length;
    const okCount = total - expired.length;
    const message = status === "ok"
      ? `${total}/${total} валидны`
      : expired.length > 0
        ? `${expired.length} истекли, ${okCount}/${total} ок`
        : `${expiring.length} истекают в 24ч`;

    return { name: "Токены", status, message, details: issues };
  },
});

// ─── Block 1.3: Account Sync ───

export const checkAccountSync = internalQuery({
  args: {},
  handler: async (ctx): Promise<CheckResult> => {
    const accounts = await ctx.db.query("adAccounts").collect();
    const users = await ctx.db.query("users").collect();
    const active = accounts.filter((a) => a.status !== "paused");
    const now = Date.now();
    const issues: string[] = [];
    let status: CheckStatus = "ok";

    for (const acc of active) {
      const user = users.find((u) => u._id === acc.userId);
      const label = `"${acc.name}" (${user?.name || user?.email || "?"})`;

      if (acc.status === "error") {
        // Agency-specific diagnostics
        if (
          (acc as any).vitaminCabinetId &&
          acc.lastError?.includes("TOKEN_EXPIRED")
        ) {
          const errHours = acc.lastError
            ? hoursAgo((acc as any).lastErrorAt || acc._creationTime)
            : 0;
          issues.push(
            `${label}: Витамин TOKEN_EXPIRED (${errHours}ч). Проверить VITAMIN_API_KEY и cabinetId`
          );
          status = "error";
          continue;
        }
        issues.push(`${label}: status=error — ${acc.lastError?.slice(0, 60) || "?"}`);
        status = "error";
        continue;
      }

      if (!acc.lastSyncAt) {
        issues.push(`${label}: ни разу не синхронизировался`);
        status = "error";
        continue;
      }

      if (minutesAgo(acc.lastSyncAt) > 15) {
        issues.push(`${label}: lastSync ${minutesAgo(acc.lastSyncAt)} мин назад`);
        if (status === "ok") status = "warning";
      }

      if (!acc.accessToken) {
        issues.push(`${label}: accessToken отсутствует`);
        status = "error";
      }

      // Check credentials for refresh capability
      if (
        !acc.clientId &&
        !acc.clientSecret
      ) {
        const u = users.find((usr) => usr._id === acc.userId);
        if (!u?.vkAdsClientId && !u?.vkAdsClientSecret) {
          issues.push(`${label}: нет credentials для refresh`);
          if (status === "ok") status = "warning";
        }
      }

      if (acc.lastError) {
        issues.push(`${label}: lastError — ${acc.lastError.slice(0, 60)}`);
        if (status === "ok") status = "warning";
      }
    }

    const okCount = active.length - issues.length;
    const message = status === "ok"
      ? `${active.length}/${active.length} синхронизируются`
      : `${issues.length} ${issues.length === 1 ? "проблема" : "проблем"} из ${active.length}`;

    return { name: "Кабинеты", status, message, details: issues };
  },
});

// ─── Block 1.4: Notifications ───

export const checkNotifications = internalQuery({
  args: {},
  handler: async (ctx): Promise<CheckResult> => {
    const now = Date.now();
    const DAY = 24 * 3600_000;
    const notifs = await ctx.db.query("notifications").collect();
    const recent = notifs.filter((n) => n.createdAt > now - DAY);
    const failed = recent.filter((n) => n.status === "failed");
    const issues: string[] = [];
    let status: CheckStatus = "ok";

    if (failed.length > 0) {
      issues.push(`${failed.length} уведомлений не доставлено за 24ч`);
      status = "error";
    }

    // Users with active rules but no telegramChatId
    const rules = await ctx.db.query("rules").collect();
    const activeRuleUserIds = [
      ...new Set(rules.filter((r) => r.isActive).map((r) => r.userId)),
    ];
    const users = await ctx.db.query("users").collect();
    const noTelegram = activeRuleUserIds.filter((uid) => {
      const u = users.find((usr) => usr._id === uid);
      return u && !u.telegramChatId;
    });
    if (noTelegram.length > 0) {
      issues.push(`${noTelegram.length} пользователей с правилами без Telegram`);
      if (status === "ok") status = "warning";
    }

    const sent = recent.filter((n) => n.status === "sent").length;
    const message = status === "ok"
      ? `${sent}/${recent.length} доставлены`
      : failed.length > 0
        ? `${failed.length} не доставлено`
        : `${noTelegram.length} без Telegram`;

    return { name: "Уведомления", status, message, details: issues };
  },
});

// ─── Block 1.5: Payments ───

export const checkPayments = internalQuery({
  args: {},
  handler: async (ctx): Promise<CheckResult> => {
    const payments = await ctx.db.query("payments").collect();
    const users = await ctx.db.query("users").collect();
    const now = Date.now();
    const issues: string[] = [];
    let status: CheckStatus = "ok";

    const stuckPayments = payments.filter(
      (p) => p.status === "pending" && now - p.createdAt > 2 * 3600_000
    );
    if (stuckPayments.length > 0) {
      issues.push(`${stuckPayments.length} зависших платежей (pending >2ч)`);
      if (status === "ok") status = "warning";
    }

    const expiredNotDowngraded = users.filter(
      (u) =>
        u.subscriptionTier &&
        u.subscriptionTier !== "freemium" &&
        u.subscriptionExpiresAt &&
        u.subscriptionExpiresAt < now
    );
    if (expiredNotDowngraded.length > 0) {
      for (const u of expiredNotDowngraded) {
        issues.push(`${u.name || u.email}: ${u.subscriptionTier} истёк, не даунгрейднут`);
      }
      status = "error";
    }

    const message = status === "ok" ? "ок" : `${issues.length} проблем`;
    return { name: "Платежи", status, message, details: issues };
  },
});

// ─── Block 1.6: Subscriptions ───

export const checkSubscriptions = internalQuery({
  args: {},
  handler: async (ctx): Promise<CheckResult> => {
    const users = await ctx.db.query("users").collect();
    const accounts = await ctx.db.query("adAccounts").collect();
    const rules = await ctx.db.query("rules").collect();
    const now = Date.now();
    const TWO_DAYS = 48 * 3600_000;
    const issues: string[] = [];
    let status: CheckStatus = "ok";

    for (const u of users) {
      const tier = u.subscriptionTier || "freemium";
      if (tier === "freemium") continue;

      // Expiring soon
      if (u.subscriptionExpiresAt && u.subscriptionExpiresAt < now + TWO_DAYS && u.subscriptionExpiresAt > now) {
        const hoursLeft = Math.round((u.subscriptionExpiresAt - now) / 3_600_000);
        issues.push(`${u.name || u.email}: ${tier} истекает через ${hoursLeft}ч`);
        if (status === "ok") status = "warning";
      }

      // Limit checks
      const limits = TIER_LIMITS[tier] || TIER_LIMITS.freemium;
      const userAccounts = accounts.filter(
        (a) => a.userId === u._id && a.status !== "paused"
      ).length;
      const userRules = rules.filter(
        (r) => r.userId === u._id && r.isActive
      ).length;

      if (userAccounts > limits.accounts) {
        issues.push(`${u.name || u.email}: ${userAccounts} каб. (лимит ${limits.accounts})`);
        status = "error";
      }
      if (userRules > limits.rules) {
        issues.push(`${u.name || u.email}: ${userRules} правил (лимит ${limits.rules})`);
        status = "error";
      }
    }

    const message = status === "ok" ? "ок" : `${issues.length} проблем`;
    return { name: "Подписки", status, message, details: issues };
  },
});

// ─── Cycle 1 Orchestrator ───

export const runSystemCheck = internalAction({
  args: {},
  handler: async (ctx) => {
    const startTime = Date.now();

    const blocks: CheckResult[] = [];
    const blockChecks = [
      { name: "checkCronHealth", fn: internal.healthCheck.checkCronHealth },
      { name: "checkTokenHealth", fn: internal.healthCheck.checkTokenHealth },
      { name: "checkAccountSync", fn: internal.healthCheck.checkAccountSync },
      { name: "checkNotifications", fn: internal.healthCheck.checkNotifications },
      { name: "checkPayments", fn: internal.healthCheck.checkPayments },
      { name: "checkSubscriptions", fn: internal.healthCheck.checkSubscriptions },
    ];

    for (const check of blockChecks) {
      try {
        const result = await ctx.runQuery(check.fn, {});
        blocks.push(result);
      } catch (err) {
        blocks.push({
          name: check.name,
          status: "warning",
          message: `CHECK_FAILED: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    const statuses = blocks.map((b) => b.status);
    const report: SystemReport = {
      type: "system",
      status: worstStatus(statuses),
      blocks,
      warnings: statuses.filter((s) => s === "warning").length,
      errors: statuses.filter((s) => s === "error").length,
      duration: Date.now() - startTime,
    };

    // Save result
    await ctx.runMutation(internal.healthCheck.saveResult, {
      type: "system",
      status: report.status,
      summary: formatSystemReport(report),
      details: report as any,
      checkedUsers: 0,
      checkedAccounts: 0,
      checkedRules: 0,
      warnings: report.warnings,
      errors: report.errors,
      duration: report.duration,
    });

    // Send Telegram only if problems found
    const text = formatSystemReport(report);
    if (text) {
      await ctx.runAction(internal.telegram.sendMessage, {
        chatId: ADMIN_CHAT_ID,
        text,
      });
    }
  },
});

// ─── Save result mutation ───

export const saveResult = internalMutation({
  args: {
    type: v.union(v.literal("system"), v.literal("function"), v.literal("user")),
    targetUserId: v.optional(v.id("users")),
    status: v.union(v.literal("ok"), v.literal("warning"), v.literal("error")),
    summary: v.string(),
    details: v.any(),
    checkedUsers: v.number(),
    checkedAccounts: v.number(),
    checkedRules: v.number(),
    warnings: v.number(),
    errors: v.number(),
    duration: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("healthCheckResults", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

// ─── Manual triggers (public actions for admin UI) ───

export const runManualSystemCheck = action({
  args: {},
  handler: async (ctx) => {
    await ctx.runAction(internal.healthCheck.runSystemCheck, {});
  },
});

// ─── Query results for admin UI ───

export const getLatestResults = query({
  args: {},
  handler: async (ctx) => {
    const results = await ctx.db
      .query("healthCheckResults")
      .withIndex("by_createdAt")
      .order("desc")
      .take(20);
    return results;
  },
});

export const getResultHistory = query({
  args: {
    type: v.union(v.literal("system"), v.literal("function"), v.literal("user")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("healthCheckResults")
      .withIndex("by_type", (q) => q.eq("type", args.type))
      .order("desc")
      .take(args.limit ?? 10);
    return results;
  },
});
```

Note: add `internalMutation` to the imports:

```typescript
import {
  query,
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No errors. Fix any type issues (e.g., optional fields on adAccounts/users — use `(acc as any).vitaminCabinetId` or check field existence).

- [ ] **Step 3: Commit**

```bash
git add convex/healthCheck.ts
git commit -m "feat(health): implement Cycle 1 — system health checks (blocks 1.1-1.6)"
```

---

### Task 4: healthCheck.ts — Cycle 2 (Function Verification)

**Files:**
- Modify: `convex/healthCheck.ts`

Add blocks 2.1-2.10 and the Cycle 2 orchestrator. This is the largest task — VK API calls, per-user iteration, coverage analysis.

- [ ] **Step 1: Add Cycle 2 per-user check function**

Append to `convex/healthCheck.ts`:

```typescript
// ─── Cycle 2: Function Verification ───

// Per-user check — runs all blocks 2.1-2.10 for a single user
export const checkUserFunctions = internalAction({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<UserCheckResult> => {
    const user = await ctx.runQuery(internal.healthCheck.getUserData, {
      userId: args.userId,
    });
    if (!user) {
      return {
        userId: args.userId,
        userName: "?",
        email: "?",
        tier: "?",
        accounts: 0,
        rules: 0,
        status: "error",
        checks: [{ name: "user", status: "error", message: "Пользователь не найден" }],
      };
    }

    const checks: CheckResult[] = [];

    // Block 2.1: Profile
    try {
      const profileCheck = await ctx.runQuery(
        internal.healthCheck.checkUserProfile,
        { userId: args.userId }
      );
      checks.push(profileCheck);
    } catch (err) {
      checks.push({
        name: "Профиль",
        status: "warning",
        message: `CHECK_FAILED: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Block 2.2: Token test call (VK API)
    const tokenResults: Map<string, boolean> = new Map();
    for (const acc of user.accounts) {
      try {
        const result = await ctx.runAction(
          internal.healthCheck.testAccountToken,
          { accountId: acc._id }
        );
        checks.push(result);
        tokenResults.set(acc._id, result.status === "ok");
      } catch (err) {
        checks.push({
          name: `Токен "${acc.name}"`,
          status: "error",
          message: `"${acc.name}": ${err instanceof Error ? err.message : "ошибка"}`,
        });
        tokenResults.set(acc._id, false);
      }
    }

    // Block 2.3: Rule coverage
    for (const rule of user.rules) {
      if (!rule.isActive) continue;
      try {
        const coverageCheck = await ctx.runQuery(
          internal.healthCheck.checkRuleCoverage,
          { ruleId: rule._id }
        );
        checks.push(coverageCheck);
      } catch (err) {
        checks.push({
          name: `Правило "${rule.name}"`,
          status: "warning",
          message: `CHECK_FAILED: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // Block 2.4-2.5: VK status + rule logic — only for accounts with working tokens
    // Skipped if token test failed (block 2.2)

    // Block 2.6: Log dynamics (UZ rules)
    for (const rule of user.rules) {
      if (rule.type !== "uz_budget_manage" || !rule.isActive) continue;
      try {
        const dynamicsCheck = await ctx.runQuery(
          internal.healthCheck.checkLogDynamics,
          { ruleId: rule._id }
        );
        checks.push(dynamicsCheck);
      } catch (err) {
        checks.push({
          name: `Динамика "${rule.name}"`,
          status: "warning",
          message: `CHECK_FAILED: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // Block 2.8: Deduplication
    try {
      const dedupCheck = await ctx.runQuery(
        internal.healthCheck.checkDeduplication,
        { userId: args.userId }
      );
      checks.push(dedupCheck);
    } catch (err) {
      checks.push({
        name: "Дедупликация",
        status: "warning",
        message: `CHECK_FAILED: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Block 2.9: Account functionality (VK API)
    for (const acc of user.accounts) {
      if (!tokenResults.get(acc._id)) continue; // skip if token dead
      try {
        const funcCheck = await ctx.runAction(
          internal.healthCheck.checkAccountFunctionality,
          { accountId: acc._id }
        );
        checks.push(funcCheck);
      } catch (err) {
        checks.push({
          name: `Функции "${acc.name}"`,
          status: "warning",
          message: `CHECK_FAILED: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // Block 2.10: Budget overspend (VK API, UZ rules only)
    const uzRules = user.rules.filter(
      (r) => r.type === "uz_budget_manage" && r.isActive
    );
    if (uzRules.length > 0) {
      for (const acc of user.accounts) {
        if (!tokenResults.get(acc._id)) continue;
        try {
          const overspendCheck = await ctx.runAction(
            internal.healthCheck.checkBudgetOverspend,
            { accountId: acc._id }
          );
          if (overspendCheck.status !== "ok") {
            checks.push(overspendCheck);
          }
        } catch (err) {
          checks.push({
            name: `Перерасход "${acc.name}"`,
            status: "warning",
            message: `CHECK_FAILED: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }

    const statuses = checks.map((c) => c.status);
    return {
      userId: args.userId,
      userName: user.user.name || user.user.email,
      email: user.user.email,
      tier: user.user.subscriptionTier || "freemium",
      accounts: user.accounts.length,
      rules: user.rules.length,
      status: worstStatus(statuses),
      checks,
    };
  },
});
```

- [ ] **Step 2: Add helper queries for Cycle 2 blocks**

Append to `convex/healthCheck.ts`:

```typescript
// ─── Cycle 2 helper: get user data bundle ───

export const getUserData = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return null;
    const accounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    const rules = await ctx.db
      .query("rules")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    return {
      user,
      accounts: accounts.filter((a) => a.status !== "paused"),
      rules,
    };
  },
});

// ─── Block 2.1: User Profile ───

export const checkUserProfile = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<CheckResult> => {
    const user = await ctx.db.get(args.userId);
    if (!user) return { name: "Профиль", status: "error", message: "Не найден" };

    const accounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    const activeAccounts = accounts.filter((a) => a.status !== "paused");
    const rules = await ctx.db
      .query("rules")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    const activeRules = rules.filter((r) => r.isActive);

    const tier = user.subscriptionTier || "freemium";
    const limits = TIER_LIMITS[tier] || TIER_LIMITS.freemium;
    const issues: string[] = [];
    let status: CheckStatus = "ok";

    if (activeAccounts.length > limits.accounts) {
      issues.push(`${activeAccounts.length} каб. (лимит ${limits.accounts})`);
      status = "error";
    }
    if (activeRules.length > limits.rules) {
      issues.push(`${activeRules.length} правил (лимит ${limits.rules})`);
      status = "error";
    }

    // stopAd on freemium
    if (tier === "freemium") {
      const stopRules = activeRules.filter((r) => r.actions.stopAd);
      if (stopRules.length > 0) {
        issues.push(`${stopRules.length} правил с авто-стоп на freemium`);
        status = "error";
      }
    }

    // No Telegram
    if (activeRules.length > 0 && !user.telegramChatId) {
      issues.push("Нет Telegram (правила не уведомят)");
      if (status === "ok") status = "warning";
    }

    const message =
      status === "ok"
        ? `${tier}, ${activeAccounts.length} каб., ${activeRules.length} правил`
        : issues.join("; ");

    return { name: "Профиль", status, message, details: issues };
  },
});

// ─── Block 2.2: Token test call ───

export const testAccountToken = internalAction({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args): Promise<CheckResult> => {
    const account = await ctx.runQuery(internal.healthCheck.getAccount, {
      accountId: args.accountId,
    });
    const name = account?.name || "?";

    try {
      const token = await ctx.runAction(
        internal.auth.getValidTokenForAccount,
        { accountId: args.accountId }
      );
      // Light test: fetch campaigns list (read-only)
      await ctx.runAction(internal.vkApi.getCampaignsForAccount, {
        accessToken: token,
      });
      return {
        name: `Токен "${name}"`,
        status: "ok",
        message: `"${name}": токен рабочий`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errStatus: CheckStatus = msg.includes("timeout") ? "warning" : "error";
      return {
        name: `Токен "${name}"`,
        status: errStatus,
        message: `"${name}": ${msg.slice(0, 80)}`,
      };
    }
  },
});

export const getAccount = internalQuery({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.accountId);
  },
});

// ─── Block 2.3: Rule Coverage ───

export const checkRuleCoverage = internalQuery({
  args: { ruleId: v.id("rules") },
  handler: async (ctx, args): Promise<CheckResult> => {
    const rule = await ctx.db.get(args.ruleId);
    if (!rule) return { name: "Правило", status: "error", message: "Не найдено" };

    const todayStart = new Date(todayStr()).getTime();

    // Skip rules created today
    if (rule.createdAt >= todayStart) {
      return {
        name: `"${rule.name}"`,
        status: "ok",
        message: `"${rule.name}": создано сегодня, пропуск`,
      };
    }

    const targetCount = rule.targetCampaignIds?.length ?? 0;
    if (targetCount === 0) {
      return {
        name: `"${rule.name}"`,
        status: "ok",
        message: `"${rule.name}": нет целевых кампаний`,
      };
    }

    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_ruleId", (q) => q.eq("ruleId", args.ruleId))
      .collect();
    const todayLogs = logs.filter((l) => l.createdAt >= todayStart);
    const processedCampaigns = new Set(
      todayLogs.map((l) => (l as any).campaignId || l.adId)
    );
    const processed = processedCampaigns.size;

    let status: CheckStatus = "ok";
    const issues: string[] = [];

    if (processed === 0 && targetCount > 0) {
      status = "error";
      issues.push("Ни одна кампания не обработана сегодня");
    } else if (processed < targetCount) {
      status = "warning";
      issues.push(`${targetCount - processed} кампаний не обработаны`);
    }

    return {
      name: `"${rule.name}"`,
      status,
      message: `"${rule.name}": ${processed}/${targetCount} обработано`,
      details: issues,
    };
  },
});

// ─── Block 2.6: Log Dynamics ───

export const checkLogDynamics = internalQuery({
  args: { ruleId: v.id("rules") },
  handler: async (ctx, args): Promise<CheckResult> => {
    const rule = await ctx.db.get(args.ruleId);
    if (!rule) return { name: "Динамика", status: "error", message: "Правило не найдено" };

    const todayStart = new Date(todayStr()).getTime();
    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_ruleId", (q) => q.eq("ruleId", args.ruleId))
      .collect();
    const todayLogs = logs
      .filter((l) => l.createdAt >= todayStart && l.actionType === "budget_increased")
      .sort((a, b) => a.createdAt - b.createdAt);

    if (todayLogs.length < 2) {
      return {
        name: `Динамика "${rule.name}"`,
        status: "ok",
        message: `"${rule.name}": ${todayLogs.length} увеличений сегодня`,
      };
    }

    const issues: string[] = [];
    let status: CheckStatus = "ok";
    let spentStuckCount = 0;
    let slowGapCount = 0;

    for (let i = 1; i < todayLogs.length; i++) {
      const prev = todayLogs[i - 1];
      const curr = todayLogs[i];
      const gapMin = Math.round((curr.createdAt - prev.createdAt) / 60_000);
      const prevSpent = prev.metricsSnapshot.spent;
      const currSpent = curr.metricsSnapshot.spent;

      if (currSpent <= prevSpent && gapMin > 5) {
        spentStuckCount++;
      }
      if (gapMin > 10) {
        slowGapCount++;
      }
    }

    if (spentStuckCount > 2) {
      issues.push(`spent не растёт в ${spentStuckCount} переходах — resume не работает?`);
      status = "error";
    }
    if (slowGapCount > 2) {
      issues.push(`${slowGapCount} gap'ов >10 мин между увеличениями`);
      if (status === "ok") status = "warning";
    }

    // Daily reset check
    if (rule.conditions.resetDaily) {
      const resetLogs = logs.filter(
        (l) => l.createdAt >= todayStart && l.actionType === "budget_reset"
      );
      const targetCount = rule.targetCampaignIds?.length ?? 0;

      if (targetCount > 0 && resetLogs.length === 0) {
        issues.push(`Ресет не выполнен (0/${targetCount})`);
        status = "error";
      } else if (targetCount > 0 && resetLogs.length < targetCount) {
        issues.push(`Ресет частичный (${resetLogs.length}/${targetCount})`);
        status = "error";
      }
    }

    const message = status === "ok"
      ? `"${rule.name}": ${todayLogs.length} увеличений, динамика ок`
      : `"${rule.name}": ${issues.join("; ")}`;

    return {
      name: `Динамика "${rule.name}"`,
      status,
      message,
      details: issues,
    };
  },
});

// ─── Block 2.8: Deduplication ───

export const checkDeduplication = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<CheckResult> => {
    const todayStart = new Date(todayStr()).getTime();
    const logs = await ctx.db
      .query("actionLogs")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    const todayLogs = logs.filter((l) => l.createdAt >= todayStart);
    const issues: string[] = [];
    let status: CheckStatus = "ok";

    // Double stops
    const stopLogs = todayLogs.filter(
      (l) =>
        (l.actionType === "stopped" || l.actionType === "stopped_and_notified") &&
        l.status === "success"
    );
    const adStopCounts = new Map<string, number>();
    for (const l of stopLogs) {
      adStopCounts.set(l.adId, (adStopCounts.get(l.adId) || 0) + 1);
    }
    for (const [adId, count] of adStopCounts) {
      if (count > 1) {
        const log = stopLogs.find((l) => l.adId === adId);
        issues.push(`Объявление ${log?.adName || adId}: остановлено ${count} раз`);
        status = "error";
      }
    }

    // UZ campaign overlap
    const rules = await ctx.db
      .query("rules")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    const uzRules = rules.filter(
      (r) => r.type === "uz_budget_manage" && r.isActive
    );

    if (uzRules.length >= 2) {
      for (let i = 0; i < uzRules.length; i++) {
        for (let j = i + 1; j < uzRules.length; j++) {
          const idsA = new Set(uzRules[i].targetCampaignIds || []);
          const overlap = (uzRules[j].targetCampaignIds || []).filter((id) =>
            idsA.has(id)
          );
          if (overlap.length > 0) {
            issues.push(
              `${overlap.length} кампаний в правилах "${uzRules[i].name}" и "${uzRules[j].name}"`
            );
            status = "error";
          }
        }
      }
    }

    const message = status === "ok" ? "ок" : issues.join("; ");
    return { name: "Дедупликация", status, message, details: issues };
  },
});

// ─── Block 2.9: Account Functionality ───

export const checkAccountFunctionality = internalAction({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args): Promise<CheckResult> => {
    const account = await ctx.runQuery(internal.healthCheck.getAccount, {
      accountId: args.accountId,
    });
    const name = account?.name || "?";

    try {
      const result = await ctx.runAction(internal.vkApi.fetchUzCampaigns, {
        accountId: args.accountId,
      });
      const totalCampaigns =
        result.adPlans.reduce((sum: number, p: any) => sum + p.campaigns.length, 0) +
        result.ungrouped.length;

      if (totalCampaigns === 0) {
        return {
          name: `Функции "${name}"`,
          status: "warning",
          message: `"${name}": нет кампаний/групп`,
          details: ["Кабинет пустой — правила создать нельзя"],
        };
      }
      if (result.adPlans.length === 0 && result.ungrouped.length > 0) {
        return {
          name: `Функции "${name}"`,
          status: "warning",
          message: `"${name}": ${totalCampaigns} кампаний, но нет UZ-групп`,
          details: ["Нет ad_plans — UZ-правило создать нельзя"],
        };
      }

      return {
        name: `Функции "${name}"`,
        status: "ok",
        message: `"${name}": ${result.adPlans.length} групп, ${totalCampaigns} кампаний`,
      };
    } catch (err) {
      return {
        name: `Функции "${name}"`,
        status: "error",
        message: `"${name}": ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`,
      };
    }
  },
});

// ─── Block 2.10: Budget Overspend ───

export const checkBudgetOverspend = internalAction({
  args: { accountId: v.id("adAccounts") },
  handler: async (ctx, args): Promise<CheckResult> => {
    const account = await ctx.runQuery(internal.healthCheck.getAccount, {
      accountId: args.accountId,
    });
    const name = account?.name || "?";

    try {
      const result = await ctx.runAction(internal.vkApi.fetchUzCampaigns, {
        accountId: args.accountId,
      });

      const issues: string[] = [];
      let overspendCount = 0;

      const allCampaigns = [
        ...result.adPlans.flatMap((p: any) => p.campaigns),
        ...result.ungrouped,
      ];

      for (const c of allCampaigns) {
        if (!c.budgetLimitDay || c.budgetLimitDay <= 0) continue;
        // We need spent data — use metricsDaily
        // For now, check budget vs what VK reports
        // Note: spent is not returned by fetchUzCampaigns — this check
        // relies on metricsDaily data from syncMetrics
      }

      // Fallback: check via metricsDaily
      const todayDate = todayStr();
      const metrics = await ctx.runQuery(
        internal.healthCheck.getAccountMetricsToday,
        { accountId: args.accountId, date: todayDate }
      );

      for (const m of metrics) {
        // Find matching campaign budget
        const campaign = allCampaigns.find(
          (c: any) => String(c.id) === m.adId || String(c.id) === m.campaignId
        );
        if (!campaign?.budgetLimitDay || campaign.budgetLimitDay <= 0) continue;

        const budget = campaign.budgetLimitDay;
        const spent = m.spent;
        if (spent > budget * 1.05) {
          const pct = Math.round(((spent - budget) / budget) * 100);
          issues.push(
            `"${campaign.name}": бюджет ${budget}, потрачено ${spent} (+${pct}%)`
          );
          overspendCount++;
        }
      }

      if (overspendCount === 0) {
        return { name: `Перерасход "${name}"`, status: "ok", message: `"${name}": ок` };
      }

      const status: CheckStatus = overspendCount > 3 ? "error" : "warning";
      return {
        name: `Перерасход "${name}"`,
        status,
        message: `"${name}": ${overspendCount} групп с перерасходом`,
        details: issues,
      };
    } catch (err) {
      return {
        name: `Перерасход "${name}"`,
        status: "warning",
        message: `"${name}": не удалось проверить — ${(err instanceof Error ? err.message : String(err)).slice(0, 60)}`,
      };
    }
  },
});

export const getAccountMetricsToday = internalQuery({
  args: {
    accountId: v.id("adAccounts"),
    date: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("metricsDaily")
      .withIndex("by_accountId_date", (q) =>
        q.eq("accountId", args.accountId).eq("date", args.date)
      )
      .collect();
  },
});
```

- [ ] **Step 3: Add Cycle 2 orchestrator and manual triggers**

Append to `convex/healthCheck.ts`:

```typescript
// ─── Cycle 2 Orchestrator ───

export const runFunctionCheck = internalAction({
  args: {},
  handler: async (ctx) => {
    const startTime = Date.now();
    const TIMEOUT = 5 * 60_000; // 5 min
    const USER_TIMEOUT = 60_000; // 60 sec per user

    // Get all users with at least 1 account
    const usersWithAccounts = await ctx.runQuery(
      internal.healthCheck.getUsersWithAccounts,
      {}
    );

    const userResults: UserCheckResult[] = [];
    let totalAccounts = 0;
    let totalRules = 0;

    for (const userId of usersWithAccounts) {
      if (Date.now() - startTime > TIMEOUT) {
        userResults.push({
          userId,
          userName: "?",
          email: "?",
          tier: "?",
          accounts: 0,
          rules: 0,
          status: "warning",
          checks: [{ name: "timeout", status: "warning", message: "Таймаут общей проверки" }],
        });
        break;
      }

      try {
        const result = await ctx.runAction(
          internal.healthCheck.checkUserFunctions,
          { userId: userId as Id<"users"> }
        );
        userResults.push(result);
        totalAccounts += result.accounts;
        totalRules += result.rules;
      } catch (err) {
        userResults.push({
          userId,
          userName: "?",
          email: "?",
          tier: "?",
          accounts: 0,
          rules: 0,
          status: "warning",
          checks: [{
            name: "error",
            status: "warning",
            message: `USER_CHECK_FAILED: ${err instanceof Error ? err.message : String(err)}`,
          }],
        });
      }
    }

    const statuses = userResults.map((u) => u.status);
    const report: FunctionReport = {
      type: "function",
      status: worstStatus(statuses),
      users: userResults,
      checkedUsers: userResults.length,
      checkedAccounts: totalAccounts,
      checkedRules: totalRules,
      warnings: userResults.filter((u) => u.status === "warning").length,
      errors: userResults.filter((u) => u.status === "error").length,
      duration: Date.now() - startTime,
    };

    // Save result
    await ctx.runMutation(internal.healthCheck.saveResult, {
      type: "function",
      status: report.status,
      summary: formatFunctionReport(report),
      details: report as any,
      checkedUsers: report.checkedUsers,
      checkedAccounts: report.checkedAccounts,
      checkedRules: report.checkedRules,
      warnings: report.warnings,
      errors: report.errors,
      duration: report.duration,
    });

    // Always send Telegram summary for Cycle 2
    const text = formatFunctionReport(report);
    if (text) {
      await ctx.runAction(internal.telegram.sendMessage, {
        chatId: ADMIN_CHAT_ID,
        text,
      });
    }
  },
});

// ─── Helper: get user IDs with accounts ───

export const getUsersWithAccounts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("adAccounts").collect();
    const activeAccounts = accounts.filter((a) => a.status !== "paused");
    const userIds = [...new Set(activeAccounts.map((a) => a.userId))];
    return userIds;
  },
});

// ─── Manual triggers ───

export const runManualFunctionCheck = action({
  args: {},
  handler: async (ctx) => {
    await ctx.runAction(internal.healthCheck.runFunctionCheck, {});
  },
});

export const runManualUserCheck = action({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const startTime = Date.now();
    const result = await ctx.runAction(
      internal.healthCheck.checkUserFunctions,
      { userId: args.userId }
    );

    const report: FunctionReport = {
      type: "user",
      status: result.status,
      users: [result],
      checkedUsers: 1,
      checkedAccounts: result.accounts,
      checkedRules: result.rules,
      warnings: result.checks.filter((c) => c.status === "warning").length,
      errors: result.checks.filter((c) => c.status === "error").length,
      duration: Date.now() - startTime,
    };

    await ctx.runMutation(internal.healthCheck.saveResult, {
      type: "user",
      targetUserId: args.userId,
      status: report.status,
      summary: formatFunctionReport(report),
      details: report as any,
      checkedUsers: 1,
      checkedAccounts: report.checkedAccounts,
      checkedRules: report.checkedRules,
      warnings: report.warnings,
      errors: report.errors,
      duration: report.duration,
    });

    const text = formatFunctionReport(report);
    if (text) {
      await ctx.runAction(internal.telegram.sendMessage, {
        chatId: ADMIN_CHAT_ID,
        text,
      });
    }
  },
});
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No errors. May need to adjust types for `internal.auth.getValidTokenForAccount` and `internal.vkApi.getCampaignsForAccount` — verify these exist as internalAction/internalQuery in auth.ts and vkApi.ts. If they're named differently, update the references.

- [ ] **Step 5: Commit**

```bash
git add convex/healthCheck.ts
git commit -m "feat(health): implement Cycle 2 — function verification (blocks 2.1-2.10)"
```

---

### Task 5: Cron jobs

**Files:**
- Modify: `convex/crons.ts:104` (before `export default crons;`)

- [ ] **Step 1: Add 2 new cron jobs**

Before `export default crons;` in `convex/crons.ts`, add:

```typescript
// System health check — every 6 hours
crons.cron(
  "system-health-check",
  "0 0,6,12,18 * * *",
  internal.healthCheck.runSystemCheck
);

// Function verification — every 12 hours (03:00 and 15:00 UTC)
crons.cron(
  "function-verification",
  "0 3,15 * * *",
  internal.healthCheck.runFunctionCheck
);
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add convex/crons.ts
git commit -m "feat(health): add system-health-check and function-verification crons"
```

---

### Task 6: External ping script

**Files:**
- Create: `scripts/external-ping.sh`

- [ ] **Step 1: Create the ping script**

```bash
#!/bin/bash
# /opt/addpilot/external-ping.sh
# Cron: */15 * * * * /opt/addpilot/external-ping.sh
#
# Independent uptime monitor — works even if Convex is down.
# Alerts on 2 consecutive failures to avoid false positives.

TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
ADMIN_CHAT_ID="325307765"
STATE_FILE="/tmp/addpilot_ping_state"

# Create state file if missing
touch "$STATE_FILE"

URLS=(
  "https://convex.aipilot.by"
  "https://aipilot.by"
)

for url in "${URLS[@]}"; do
  status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null)
  key=$(echo "$url" | md5 -q 2>/dev/null || echo "$url" | md5sum | cut -c1-8)

  prev_fail=$(grep "^${key}=" "$STATE_FILE" 2>/dev/null | cut -d= -f2)

  if [ "$status" -lt 200 ] 2>/dev/null || [ "$status" -ge 500 ] 2>/dev/null || [ -z "$status" ]; then
    if [ "$prev_fail" = "1" ]; then
      # Second consecutive failure — send alert
      if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
        curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
          -d chat_id="$ADMIN_CHAT_ID" \
          -d text="🔴 Сервис недоступен: ${url} (HTTP ${status:-timeout})" \
          > /dev/null 2>&1
      fi
    fi
    # Mark as failed
    if grep -q "^${key}=" "$STATE_FILE" 2>/dev/null; then
      sed -i.bak "s/^${key}=.*/${key}=1/" "$STATE_FILE"
    else
      echo "${key}=1" >> "$STATE_FILE"
    fi
  else
    # Mark as ok
    if grep -q "^${key}=" "$STATE_FILE" 2>/dev/null; then
      sed -i.bak "s/^${key}=.*/${key}=0/" "$STATE_FILE"
    else
      echo "${key}=0" >> "$STATE_FILE"
    fi
  fi
done
```

- [ ] **Step 2: Make executable**

Run: `chmod +x scripts/external-ping.sh`

- [ ] **Step 3: Commit**

```bash
git add scripts/external-ping.sh
git commit -m "feat(health): add external uptime ping script"
```

Note: Deploy to server manually — add to crontab on 178.172.235.49:
```
*/15 * * * * TELEGRAM_BOT_TOKEN=<token> /opt/addpilot/external-ping.sh
```

---

### Task 7: Admin UI — diagnostic buttons and results

**Files:**
- Modify: `src/pages/AdminPage.tsx`

- [ ] **Step 1: Add diagnostic section to AdminPage**

Find the `AdminDashboard` component in `src/pages/AdminPage.tsx`. Add a new tab or section. Import the necessary hooks and add the diagnostic UI.

Add imports at the top:
```typescript
import { Activity, Stethoscope, UserCheck } from 'lucide-react';
```

Add a new component inside the file (before or after other tab components):

```typescript
function DiagnosticSection() {
  const runSystemCheck = useAction(api.healthCheck.runManualSystemCheck);
  const runFunctionCheck = useAction(api.healthCheck.runManualFunctionCheck);
  const runUserCheck = useAction(api.healthCheck.runManualUserCheck);
  const latestResults = useQuery(api.healthCheck.getLatestResults);

  const [running, setRunning] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState('');

  const handleSystemCheck = async () => {
    setRunning('system');
    try {
      await runSystemCheck({});
    } catch (err) {
      console.error(err);
    } finally {
      setRunning(null);
    }
  };

  const handleFunctionCheck = async () => {
    setRunning('function');
    try {
      await runFunctionCheck({});
    } catch (err) {
      console.error(err);
    } finally {
      setRunning(null);
    }
  };

  const handleUserCheck = async () => {
    if (!selectedUserId) return;
    setRunning('user');
    try {
      await runUserCheck({ userId: selectedUserId as Id<"users"> });
    } catch (err) {
      console.error(err);
    } finally {
      setRunning(null);
    }
  };

  const statusBadge = (status: string) => {
    if (status === 'ok') return <Badge variant="success">OK</Badge>;
    if (status === 'warning') return <Badge variant="warning">Warning</Badge>;
    return <Badge variant="destructive">Error</Badge>;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 mb-4">
        <Stethoscope className="h-5 w-5 text-primary" />
        <h3 className="text-lg font-semibold">Диагностика</h3>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Button
          onClick={handleSystemCheck}
          disabled={running !== null}
          variant="outline"
          className="h-auto py-3"
        >
          {running === 'system' ? (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          ) : (
            <Activity className="h-4 w-4 mr-2" />
          )}
          <div className="text-left">
            <div className="font-medium">Быстрая проверка</div>
            <div className="text-xs text-muted-foreground">Цикл 1: 5-15 сек</div>
          </div>
        </Button>

        <Button
          onClick={handleFunctionCheck}
          disabled={running !== null}
          variant="outline"
          className="h-auto py-3"
        >
          {running === 'function' ? (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          ) : (
            <Stethoscope className="h-4 w-4 mr-2" />
          )}
          <div className="text-left">
            <div className="font-medium">Полная диагностика</div>
            <div className="text-xs text-muted-foreground">Цикл 2: 30-120 сек</div>
          </div>
        </Button>

        <div className="flex gap-2">
          <Input
            placeholder="userId..."
            value={selectedUserId}
            onChange={(e) => setSelectedUserId(e.target.value)}
            className="flex-1"
          />
          <Button
            onClick={handleUserCheck}
            disabled={running !== null || !selectedUserId}
            variant="outline"
            size="icon"
          >
            {running === 'user' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <UserCheck className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      {/* Results */}
      {latestResults && latestResults.length > 0 && (
        <div className="space-y-2 mt-4">
          <h4 className="text-sm font-medium text-muted-foreground">Последние результаты</h4>
          {latestResults.slice(0, 10).map((r) => (
            <Card key={r._id} className="p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {statusBadge(r.status)}
                  <span className="text-sm font-medium capitalize">{r.type}</span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(r.createdAt).toLocaleString('ru-RU')}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {r.checkedUsers > 0 && `${r.checkedUsers} польз. `}
                  {r.warnings > 0 && `${r.warnings} warn `}
                  {r.errors > 0 && `${r.errors} err `}
                  {Math.round(r.duration / 1000)}сек
                </div>
              </div>
              {r.status !== 'ok' && r.summary && (
                <pre className="text-xs mt-2 whitespace-pre-wrap text-muted-foreground max-h-40 overflow-auto">
                  {r.summary.replace(/<[^>]+>/g, '').slice(0, 500)}
                </pre>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
```

Then add `<DiagnosticSection />` inside the admin dashboard layout, e.g., as a new card/section.

- [ ] **Step 2: Typecheck and lint**

Run: `npm run lint && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/pages/AdminPage.tsx
git commit -m "feat(health): add diagnostic buttons and results to admin panel"
```

---

### Task 8: Skill file

**Files:**
- Create: `docs/skills/service-diagnostic.md`

- [ ] **Step 1: Create the skill file**

```markdown
# Service Diagnostic Skill

## Trigger

Use when: diagnosing service issues, checking health, user reports "not working",
monitoring, health check, "why isn't rule/account/sync working?"

## Quick Commands

Manual checks from admin panel or Convex dashboard:

- **System check (Cycle 1):** Admin panel -> "Быстрая проверка" (5-15 sec)
- **Full diagnostic (Cycle 2):** Admin panel -> "Полная диагностика" (30-120 sec)
- **Single user:** Admin panel -> enter userId -> check (30-60 sec)

## Automated Schedule

- Cycle 1 (system health): every 6h (00:00, 06:00, 12:00, 18:00 UTC)
- Cycle 2 (function check): every 12h (03:00, 15:00 UTC)
- External ping: every 15 min (independent of Convex)

## What Gets Checked

### Cycle 1 — System Health (no VK API)
1. Crons: heartbeat + result verification (sync completeness, budget resets, digests)
2. User tokens: expiry, refresh capability
3. Account sync: status, lastSyncAt, credentials, agency tokens
4. Notifications: delivery failures, Telegram linkage
5. Payments: stuck pending, expired not downgraded
6. Subscriptions: expiring, limit violations

### Cycle 2 — Function Verification (with VK API, per-user)
1. User profile: tier limits, stopAd on freemium
2. Token test: real VK API call per account
3. Rule coverage: targetCampaignIds vs actionLogs (M < N = gap)
4. VK campaign status: our DB vs VK API (status, delivery mismatches)
5. Rule logic trace: evaluateCondition with real numbers
6. Log dynamics: spent growth pattern, budget reset verification
7. Leads: 5-source comparison, Lead Ads API availability
8. Deduplication: double stops, UZ campaign overlap
9. Account functionality: fetchUzCampaigns test, empty groups detection
10. Budget overspend: spent vs budget_limit_day per group

## Interpreting Results

- **ok**: everything works
- **warning**: degraded but functional (expiring tokens, stale sync, minor overspend)
- **error**: broken and needs fixing (expired tokens, rules not working, budget not reset)

## Key Files

- `convex/healthCheck.ts` — all check logic
- `convex/healthReport.ts` — Telegram formatting
- `convex/crons.ts` — scheduled runs
- `scripts/external-ping.sh` — independent uptime monitor

## Debugging with Diagnostic Data

When a user reports an issue:
1. Run single-user diagnostic from admin panel
2. Read the Telegram report — it shows exactly which block failed
3. Each block provides specific error codes (COVERAGE_GAP, RESET_FAILED, etc.)
4. Follow the error to the relevant code/data
```

- [ ] **Step 2: Commit**

```bash
git add docs/skills/service-diagnostic.md
git commit -m "docs: add service-diagnostic skill file"
```

---

### Task 9: Final integration test

- [ ] **Step 1: Deploy to Convex dev and verify typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json`
Expected: No errors

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: Max 50 warnings, no errors

- [ ] **Step 3: Test Cycle 1 manually**

From Convex dashboard, run:
```
healthCheck.runManualSystemCheck({})
```

Expected: Telegram message received (if problems exist) or silent (if all ok). Check `healthCheckResults` table for new record.

- [ ] **Step 4: Test Cycle 2 for single user**

From Convex dashboard, run:
```
healthCheck.runManualUserCheck({ userId: "kx7djrrpr67bry6zxehzx0e65x8141ct" })
```

Expected: Detailed Telegram report for your account.

- [ ] **Step 5: Verify admin UI**

Open https://aipilot.by/admin, check:
- Diagnostic buttons appear
- "Быстрая проверка" runs and shows result
- Results list updates

- [ ] **Step 6: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(health): integration fixes after testing"
```

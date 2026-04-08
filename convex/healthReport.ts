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
  ok: "\u2705",
  warning: "\u26a0\ufe0f",
  error: "\ud83d\uded1",
};

function overallIcon(status: CheckStatus): string {
  if (status === "error") return "\ud83d\udd34";
  if (status === "warning") return "\ud83d\udfe1";
  return "\ud83d\udfe2";
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
    const problems = countProblems(u.checks);
    const suffix = u.status === "ok" ? "ок" : `${problems} ${problemWord(problems)}`;
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

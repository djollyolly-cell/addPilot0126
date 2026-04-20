import { useState, useRef, useMemo } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Card, CardContent } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Loader2,
  Search,
  Download,
  Play,
  Square,
  ChevronDown,
  ChevronRight,
  Users,
  AlertTriangle,
  Send,
  CheckCircle,
  XCircle,
  CircleDot,
  Eye,
} from "lucide-react";

interface DiagRule {
  name: string;
  type: string;
  isActive: boolean;
  stopAd: boolean;
  triggerCount: number;
  targetAlive: boolean;
  problem: string | null;
}

interface DiagBanner {
  bannerId: string;
  campaignId: string;
  campaignName: string;
  spent: number;
  clicks: number;
  leads: number;
  cpl: number | null;
  isCovered: boolean;
  coveredByRules: string[];
  problem: string | null;
}

interface DiagTrace {
  bannerId: string;
  ruleName: string;
  stoppedAt: string;
  reason: string;
}

interface DiagProblem {
  category: string;
  message: string;
}

interface UserDiagnostic {
  userId: string;
  name: string;
  email: string;
  tier: string;
  telegramConnected: boolean;
  error: string | null;
  rules: DiagRule[];
  banners: DiagBanner[];
  tracing: DiagTrace[];
  problems: DiagProblem[];
}

interface Props {
  sessionToken: string;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

type RuleVerdict = "ok" | "warning" | "error";

interface RuleDigest {
  rule: DiagRule;
  verdict: RuleVerdict;
  verdictText: string;
  bannersTotal: number;
  bannersTriggered: number;
  bannersSkipped: number;
  traces: DiagTrace[];
  banners: DiagBanner[];
}

function buildRuleDigests(user: UserDiagnostic): RuleDigest[] {
  return user.rules.map((rule) => {
    const traces = user.tracing.filter((t) => t.ruleName === rule.name);
    const triggered = traces.filter((t) => t.stoppedAt === "triggered").length;
    const skipped = traces.filter((t) => t.stoppedAt !== "triggered").length;
    const coveredBanners = user.banners.filter((b) =>
      b.coveredByRules.includes(rule.name)
    );

    let verdict: RuleVerdict = "ok";
    let verdictText = "";

    if (!rule.isActive) {
      verdict = "warning";
      verdictText = "Правило выключено";
    } else if (rule.problem) {
      verdict = "error";
      verdictText = rule.problem;
    } else if (!rule.targetAlive) {
      verdict = "error";
      verdictText = "Целевые кампании не найдены в VK";
    } else if (!rule.stopAd) {
      verdict = "warning";
      verdictText = "Только уведомление, без остановки";
    } else if (triggered > 0) {
      verdict = "ok";
      verdictText = `Сработало ${triggered} раз`;
    } else if (coveredBanners.length === 0) {
      verdict = "warning";
      verdictText = "Нет баннеров с расходом под это правило";
    } else {
      verdict = "ok";
      verdictText = "Условия не достигнуты (это нормально)";
    }

    return {
      rule,
      verdict,
      verdictText,
      bannersTotal: coveredBanners.length,
      bannersTriggered: triggered,
      bannersSkipped: skipped,
      traces,
      banners: coveredBanners,
    };
  });
}

const VERDICT_CONFIG: Record<
  RuleVerdict,
  { icon: typeof CheckCircle; color: string; bg: string }
> = {
  ok: { icon: CheckCircle, color: "text-success", bg: "bg-success/10" },
  warning: { icon: AlertTriangle, color: "text-warning", bg: "bg-warning/10" },
  error: { icon: XCircle, color: "text-destructive", bg: "bg-destructive/10" },
};

const RULE_TYPE_LABELS: Record<string, string> = {
  cpl_limit: "CPL лимит",
  min_ctr: "Мин. CTR",
  fast_spend: "Быстрый расход",
  spend_no_leads: "Расход без лидов",
  budget_limit: "Лимит бюджета",
  low_impressions: "Мало показов",
  clicks_no_leads: "Клики без лидов",
  new_lead: "Новый лид",
  uz_budget_manage: "Управление бюджетом",
};

function RuleCard({ digest }: { digest: RuleDigest }) {
  const [expanded, setExpanded] = useState(false);
  const cfg = VERDICT_CONFIG[digest.verdict];
  const Icon = cfg.icon;

  return (
    <div className={`rounded-lg border ${digest.verdict === "error" ? "border-destructive/30" : "border-border"}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-muted/30 transition-colors rounded-lg"
      >
        <Icon className={`h-5 w-5 shrink-0 ${cfg.color}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm truncate">{digest.rule.name}</span>
            <Badge variant="secondary" className="text-xs">
              {RULE_TYPE_LABELS[digest.rule.type] || digest.rule.type}
            </Badge>
            {digest.rule.stopAd ? (
              <Badge variant="outline" className="text-xs">Стоп</Badge>
            ) : (
              <Badge variant="outline" className="text-xs opacity-60">Уведом.</Badge>
            )}
          </div>
          <p className={`text-xs mt-0.5 ${cfg.color}`}>{digest.verdictText}</p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
          {digest.rule.triggerCount > 0 && (
            <span title="Всего срабатываний">
              <CircleDot className="inline h-3 w-3 mr-0.5" />
              {digest.rule.triggerCount}
            </span>
          )}
          {digest.bannersTotal > 0 && (
            <span title="Баннеров под правилом">
              <Eye className="inline h-3 w-3 mr-0.5" />
              {digest.bannersTotal}
            </span>
          )}
          {expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-3">
          {/* Traces for this rule */}
          {digest.traces.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-muted-foreground text-left">
                    <th className="pb-1.5 pr-3">Баннер</th>
                    <th className="pb-1.5 pr-3">Кампания</th>
                    <th className="pb-1.5 pr-3">Расход</th>
                    <th className="pb-1.5 pr-3">Лиды</th>
                    <th className="pb-1.5 pr-3">CPL</th>
                    <th className="pb-1.5 pr-3">Результат</th>
                    <th className="pb-1.5">Детали</th>
                  </tr>
                </thead>
                <tbody>
                  {digest.traces.map((t, i) => {
                    const banner = digest.banners.find(
                      (b) => b.bannerId === t.bannerId
                    );
                    const isTriggered = t.stoppedAt === "triggered";
                    return (
                      <tr key={i} className="border-b border-border/30">
                        <td className="py-1.5 pr-3 font-mono">{t.bannerId}</td>
                        <td className="py-1.5 pr-3">
                          {banner?.campaignName || banner?.campaignId || "—"}
                        </td>
                        <td className="py-1.5 pr-3">
                          {banner ? `${Math.round(banner.spent)}₽` : "—"}
                        </td>
                        <td className="py-1.5 pr-3">{banner?.leads ?? "—"}</td>
                        <td className="py-1.5 pr-3">
                          {banner?.cpl !== null && banner?.cpl !== undefined
                            ? `${Math.round(banner.cpl)}₽`
                            : "—"}
                        </td>
                        <td className="py-1.5 pr-3">
                          <Badge
                            variant={isTriggered ? "success" : "secondary"}
                            className="text-xs"
                          >
                            {isTriggered ? "Сработало" : t.stoppedAt}
                          </Badge>
                        </td>
                        <td className="py-1.5 text-muted-foreground">
                          {t.reason}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Covered banners without traces */}
          {digest.traces.length === 0 && digest.banners.length > 0 && (
            <div className="text-xs text-muted-foreground">
              Покрывает {digest.banners.length} баннер(ов), но условия не достигнуты ни для одного
            </div>
          )}

          {digest.traces.length === 0 && digest.banners.length === 0 && (
            <div className="text-xs text-muted-foreground">
              Нет активных баннеров с расходом, подходящих под фильтры правила
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function UncoveredBannersSection({ banners }: { banners: DiagBanner[] }) {
  const [expanded, setExpanded] = useState(false);
  const uncovered = banners.filter((b) => !b.isCovered && b.spent > 0);
  if (uncovered.length === 0) return null;

  return (
    <div className="rounded-lg border border-warning/30">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-muted/30 transition-colors rounded-lg"
      >
        <AlertTriangle className="h-5 w-5 text-warning shrink-0" />
        <div className="flex-1">
          <span className="font-medium text-sm">
            Баннеры без покрытия правилами
          </span>
          <p className="text-xs text-warning mt-0.5">
            {uncovered.length} баннер(ов) с расходом не покрыты ни одним правилом
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{Math.round(uncovered.reduce((s, b) => s + b.spent, 0))}₽ расход</span>
          {expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-muted-foreground text-left">
                <th className="pb-1.5 pr-3">Баннер</th>
                <th className="pb-1.5 pr-3">Кампания</th>
                <th className="pb-1.5 pr-3">Расход</th>
                <th className="pb-1.5 pr-3">Клики</th>
                <th className="pb-1.5 pr-3">Лиды</th>
                <th className="pb-1.5">CPL</th>
              </tr>
            </thead>
            <tbody>
              {uncovered.map((b, i) => (
                <tr key={i} className="border-b border-border/30">
                  <td className="py-1.5 pr-3 font-mono">{b.bannerId}</td>
                  <td className="py-1.5 pr-3">{b.campaignName || b.campaignId}</td>
                  <td className="py-1.5 pr-3">{Math.round(b.spent)}₽</td>
                  <td className="py-1.5 pr-3">{b.clicks}</td>
                  <td className="py-1.5 pr-3">{b.leads}</td>
                  <td className="py-1.5">
                    {b.cpl !== null ? `${Math.round(b.cpl)}₽` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function UserResultCard({
  user,
  isOpen,
  onToggle,
}: {
  user: UserDiagnostic;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const digests = useMemo(() => buildRuleDigests(user), [user]);
  const errorCount = digests.filter((d) => d.verdict === "error").length;
  const warningCount = digests.filter((d) => d.verdict === "warning").length;
  const okCount = digests.filter((d) => d.verdict === "ok").length;
  const uncoveredCount = user.banners.filter(
    (b) => !b.isCovered && b.spent > 0
  ).length;

  // Sort: errors first, then warnings, then ok
  const sortedDigests = useMemo(
    () =>
      [...digests].sort((a, b) => {
        const order: Record<RuleVerdict, number> = { error: 0, warning: 1, ok: 2 };
        return order[a.verdict] - order[b.verdict];
      }),
    [digests]
  );

  return (
    <Card>
      <button
        onClick={onToggle}
        className="w-full px-6 py-4 flex items-center justify-between text-left hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          {isOpen ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <span className="font-medium">{user.name}</span>
          {user.error ? (
            <Badge variant="destructive">ошибка</Badge>
          ) : (
            <div className="flex items-center gap-1.5">
              {errorCount > 0 && (
                <Badge variant="destructive" className="text-xs">
                  {errorCount} ошибок
                </Badge>
              )}
              {warningCount > 0 && (
                <Badge variant="warning" className="text-xs">
                  {warningCount} внимание
                </Badge>
              )}
              {okCount > 0 && (
                <Badge variant="success" className="text-xs">
                  {okCount} ок
                </Badge>
              )}
              {uncoveredCount > 0 && (
                <Badge variant="outline" className="text-xs text-warning">
                  {uncoveredCount} без покрытия
                </Badge>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{user.tier}</span>
          {user.telegramConnected ? (
            <Send className="h-3 w-3 text-primary" />
          ) : (
            <Send className="h-3 w-3 text-muted-foreground/30" />
          )}
        </div>
      </button>

      {isOpen && (
        <CardContent className="pt-0 space-y-2">
          {user.error ? (
            <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              {user.error}
            </div>
          ) : (
            <>
              {/* Rule cards */}
              {sortedDigests.map((digest, i) => (
                <RuleCard key={i} digest={digest} />
              ))}

              {/* Uncovered banners */}
              <UncoveredBannersSection banners={user.banners} />

              {user.rules.length === 0 && user.banners.length === 0 && (
                <p className="text-sm text-muted-foreground py-2">
                  Нет правил и активных баннеров
                </p>
              )}
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

export function AdminRuleDiagnosticTab({ sessionToken }: Props) {
  const [dateFrom, setDateFrom] = useState(daysAgo(7));
  const [dateTo, setDateTo] = useState(today());
  const [selectedUserIds, setSelectedUserIds] = useState<string[] | "all">("all");
  const [userSearch, setUserSearch] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [currentUserName, setCurrentUserName] = useState("");
  const [results, setResults] = useState<UserDiagnostic[]>([]);
  const [openUsers, setOpenUsers] = useState<Set<string>>(new Set());
  const cancelledRef = useRef(false);

  const usersForFilter = useQuery(api.adminRuleDiagnostic.getUsersForFilter, { sessionToken });
  const runDiagnosticForUser = useAction(api.adminRuleDiagnostic.runDiagnosticForUser);

  const totalUsers = useMemo(() => {
    if (!usersForFilter) return 0;
    return selectedUserIds === "all" ? usersForFilter.length : selectedUserIds.length;
  }, [usersForFilter, selectedUserIds]);

  const filteredUsers = useMemo(() => {
    if (!usersForFilter) return [];
    if (!userSearch) return usersForFilter;
    const q = userSearch.toLowerCase();
    return usersForFilter.filter(
      (u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
    );
  }, [usersForFilter, userSearch]);

  const summary = useMemo(() => {
    const totalRules = results.reduce((s, r) => s + r.rules.length, 0);
    const rulesOk = results.reduce(
      (s, r) =>
        s +
        buildRuleDigests(r).filter((d) => d.verdict === "ok").length,
      0
    );
    const rulesWithProblems = results.reduce(
      (s, r) =>
        s +
        buildRuleDigests(r).filter((d) => d.verdict === "error").length,
      0
    );
    const uncoveredBanners = results.reduce(
      (s, r) => s + r.banners.filter((b) => !b.isCovered && b.spent > 0).length,
      0
    );
    return { users: results.length, totalRules, rulesOk, rulesWithProblems, uncoveredBanners };
  }, [results]);

  const sortedResults = useMemo(() => {
    return [...results].sort((a, b) => b.problems.length - a.problems.length);
  }, [results]);

  const handleRun = async () => {
    if (!usersForFilter) return;
    const userIds =
      selectedUserIds === "all"
        ? usersForFilter.map((u) => u.userId)
        : selectedUserIds;

    setResults([]);
    setIsRunning(true);
    cancelledRef.current = false;

    for (let i = 0; i < userIds.length; i++) {
      if (cancelledRef.current) break;

      const user = usersForFilter.find((u) => u.userId === userIds[i]);
      setCurrentIndex(i);
      setCurrentUserName(user?.name ?? "");

      try {
        const result = await runDiagnosticForUser({
          sessionToken,
          userId: userIds[i],
          dateFrom,
          dateTo,
        });
        setResults((prev) => [...prev, result as UserDiagnostic]);
      } catch (err) {
        setResults((prev) => [
          ...prev,
          {
            userId: userIds[i],
            name: user?.name ?? "?",
            email: user?.email ?? "",
            tier: user?.tier ?? "",
            telegramConnected: false,
            error: err instanceof Error ? err.message : String(err),
            rules: [],
            banners: [],
            tracing: [],
            problems: [],
          },
        ]);
      }
    }

    setIsRunning(false);
  };

  const handleCancel = () => {
    cancelledRef.current = true;
  };

  const handleExport = async () => {
    const XLSX = await import("xlsx");

    const rows: Record<string, string | number>[] = [];
    for (const user of results) {
      if (user.error) {
        rows.push({
          "Пользователь": user.name,
          "Email": user.email,
          "Тариф": user.tier,
          "Ошибка": user.error,
        });
        continue;
      }
      for (const trace of user.tracing) {
        const banner = user.banners.find((b) => b.bannerId === trace.bannerId);
        const rule = user.rules.find((r) => r.name === trace.ruleName);
        rows.push({
          "Пользователь": user.name,
          "Email": user.email,
          "Тариф": user.tier,
          "Правило": trace.ruleName,
          "Тип": rule?.type || "",
          "Активно": rule?.isActive ? "Да" : "Нет",
          "stopAd": rule?.stopAd ? "Стоп" : "Уведомление",
          "Баннер": trace.bannerId,
          "Кампания": banner?.campaignId || "",
          "Расход": banner?.spent || 0,
          "Клики": banner?.clicks || 0,
          "Лиды": banner?.leads || 0,
          "CPL": banner?.cpl || "",
          "Покрыт": banner?.isCovered ? "Да" : "Нет",
          "Шаг": trace.stoppedAt,
          "Причина": trace.reason,
        });
      }
      for (const banner of user.banners) {
        const hasTrace = user.tracing.some((t) => t.bannerId === banner.bannerId);
        if (!hasTrace && banner.spent > 0) {
          rows.push({
            "Пользователь": user.name,
            "Email": user.email,
            "Тариф": user.tier,
            "Правило": "—",
            "Тип": "",
            "Активно": "",
            "stopAd": "",
            "Баннер": banner.bannerId,
            "Кампания": banner.campaignId,
            "Расход": banner.spent,
            "Клики": banner.clicks,
            "Лиды": banner.leads,
            "CPL": banner.cpl || "",
            "Покрыт": "Нет",
            "Шаг": "—",
            "Причина": "Нет правил для этого баннера",
          });
        }
      }
    }

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Диагностика правил");
    if (rows.length > 0) {
      ws["!cols"] = Object.keys(rows[0]).map((key) => ({
        wch: Math.max(key.length, ...rows.map((r) => String(r[key] || "").length)),
      }));
    }
    XLSX.writeFile(wb, `rule-diagnostic-${dateFrom}-${dateTo}.xlsx`);
  };

  const toggleUser = (userId: string) => {
    setOpenUsers((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const toggleUserSelection = (userId: string) => {
    setSelectedUserIds((prev) => {
      if (prev === "all") {
        const all = (usersForFilter || []).map((u) => u.userId);
        return all.filter((id) => id !== userId);
      }
      if (prev.includes(userId)) {
        return prev.filter((id) => id !== userId);
      }
      return [...prev, userId];
    });
  };

  return (
    <div className="space-y-6" data-testid="admin-rule-diagnostic-tab">
      {/* Filters */}
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label className="text-sm text-muted-foreground mb-1 block">Период от</label>
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-40"
              />
            </div>
            <div>
              <label className="text-sm text-muted-foreground mb-1 block">до</label>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-40"
              />
            </div>
          </div>

          {/* User selection */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <label className="text-sm text-muted-foreground">Пользователи</label>
              <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedUserIds === "all"}
                  onChange={() =>
                    setSelectedUserIds((prev) => (prev === "all" ? [] : "all"))
                  }
                  className="rounded"
                />
                Все
              </label>
            </div>
            {selectedUserIds !== "all" && (
              <>
                <div className="relative mb-2">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Поиск..."
                    value={userSearch}
                    onChange={(e) => setUserSearch(e.target.value)}
                    className="pl-9 h-9"
                  />
                </div>
                <div className="max-h-40 overflow-y-auto border rounded-lg p-2 space-y-1">
                  {filteredUsers.map((u) => (
                    <label
                      key={u.userId}
                      className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted rounded px-1 py-0.5"
                    >
                      <input
                        type="checkbox"
                        checked={selectedUserIds.includes(u.userId)}
                        onChange={() => toggleUserSelection(u.userId)}
                        className="rounded"
                      />
                      <span>{u.name}</span>
                      <span className="text-muted-foreground text-xs">
                        ({u.rulesCount} правил)
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            <Button onClick={handleRun} disabled={isRunning || !usersForFilter}>
              {isRunning ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-2 h-4 w-4" />
              )}
              Запустить проверку
            </Button>
            {isRunning && (
              <Button variant="outline" onClick={handleCancel}>
                <Square className="mr-2 h-4 w-4" />
                Отменить
              </Button>
            )}
            <Button
              variant="outline"
              onClick={handleExport}
              disabled={results.length === 0}
            >
              <Download className="mr-2 h-4 w-4" />
              Скачать Excel
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Progress */}
      {isRunning && (
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span>
                  Проверено: {currentIndex} / {totalUsers} пользователей
                </span>
                <span className="text-muted-foreground">{currentUserName}</span>
              </div>
              <div className="w-full bg-muted rounded-full h-2">
                <div
                  className="bg-primary h-2 rounded-full transition-all"
                  style={{
                    width: `${totalUsers > 0 ? (currentIndex / totalUsers) * 100 : 0}%`,
                  }}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Summary cards */}
      {results.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-3">
                <Users className="h-5 w-5 text-primary" />
                <div>
                  <p className="text-xs text-muted-foreground">Пользователей</p>
                  <p className="text-xl font-bold">{summary.users}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-3">
                <CheckCircle className="h-5 w-5 text-success" />
                <div>
                  <p className="text-xs text-muted-foreground">Правила ОК</p>
                  <p className="text-xl font-bold">
                    {summary.rulesOk}
                    <span className="text-sm font-normal text-muted-foreground">
                      {" "}/ {summary.totalRules}
                    </span>
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-3">
                <XCircle className="h-5 w-5 text-destructive" />
                <div>
                  <p className="text-xs text-muted-foreground">С ошибками</p>
                  <p className="text-xl font-bold">{summary.rulesWithProblems}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-3">
                <AlertTriangle className="h-5 w-5 text-warning" />
                <div>
                  <p className="text-xs text-muted-foreground">Без покрытия</p>
                  <p className="text-xl font-bold">{summary.uncoveredBanners}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Results per user */}
      {sortedResults.map((user) => (
        <UserResultCard
          key={user.userId}
          user={user}
          isOpen={openUsers.has(user.userId)}
          onToggle={() => toggleUser(user.userId)}
        />
      ))}
    </div>
  );
}

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
  ListChecks,
  AlertTriangle,
  ShieldCheck,
  Send,
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
    const uncoveredBanners = results.reduce(
      (s, r) => s + r.banners.filter((b) => !b.isCovered && b.spent > 0).length,
      0
    );
    const totalProblems = results.reduce((s, r) => s + r.problems.length, 0);
    return { users: results.length, totalRules, uncoveredBanners, totalProblems };
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
                <ListChecks className="h-5 w-5 text-primary" />
                <div>
                  <p className="text-xs text-muted-foreground">Правил</p>
                  <p className="text-xl font-bold">{summary.totalRules}</p>
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
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-3">
                <AlertTriangle className="h-5 w-5 text-destructive" />
                <div>
                  <p className="text-xs text-muted-foreground">Проблем</p>
                  <p className="text-xl font-bold">{summary.totalProblems}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Results per user */}
      {sortedResults.map((user) => (
        <Card key={user.userId}>
          <button
            onClick={() => toggleUser(user.userId)}
            className="w-full px-6 py-4 flex items-center justify-between text-left hover:bg-muted/50 transition-colors"
          >
            <div className="flex items-center gap-3">
              {openUsers.has(user.userId) ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
              <span className="font-medium">{user.name}</span>
              {user.error ? (
                <Badge variant="destructive">ошибка</Badge>
              ) : user.problems.length > 0 ? (
                <Badge variant="destructive">{user.problems.length} проблем</Badge>
              ) : (
                <Badge variant="success">ок</Badge>
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

          {openUsers.has(user.userId) && (
            <CardContent className="pt-0 space-y-4">
              {user.error ? (
                <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
                  {user.error}
                </div>
              ) : (
                <>
                  {/* Rules table */}
                  {user.rules.length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium mb-2">
                        Правила ({user.rules.length})
                      </h4>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b text-muted-foreground text-left">
                              <th className="pb-2 pr-3">Правило</th>
                              <th className="pb-2 pr-3">Тип</th>
                              <th className="pb-2 pr-3">Акт.</th>
                              <th className="pb-2 pr-3">stopAd</th>
                              <th className="pb-2 pr-3">Сработ.</th>
                              <th className="pb-2 pr-3">Таргет</th>
                              <th className="pb-2">Проблема</th>
                            </tr>
                          </thead>
                          <tbody>
                            {user.rules.map((r, i) => (
                              <tr key={i} className="border-b border-border/50">
                                <td className="py-1.5 pr-3">{r.name}</td>
                                <td className="py-1.5 pr-3">
                                  <Badge variant="secondary">{r.type}</Badge>
                                </td>
                                <td className="py-1.5 pr-3">
                                  {r.isActive ? "✓" : "✗"}
                                </td>
                                <td className="py-1.5 pr-3">
                                  {r.stopAd ? "Стоп" : "Уведом."}
                                </td>
                                <td className="py-1.5 pr-3">{r.triggerCount}</td>
                                <td className="py-1.5 pr-3">
                                  {r.targetAlive ? "✓" : "✗"}
                                </td>
                                <td className="py-1.5 text-destructive text-xs">
                                  {r.problem}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Banners table */}
                  {user.banners.length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium mb-2">
                        Баннеры с расходом ({user.banners.length})
                      </h4>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b text-muted-foreground text-left">
                              <th className="pb-2 pr-3">Баннер</th>
                              <th className="pb-2 pr-3">Кампания</th>
                              <th className="pb-2 pr-3">Расход</th>
                              <th className="pb-2 pr-3">Клики</th>
                              <th className="pb-2 pr-3">Лиды</th>
                              <th className="pb-2 pr-3">CPL</th>
                              <th className="pb-2 pr-3">Покрыт</th>
                              <th className="pb-2">Правила</th>
                            </tr>
                          </thead>
                          <tbody>
                            {user.banners.map((b, i) => (
                              <tr
                                key={i}
                                className={`border-b border-border/50 ${!b.isCovered ? "bg-destructive/5" : ""}`}
                              >
                                <td className="py-1.5 pr-3 font-mono text-xs">
                                  {b.bannerId}
                                </td>
                                <td className="py-1.5 pr-3 text-xs">
                                  {b.campaignName || b.campaignId}
                                </td>
                                <td className="py-1.5 pr-3">
                                  {Math.round(b.spent)}₽
                                </td>
                                <td className="py-1.5 pr-3">{b.clicks}</td>
                                <td className="py-1.5 pr-3">{b.leads}</td>
                                <td className="py-1.5 pr-3">
                                  {b.cpl !== null ? `${Math.round(b.cpl)}₽` : "—"}
                                </td>
                                <td className="py-1.5 pr-3">
                                  {b.isCovered ? (
                                    <ShieldCheck className="h-4 w-4 text-success" />
                                  ) : (
                                    <AlertTriangle className="h-4 w-4 text-destructive" />
                                  )}
                                </td>
                                <td className="py-1.5 text-xs text-muted-foreground">
                                  {b.coveredByRules.join(", ") || "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Tracing table */}
                  {user.tracing.length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium mb-2">
                        Трассировка ({user.tracing.length})
                      </h4>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b text-muted-foreground text-left">
                              <th className="pb-2 pr-3">Баннер</th>
                              <th className="pb-2 pr-3">Правило</th>
                              <th className="pb-2 pr-3">Шаг</th>
                              <th className="pb-2">Причина</th>
                            </tr>
                          </thead>
                          <tbody>
                            {user.tracing.map((t, i) => (
                              <tr key={i} className="border-b border-border/50">
                                <td className="py-1.5 pr-3 font-mono text-xs">
                                  {t.bannerId}
                                </td>
                                <td className="py-1.5 pr-3">{t.ruleName}</td>
                                <td className="py-1.5 pr-3">
                                  <Badge
                                    variant={
                                      t.stoppedAt === "triggered"
                                        ? "success"
                                        : "secondary"
                                    }
                                  >
                                    {t.stoppedAt}
                                  </Badge>
                                </td>
                                <td className="py-1.5 text-xs">{t.reason}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Problems */}
                  {user.problems.length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium mb-2">Проблемы</h4>
                      <div className="space-y-1">
                        {user.problems.map((p, i) => (
                          <div key={i} className="flex items-start gap-2 text-sm">
                            <Badge
                              variant="destructive"
                              className="shrink-0 text-xs"
                            >
                              {p.category}
                            </Badge>
                            <span>{p.message}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

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
      ))}
    </div>
  );
}

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useAuth } from "@/lib/useAuth";
import { Id } from "../../convex/_generated/dataModel";
import { TIERS } from "../../convex/billing";
import {
  Building2,
  Users,
  Loader2,
  AlertTriangle,
  Snowflake,
  Lock,
  CheckCircle,
  TrendingUp,
  Calendar,
  Crown,
} from "lucide-react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function getYearMonth(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function GracePhaseStatus({ status }: { status: NonNullable<ReturnType<typeof useLoadStatus>> }) {
  if (status.expiredGracePhase === "frozen") {
    return (
      <div className="flex items-center gap-3 p-4 rounded-lg bg-destructive/10 border border-destructive/30">
        <Snowflake className="h-5 w-5 text-destructive shrink-0" />
        <div>
          <p className="font-medium text-destructive">Организация заморожена</p>
          <p className="text-sm text-muted-foreground">Подписка истекла. Все кабинеты заархивированы.</p>
          <Link to="/pricing" className="text-sm underline text-destructive">Восстановить подписку</Link>
        </div>
      </div>
    );
  }

  if (status.expiredGracePhase === "deep_read_only") {
    return (
      <div className="flex items-center gap-3 p-4 rounded-lg bg-destructive/10 border border-destructive/30">
        <Lock className="h-5 w-5 text-destructive shrink-0" />
        <div>
          <p className="font-medium text-destructive">Только просмотр (расширенный)</p>
          <p className="text-sm text-muted-foreground">Правила отключены. Кабинеты заархивированы.</p>
          <Link to="/pricing" className="text-sm underline text-destructive">Продлить подписку</Link>
        </div>
      </div>
    );
  }

  if (status.expiredGracePhase === "read_only") {
    return (
      <div className="flex items-center gap-3 p-4 rounded-lg bg-warning/10 border border-warning/30">
        <Lock className="h-5 w-5 text-warning shrink-0" />
        <div>
          <p className="font-medium">Только просмотр</p>
          <p className="text-sm text-muted-foreground">Подписка истекла. Запись заблокирована.</p>
          <Link to="/pricing" className="text-sm underline font-medium">Продлить подписку</Link>
        </div>
      </div>
    );
  }

  if (status.expiredGracePhase === "warnings") {
    const daysLeft = status.expiredGraceStartedAt
      ? Math.max(0, 14 - Math.floor((Date.now() - status.expiredGraceStartedAt) / 86400000))
      : 14;
    return (
      <div className="flex items-center gap-3 p-4 rounded-lg bg-warning/10 border border-warning/30">
        <AlertTriangle className="h-5 w-5 text-warning shrink-0" />
        <div>
          <p className="font-medium">Подписка истекла</p>
          <p className="text-sm text-muted-foreground">
            {daysLeft > 0 ? `Осталось ${daysLeft} дн. до перехода в режим только чтения.` : "Скоро перейдёт в режим только чтения."}
          </p>
          <Link to="/pricing" className="text-sm underline font-medium">Продлить подписку</Link>
        </div>
      </div>
    );
  }

  if (status.featuresDisabledAt) {
    return (
      <div className="flex items-center gap-3 p-4 rounded-lg bg-warning/10 border border-warning/30">
        <AlertTriangle className="h-5 w-5 text-warning shrink-0" />
        <div>
          <p className="font-medium">Превышение лимита нагрузки</p>
          <p className="text-sm text-muted-foreground">
            Конструктор правил и добавление кабинетов отключены.
          </p>
          <Link to="/pricing" className="text-sm underline font-medium">Обновить тариф</Link>
        </div>
      </div>
    );
  }

  if (status.isOverLimit) {
    return (
      <div className="flex items-center gap-3 p-4 rounded-lg bg-primary/10 border border-primary/30">
        <TrendingUp className="h-5 w-5 text-primary shrink-0" />
        <div>
          <p className="font-medium">Нагрузка превышает лимит</p>
          <p className="text-sm text-muted-foreground">
            {status.currentLoadUnits} из {status.maxLoadUnits} ед.
            Рекомендуем обновить тариф для стабильной работы.
          </p>
        </div>
      </div>
    );
  }

  return null;
}

function LoadGauge({ current, max }: { current: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((current / max) * 100)) : 0;
  const isOver = current > max;
  const barColor = isOver ? "bg-destructive" : pct > 80 ? "bg-warning" : "bg-primary";

  return (
    <div className="space-y-2">
      <div className="flex items-end justify-between">
        <span className="text-3xl font-bold tabular-nums">{current}</span>
        <span className="text-muted-foreground text-sm">из {max} ед.</span>
      </div>
      <div className="h-3 bg-muted rounded-full overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", barColor)}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">{pct}% использовано</p>
    </div>
  );
}

function LoadChart({ data, max }: { data: { date: string; loadUnits: number }[]; max: number }) {
  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">Нет данных за этот месяц</p>;
  }

  const peak = Math.max(max, ...data.map((d) => d.loadUnits));
  const barH = 80;

  return (
    <div className="flex items-end gap-px overflow-x-auto pb-1" style={{ minHeight: barH + 20 }}>
      {data.map((d) => {
        const h = peak > 0 ? Math.max(2, (d.loadUnits / peak) * barH) : 2;
        const isOver = d.loadUnits > max;
        const day = d.date.split("-")[2];
        return (
          <div key={d.date} className="flex flex-col items-center gap-1 min-w-[14px]" title={`${d.date}: ${d.loadUnits} ед.`}>
            <div
              className={cn(
                "w-2.5 rounded-sm transition-all",
                isOver ? "bg-destructive/80" : "bg-primary/70"
              )}
              style={{ height: h }}
            />
            {parseInt(day) % 5 === 1 && (
              <span className="text-[9px] text-muted-foreground">{day}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function OrgDashboardPage() {
  const { user } = useAuth();
  const userId = user?.userId as Id<"users"> | undefined;

  const org = useQuery(
    api.organizations.getCurrent,
    userId ? { userId } : "skip"
  );
  const status = useQuery(
    api.loadUnits.getCurrentLoadStatus,
    userId ? { userId } : "skip"
  );

  const now = new Date();
  const yearMonth = getYearMonth(now);
  const history = useQuery(
    api.loadUnits.getLoadHistory,
    userId ? { userId, yearMonth } : "skip"
  );

  const isLoading = org === undefined || status === undefined;

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!org) {
    return (
      <div className="text-center py-12 space-y-4">
        <Building2 className="h-12 w-12 text-muted-foreground mx-auto" />
        <h3 className="text-lg font-medium">Нет организации</h3>
        <p className="text-muted-foreground">Создайте агентство для доступа к этой странице.</p>
        <Button asChild>
          <Link to="/agency/onboarding">Создать агентство</Link>
        </Button>
      </div>
    );
  }

  const activeMembers = org.members.filter((m) => m.status === "active");
  const managers = activeMembers.filter((m) => m.role === "manager");
  const tierConfig = TIERS[org.subscriptionTier as keyof typeof TIERS];
  const daysUntilExpiry = org.subscriptionExpiresAt
    ? Math.max(0, Math.ceil((org.subscriptionExpiresAt - Date.now()) / 86400000))
    : null;

  return (
    <div className="space-y-6" data-testid="org-dashboard-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Building2 className="h-6 w-6 text-primary" />
          {org.name}
        </h1>
        <Badge variant="secondary" className="text-sm">
          <Crown className="h-3.5 w-3.5 mr-1" />
          {tierConfig?.name ?? org.subscriptionTier}
        </Badge>
      </div>

      {/* Grace phase warning */}
      {status && <GracePhaseStatus status={status} />}

      {/* Stats cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Load units */}
        <Card data-testid="load-units-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Нагрузка</CardTitle>
          </CardHeader>
          <CardContent>
            {status ? (
              <LoadGauge current={status.currentLoadUnits} max={status.maxLoadUnits} />
            ) : (
              <p className="text-muted-foreground text-sm">Нет данных</p>
            )}
          </CardContent>
        </Card>

        {/* Team */}
        <Card data-testid="team-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Команда</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-end justify-between">
              <span className="text-3xl font-bold tabular-nums">{activeMembers.length}</span>
              <span className="text-muted-foreground text-sm">
                {managers.length} менеджер{managers.length !== 1 ? "ов" : ""}
              </span>
            </div>
            <Button variant="outline" size="sm" className="w-full" asChild>
              <Link to="/team">
                <Users className="h-4 w-4 mr-1.5" />
                Управление командой
              </Link>
            </Button>
          </CardContent>
        </Card>

        {/* Subscription */}
        <Card data-testid="subscription-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Подписка</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-end justify-between">
              <span className="text-3xl font-bold tabular-nums">
                {daysUntilExpiry !== null ? daysUntilExpiry : "—"}
              </span>
              <span className="text-muted-foreground text-sm">дн. до конца</span>
            </div>
            {daysUntilExpiry !== null && daysUntilExpiry <= 7 ? (
              <Badge variant="warning" className="w-full justify-center">
                <Calendar className="h-3.5 w-3.5 mr-1" />
                Скоро истекает
              </Badge>
            ) : daysUntilExpiry !== null ? (
              <Badge variant="success" className="w-full justify-center">
                <CheckCircle className="h-3.5 w-3.5 mr-1" />
                Активна
              </Badge>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {/* Load history chart */}
      <Card data-testid="load-history-card">
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Нагрузка за {now.toLocaleDateString("ru-RU", { month: "long", year: "numeric" })}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <LoadChart data={history ?? []} max={status?.maxLoadUnits ?? 0} />
          {status && (
            <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <div className="w-2.5 h-2.5 rounded-sm bg-primary/70" /> В норме
              </span>
              <span className="flex items-center gap-1">
                <div className="w-2.5 h-2.5 rounded-sm bg-destructive/80" /> Превышение
              </span>
              <span className="ml-auto">Лимит: {status.maxLoadUnits} ед.</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Niches config */}
      {org.nichesConfig && org.nichesConfig.length > 0 && (
        <Card data-testid="niches-card">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">Ниши</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {org.nichesConfig.map((n) => (
                <Badge key={n.niche} variant="outline">
                  {n.niche}: {n.cabinetsCount} каб.
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default OrgDashboardPage;

import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useAuth } from '../lib/useAuth';
import { Id } from '../../convex/_generated/dataModel';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { LayoutDashboard, Loader2, Trash2, CheckCircle2, Building2, TrendingUp, TrendingDown, Minus, Zap, ShieldOff, Bell } from 'lucide-react';
import { cn } from '../lib/utils';
import { Link } from 'react-router-dom';

/** Animated counter hook */
function useAnimatedNumber(target: number, duration = 800) {
  const [current, setCurrent] = useState(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const start = current;
    const diff = target - start;
    if (diff === 0) return;
    const startTime = performance.now();

    const animate = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // ease-out quad
      const eased = 1 - (1 - progress) * (1 - progress);
      setCurrent(Math.round(start + diff * eased));
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      }
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration]);

  return current;
}

/** Mini bar chart for 7-day savings */
function SavingsChart({ data }: { data: { date: string; amount: number }[] }) {
  const max = Math.max(...data.map((d) => d.amount), 1);

  return (
    <div className="flex items-end gap-1 h-16" data-testid="savings-chart">
      {data.map((d) => {
        const height = Math.max((d.amount / max) * 100, 4);
        return (
          <div
            key={d.date}
            className="flex-1 bg-primary/20 rounded-t relative group"
            style={{ height: `${height}%` }}
          >
            <div
              className="absolute bottom-0 left-0 right-0 bg-primary rounded-t transition-all"
              style={{ height: `${height}%` }}
            />
            <div className="absolute -top-8 left-1/2 -translate-x-1/2 hidden group-hover:block bg-foreground text-background text-xs px-1.5 py-0.5 rounded whitespace-nowrap z-10">
              {d.amount.toLocaleString()}₽
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Savings Widget */
function SavingsWidget({ userId }: { userId: Id<"users"> }) {
  const savedToday = useQuery(api.ruleEngine.getSavedToday, { userId });
  const savedHistory = useQuery(api.ruleEngine.getSavedHistory, { userId });

  const todayValue = savedToday ?? 0;
  const animatedValue = useAnimatedNumber(todayValue);

  // Calculate percentage change vs previous 7 days
  const historyData = savedHistory ?? [];
  const thisWeekTotal = historyData.reduce((s, d) => s + d.amount, 0);

  // For percentage change, we'd need previous week data.
  // We'll compute based on the first half vs second half of available data.
  const halfLen = Math.floor(historyData.length / 2);
  const firstHalf = historyData.slice(0, halfLen).reduce((s, d) => s + d.amount, 0);
  const secondHalf = historyData.slice(halfLen).reduce((s, d) => s + d.amount, 0);

  let percentChange: number | null = null;
  if (firstHalf > 0) {
    percentChange = Math.round(((secondHalf - firstHalf) / firstHalf) * 100);
  } else if (secondHalf > 0) {
    percentChange = 100;
  }

  return (
    <Card data-testid="savings-widget">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">Экономия сегодня</CardTitle>
        <CardDescription>Сумма сэкономленного бюджета</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-baseline gap-3">
          <span className="text-4xl font-bold tabular-nums" data-testid="savings-amount">
            {animatedValue.toLocaleString()} ₽
          </span>
          {percentChange !== null && (
            <span
              className={cn(
                'flex items-center gap-0.5 text-sm font-medium',
                percentChange > 0
                  ? 'text-green-600'
                  : percentChange < 0
                    ? 'text-red-600'
                    : 'text-muted-foreground'
              )}
              data-testid="savings-change"
            >
              {percentChange > 0 ? (
                <TrendingUp className="w-4 h-4" />
              ) : percentChange < 0 ? (
                <TrendingDown className="w-4 h-4" />
              ) : (
                <Minus className="w-4 h-4" />
              )}
              {percentChange > 0 ? '+' : ''}
              {percentChange}%
            </span>
          )}
          {percentChange === null && thisWeekTotal === 0 && (
            <span className="text-sm text-muted-foreground" data-testid="savings-change">—</span>
          )}
        </div>

        {historyData.length > 0 && <SavingsChart data={historyData} />}

        <div className="flex justify-between text-xs text-muted-foreground">
          {historyData.length > 0 && (
            <>
              <span>
                {new Date(historyData[0].date).toLocaleDateString('ru-RU', {
                  day: 'numeric',
                  month: 'short',
                })}
              </span>
              <span>Сегодня</span>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Activity Block — triggers, stops, notifications counts */
function ActivityBlock({ userId }: { userId: Id<"users"> }) {
  const stats = useQuery(api.ruleEngine.getActivityStats, { userId });

  const items = [
    {
      label: 'Срабатываний',
      value: stats?.triggers ?? 0,
      icon: Zap,
      color: 'text-amber-500',
      bg: 'bg-amber-500/10',
    },
    {
      label: 'Остановок',
      value: stats?.stops ?? 0,
      icon: ShieldOff,
      color: 'text-red-500',
      bg: 'bg-red-500/10',
    },
    {
      label: 'Уведомлений',
      value: stats?.notifications ?? 0,
      icon: Bell,
      color: 'text-blue-500',
      bg: 'bg-blue-500/10',
    },
  ];

  return (
    <div className="grid grid-cols-3 gap-4" data-testid="activity-block">
      {items.map((item) => (
        <Card key={item.label}>
          <CardContent className="flex items-center gap-3 p-4">
            <div className={cn('p-2 rounded-lg', item.bg)}>
              <item.icon className={cn('w-5 h-5', item.color)} />
            </div>
            <div>
              <p className="text-2xl font-bold tabular-nums">{item.value}</p>
              <p className="text-xs text-muted-foreground">{item.label}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** Health indicator dot for account status */
function HealthIndicator({ status }: { status: string }) {
  const colorClass =
    status === 'active'
      ? 'bg-green-500'
      : status === 'error'
        ? 'bg-red-500'
        : 'bg-yellow-500';

  return (
    <span
      className={cn('inline-block w-2.5 h-2.5 rounded-full shrink-0', colorClass)}
      data-testid="health-indicator"
      title={
        status === 'active'
          ? 'Активен'
          : status === 'error'
            ? 'Ошибка синхронизации'
            : 'Приостановлен'
      }
    />
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  const typedUserId = user?.userId as Id<"users"> | undefined;

  const accounts = useQuery(
    api.adAccounts.list,
    typedUserId ? { userId: typedUserId } : 'skip'
  );

  const settings = useQuery(
    api.userSettings.get,
    typedUserId ? { userId: typedUserId } : 'skip'
  );

  const setActiveAccount = useMutation(api.userSettings.setActiveAccount);
  const disconnectAccount = useMutation(api.adAccounts.disconnect);

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const isLoading = accounts === undefined || settings === undefined;
  const activeAccountId = settings?.activeAccountId;

  const handleSelectAccount = async (accountId: Id<"adAccounts">) => {
    if (!typedUserId) return;
    await setActiveAccount({ userId: typedUserId, accountId });
  };

  const handleDeleteAccount = async (accountId: Id<"adAccounts">) => {
    if (!typedUserId) return;
    await disconnectAccount({ accountId, userId: typedUserId });
  };

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6" data-testid="dashboard-page">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <LayoutDashboard className="w-7 h-7" />
          Дашборд
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Выберите активный рекламный кабинет
        </p>
      </div>

      {/* Savings Widget */}
      {typedUserId && <SavingsWidget userId={typedUserId} />}

      {/* Activity Block */}
      {typedUserId && <ActivityBlock userId={typedUserId} />}

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : accounts.length === 0 ? (
        /* Empty state */
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 gap-4">
            <Building2 className="w-12 h-12 text-muted-foreground" />
            <div className="text-center space-y-1">
              <p className="text-lg font-medium text-foreground">
                Нет подключённых кабинетов
              </p>
              <p className="text-sm text-muted-foreground">
                Подключите рекламный кабинет VK Ads, чтобы начать работу
              </p>
            </div>
            <Link
              to="/accounts"
              className={cn(
                'inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-all',
                'bg-primary text-primary-foreground hover:bg-primary/90'
              )}
            >
              Подключить кабинет
            </Link>
          </CardContent>
        </Card>
      ) : (
        /* Account cards */
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Рекламные кабинеты</CardTitle>
            <CardDescription>
              Нажмите на кабинет, чтобы сделать его активным
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2" data-testid="account-cards">
            {accounts.map((account) => {
              const isActive = activeAccountId === account._id;
              return (
                <div
                  key={account._id}
                  onClick={() => handleSelectAccount(account._id as Id<"adAccounts">)}
                  className={cn(
                    'flex items-center gap-3 p-4 rounded-lg border cursor-pointer transition-colors',
                    isActive
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:bg-muted/50'
                  )}
                  data-testid={`account-card-${account._id}`}
                >
                  <HealthIndicator status={account.status} />
                  <Building2 className="w-5 h-5 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{account.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {account.status === 'active' ? 'Активен' : account.status === 'paused' ? 'Приостановлен' : 'Ошибка'}
                    </p>
                  </div>
                  {isActive && (
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-primary text-primary-foreground shrink-0">
                      Выбран
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteAccount(account._id as Id<"adAccounts">);
                    }}
                    className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors shrink-0"
                    title="Удалить кабинет"
                    data-testid={`delete-account-${account._id}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

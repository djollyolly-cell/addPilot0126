import { useState, useMemo, useRef, useCallback, useEffect, memo } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useAuth } from '../lib/useAuth';
import { Id } from '../../convex/_generated/dataModel';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Button } from '../components/ui/button';
import {
  LayoutDashboard, Loader2, Trash2, Building2, TrendingUp, TrendingDown, Minus,
  Zap, ShieldOff, Bell, ListFilter, Clock, Inbox, AlertTriangle, Crown,
  Download, Image, Lock,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { DisconnectDialog } from '../components/DisconnectDialog';
import { Link, useNavigate } from 'react-router-dom';
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

/* ───────────────────────── helpers ───────────────────────── */

type PeriodPreset = '7' | '30' | '90' | 'custom';

const PERIOD_OPTIONS: { value: PeriodPreset; label: string }[] = [
  { value: '7', label: '7 дней' },
  { value: '30', label: '30 дней' },
  { value: '90', label: '90 дней' },
  { value: 'custom', label: 'Свой период' },
];

const PIE_COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];

function getDateRange(preset: PeriodPreset, customStart: string, customEnd: string) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (preset === 'custom') {
    const start = customStart ? new Date(customStart) : new Date(today.getTime() - 7 * 86400000);
    const end = customEnd ? new Date(customEnd) : today;
    return {
      startDate: start.getTime(),
      endDate: end.getTime() + 86400000 - 1,
    };
  }

  const days = Number(preset);
  const startDate = new Date(today.getTime() - (days - 1) * 86400000);
  return {
    startDate: startDate.getTime(),
    endDate: today.getTime() + 86400000 - 1,
  };
}

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

/** Export chart area as PNG via canvas */
function useExportPng(ref: React.RefObject<HTMLDivElement | null>) {
  return useCallback(async () => {
    const el = ref.current;
    if (!el) return;
    const svg = el.querySelector('svg');
    if (!svg) return;

    const svgData = new XMLSerializer().serializeToString(svg);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const img = new window.Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      const url = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = 'chart.png';
      a.click();
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgData);
  }, [ref]);
}

/** Export top-ads data as CSV */
function exportCsv(
  data: { adId: string; adName: string; totalSaved: number; totalSpent: number; triggers: number }[]
) {
  const header = 'ID объявления,Название,Сэкономлено (₽),Потрачено (₽),Срабатываний\n';
  const rows = data
    .map((d) => `${d.adId},"${d.adName}",${d.totalSaved},${d.totalSpent},${d.triggers}`)
    .join('\n');
  const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'top-ads.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-muted-foreground" data-testid="no-data">
      <Inbox className="w-10 h-10 mb-2 opacity-30" />
      <p className="text-sm">{message}</p>
    </div>
  );
}

/* ───────────────────────── sub-components ───────────────────────── */

/** Action type label mapping */
const ACTION_TYPE_LABELS: Record<string, string> = {
  stopped: 'Остановлено',
  notified: 'Уведомление',
  stopped_and_notified: 'Остановлено + уведомление',
};

/** Health indicator dot for account status */
const HealthIndicator = memo(function HealthIndicator({ status }: { status: string }) {
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
});

/** Event Feed — recent action logs with filters */
const EventFeed = memo(function EventFeed({
  userId,
  accounts,
}: {
  userId: Id<"users">;
  accounts: { _id: string; name: string }[] | undefined;
}) {
  const [filterType, setFilterType] = useState<string>('all');
  const [filterAccount, setFilterAccount] = useState<string>('all');

  const queryArgs: {
    userId: Id<"users">;
    actionType?: "stopped" | "notified" | "stopped_and_notified";
    accountId?: Id<"adAccounts">;
    limit?: number;
  } = { userId, limit: 10 };

  if (filterType !== 'all') {
    queryArgs.actionType = filterType as "stopped" | "notified" | "stopped_and_notified";
  }
  if (filterAccount !== 'all') {
    queryArgs.accountId = filterAccount as Id<"adAccounts">;
  }

  const events = useQuery(api.ruleEngine.getRecentEvents, queryArgs);

  const actionIcon = (type: string) => {
    switch (type) {
      case 'stopped':
        return <ShieldOff className="w-4 h-4 text-red-500" />;
      case 'notified':
        return <Bell className="w-4 h-4 text-blue-500" />;
      case 'stopped_and_notified':
        return <Zap className="w-4 h-4 text-amber-500" />;
      default:
        return <Zap className="w-4 h-4" />;
    }
  };

  return (
    <Card data-testid="event-feed">
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <ListFilter className="w-5 h-5" />
          Лента событий
        </CardTitle>
        <CardDescription>Последние действия автоматики</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Filters */}
        <div className="flex flex-wrap gap-3" data-testid="event-filters">
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="px-3 py-1.5 border rounded-lg text-sm bg-background"
            data-testid="filter-type"
          >
            <option value="all">Все типы</option>
            <option value="stopped">Остановки</option>
            <option value="notified">Уведомления</option>
            <option value="stopped_and_notified">Остановки + уведомления</option>
          </select>

          <select
            value={filterAccount}
            onChange={(e) => setFilterAccount(e.target.value)}
            className="px-3 py-1.5 border rounded-lg text-sm bg-background"
            data-testid="filter-account"
          >
            <option value="all">Все кабинеты</option>
            {(accounts ?? []).map((acc) => (
              <option key={acc._id} value={acc._id}>
                {acc.name}
              </option>
            ))}
          </select>
        </div>

        {/* Event list */}
        {events === undefined ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : events.length === 0 ? (
          <div className="flex flex-col items-center py-8 text-muted-foreground gap-2">
            <Inbox className="w-8 h-8" />
            <p className="text-sm" data-testid="event-feed-empty">
              {filterType !== 'all' || filterAccount !== 'all'
                ? 'Ничего не найдено'
                : 'Пока нет событий'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {events.map((event) => (
              <div
                key={event._id}
                className="flex items-start gap-3 p-3 rounded-lg border border-border hover:bg-muted/30 transition-colors"
                data-testid="event-item"
              >
                <div className="pt-0.5">{actionIcon(event.actionType)}</div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{event.adName}</p>
                  <p className="text-xs text-muted-foreground truncate">{event.reason}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                      {ACTION_TYPE_LABELS[event.actionType] ?? event.actionType}
                    </span>
                    {event.savedAmount > 0 && (
                      <span className="text-xs text-green-600 font-medium">
                        +{event.savedAmount.toLocaleString()} ₽
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                  <Clock className="w-3 h-3" />
                  {new Date(event.createdAt).toLocaleString('ru-RU', {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
});

/** In-app user notifications (sent by admin) */
const UserNotificationsBanner = memo(function UserNotificationsBanner({ userId }: { userId: Id<"users"> }) {
  const notifications = useQuery(api.userNotifications.getUnread, { userId });
  const markRead = useMutation(api.userNotifications.markRead);

  if (!notifications || notifications.length === 0) return null;

  const iconColor: Record<string, string> = {
    info: "text-blue-500 bg-blue-500/10",
    warning: "text-amber-500 bg-amber-500/10",
    payment: "text-destructive bg-destructive/10",
  };
  const borderColor: Record<string, string> = {
    info: "border-blue-500/30",
    warning: "border-amber-500/30",
    payment: "border-destructive/30",
  };

  return (
    <>
      {notifications.map((n) => (
        <Card key={n._id} className={cn("border", borderColor[n.type] || "border-border")} data-testid="user-notification">
          <CardContent className="flex items-start gap-4 p-4">
            <div className={cn("p-2 rounded-full shrink-0", iconColor[n.type] || "bg-muted")}>
              <Bell className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium">{n.title}</p>
              <p className="text-sm text-muted-foreground mt-0.5">{n.message}</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 text-muted-foreground"
              onClick={() => markRead({ notificationId: n._id })}
            >
              Закрыть
            </Button>
          </CardContent>
        </Card>
      ))}
    </>
  );
});

/** Expired Subscription Banner */
const ExpiredSubscriptionBanner = memo(function ExpiredSubscriptionBanner() {
  const navigate = useNavigate();

  return (
    <Card className="border-destructive bg-destructive/5" data-testid="expired-subscription-banner">
      <CardContent className="flex items-center gap-4 p-4">
        <div className="p-2 rounded-full bg-destructive/10">
          <AlertTriangle className="w-6 h-6 text-destructive" />
        </div>
        <div className="flex-1">
          <p className="font-medium text-destructive">Подписка истекла</p>
          <p className="text-sm text-muted-foreground">
            Лишние кабинеты и правила деактивированы. Продлите подписку для восстановления доступа.
          </p>
        </div>
        <Button onClick={() => navigate('/pricing')} variant="destructive" size="sm">
          <Crown className="w-4 h-4 mr-2" />
          Продлить
        </Button>
      </CardContent>
    </Card>
  );
});

/** Expiring Soon Banner (7 days or less) */
const ExpiringSoonBanner = memo(function ExpiringSoonBanner({ expiresAt }: { expiresAt: number }) {
  const navigate = useNavigate();
  const daysLeft = Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000));

  if (daysLeft > 7) return null;

  const expiryDate = new Date(expiresAt);
  const dateStr = expiryDate.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
  });

  return (
    <Card className="border-yellow-500 bg-yellow-500/5" data-testid="expiring-soon-banner">
      <CardContent className="flex items-center gap-4 p-4">
        <div className="p-2 rounded-full bg-yellow-500/10">
          <Clock className="w-6 h-6 text-yellow-600" />
        </div>
        <div className="flex-1">
          <p className="font-medium text-yellow-700 dark:text-yellow-500">
            Подписка истекает {daysLeft === 1 ? 'завтра' : `через ${daysLeft} дн.`}
          </p>
          <p className="text-sm text-muted-foreground">
            Срок действия подписки заканчивается {dateStr}. Продлите заранее, чтобы не потерять доступ.
          </p>
        </div>
        <Button onClick={() => navigate('/pricing')} variant="outline" size="sm" className="border-yellow-500 text-yellow-700 hover:bg-yellow-500/10">
          <Crown className="w-4 h-4 mr-2" />
          Продлить
        </Button>
      </CardContent>
    </Card>
  );
});

/* ───────────────────────── main page ───────────────────────── */

export function DashboardPage() {
  const { user } = useAuth();
  const typedUserId = user?.userId as Id<"users"> | undefined;

  /* ── period state (analytics) ── */
  const [period, setPeriod] = useState<PeriodPreset>('7');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [dateError, setDateError] = useState<string | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<{ id: string; name: string; isAgency: boolean } | null>(null);

  const chartRef = useRef<HTMLDivElement | null>(null);
  const handleExportPng = useExportPng(chartRef);

  const { startDate, endDate } = useMemo(
    () => getDateRange(period, customStart, customEnd),
    [period, customStart, customEnd]
  );

  const handleCustomStartChange = (val: string) => {
    setCustomStart(val);
    setDateError(null);
    if (val) {
      const d = new Date(val);
      const today = new Date();
      today.setHours(23, 59, 59, 999);
      if (d.getTime() > today.getTime()) {
        setDateError('Дата не может быть в будущем');
      }
    }
  };

  const handleCustomEndChange = (val: string) => {
    setCustomEnd(val);
    setDateError(null);
    if (val) {
      const d = new Date(val);
      const today = new Date();
      today.setHours(23, 59, 59, 999);
      if (d.getTime() > today.getTime()) {
        setDateError('Дата не может быть в будущем');
      }
    }
  };

  /* ── queries: dashboard core ── */
  const accounts = useQuery(
    api.adAccounts.list,
    typedUserId ? { userId: typedUserId } : 'skip'
  );

  const settings = useQuery(
    api.userSettings.get,
    typedUserId ? { userId: typedUserId } : 'skip'
  );

  const savedToday = useQuery(
    api.ruleEngine.getSavedToday,
    typedUserId ? { userId: typedUserId } : 'skip'
  );

  const activityStats = useQuery(
    api.ruleEngine.getActivityStats,
    typedUserId ? { userId: typedUserId } : 'skip'
  );

  /* ── queries: analytics ── */
  const savingsData = useQuery(
    api.ruleEngine.getAnalyticsSavings,
    typedUserId ? { userId: typedUserId, startDate, endDate } : 'skip'
  );

  const typeData = useQuery(
    api.ruleEngine.getAnalyticsByType,
    typedUserId ? { userId: typedUserId, startDate, endDate } : 'skip'
  );

  const triggerData = useQuery(
    api.ruleEngine.getAnalyticsTriggersByRule,
    typedUserId ? { userId: typedUserId, startDate, endDate } : 'skip'
  );

  const topAdsData = useQuery(
    api.ruleEngine.getTopAds,
    typedUserId ? { userId: typedUserId, startDate, endDate } : 'skip'
  );

  const roiData = useQuery(
    api.ruleEngine.getROI,
    typedUserId ? { userId: typedUserId, startDate, endDate } : 'skip'
  );

  /* ── mutations ── */
  const setActiveAccount = useMutation(api.userSettings.setActiveAccount);
  const disconnectAccount = useMutation(api.adAccounts.disconnect);

  /* ── animated today value ── */
  const todayValue = savedToday ?? 0;
  const animatedSaved = useAnimatedNumber(todayValue);

  /* ── percentage change (savings history from analytics 7d) ── */
  const savedHistory = useQuery(
    api.ruleEngine.getSavedHistory,
    typedUserId ? { userId: typedUserId } : 'skip'
  );
  const historyData = savedHistory ?? [];
  const halfLen = Math.floor(historyData.length / 2);
  const firstHalf = historyData.slice(0, halfLen).reduce((s, d) => s + d.amount, 0);
  const secondHalf = historyData.slice(halfLen).reduce((s, d) => s + d.amount, 0);
  const thisWeekTotal = historyData.reduce((s, d) => s + d.amount, 0);

  let percentChange: number | null = null;
  if (firstHalf > 0) {
    percentChange = Math.round(((secondHalf - firstHalf) / firstHalf) * 100);
  } else if (secondHalf > 0) {
    percentChange = 100;
  }

  /* ── derived ── */
  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const isLoading = accounts === undefined || settings === undefined;
  const activeAccountId = settings?.activeAccountId;
  const isFreemium = user.subscriptionTier === 'freemium';

  const isExpired = user.subscriptionTier !== 'freemium' &&
    user.subscriptionExpiresAt &&
    user.subscriptionExpiresAt < Date.now();

  const isExpiringSoon = user.subscriptionTier !== 'freemium' &&
    user.subscriptionExpiresAt &&
    user.subscriptionExpiresAt > Date.now() &&
    user.subscriptionExpiresAt < Date.now() + 7 * 24 * 60 * 60 * 1000;

  const analyticsLoading =
    savingsData === undefined ||
    typeData === undefined ||
    triggerData === undefined ||
    topAdsData === undefined ||
    roiData === undefined;

  const hasData = savingsData && savingsData.some((d) => d.amount > 0);
  const hasTypeData = typeData && typeData.some((d) => d.count > 0);
  const hasTriggerData = triggerData && triggerData.length > 0;
  const hasTopAds = topAdsData && topAdsData.length > 0;

  const handleSelectAccount = async (accountId: Id<"adAccounts">) => {
    if (!typedUserId) return;
    await setActiveAccount({ userId: typedUserId, accountId });
  };

  const handleDeleteAccount = async () => {
    if (!typedUserId || !disconnectTarget) return;
    try {
      await disconnectAccount({
        accountId: disconnectTarget.id as Id<"adAccounts">,
        userId: typedUserId,
      });
    } catch (err) {
      console.error("Disconnect failed:", err);
    }
    setDisconnectTarget(null);
  };

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6" data-testid="dashboard-page">
      {/* ── User notifications ── */}
      {typedUserId && <UserNotificationsBanner userId={typedUserId} />}

      {/* ── Subscription banners ── */}
      {isExpired && <ExpiredSubscriptionBanner />}
      {isExpiringSoon && user.subscriptionExpiresAt && (
        <ExpiringSoonBanner expiresAt={user.subscriptionExpiresAt} />
      )}

      {/* ── Header ── */}
      <div>
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <LayoutDashboard className="w-7 h-7" />
          Дашборд
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Обзор автоматизации и аналитика
        </p>
      </div>

      {/* ── Today's stats row (4 compact cards) ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4" data-testid="today-stats-row">
        {/* Savings today */}
        <Card data-testid="savings-widget">
          <CardContent className="flex items-center gap-3 p-4">
            <div className="p-2 rounded-lg bg-green-500/10">
              <TrendingUp className="w-5 h-5 text-green-500" />
            </div>
            <div>
              <p className="text-2xl font-bold tabular-nums" data-testid="savings-amount">
                {animatedSaved.toLocaleString()} <span className="text-base font-normal">₽</span>
              </p>
              <div className="flex items-center gap-1">
                <p className="text-xs text-muted-foreground">Экономия сегодня</p>
                {percentChange !== null && (
                  <span
                    className={cn(
                      'flex items-center gap-0.5 text-xs font-medium',
                      percentChange > 0
                        ? 'text-green-600'
                        : percentChange < 0
                          ? 'text-red-600'
                          : 'text-muted-foreground'
                    )}
                    data-testid="savings-change"
                  >
                    {percentChange > 0 ? (
                      <TrendingUp className="w-3 h-3" />
                    ) : percentChange < 0 ? (
                      <TrendingDown className="w-3 h-3" />
                    ) : (
                      <Minus className="w-3 h-3" />
                    )}
                    {percentChange > 0 ? '+' : ''}
                    {percentChange}%
                  </span>
                )}
                {percentChange === null && thisWeekTotal === 0 && (
                  <span className="text-xs text-muted-foreground" data-testid="savings-change">—</span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Triggers */}
        <Card data-testid="activity-block">
          <CardContent className="flex items-center gap-3 p-4">
            <div className="p-2 rounded-lg bg-amber-500/10">
              <Zap className="w-5 h-5 text-amber-500" />
            </div>
            <div>
              <p className="text-2xl font-bold tabular-nums">{activityStats?.triggers ?? 0}</p>
              <p className="text-xs text-muted-foreground">Срабатываний</p>
            </div>
          </CardContent>
        </Card>

        {/* Stops */}
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <div className="p-2 rounded-lg bg-red-500/10">
              <ShieldOff className="w-5 h-5 text-red-500" />
            </div>
            <div>
              <p className="text-2xl font-bold tabular-nums">{activityStats?.stops ?? 0}</p>
              <p className="text-xs text-muted-foreground">Остановок</p>
            </div>
          </CardContent>
        </Card>

        {/* Notifications */}
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <div className="p-2 rounded-lg bg-blue-500/10">
              <Bell className="w-5 h-5 text-blue-500" />
            </div>
            <div>
              <p className="text-2xl font-bold tabular-nums">{activityStats?.notifications ?? 0}</p>
              <p className="text-xs text-muted-foreground">Уведомлений</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Account cards ── */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : accounts.length === 0 ? (
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
                      {account.status === 'active' ? 'Активен' : account.status === 'paused' ? 'Приостановлен' : account.status === 'deleting' ? 'Удаляется...' : 'Ошибка'}
                    </p>
                  </div>
                  {isActive && (
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-primary text-primary-foreground shrink-0">
                      Выбран
                    </span>
                  )}
                  <button
                    type="button"
                    disabled={account.status === 'deleting'}
                    onClick={(e) => {
                      e.stopPropagation();
                      setDisconnectTarget({
                        id: account._id,
                        name: account.name,
                        isAgency: !!account.agencyProviderId,
                      });
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

      {/* ── Period selector ── */}
      <div className="space-y-3" data-testid="period-selector">
        <div className="flex gap-2">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => { setPeriod(opt.value); setDateError(null); }}
              className={cn(
                'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                period === opt.value
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              )}
              data-testid={`period-${opt.value}`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {period === 'custom' && (
          <div className="flex items-center gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">С</label>
              <input
                type="date"
                value={customStart}
                onChange={(e) => handleCustomStartChange(e.target.value)}
                className="block px-3 py-1.5 border rounded-lg text-sm bg-background"
                data-testid="custom-start"
              />
            </div>
            <span className="text-muted-foreground mt-5">—</span>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">По</label>
              <input
                type="date"
                value={customEnd}
                onChange={(e) => handleCustomEndChange(e.target.value)}
                className="block px-3 py-1.5 border rounded-lg text-sm bg-background"
                data-testid="custom-end"
              />
            </div>
          </div>
        )}

        {dateError && (
          <p className="text-sm text-red-500" data-testid="date-error">{dateError}</p>
        )}
      </div>

      {/* ── Analytics charts ── */}
      {analyticsLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : (
        <div className="space-y-6">
          {/* ROI Widget */}
          <Card data-testid="roi-widget">
            <CardHeader>
              <CardTitle className="text-lg">ROI автоматизации</CardTitle>
              <CardDescription>Отношение сэкономленного бюджета к потраченному</CardDescription>
            </CardHeader>
            <CardContent>
              {isFreemium ? (
                <div className="flex items-center gap-3 py-4 text-muted-foreground">
                  <Lock className="w-5 h-5" />
                  <p className="text-sm">Оформите подписку для доступа к ROI-аналитике</p>
                </div>
              ) : roiData!.totalEvents > 0 ? (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <p className="text-2xl font-bold tabular-nums">{roiData!.roi}%</p>
                    <p className="text-xs text-muted-foreground">ROI</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold tabular-nums">{roiData!.totalSaved.toLocaleString()} ₽</p>
                    <p className="text-xs text-muted-foreground">Сэкономлено</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold tabular-nums">{roiData!.totalSpent.toLocaleString()} ₽</p>
                    <p className="text-xs text-muted-foreground">Потрачено</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold tabular-nums">{roiData!.totalEvents}</p>
                    <p className="text-xs text-muted-foreground">Событий</p>
                  </div>
                </div>
              ) : (
                <EmptyChart message="Нет данных за период" />
              )}
            </CardContent>
          </Card>

          {/* Line chart — savings over time */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <TrendingUp className="w-5 h-5" />
                    Экономия за период
                  </CardTitle>
                  <CardDescription>Сумма сэкономленного бюджета по дням</CardDescription>
                </div>
                {hasData && (
                  <button
                    type="button"
                    onClick={handleExportPng}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border hover:bg-muted transition-colors"
                    data-testid="export-png"
                  >
                    <Image className="w-3.5 h-3.5" />
                    PNG
                  </button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {hasData ? (
                <div ref={chartRef} data-testid="savings-line-chart" className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={savingsData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 12 }}
                        tickFormatter={(d: string) =>
                          new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
                        }
                      />
                      <YAxis tick={{ fontSize: 12 }} />
                      <Tooltip
                        formatter={(value: number) => [`${value.toLocaleString()} ₽`, 'Экономия']}
                        labelFormatter={(label: string) =>
                          new Date(label).toLocaleDateString('ru-RU', {
                            day: 'numeric',
                            month: 'long',
                            year: 'numeric',
                          })
                        }
                      />
                      <Line
                        type="monotone"
                        dataKey="amount"
                        stroke="hsl(var(--primary))"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <EmptyChart message="Нет данных за период" />
              )}
            </CardContent>
          </Card>

          {/* Bar chart + Pie chart in 2-column grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Bar chart — action type breakdown */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Действия по типам</CardTitle>
                <CardDescription>Количество срабатываний по типу действия</CardDescription>
              </CardHeader>
              <CardContent>
                {hasTypeData ? (
                  <div data-testid="rules-bar-chart" className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={typeData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                        <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                        <Tooltip formatter={(value: number) => [value, 'Срабатываний']} />
                        <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                          <Cell fill="#ef4444" />
                          <Cell fill="#3b82f6" />
                          <Cell fill="#f59e0b" />
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <EmptyChart message="Нет данных за период" />
                )}
              </CardContent>
            </Card>

            {/* Pie chart — triggers by rule */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Срабатывания по правилам</CardTitle>
                <CardDescription>Доля каждого правила в общем числе срабатываний</CardDescription>
              </CardHeader>
              <CardContent>
                {hasTriggerData ? (
                  <div data-testid="triggers-pie-chart" className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={triggerData}
                          dataKey="count"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          outerRadius={90}
                          label={({ name, percent }: { name: string; percent: number }) =>
                            `${name} (${(percent * 100).toFixed(0)}%)`
                          }
                          labelLine={false}
                        >
                          {triggerData!.map((_, i) => (
                            <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(value: number) => [value, 'Срабатываний']} />
                        <Legend />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <EmptyChart message="Нет данных за период" />
                )}
              </CardContent>
            </Card>
          </div>

          {/* Top-10 Ads Table */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-lg">Топ-10 объявлений</CardTitle>
                  <CardDescription>По сумме сэкономленного бюджета</CardDescription>
                </div>
                <button
                  type="button"
                  onClick={() => hasTopAds && exportCsv(topAdsData!)}
                  disabled={!hasTopAds}
                  className={cn(
                    'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors',
                    hasTopAds
                      ? 'hover:bg-muted'
                      : 'opacity-50 cursor-not-allowed'
                  )}
                  data-testid="export-csv"
                >
                  <Download className="w-3.5 h-3.5" />
                  CSV
                </button>
              </div>
            </CardHeader>
            <CardContent>
              {hasTopAds ? (
                <div className="overflow-x-auto" data-testid="top-ads-table">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="pb-2 font-medium">#</th>
                        <th className="pb-2 font-medium">Объявление</th>
                        <th className="pb-2 font-medium text-right">Сэкономлено</th>
                        <th className="pb-2 font-medium text-right">Потрачено</th>
                        <th className="pb-2 font-medium text-right">Срабатываний</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topAdsData!.map((ad, i) => (
                        <tr key={ad.adId} className="border-b last:border-0">
                          <td className="py-2.5 text-muted-foreground">{i + 1}</td>
                          <td className="py-2.5 font-medium truncate max-w-[200px]">{ad.adName}</td>
                          <td className="py-2.5 text-right text-green-600">
                            {ad.totalSaved.toLocaleString()} ₽
                          </td>
                          <td className="py-2.5 text-right">
                            {ad.totalSpent.toLocaleString()} ₽
                          </td>
                          <td className="py-2.5 text-right">{ad.triggers}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyChart message="Нет данных за период" />
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Event Feed ── */}
      {typedUserId && <EventFeed userId={typedUserId} accounts={accounts} />}

      <DisconnectDialog
        open={!!disconnectTarget}
        onOpenChange={(open) => { if (!open) setDisconnectTarget(null); }}
        accountName={disconnectTarget?.name ?? ''}
        isAgency={disconnectTarget?.isAgency ?? false}
        onConfirm={handleDeleteAccount}
      />
    </div>
  );
}

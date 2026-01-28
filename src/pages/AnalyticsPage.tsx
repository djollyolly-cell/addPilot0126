import { useState, useMemo } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useAuth } from '../lib/useAuth';
import { Id } from '../../convex/_generated/dataModel';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { BarChart3, Loader2, TrendingUp, Inbox } from 'lucide-react';
import { cn } from '../lib/utils';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';

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

export function AnalyticsPage() {
  const { user } = useAuth();
  const userId = user?.userId as Id<"users"> | undefined;

  const [period, setPeriod] = useState<PeriodPreset>('7');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [dateError, setDateError] = useState<string | null>(null);

  const { startDate, endDate } = useMemo(
    () => getDateRange(period, customStart, customEnd),
    [period, customStart, customEnd]
  );

  // Validate custom dates
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

  const savingsData = useQuery(
    api.ruleEngine.getAnalyticsSavings,
    userId ? { userId, startDate, endDate } : 'skip'
  );

  const typeData = useQuery(
    api.ruleEngine.getAnalyticsByType,
    userId ? { userId, startDate, endDate } : 'skip'
  );

  const triggerData = useQuery(
    api.ruleEngine.getAnalyticsTriggersByRule,
    userId ? { userId, startDate, endDate } : 'skip'
  );

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const isLoading = savingsData === undefined || typeData === undefined || triggerData === undefined;
  const hasData = savingsData && savingsData.some((d) => d.amount > 0);
  const hasTypeData = typeData && typeData.some((d) => d.count > 0);
  const hasTriggerData = triggerData && triggerData.length > 0;

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6" data-testid="analytics-page">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <BarChart3 className="w-7 h-7" />
          Аналитика
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Статистика по работе автоматических правил
        </p>
      </div>

      {/* Period selector */}
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

      {/* Loading */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : (
        <div className="space-y-6">
          {/* Line chart — savings over time */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <TrendingUp className="w-5 h-5" />
                Экономия за период
              </CardTitle>
              <CardDescription>Сумма сэкономленного бюджета по дням</CardDescription>
            </CardHeader>
            <CardContent>
              {hasData ? (
                <div data-testid="savings-line-chart" className="h-64">
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
      )}
    </div>
  );
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-muted-foreground" data-testid="no-data">
      <Inbox className="w-10 h-10 mb-2 opacity-30" />
      <p className="text-sm">{message}</p>
    </div>
  );
}

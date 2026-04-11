import { useState } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import {
  TrendingUp,
  Users,
  Clock,
  UserMinus,
  ArrowUpRight,
  Loader2,
  Banknote,
  ChevronDown,
  ChevronRight,
  HelpCircle,
  GitBranch,
} from 'lucide-react';

function MetricCard({
  icon,
  label,
  value,
  subtitle,
  tooltip,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  subtitle?: string;
  tooltip?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <div className="flex items-center gap-3">
          <div className="text-primary">{icon}</div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1">
              <p className="text-xs text-muted-foreground">{label}</p>
              {tooltip && (
                <span className="relative group">
                  <HelpCircle className="w-3 h-3 text-muted-foreground/50 cursor-help" />
                  <span className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block w-56 p-2 rounded-lg bg-popover border border-border text-xs text-popover-foreground shadow-md whitespace-normal">
                    {tooltip}
                  </span>
                </span>
              )}
            </div>
            <p className="text-xl font-bold">{value}</p>
            {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

interface Props {
  sessionToken: string;
}

export function AdminMetricsTab({ sessionToken }: Props) {
  const metrics = useQuery(api.adminMetrics.getMetrics, { sessionToken });

  if (!metrics) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'BYN', minimumFractionDigits: 2 }).format(amount);

  const formatDate = (ts: number) =>
    new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const firstStartPct = metrics.totalFirstPayments > 0
    ? Math.round((metrics.firstPaymentStart / metrics.totalFirstPayments) * 100)
    : 0;
  const firstProPct = metrics.totalFirstPayments > 0
    ? Math.round((metrics.firstPaymentPro / metrics.totalFirstPayments) * 100)
    : 0;

  return (
    <div className="space-y-6">
      {/* Key Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          icon={<Banknote className="w-5 h-5" />}
          label="MRR"
          value={formatCurrency(metrics.mrr)}
          subtitle={`Start: ${metrics.activeStart} | Pro: ${metrics.activePro}`}
          tooltip="Ежемесячная выручка. Считается как: активные Start × средний чек Start за 30 дн. + активные Pro × средний чек Pro за 30 дн."
        />
        <MetricCard
          icon={<UserMinus className="w-5 h-5" />}
          label="Churn rate (30 дн.)"
          value={`${metrics.churnRate}%`}
          subtitle={`${metrics.churnedCount} ушли`}
          tooltip="Процент платных пользователей, чья подписка истекла за последние 30 дней и они не продлили."
        />
        <MetricCard
          icon={<ArrowUpRight className="w-5 h-5" />}
          label="Конверсия Free → Paid"
          value={`${metrics.conversionRate}%`}
          tooltip="Доля пользователей, которые хотя бы раз оплатили подписку, от общего числа зарегистрированных. За всё время."
        />
        <MetricCard
          icon={<Clock className="w-5 h-5" />}
          label="Время до оплаты"
          value={metrics.medianConversionDays !== null ? `${metrics.medianConversionDays} дн.` : '—'}
          tooltip="Медиана дней от регистрации до первой оплаты. Половина пользователей платят быстрее, половина — дольше."
        />
        <MetricCard
          icon={<TrendingUp className="w-5 h-5" />}
          label="LTV"
          value={formatCurrency(metrics.avgLtv)}
          tooltip="Средняя сумма всех оплат одного платящего пользователя за всё время."
        />
        <MetricCard
          icon={<Users className="w-5 h-5" />}
          label="ARPU"
          value={formatCurrency(metrics.arpu)}
          tooltip="Средняя выручка на одного активного платного пользователя в месяц. MRR / кол-во активных платных."
        />
        <MetricCard
          icon={<Users className="w-5 h-5" />}
          label="Регистрации сегодня"
          value={metrics.registrationsToday}
          subtitle={`7 дн: ${metrics.registrations7d} | 30 дн: ${metrics.registrations30d}`}
          tooltip="Сегодня = с полуночи (UTC+3). 7/30 дн. = включая сегодня."
        />
        <MetricCard
          icon={<TrendingUp className="w-5 h-5" />}
          label="Оплаты сегодня"
          value={metrics.paymentsTodayCount}
          subtitle={metrics.paymentsTodaySum > 0 ? formatCurrency(metrics.paymentsTodaySum) : '—'}
          tooltip="Количество и сумма успешных оплат с полуночи (UTC+3)."
        />
      </div>

      {/* Funnel Metrics */}
      <h3 className="text-base font-semibold text-muted-foreground">Воронка конверсии</h3>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <MetricCard
          icon={<GitBranch className="w-5 h-5" />}
          label="Первая оплата → Start"
          value={`${firstStartPct}%`}
          subtitle={`${metrics.firstPaymentStart} из ${metrics.totalFirstPayments}`}
          tooltip="Доля пользователей, чья первая оплата была за тариф Start. Показывает, сколько начинают с младшего тарифа."
        />
        <MetricCard
          icon={<GitBranch className="w-5 h-5" />}
          label="Первая оплата → Pro"
          value={`${firstProPct}%`}
          subtitle={`${metrics.firstPaymentPro} из ${metrics.totalFirstPayments}`}
          tooltip="Доля пользователей, чья первая оплата была сразу за Pro. Показывает, сколько пропускают Start."
        />
        <MetricCard
          icon={<ArrowUpRight className="w-5 h-5" />}
          label="Апгрейд Start → Pro"
          value={`${metrics.upgradeRate}%`}
          subtitle={`${metrics.upgradeCount} из ${metrics.totalEverStart}${metrics.medianUpgradeDays !== null ? ` · медиана ${metrics.medianUpgradeDays} дн.` : ''}`}
          tooltip="Процент пользователей, которые начали со Start и затем перешли на Pro. Медиана — сколько дней от первой оплаты Start до первой оплаты Pro."
        />
      </div>

      {/* Recent Registrations — collapsible */}
      <CollapsibleRegistrations users={metrics.recentUsers} formatDate={formatDate} />

      {/* Recent Payments — collapsible */}
      <CollapsiblePayments payments={metrics.recentPayments} formatDate={formatDate} />
    </div>
  );
}

function CollapsibleRegistrations({
  users,
  formatDate,
}: {
  users: { name: string; tier: string; createdAt: number }[];
  formatDate: (ts: number) => string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Card>
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setOpen(!open)}
      >
        <CardTitle className="text-lg flex items-center justify-between">
          <span className="flex items-center gap-2">
            {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            Регистрации (7 дней)
          </span>
          <span className="text-sm font-medium text-muted-foreground">
            {users.length} чел.
          </span>
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent>
          {users.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">Нет регистраций за 7 дней</p>
          ) : (
            <div className="space-y-2">
              {users.map((u, i) => (
                <div key={i} className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/30">
                  <span className="text-sm">{u.name}</span>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">{u.tier}</Badge>
                    <span className="text-xs text-muted-foreground">{formatDate(u.createdAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function CollapsiblePayments({
  payments,
  formatDate,
}: {
  payments: { userName: string; tier: string; amount: number; currency: string; completedAt: number }[];
  formatDate: (ts: number) => string;
}) {
  const [open, setOpen] = useState(false);
  const totalSum = payments.reduce((s, p) => s + p.amount, 0);

  return (
    <Card>
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setOpen(!open)}
      >
        <CardTitle className="text-lg flex items-center justify-between">
          <span className="flex items-center gap-2">
            {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            Оплаты (7 дней)
          </span>
          <span className="text-sm font-medium text-muted-foreground">
            {payments.length} шт. — {totalSum.toFixed(2)} BYN
          </span>
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent>
          {payments.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">Нет оплат за 7 дней</p>
          ) : (
            <div className="space-y-2">
              {payments.map((p, i) => (
                <div key={i} className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/30">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{p.userName}</span>
                    <Badge variant={p.tier === 'pro' ? 'success' : 'warning'}>{p.tier}</Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-green-600">
                      {p.amount.toFixed(2)} {p.currency}
                    </span>
                    <span className="text-xs text-muted-foreground">{formatDate(p.completedAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import {
  TrendingUp,
  Users,
  DollarSign,
  Clock,
  UserMinus,
  ArrowUpRight,
  Loader2,
} from 'lucide-react';

function MetricCard({
  icon,
  label,
  value,
  subtitle,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  subtitle?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <div className="flex items-center gap-3">
          <div className="text-primary">{icon}</div>
          <div>
            <p className="text-xs text-muted-foreground">{label}</p>
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

  return (
    <div className="space-y-6">
      {/* Key Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          icon={<DollarSign className="w-5 h-5" />}
          label="MRR"
          value={formatCurrency(metrics.mrr)}
          subtitle={`Start: ${metrics.activeStart} | Pro: ${metrics.activePro}`}
        />
        <MetricCard
          icon={<UserMinus className="w-5 h-5" />}
          label="Churn rate (30 дн.)"
          value={`${metrics.churnRate}%`}
          subtitle={`${metrics.churnedCount} ушли`}
        />
        <MetricCard
          icon={<ArrowUpRight className="w-5 h-5" />}
          label="Конверсия Free → Paid"
          value={`${metrics.conversionRate}%`}
        />
        <MetricCard
          icon={<Clock className="w-5 h-5" />}
          label="Время до оплаты (медиана)"
          value={metrics.medianConversionDays !== null ? `${metrics.medianConversionDays} дн.` : '—'}
        />
        <MetricCard
          icon={<DollarSign className="w-5 h-5" />}
          label="LTV (среднее)"
          value={formatCurrency(metrics.avgLtv)}
        />
        <MetricCard
          icon={<DollarSign className="w-5 h-5" />}
          label="ARPU"
          value={formatCurrency(metrics.arpu)}
        />
        <MetricCard
          icon={<Users className="w-5 h-5" />}
          label="Регистрации сегодня"
          value={metrics.registrationsToday}
          subtitle={`7 дн: ${metrics.registrations7d} | 30 дн: ${metrics.registrations30d}`}
        />
        <MetricCard
          icon={<TrendingUp className="w-5 h-5" />}
          label="Оплаты сегодня"
          value={metrics.paymentsTodayCount}
          subtitle={metrics.paymentsTodaySum > 0 ? formatCurrency(metrics.paymentsTodaySum) : '—'}
        />
      </div>

      {/* Recent Registrations */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Последние регистрации (7 дней)</CardTitle>
        </CardHeader>
        <CardContent>
          {metrics.recentUsers.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">Нет регистраций за 7 дней</p>
          ) : (
            <div className="space-y-2">
              {metrics.recentUsers.map((u, i) => (
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
      </Card>

      {/* Recent Payments */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Последние оплаты (7 дней)</CardTitle>
        </CardHeader>
        <CardContent>
          {metrics.recentPayments.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">Нет оплат за 7 дней</p>
          ) : (
            <div className="space-y-2">
              {metrics.recentPayments.map((p, i) => (
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
      </Card>
    </div>
  );
}

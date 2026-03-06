import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useAuth } from '../lib/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import {
  Shield,
  Users,
  Crown,
  MessageCircle,
  Building2,
  DollarSign,
  Search,
} from 'lucide-react';
import { Id } from '../../convex/_generated/dataModel';

const ADMIN_EMAILS = ['13632013@vk.com'];

const SESSION_KEY = 'adpilot_session';

const TIER_LABELS: Record<string, string> = {
  freemium: 'Freemium',
  start: 'Start',
  pro: 'Pro',
};

const TIER_BADGE_VARIANT: Record<string, 'secondary' | 'warning' | 'success'> = {
  freemium: 'secondary',
  start: 'warning',
  pro: 'success',
};

export function AdminPage() {
  const { user } = useAuth();
  const isAdmin = user && ADMIN_EMAILS.includes(user.email);

  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <Shield className="w-12 h-12 text-destructive mx-auto mb-4" />
            <h2 className="text-xl font-bold mb-2">Нет доступа</h2>
            <p className="text-muted-foreground">
              У вас нет прав для доступа к админ-панели.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <AdminDashboard />;
}

function AdminDashboard() {
  const sessionToken = localStorage.getItem(SESSION_KEY) || '';
  const stats = useQuery(api.admin.getStats, { sessionToken });
  const users = useQuery(api.admin.listUsers, { sessionToken });
  const updateTier = useMutation(api.admin.updateUserTier);

  const [search, setSearch] = useState('');
  const [tierFilter, setTierFilter] = useState<string>('all');
  const [changingTier, setChangingTier] = useState<string | null>(null);

  const filteredUsers = users
    ?.filter((u) => {
      const matchSearch =
        !search ||
        (u.name || '').toLowerCase().includes(search.toLowerCase()) ||
        u.email.toLowerCase().includes(search.toLowerCase());
      const matchTier = tierFilter === 'all' || u.subscriptionTier === tierFilter;
      return matchSearch && matchTier;
    })
    .sort((a, b) => b.createdAt - a.createdAt);

  const handleTierChange = async (userId: string, newTier: 'freemium' | 'start' | 'pro') => {
    setChangingTier(userId);
    try {
      await updateTier({
        sessionToken,
        userId: userId as Id<'users'>,
        tier: newTier,
      });
    } catch (err) {
      console.error('Failed to update tier:', err);
    } finally {
      setChangingTier(null);
    }
  };

  const formatDate = (ts: number) => {
    return new Date(ts).toLocaleDateString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('ru-RU', {
      style: 'currency',
      currency: 'BYN',
      minimumFractionDigits: 0,
    }).format(amount / 100);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Shield className="w-8 h-8 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Админ-панель</h1>
          <p className="text-muted-foreground">Управление пользователями и статистика</p>
        </div>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            icon={<Users className="w-5 h-5" />}
            label="Всего пользователей"
            value={stats.totalUsers}
          />
          <StatCard
            icon={<Crown className="w-5 h-5 text-muted-foreground" />}
            label="Freemium"
            value={stats.freemiumCount}
          />
          <StatCard
            icon={<Crown className="w-5 h-5 text-yellow-500" />}
            label="Start"
            value={stats.startCount}
          />
          <StatCard
            icon={<Crown className="w-5 h-5 text-green-500" />}
            label="Pro"
            value={stats.proCount}
          />
          <StatCard
            icon={<MessageCircle className="w-5 h-5" />}
            label="Telegram"
            value={stats.withTelegram}
          />
          <StatCard
            icon={<Building2 className="w-5 h-5" />}
            label="С кабинетами"
            value={stats.withAccounts}
          />
          <StatCard
            icon={<DollarSign className="w-5 h-5" />}
            label="Выручка всего"
            value={formatCurrency(stats.totalRevenue)}
          />
          <StatCard
            icon={<DollarSign className="w-5 h-5" />}
            label="Выручка 30 дн."
            value={formatCurrency(stats.recentRevenue)}
          />
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Поиск по имени или email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex gap-2">
          {['all', 'freemium', 'start', 'pro'].map((tier) => (
            <Button
              key={tier}
              variant={tierFilter === tier ? 'default' : 'outline'}
              size="sm"
              onClick={() => setTierFilter(tier)}
            >
              {tier === 'all' ? 'Все' : TIER_LABELS[tier]}
            </Button>
          ))}
        </div>
      </div>

      {/* Users Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            Пользователи {filteredUsers && `(${filteredUsers.length})`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!filteredUsers ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
          ) : filteredUsers.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">Пользователи не найдены</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="pb-3 font-medium text-muted-foreground">Имя / Email</th>
                    <th className="pb-3 font-medium text-muted-foreground">Тариф</th>
                    <th className="pb-3 font-medium text-muted-foreground hidden sm:table-cell">Кабинеты</th>
                    <th className="pb-3 font-medium text-muted-foreground hidden sm:table-cell">Правила</th>
                    <th className="pb-3 font-medium text-muted-foreground hidden md:table-cell">Telegram</th>
                    <th className="pb-3 font-medium text-muted-foreground hidden md:table-cell">Дата рег.</th>
                    <th className="pb-3 font-medium text-muted-foreground">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map((u) => (
                    <tr key={u._id} className="border-b border-border/50 last:border-0">
                      <td className="py-3 pr-4">
                        <div className="font-medium">{u.name || '—'}</div>
                        <div className="text-xs text-muted-foreground">{u.email}</div>
                      </td>
                      <td className="py-3 pr-4">
                        <Badge variant={TIER_BADGE_VARIANT[u.subscriptionTier ?? "freemium"]}>
                          {TIER_LABELS[u.subscriptionTier ?? "freemium"]}
                        </Badge>
                      </td>
                      <td className="py-3 pr-4 hidden sm:table-cell">{u.accountsCount}</td>
                      <td className="py-3 pr-4 hidden sm:table-cell">{u.rulesCount}</td>
                      <td className="py-3 pr-4 hidden md:table-cell">
                        {u.telegramChatId ? (
                          <Badge variant="success">Да</Badge>
                        ) : (
                          <span className="text-muted-foreground">Нет</span>
                        )}
                      </td>
                      <td className="py-3 pr-4 hidden md:table-cell text-muted-foreground">
                        {formatDate(u.createdAt)}
                      </td>
                      <td className="py-3">
                        <select
                          className="text-xs border border-border rounded px-2 py-1 bg-background"
                          value={u.subscriptionTier}
                          disabled={changingTier === u._id}
                          onChange={(e) =>
                            handleTierChange(u._id, e.target.value as 'freemium' | 'start' | 'pro')
                          }
                        >
                          <option value="freemium">Freemium</option>
                          <option value="start">Start</option>
                          <option value="pro">Pro</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
}) {
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <div className="flex items-center gap-3">
          <div className="text-primary">{icon}</div>
          <div>
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-xl font-bold">{value}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

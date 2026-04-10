import React, { useState } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import {
  Users,
  Crown,
  MessageCircle,
  Building2,
  DollarSign,
  Search,
  Loader2,
} from 'lucide-react';
import { AdminUserSheet } from './AdminUserSheet';

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

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | number }) {
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

interface Props {
  sessionToken: string;
}

export function AdminUsersTab({ sessionToken }: Props) {
  const stats = useQuery(api.admin.getStats, { sessionToken });
  const users = useQuery(api.admin.listUsers, { sessionToken });

  const [search, setSearch] = useState('');
  const [tierFilter, setTierFilter] = useState<string>('all');
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'BYN', minimumFractionDigits: 2 }).format(amount);

  const formatDate = (ts: number) =>
    new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

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

  const selectedUser = filteredUsers?.find((u) => u._id === selectedUserId);

  return (
    <>
      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard icon={<Users className="w-5 h-5" />} label="Всего" value={stats.totalUsers} />
          <StatCard icon={<Crown className="w-5 h-5 text-muted-foreground" />} label="Freemium" value={stats.freemiumCount} />
          <StatCard icon={<Crown className="w-5 h-5 text-yellow-500" />} label="Start" value={stats.startCount} />
          <StatCard icon={<Crown className="w-5 h-5 text-green-500" />} label="Pro" value={stats.proCount} />
          <StatCard icon={<MessageCircle className="w-5 h-5" />} label="Telegram" value={stats.withTelegram} />
          <StatCard icon={<Building2 className="w-5 h-5" />} label="С кабинетами" value={stats.withAccounts} />
          <StatCard icon={<DollarSign className="w-5 h-5" />} label="Выручка всего" value={formatCurrency(stats.totalRevenue)} />
          <StatCard icon={<DollarSign className="w-5 h-5" />} label="Выручка 30 дн." value={formatCurrency(stats.recentRevenue)} />
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
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
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
                    <th className="pb-3 font-medium text-muted-foreground hidden md:table-cell">Оплачено</th>
                    <th className="pb-3 font-medium text-muted-foreground hidden md:table-cell">Дата рег.</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map((u) => (
                    <tr
                      key={u._id}
                      className="border-b border-border/50 last:border-0 cursor-pointer hover:bg-muted/30 transition-colors"
                      onClick={() => setSelectedUserId(u._id)}
                    >
                      <td className="py-3 pr-4">
                        <div className="font-medium">{u.name || '—'}</div>
                        <div className="text-xs text-muted-foreground">{u.email}</div>
                      </td>
                      <td className="py-3 pr-4">
                        <Badge variant={TIER_BADGE_VARIANT[u.subscriptionTier ?? 'freemium']}>
                          {TIER_LABELS[u.subscriptionTier ?? 'freemium']}
                        </Badge>
                      </td>
                      <td className="py-3 pr-4 hidden sm:table-cell">{u.accountsCount}</td>
                      <td className="py-3 pr-4 hidden sm:table-cell">{u.rulesCount}</td>
                      <td className="py-3 pr-4 hidden md:table-cell">
                        {u.telegramChatId ? <Badge variant="success">Да</Badge> : <span className="text-muted-foreground">Нет</span>}
                      </td>
                      <td className="py-3 pr-4 hidden md:table-cell">
                        {u.totalPaid > 0 ? (
                          <span className="text-xs font-medium text-green-600">{u.totalPaid.toFixed(2)} BYN</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-3 pr-4 hidden md:table-cell text-muted-foreground">
                        {formatDate(u.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* User Detail Sheet */}
      {selectedUser && (
        <AdminUserSheet
          user={selectedUser}
          sessionToken={sessionToken}
          onClose={() => setSelectedUserId(null)}
        />
      )}
    </>
  );
}

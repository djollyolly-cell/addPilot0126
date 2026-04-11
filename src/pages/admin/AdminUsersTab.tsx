import React, { useState } from 'react';
import { useQuery, useMutation, useAction } from 'convex/react';
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
  Bell,
  X,
  Send,
  AlertCircle,
  CheckCircle,
  Stethoscope,
} from 'lucide-react';
import { Id } from '../../../convex/_generated/dataModel';

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

const NOTIFY_TEMPLATES = [
  { label: 'Оплата', title: 'Необходима оплата подписки', message: 'Ваш тариф был деактивирован. Для продолжения использования сервиса, пожалуйста, оплатите подписку в разделе Тарифы.', type: 'payment' as const },
  { label: 'Истекает', title: 'Подписка скоро истекает', message: 'Ваша подписка истекает через несколько дней. Продлите подписку, чтобы не потерять доступ к функциям.', type: 'warning' as const },
  { label: 'Инфо', title: 'Информация', message: '', type: 'info' as const },
];

interface Props {
  sessionToken: string;
}

export function AdminUsersTab({ sessionToken }: Props) {
  const stats = useQuery(api.admin.getStats, { sessionToken });
  const users = useQuery(api.admin.listUsers, { sessionToken });
  const updateTier = useMutation(api.admin.updateUserTier);
  const updateExpiry = useMutation(api.admin.updateUserExpiry);
  const toggleAdmin = useMutation(api.admin.toggleAdmin);
  const sendNotification = useMutation(api.admin.sendUserNotification);
  const adminUpdateReferral = useMutation(api.referrals.adminUpdateReferral);
  const runUserCheck = useAction(api.healthCheck.runManualUserCheck);

  const [search, setSearch] = useState('');
  const [tierFilter, setTierFilter] = useState<string>('all');
  const [changingTier, setChangingTier] = useState<string | null>(null);
  const [editingExpiry, setEditingExpiry] = useState<string | null>(null);
  const [expiryInput, setExpiryInput] = useState('');
  const [togglingAdmin, setTogglingAdmin] = useState<string | null>(null);
  const [notifyUserId, setNotifyUserId] = useState<string | null>(null);
  const [expandedReferralUserId, setExpandedReferralUserId] = useState<string | null>(null);
  const [diagUserId, setDiagUserId] = useState<string | null>(null);
  const [notifyTitle, setNotifyTitle] = useState('');
  const [notifyMessage, setNotifyMessage] = useState('');
  const [notifyType, setNotifyType] = useState<'info' | 'warning' | 'payment'>('info');
  const [notifySending, setNotifySending] = useState(false);
  const [notifyResult, setNotifyResult] = useState<string | null>(null);

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'BYN', minimumFractionDigits: 2 }).format(amount);

  const formatDate = (ts: number) =>
    new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const toDateInput = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

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
      await updateTier({ sessionToken, userId: userId as Id<'users'>, tier: newTier });
    } catch (err) {
      console.error('Failed to update tier:', err);
    } finally {
      setChangingTier(null);
    }
  };

  const handleToggleAdmin = async (userId: string, currentIsAdmin: boolean) => {
    setTogglingAdmin(userId);
    try {
      await toggleAdmin({ sessionToken, userId: userId as Id<'users'>, isAdmin: !currentIsAdmin });
    } catch (err) {
      console.error('Failed to toggle admin:', err);
    } finally {
      setTogglingAdmin(null);
    }
  };

  const handleExpirySave = async (userId: string) => {
    if (!expiryInput) {
      await updateExpiry({ sessionToken, userId: userId as Id<'users'>, expiresAt: undefined });
    } else {
      const ts = new Date(expiryInput + 'T23:59:59').getTime();
      await updateExpiry({ sessionToken, userId: userId as Id<'users'>, expiresAt: ts });
    }
    setEditingExpiry(null);
    setExpiryInput('');
  };

  const handleSendNotification = async () => {
    if (!notifyUserId || !notifyTitle.trim() || !notifyMessage.trim()) return;
    setNotifySending(true);
    setNotifyResult(null);
    try {
      await sendNotification({
        sessionToken,
        userId: notifyUserId as Id<'users'>,
        title: notifyTitle.trim(),
        message: notifyMessage.trim(),
        type: notifyType,
      });
      setNotifyResult('Уведомление отправлено');
      setNotifyTitle('');
      setNotifyMessage('');
      setTimeout(() => { setNotifyResult(null); setNotifyUserId(null); }, 2000);
    } catch (err) {
      setNotifyResult(`Ошибка: ${err instanceof Error ? err.message : 'Неизвестная ошибка'}`);
    } finally {
      setNotifySending(false);
    }
  };

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

      {/* Notification Modal */}
      {notifyUserId && (
        <Card className="border-primary/30">
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Bell className="w-5 h-5" />
              Уведомление для {filteredUsers?.find((u) => u._id === notifyUserId)?.name || 'пользователя'}
            </CardTitle>
            <Button variant="ghost" size="icon" onClick={() => { setNotifyUserId(null); setNotifyResult(null); }}>
              <X className="w-4 h-4" />
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {NOTIFY_TEMPLATES.map((t) => (
                <Button
                  key={t.label}
                  size="sm"
                  variant="outline"
                  onClick={() => { setNotifyTitle(t.title); setNotifyMessage(t.message); setNotifyType(t.type); }}
                >
                  {t.label}
                </Button>
              ))}
            </div>
            <div className="flex gap-3">
              <select
                className="text-xs border border-border rounded px-2 py-1 bg-background"
                value={notifyType}
                onChange={(e) => setNotifyType(e.target.value as 'info' | 'warning' | 'payment')}
              >
                <option value="info">Инфо</option>
                <option value="warning">Предупреждение</option>
                <option value="payment">Оплата</option>
              </select>
              <Input
                placeholder="Заголовок"
                value={notifyTitle}
                onChange={(e) => setNotifyTitle(e.target.value)}
                className="flex-1"
              />
            </div>
            <textarea
              className="w-full min-h-[80px] p-3 rounded-lg border border-border bg-background text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Текст уведомления..."
              value={notifyMessage}
              onChange={(e) => setNotifyMessage(e.target.value)}
            />
            {notifyResult && (
              <div className={`flex items-center gap-2 p-2 rounded-lg text-sm ${notifyResult.startsWith('Ошибка') ? 'bg-destructive/10 text-destructive' : 'bg-green-500/10 text-green-700'}`}>
                {notifyResult.startsWith('Ошибка') ? <AlertCircle className="w-4 h-4" /> : <CheckCircle className="w-4 h-4" />}
                {notifyResult}
              </div>
            )}
            <Button
              onClick={handleSendNotification}
              disabled={notifySending || !notifyTitle.trim() || !notifyMessage.trim()}
              size="sm"
            >
              {notifySending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Send className="w-4 h-4 mr-2" />}
              Отправить
            </Button>
          </CardContent>
        </Card>
      )}

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
                    <th className="pb-3 font-medium text-muted-foreground">Доступ до</th>
                    <th className="pb-3 font-medium text-muted-foreground hidden sm:table-cell">Промо</th>
                    <th className="pb-3 font-medium text-muted-foreground hidden md:table-cell">Рефералов</th>
                    <th className="pb-3 font-medium text-muted-foreground hidden md:table-cell">Тип ссылки</th>
                    <th className="pb-3 font-medium text-muted-foreground hidden sm:table-cell">Кабинеты</th>
                    <th className="pb-3 font-medium text-muted-foreground hidden sm:table-cell">Правила</th>
                    <th className="pb-3 font-medium text-muted-foreground hidden md:table-cell">Telegram</th>
                    <th className="pb-3 font-medium text-muted-foreground hidden md:table-cell">Оплачено</th>
                    <th className="pb-3 font-medium text-muted-foreground hidden md:table-cell">Посл. оплата</th>
                    <th className="pb-3 font-medium text-muted-foreground hidden md:table-cell">Дата рег.</th>
                    <th className="pb-3 font-medium text-muted-foreground hidden sm:table-cell">Админ</th>
                    <th className="pb-3 font-medium text-muted-foreground">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map((u) => (
                    <React.Fragment key={u._id}>
                    <tr
                      className="border-b border-border/50 last:border-0 cursor-pointer hover:bg-muted/30"
                      onClick={() => setExpandedReferralUserId(expandedReferralUserId === u._id ? null : u._id)}
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
                      <td className="py-3 pr-4">
                        {editingExpiry === u._id ? (
                          <div className="flex items-center gap-1">
                            <input
                              type="date"
                              className="text-xs border border-border rounded px-1 py-0.5 bg-background w-[120px]"
                              value={expiryInput}
                              onChange={(e) => setExpiryInput(e.target.value)}
                            />
                            <Button size="sm" variant="ghost" className="h-6 px-1" onClick={() => handleExpirySave(u._id)}>
                              <CheckCircle className="w-3.5 h-3.5 text-green-600" />
                            </Button>
                            <Button size="sm" variant="ghost" className="h-6 px-1" onClick={() => setEditingExpiry(null)}>
                              <AlertCircle className="w-3.5 h-3.5 text-muted-foreground" />
                            </Button>
                          </div>
                        ) : u.subscriptionExpiresAt ? (
                          <button
                            className={`text-xs ${u.subscriptionExpiresAt < Date.now() ? 'text-destructive' : 'text-muted-foreground'} hover:underline`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingExpiry(u._id);
                              setExpiryInput(toDateInput(u.subscriptionExpiresAt!));
                            }}
                          >
                            {formatDate(u.subscriptionExpiresAt)}
                            {u.subscriptionExpiresAt < Date.now() && ' (истёк)'}
                          </button>
                        ) : (
                          <button
                            className="text-xs text-primary hover:underline"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingExpiry(u._id);
                              setExpiryInput(toDateInput(Date.now() + 30 * 24 * 60 * 60 * 1000));
                            }}
                          >
                            задать
                          </button>
                        )}
                      </td>
                      <td className="py-3 pr-4 hidden sm:table-cell">
                        {u.lastPromoCode ? (
                          <span className="text-xs font-mono">
                            {u.lastPromoCode}
                            {u.lastBonusDays ? <span className="text-muted-foreground"> +{u.lastBonusDays}д</span> : null}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-3 pr-4 hidden md:table-cell">
                        {u.referralCount > 0 ? (
                          <span className="font-medium">{u.referralCount}</span>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </td>
                      <td className="py-3 pr-4 hidden md:table-cell">
                        <select
                          value={u.referralType ?? 'basic'}
                          onChange={(e) => {
                            e.stopPropagation();
                            adminUpdateReferral({
                              sessionToken,
                              userId: u._id as Id<'users'>,
                              referralType: e.target.value as 'basic' | 'discount',
                            });
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="text-xs bg-transparent border border-border rounded px-1.5 py-0.5"
                        >
                          <option value="basic">Обычная</option>
                          <option value="discount">Со скидкой</option>
                        </select>
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
                      <td className="py-3 pr-4 hidden md:table-cell">
                        {u.totalPaid > 0 ? (
                          <span className="text-xs font-medium text-green-600">
                            {u.totalPaid.toFixed(2)} BYN
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-3 pr-4 hidden md:table-cell text-muted-foreground">
                        {u.lastPaymentDate ? formatDate(u.lastPaymentDate) : '—'}
                      </td>
                      <td className="py-3 pr-4 hidden md:table-cell text-muted-foreground">
                        {formatDate(u.createdAt)}
                      </td>
                      <td className="py-3 pr-4 hidden sm:table-cell">
                        <button
                          className={`text-xs font-medium px-2 py-1 rounded ${
                            u.isAdmin
                              ? 'bg-primary/10 text-primary hover:bg-primary/20'
                              : 'bg-muted text-muted-foreground hover:bg-muted/80'
                          } transition-colors`}
                          disabled={togglingAdmin === u._id}
                          onClick={(e) => { e.stopPropagation(); handleToggleAdmin(u._id, u.isAdmin); }}
                        >
                          {togglingAdmin === u._id ? '...' : u.isAdmin ? 'Да' : 'Нет'}
                        </button>
                      </td>
                      <td className="py-3">
                        <div className="flex items-center gap-1">
                          <select
                            className="text-xs border border-border rounded px-2 py-1 bg-background"
                            value={u.subscriptionTier}
                            disabled={changingTier === u._id}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => {
                              e.stopPropagation();
                              handleTierChange(u._id, e.target.value as 'freemium' | 'start' | 'pro');
                            }}
                          >
                            <option value="freemium">Freemium</option>
                            <option value="start">Start</option>
                            <option value="pro">Pro</option>
                          </select>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            title="Отправить уведомление"
                            onClick={(e) => { e.stopPropagation(); setNotifyUserId(u._id); setNotifyResult(null); }}
                          >
                            <Bell className="w-3.5 h-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            title="Диагностика пользователя"
                            disabled={diagUserId === u._id}
                            onClick={async (e) => {
                              e.stopPropagation();
                              setDiagUserId(u._id);
                              try {
                                await runUserCheck({ userId: u._id as Id<'users'> });
                              } catch (err) {
                                console.error('User diagnostic failed:', err);
                              } finally {
                                setDiagUserId(null);
                              }
                            }}
                          >
                            {diagUserId === u._id ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Stethoscope className="w-3.5 h-3.5" />
                            )}
                          </Button>
                        </div>
                      </td>
                    </tr>
                    {expandedReferralUserId === u._id && (
                      <tr>
                        <td colSpan={14} className="px-4 py-3 bg-muted/20">
                          <ReferralDetailsTable userId={u._id as Id<'users'>} sessionToken={sessionToken} />
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function ReferralDetailsTable({ userId, sessionToken }: { userId: Id<'users'>; sessionToken: string }) {
  const details = useQuery(api.referrals.adminGetUserReferrals, { sessionToken, userId });

  if (details === undefined) {
    return <Loader2 className="h-4 w-4 animate-spin" />;
  }
  if (details.length === 0) {
    return <p className="text-xs text-muted-foreground">Нет рефералов</p>;
  }

  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-muted-foreground">
          <th className="text-left py-1 pr-4">Имя/Email</th>
          <th className="text-left py-1 pr-4">Дата регистрации</th>
          <th className="text-left py-1 pr-4">Дата оплаты</th>
          <th className="text-left py-1 pr-4">Статус</th>
          <th className="text-left py-1">Бонус</th>
        </tr>
      </thead>
      <tbody>
        {details.map((r) => (
          <tr key={r._id} className="border-t border-border/50">
            <td className="py-1.5 pr-4">{r.referredName}</td>
            <td className="py-1.5 pr-4">{new Date(r.createdAt).toLocaleDateString('ru-RU')}</td>
            <td className="py-1.5 pr-4">{r.paidAt ? new Date(r.paidAt).toLocaleDateString('ru-RU') : '—'}</td>
            <td className="py-1.5 pr-4">
              <Badge variant={r.status === 'paid' ? 'success' : 'secondary'} className="text-[10px]">
                {r.status === 'paid' ? 'Оплатил' : 'Регистрация'}
              </Badge>
            </td>
            <td className="py-1.5">{r.bonusDaysGranted ? `+${r.bonusDaysGranted} дн.` : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

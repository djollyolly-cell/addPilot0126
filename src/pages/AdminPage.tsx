import { useState } from 'react';
import { useQuery, useMutation, useAction } from 'convex/react';
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
  Tag,
  Plus,
  Loader2,
  Send,
  AlertCircle,
  CheckCircle,
} from 'lucide-react';
import { Label } from '../components/ui/label';
import { Id } from '../../convex/_generated/dataModel';

const ADMIN_EMAILS = ['13632013@vk.com', '786709647@vk.com'];

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
  const isAdmin = user && (user.isAdmin === true || ADMIN_EMAILS.includes(user.email));

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
  const updateExpiry = useMutation(api.admin.updateUserExpiry);
  const toggleAdmin = useMutation(api.admin.toggleAdmin);

  const [search, setSearch] = useState('');
  const [tierFilter, setTierFilter] = useState<string>('all');
  const [changingTier, setChangingTier] = useState<string | null>(null);
  const [editingExpiry, setEditingExpiry] = useState<string | null>(null);
  const [expiryInput, setExpiryInput] = useState('');
  const [togglingAdmin, setTogglingAdmin] = useState<string | null>(null);

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

  const handleToggleAdmin = async (userId: string, currentIsAdmin: boolean) => {
    setTogglingAdmin(userId);
    try {
      await toggleAdmin({
        sessionToken,
        userId: userId as Id<'users'>,
        isAdmin: !currentIsAdmin,
      });
    } catch (err) {
      console.error('Failed to toggle admin:', err);
    } finally {
      setTogglingAdmin(null);
    }
  };

  const handleExpirySave = async (userId: string) => {
    if (!expiryInput) {
      // Clear expiry
      await updateExpiry({ sessionToken, userId: userId as Id<'users'>, expiresAt: undefined });
    } else {
      const ts = new Date(expiryInput + 'T23:59:59').getTime();
      await updateExpiry({ sessionToken, userId: userId as Id<'users'>, expiresAt: ts });
    }
    setEditingExpiry(null);
    setExpiryInput('');
  };

  const toDateInput = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

      {/* Promo Codes */}
      <PromoCodesSection sessionToken={sessionToken} />

      {/* Telegram Broadcast */}
      <BroadcastSection sessionToken={sessionToken} />

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
                    <th className="pb-3 font-medium text-muted-foreground">Доступ до</th>
                    <th className="pb-3 font-medium text-muted-foreground hidden sm:table-cell">Промо</th>
                    <th className="pb-3 font-medium text-muted-foreground hidden sm:table-cell">Кабинеты</th>
                    <th className="pb-3 font-medium text-muted-foreground hidden sm:table-cell">Правила</th>
                    <th className="pb-3 font-medium text-muted-foreground hidden md:table-cell">Telegram</th>
                    <th className="pb-3 font-medium text-muted-foreground hidden md:table-cell">Оплачено</th>
                    <th className="pb-3 font-medium text-muted-foreground hidden md:table-cell">Дата рег.</th>
                    <th className="pb-3 font-medium text-muted-foreground hidden sm:table-cell">Админ</th>
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
                            onClick={() => {
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
                            onClick={() => {
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
                            {(u.totalPaid / 100).toFixed(2)} BYN
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
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
                          onClick={() => handleToggleAdmin(u._id, u.isAdmin)}
                        >
                          {togglingAdmin === u._id ? '...' : u.isAdmin ? 'Да' : 'Нет'}
                        </button>
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

function PromoCodesSection({ sessionToken: _sessionToken }: { sessionToken: string }) {
  const promos = useQuery(api.billing.listPromoCodes, {});
  const createPromo = useMutation(api.billing.createPromoCode);
  const togglePromo = useMutation(api.billing.togglePromoCode);

  const [showForm, setShowForm] = useState(false);
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [bonusDays, setBonusDays] = useState(30);
  const [maxUses, setMaxUses] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!code.trim() || !description.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createPromo({
        code: code.trim().toUpperCase(),
        description: description.trim(),
        bonusDays,
        maxUses: maxUses ? parseInt(maxUses) : undefined,
      });
      setCode('');
      setDescription('');
      setBonusDays(30);
      setMaxUses('');
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setCreating(false);
    }
  };

  const formatDate = (ts: number) =>
    new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-lg flex items-center gap-2">
          <Tag className="w-5 h-5" />
          Промокоды {promos && `(${promos.length})`}
        </CardTitle>
        <Button size="sm" onClick={() => setShowForm(!showForm)}>
          <Plus className="w-4 h-4 mr-1" />
          Создать
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {showForm && (
          <div className="p-4 border border-border rounded-lg space-y-3">
            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Код</Label>
                <Input
                  placeholder="COMMUNITY30"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Бонус дней</Label>
                <Input
                  type="number"
                  value={bonusDays}
                  onChange={(e) => setBonusDays(parseInt(e.target.value) || 0)}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Описание</Label>
                <Input
                  placeholder="Бонус для сообщества"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Макс. использований (пусто = безлимит)</Label>
                <Input
                  type="number"
                  placeholder="∞"
                  value={maxUses}
                  onChange={(e) => setMaxUses(e.target.value)}
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleCreate} disabled={creating || !code.trim() || !description.trim()}>
                {creating ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
                Создать промокод
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>
                Отмена
              </Button>
            </div>
          </div>
        )}

        {!promos ? (
          <div className="flex justify-center py-4">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : promos.length === 0 ? (
          <p className="text-center text-muted-foreground py-4">Промокодов пока нет</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="pb-2 font-medium text-muted-foreground">Код</th>
                  <th className="pb-2 font-medium text-muted-foreground">Описание</th>
                  <th className="pb-2 font-medium text-muted-foreground">Бонус</th>
                  <th className="pb-2 font-medium text-muted-foreground">Использован</th>
                  <th className="pb-2 font-medium text-muted-foreground">Статус</th>
                  <th className="pb-2 font-medium text-muted-foreground">Создан</th>
                  <th className="pb-2 font-medium text-muted-foreground"></th>
                </tr>
              </thead>
              <tbody>
                {promos.map((p) => (
                  <tr key={p._id} className="border-b border-border/50 last:border-0">
                    <td className="py-2 pr-3 font-mono font-bold">{p.code}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{p.description}</td>
                    <td className="py-2 pr-3">+{p.bonusDays} дн.</td>
                    <td className="py-2 pr-3">{p.usedCount}{p.maxUses ? ` / ${p.maxUses}` : ''}</td>
                    <td className="py-2 pr-3">
                      <Badge variant={p.isActive ? 'success' : 'secondary'}>
                        {p.isActive ? 'Активен' : 'Выключен'}
                      </Badge>
                    </td>
                    <td className="py-2 pr-3 text-muted-foreground">{formatDate(p.createdAt)}</td>
                    <td className="py-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => togglePromo({ promoId: p._id })}
                      >
                        {p.isActive ? 'Выключить' : 'Включить'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const SYSTEM_TEMPLATES = [
  {
    label: 'Тех. работы',
    text: '🔧 <b>Плановые технические работы</b>\n\nСервис будет недоступен ориентировочно 30 минут.\nПриносим извинения за неудобства.',
  },
  {
    label: 'Работы завершены',
    text: '✅ <b>Технические работы завершены</b>\n\nСервис работает в штатном режиме. Спасибо за терпение!',
  },
  {
    label: 'Обновление',
    text: '🚀 <b>Обновление AddPilot</b>\n\nМы добавили новые возможности! Подробности в личном кабинете.',
  },
];

function BroadcastSection({ sessionToken }: { sessionToken: string }) {
  const telegramUsers = useQuery(api.admin.getTelegramUsers, { sessionToken });
  const broadcast = useAction(api.admin.broadcastTelegram);

  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ sent: number; failed: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedAll, setSelectedAll] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const recipients = selectedAll
    ? telegramUsers || []
    : (telegramUsers || []).filter((u) => selectedIds.has(u._id));

  const handleSend = async () => {
    if (!message.trim() || recipients.length === 0) return;
    setSending(true);
    setError(null);
    setResult(null);
    try {
      const res = await broadcast({
        sessionToken,
        message: message.trim(),
        chatIds: recipients.map((u) => u.telegramChatId),
      });
      setResult(res);
      if (res.sent === res.total) setMessage('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка отправки');
    } finally {
      setSending(false);
    }
  };

  const toggleUser = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
    setSelectedAll(false);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Send className="w-5 h-5" />
          Рассылка в Telegram {telegramUsers && `(${telegramUsers.length} получателей)`}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Templates */}
        <div className="flex flex-wrap gap-2">
          {SYSTEM_TEMPLATES.map((t) => (
            <Button
              key={t.label}
              size="sm"
              variant="outline"
              onClick={() => setMessage(t.text)}
            >
              {t.label}
            </Button>
          ))}
        </div>

        {/* Message */}
        <div className="space-y-1">
          <Label className="text-xs">Сообщение (HTML-разметка)</Label>
          <textarea
            className="w-full min-h-[120px] p-3 rounded-lg border border-border bg-background text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder="Введите текст сообщения..."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </div>

        {/* Recipients */}
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <Label className="text-xs">Получатели:</Label>
            <Button
              size="sm"
              variant={selectedAll ? 'default' : 'outline'}
              onClick={() => { setSelectedAll(true); setSelectedIds(new Set()); }}
            >
              Все
            </Button>
            <Button
              size="sm"
              variant={!selectedAll ? 'default' : 'outline'}
              onClick={() => setSelectedAll(false)}
            >
              Выбрать
            </Button>
          </div>

          {!selectedAll && telegramUsers && (
            <div className="flex flex-wrap gap-2 max-h-[120px] overflow-y-auto p-2 border border-border rounded-lg">
              {telegramUsers.map((u) => (
                <Button
                  key={u._id}
                  size="sm"
                  variant={selectedIds.has(u._id) ? 'default' : 'outline'}
                  onClick={() => toggleUser(u._id)}
                >
                  {u.telegramFirstName || u.name}
                  {u.telegramUsername && ` @${u.telegramUsername}`}
                </Button>
              ))}
            </div>
          )}
        </div>

        {/* Status */}
        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}
        {result && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 text-green-700 text-sm">
            <CheckCircle className="w-4 h-4 shrink-0" />
            Отправлено: {result.sent} из {result.total}
            {result.failed > 0 && `, ошибок: ${result.failed}`}
          </div>
        )}

        {/* Send */}
        <Button
          onClick={handleSend}
          disabled={sending || !message.trim() || recipients.length === 0}
        >
          {sending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Send className="w-4 h-4 mr-2" />}
          Отправить {recipients.length > 0 ? `(${recipients.length})` : ''}
        </Button>
      </CardContent>
    </Card>
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

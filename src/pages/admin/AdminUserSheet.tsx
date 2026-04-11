import { useQuery, useMutation, useAction } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Id } from '../../../convex/_generated/dataModel';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import {
  X,
  Bell,
  Stethoscope,
  Loader2,
  CheckCircle,
  AlertCircle,
  Send,
} from 'lucide-react';
import { Input } from '../../components/ui/input';
import { useState } from 'react';

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

export interface AdminUser {
  _id: string;
  email: string;
  name?: string;
  isAdmin: boolean;
  subscriptionTier?: string;
  subscriptionExpiresAt?: number;
  telegramChatId?: string;
  createdAt: number;
  accountsCount: number;
  rulesCount: number;
  lastPromoCode: string | null;
  lastBonusDays: number | null;
  totalPaid: number;
  referralCode: string | null;
  referralType: string;
  referralDiscount: number;
  referralCount: number;
}

interface Props {
  user: AdminUser;
  sessionToken: string;
  onClose: () => void;
}

const NOTIFY_TEMPLATES = [
  { label: 'Оплата', title: 'Необходима оплата подписки', message: 'Ваш тариф был деактивирован. Для продолжения использования сервиса, пожалуйста, оплатите подписку в разделе Тарифы.', type: 'payment' as const },
  { label: 'Истекает', title: 'Подписка скоро истекает', message: 'Ваша подписка истекает через несколько дней. Продлите подписку, чтобы не потерять доступ к функциям.', type: 'warning' as const },
  { label: 'Инфо', title: 'Информация', message: '', type: 'info' as const },
];

export function AdminUserSheet({ user: u, sessionToken, onClose }: Props) {
  const updateTier = useMutation(api.admin.updateUserTier);
  const updateExpiry = useMutation(api.admin.updateUserExpiry);
  const toggleAdmin = useMutation(api.admin.toggleAdmin);
  const sendNotification = useMutation(api.admin.sendUserNotification);
  const adminUpdateReferral = useMutation(api.referrals.adminUpdateReferral);
  const runUserCheck = useAction(api.healthCheck.runManualUserCheck);
  const referralDetails = useQuery(api.referrals.adminGetUserReferrals, {
    sessionToken,
    userId: u._id as Id<'users'>,
  });

  const [changingTier, setChangingTier] = useState(false);
  const [editingExpiry, setEditingExpiry] = useState(false);
  const [expiryInput, setExpiryInput] = useState('');
  const [togglingAdmin, setTogglingAdmin] = useState(false);
  const [diagRunning, setDiagRunning] = useState(false);

  // Notification state
  const [showNotify, setShowNotify] = useState(false);
  const [notifyTitle, setNotifyTitle] = useState('');
  const [notifyMessage, setNotifyMessage] = useState('');
  const [notifyType, setNotifyType] = useState<'info' | 'warning' | 'payment'>('info');
  const [notifySending, setNotifySending] = useState(false);
  const [notifyResult, setNotifyResult] = useState<string | null>(null);

  const formatDate = (ts: number) =>
    new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const toDateInput = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const handleTierChange = async (newTier: 'freemium' | 'start' | 'pro') => {
    setChangingTier(true);
    try {
      await updateTier({ sessionToken, userId: u._id as Id<'users'>, tier: newTier });
    } catch (err) {
      console.error('Failed to update tier:', err);
    } finally {
      setChangingTier(false);
    }
  };

  const handleExpirySave = async () => {
    if (!expiryInput) {
      await updateExpiry({ sessionToken, userId: u._id as Id<'users'>, expiresAt: undefined });
    } else {
      const ts = new Date(expiryInput + 'T23:59:59').getTime();
      await updateExpiry({ sessionToken, userId: u._id as Id<'users'>, expiresAt: ts });
    }
    setEditingExpiry(false);
    setExpiryInput('');
  };

  const handleSendNotification = async () => {
    if (!notifyTitle.trim() || !notifyMessage.trim()) return;
    setNotifySending(true);
    setNotifyResult(null);
    try {
      await sendNotification({
        sessionToken,
        userId: u._id as Id<'users'>,
        title: notifyTitle.trim(),
        message: notifyMessage.trim(),
        type: notifyType,
      });
      setNotifyResult('Отправлено');
      setTimeout(() => { setNotifyResult(null); setShowNotify(false); }, 2000);
    } catch (err) {
      setNotifyResult(`Ошибка: ${err instanceof Error ? err.message : 'Неизвестная ошибка'}`);
    } finally {
      setNotifySending(false);
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />

      {/* Panel */}
      <div className="fixed right-0 top-0 bottom-0 w-full max-w-lg bg-background border-l border-border z-50 overflow-y-auto shadow-xl">
        <div className="p-6 space-y-6">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-lg font-bold">{u.name || u.email}</h2>
              <p className="text-sm text-muted-foreground">{u.email}</p>
              <p className="text-xs text-muted-foreground mt-1">
                Регистрация: {formatDate(u.createdAt)}
              </p>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="w-5 h-5" />
            </Button>
          </div>

          {/* Quick stats */}
          <div className="grid grid-cols-3 gap-3">
            <div className="text-center p-3 rounded-lg bg-muted/50">
              <p className="text-2xl font-bold">{u.accountsCount}</p>
              <p className="text-xs text-muted-foreground">Кабинеты</p>
            </div>
            <div className="text-center p-3 rounded-lg bg-muted/50">
              <p className="text-2xl font-bold">{u.rulesCount}</p>
              <p className="text-xs text-muted-foreground">Правила</p>
            </div>
            <div className="text-center p-3 rounded-lg bg-muted/50">
              <p className="text-2xl font-bold">{u.totalPaid > 0 ? `${u.totalPaid.toFixed(0)}` : '0'}</p>
              <p className="text-xs text-muted-foreground">Оплачено BYN</p>
            </div>
          </div>

          {/* Tier */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Тариф</label>
            <div className="flex items-center gap-3">
              <Badge variant={TIER_BADGE_VARIANT[u.subscriptionTier ?? 'freemium']}>
                {TIER_LABELS[u.subscriptionTier ?? 'freemium']}
              </Badge>
              <select
                className="text-sm border border-border rounded px-2 py-1 bg-background"
                value={u.subscriptionTier}
                disabled={changingTier}
                onChange={(e) => handleTierChange(e.target.value as 'freemium' | 'start' | 'pro')}
              >
                <option value="freemium">Freemium</option>
                <option value="start">Start</option>
                <option value="pro">Pro</option>
              </select>
            </div>
          </div>

          {/* Expiry */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Доступ до</label>
            {editingExpiry ? (
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  className="text-sm border border-border rounded px-2 py-1 bg-background"
                  value={expiryInput}
                  onChange={(e) => setExpiryInput(e.target.value)}
                />
                <Button size="sm" onClick={handleExpirySave}>
                  <CheckCircle className="w-4 h-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditingExpiry(false)}>
                  Отмена
                </Button>
              </div>
            ) : (
              <button
                className={`text-sm ${
                  u.subscriptionExpiresAt && u.subscriptionExpiresAt < Date.now()
                    ? 'text-destructive'
                    : 'text-muted-foreground'
                } hover:underline`}
                onClick={() => {
                  setEditingExpiry(true);
                  setExpiryInput(
                    u.subscriptionExpiresAt
                      ? toDateInput(u.subscriptionExpiresAt)
                      : toDateInput(Date.now() + 30 * 24 * 60 * 60 * 1000)
                  );
                }}
              >
                {u.subscriptionExpiresAt
                  ? `${formatDate(u.subscriptionExpiresAt)}${u.subscriptionExpiresAt < Date.now() ? ' (истёк)' : ''}`
                  : 'Не задана — нажмите чтобы задать'}
              </button>
            )}
          </div>

          {/* Telegram + Admin */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">Telegram</label>
              <p className="text-sm">
                {u.telegramChatId ? (
                  <Badge variant="success">Подключён</Badge>
                ) : (
                  <span className="text-muted-foreground">Не подключён</span>
                )}
              </p>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Админ</label>
              <button
                className={`text-sm font-medium px-3 py-1 rounded ${
                  u.isAdmin
                    ? 'bg-primary/10 text-primary hover:bg-primary/20'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                } transition-colors`}
                disabled={togglingAdmin}
                onClick={async () => {
                  setTogglingAdmin(true);
                  try {
                    await toggleAdmin({
                      sessionToken,
                      userId: u._id as Id<'users'>,
                      isAdmin: !u.isAdmin,
                    });
                  } finally {
                    setTogglingAdmin(false);
                  }
                }}
              >
                {togglingAdmin ? '...' : u.isAdmin ? 'Да' : 'Нет'}
              </button>
            </div>
          </div>

          {/* Referral info */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Реферальная программа</label>
            <div className="flex items-center gap-3 text-sm">
              <span className="text-muted-foreground">Код: {u.referralCode || '—'}</span>
              <span className="text-muted-foreground">Рефералов: {u.referralCount}</span>
              <select
                value={u.referralType ?? 'basic'}
                onChange={(e) =>
                  adminUpdateReferral({
                    sessionToken,
                    userId: u._id as Id<'users'>,
                    referralType: e.target.value as 'basic' | 'discount',
                  })
                }
                className="text-sm bg-transparent border border-border rounded px-2 py-0.5"
              >
                <option value="basic">Обычная</option>
                <option value="discount">Со скидкой</option>
              </select>
            </div>
            {referralDetails && referralDetails.length > 0 && (
              <div className="mt-2 text-xs space-y-1">
                {referralDetails.map((r) => (
                  <div key={r._id} className="flex items-center gap-2 p-1.5 rounded bg-muted/30">
                    <span>{r.referredName}</span>
                    <Badge variant={r.status === 'paid' ? 'success' : 'secondary'} className="text-[10px]">
                      {r.status === 'paid' ? 'Оплатил' : 'Регистрация'}
                    </Badge>
                    <span className="text-muted-foreground">{new Date(r.createdAt).toLocaleDateString('ru-RU')}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Promo */}
          {u.lastPromoCode && (
            <div className="space-y-1">
              <label className="text-sm font-medium">Последний промокод</label>
              <p className="text-sm font-mono">
                {u.lastPromoCode}
                {u.lastBonusDays ? <span className="text-muted-foreground"> +{u.lastBonusDays}дн.</span> : null}
              </p>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-2 border-t border-border">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowNotify(!showNotify)}
            >
              <Bell className="w-4 h-4 mr-1" />
              Уведомление
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={diagRunning}
              onClick={async () => {
                setDiagRunning(true);
                try {
                  await runUserCheck({ userId: u._id as Id<'users'> });
                } finally {
                  setDiagRunning(false);
                }
              }}
            >
              {diagRunning ? (
                <Loader2 className="w-4 h-4 animate-spin mr-1" />
              ) : (
                <Stethoscope className="w-4 h-4 mr-1" />
              )}
              Диагностика
            </Button>
          </div>

          {/* Notification form */}
          {showNotify && (
            <div className="space-y-3 p-4 border border-border rounded-lg">
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
              <div className="flex gap-2">
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
                <div className={`flex items-center gap-2 p-2 rounded-lg text-sm ${
                  notifyResult.startsWith('Ошибка') ? 'bg-destructive/10 text-destructive' : 'bg-green-500/10 text-green-700'
                }`}>
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
            </div>
          )}
        </div>
      </div>
    </>
  );
}

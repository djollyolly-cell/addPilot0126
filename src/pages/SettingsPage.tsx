import { useState, useEffect } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { useNavigate, useLocation } from 'react-router-dom';
import { api } from '../../convex/_generated/api';
import { useAuth } from '../lib/useAuth';
import { BusinessProfileEditor } from '@/components/BusinessProfileEditor';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Label } from '../components/ui/label';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  Settings,
  Loader2,
  User,
  Mail,
  Calendar,
  Lock,
  CreditCard,
  Crown,
  CheckCircle2,
  Receipt,
  MessageCircle,
  Moon,
  Clock,
  Link2,
  Copy,
  ExternalLink,
  RefreshCw,
  Wifi,
  WifiOff,
  AlertTriangle,
  Briefcase,
  Send,
  AlertCircle,
  Gift,
  Users,
} from 'lucide-react';
import { CommunityProfilesSection } from "@/components/CommunityProfilesSection";
import { cn } from '../lib/utils';
import { Id } from '../../convex/_generated/dataModel';

const TIER_LABELS: Record<string, string> = {
  freemium: 'Freemium',
  start: 'Start',
  pro: 'Pro',
};

const TIER_COLORS: Record<string, string> = {
  freemium: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300',
  start: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
  pro: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400',
};

const BOT_USERNAME = import.meta.env.VITE_TELEGRAM_BOT_USERNAME || 'Addpilot_bot';

export function SettingsPage() {
  const { user } = useAuth();
  const location = useLocation();
  const initialTab = (location.state as { tab?: string })?.tab || 'profile';
  const [activeTab, setActiveTab] = useState<'profile' | 'telegram' | 'api' | 'business' | 'referral' | 'communities'>(initialTab as 'profile' | 'telegram' | 'api' | 'business' | 'referral' | 'communities');

  if (!user) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div data-testid="settings-page" className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Settings className="w-8 h-8 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Настройки</h1>
          <p className="text-muted-foreground">Профиль, подписка и интеграции</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-border">
        <nav className="flex gap-4">
          <button
            data-testid="tab-profile"
            onClick={() => setActiveTab('profile')}
            className={cn(
              'pb-3 px-1 text-sm font-medium border-b-2 transition-colors',
              activeTab === 'profile'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            Профиль
          </button>
          <button
            data-testid="tab-telegram"
            onClick={() => setActiveTab('telegram')}
            className={cn(
              'pb-3 px-1 text-sm font-medium border-b-2 transition-colors',
              activeTab === 'telegram'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            Telegram
          </button>
          <button
            data-testid="tab-api"
            onClick={() => setActiveTab('api')}
            className={cn(
              'pb-3 px-1 text-sm font-medium border-b-2 transition-colors',
              activeTab === 'api'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            API
          </button>
          <button
            data-testid="tab-business"
            onClick={() => setActiveTab('business')}
            className={cn(
              'pb-3 px-1 text-sm font-medium border-b-2 transition-colors',
              activeTab === 'business'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            Бизнес
          </button>
          <button
            data-testid="tab-referral"
            onClick={() => setActiveTab('referral')}
            className={cn(
              'pb-3 px-1 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5',
              activeTab === 'referral'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <Gift className="w-4 h-4" />
            Рефералы
          </button>
          <button
            data-testid="tab-communities"
            onClick={() => setActiveTab('communities')}
            className={cn(
              'pb-3 px-1 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5',
              activeTab === 'communities'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <Users className="w-4 h-4" />
            Сообщества
          </button>
        </nav>
      </div>

      {/* Tab content */}
      {activeTab === 'profile' ? (
        <ProfileTab user={user} />
      ) : activeTab === 'telegram' ? (
        <TelegramTab userId={user.userId as Id<'users'>} />
      ) : activeTab === 'api' ? (
        <ApiTab userId={user.userId as Id<'users'>} />
      ) : activeTab === 'referral' ? (
        <ReferralTab userId={user.userId} />
      ) : activeTab === 'communities' ? (
        <CommunityProfilesSection />
      ) : (
        <BusinessTab userId={user.userId} />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   Profile Tab (Sprint 20)
   ═══════════════════════════════════════════════════════════ */

function ProfileTab({ user }: { user: NonNullable<ReturnType<typeof useAuth>['user']> }) {
  const navigate = useNavigate();
  const paymentHistory = useQuery(
    api.billing.getPaymentHistory,
    user.userId ? { userId: user.userId as Id<"users"> } : "skip"
  );

  return (
    <div data-testid="profile-tab" className="space-y-6">
      {/* Upgrade Banner */}
      <div
        onClick={() => navigate('/pricing')}
        className="flex items-center justify-between p-4 rounded-xl bg-gradient-to-r from-primary/10 via-primary/5 to-transparent border border-primary/20 cursor-pointer hover:border-primary/40 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <Crown className="w-6 h-6 text-primary" />
          </div>
          <div>
            <p className="font-semibold">
              {user.subscriptionTier === 'freemium'
                ? 'Перейти на платный тариф'
                : user.subscriptionTier === 'start'
                ? 'Перейти на Pro'
                : 'Управление тарифом'}
            </p>
            <p className="text-sm text-muted-foreground">
              {user.subscriptionTier === 'freemium'
                ? 'Больше кабинетов, правил и возможностей'
                : user.subscriptionTier === 'start'
                ? 'До 9 кабинетов, безлимитные правила, API'
                : 'Посмотреть все тарифы и опции'}
            </p>
          </div>
        </div>
        <Button variant="default" size="sm" className="shrink-0">
          {user.subscriptionTier === 'pro' ? 'Тарифы' : 'Улучшить'}
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Personal info */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <User className="w-5 h-5" />
              Личные данные
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <Mail className="w-4 h-4 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">Email</p>
                <p className="font-medium">{user.email}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Calendar className="w-4 h-4 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">Дата регистрации</p>
                <p className="font-medium">
                  {new Date().toLocaleDateString('ru-RU', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}
                </p>
              </div>
            </div>
            {user.name && (
              <div className="flex items-center gap-3">
                <User className="w-4 h-4 text-muted-foreground" />
                <div>
                  <p className="text-sm text-muted-foreground">Имя</p>
                  <p className="font-medium">{user.name}</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Security info */}
        <SecurityInfoCard />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Subscription info */}
        <Card data-testid="subscription-info">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Crown className="w-5 h-5" />
              Подписка
            </CardTitle>
            <CardDescription>Текущий тарифный план</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Тариф</span>
              <span
                data-testid="subscription-tier"
                className={cn(
                  'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium',
                  TIER_COLORS[user.subscriptionTier] || TIER_COLORS.freemium
                )}
              >
                {TIER_LABELS[user.subscriptionTier] || user.subscriptionTier}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Статус</span>
              <Badge variant="default" className="text-xs">
                Активна
              </Badge>
            </div>
            {user.subscriptionTier !== 'freemium' && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Действует до</span>
                <span className="text-sm font-medium">
                  {new Date(Date.now() + 30 * 86400000).toLocaleDateString('ru-RU')}
                </span>
              </div>
            )}
            <div className="pt-3 border-t space-y-2">
              {user.subscriptionTier === 'freemium' ? (
                <button
                  onClick={() => navigate('/pricing')}
                  className="w-full px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
                >
                  Перейти на Start — 1 290 ₽/мес
                </button>
              ) : (
                <button
                  onClick={() => navigate('/pricing')}
                  className="w-full px-4 py-2 border border-primary text-primary rounded-lg text-sm font-medium hover:bg-primary/5 transition-colors flex items-center justify-center gap-2"
                >
                  <Crown className="w-4 h-4" />
                  Изменить тариф
                </button>
              )}
              <p className="text-xs text-muted-foreground text-center pt-1">
                🇷🇺 Доступна оплата картами МИР
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Payment history */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Receipt className="w-5 h-5" />
              История платежей
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!paymentHistory || paymentHistory.length === 0 ? (
              <div data-testid="no-payments" className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                <CreditCard className="w-10 h-10 mb-2 opacity-50" />
                <p className="text-sm font-medium">Нет платежей</p>
                <p className="text-xs mt-1">Платежи появятся после оформления подписки</p>
              </div>
            ) : (
              <div data-testid="payments-table" className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="pb-2 font-medium">Дата</th>
                      <th className="pb-2 font-medium">Тариф</th>
                      <th className="pb-2 font-medium">Сумма</th>
                      <th className="pb-2 font-medium">Статус</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paymentHistory.map((p) => (
                      <tr key={p.id} className="border-b">
                        <td className="py-2">
                          {new Date(p.completedAt || p.createdAt).toLocaleDateString('ru-RU')}
                        </td>
                        <td className="py-2">
                          <Badge variant="secondary" className="text-xs">
                            {p.tier === 'pro' ? 'Pro' : 'Start'}
                          </Badge>
                        </td>
                        <td className="py-2">
                          {p.amount.toLocaleString('ru-RU')} {p.currency === 'BYN' ? 'BYN' : '₽'}
                        </td>
                        <td className="py-2">
                          {p.status === 'completed' ? (
                            <span className="inline-flex items-center gap-1 text-green-600 text-xs">
                              <CheckCircle2 className="w-3 h-3" />
                              Оплачено
                            </span>
                          ) : p.status === 'failed' ? (
                            <span className="text-destructive text-xs">Ошибка</span>
                          ) : (
                            <span className="text-muted-foreground text-xs">Ожидание</span>
                          )}
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

      {/* Feedback Form */}
      <FeedbackForm userId={user.userId as Id<'users'>} />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   Feedback Form
   ═══════════════════════════════════════════════════════════ */

function FeedbackForm({ userId }: { userId: Id<'users'> }) {
  const sendFeedback = useMutation(api.userNotifications.sendFeedback);
  const threads = useQuery(api.userNotifications.getUserThreads, { userId });
  const markAllRead = useMutation(api.userNotifications.markAllRead);

  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<'success' | 'error' | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);

  const handleSend = async (threadId?: string) => {
    if (!message.trim()) return;
    setSending(true);
    setResult(null);
    try {
      await sendFeedback({
        userId,
        title: threadId ? '' : (title.trim() || 'Обратная связь'),
        message: message.trim(),
        threadId: threadId as Id<'userNotifications'> | undefined,
      });
      setResult('success');
      setTitle('');
      setMessage('');
      setTimeout(() => setResult(null), 3000);
    } catch (err) {
      setResult('error');
      setErrorMsg(err instanceof Error ? err.message : 'Ошибка отправки');
    } finally {
      setSending(false);
    }
  };

  const totalUnread = threads?.reduce((sum, t) => sum + t.unreadCount, 0) ?? 0;

  // Mark admin replies as read when user opens the section
  useEffect(() => {
    if (totalUnread > 0) {
      markAllRead({ userId });
    }
  }, [totalUnread, markAllRead, userId]);

  return (
    <Card data-testid="feedback-form">
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <MessageCircle className="w-5 h-5" />
          Обратная связь
          {totalUnread > 0 && (
            <Badge variant="destructive" className="ml-2">{totalUnread}</Badge>
          )}
        </CardTitle>
        <CardDescription>Напишите нам, если есть вопросы или предложения</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* New message form */}
        <div className="space-y-3">
          <input
            type="text"
            placeholder="Тема (необязательно)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            data-testid="feedback-title"
          />
          <textarea
            placeholder="Ваше сообщение..."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className="w-full min-h-[80px] p-3 rounded-lg border border-border bg-background text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring"
            data-testid="feedback-message"
          />
          {result === 'success' && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 text-green-700 text-sm">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              Сообщение отправлено!
            </div>
          )}
          {result === 'error' && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {errorMsg}
            </div>
          )}
          <Button
            onClick={() => handleSend()}
            disabled={sending || !message.trim()}
            size="sm"
            className="gap-2"
            data-testid="feedback-send"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Отправить
          </Button>
        </div>

        {/* Previous threads */}
        {threads && threads.length > 0 && (
          <div className="space-y-3 pt-4 border-t">
            <p className="text-sm font-medium text-muted-foreground">Ваши обращения</p>
            {threads.map((t) => (
              <div key={t.threadId}>
                <button
                  onClick={() => setOpenThreadId(openThreadId === t.threadId ? null : t.threadId)}
                  className={`w-full text-left p-3 rounded-lg border transition-colors ${
                    t.unreadCount > 0
                      ? 'border-primary/30 bg-primary/5'
                      : 'border-border hover:bg-muted/50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {t.title || 'Обратная связь'}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">{t.lastMessage}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {t.unreadCount > 0 && (
                        <Badge variant="destructive" className="text-xs">{t.unreadCount}</Badge>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {new Date(t.lastMessageAt).toLocaleDateString('ru-RU', {
                          day: '2-digit',
                          month: '2-digit',
                        })}
                      </span>
                    </div>
                  </div>
                </button>

                {/* Thread messages */}
                {openThreadId === t.threadId && (
                  <UserThreadMessages
                    threadId={t.threadId as Id<'userNotifications'>}
                    userId={userId}
                    onReply={(text) => {
                      setMessage(text);
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function UserThreadMessages({
  threadId,
  userId,
  onReply: _onReply,
}: {
  threadId: Id<'userNotifications'>;
  userId: Id<'users'>;
  onReply: (text: string) => void;
}) {
  const thread = useQuery(api.userNotifications.getThread, { threadId });
  const sendFeedback = useMutation(api.userNotifications.sendFeedback);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);

  if (!thread) return null;

  const handleReply = async () => {
    if (!replyText.trim()) return;
    setSending(true);
    try {
      await sendFeedback({
        userId,
        title: '',
        message: replyText.trim(),
        threadId,
      });
      setReplyText('');
    } finally {
      setSending(false);
    }
  };

  const formatTime = (ts: number) =>
    new Date(ts).toLocaleDateString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <div className="mt-2 ml-3 space-y-2 border-l-2 border-border pl-3">
      {thread.map((msg) => (
        <div
          key={msg._id}
          className={`p-2 rounded-lg text-sm ${
            msg.direction === 'admin_to_user'
              ? 'bg-primary/10 border border-primary/20'
              : 'bg-muted/50 border border-border'
          }`}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-medium">
              {msg.direction === 'admin_to_user' ? 'Поддержка' : 'Вы'}
            </span>
            <span className="text-xs text-muted-foreground">{formatTime(msg.createdAt)}</span>
          </div>
          <p className="text-sm whitespace-pre-wrap">{msg.message}</p>
        </div>
      ))}

      {/* Reply in thread */}
      <div className="flex gap-2">
        <textarea
          className="flex-1 min-h-[40px] p-2 rounded-lg border border-border bg-background text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder="Ответить..."
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          rows={1}
        />
        <Button
          size="sm"
          onClick={handleReply}
          disabled={sending || !replyText.trim()}
          className="shrink-0 self-end"
        >
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </Button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   Telegram Tab (Sprint 21)
   ═══════════════════════════════════════════════════════════ */

function TelegramTab({ userId }: { userId: Id<'users'> }) {
  const connectionStatus = useQuery(api.telegram.getConnectionStatus, { userId });
  const existingToken = useQuery(api.telegram.getLinkToken, { userId });
  const generateToken = useMutation(api.telegram.generateLinkToken);
  const disconnectTelegram = useMutation(api.telegram.disconnectTelegram);

  const userSettings = useQuery(api.userSettings.get, { userId });
  const setQuietHours = useMutation(api.userSettings.setQuietHours);
  const setDigestEnabled = useMutation(api.userSettings.setDigestEnabled);

  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [quietEnabled, setQuietEnabled] = useState(false);
  const [quietStart, setQuietStart] = useState('23:00');
  const [quietEnd, setQuietEnd] = useState('07:00');
  const [digestOn, setDigestOn] = useState(true);

  useEffect(() => {
    if (existingToken) {
      setLinkToken(existingToken);
    }
  }, [existingToken]);

  useEffect(() => {
    if (userSettings) {
      setQuietEnabled(userSettings.quietHoursEnabled);
      setQuietStart(userSettings.quietHoursStart ?? '23:00');
      setQuietEnd(userSettings.quietHoursEnd ?? '07:00');
      setDigestOn(userSettings.digestEnabled);
    }
  }, [userSettings]);

  const handleGenerateToken = async () => {
    const token = await generateToken({ userId });
    setLinkToken(token);
    setCopied(false);
  };

  const botLink = linkToken
    ? `https://t.me/${BOT_USERNAME}?start=${linkToken}`
    : null;

  const qrCodeUrl = botLink
    ? `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(botLink)}&size=200x200&format=svg`
    : null;

  const handleCopyLink = () => {
    if (botLink) {
      navigator.clipboard.writeText(botLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div data-testid="telegram-tab" className="space-y-6 max-w-2xl">
      {/* Connection Status */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">Статус подключения</CardTitle>
              <CardDescription>Telegram-бот AddPilot</CardDescription>
            </div>
            {connectionStatus?.connected ? (
              <Badge variant="success" className="gap-1">
                <CheckCircle2 className="h-3 w-3" />
                Подключен
              </Badge>
            ) : (
              <Badge variant="secondary">Не подключен</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {connectionStatus?.connected ? (
            <div className="flex items-center gap-3 p-4 rounded-lg bg-success/10">
              <MessageCircle className="h-6 w-6 text-success" />
              <div className="flex-1">
                <p className="font-medium">Бот подключен</p>
                <p className="text-sm text-muted-foreground">
                  Уведомления отправляются в Telegram
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-destructive"
                onClick={async () => {
                  await disconnectTelegram({ userId });
                }}
                data-testid="disconnect-telegram"
              >
                Отключить
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-3 p-4 rounded-lg bg-muted">
              <MessageCircle className="h-6 w-6 text-muted-foreground" />
              <div className="flex-1">
                <p className="font-medium">Бот не подключен</p>
                <p className="text-sm text-muted-foreground">
                  Следуйте инструкции ниже для подключения
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Quiet Hours (only when connected) */}
      {connectionStatus?.connected && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Moon className="h-5 w-5" />
              <div>
                <CardTitle className="text-lg">Тихие часы</CardTitle>
                <CardDescription>Не отправлять уведомления в указанное время</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={quietEnabled}
                onChange={async (e) => {
                  const enabled = e.target.checked;
                  setQuietEnabled(enabled);
                  await setQuietHours({ userId, enabled, start: quietStart, end: quietEnd });
                }}
                className="h-4 w-4 rounded border-gray-300"
                data-testid="quiet-hours-toggle"
              />
              <span className="text-sm font-medium">Включить тихие часы</span>
            </label>

            {quietEnabled && (
              <div className="flex items-center gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">С</label>
                  <input
                    type="time"
                    value={quietStart}
                    onChange={async (e) => {
                      const val = e.target.value;
                      setQuietStart(val);
                      await setQuietHours({ userId, enabled: true, start: val, end: quietEnd });
                    }}
                    className="block w-28 px-2 py-1 border rounded text-sm"
                    data-testid="quiet-hours-start"
                  />
                </div>
                <span className="text-muted-foreground mt-5">&mdash;</span>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">До</label>
                  <input
                    type="time"
                    value={quietEnd}
                    onChange={async (e) => {
                      const val = e.target.value;
                      setQuietEnd(val);
                      await setQuietHours({ userId, enabled: true, start: quietStart, end: val });
                    }}
                    className="block w-28 px-2 py-1 border rounded text-sm"
                    data-testid="quiet-hours-end"
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Daily Digest (only when connected) */}
      {connectionStatus?.connected && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              <div>
                <CardTitle className="text-lg">Дайджест</CardTitle>
                <CardDescription>Ежедневная сводка за предыдущий день</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={digestOn}
                onChange={async (e) => {
                  const enabled = e.target.checked;
                  setDigestOn(enabled);
                  await setDigestEnabled({ userId, enabled });
                }}
                className="h-4 w-4 rounded border-gray-300"
                data-testid="digest-toggle"
              />
              <span className="text-sm font-medium">Отправлять дайджест в 09:00 (МСК)</span>
            </label>
          </CardContent>
        </Card>
      )}

      {/* Connection Flow (only when NOT connected) */}
      {!connectionStatus?.connected && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Подключение бота</CardTitle>
            <CardDescription>Отсканируйте QR-код или перейдите по ссылке</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {!linkToken ? (
              <div className="text-center space-y-4">
                <p className="text-sm text-muted-foreground">
                  Нажмите кнопку, чтобы получить ссылку для подключения
                </p>
                <Button onClick={handleGenerateToken} className="gap-2">
                  <Link2 className="h-4 w-4" />
                  Получить ссылку
                </Button>
              </div>
            ) : (
              <>
                {/* QR Code */}
                <div className="flex flex-col items-center gap-4">
                  <div
                    className="p-4 bg-white rounded-xl shadow-sm border"
                    data-testid="telegram-qr"
                  >
                    {qrCodeUrl && (
                      <img
                        src={qrCodeUrl}
                        alt="QR-код для Telegram бота"
                        width={200}
                        height={200}
                        className="block"
                        data-testid="telegram-qr-image"
                      />
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground text-center">
                    Отсканируйте камерой телефона
                  </p>
                </div>

                {/* Direct link */}
                <div className="space-y-3">
                  <p className="text-sm font-medium">Или перейдите по ссылке:</p>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 px-3 py-2 bg-muted rounded-lg text-sm font-mono truncate">
                      {botLink}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleCopyLink}
                      className="gap-1 shrink-0"
                    >
                      <Copy className="h-3 w-3" />
                      {copied ? 'Скопировано' : 'Копировать'}
                    </Button>
                  </div>
                  <a
                    href={botLink || '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Открыть в Telegram
                  </a>
                </div>

                {/* Instructions */}
                <div className="space-y-2 pt-4 border-t">
                  <p className="text-sm font-medium">Инструкция:</p>
                  <ol className="list-decimal list-inside space-y-1 text-sm text-muted-foreground">
                    <li>Откройте ссылку или отсканируйте QR-код</li>
                    <li>Нажмите <strong>Start</strong> в Telegram</li>
                    <li>Бот подтвердит подключение</li>
                    <li>Эта страница обновится автоматически</li>
                  </ol>
                </div>

                {/* Regenerate */}
                <Button variant="ghost" size="sm" onClick={handleGenerateToken} className="gap-1">
                  <RefreshCw className="h-3 w-3" />
                  Сгенерировать новую ссылку
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   API Tab (Sprint 21)
   ═══════════════════════════════════════════════════════════ */

function ApiTab({ userId }: { userId: Id<'users'> }) {
  const vkStatus = useQuery(api.adAccounts.getVkApiStatus, { userId });
  const syncErrors = useQuery(api.adAccounts.getSyncErrors, { userId });

  return (
    <div data-testid="api-tab" className="space-y-6 max-w-2xl">
      {/* VK API Status */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Wifi className="w-5 h-5" />
            Статус VK Ads API
          </CardTitle>
          <CardDescription>Подключение к рекламному кабинету</CardDescription>
        </CardHeader>
        <CardContent>
          {!vkStatus ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : vkStatus.connected && !vkStatus.expired ? (
            <div className="flex items-center gap-3 p-4 rounded-lg bg-green-50 dark:bg-green-900/20">
              <Wifi className="h-6 w-6 text-green-600" />
              <div className="flex-1">
                <p className="font-medium text-green-700 dark:text-green-400">Активно</p>
                <p className="text-sm text-muted-foreground">
                  API подключен и работает
                </p>
              </div>
              <Badge className="bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-400">
                Активно
              </Badge>
            </div>
          ) : vkStatus.connected && vkStatus.expired ? (
            <div className="flex items-center gap-3 p-4 rounded-lg bg-red-50 dark:bg-red-900/20">
              <WifiOff className="h-6 w-6 text-red-600" />
              <div className="flex-1">
                <p className="font-medium text-red-700 dark:text-red-400">Токен истёк</p>
                <p className="text-sm text-muted-foreground">
                  Переавторизуйтесь в VK Ads для восстановления
                </p>
              </div>
              <Badge variant="destructive">Переавторизуйтесь</Badge>
            </div>
          ) : (
            <div className="flex items-center gap-3 p-4 rounded-lg bg-muted">
              <WifiOff className="h-6 w-6 text-muted-foreground" />
              <div className="flex-1">
                <p className="font-medium">Не подключен</p>
                <p className="text-sm text-muted-foreground">
                  Подключите VK Ads в разделе Кабинеты
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Sync Errors */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" />
            Ошибки синхронизации
          </CardTitle>
          <CardDescription>Проблемы при обмене данными с VK Ads</CardDescription>
        </CardHeader>
        <CardContent>
          {!syncErrors ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : syncErrors.length === 0 ? (
            <div data-testid="sync-errors" className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <CheckCircle2 className="w-10 h-10 mb-2 text-green-500 opacity-70" />
              <p className="text-sm font-medium">Всё работает</p>
              <p className="text-xs mt-1">Ошибок синхронизации нет</p>
            </div>
          ) : (
            <div data-testid="sync-errors" className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pb-2 font-medium">Кабинет</th>
                    <th className="pb-2 font-medium">Ошибка</th>
                    <th className="pb-2 font-medium">Последняя синхронизация</th>
                  </tr>
                </thead>
                <tbody>
                  {syncErrors.map((err) => (
                    <tr key={err._id} className="border-b">
                      <td className="py-2 font-medium">{err.name}</td>
                      <td className="py-2 text-red-600 dark:text-red-400">{err.lastError}</td>
                      <td className="py-2 text-muted-foreground">
                        {err.lastSyncAt
                          ? new Date(err.lastSyncAt).toLocaleString('ru-RU')
                          : 'Никогда'}
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

/* ═══════════════════════════════════════════════════════════
   Security Info Card (VK OAuth - no local password)
   ═══════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════
   Business Tab
   ═══════════════════════════════════════════════════════════ */

function BusinessTab({ userId }: { userId: string }) {
  const settings = useQuery(
    api.userSettings.get,
    userId ? { userId: userId as Id<"users"> } : 'skip'
  );
  const accountId = settings?.activeAccountId;

  if (!accountId) {
    return (
      <div className="text-center py-12">
        <Briefcase className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
        <h3 className="text-lg font-medium mb-2">Выберите аккаунт</h3>
        <p className="text-muted-foreground">
          Выберите активный аккаунт на вкладке Профиль
        </p>
      </div>
    );
  }

  return <BusinessProfileEditor accountId={accountId} userId={userId} />;
}

/* ═══════════════════════════════════════════════════════════
   Security Info Card (VK OAuth - no local password)
   ═══════════════════════════════════════════════════════════ */

function SecurityInfoCard() {
  return (
    <Card data-testid="security-info">
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Lock className="w-5 h-5" />
          Безопасность
        </CardTitle>
        <CardDescription>Управление доступом к аккаунту</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start gap-3 p-4 rounded-lg bg-blue-50 dark:bg-blue-900/20">
          <CheckCircle2 className="w-5 h-5 text-blue-600 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium text-blue-900 dark:text-blue-100">Вход через VK ID</p>
            <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
              Ваш аккаунт защищён авторизацией VK. Пароль хранится в VK, а не в AddPilot.
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Для изменения пароля или настроек безопасности:
          </p>
          <a
            href="https://id.vk.com/account/#/security"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            Настройки безопасности VK
          </a>
        </div>
      </CardContent>
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════════
   Referral Tab
   ═══════════════════════════════════════════════════════════ */

function ReferralTab({ userId }: { userId: string }) {
  const stats = useQuery(
    api.referrals.getMyReferralStats,
    { userId: userId as Id<'users'> }
  );
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  if (stats === undefined) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!stats || !stats.referralCode) {
    return <p className="text-sm text-muted-foreground py-4">Реферальный код не найден</p>;
  }

  const referralLink = stats?.referralCode
    ? `https://aipilot.by/login?ref=${stats.referralCode}`
    : '';

  const handleCopy = () => {
    navigator.clipboard.writeText(stats.referralCode!);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyLink = () => {
    navigator.clipboard.writeText(referralLink);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  };

  return (
    <div data-testid="referral-tab" className="space-y-6 max-w-2xl">
      {/* Code & Link */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Ваш реферальный код и ссылка</CardTitle>
          <CardDescription>
            Поделитесь кодом или ссылкой — получайте бонусные дни за каждого оплатившего пользователя
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Referral code */}
          <div>
            <Label className="text-xs text-muted-foreground mb-1.5 block">Код</Label>
            <div className="flex items-center gap-3">
              <code className="text-lg font-mono bg-muted px-4 py-2 rounded-lg">
                {stats.referralCode}
              </code>
              <Button variant="outline" size="sm" onClick={handleCopy}>
                {copied ? <CheckCircle2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                <span className="ml-1.5">{copied ? 'Скопировано' : 'Копировать'}</span>
              </Button>
            </div>
          </div>

          {/* Referral link */}
          <div>
            <Label className="text-xs text-muted-foreground mb-1.5 block">Ссылка</Label>
            <div className="flex items-center gap-3">
              <code className="text-sm font-mono bg-muted px-4 py-2 rounded-lg truncate max-w-[320px]" title={referralLink}>
                {referralLink}
              </code>
              <Button variant="outline" size="sm" onClick={handleCopyLink}>
                {linkCopied ? <CheckCircle2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                <span className="ml-1.5">{linkCopied ? 'Скопировано' : 'Копировать'}</span>
              </Button>
            </div>
          </div>

          <div className="p-3 bg-muted/50 rounded-lg space-y-1.5 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Как это работает:</p>
            <ol className="list-decimal list-inside space-y-1">
              <li>Отправьте код или ссылку другу</li>
              <li>Друг переходит по ссылке (код подставится автоматически) или вводит код вручную при оплате</li>
              {stats.referralType === 'discount' && (
                <li>Друг получает <span className="font-medium text-foreground">скидку {stats.referralDiscount}%</span> на оплату</li>
              )}
              <li>Вы получаете <span className="font-medium text-foreground">+7 дней</span> к подписке за каждого оплатившего</li>
              <li>3 реферала = <span className="font-medium text-foreground">30 дней</span> бесплатного использования (7×3 + 9 бонус)</li>
              <li>10 рефералов = <span className="font-medium text-foreground">скидка 15%</span> на все последующие оплаты</li>
            </ol>
          </div>
        </CardContent>
      </Card>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{stats.paid}</div>
            <p className="text-sm text-muted-foreground">Оплативших рефералов</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">+{stats.bonusDays} дн.</div>
            <p className="text-sm text-muted-foreground">Дней заработано</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{stats.registered}</div>
            <p className="text-sm text-muted-foreground">Всего приглашённых</p>
          </CardContent>
        </Card>
      </div>

      {/* Progress bars */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Прогресс бонусов</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="flex justify-between text-sm mb-1">
              <span>Бесплатный месяц (30 дней за 3 реферала)</span>
              <span className={stats.milestone3Claimed ? 'text-green-600' : ''}>
                {Math.min(stats.paid, 3)}/3
              </span>
            </div>
            <div className="w-full bg-muted rounded-full h-2">
              <div
                className={cn('h-2 rounded-full transition-all', stats.milestone3Claimed ? 'bg-green-500' : 'bg-primary')}
                style={{ width: `${Math.min(100, (stats.paid / 3) * 100)}%` }}
              />
            </div>
            {stats.milestone3Claimed && (
              <p className="text-xs text-green-600 mt-1">Получено!</p>
            )}
          </div>
          <div>
            <div className="flex justify-between text-sm mb-1">
              <span>Скидка 15% на оплату</span>
              <span className={stats.milestone10Reached ? 'text-green-600' : ''}>
                {Math.min(stats.paid, 10)}/10
              </span>
            </div>
            <div className="w-full bg-muted rounded-full h-2">
              <div
                className={cn('h-2 rounded-full transition-all', stats.milestone10Reached ? 'bg-green-500' : 'bg-primary')}
                style={{ width: `${Math.min(100, (stats.paid / 10) * 100)}%` }}
              />
            </div>
            {stats.milestone10Reached && (
              <p className="text-xs text-green-600 mt-1">Активна!</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Referral list */}
      {stats.referrals.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Приглашённые</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {stats.referrals.map((r, i) => (
                <div key={i} className="flex items-center justify-between text-sm py-1.5 border-b last:border-0">
                  <span className="text-muted-foreground">
                    {new Date(r.createdAt).toLocaleDateString('ru-RU')}
                  </span>
                  <Badge variant={r.status === 'paid' ? 'success' : 'secondary'}>
                    {r.status === 'paid' ? 'Оплатил' : 'Зарегистрирован'}
                  </Badge>
                  {r.bonusDaysGranted && (
                    <span className="text-xs text-green-600">+{r.bonusDaysGranted} дн.</span>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

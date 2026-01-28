import { useState, useEffect } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useAuth } from '../lib/useAuth';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
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
  XCircle,
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
} from 'lucide-react';
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

const BOT_USERNAME = import.meta.env.VITE_TELEGRAM_BOT_USERNAME || 'AdPilotBot';

export function SettingsPage() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<'profile' | 'telegram' | 'api'>('profile');

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
        </nav>
      </div>

      {/* Tab content */}
      {activeTab === 'profile' ? (
        <ProfileTab user={user} />
      ) : activeTab === 'telegram' ? (
        <TelegramTab userId={user.userId as Id<'users'>} />
      ) : (
        <ApiTab userId={user.userId as Id<'users'>} />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   Profile Tab (Sprint 20)
   ═══════════════════════════════════════════════════════════ */

function ProfileTab({ user }: { user: NonNullable<ReturnType<typeof useAuth>['user']> }) {
  return (
    <div data-testid="profile-tab" className="space-y-6">
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

        {/* Password change form */}
        <PasswordChangeForm email={user.email} />
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
            {user.subscriptionTier === 'freemium' && (
              <div className="pt-3 border-t">
                <button className="w-full px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors">
                  Перейти на Start — 990 ₽/мес
                </button>
              </div>
            )}
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
            {user.subscriptionTier === 'freemium' ? (
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
                      <th className="pb-2 font-medium">Сумма</th>
                      <th className="pb-2 font-medium">Статус</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b">
                      <td className="py-2">
                        {new Date().toLocaleDateString('ru-RU')}
                      </td>
                      <td className="py-2">
                        {user.subscriptionTier === 'pro' ? '2 990 ₽' : '990 ₽'}
                      </td>
                      <td className="py-2">
                        <span className="inline-flex items-center gap-1 text-green-600 text-xs">
                          <CheckCircle2 className="w-3 h-3" />
                          Оплачено
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
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
              <CardDescription>Telegram-бот AdPilot</CardDescription>
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
   Password Change Form (Sprint 20)
   ═══════════════════════════════════════════════════════════ */

function PasswordChangeForm({ email }: { email: string }) {
  const changePassword = useAction(api.authEmail.changePassword);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (newPassword !== confirmPassword) {
      setError('Пароли не совпадают');
      return;
    }

    if (newPassword.length < 6) {
      setError('Новый пароль должен быть не менее 6 символов');
      return;
    }

    setLoading(true);
    try {
      const result = await changePassword({
        email,
        oldPassword,
        newPassword,
      });
      if (result.success) {
        setSuccess(true);
        setOldPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } else {
        setError(result.error || 'Ошибка смены пароля');
      }
    } catch {
      setError('Произошла ошибка');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card data-testid="password-form">
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Lock className="w-5 h-5" />
          Смена пароля
        </CardTitle>
        <CardDescription>Изменить пароль учётной записи VK</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-sm font-medium mb-1 block">Текущий пароль</label>
            <input
              data-testid="old-password"
              type="password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
              placeholder="Введите текущий пароль"
              required
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Новый пароль</label>
            <input
              data-testid="new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
              placeholder="Не менее 6 символов"
              required
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Подтверждение пароля</label>
            <input
              data-testid="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
              placeholder="Повторите новый пароль"
              required
            />
          </div>

          {error && (
            <div data-testid="password-error" className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded-md">
              <XCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          {success && (
            <div data-testid="password-success" className="flex items-center gap-2 text-sm text-green-600 bg-green-50 dark:bg-green-900/20 px-3 py-2 rounded-md">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              Пароль успешно изменён
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !oldPassword || !newPassword || !confirmPassword}
            className={cn(
              'w-full px-4 py-2 rounded-lg text-sm font-medium transition-colors',
              loading || !oldPassword || !newPassword || !confirmPassword
                ? 'bg-muted text-muted-foreground cursor-not-allowed'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            )}
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Проверка...
              </span>
            ) : (
              'Сменить пароль'
            )}
          </button>
        </form>
      </CardContent>
    </Card>
  );
}

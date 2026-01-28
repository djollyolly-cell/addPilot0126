import { useState } from 'react';
import { useAction } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useAuth } from '../lib/useAuth';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
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
} from 'lucide-react';
import { cn } from '../lib/utils';

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

export function SettingsPage() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<'profile' | 'telegram'>('profile');

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
        </nav>
      </div>

      {/* Tab content */}
      {activeTab === 'profile' ? (
        <ProfileTab user={user} />
      ) : (
        <div className="text-muted-foreground text-sm">
          Перейдите в{' '}
          <a href="/settings/telegram" className="text-primary underline">
            Настройки Telegram
          </a>
        </div>
      )}
    </div>
  );
}

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

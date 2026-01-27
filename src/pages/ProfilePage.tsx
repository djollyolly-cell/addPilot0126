import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useAuth } from '../lib/useAuth';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '../components/ui/avatar';
import {
  User,
  Mail,
  Calendar,
  CreditCard,
  Zap,
  Shield,
  MessageCircle,
  AlertCircle,
} from 'lucide-react';
import { getTierLabel, cn } from '../lib/utils';
import { Id } from '../../convex/_generated/dataModel';

export function ProfilePage() {
  const { user } = useAuth();

  const limits = useQuery(
    api.users.getLimits,
    user?.userId ? { userId: user.userId as Id<"users"> } : 'skip'
  );

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6" data-testid="user-profile">
      {/* Page header */}
      <div>
        <h1 className="text-3xl font-bold">Профиль</h1>
        <p className="text-muted-foreground">
          Управление аккаунтом и подпиской
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* User info card */}
        <Card data-testid="user-info-card">
          <CardHeader>
            <CardTitle className="text-lg">Информация</CardTitle>
            <CardDescription>Ваши данные из VK</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4">
              <Avatar className="h-16 w-16">
                <AvatarImage src={user.avatarUrl} alt={user.name} />
                <AvatarFallback>
                  <User className="h-8 w-8 text-muted-foreground" />
                </AvatarFallback>
              </Avatar>
              <div>
                <p className="font-semibold text-lg">{user.name || 'Пользователь'}</p>
                <p className="text-sm text-muted-foreground">VK ID: {user.vkId}</p>
              </div>
            </div>

            <div className="space-y-3 pt-4 border-t">
              <div className="flex items-center gap-3 text-sm">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span>{user.email}</span>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <span>Зарегистрирован</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Subscription card */}
        <Card data-testid="subscription-card">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg">Подписка</CardTitle>
                <CardDescription>Текущий тарифный план</CardDescription>
              </div>
              <Badge
                variant={
                  user.subscriptionTier === 'pro'
                    ? 'success'
                    : user.subscriptionTier === 'start'
                    ? 'default'
                    : 'secondary'
                }
                className="text-sm"
              >
                {getTierLabel(user.subscriptionTier)}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <TierFeature
                icon={CreditCard}
                label="Кабинеты"
                value={
                  limits
                    ? `${limits.usage.accounts} / ${limits.limits.accounts === Infinity ? '∞' : limits.limits.accounts}`
                    : '—'
                }
                available={limits?.canAddAccount}
              />
              <TierFeature
                icon={Zap}
                label="Правила"
                value={
                  limits
                    ? `${limits.usage.rules} / ${limits.limits.rules === Infinity ? '∞' : limits.limits.rules}`
                    : '—'
                }
                available={limits?.canAddRule}
              />
            </div>

            <div className="flex items-center gap-2 text-sm">
              <Shield
                className={cn(
                  'h-4 w-4',
                  limits?.limits.autoStop
                    ? 'text-success'
                    : 'text-muted-foreground'
                )}
              />
              <span>Автоостановка</span>
              {limits?.limits.autoStop ? (
                <Badge variant="success" className="ml-auto">
                  Включена
                </Badge>
              ) : (
                <Badge variant="secondary" className="ml-auto">
                  Недоступна
                </Badge>
              )}
            </div>

            {user.subscriptionTier === 'freemium' && (
              <div className="pt-4 border-t">
                <Button className="w-full" data-testid="upgrade-button">
                  Перейти на Start
                </Button>
                <p className="text-xs text-center text-muted-foreground mt-2">
                  990 ₽/мес — автоостановка, до 3 кабинетов
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Telegram card */}
        <Card data-testid="telegram-card">
          <CardHeader>
            <CardTitle className="text-lg">Telegram</CardTitle>
            <CardDescription>
              Подключите бота для уведомлений
            </CardDescription>
          </CardHeader>
          <CardContent>
            {user.telegramChatId ? (
              <div className="flex items-center gap-3 p-3 rounded-lg bg-success/10">
                <MessageCircle className="h-5 w-5 text-success" />
                <div className="flex-1">
                  <p className="font-medium text-sm">Подключен</p>
                  <p className="text-xs text-muted-foreground">
                    Уведомления отправляются в Telegram
                  </p>
                </div>
                <Button variant="ghost" size="sm">
                  Отключить
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-3 p-3 rounded-lg bg-muted">
                  <AlertCircle className="h-5 w-5 text-warning" />
                  <div className="flex-1">
                    <p className="font-medium text-sm">Не подключен</p>
                    <p className="text-xs text-muted-foreground">
                      Подключите для получения уведомлений
                    </p>
                  </div>
                </div>
                <Button variant="outline" className="w-full">
                  <MessageCircle className="h-4 w-4 mr-2" />
                  Подключить Telegram
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Onboarding status */}
        <Card data-testid="onboarding-card">
          <CardHeader>
            <CardTitle className="text-lg">Начало работы</CardTitle>
            <CardDescription>Статус настройки аккаунта</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <OnboardingStep
                done={true}
                label="Авторизация через VK"
              />
              <OnboardingStep
                done={!!user.telegramChatId}
                label="Подключение Telegram"
              />
              <OnboardingStep
                done={user.onboardingCompleted}
                label="Подключение рекламного кабинета"
              />
              <OnboardingStep
                done={user.onboardingCompleted}
                label="Создание первого правила"
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function TierFeature({
  icon: Icon,
  label,
  value,
  available,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  available?: boolean;
}) {
  return (
    <div className="p-3 rounded-lg bg-muted">
      <div className="flex items-center gap-2 mb-1">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className={cn('font-semibold', available === false && 'text-warning')}>
        {value}
      </p>
    </div>
  );
}

function OnboardingStep({ done, label }: { done: boolean; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <div
        className={cn(
          'w-5 h-5 rounded-full flex items-center justify-center text-xs',
          done ? 'bg-success text-white' : 'bg-muted text-muted-foreground'
        )}
      >
        {done ? '✓' : '○'}
      </div>
      <span className={cn('text-sm', !done && 'text-muted-foreground')}>
        {label}
      </span>
    </div>
  );
}

import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Check, Crown, Zap, Sparkles, CheckCircle, XCircle } from 'lucide-react';
import { useAuth } from '@/lib/useAuth';
import { PaymentModal } from '@/components/PaymentModal';
import { AgencyTierCard } from '@/components/AgencyTierCard';
import { useNavigate } from 'react-router-dom';

const TIERS = {
  freemium: {
    name: "Freemium",
    price: 0,
    period: "",
    accountsLimit: 1,
    rulesLimit: 3,
    features: ["1 рекламный кабинет", "3 правила автоматизации", "Telegram-уведомления"],
    icon: Sparkles,
    popular: false,
  },
  start: {
    name: "Start",
    price: 1290,
    period: "/мес",
    accountsLimit: 3,
    rulesLimit: 10,
    features: ["3 рекламных кабинета", "10 правил автоматизации", "Telegram-уведомления", "Базовая аналитика"],
    icon: Zap,
    popular: true,
  },
  pro: {
    name: "Pro",
    price: 2990,
    period: "/мес",
    accountsLimit: 9,
    rulesLimit: -1,
    features: ["До 9 кабинетов", "Неограниченные правила", "Приоритетная поддержка", "Расширенная аналитика"],
    icon: Crown,
    popular: false,
  },
} as const;

type TierKey = keyof typeof TIERS;

const AGENCY_COMMON_FEATURES = [
  "Все функции Pro",
  "Конструктор правил (L2)",
  "Команда менеджеров с правами",
  "Приоритетная поддержка",
  "Мониторинг здоровья аккаунтов",
  "Месячный отчёт по нагрузке",
];

const AGENCY_TIERS = [
  { code: "agency_s", name: "Agency S", price: 14900, includedLoadUnits: 30, overagePerUnit: 600,
    features: [...AGENCY_COMMON_FEATURES] },
  { code: "agency_m", name: "Agency M", price: 24900, includedLoadUnits: 60, overagePerUnit: 500,
    features: [...AGENCY_COMMON_FEATURES] },
  { code: "agency_l", name: "Agency L", price: 39900, includedLoadUnits: 120, overagePerUnit: 400,
    features: [...AGENCY_COMMON_FEATURES, "Выделенный IP", "Кастомные типы правил (L3)", "SLA на синхронизацию"], recommended: true },
  { code: "agency_xl", name: "Agency XL", includedLoadUnits: 200,
    features: [...AGENCY_COMMON_FEATURES, "Выделенный IP", "Кастомные типы правил (L3)", "SLA на синхронизацию", "Персональный менеджер"] },
];

export function PricingPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedTier, setSelectedTier] = useState<TierKey | null>(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const currentTier = (user?.subscriptionTier || 'freemium') as TierKey;

  // Get user's personalized prices (respects grandfathered pricing)
  const userPrices = useQuery(
    api.billing.getUserPrices,
    user?.userId ? { userId: user.userId as Id<"users"> } : "skip"
  );

  // Handle URL params on mount: ?status=success/failed and ?plan=start/pro
  useEffect(() => {
    const status = searchParams.get('status');
    const tier = searchParams.get('tier');
    const plan = searchParams.get('plan');

    // Handle bePaid return status
    if (status === 'success') {
      const tierName = tier && tier in TIERS ? TIERS[tier as TierKey].name : '';
      setStatusMessage({
        type: 'success',
        text: tierName
          ? `Оплата прошла успешно! Тариф ${tierName} активирован.`
          : 'Оплата прошла успешно!',
      });
      // Clean up URL params
      setSearchParams({}, { replace: true });
    } else if (status === 'failed') {
      setStatusMessage({
        type: 'error',
        text: 'Оплата не прошла. Попробуйте ещё раз или выберите другой способ оплаты.',
      });
      setSearchParams({}, { replace: true });
    }

    // Auto-open payment modal if ?plan= is set
    if (plan && (plan === 'start' || plan === 'pro') && plan !== currentTier) {
      setSelectedTier(plan as TierKey);
      setShowPaymentModal(true);
      setSearchParams({}, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectTier = (tier: TierKey) => {
    if (tier === 'freemium' || tier === currentTier) return;
    setSelectedTier(tier);
    setShowPaymentModal(true);
  };

  const handlePaymentSuccess = () => {
    setShowPaymentModal(false);
    setSelectedTier(null);
    setStatusMessage({
      type: 'success',
      text: 'Оплата прошла успешно! Тариф активирован.',
    });
  };

  const dismissStatus = () => setStatusMessage(null);

  return (
    <div className="container mx-auto py-8 px-4" data-testid="pricing-page">
      {/* Payment status notification */}
      {statusMessage && (
        <div
          className={`mb-8 max-w-2xl mx-auto flex items-center gap-3 p-4 rounded-lg ${
            statusMessage.type === 'success'
              ? 'bg-green-50 text-green-800 border border-green-200'
              : 'bg-red-50 text-red-800 border border-red-200'
          }`}
          data-testid="payment-status"
        >
          {statusMessage.type === 'success' ? (
            <CheckCircle className="h-5 w-5 text-green-600 shrink-0" />
          ) : (
            <XCircle className="h-5 w-5 text-red-600 shrink-0" />
          )}
          <span className="flex-1 text-sm font-medium">{statusMessage.text}</span>
          <button
            onClick={dismissStatus}
            className="text-current opacity-50 hover:opacity-100 transition-opacity text-lg leading-none"
          >
            &times;
          </button>
        </div>
      )}

      <div className="text-center mb-12">
        <h1 className="text-4xl font-bold mb-4">Выберите тариф</h1>
        <p className="text-muted-foreground text-lg">
          Начните бесплатно и масштабируйте по мере роста
        </p>
      </div>

      <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
        {(Object.entries(TIERS) as [TierKey, typeof TIERS[TierKey]][]).map(([key, tier]) => {
          const Icon = tier.icon;
          const isCurrent = key === currentTier;

          return (
            <Card
              key={key}
              data-testid={`pricing-card-${key}`}
              className={`relative flex flex-col ${
                tier.popular ? 'border-primary shadow-lg scale-105' : ''
              } ${isCurrent ? 'ring-2 ring-primary/50' : ''}`}
            >
              {tier.popular && (
                <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 px-3">
                  Популярный
                </Badge>
              )}
              {isCurrent && (
                <Badge variant="secondary" className="absolute -top-3 right-4 px-3">
                  Текущий
                </Badge>
              )}

              <CardHeader className="text-center pb-2">
                <div className="mx-auto mb-4 p-3 rounded-full bg-primary/10 w-fit">
                  <Icon className="h-8 w-8 text-primary" />
                </div>
                <CardTitle className="text-2xl">{tier.name}</CardTitle>
                <CardDescription>
                  {(() => {
                    const displayPrice = key === 'freemium' ? 0
                      : userPrices ? userPrices[key as 'start' | 'pro']
                      : tier.price;
                    return (
                      <>
                        <span className="text-4xl font-bold text-foreground">
                          {displayPrice === 0 ? 'Бесплатно' : `${displayPrice.toLocaleString('ru-RU')} ₽`}
                        </span>
                        {tier.period && (
                          <span className="text-muted-foreground">{tier.period}</span>
                        )}
                      </>
                    );
                  })()}
                </CardDescription>
              </CardHeader>

              <CardContent className="flex-1">
                <ul className="space-y-3">
                  {tier.features.map((feature, index) => (
                    <li key={index} className="flex items-start gap-2">
                      <Check className="h-5 w-5 text-green-500 shrink-0 mt-0.5" />
                      <span className="text-sm">{feature}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>

              <CardFooter>
                <Button
                  data-testid={`select-${key}`}
                  className="w-full"
                  variant={tier.popular ? 'default' : 'outline'}
                  disabled={isCurrent || key === 'freemium'}
                  onClick={() => handleSelectTier(key)}
                >
                  {isCurrent ? 'Текущий тариф' : key === 'freemium' ? 'Бесплатно' : `Оформить ${tier.name}`}
                </Button>
              </CardFooter>
            </Card>
          );
        })}
      </div>

      {/* Agency tiers */}
      <div className="mt-16 max-w-5xl mx-auto" data-testid="agency-tiers-section">
        <div className="text-center mb-8">
          <h2 className="text-3xl font-bold mb-2">Для агентств</h2>
          <p className="text-muted-foreground text-lg">Управление 10+ кабинетов с командой менеджеров</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {AGENCY_TIERS.map((t) => (
            <AgencyTierCard
              key={t.code}
              name={t.name}
              price={t.price}
              includedLoadUnits={t.includedLoadUnits}
              overagePerUnit={t.overagePerUnit}
              features={t.features}
              recommended={t.recommended}
              onSelect={() => navigate(`/agency/onboarding?tier=${t.code}`)}
            />
          ))}
        </div>
      </div>

      <div className="mt-8 max-w-2xl mx-auto p-4 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 text-center">
        <p className="text-sm text-blue-800 dark:text-blue-200">
          🇷🇺 Для пользователей из России доступна оплата картами МИР
        </p>
      </div>

      <div className="mt-6 text-center text-sm text-muted-foreground">
        <p>Отмена подписки в любой момент.</p>
        <p className="mt-2">Вопросы? Напишите нам в Telegram: @Addpilot_bot</p>
      </div>

      {showPaymentModal && selectedTier && selectedTier !== 'freemium' && (
        <PaymentModal
          tier={selectedTier}
          tierInfo={{
            ...TIERS[selectedTier],
            price: userPrices ? userPrices[selectedTier as 'start' | 'pro'] : TIERS[selectedTier].price,
          }}
          onClose={() => setShowPaymentModal(false)}
          onSuccess={handlePaymentSuccess}
        />
      )}
    </div>
  );
}

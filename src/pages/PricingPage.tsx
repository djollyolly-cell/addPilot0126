import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Check, Crown, Zap, Sparkles, CheckCircle, XCircle } from 'lucide-react';
import { useAuth } from '@/lib/useAuth';
import { PaymentModal } from '@/components/PaymentModal';

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
    price: 990,
    period: "/мес",
    accountsLimit: 3,
    rulesLimit: 10,
    features: ["3 рекламных кабинета", "10 правил автоматизации", "Telegram-уведомления", "Базовая аналитика"],
    icon: Zap,
    popular: true,
  },
  pro: {
    name: "Pro",
    price: 2490,
    period: "/мес",
    accountsLimit: 10,
    rulesLimit: -1,
    features: ["10 рекламных кабинетов", "Неограниченные правила", "Приоритетная поддержка", "Расширенная аналитика"],
    icon: Crown,
    popular: false,
  },
} as const;

type TierKey = keyof typeof TIERS;

export function PricingPage() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedTier, setSelectedTier] = useState<TierKey | null>(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const currentTier = (user?.subscriptionTier || 'freemium') as TierKey;

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
                  <span className="text-4xl font-bold text-foreground">
                    {tier.price === 0 ? 'Бесплатно' : `${tier.price} ₽`}
                  </span>
                  {tier.period && (
                    <span className="text-muted-foreground">{tier.period}</span>
                  )}
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

      <div className="mt-12 text-center text-sm text-muted-foreground">
        <p>Все тарифы включают 7-дневный пробный период. Отмена в любой момент.</p>
        <p className="mt-2">Вопросы? Напишите нам в Telegram: @adpilot_support</p>
      </div>

      {showPaymentModal && selectedTier && selectedTier !== 'freemium' && (
        <PaymentModal
          tier={selectedTier}
          tierInfo={TIERS[selectedTier]}
          onClose={() => setShowPaymentModal(false)}
          onSuccess={handlePaymentSuccess}
        />
      )}
    </div>
  );
}

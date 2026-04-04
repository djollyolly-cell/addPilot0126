import { useState, useEffect } from 'react';
import { useAction, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { X, CreditCard, Lock, CheckCircle, AlertCircle, Loader2, ExternalLink, ChevronLeft, Tag } from 'lucide-react';
import { useAuth } from '@/lib/useAuth';
import { cn } from '@/lib/utils';

// Fallback BYN prices (used if exchange rate API fails)
const FALLBACK_BYN_PRICES = {
  start: 46,
  pro: 106,
} as const;

type Currency = 'RUB' | 'BYN';
type PaymentStep = 'select-country' | 'payment';

interface PaymentModalProps {
  tier: 'start' | 'pro';
  tierInfo: {
    name: string;
    price: number;
    features: readonly string[];
  };
  onClose: () => void;
  onSuccess: () => void;
}

// NBRB API response type
interface NBRBRateResponse {
  Cur_ID: number;
  Date: string;
  Cur_Abbreviation: string;
  Cur_Scale: number;
  Cur_Name: string;
  Cur_OfficialRate: number;
}

export function PaymentModal({ tier, tierInfo, onClose, onSuccess: _onSuccess }: PaymentModalProps) {
  const { user } = useAuth();
  const [step, setStep] = useState<PaymentStep>('select-country');
  const [currency, setCurrency] = useState<Currency | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bepaidLoading, setBepaidLoading] = useState(false);
  const [exchangeRate, setExchangeRate] = useState<{ rate: number; scale: number } | null>(null);
  const [rateLoading, setRateLoading] = useState(true);
  const [promoCode, setPromoCode] = useState('');
  const [promoApplied, setPromoApplied] = useState<{ bonusDays: number; description: string } | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);

  const createBepaidCheckout = useAction(api.billing.createBepaidCheckout);
  const upgradeInfo = useQuery(
    api.billing.getUpgradePrice,
    user?.userId ? { userId: user.userId as Id<"users">, newTier: tier } : "skip"
  );
  const promoValidation = useQuery(
    api.billing.validatePromoCode,
    promoCode.trim().length >= 3 ? { code: promoCode.trim() } : "skip"
  );

  // Fetch exchange rate from NBRB API on mount
  useEffect(() => {
    const fetchExchangeRate = async () => {
      try {
        // NBRB API for RUB exchange rate
        const response = await fetch('https://api.nbrb.by/exrates/rates/RUB?parammode=2');
        if (!response.ok) throw new Error('Failed to fetch rate');

        const data: NBRBRateResponse = await response.json();
        setExchangeRate({
          rate: data.Cur_OfficialRate,
          scale: data.Cur_Scale, // Usually 100 (rate is for 100 RUB)
        });
      } catch (err) {
        console.error('Failed to fetch NBRB exchange rate:', err);
        // Will use fallback prices
        setExchangeRate(null);
      } finally {
        setRateLoading(false);
      }
    };

    fetchExchangeRate();
  }, []);

  // Calculate BYN price from RUB using exchange rate
  const calculateBYNPrice = (rubPrice: number): number => {
    if (exchangeRate) {
      // Formula: RUB * (rate / scale) = BYN
      // e.g., 990 RUB * (3.5 / 100) = 34.65 BYN
      const bynPrice = rubPrice * (exchangeRate.rate / exchangeRate.scale);
      return Math.ceil(bynPrice); // Round up to nearest whole number
    }
    // Fallback to static prices
    return FALLBACK_BYN_PRICES[tier];
  };

  const priceRUB = tierInfo.price;
  const priceBYN = calculateBYNPrice(priceRUB);
  const price = currency === 'BYN' ? priceBYN : priceRUB;
  const currencySymbol = currency === 'BYN' ? 'BYN' : '₽';

  // Prorated upgrade calculation
  const isUpgrade = upgradeInfo?.isUpgrade === true;
  const upgradeCredit = upgradeInfo?.credit ?? 0;
  const upgradeCostBYN = isUpgrade
    ? Math.max(Math.ceil(priceBYN - upgradeCredit), 1)
    : priceBYN;
  const finalAmountBYN = isUpgrade ? upgradeCostBYN : priceBYN;

  const handleApplyPromo = () => {
    if (!promoCode.trim()) return;
    setPromoError(null);
    if (!promoValidation) {
      // Query still loading — shouldn't happen since button is disabled, but guard anyway
      setPromoError('Подождите, идёт проверка...');
      return;
    }
    if (promoValidation.valid) {
      setPromoApplied({ bonusDays: promoValidation.bonusDays!, description: promoValidation.description! });
      setPromoError(null);
    } else {
      setPromoError(promoValidation.error || 'Промокод недействителен');
      setPromoApplied(null);
    }
  };

  const handleSelectCountry = (selectedCurrency: Currency) => {
    // Both countries go through bePaid (BYN)
    setCurrency(selectedCurrency);
    setStep('payment');
    setError(null);
  };

  const handleBack = () => {
    setStep('select-country');
    setCurrency(null);
    setError(null);
  };

  // Handle bePaid checkout (for Belarus/BYN)
  const handleBepaidCheckout = async () => {
    if (!user?.userId) return;

    setBepaidLoading(true);
    setError(null);

    try {
      const returnUrl = `${window.location.origin}/pricing`;

      const result = await createBepaidCheckout({
        userId: user.userId as Id<"users">,
        tier,
        returnUrl,
        amountBYN: finalAmountBYN,
        promoCode: promoApplied ? promoCode.trim().toUpperCase() : undefined,
        isUpgrade: isUpgrade || undefined,
        creditAmount: isUpgrade ? upgradeCredit : undefined,
      });

      if (result.success && result.redirectUrl) {
        window.location.href = result.redirectUrl;
      } else {
        setError(result.error || 'Ошибка создания платежа');
      }
    } catch {
      setError('Произошла ошибка при создании платежа');
    } finally {
      setBepaidLoading(false);
    }
  };

  // Russian payments also go through bePaid (BYN conversion via NBRB rate)

  // Step 1: Country/Currency selection
  if (step === 'select-country') {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
        <Card className="w-full max-w-md" data-testid="payment-form">
          <CardHeader className="relative">
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-4 top-4"
              onClick={onClose}
              data-testid="close-payment"
            >
              <X className="h-4 w-4" />
            </Button>
            <CardTitle className="flex items-center gap-2">
              <CreditCard className="h-5 w-5" />
              Оплата тарифа {tierInfo.name}
            </CardTitle>
            <CardDescription>
              Выберите способ оплаты
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            {/* Features summary */}
            <div className="p-4 bg-muted rounded-lg space-y-2">
              <p className="font-medium">Что включено:</p>
              <ul className="text-sm text-muted-foreground space-y-1">
                {tierInfo.features.map((feature, i) => (
                  <li key={i}>• {feature}</li>
                ))}
              </ul>
            </div>

            {/* Country selection */}
            <div className="space-y-3">
              <p className="text-sm font-medium">Выберите страну:</p>

              {/* Russia option */}
              <button
                type="button"
                onClick={() => handleSelectCountry('RUB')}
                className={cn(
                  'w-full p-4 rounded-lg border-2 text-left transition-all hover:border-primary hover:bg-primary/5',
                  'flex items-center justify-between'
                )}
                data-testid="select-russia"
              >
                <div className="flex items-center gap-3">
                  <span className="text-2xl">🇷🇺</span>
                  <div>
                    <p className="font-medium">Россия</p>
                    <p className="text-sm text-muted-foreground">Российская карта</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="font-bold text-lg">{priceRUB} ₽</p>
                  <p className="text-xs text-muted-foreground">/месяц</p>
                </div>
              </button>

              {/* Belarus option */}
              <button
                type="button"
                onClick={() => handleSelectCountry('BYN')}
                disabled={rateLoading}
                className={cn(
                  'w-full p-4 rounded-lg border-2 text-left transition-all hover:border-primary hover:bg-primary/5',
                  'flex items-center justify-between',
                  rateLoading && 'opacity-70'
                )}
                data-testid="select-belarus"
              >
                <div className="flex items-center gap-3">
                  <span className="text-2xl">🇧🇾</span>
                  <div>
                    <p className="font-medium">Беларусь</p>
                    <p className="text-sm text-muted-foreground">Карта любого банка</p>
                  </div>
                </div>
                <div className="text-right">
                  {rateLoading ? (
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  ) : (
                    <>
                      <p className="font-bold text-lg">{priceBYN} BYN</p>
                      <p className="text-xs text-muted-foreground">/месяц</p>
                    </>
                  )}
                </div>
              </button>

              {/* Exchange rate info */}
              {!rateLoading && exchangeRate && (
                <p className="text-xs text-center text-muted-foreground">
                  Курс НБРБ: {exchangeRate.scale} RUB = {exchangeRate.rate.toFixed(4)} BYN
                </p>
              )}
            </div>
          </CardContent>

          <CardFooter>
            <p className="text-xs text-center text-muted-foreground w-full">
              Безопасная оплата. Данные карты не хранятся на нашем сервере.
            </p>
          </CardFooter>
        </Card>
      </div>
    );
  }

  // Step 2: Payment form
  // Belarus (BYN) - bePaid redirect
  if (currency === 'BYN') {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
        <Card className="w-full max-w-md" data-testid="payment-form">
          <CardHeader className="relative">
            <Button
              variant="ghost"
              size="icon"
              className="absolute left-4 top-4"
              onClick={handleBack}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-4 top-4"
              onClick={onClose}
              data-testid="close-payment"
            >
              <X className="h-4 w-4" />
            </Button>
            <CardTitle className="flex items-center gap-2 pl-8">
              <CreditCard className="h-5 w-5" />
              Оплата тарифа {tierInfo.name}
            </CardTitle>
            <CardDescription className="pl-8">
              {isUpgrade ? `${upgradeCostBYN} BYN (доплата)` : `${price} ${currencySymbol}/месяц`} • 🇧🇾 Беларусь
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            {error && (
              <div className="flex items-center gap-2 p-3 bg-destructive/10 text-destructive rounded-lg" data-testid="payment-error">
                <AlertCircle className="h-4 w-4" />
                <span className="text-sm">{error}</span>
              </div>
            )}

            <div className="p-4 bg-muted rounded-lg space-y-2">
              <p className="font-medium">Что включено:</p>
              <ul className="text-sm text-muted-foreground space-y-1">
                {tierInfo.features.map((feature, i) => (
                  <li key={i}>• {feature}</li>
                ))}
              </ul>
            </div>

            {/* Upgrade credit info */}
            {isUpgrade && (
              <div className="p-4 bg-green-500/10 rounded-lg space-y-1 text-sm" data-testid="upgrade-credit-info">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Кредит за остаток ({upgradeInfo?.remainingDays} дн.)</span>
                  <span className="text-green-700 dark:text-green-400 font-medium">−{upgradeCredit.toFixed(2)} BYN</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Стоимость {tierInfo.name}</span>
                  <span>{priceBYN} BYN</span>
                </div>
                <div className="flex justify-between font-bold border-t border-border pt-1 mt-1">
                  <span>К оплате</span>
                  <span>{upgradeCostBYN} BYN</span>
                </div>
              </div>
            )}

            {/* Промокод */}
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5 text-sm">
                <Tag className="h-3.5 w-3.5" />
                Промокод
              </Label>
              <div className="flex gap-2">
                <Input
                  placeholder="Введите промокод"
                  value={promoCode}
                  onChange={(e) => {
                    setPromoCode(e.target.value.toUpperCase());
                    setPromoApplied(null);
                    setPromoError(null);
                  }}
                  disabled={!!promoApplied}
                  data-testid="promo-input"
                />
                {promoApplied ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => {
                      setPromoCode('');
                      setPromoApplied(null);
                      setPromoError(null);
                    }}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={handleApplyPromo}
                    disabled={promoCode.trim().length < 3 || promoValidation === undefined}
                    data-testid="promo-apply"
                  >
                    {promoValidation === undefined && promoCode.trim().length >= 3
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : 'Применить'}
                  </Button>
                )}
              </div>
              {promoApplied && (
                <div className="flex items-center gap-2 p-2 rounded-md bg-green-500/10 text-green-700 dark:text-green-400 text-sm">
                  <CheckCircle className="h-4 w-4 shrink-0" />
                  <span>+{promoApplied.bonusDays} дней бонус: {promoApplied.description}</span>
                </div>
              )}
              {promoError && (
                <p className="text-sm text-destructive">{promoError}</p>
              )}
            </div>

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Lock className="h-3 w-3" />
              <span>Безопасная оплата через bePaid</span>
            </div>
          </CardContent>

          <CardFooter className="flex flex-col gap-3">
            <Button
              className="w-full"
              disabled={bepaidLoading}
              onClick={handleBepaidCheckout}
              data-testid="submit-payment"
            >
              {bepaidLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Загрузка...
                </>
              ) : (
                <>
                  <ExternalLink className="h-4 w-4 mr-2" />
                  Перейти к оплате {finalAmountBYN} BYN
                  {promoApplied && ` + ${promoApplied.bonusDays} дней`}
                </>
              )}
            </Button>
            <p className="text-xs text-center text-muted-foreground">
              Вы будете перенаправлены на защищённую страницу оплаты bePaid
            </p>
          </CardFooter>
        </Card>
      </div>
    );
  }

  // Russia (RUB) — also goes through bePaid with BYN conversion
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <Card className="w-full max-w-md" data-testid="payment-form">
        <CardHeader className="relative">
          <Button
            variant="ghost"
            size="icon"
            className="absolute left-4 top-4"
            onClick={handleBack}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-4 top-4"
            onClick={onClose}
            data-testid="close-payment"
          >
            <X className="h-4 w-4" />
          </Button>
          <CardTitle className="flex items-center gap-2 pl-8">
            <CreditCard className="h-5 w-5" />
            Оплата тарифа {tierInfo.name}
          </CardTitle>
          <CardDescription className="pl-8">
            {priceRUB} ₽/месяц • 🇷🇺 Россия
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {error && (
            <div className="flex items-center gap-2 p-3 bg-destructive/10 text-destructive rounded-lg" data-testid="payment-error">
              <AlertCircle className="h-4 w-4" />
              <span className="text-sm">{error}</span>
            </div>
          )}

          <div className="p-4 bg-muted rounded-lg space-y-2">
            <p className="font-medium">Что включено:</p>
            <ul className="text-sm text-muted-foreground space-y-1">
              {tierInfo.features.map((feature, i) => (
                <li key={i}>• {feature}</li>
              ))}
            </ul>
          </div>

          <div className="p-3 bg-blue-500/10 text-blue-700 dark:text-blue-400 rounded-lg text-sm">
            <p>Оплата проходит через платёжную систему bePaid.</p>
            <p className="mt-1">Сумма к оплате: <strong>{finalAmountBYN} BYN</strong> (≈ {priceRUB} ₽ по курсу НБРБ)</p>
          </div>

          {/* Upgrade credit info */}
          {isUpgrade && (
            <div className="p-4 bg-green-500/10 rounded-lg space-y-1 text-sm" data-testid="upgrade-credit-info">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Кредит за остаток ({upgradeInfo?.remainingDays} дн.)</span>
                <span className="text-green-700 dark:text-green-400 font-medium">−{upgradeCredit.toFixed(2)} BYN</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Стоимость {tierInfo.name}</span>
                <span>{priceBYN} BYN</span>
              </div>
              <div className="flex justify-between font-bold border-t border-border pt-1 mt-1">
                <span>К оплате</span>
                <span>{upgradeCostBYN} BYN</span>
              </div>
            </div>
          )}

          {/* Промокод */}
          <div className="space-y-2">
            <Label className="flex items-center gap-1.5 text-sm">
              <Tag className="h-3.5 w-3.5" />
              Промокод
            </Label>
            <div className="flex gap-2">
              <Input
                placeholder="Введите промокод"
                value={promoCode}
                onChange={(e) => {
                  setPromoCode(e.target.value.toUpperCase());
                  setPromoApplied(null);
                  setPromoError(null);
                }}
                disabled={!!promoApplied}
                data-testid="promo-input"
              />
              {promoApplied ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => {
                    setPromoCode('');
                    setPromoApplied(null);
                    setPromoError(null);
                  }}
                >
                  <X className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={handleApplyPromo}
                  disabled={promoCode.trim().length < 3 || promoValidation === undefined}
                  data-testid="promo-apply"
                >
                  {promoValidation === undefined && promoCode.trim().length >= 3
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : 'Применить'}
                </Button>
              )}
            </div>
            {promoApplied && (
              <div className="flex items-center gap-2 p-2 rounded-md bg-green-500/10 text-green-700 dark:text-green-400 text-sm">
                <CheckCircle className="h-4 w-4 shrink-0" />
                <span>+{promoApplied.bonusDays} дней бонус: {promoApplied.description}</span>
              </div>
            )}
            {promoError && (
              <p className="text-sm text-destructive">{promoError}</p>
            )}
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Lock className="h-3 w-3" />
            <span>Безопасная оплата через bePaid</span>
          </div>
        </CardContent>

        <CardFooter className="flex flex-col gap-3">
          <Button
            className="w-full"
            disabled={bepaidLoading}
            onClick={handleBepaidCheckout}
            data-testid="submit-payment"
          >
            {bepaidLoading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Загрузка...
              </>
            ) : (
              <>
                <ExternalLink className="h-4 w-4 mr-2" />
                Перейти к оплате {finalAmountBYN} BYN
                {promoApplied && ` + ${promoApplied.bonusDays} дней`}
              </>
            )}
          </Button>
          <p className="text-xs text-center text-muted-foreground">
            Вы будете перенаправлены на защищённую страницу оплаты bePaid
          </p>
        </CardFooter>
      </Card>
    </div>
  );
}

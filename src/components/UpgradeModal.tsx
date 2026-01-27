import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';
import { X, Zap, Check } from 'lucide-react';
import { cn } from '../lib/utils';

interface UpgradeModalProps {
  currentTier: 'freemium' | 'start' | 'pro';
  limitType: 'accounts' | 'rules';
  currentUsage: number;
  limit: number;
  onClose: () => void;
  onUpgrade: (tier: 'start' | 'pro') => void;
}

const TIER_INFO = {
  freemium: {
    label: 'Freemium',
    accounts: 1,
    rules: 2,
    autoStop: false,
  },
  start: {
    label: 'Start',
    accounts: 3,
    rules: 10,
    autoStop: true,
  },
  pro: {
    label: 'Pro',
    accounts: '∞',
    rules: '∞',
    autoStop: true,
  },
} as const;

export function UpgradeModal({
  currentTier,
  limitType,
  currentUsage,
  limit,
  onClose,
  onUpgrade,
}: UpgradeModalProps) {
  const limitLabel = limitType === 'accounts' ? 'кабинетов' : 'правил';
  const nextTier = currentTier === 'freemium' ? 'start' : 'pro';
  const nextTierInfo = TIER_INFO[nextTier];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="upgrade-modal"
    >
      <Card className="w-full max-w-md mx-4 relative">
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 text-muted-foreground hover:text-foreground"
        >
          <X className="w-5 h-5" />
        </button>

        <CardHeader className="text-center">
          <div className="mx-auto w-12 h-12 rounded-full bg-warning/10 flex items-center justify-center mb-2">
            <Zap className="w-6 h-6 text-warning" />
          </div>
          <CardTitle>Лимит {limitLabel} исчерпан</CardTitle>
          <CardDescription>
            Вы используете {currentUsage} из {limit} {limitLabel} на тарифе{' '}
            <strong>{TIER_INFO[currentTier].label}</strong>
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Tier comparison */}
          <div className="grid grid-cols-2 gap-3">
            {/* Current tier */}
            <div className="p-3 rounded-lg border border-border bg-muted/30">
              <p className="text-xs text-muted-foreground mb-1">Текущий тариф</p>
              <p className="font-semibold text-sm">{TIER_INFO[currentTier].label}</p>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                <li>{TIER_INFO[currentTier].accounts} {limitType === 'accounts' ? 'кабинет' : ''}</li>
                <li>{TIER_INFO[currentTier].rules} правил</li>
                <li>{TIER_INFO[currentTier].autoStop ? 'Авто-стоп' : 'Без авто-стопа'}</li>
              </ul>
            </div>

            {/* Next tier */}
            <div className="p-3 rounded-lg border-2 border-primary bg-primary/5">
              <p className="text-xs text-primary mb-1">Рекомендуемый</p>
              <p className="font-semibold text-sm">{nextTierInfo.label}</p>
              <ul className="mt-2 space-y-1 text-xs">
                <li className="flex items-center gap-1">
                  <Check className="w-3 h-3 text-primary" />
                  {nextTierInfo.accounts} кабинетов
                </li>
                <li className="flex items-center gap-1">
                  <Check className="w-3 h-3 text-primary" />
                  {nextTierInfo.rules} правил
                </li>
                <li className="flex items-center gap-1">
                  <Check className="w-3 h-3 text-primary" />
                  Авто-стоп
                </li>
              </ul>
            </div>
          </div>

          {/* Upgrade button */}
          <button
            type="button"
            onClick={() => onUpgrade(nextTier)}
            className={cn(
              'w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-sm transition-all',
              'bg-primary text-primary-foreground hover:bg-primary/90'
            )}
            data-testid="upgrade-button"
          >
            <Zap className="w-4 h-4" />
            Перейти на {nextTierInfo.label}
          </button>

          <button
            type="button"
            onClick={onClose}
            className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Остаться на {TIER_INFO[currentTier].label}
          </button>
        </CardContent>
      </Card>
    </div>
  );
}

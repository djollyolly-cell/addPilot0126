import { cn } from '../lib/utils';
import { Bell, StopCircle, BellRing } from 'lucide-react';

export type ActionMode = 'notify_only' | 'stop_only' | 'stop_and_notify';

interface ActionRadioProps {
  value: ActionMode;
  onChange: (mode: ActionMode) => void;
  isFreemium: boolean;
}

const ACTION_OPTIONS: Array<{
  mode: ActionMode;
  label: string;
  description: string;
  icon: typeof Bell;
  requiresPaid: boolean;
}> = [
  {
    mode: 'notify_only',
    label: 'Только уведомить',
    description: 'Отправить уведомление при срабатывании',
    icon: Bell,
    requiresPaid: false,
  },
  {
    mode: 'stop_only',
    label: 'Остановить',
    description: 'Автоматически остановить объявление',
    icon: StopCircle,
    requiresPaid: true,
  },
  {
    mode: 'stop_and_notify',
    label: 'Остановить и уведомить',
    description: 'Остановить + отправить уведомление',
    icon: BellRing,
    requiresPaid: true,
  },
];

export function actionModeToFlags(mode: ActionMode): { stopAd: boolean; notify: boolean } {
  switch (mode) {
    case 'notify_only':
      return { stopAd: false, notify: true };
    case 'stop_only':
      return { stopAd: true, notify: false };
    case 'stop_and_notify':
      return { stopAd: true, notify: true };
  }
}

export function flagsToActionMode(stopAd: boolean, notify: boolean): ActionMode {
  if (stopAd && notify) return 'stop_and_notify';
  if (stopAd) return 'stop_only';
  return 'notify_only';
}

export function ActionRadio({ value, onChange, isFreemium }: ActionRadioProps) {
  return (
    <div data-testid="action-radio" className="space-y-2">
      {ACTION_OPTIONS.map((option) => {
        const isDisabled = isFreemium && option.requiresPaid;
        const isSelected = value === option.mode;
        const Icon = option.icon;

        return (
          <label
            key={option.mode}
            className={cn(
              'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
              isSelected && !isDisabled && 'border-primary bg-primary/5',
              !isSelected && !isDisabled && 'border-border hover:bg-muted/50',
              isDisabled && 'border-border/50 opacity-50 cursor-not-allowed',
            )}
            title={isDisabled ? 'Недоступно на тарифе Freemium. Перейдите на Start или Pro.' : undefined}
            data-testid={`action-option-${option.mode}`}
          >
            <input
              type="radio"
              name="action-mode"
              value={option.mode}
              checked={isSelected}
              disabled={isDisabled}
              onChange={() => onChange(option.mode)}
              className="mt-0.5 shrink-0"
            />
            <Icon className={cn(
              'w-4 h-4 mt-0.5 shrink-0',
              isSelected && !isDisabled ? 'text-primary' : 'text-muted-foreground',
            )} />
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {option.label}
                {isDisabled && (
                  <span className="ml-1.5 text-[10px] text-muted-foreground font-normal">
                    (Start / Pro)
                  </span>
                )}
              </p>
              <p className="text-xs text-muted-foreground">{option.description}</p>
            </div>
          </label>
        );
      })}
    </div>
  );
}

import { cn } from '@/lib/utils';

interface AiScoreBadgeProps {
  score: number;
  label?: string;
  className?: string;
}

export function AiScoreBadge({ score, label, className }: AiScoreBadgeProps) {
  const getVariant = () => {
    if (score >= 81) return { bg: 'bg-primary/10 text-primary', text: label || 'Отлично' };
    if (score >= 61) return { bg: 'bg-green-500/10 text-green-600 dark:text-green-400', text: label || 'Хорошо' };
    if (score >= 41) return { bg: 'bg-amber-500/10 text-amber-600 dark:text-amber-400', text: label || 'Средне' };
    return { bg: 'bg-destructive/10 text-destructive', text: label || 'Плохо' };
  };

  const variant = getVariant();

  return (
    <div className={cn('inline-flex items-center gap-2', className)}>
      <span className={cn('px-2 py-0.5 rounded-md text-xs font-medium', variant.bg)}>
        {variant.text}
      </span>
      <span className="text-sm text-muted-foreground">
        Оценка: {score}/100
      </span>
    </div>
  );
}

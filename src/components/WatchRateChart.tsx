import { cn } from '@/lib/utils';

interface WatchRateChartProps {
  videoStarted: number;
  viewed3s?: number;
  p25: number;
  p50: number;
  p75: number;
  p100: number;
}

export function WatchRateChart({ videoStarted, viewed3s, p25, p50, p75, p100 }: WatchRateChartProps) {
  if (videoStarted === 0) return null;

  const pct = (val: number) => Math.round((val / videoStarted) * 100);

  const rates = [
    { label: 'Старт', value: videoStarted, pct: 100 },
    ...(viewed3s !== undefined ? [{ label: '3 сек', value: viewed3s, pct: pct(viewed3s) }] : []),
    { label: '25%', value: p25, pct: pct(p25) },
    { label: '50%', value: p50, pct: pct(p50) },
    { label: '75%', value: p75, pct: pct(p75) },
    { label: '100%', value: p100, pct: pct(p100) },
  ];

  const getColor = (val: number, idx: number) => {
    if (idx === 0) return 'bg-primary';
    if (val >= 50) return 'bg-green-500';
    if (val >= 25) return 'bg-amber-500';
    return 'bg-destructive';
  };

  return (
    <div className="space-y-2" data-testid="watch-rate-chart">
      <p className="text-sm font-medium">Воронка досмотров</p>
      <div className="space-y-1.5">
        {rates.map((rate, i) => (
          <div key={rate.label} className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-10 text-right shrink-0">
              {rate.label}
            </span>
            <div className="flex-1 h-5 bg-muted rounded-full overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all', getColor(rate.pct, i))}
                style={{ width: `${rate.pct}%` }}
              />
            </div>
            <span className="text-xs font-medium w-10 shrink-0">
              {rate.pct}%
            </span>
            <span className="text-xs text-muted-foreground w-16 shrink-0 hidden sm:block">
              {rate.value.toLocaleString('ru-RU')}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { cn } from '../lib/utils';

interface SyncButtonProps {
  onSync: () => Promise<void>;
  lastSyncAt?: number;
  disabled?: boolean;
  className?: string;
}

export function SyncButton({ onSync, lastSyncAt, disabled, className }: SyncButtonProps) {
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  const handleSync = async () => {
    setIsSyncing(true);
    setSyncError(null);
    try {
      await onSync();
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : 'Ошибка синхронизации');
    } finally {
      setIsSyncing(false);
    }
  };

  const formatLastSync = (timestamp: number) => {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'только что';
    if (minutes < 60) return `${minutes} мин. назад`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} ч. назад`;
    return new Date(timestamp).toLocaleDateString('ru-RU');
  };

  return (
    <div className={cn('flex items-center gap-2', className)} data-testid="sync-button">
      <button
        type="button"
        onClick={handleSync}
        disabled={disabled || isSyncing}
        className={cn(
          'inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all',
          'bg-primary/10 text-primary hover:bg-primary/20',
          'disabled:opacity-50 disabled:cursor-not-allowed'
        )}
        data-testid="sync-trigger"
      >
        <RefreshCw
          className={cn('h-4 w-4', isSyncing && 'animate-spin')}
        />
        {isSyncing ? 'Синхронизация...' : 'Синхронизировать'}
      </button>
      {lastSyncAt && !isSyncing && (
        <span className="text-xs text-muted-foreground" data-testid="sync-last-time">
          {formatLastSync(lastSyncAt)}
        </span>
      )}
      {syncError && (
        <span className="text-xs text-destructive" data-testid="sync-error">
          {syncError}
        </span>
      )}
    </div>
  );
}

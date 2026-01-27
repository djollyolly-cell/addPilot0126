import { Building2, AlertTriangle, CheckCircle2, PauseCircle, Trash2 } from 'lucide-react';
import { Card, CardContent } from './ui/card';
import { SyncButton } from './SyncButton';
import { cn } from '../lib/utils';

interface AccountCardProps {
  account: {
    _id: string;
    vkAccountId: string;
    name: string;
    status: 'active' | 'paused' | 'error';
    lastSyncAt?: number;
    lastError?: string;
  };
  onSync: (accountId: string) => Promise<void>;
  onDisconnect: (accountId: string) => void;
}

const statusConfig = {
  active: {
    icon: CheckCircle2,
    label: 'Активен',
    color: 'text-green-600',
    bg: 'bg-green-50',
  },
  paused: {
    icon: PauseCircle,
    label: 'Приостановлен',
    color: 'text-yellow-600',
    bg: 'bg-yellow-50',
  },
  error: {
    icon: AlertTriangle,
    label: 'Ошибка',
    color: 'text-destructive',
    bg: 'bg-destructive/10',
  },
};

export function AccountCard({ account, onSync, onDisconnect }: AccountCardProps) {
  const status = statusConfig[account.status];
  const StatusIcon = status.icon;

  return (
    <Card data-testid="account-card" data-account-id={account.vkAccountId}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          {/* Account info */}
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Building2 className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h3 className="font-medium text-sm truncate" data-testid="account-name">
                {account.name}
              </h3>
              <p className="text-xs text-muted-foreground">
                ID: {account.vkAccountId}
              </p>
              <div className={cn('inline-flex items-center gap-1 mt-1 px-2 py-0.5 rounded-full text-xs', status.bg, status.color)}>
                <StatusIcon className="w-3 h-3" />
                {status.label}
              </div>
              {account.status === 'error' && account.lastError && (
                <p className="text-xs text-destructive mt-1" data-testid="account-error">
                  {account.lastError}
                </p>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => onDisconnect(account._id)}
              className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              title="Отключить кабинет"
              data-testid="disconnect-button"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Sync */}
        <div className="mt-3 pt-3 border-t">
          <SyncButton
            onSync={() => onSync(account._id)}
            lastSyncAt={account.lastSyncAt}
          />
        </div>
      </CardContent>
    </Card>
  );
}

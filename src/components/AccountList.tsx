import { AccountCard } from './AccountCard';
import { FolderOpen } from 'lucide-react';

interface Account {
  _id: string;
  vkAccountId: string;
  name: string;
  status: 'active' | 'paused' | 'error';
  lastSyncAt?: number;
  lastError?: string;
}

interface AccountListProps {
  accounts: Account[];
  onSync: (accountId: string) => Promise<void>;
  onDisconnect: (accountId: string) => void;
}

export function AccountList({ accounts, onSync, onDisconnect }: AccountListProps) {
  if (accounts.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center py-12 text-center"
        data-testid="empty-accounts"
      >
        <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
          <FolderOpen className="w-8 h-8 text-muted-foreground" />
        </div>
        <h3 className="font-medium text-foreground mb-1">Нет подключённых кабинетов</h3>
        <p className="text-sm text-muted-foreground max-w-sm">
          Подключите рекламный кабинет VK, чтобы начать мониторинг и автоматизацию.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="account-list">
      {accounts.map((account) => (
        <AccountCard
          key={account._id}
          account={account}
          onSync={onSync}
          onDisconnect={onDisconnect}
        />
      ))}
    </div>
  );
}

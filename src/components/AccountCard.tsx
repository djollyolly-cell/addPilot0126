import { useState, memo } from 'react';
import { Building2, AlertTriangle, CheckCircle2, PauseCircle, Loader2, Trash2, ChevronDown, ChevronRight, Pencil, Check, X, XCircle, VolumeX, RotateCcw, Play } from 'lucide-react';
import { useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';
import { Card, CardContent } from './ui/card';
import { SyncButton } from './SyncButton';
import { CampaignList } from './CampaignList';
import { BusinessProfileEditor } from './BusinessProfileEditor';
import { cn } from '../lib/utils';
import { DisconnectDialog } from './DisconnectDialog';

interface AccountCardProps {
  account: {
    _id: string;
    vkAccountId: string;
    name: string;
    status: 'active' | 'paused' | 'error' | 'deleting' | 'abandoned';
    lastSyncAt?: number;
    lastError?: string;
    mtAdvertiserId?: string;
    agencyProviderId?: string;
  };
  userId: string;
  onSync: (accountId: string) => Promise<void>;
  onDisconnect: (accountId: string) => void;
  onActivated?: (message: string) => void;
  onActivationError?: (message: string) => void;
  isAdmin?: boolean;
  sessionToken?: string;
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
  deleting: {
    icon: Loader2,
    label: 'Удаляется...',
    color: 'text-muted-foreground',
    bg: 'bg-muted/50',
  },
  abandoned: {
    icon: XCircle,
    label: 'Требует переподключения',
    color: 'text-muted-foreground',
    bg: 'bg-muted/50',
  },
};

export const AccountCard = memo(function AccountCard({ account, userId, onSync, onDisconnect, onActivated, onActivationError, isAdmin, sessionToken }: AccountCardProps) {
  const [showCampaigns, setShowCampaigns] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [advId, setAdvId] = useState(account.mtAdvertiserId || '');
  const [advSaving, setAdvSaving] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState(account.name);
  const [nameSaving, setNameSaving] = useState(false);
  const setAdvertiserId = useMutation(api.videos.setAdvertiserId);
  const renameAccount = useMutation(api.adAccounts.rename);
  const abandonAccount = useMutation(api.admin.abandonAccount);
  const reactivateAccount = useMutation(api.admin.reactivateAccount);
  const activateAccount = useMutation(api.adAccounts.activate);
  const [adminAction, setAdminAction] = useState(false);
  const [activating, setActivating] = useState(false);

  const handleSaveName = async () => {
    const trimmed = editName.trim();
    if (!trimmed || trimmed === account.name) {
      setEditName(account.name);
      setIsEditingName(false);
      return;
    }
    setNameSaving(true);
    try {
      await renameAccount({
        accountId: account._id as Id<"adAccounts">,
        userId: userId as Id<"users">,
        name: trimmed,
      });
      setIsEditingName(false);
    } catch {
      setEditName(account.name);
    } finally {
      setNameSaving(false);
    }
  };

  const handleCancelName = () => {
    setEditName(account.name);
    setIsEditingName(false);
  };
  const status = statusConfig[account.status];
  const StatusIcon = status.icon;

  return (
    <Card data-testid="account-card" data-account-id={account.vkAccountId} className={cn(account.status === 'deleting' && 'opacity-60 pointer-events-none', account.status === 'abandoned' && 'opacity-75')}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          {/* Account info */}
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Building2 className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0">
              {isEditingName ? (
                <div className="flex items-center gap-1" data-testid="account-name-edit">
                  <input
                    type="text"
                    className="h-7 px-2 text-sm font-medium rounded border border-primary bg-background w-48"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveName();
                      if (e.key === 'Escape') handleCancelName();
                    }}
                    onClick={(e) => e.stopPropagation()}
                    disabled={nameSaving}
                    autoFocus
                    data-testid="account-name-input"
                  />
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleSaveName(); }}
                    disabled={nameSaving}
                    className="p-1 rounded text-green-600 hover:bg-green-50 transition-colors disabled:opacity-50"
                    title="Сохранить"
                  >
                    <Check className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleCancelName(); }}
                    className="p-1 rounded text-muted-foreground hover:bg-muted transition-colors"
                    title="Отменить"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5" data-testid="account-name">
                  <h3 className="font-medium text-sm truncate">{account.name}</h3>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setEditName(account.name); setIsEditingName(true); }}
                    className="p-0.5 rounded text-muted-foreground hover:text-primary transition-colors"
                    title="Переименовать"
                    data-testid="rename-button"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                ID: {account.vkAccountId}
              </p>
              <div className="flex items-center gap-1.5 mt-1">
                <span className="text-xs text-muted-foreground whitespace-nowrap">Advertiser ID:</span>
                <input
                  type="text"
                  placeholder="из VK Ads"
                  className="h-6 w-24 px-1.5 text-xs rounded border border-border bg-background"
                  value={advId}
                  onChange={(e) => setAdvId(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  data-testid="mt-advertiser-id"
                />
                {advId && advId !== (account.mtAdvertiserId || '') && (
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline disabled:opacity-50"
                    disabled={advSaving}
                    onClick={async (e) => {
                      e.stopPropagation();
                      setAdvSaving(true);
                      try {
                        await setAdvertiserId({
                          accountId: account._id as Id<"adAccounts">,
                          mtAdvertiserId: advId.trim(),
                        });
                      } finally {
                        setAdvSaving(false);
                      }
                    }}
                  >
                    {advSaving ? '...' : 'Сохранить'}
                  </button>
                )}
                {account.mtAdvertiserId && (
                  <CheckCircle2 className="w-3 h-3 text-green-600" />
                )}
              </div>
              <div className={cn('inline-flex items-center gap-1 mt-1 px-2 py-0.5 rounded-full text-xs', status.bg, status.color)}>
                <StatusIcon className={cn("w-3 h-3", account.status === 'deleting' && 'animate-spin')} />
                {status.label}
              </div>
              {account.status === 'error' && account.lastError && (
                <p className="text-xs text-destructive mt-1" data-testid="account-error">
                  {account.lastError}
                </p>
              )}
              {account.status === 'abandoned' && (
                <p className="text-xs text-muted-foreground mt-1" data-testid="account-abandoned-message">
                  Токен недействителен более 7 дней. Переподключите кабинет.
                </p>
              )}
            </div>
          </div>

          {/* Actions */}
          {account.status !== 'deleting' && (
            <div className="flex items-center gap-1 shrink-0">
              {/* Admin: Заглушить error → abandoned */}
              {isAdmin && sessionToken && account.status === 'error' && (
                <button
                  type="button"
                  disabled={adminAction}
                  onClick={async (e) => {
                    e.stopPropagation();
                    setAdminAction(true);
                    try {
                      await abandonAccount({ sessionToken, accountId: account._id as Id<"adAccounts"> });
                    } finally { setAdminAction(false); }
                  }}
                  className="p-1.5 rounded-md text-muted-foreground hover:text-orange-600 hover:bg-orange-50 transition-colors disabled:opacity-50"
                  title="Заглушить (abandoned)"
                  data-testid="abandon-button"
                >
                  <VolumeX className="w-4 h-4" />
                </button>
              )}
              {/* Admin: Вернуть abandoned → error */}
              {isAdmin && sessionToken && account.status === 'abandoned' && (
                <button
                  type="button"
                  disabled={adminAction}
                  onClick={async (e) => {
                    e.stopPropagation();
                    setAdminAction(true);
                    try {
                      await reactivateAccount({ sessionToken, accountId: account._id as Id<"adAccounts"> });
                    } finally { setAdminAction(false); }
                  }}
                  className="p-1.5 rounded-md text-muted-foreground hover:text-green-600 hover:bg-green-50 transition-colors disabled:opacity-50"
                  title="Вернуть в error"
                  data-testid="reactivate-button"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>
              )}
              {/* Восстановить paused → active (manual fallback после auto-reactivation) */}
              {account.status === 'paused' && (
                <button
                  type="button"
                  disabled={activating}
                  onClick={async (e) => {
                    e.stopPropagation();
                    setActivating(true);
                    try {
                      await activateAccount({
                        accountId: account._id as Id<"adAccounts">,
                        userId: userId as Id<"users">,
                      });
                      onActivated?.('Кабинет активирован. Данные обновятся в течение 5 минут.');
                    } catch (err) {
                      const msg = err instanceof Error ? err.message : 'Ошибка активации';
                      onActivationError?.(msg);
                    } finally {
                      setActivating(false);
                    }
                  }}
                  className="p-1.5 rounded-md text-muted-foreground hover:text-green-600 hover:bg-green-50 transition-colors disabled:opacity-50"
                  title="Активировать кабинет"
                  data-testid={`activate-account-${account.vkAccountId}`}
                >
                  {activating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowDisconnectConfirm(true)}
                className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                title="Отключить кабинет"
                data-testid="disconnect-button"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

        <DisconnectDialog
          open={showDisconnectConfirm}
          onOpenChange={setShowDisconnectConfirm}
          accountName={account.name}
          isAgency={!!account.agencyProviderId}
          onConfirm={() => { setShowDisconnectConfirm(false); onDisconnect(account._id); }}
        />

        {/* Sync — скрыт для paused (sync на paused упрётся в updateStatus guard,
            юзеру нужна кнопка «Активировать») и abandoned (требуется переподключение). */}
        {account.status !== 'abandoned' && account.status !== 'paused' && (
          <div className="mt-3 pt-3 border-t">
            <SyncButton
              onSync={() => onSync(account._id)}
              lastSyncAt={account.lastSyncAt}
            />
          </div>
        )}

        {/* Campaigns toggle */}
        <div className="mt-3 pt-3 border-t">
          <button
            type="button"
            onClick={() => setShowCampaigns(!showCampaigns)}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            data-testid="toggle-campaigns"
          >
            {showCampaigns ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
            Кампании
          </button>
          {showCampaigns && (
            <div className="mt-2">
              <CampaignList accountId={account._id} />
            </div>
          )}
        </div>

        {/* Business profile toggle */}
        <div className="mt-3 pt-3 border-t">
          <button
            type="button"
            onClick={() => setShowProfile(!showProfile)}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            data-testid="toggle-profile"
          >
            {showProfile ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
            Профиль бизнеса
          </button>
          {showProfile && (
            <div className="mt-3">
              <BusinessProfileEditor accountId={account._id} userId={userId} />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
});

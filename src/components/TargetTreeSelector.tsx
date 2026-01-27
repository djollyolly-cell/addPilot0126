import { useState, useCallback } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';
import { ChevronDown, ChevronRight, Loader2, Monitor, Megaphone, ImageIcon } from 'lucide-react';
import { cn } from '../lib/utils';

export interface TargetSelection {
  accountIds: string[];
  campaignIds: string[];
  adIds: string[];
}

interface TargetTreeSelectorProps {
  userId: string;
  value: TargetSelection;
  onChange: (selection: TargetSelection) => void;
}

export function TargetTreeSelector({ userId, value, onChange }: TargetTreeSelectorProps) {
  const accounts = useQuery(
    api.adAccounts.list,
    { userId: userId as Id<"users"> }
  );

  if (accounts === undefined) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-3 text-center">
        Нет подключённых кабинетов
      </p>
    );
  }

  return (
    <div data-testid="target-tree" className="border rounded-lg p-3 space-y-1 max-h-72 overflow-y-auto">
      {accounts.map((account) => (
        <AccountNode
          key={account._id}
          account={account}
          value={value}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

// ─── Account-level node ──────────────────────────────

interface AccountNodeProps {
  account: { _id: string; name: string };
  value: TargetSelection;
  onChange: (selection: TargetSelection) => void;
}

function AccountNode({ account, value, onChange }: AccountNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const isChecked = value.accountIds.includes(account._id);

  const campaigns = useQuery(
    api.adAccounts.listCampaigns,
    expanded ? { accountId: account._id as Id<"adAccounts"> } : 'skip'
  );

  const handleAccountToggle = useCallback(() => {
    if (isChecked) {
      // Uncheck account — remove it and all its campaigns/ads
      const campaignIdsToRemove = new Set((campaigns || []).map((c) => c._id as string));
      onChange({
        accountIds: value.accountIds.filter((id) => id !== account._id),
        campaignIds: value.campaignIds.filter((id) => !campaignIdsToRemove.has(id)),
        adIds: [], // Clear ad-level selections for simplicity when unchecking parent
      });
    } else {
      // Check account
      onChange({
        ...value,
        accountIds: [...value.accountIds, account._id],
      });
    }
  }, [isChecked, account._id, campaigns, value, onChange]);

  return (
    <div>
      <div className="flex items-center gap-2 py-1.5 px-1 rounded hover:bg-muted/50">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="shrink-0 p-0.5"
          data-testid={`expand-account-${account._id}`}
        >
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          )}
        </button>
        <input
          type="checkbox"
          checked={isChecked}
          onChange={handleAccountToggle}
          className="rounded shrink-0"
          data-testid={`check-account-${account._id}`}
        />
        <Monitor className="w-4 h-4 text-primary shrink-0" />
        <span className="text-sm truncate">{account.name}</span>
      </div>

      {expanded && (
        <div className="pl-6">
          {campaigns === undefined ? (
            <div className="flex items-center justify-center py-2">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          ) : campaigns.length === 0 ? (
            <p className="text-xs text-muted-foreground py-1 pl-6">Нет кампаний</p>
          ) : (
            campaigns.map((campaign) => (
              <CampaignNode
                key={campaign._id}
                campaign={campaign}
                accountId={account._id}
                value={value}
                onChange={onChange}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── Campaign-level node ─────────────────────────────

interface CampaignNodeProps {
  campaign: { _id: string; name: string; status: string };
  accountId: string;
  value: TargetSelection;
  onChange: (selection: TargetSelection) => void;
}

function CampaignNode({ campaign, accountId, value, onChange }: CampaignNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const isChecked = value.campaignIds.includes(campaign._id);
  const parentChecked = value.accountIds.includes(accountId);

  const ads = useQuery(
    api.adAccounts.listAds,
    expanded ? { campaignId: campaign._id as Id<"campaigns"> } : 'skip'
  );

  const handleCampaignToggle = useCallback(() => {
    if (isChecked) {
      // Uncheck campaign — also remove its ads
      const adIdsToRemove = new Set((ads || []).map((a) => a._id as string));
      onChange({
        ...value,
        campaignIds: value.campaignIds.filter((id) => id !== campaign._id),
        adIds: value.adIds.filter((id) => !adIdsToRemove.has(id)),
      });
    } else {
      onChange({
        ...value,
        campaignIds: [...value.campaignIds, campaign._id],
      });
    }
  }, [isChecked, campaign._id, ads, value, onChange]);

  // If parent (account) is checked, campaign is implicitly included
  const effectiveChecked = parentChecked || isChecked;

  return (
    <div>
      <div className="flex items-center gap-2 py-1 px-1 rounded hover:bg-muted/50">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="shrink-0 p-0.5"
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
          )}
        </button>
        <input
          type="checkbox"
          checked={effectiveChecked}
          onChange={handleCampaignToggle}
          disabled={parentChecked}
          className={cn('rounded shrink-0', parentChecked && 'opacity-50')}
        />
        <Megaphone className="w-3.5 h-3.5 text-primary shrink-0" />
        <span className="text-xs truncate">{campaign.name}</span>
        <span className={cn(
          'text-[10px] shrink-0',
          campaign.status === 'active' ? 'text-green-600' : 'text-muted-foreground'
        )}>
          {campaign.status === 'active' ? 'Активна' : campaign.status}
        </span>
      </div>

      {expanded && (
        <div className="pl-6">
          {ads === undefined ? (
            <div className="flex items-center justify-center py-1">
              <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
            </div>
          ) : ads.length === 0 ? (
            <p className="text-[10px] text-muted-foreground py-1 pl-6">Нет объявлений</p>
          ) : (
            ads.map((ad) => (
              <AdNode
                key={ad._id}
                ad={ad}
                campaignId={campaign._id}
                accountId={accountId}
                value={value}
                onChange={onChange}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── Ad-level node ───────────────────────────────────

interface AdNodeProps {
  ad: { _id: string; name: string; status: string };
  campaignId: string;
  accountId: string;
  value: TargetSelection;
  onChange: (selection: TargetSelection) => void;
}

function AdNode({ ad, campaignId, accountId, value, onChange }: AdNodeProps) {
  const isChecked = value.adIds.includes(ad._id);
  const parentChecked =
    value.accountIds.includes(accountId) ||
    value.campaignIds.includes(campaignId);

  const handleAdToggle = useCallback(() => {
    if (isChecked) {
      onChange({
        ...value,
        adIds: value.adIds.filter((id) => id !== ad._id),
      });
    } else {
      onChange({
        ...value,
        adIds: [...value.adIds, ad._id],
      });
    }
  }, [isChecked, ad._id, value, onChange]);

  const effectiveChecked = parentChecked || isChecked;

  return (
    <div className="flex items-center gap-2 py-0.5 px-1 rounded hover:bg-muted/30">
      <input
        type="checkbox"
        checked={effectiveChecked}
        onChange={handleAdToggle}
        disabled={parentChecked}
        className={cn('rounded shrink-0 ml-5', parentChecked && 'opacity-50')}
      />
      <ImageIcon className="w-3 h-3 text-muted-foreground shrink-0" />
      <span className="text-[11px] truncate">{ad.name}</span>
    </div>
  );
}

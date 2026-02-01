import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useAuth } from '../lib/useAuth';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import {
  ListChecks, Plus, Loader2, AlertCircle, Trash2, Power, Pencil,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { Id } from '../../convex/_generated/dataModel';
import { TargetTreeSelector, TargetSelection } from '../components/TargetTreeSelector';
import { ActionRadio, ActionMode, actionModeToFlags } from '../components/ActionRadio';
import { UpgradeModal } from '../components/UpgradeModal';

type RuleType = 'cpl_limit' | 'min_ctr' | 'fast_spend' | 'spend_no_leads' | 'budget_limit' | 'low_impressions' | 'clicks_no_leads';

const RULE_TYPE_LABELS: Record<RuleType, string> = {
  cpl_limit: 'CPL лимит',
  min_ctr: 'Мин. CTR',
  fast_spend: 'Быстрый расход',
  spend_no_leads: 'Расход без лидов',
  budget_limit: 'Лимит расхода',
  low_impressions: 'Мало показов',
  clicks_no_leads: 'Клики без результата',
};

const RULE_TYPE_DESCRIPTIONS: Record<RuleType, string> = {
  cpl_limit: 'Остановить, если стоимость лида превышает порог',
  min_ctr: 'Остановить, если CTR ниже порога',
  fast_spend: 'Остановить при слишком быстром расходе бюджета',
  spend_no_leads: 'Остановить, если потрачено N без единого лида',
  budget_limit: 'Остановить, если дневной расход превышает порог',
  low_impressions: 'Уведомить, если показов меньше порога (не откручивается)',
  clicks_no_leads: 'Остановить, если N+ кликов без единого лида',
};

const RULE_TYPE_UNITS: Record<RuleType, string> = {
  cpl_limit: '₽',
  min_ctr: '%',
  fast_spend: '₽/час',
  spend_no_leads: '₽',
  budget_limit: '₽',
  low_impressions: 'показов',
  clicks_no_leads: 'кликов',
};

/** Convert action flags to ActionMode */
function flagsToActionMode(actions: { stopAd: boolean; notify: boolean }): ActionMode {
  if (actions.stopAd && actions.notify) return 'stop_and_notify';
  if (actions.stopAd) return 'stop_only';
  return 'notify_only';
}

export function RulesPage() {
  const { user } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);

  const limits = useQuery(
    api.users.getLimits,
    user?.userId ? { userId: user.userId as Id<"users"> } : 'skip'
  );

  const rules = useQuery(
    api.rules.list,
    user?.userId ? { userId: user.userId as Id<"users"> } : 'skip'
  );

  const createRule = useMutation(api.rules.create);
  const updateRule = useMutation(api.rules.update);
  const toggleActive = useMutation(api.rules.toggleActive);
  const removeRule = useMutation(api.rules.remove);

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const isLoading = rules === undefined;
  const isLimitReached = limits && limits.usage.rules >= limits.limits.rules;

  const handleToggle = async (ruleId: string) => {
    setError(null);
    try {
      await toggleActive({
        ruleId: ruleId as Id<"rules">,
        userId: user.userId as Id<"users">,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Ошибка переключения';
      if (msg.includes('Лимит')) setShowUpgradeModal(true);
      setError(msg);
    }
  };

  const handleDelete = async (ruleId: string) => {
    setError(null);
    try {
      await removeRule({
        ruleId: ruleId as Id<"rules">,
        userId: user.userId as Id<"users">,
      });
      if (editingRuleId === ruleId) {
        setEditingRuleId(null);
        setShowEditor(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления');
    }
  };

  const handleSelectRule = (ruleId: string) => {
    setEditingRuleId(ruleId);
    setShowEditor(true);
    setError(null);
  };

  const handleNewRule = () => {
    if (isLimitReached) {
      setShowUpgradeModal(true);
      return;
    }
    setEditingRuleId(null);
    setShowEditor(true);
    setError(null);
  };

  const editingRule = editingRuleId ? rules?.find((r) => r._id === editingRuleId) : undefined;

  return (
    <div className="max-w-6xl mx-auto space-y-6" data-testid="rules-page">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-foreground flex items-center gap-2">
            <ListChecks className="w-7 h-7" />
            Правила автоматизации
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Настройте автоматическую остановку и уведомления
          </p>
        </div>
        <div className="relative group">
          <button
            type="button"
            onClick={handleNewRule}
            disabled={!!isLimitReached}
            className={cn(
              'inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-all',
              'bg-primary text-primary-foreground hover:bg-primary/90',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
            data-testid="add-rule-button"
          >
            <Plus className="w-4 h-4" />
            Новое правило
          </button>
          {isLimitReached && (
            <div className="absolute right-0 top-full mt-1 px-3 py-1.5 bg-foreground text-background text-xs rounded shadow-lg whitespace-nowrap z-10 hidden group-hover:block" data-testid="limit-tooltip">
              Лимит правил исчерпан. Обновите тариф.
            </div>
          )}
        </div>
      </div>

      {/* Messages */}
      {success && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 text-green-700 dark:text-green-400 text-sm">
          <span>{success}</span>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left column: Rules list */}
        <div data-testid="rules-list-panel">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Ваши правила</CardTitle>
              <CardDescription>
                {isLoading
                  ? 'Загрузка...'
                  : rules.length > 0
                    ? `${rules.length} ${rules.length === 1 ? 'правило' : rules.length < 5 ? 'правила' : 'правил'}`
                    : 'Нет правил'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                </div>
              ) : rules.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground" data-testid="rules-empty-state">
                  <Power className="w-12 h-12 mx-auto mb-3 opacity-30" />
                  <p className="text-base font-medium">Создайте первое правило</p>
                  <p className="text-sm mt-1">Нажмите «Новое правило» чтобы начать</p>
                </div>
              ) : (
                <div data-testid="rules-list" className="space-y-2">
                  {rules.map((rule) => {
                    const isSelected = editingRuleId === rule._id;
                    return (
                      <div
                        key={rule._id}
                        onClick={() => handleSelectRule(rule._id)}
                        className={cn(
                          'flex items-center gap-3 p-4 rounded-lg border cursor-pointer transition-colors',
                          isSelected
                            ? 'border-primary bg-primary/5'
                            : rule.isActive
                              ? 'border-border hover:bg-muted/50'
                              : 'border-border/50 opacity-60 hover:opacity-80'
                        )}
                        data-testid={`rule-card-${rule._id}`}
                      >
                        {/* Toggle */}
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleToggle(rule._id); }}
                          className={cn(
                            'w-10 h-6 rounded-full transition-colors relative shrink-0',
                            rule.isActive ? 'bg-primary' : 'bg-muted'
                          )}
                          data-testid={`toggle-rule-${rule._id}`}
                        >
                          <span
                            className={cn(
                              'absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform',
                              rule.isActive ? 'translate-x-4' : 'translate-x-0.5'
                            )}
                          />
                        </button>

                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">{rule.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {RULE_TYPE_LABELS[rule.type as RuleType]} · {rule.conditions.operator} {rule.conditions.value}
                            {RULE_TYPE_UNITS[rule.type as RuleType] ? ` ${RULE_TYPE_UNITS[rule.type as RuleType]}` : ''}
                          </p>
                        </div>

                        {/* Actions badge */}
                        <div className="flex items-center gap-1.5">
                          {rule.actions.stopAd && (
                            <span className="px-2 py-0.5 rounded-full text-xs bg-destructive/10 text-destructive">
                              Стоп
                            </span>
                          )}
                          {rule.actions.notify && (
                            <span className="px-2 py-0.5 rounded-full text-xs bg-primary/10 text-primary">
                              Уведомление
                            </span>
                          )}
                        </div>

                        {/* Delete */}
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleDelete(rule._id); }}
                          className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                          data-testid={`delete-rule-${rule._id}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right column: Editor */}
        <div data-testid="rules-editor-panel">
          {showEditor ? (
            <RuleForm
              key={editingRuleId ?? 'new'}
              userId={user.userId}
              subscriptionTier={user.subscriptionTier}
              existingRule={editingRule ? {
                _id: editingRule._id,
                name: editingRule.name,
                type: editingRule.type as RuleType,
                value: editingRule.conditions.value,
                actions: editingRule.actions,
                targetAccountIds: editingRule.targetAccountIds,
                targetCampaignIds: editingRule.targetCampaignIds,
                targetAdIds: editingRule.targetAdIds,
              } : undefined}
              onSubmit={async (data) => {
                setError(null);
                try {
                  if (editingRuleId) {
                    await updateRule({
                      ruleId: editingRuleId as Id<"rules">,
                      userId: user.userId as Id<"users">,
                      name: data.name,
                      value: data.value,
                      actions: data.actions,
                      targetAccountIds: data.targetAccountIds,
                      targetCampaignIds: data.targetCampaignIds,
                      targetAdIds: data.targetAdIds,
                    });
                    setSuccess('Правило обновлено!');
                  } else {
                    await createRule({
                      userId: user.userId as Id<"users">,
                      ...data,
                    });
                    setSuccess('Правило создано!');
                  }
                  setShowEditor(false);
                  setEditingRuleId(null);
                  setTimeout(() => setSuccess(null), 3000);
                } catch (err) {
                  const msg = err instanceof Error ? err.message : 'Ошибка сохранения';
                  if (msg.includes('Лимит правил')) {
                    setShowUpgradeModal(true);
                  }
                  setError(msg);
                }
              }}
              onCancel={() => { setShowEditor(false); setEditingRuleId(null); }}
            />
          ) : (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <Pencil className="w-10 h-10 mb-3 opacity-30" />
                <p className="text-sm">Выберите правило для редактирования</p>
                <p className="text-xs mt-1">или создайте новое</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Upgrade modal */}
      {showUpgradeModal && limits && (
        <UpgradeModal
          currentTier={limits.tier as 'freemium' | 'start' | 'pro'}
          limitType="rules"
          currentUsage={limits.usage.rules}
          limit={limits.limits.rules}
          onClose={() => setShowUpgradeModal(false)}
          onUpgrade={() => {
            setShowUpgradeModal(false);
          }}
        />
      )}
    </div>
  );
}

// ─── Rule editor form ──────────────────────────────────────

interface ExistingRuleData {
  _id: string;
  name: string;
  type: RuleType;
  value: number;
  actions: { stopAd: boolean; notify: boolean };
  targetAccountIds: Id<"adAccounts">[];
  targetCampaignIds?: string[];
  targetAdIds?: string[];
}

interface RuleFormProps {
  userId: string;
  subscriptionTier: string;
  existingRule?: ExistingRuleData;
  onSubmit: (data: {
    name: string;
    type: RuleType;
    value: number;
    actions: { stopAd: boolean; notify: boolean };
    targetAccountIds: Id<"adAccounts">[];
    targetCampaignIds?: string[];
    targetAdIds?: string[];
  }) => Promise<void>;
  onCancel: () => void;
}

function RuleForm({ userId, subscriptionTier, existingRule, onSubmit, onCancel }: RuleFormProps) {
  const [name, setName] = useState(existingRule?.name ?? '');
  const [type, setType] = useState<RuleType>(existingRule?.type ?? 'cpl_limit');
  const [value, setValue] = useState(existingRule ? String(existingRule.value) : '');
  const [actionMode, setActionMode] = useState<ActionMode>(
    existingRule ? flagsToActionMode(existingRule.actions) : 'notify_only'
  );
  const [targets, setTargets] = useState<TargetSelection>({
    accountIds: existingRule?.targetAccountIds?.map(String) ?? [],
    campaignIds: existingRule?.targetCampaignIds ?? [],
    adIds: existingRule?.targetAdIds ?? [],
  });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const isFreemium = subscriptionTier === 'freemium';
  const isEditing = !!existingRule;

  // Real-time validation
  const numericValue = Number(value);
  const hasValueError = value !== '' && (isNaN(numericValue) || numericValue <= 0);
  const hasCtrError = type === 'min_ctr' && value !== '' && numericValue > 100;

  const handleSubmit = async () => {
    setFormError(null);

    if (!name.trim()) {
      setFormError('Введите название правила');
      return;
    }
    if (!value || numericValue <= 0) {
      setFormError('Значение должно быть больше 0');
      return;
    }
    if (type === 'min_ctr' && numericValue > 100) {
      setFormError('CTR не может быть больше 100%');
      return;
    }
    if (targets.accountIds.length === 0) {
      setFormError('Выберите хотя бы один кабинет');
      return;
    }

    const flags = actionModeToFlags(actionMode);

    setSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        type,
        value: numericValue,
        actions: flags,
        targetAccountIds: targets.accountIds as Id<"adAccounts">[],
        targetCampaignIds: targets.campaignIds.length > 0 ? targets.campaignIds : undefined,
        targetAdIds: targets.adIds.length > 0 ? targets.adIds : undefined,
      });
    } catch {
      // Error handled by parent
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card data-testid="rule-form">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">
            {isEditing ? 'Редактировать правило' : 'Новое правило'}
          </CardTitle>
          <button
            type="button"
            onClick={onCancel}
            className="text-muted-foreground hover:text-foreground text-sm"
          >
            Отмена
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {formError && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{formError}</span>
          </div>
        )}

        {/* Name */}
        <div>
          <label className="block text-sm font-medium mb-1">Название</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Например: CPL не больше 500₽"
            className="w-full px-3 py-2 rounded-lg border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            data-testid="rule-name-input"
          />
        </div>

        {/* Condition builder */}
        <div data-testid="condition-builder" className="space-y-3">
          <label className="block text-sm font-medium">Условие</label>

          {/* Type selector */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {(Object.keys(RULE_TYPE_LABELS) as RuleType[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                disabled={isEditing}
                className={cn(
                  'p-3 rounded-lg border text-left text-sm transition-colors',
                  type === t
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-muted/50',
                  isEditing && type !== t && 'opacity-40 cursor-not-allowed'
                )}
                data-testid={`rule-type-${t}`}
              >
                <p className="font-medium">{RULE_TYPE_LABELS[t]}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {RULE_TYPE_DESCRIPTIONS[t]}
                </p>
              </button>
            ))}
          </div>

          {/* Value */}
          <div>
            <label className="block text-sm font-medium mb-1">
              Порог ({RULE_TYPE_UNITS[type]})
            </label>
            <input
              type="number"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="0"
              min="0"
              step={type === 'min_ctr' ? '0.1' : '1'}
              className={cn(
                'w-full px-3 py-2 rounded-lg border bg-background text-foreground text-sm focus:outline-none focus:ring-2',
                hasValueError || hasCtrError
                  ? 'border-red-500 focus:ring-red-500'
                  : 'border-border focus:ring-primary'
              )}
              data-testid="rule-value-input"
            />
            {hasValueError && (
              <p className="text-xs text-red-500 mt-1" data-testid="value-error">
                Значение должно быть больше 0
              </p>
            )}
            {hasCtrError && (
              <p className="text-xs text-red-500 mt-1" data-testid="value-error">
                CTR не может быть больше 100%
              </p>
            )}
          </div>
        </div>

        {/* Action radio */}
        <div className="space-y-2">
          <label className="block text-sm font-medium">Действие при срабатывании</label>
          <ActionRadio
            value={actionMode}
            onChange={setActionMode}
            isFreemium={isFreemium}
          />
        </div>

        {/* Target tree selector */}
        <div>
          <label className="block text-sm font-medium mb-2">Применить к</label>
          <TargetTreeSelector
            userId={userId}
            value={targets}
            onChange={setTargets}
          />
          {targets.accountIds.length > 0 && (
            <p className="text-xs text-muted-foreground mt-1">
              {targets.accountIds.length} кабинет(ов)
              {targets.campaignIds.length > 0 && `, ${targets.campaignIds.length} кампаний`}
              {targets.adIds.length > 0 && `, ${targets.adIds.length} объявлений`}
            </p>
          )}
        </div>

        {/* Submit */}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          className={cn(
            'w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-all',
            'bg-primary text-primary-foreground hover:bg-primary/90',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
          data-testid="rule-submit-button"
        >
          {submitting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              {isEditing ? 'Сохранение...' : 'Создание...'}
            </>
          ) : (
            isEditing ? 'Сохранить' : 'Создать правило'
          )}
        </button>
      </CardContent>
    </Card>
  );
}

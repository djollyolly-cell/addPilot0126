import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useAuth } from '../lib/useAuth';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import {
  ListChecks, Plus, Loader2, AlertCircle, Trash2, Power, Pencil, Monitor,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { Id } from '../../convex/_generated/dataModel';
import { TargetTreeSelector, TargetSelection } from '../components/TargetTreeSelector';
import { ActionRadio, ActionMode, actionModeToFlags } from '../components/ActionRadio';
import { UpgradeModal } from '../components/UpgradeModal';

type RuleType = 'cpl_limit' | 'min_ctr' | 'fast_spend' | 'spend_no_leads' | 'budget_limit' | 'low_impressions' | 'clicks_no_leads' | 'new_lead' | 'uz_budget_manage';
type TimeWindow = 'daily' | 'since_launch' | '24h';

const TIME_WINDOW_OPTIONS: { value: TimeWindow; label: string; description: string }[] = [
  { value: 'daily', label: 'За сегодня', description: 'Только дневная статистика' },
  { value: 'since_launch', label: 'С запуска', description: 'Все клики с момента запуска объявления' },
  { value: '24h', label: 'За 24 часа', description: 'Сумма за последние 24 часа' },
];

const RULE_TYPE_LABELS: Record<RuleType, string> = {
  cpl_limit: 'CPL лимит',
  min_ctr: 'Мин. CTR',
  fast_spend: 'Быстрый расход',
  spend_no_leads: 'Расход без лидов',
  budget_limit: 'Лимит расхода',
  low_impressions: 'Мало показов',
  clicks_no_leads: 'Клики без результата',
  new_lead: 'Новый лид',
  uz_budget_manage: 'Работа с УЗ',
};

const RULE_TYPE_DESCRIPTIONS: Record<RuleType, string> = {
  cpl_limit: 'Остановить, если стоимость лида превышает порог',
  min_ctr: 'Остановить, если CTR ниже порога',
  fast_spend: 'Остановить при слишком быстром расходе бюджета',
  spend_no_leads: 'Остановить, если потрачено N без единого лида',
  budget_limit: 'Остановить, если дневной расход превышает порог',
  low_impressions: 'Уведомить, если показов меньше порога (не откручивается)',
  clicks_no_leads: 'Остановить, если N+ кликов без единого лида',
  new_lead: 'Уведомить в Telegram при получении нового лида',
  uz_budget_manage: 'Управление дневным бюджетом группы: автоматическое увеличение при приостановке и сброс в начале суток',
};

const RULE_TYPE_UNITS: Record<RuleType, string> = {
  cpl_limit: '₽',
  min_ctr: '%',
  fast_spend: '₽/час',
  spend_no_leads: '₽',
  budget_limit: '₽',
  low_impressions: 'показов',
  clicks_no_leads: 'кликов',
  new_lead: '',
  uz_budget_manage: '',
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

  const accounts = useQuery(
    api.adAccounts.list,
    user?.userId ? { userId: user.userId as Id<"users"> } : 'skip'
  );

  const createRule = useMutation(api.rules.create);
  const updateRule = useMutation(api.rules.update);
  const toggleActive = useMutation(api.rules.toggleActive);
  const removeRule = useMutation(api.rules.remove);

  // Map account IDs to names for display in rule cards
  const accountNameMap = new Map<string, string>();
  if (accounts) {
    for (const acc of accounts) {
      accountNameMap.set(acc._id, acc.name);
    }
  }

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
                            {RULE_TYPE_LABELS[rule.type as RuleType]}
                            {rule.type === 'uz_budget_manage'
                              ? ` · ${rule.conditions.initialBudget ?? 0}₽ +${rule.conditions.budgetStep ?? 0}₽`
                              : ` · ${rule.conditions.operator} ${rule.conditions.value}${RULE_TYPE_UNITS[rule.type as RuleType] ? ` ${RULE_TYPE_UNITS[rule.type as RuleType]}` : ''}`
                            }
                            {rule.type === 'clicks_no_leads' && (
                              <> · {rule.conditions.timeWindow === 'since_launch' ? 'с запуска' : rule.conditions.timeWindow === '24h' ? 'за 24ч' : 'за сегодня'}</>
                            )}
                          </p>
                          {rule.targetAccountIds.length > 0 && (
                            <p className="text-xs text-muted-foreground/70 truncate flex items-center gap-1">
                              <Monitor className="w-3 h-3 shrink-0" />
                              {rule.targetAccountIds.map((id) => accountNameMap.get(id) || 'Кабинет').join(', ')}
                            </p>
                          )}
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
                timeWindow: editingRule.conditions.timeWindow as TimeWindow | undefined,
                actions: editingRule.actions,
                targetAccountIds: editingRule.targetAccountIds,
                targetCampaignIds: editingRule.targetCampaignIds,
                targetAdIds: editingRule.targetAdIds,
                initialBudget: editingRule.conditions.initialBudget,
                budgetStep: editingRule.conditions.budgetStep,
                maxDailyBudget: editingRule.conditions.maxDailyBudget,
                resetDaily: editingRule.conditions.resetDaily,
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
                      timeWindow: data.timeWindow,
                      actions: data.actions,
                      targetAccountIds: data.targetAccountIds,
                      targetCampaignIds: data.targetCampaignIds,
                      targetAdIds: data.targetAdIds,
                      ...(data.initialBudget !== undefined ? { initialBudget: data.initialBudget } : {}),
                      ...(data.budgetStep !== undefined ? { budgetStep: data.budgetStep } : {}),
                      ...(data.maxDailyBudget !== undefined ? { maxDailyBudget: data.maxDailyBudget } : {}),
                      ...(data.resetDaily !== undefined ? { resetDaily: data.resetDaily } : {}),
                    });
                    setSuccess('Правило обновлено!');
                  } else {
                    await createRule({
                      userId: user.userId as Id<"users">,
                      name: data.name,
                      type: data.type,
                      value: data.value,
                      timeWindow: data.timeWindow,
                      actions: data.actions,
                      targetAccountIds: data.targetAccountIds,
                      targetCampaignIds: data.targetCampaignIds,
                      targetAdIds: data.targetAdIds,
                      ...(data.initialBudget !== undefined ? { initialBudget: data.initialBudget } : {}),
                      ...(data.budgetStep !== undefined ? { budgetStep: data.budgetStep } : {}),
                      ...(data.maxDailyBudget !== undefined ? { maxDailyBudget: data.maxDailyBudget } : {}),
                      ...(data.resetDaily !== undefined ? { resetDaily: data.resetDaily } : {}),
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
  timeWindow?: TimeWindow;
  actions: { stopAd: boolean; notify: boolean; notifyOnEveryIncrease?: boolean; notifyOnKeyEvents?: boolean };
  targetAccountIds: Id<"adAccounts">[];
  targetCampaignIds?: string[];
  targetAdIds?: string[];
  // uz_budget_manage
  initialBudget?: number;
  budgetStep?: number;
  maxDailyBudget?: number;
  resetDaily?: boolean;
}

interface RuleFormProps {
  userId: string;
  subscriptionTier: string;
  existingRule?: ExistingRuleData;
  onSubmit: (data: {
    name: string;
    type: RuleType;
    value: number;
    timeWindow?: TimeWindow;
    actions: { stopAd: boolean; notify: boolean; notifyOnEveryIncrease?: boolean; notifyOnKeyEvents?: boolean };
    targetAccountIds: Id<"adAccounts">[];
    targetCampaignIds?: string[];
    targetAdIds?: string[];
    initialBudget?: number;
    budgetStep?: number;
    maxDailyBudget?: number;
    resetDaily?: boolean;
  }) => Promise<void>;
  onCancel: () => void;
}

function RuleForm({ userId, subscriptionTier, existingRule, onSubmit, onCancel }: RuleFormProps) {
  const [name, setName] = useState(existingRule?.name ?? '');
  const [type, setType] = useState<RuleType>(existingRule?.type ?? 'cpl_limit');
  const [value, setValue] = useState(existingRule ? String(existingRule.value) : '');
  const [timeWindow, setTimeWindow] = useState<TimeWindow>(
    existingRule?.timeWindow ?? 'since_launch'
  );
  const [actionMode, setActionMode] = useState<ActionMode>(
    existingRule ? flagsToActionMode(existingRule.actions) : 'notify_only'
  );
  const [targets, setTargets] = useState<TargetSelection>({
    accountIds: existingRule?.targetAccountIds?.map(String) ?? [],
    campaignIds: existingRule?.targetCampaignIds ?? [],
    adIds: existingRule?.targetAdIds ?? [],
  });
  // uz_budget_manage specific state
  const [initialBudget, setInitialBudget] = useState(existingRule?.initialBudget ? String(existingRule.initialBudget) : '100');
  const [budgetStep, setBudgetStep] = useState(existingRule?.budgetStep ? String(existingRule.budgetStep) : '1');
  const [maxDailyBudget, setMaxDailyBudget] = useState(existingRule?.maxDailyBudget ? String(existingRule.maxDailyBudget) : '');
  const [resetDaily, setResetDaily] = useState(existingRule?.resetDaily ?? true);
  const [notifyOnEveryIncrease, setNotifyOnEveryIncrease] = useState(existingRule?.actions.notifyOnEveryIncrease ?? false);
  const [notifyOnKeyEvents, setNotifyOnKeyEvents] = useState(existingRule?.actions.notifyOnKeyEvents ?? true);

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
    if (type === 'uz_budget_manage') {
      const ib = Number(initialBudget);
      const bs = Number(budgetStep);
      const mdb = maxDailyBudget ? Number(maxDailyBudget) : undefined;
      if (!ib || ib <= 0) { setFormError('Начальный бюджет должен быть больше 0'); return; }
      if (!bs || bs <= 0) { setFormError('Шаг увеличения должен быть больше 0'); return; }
      if (mdb !== undefined && mdb > 0 && mdb <= ib) { setFormError('Максимальный бюджет должен быть больше начального'); return; }
      if (targets.campaignIds.length === 0) { setFormError('Выберите хотя бы одну группу'); return; }
    } else if (type !== 'new_lead' && (!value || numericValue <= 0)) {
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
        value: type === 'new_lead' || type === 'uz_budget_manage' ? 1 : numericValue,
        timeWindow: type === 'clicks_no_leads' ? timeWindow : undefined,
        actions: type === 'uz_budget_manage'
          ? { ...flags, notifyOnEveryIncrease, notifyOnKeyEvents }
          : flags,
        targetAccountIds: targets.accountIds as Id<"adAccounts">[],
        targetCampaignIds: targets.campaignIds.length > 0 ? targets.campaignIds : undefined,
        targetAdIds: targets.adIds.length > 0 ? targets.adIds : undefined,
        ...(type === 'uz_budget_manage' ? {
          initialBudget: Number(initialBudget),
          budgetStep: Number(budgetStep),
          maxDailyBudget: maxDailyBudget ? Number(maxDailyBudget) : undefined,
          resetDaily,
        } : {}),
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

        {/* Target tree selector — moved up for discoverability */}
        <div>
          <label className="block text-sm font-medium mb-2">Применить к кабинету</label>
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

          {/* Budget fields for uz_budget_manage */}
          {type === 'uz_budget_manage' && (
            <div className="space-y-3 p-3 rounded-lg border border-border bg-muted/30">
              <div>
                <label className="block text-sm font-medium mb-1">Начальный бюджет (₽)</label>
                <input
                  type="number"
                  value={initialBudget}
                  onChange={(e) => setInitialBudget(e.target.value)}
                  placeholder="100"
                  min="1"
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  data-testid="uz-initial-budget"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Шаг увеличения (₽)</label>
                <input
                  type="number"
                  value={budgetStep}
                  onChange={(e) => setBudgetStep(e.target.value)}
                  placeholder="1"
                  min="1"
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  data-testid="uz-budget-step"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Максимальный бюджет (₽)</label>
                <input
                  type="number"
                  value={maxDailyBudget}
                  onChange={(e) => setMaxDailyBudget(e.target.value)}
                  placeholder="Без ограничений"
                  min="0"
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  data-testid="uz-max-budget"
                />
                <p className="text-xs text-muted-foreground mt-1">Оставьте пустым для работы без ограничений</p>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-medium">Сбрасывать бюджет ежедневно</label>
                  <p className="text-xs text-muted-foreground">В начале суток вернуть начальный бюджет</p>
                </div>
                <button
                  type="button"
                  onClick={() => setResetDaily(!resetDaily)}
                  className={cn(
                    'relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors',
                    resetDaily ? 'bg-primary' : 'bg-muted'
                  )}
                  data-testid="uz-reset-daily"
                >
                  <span className={cn(
                    'pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg transition-transform',
                    resetDaily ? 'translate-x-5' : 'translate-x-0'
                  )} />
                </button>
              </div>
              <div className="space-y-2 pt-2 border-t border-border">
                <label className="block text-sm font-medium">Уведомления</label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={notifyOnEveryIncrease}
                    onChange={(e) => setNotifyOnEveryIncrease(e.target.checked)}
                    className="rounded"
                  />
                  При каждом увеличении
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={notifyOnKeyEvents}
                    onChange={(e) => setNotifyOnKeyEvents(e.target.checked)}
                    className="rounded"
                  />
                  Только ключевые события
                </label>
              </div>
            </div>
          )}

          {/* Value (hidden for new_lead and uz_budget_manage — no threshold needed) */}
          {type !== 'new_lead' && type !== 'uz_budget_manage' && (
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
          )}
        </div>

        {/* Time window (only for clicks_no_leads) */}
        {type === 'clicks_no_leads' && (
          <div className="space-y-2" data-testid="time-window-selector">
            <label className="block text-sm font-medium">Период анализа</label>
            <div className="grid grid-cols-3 gap-2">
              {TIME_WINDOW_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setTimeWindow(opt.value)}
                  className={cn(
                    'p-2 rounded-lg border text-center text-sm transition-colors',
                    timeWindow === opt.value
                      ? 'border-primary bg-primary/5 font-medium'
                      : 'border-border hover:bg-muted/50'
                  )}
                >
                  <p className="text-sm">{opt.label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{opt.description}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Action radio (hidden for uz_budget_manage — it manages budgets, not stops ads) */}
        {type !== 'uz_budget_manage' && (
          <div className="space-y-2">
            <label className="block text-sm font-medium">Действие при срабатывании</label>
            <ActionRadio
              value={actionMode}
              onChange={setActionMode}
              isFreemium={isFreemium}
            />
          </div>
        )}

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

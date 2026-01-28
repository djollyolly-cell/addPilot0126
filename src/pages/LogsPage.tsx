import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useAuth } from '../lib/useAuth';
import { Id } from '../../convex/_generated/dataModel';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import {
  ScrollText,
  Loader2,
  Search,
  ShieldOff,
  Bell,
  Zap,
  CheckCircle2,
  XCircle,
  Undo2,
  Clock,
  ChevronRight,
  X,
  Inbox,
} from 'lucide-react';
import { cn } from '../lib/utils';

type ActionType = 'stopped' | 'notified' | 'stopped_and_notified';
type StatusType = 'success' | 'failed' | 'reverted';

const ACTION_LABELS: Record<ActionType, string> = {
  stopped: 'Остановлено',
  notified: 'Уведомление',
  stopped_and_notified: 'Остановлено + уведомление',
};

const STATUS_LABELS: Record<StatusType, string> = {
  success: 'Успешно',
  failed: 'Ошибка',
  reverted: 'Отменено',
};

function ActionIcon({ type }: { type: ActionType }) {
  switch (type) {
    case 'stopped':
      return <ShieldOff className="w-4 h-4 text-red-500" />;
    case 'notified':
      return <Bell className="w-4 h-4 text-blue-500" />;
    case 'stopped_and_notified':
      return <Zap className="w-4 h-4 text-orange-500" />;
  }
}

function StatusBadge({ status }: { status: StatusType }) {
  const styles: Record<StatusType, string> = {
    success: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    reverted: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
  };
  const icons: Record<StatusType, React.ReactNode> = {
    success: <CheckCircle2 className="w-3 h-3" />,
    failed: <XCircle className="w-3 h-3" />,
    reverted: <Undo2 className="w-3 h-3" />,
  };
  return (
    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium', styles[status])}>
      {icons[status]}
      {STATUS_LABELS[status]}
    </span>
  );
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function LogsPage() {
  const { user } = useAuth();
  const userId = user?.userId as Id<'users'> | undefined;

  // Filters
  const [actionType, setActionType] = useState<ActionType | ''>('');
  const [accountId, setAccountId] = useState<string>('');
  const [ruleId, setRuleId] = useState<string>('');
  const [status, setStatus] = useState<StatusType | ''>('');
  const [search, setSearch] = useState('');

  // Detail panel
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  // Revert
  const revertAction = useMutation(api.ruleEngine.revertActionPublic);

  const logs = useQuery(
    api.ruleEngine.getLogs,
    userId
      ? {
          userId,
          ...(actionType ? { actionType: actionType as ActionType } : {}),
          ...(accountId ? { accountId: accountId as Id<'adAccounts'> } : {}),
          ...(ruleId ? { ruleId: ruleId as Id<'rules'> } : {}),
          ...(status ? { status: status as StatusType } : {}),
          ...(search ? { search } : {}),
        }
      : 'skip'
  );

  // For filter dropdowns
  const accounts = useQuery(api.adAccounts.list, userId ? { userId } : 'skip');
  const rules = useQuery(api.rules.list, userId ? { userId } : 'skip');

  const selectedEvent = logs?.find((l) => l._id === selectedEventId) ?? null;

  const canRevert = (event: NonNullable<typeof selectedEvent>) => {
    if (event.status === 'reverted') return false;
    if (event.actionType !== 'stopped' && event.actionType !== 'stopped_and_notified') return false;
    const elapsed = Date.now() - event.createdAt;
    return elapsed <= 5 * 60 * 1000;
  };

  const handleRevert = async () => {
    if (!selectedEvent || !userId) return;
    await revertAction({
      actionLogId: selectedEvent._id as Id<'actionLogs'>,
      userId,
    });
  };

  if (!userId) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div data-testid="logs-page" className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <ScrollText className="w-8 h-8 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Логи событий</h1>
          <p className="text-muted-foreground">Полный журнал действий системы</p>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div data-testid="logs-filters" className="flex flex-wrap gap-3 items-end">
            {/* Search */}
            <div className="flex-1 min-w-[200px]">
              <label className="text-sm font-medium mb-1 block">Поиск</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  data-testid="logs-search"
                  type="text"
                  placeholder="Поиск по имени, причине..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-10 pr-3 py-2 rounded-md border border-input bg-background text-sm"
                />
              </div>
            </div>

            {/* Action Type filter */}
            <div>
              <label className="text-sm font-medium mb-1 block">Тип</label>
              <select
                data-testid="filter-action-type"
                value={actionType}
                onChange={(e) => setActionType(e.target.value as ActionType | '')}
                className="px-3 py-2 rounded-md border border-input bg-background text-sm"
              >
                <option value="">Все типы</option>
                <option value="stopped">Остановлено</option>
                <option value="notified">Уведомление</option>
                <option value="stopped_and_notified">Остановлено + уведомление</option>
              </select>
            </div>

            {/* Account filter */}
            <div>
              <label className="text-sm font-medium mb-1 block">Кабинет</label>
              <select
                data-testid="filter-account"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="px-3 py-2 rounded-md border border-input bg-background text-sm"
              >
                <option value="">Все кабинеты</option>
                {accounts?.map((a) => (
                  <option key={a._id} value={a._id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Rule filter */}
            <div>
              <label className="text-sm font-medium mb-1 block">Правило</label>
              <select
                data-testid="filter-rule"
                value={ruleId}
                onChange={(e) => setRuleId(e.target.value)}
                className="px-3 py-2 rounded-md border border-input bg-background text-sm"
              >
                <option value="">Все правила</option>
                {rules?.map((r) => (
                  <option key={r._id} value={r._id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Status filter */}
            <div>
              <label className="text-sm font-medium mb-1 block">Статус</label>
              <select
                data-testid="filter-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as StatusType | '')}
                className="px-3 py-2 rounded-md border border-input bg-background text-sm"
              >
                <option value="">Все статусы</option>
                <option value="success">Успешно</option>
                <option value="failed">Ошибка</option>
                <option value="reverted">Отменено</option>
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Event list */}
        <div className={cn('lg:col-span-2', selectedEvent && 'lg:col-span-2')}>
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">
                События{' '}
                {logs && (
                  <span className="text-muted-foreground font-normal text-sm">
                    ({logs.length})
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {logs === undefined ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : logs.length === 0 ? (
                <div data-testid="logs-empty" className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <Inbox className="w-12 h-12 mb-3 opacity-50" />
                  <p className="text-lg font-medium">
                    {search || actionType || accountId || ruleId || status
                      ? 'Ничего не найдено'
                      : 'Нет событий'}
                  </p>
                  <p className="text-sm mt-1">
                    {search || actionType || accountId || ruleId || status
                      ? 'Попробуйте изменить фильтры'
                      : 'События появятся после срабатывания правил'}
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {logs.map((log) => (
                    <button
                      key={log._id}
                      data-testid="log-row"
                      onClick={() => setSelectedEventId(log._id === selectedEventId ? null : log._id)}
                      className={cn(
                        'w-full flex items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50',
                        log._id === selectedEventId && 'bg-muted'
                      )}
                    >
                      <ActionIcon type={log.actionType} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{log.adName}</p>
                        <p className="text-xs text-muted-foreground truncate">{log.reason}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <StatusBadge status={log.status} />
                        <span className="text-xs text-muted-foreground whitespace-nowrap flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatTimestamp(log.createdAt)}
                        </span>
                        <ChevronRight className="w-4 h-4 text-muted-foreground" />
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Detail panel */}
        <div className="lg:col-span-1">
          {selectedEvent ? (
            <Card data-testid="event-details">
              <CardHeader className="flex flex-row items-start justify-between">
                <CardTitle className="text-lg">Детали события</CardTitle>
                <button
                  onClick={() => setSelectedEventId(null)}
                  className="p-1 rounded hover:bg-muted"
                >
                  <X className="w-4 h-4" />
                </button>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <p className="text-sm text-muted-foreground">Объявление</p>
                  <p className="font-medium">{selectedEvent.adName}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Тип действия</p>
                  <div className="flex items-center gap-2 mt-1">
                    <ActionIcon type={selectedEvent.actionType} />
                    <span className="text-sm">{ACTION_LABELS[selectedEvent.actionType]}</span>
                  </div>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Причина</p>
                  <p className="text-sm">{selectedEvent.reason}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Статус</p>
                  <StatusBadge status={selectedEvent.status} />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Время</p>
                  <p className="text-sm">{formatTimestamp(selectedEvent.createdAt)}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Метрики</p>
                  <div className="grid grid-cols-2 gap-2 mt-1 text-sm">
                    <div>
                      <span className="text-muted-foreground">Расход:</span>{' '}
                      {selectedEvent.metricsSnapshot.spent.toLocaleString('ru-RU')} ₽
                    </div>
                    <div>
                      <span className="text-muted-foreground">Лиды:</span>{' '}
                      {selectedEvent.metricsSnapshot.leads}
                    </div>
                    {selectedEvent.metricsSnapshot.cpl !== undefined && (
                      <div>
                        <span className="text-muted-foreground">CPL:</span>{' '}
                        {selectedEvent.metricsSnapshot.cpl?.toLocaleString('ru-RU')} ₽
                      </div>
                    )}
                    {selectedEvent.metricsSnapshot.ctr !== undefined && (
                      <div>
                        <span className="text-muted-foreground">CTR:</span>{' '}
                        {selectedEvent.metricsSnapshot.ctr?.toFixed(2)}%
                      </div>
                    )}
                  </div>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Сэкономлено</p>
                  <p className="text-sm font-medium text-green-600">
                    {selectedEvent.savedAmount.toLocaleString('ru-RU')} ₽
                  </p>
                </div>

                {/* Revert button */}
                {(selectedEvent.actionType === 'stopped' || selectedEvent.actionType === 'stopped_and_notified') && (
                  <button
                    data-testid="revert-button"
                    onClick={handleRevert}
                    disabled={!canRevert(selectedEvent)}
                    className={cn(
                      'w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                      canRevert(selectedEvent)
                        ? 'bg-yellow-500 text-white hover:bg-yellow-600'
                        : 'bg-muted text-muted-foreground cursor-not-allowed'
                    )}
                  >
                    <Undo2 className="w-4 h-4" />
                    {selectedEvent.status === 'reverted'
                      ? 'Уже отменено'
                      : !canRevert(selectedEvent)
                        ? 'Время отмены истекло'
                        : 'Отменить действие'}
                  </button>
                )}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <ChevronRight className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">Выберите событие для просмотра деталей</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

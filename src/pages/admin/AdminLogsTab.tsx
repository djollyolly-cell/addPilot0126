import { useState } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Id } from '../../../convex/_generated/dataModel';
import {
  Search,
  Loader2,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  TrendingUp,
  StopCircle,
} from 'lucide-react';

interface Props {
  sessionToken: string;
}

type LogType = 'budget' | 'stopped' | 'error';

export function AdminLogsTab({ sessionToken }: Props) {
  const allUsers = useQuery(api.adminLogs.listUsersLight, { sessionToken });

  // Filters
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [logTypes, setLogTypes] = useState<Set<LogType>>(new Set(['budget', 'stopped', 'error']));
  const [userSearch, setUserSearch] = useState('');

  // On-demand query params
  const [fetchParams, setFetchParams] = useState<{
    userIds: string[];
    from: number;
    to: number;
    types: string[];
  } | null>(null);

  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);

  // Group by user
  const [groupBy, setGroupBy] = useState<'none' | 'user'>('user');

  const toggleLogType = (t: LogType) => {
    const next = new Set(logTypes);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    setLogTypes(next);
  };

  const toggleUser = (uid: string) => {
    setSelectedUserIds((prev) =>
      prev.includes(uid) ? prev.filter((id) => id !== uid) : [...prev, uid]
    );
  };

  const canFetch = selectedUserIds.length > 0 && dateFrom && dateTo && logTypes.size > 0;

  const handleFetch = () => {
    if (!canFetch) return;
    const from = new Date(dateFrom + 'T00:00:00').getTime();
    const to = new Date(dateTo + 'T23:59:59').getTime();
    setFetchParams({
      userIds: selectedUserIds,
      from,
      to,
      types: [...logTypes],
    });
  };

  const queryResult = useQuery(
    api.adminLogs.getLogs,
    fetchParams
      ? {
          sessionToken,
          userIds: fetchParams.userIds as Id<'users'>[],
          from: fetchParams.from,
          to: fetchParams.to,
          types: fetchParams.types,
        }
      : 'skip'
  );

  const formatDateTime = (ts: number) =>
    new Date(ts).toLocaleDateString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

  const typeIcon = (type: string) => {
    if (type === 'budget') return <TrendingUp className="w-3.5 h-3.5 text-blue-500" />;
    if (type === 'stopped') return <StopCircle className="w-3.5 h-3.5 text-red-500" />;
    return <AlertCircle className="w-3.5 h-3.5 text-yellow-500" />;
  };

  const typeBadge = (type: string) => {
    if (type === 'budget') return <Badge variant="default" className="text-[10px]">Бюджет</Badge>;
    if (type === 'stopped') return <Badge variant="destructive" className="text-[10px]">Остановка</Badge>;
    return <Badge variant="warning" className="text-[10px]">Ошибка</Badge>;
  };

  // Group logs by user
  const groupedLogs = (() => {
    if (!queryResult?.logs) return null;
    if (groupBy === 'none') return { '': queryResult.logs };
    const groups: Record<string, typeof queryResult.logs> = {};
    for (const log of queryResult.logs) {
      const key = log.userName;
      if (!groups[key]) groups[key] = [];
      groups[key].push(log);
    }
    return groups;
  })();

  const filteredAllUsers = allUsers?.filter(
    (u) =>
      !userSearch ||
      u.name.toLowerCase().includes(userSearch.toLowerCase()) ||
      u.email.toLowerCase().includes(userSearch.toLowerCase())
  );

  return (
    <div className="space-y-6">
      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Фильтры</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* User picker */}
          <div className="space-y-2">
            <label className="text-sm font-medium">
              Пользователи ({selectedUserIds.length} выбрано)
            </label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input
                type="text"
                placeholder="Поиск пользователя..."
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="flex flex-wrap gap-1.5 max-h-[120px] overflow-y-auto p-2 border border-border rounded-lg">
              {!filteredAllUsers ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                filteredAllUsers.slice(0, 50).map((u) => (
                  <Button
                    key={u._id}
                    size="sm"
                    variant={selectedUserIds.includes(u._id as string) ? 'default' : 'outline'}
                    className="text-xs h-7"
                    onClick={() => toggleUser(u._id as string)}
                  >
                    {u.name}
                  </Button>
                ))
              )}
            </div>
          </div>

          {/* Date range */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">От</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">До</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background"
              />
            </div>
          </div>

          {/* Log types */}
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium">Типы:</label>
            {([['budget', 'Бюджет'], ['stopped', 'Остановки'], ['error', 'Ошибки']] as [LogType, string][]).map(
              ([type, label]) => (
                <Button
                  key={type}
                  size="sm"
                  variant={logTypes.has(type) ? 'default' : 'outline'}
                  className="text-xs h-7"
                  onClick={() => toggleLogType(type)}
                >
                  {label}
                </Button>
              )
            )}
          </div>

          {/* Fetch button */}
          <Button onClick={handleFetch} disabled={!canFetch}>
            <Search className="w-4 h-4 mr-2" />
            Собрать данные
          </Button>
        </CardContent>
      </Card>

      {/* Summary */}
      {queryResult && (
        <div className="flex items-center gap-4 text-sm">
          <span className="font-medium">Найдено: {queryResult.summary.total}</span>
          <span className="text-blue-600">Бюджет: {queryResult.summary.budget}</span>
          <span className="text-red-600">Остановки: {queryResult.summary.stopped}</span>
          <span className="text-yellow-600">Ошибки: {queryResult.summary.error}</span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant={groupBy === 'user' ? 'default' : 'outline'} className="text-xs h-7" onClick={() => setGroupBy('user')}>
              По пользователю
            </Button>
            <Button size="sm" variant={groupBy === 'none' ? 'default' : 'outline'} className="text-xs h-7" onClick={() => setGroupBy('none')}>
              По дате
            </Button>
          </div>
        </div>
      )}

      {/* Results */}
      {groupedLogs && (
        <div className="space-y-4">
          {Object.entries(groupedLogs).map(([groupName, logs]) => (
            <Card key={groupName || 'all'}>
              {groupName && (
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">
                    {groupName} ({logs.length} записей)
                  </CardTitle>
                </CardHeader>
              )}
              <CardContent className={groupName ? 'pt-0' : ''}>
                <div className="space-y-1">
                  {logs.map((log) => (
                    <div key={log._id}>
                      <div
                        className="flex items-center gap-2 p-2 rounded-lg hover:bg-muted/30 cursor-pointer text-sm"
                        onClick={() => setExpandedLogId(expandedLogId === log._id ? null : log._id)}
                      >
                        {expandedLogId === log._id ? (
                          <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                        )}
                        {typeIcon(log.type)}
                        <span className="text-xs text-muted-foreground w-[90px] shrink-0">
                          {formatDateTime(log.timestamp)}
                        </span>
                        {typeBadge(log.type)}
                        <span className="truncate">{log.message}</span>
                        {groupBy === 'none' && (
                          <span className="text-xs text-muted-foreground ml-auto shrink-0">
                            {log.userName}
                          </span>
                        )}
                      </div>
                      {expandedLogId === log._id && log.details && (
                        <div className="ml-8 mb-2 p-3 rounded-lg bg-muted/30 text-xs font-mono whitespace-pre-wrap overflow-x-auto">
                          {JSON.stringify(log.details, null, 2)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!queryResult && (
        <div className="text-center py-12 text-muted-foreground">
          <Search className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p>Выберите пользователей и период, затем нажмите «Собрать данные»</p>
        </div>
      )}
    </div>
  );
}

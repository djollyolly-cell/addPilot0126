import { useState } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  Activity,
  Loader2,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';

interface Props {
  sessionToken: string;
}

export function AdminHealthTab({ sessionToken }: Props) {
  const [hours, setHours] = useState(24);
  const summary = useQuery(api.adminHealth.getSummary, { sessionToken, hours });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (!summary) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const formatTime = (ts: number) =>
    new Date(ts).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <div className="space-y-6">
      {/* Период */}
      <div className="flex gap-2">
        {[
          { h: 1, label: '1ч' },
          { h: 6, label: '6ч' },
          { h: 24, label: '24ч' },
          { h: 168, label: '7д' },
          { h: 720, label: '30д' },
        ].map((p) => (
          <Button
            key={p.h}
            size="sm"
            variant={hours === p.h ? 'default' : 'outline'}
            className="text-xs h-7"
            onClick={() => setHours(p.h)}
          >
            {p.label}
          </Button>
        ))}
      </div>

      {/* Виджеты */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6 text-center">
            <AlertCircle className={`w-8 h-8 mx-auto mb-2 ${summary.errorCount > 0 ? 'text-destructive' : 'text-muted-foreground'}`} />
            <div className="text-2xl font-bold">{summary.errorCount}</div>
            <p className="text-xs text-muted-foreground">Ошибок</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 text-center">
            <AlertTriangle className={`w-8 h-8 mx-auto mb-2 ${summary.warningCount > 0 ? 'text-yellow-500' : 'text-muted-foreground'}`} />
            <div className="text-2xl font-bold">{summary.warningCount}</div>
            <p className="text-xs text-muted-foreground">Предупреждений</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 text-center">
            {summary.syncStatus === 'completed' ? (
              <CheckCircle className="w-8 h-8 mx-auto mb-2 text-green-500" />
            ) : summary.syncStatus === 'failed' ? (
              <AlertCircle className="w-8 h-8 mx-auto mb-2 text-destructive" />
            ) : (
              <Activity className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
            )}
            <div className="text-sm font-bold">
              {summary.syncStatus === 'completed' ? 'ОК' : summary.syncStatus === 'failed' ? 'Ошибка' : summary.syncStatus}
            </div>
            <p className="text-xs text-muted-foreground">Синк метрик</p>
            {summary.syncLastRun && (
              <p className="text-[10px] text-muted-foreground mt-1">{formatTime(summary.syncLastRun)}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 text-center">
            <div className="text-2xl font-bold">{Object.keys(summary.bySource).length}</div>
            <p className="text-xs text-muted-foreground">Источников ошибок</p>
          </CardContent>
        </Card>
      </div>

      {/* По источникам */}
      {Object.keys(summary.bySource).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Ошибки по источникам</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {Object.entries(summary.bySource)
                .sort((a, b) => (b[1] as number) - (a[1] as number))
                .map(([source, count]) => (
                  <Badge key={source} variant="destructive" className="text-xs">
                    {source}: {count as number}
                  </Badge>
                ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Последние ошибки */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            Последние ошибки ({summary.recentErrors.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {summary.recentErrors.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              Ошибок нет за выбранный период
            </p>
          ) : (
            <div className="space-y-1">
              {summary.recentErrors.map((log) => (
                <div key={log._id}>
                  <div
                    className="flex items-center gap-2 p-2 rounded-lg hover:bg-muted/30 cursor-pointer text-sm"
                    onClick={() => setExpandedId(expandedId === log._id ? null : log._id)}
                  >
                    {expandedId === log._id ? (
                      <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                    )}
                    <AlertCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
                    <span className="text-xs text-muted-foreground w-[90px] shrink-0">
                      {formatTime(log.createdAt)}
                    </span>
                    <Badge variant="outline" className="text-[10px] shrink-0">
                      {log.source}
                    </Badge>
                    <span className="truncate">{log.message}</span>
                  </div>
                  {expandedId === log._id && log.details && (
                    <div className="ml-8 mb-2 p-3 rounded-lg bg-muted/30 text-xs font-mono whitespace-pre-wrap overflow-x-auto">
                      {JSON.stringify(log.details, null, 2)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

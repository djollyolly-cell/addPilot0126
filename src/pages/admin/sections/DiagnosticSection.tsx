import { useState } from 'react';
import { useQuery, useAction } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Activity, Stethoscope, Loader2 } from 'lucide-react';

export function DiagnosticSection() {
  const runSystemCheck = useAction(api.healthCheck.runManualSystemCheck);
  const runFunctionCheck = useAction(api.healthCheck.runManualFunctionCheck);
  const latestResults = useQuery(api.healthCheck.getLatestResults);

  const [running, setRunning] = useState<string | null>(null);

  const handleSystemCheck = async () => {
    setRunning('system');
    try {
      await runSystemCheck({});
    } catch (err) {
      console.error(err);
    } finally {
      setRunning(null);
    }
  };

  const handleFunctionCheck = async () => {
    setRunning('function');
    try {
      await runFunctionCheck({});
    } catch (err) {
      console.error(err);
    } finally {
      setRunning(null);
    }
  };

  const statusBadge = (status: string) => {
    if (status === 'ok') return <Badge variant="success">OK</Badge>;
    if (status === 'warning') return <Badge variant="warning">Warning</Badge>;
    return <Badge variant="destructive">Error</Badge>;
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Button
          onClick={handleSystemCheck}
          disabled={running !== null}
          variant="outline"
          className="h-auto py-3"
        >
          {running === 'system' ? (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          ) : (
            <Activity className="h-4 w-4 mr-2" />
          )}
          <div className="text-left">
            <div className="font-medium">Быстрая проверка</div>
            <div className="text-xs text-muted-foreground">Цикл 1: 5-15 сек</div>
          </div>
        </Button>

        <Button
          onClick={handleFunctionCheck}
          disabled={running !== null}
          variant="outline"
          className="h-auto py-3"
        >
          {running === 'function' ? (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          ) : (
            <Stethoscope className="h-4 w-4 mr-2" />
          )}
          <div className="text-left">
            <div className="font-medium">Полная диагностика</div>
            <div className="text-xs text-muted-foreground">Цикл 2: 30-120 сек</div>
          </div>
        </Button>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Stethoscope className="h-3.5 w-3.5" />
          <span>Проверка пользователя — кнопка в строке таблицы</span>
        </div>
      </div>

      {latestResults && latestResults.length > 0 && (
        <div className="space-y-2 mt-4">
          <h4 className="text-sm font-medium text-muted-foreground">Последние результаты</h4>
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          {latestResults.slice(0, 10).map((r: any) => (
            <div key={r._id} className="flex items-center justify-between p-3 rounded-lg border border-border">
              <div className="flex items-center gap-2">
                {statusBadge(r.status)}
                <span className="text-sm font-medium capitalize">{r.type}</span>
                <span className="text-xs text-muted-foreground">
                  {new Date(r.createdAt).toLocaleString('ru-RU')}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                {r.checkedUsers > 0 && `${r.checkedUsers} польз. `}
                {r.warnings > 0 && `${r.warnings} warn `}
                {r.errors > 0 && `${r.errors} err `}
                {Math.round(r.duration / 1000)}сек
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

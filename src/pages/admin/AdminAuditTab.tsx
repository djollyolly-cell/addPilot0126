import { useState, useMemo } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import {
  Building2,
  ListChecks,
  CreditCard,
  Bot,
  Settings,
  LogIn,
  Shield,
  CheckCircle,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';

interface Props {
  sessionToken: string;
}

const CATEGORIES = [
  { id: 'all', label: 'Все', icon: null },
  { id: 'account', label: 'Кабинеты', icon: Building2 },
  { id: 'rule', label: 'Правила', icon: ListChecks },
  { id: 'payment', label: 'Оплаты', icon: CreditCard },
  { id: 'telegram', label: 'Telegram', icon: Bot },
  { id: 'settings', label: 'Настройки', icon: Settings },
  { id: 'auth', label: 'Авторизация', icon: LogIn },
  { id: 'admin', label: 'Админ', icon: Shield },
] as const;

const ACTION_LABELS: Record<string, string> = {
  connect_success: 'Подключение кабинета',
  connect_failed: 'Ошибка подключения',
  disconnect: 'Отключение кабинета',
  rule_created: 'Создание правила',
  rule_updated: 'Изменение правила',
  rule_deleted: 'Удаление правила',
  rule_toggled: 'Вкл/Выкл правила',
  payment_started: 'Начало оплаты',
  payment_completed: 'Оплата',
  payment_failed: 'Ошибка оплаты',
  bot_connected: 'Привязка бота',
  bot_connect_failed: 'Ошибка привязки',
  bot_disconnected: 'Отвязка бота',
  settings_updated: 'Изменение настроек',
  login: 'Вход',
  login_failed: 'Неудачный вход',
  vk_reauth: 'Переавторизация VK',
  tier_changed: 'Изменение тарифа',
  expiry_changed: 'Изменение срока',
  admin_toggled: 'Изменение прав',
  broadcast_sent: 'Рассылка',
  in_app_broadcast_sent: 'Рассылка в сервисе',
};

export function AdminAuditTab({ sessionToken }: Props) {
  const [category, setCategory] = useState<string>('all');
  const [hours, setHours] = useState(168); // 7 дней
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Стабилизируем since — Date.now() на каждый рендер менял args → бесконечная переподписка
  const since = useMemo(() => Date.now() - hours * 60 * 60 * 1000, [hours]);

  const logs = useQuery(api.auditLog.list, {
    sessionToken,
    category: category === 'all' ? undefined : category,
    since,
    limit: 200,
  });

  const formatTime = (ts: number) =>
    new Date(ts).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <div className="space-y-6">
      {/* Фильтры по категории */}
      <div className="flex flex-wrap gap-2">
        {CATEGORIES.map((cat) => (
          <Button
            key={cat.id}
            size="sm"
            variant={category === cat.id ? 'default' : 'outline'}
            className="text-xs h-7"
            onClick={() => setCategory(cat.id)}
          >
            {cat.icon && <cat.icon className="w-3 h-3 mr-1" />}
            {cat.label}
          </Button>
        ))}
      </div>

      {/* Период */}
      <div className="flex gap-2">
        {[
          { h: 24, label: '24ч' },
          { h: 168, label: '7д' },
          { h: 720, label: '30д' },
          { h: 2160, label: '90д' },
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

      {/* Результаты */}
      {!logs ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : logs.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p>Нет записей за выбранный период</p>
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              {logs.length} записей
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {logs.map((log) => (
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
                    {log.status === 'success' ? (
                      <CheckCircle className="w-3.5 h-3.5 text-green-500 shrink-0" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
                    )}
                    <span className="text-xs text-muted-foreground w-[90px] shrink-0">
                      {formatTime(log.createdAt)}
                    </span>
                    <Badge variant="outline" className="text-[10px] shrink-0">
                      {log.category}
                    </Badge>
                    <span className="truncate">
                      {ACTION_LABELS[log.action] ?? log.action}
                    </span>
                    <span className="text-xs text-muted-foreground ml-auto shrink-0">
                      {log.userName}
                    </span>
                  </div>
                  {expandedId === log._id && log.details && (
                    <div className="ml-8 mb-2 p-3 rounded-lg bg-muted/30 text-xs font-mono whitespace-pre-wrap overflow-x-auto">
                      {JSON.stringify(log.details, null, 2)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

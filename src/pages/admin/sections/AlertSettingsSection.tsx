import { useState, useEffect } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { Button } from '../../../components/ui/button';
import { Loader2, Check } from 'lucide-react';

interface Props {
  sessionToken: string;
}

const ALERT_OPTIONS = [
  { key: 'payments', label: 'Оплаты', desc: 'Уведомление при каждой оплате' },
  { key: 'criticalErrors', label: 'Критические ошибки', desc: 'TOKEN_EXPIRED, синк упал, Telegram не работает' },
  { key: 'accountConnections', label: 'Подключения кабинетов', desc: 'Подключение, отключение, ошибки' },
  { key: 'newUsers', label: 'Новые пользователи', desc: 'Регистрация новых юзеров' },
  { key: 'ruleErrors', label: 'Ошибки правил', desc: 'Правило не сработало из-за ошибки' },
] as const;

type AlertKey = typeof ALERT_OPTIONS[number]['key'];

export function AlertSettingsSection({ sessionToken }: Props) {
  const settings = useQuery(api.adminAlerts.getSettings, { sessionToken });
  const saveSettings = useMutation(api.adminAlerts.saveSettings);
  const [local, setLocal] = useState<Record<AlertKey, boolean> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings && !local) {
      setLocal({
        payments: settings.payments,
        criticalErrors: settings.criticalErrors,
        accountConnections: settings.accountConnections,
        newUsers: settings.newUsers,
        ruleErrors: settings.ruleErrors,
      });
    }
  }, [settings, local]);

  if (!local) {
    return <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />;
  }

  const toggle = (key: AlertKey) => {
    setLocal((prev) => prev ? { ...prev, [key]: !prev[key] } : prev);
    setSaved(false);
  };

  const handleSave = async () => {
    if (!local) return;
    setSaving(true);
    try {
      await saveSettings({ sessionToken, ...local });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Получать в Telegram уведомления по выбранным категориям:
      </p>

      <div className="space-y-3">
        {ALERT_OPTIONS.map((opt) => (
          <label
            key={opt.key}
            className="flex items-start gap-3 p-3 rounded-lg border border-border hover:bg-muted/30 cursor-pointer transition-colors"
          >
            <input
              type="checkbox"
              checked={local[opt.key]}
              onChange={() => toggle(opt.key)}
              className="mt-0.5 h-4 w-4 rounded border-border"
            />
            <div>
              <div className="text-sm font-medium">{opt.label}</div>
              <div className="text-xs text-muted-foreground">{opt.desc}</div>
            </div>
          </label>
        ))}
      </div>

      <Button onClick={handleSave} disabled={saving} size="sm">
        {saving ? (
          <Loader2 className="w-4 h-4 animate-spin mr-2" />
        ) : saved ? (
          <Check className="w-4 h-4 mr-2" />
        ) : null}
        {saved ? 'Сохранено' : 'Сохранить'}
      </Button>
    </div>
  );
}

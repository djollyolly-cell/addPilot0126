import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

const PERMISSIONS = [
  { code: "rules", label: "Правила автоматизации" },
  { code: "budgets", label: "Управление бюджетами" },
  { code: "ads_control", label: "Управление объявлениями" },
  { code: "reports", label: "Отчёты и аналитика" },
  { code: "logs", label: "Логи действий" },
  { code: "telegram", label: "Telegram-уведомления" },
  { code: "add_accounts", label: "Добавление кабинетов" },
  { code: "invite_members", label: "Приглашение менеджеров" },
  { code: "ai_cabinet", label: "ИИ-кабинет" },
];

interface Props {
  selected: string[];
  onChange: (perms: string[]) => void;
}

export function PermissionsCheckboxGroup({ selected, onChange }: Props) {
  const toggle = (code: string) => {
    if (selected.includes(code)) onChange(selected.filter((c) => c !== code));
    else onChange([...selected, code]);
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-2" data-testid="permissions-group">
      {PERMISSIONS.map((p) => (
        <Label key={p.code} className="flex items-center gap-2 p-2 cursor-pointer hover:bg-muted rounded">
          <Checkbox checked={selected.includes(p.code)} onCheckedChange={() => toggle(p.code)} />
          <span className="text-sm">{p.label}</span>
        </Label>
      ))}
    </div>
  );
}

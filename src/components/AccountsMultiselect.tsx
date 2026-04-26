import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

interface Account { _id: string; name: string }

interface Props {
  accounts: Account[];
  selected: string[];
  onChange: (ids: string[]) => void;
}

export function AccountsMultiselect({ accounts, selected, onChange }: Props) {
  const toggle = (id: string) => {
    if (selected.includes(id)) onChange(selected.filter((i) => i !== id));
    else onChange([...selected, id]);
  };

  return (
    <div className="space-y-1 max-h-64 overflow-y-auto border rounded p-2" data-testid="accounts-multiselect">
      {accounts.length === 0 && <p className="text-muted-foreground text-sm p-2">Нет кабинетов</p>}
      {accounts.map((a) => (
        <Label key={a._id} className="flex items-center gap-2 p-1 cursor-pointer hover:bg-muted">
          <Checkbox checked={selected.includes(a._id)} onCheckedChange={() => toggle(a._id)} />
          <span className="text-sm">{a.name}</span>
        </Label>
      ))}
    </div>
  );
}

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

export const NICHE_COEFS: Record<string, number> = {
  beauty: 0.8,
  schools: 1.0,
  measurement: 1.2,
  sellers: 1.0,
  infobiz: 0.9,
  other: 1.0,
};

const NICHE_LABELS: Record<string, string> = {
  beauty: "Бьюти / Красота",
  schools: "Онлайн-школы",
  measurement: "Замерные ниши",
  sellers: "Товарный бизнес",
  infobiz: "Инфобизнес",
  other: "Другое",
};

interface Props {
  selected: string[];
  onChange: (niches: string[]) => void;
}

export function NicheSelector({ selected, onChange }: Props) {
  const toggle = (code: string) => {
    if (selected.includes(code)) onChange(selected.filter((c) => c !== code));
    else onChange([...selected, code]);
  };

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-2" data-testid="niche-selector">
      {Object.entries(NICHE_LABELS).map(([code, label]) => (
        <Label key={code} className="flex items-center gap-2 p-2 cursor-pointer hover:bg-muted rounded">
          <Checkbox checked={selected.includes(code)} onCheckedChange={() => toggle(code)} />
          <span className="text-sm">{label}</span>
          <span className="text-xs text-muted-foreground">&times;{NICHE_COEFS[code]}</span>
        </Label>
      ))}
    </div>
  );
}

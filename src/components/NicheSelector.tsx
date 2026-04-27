import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

/**
 * Niche coefficients from pricing spec (2026-04-15-agency-pricing-infrastructure-design.md §2.1).
 * Used in load unit estimation at onboarding.
 * Real load units are computed from actual activeGroups (ceil(groups/100)),
 * but these coefficients predict load at signup before real data exists.
 */
export const NICHE_COEFS: Record<string, number> = {
  beauty: 1,
  schools: 1,
  measurement: 2,
  sellers: 4,
  infobiz: 5,
  other: 2,
};

const NICHE_LABELS: Record<string, string> = {
  beauty: "Бьюти / Красота",
  schools: "Офлайн-школы",
  measurement: "Замерные ниши (окна, кухни, мебель)",
  sellers: "Селлеры",
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

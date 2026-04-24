import { FIELD_CATALOG, CATEGORY_LABELS, FieldCategory } from "../lib/reportFieldCatalog";

export function FieldPicker({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const selectedSet = new Set(selected);

  function toggle(id: string) {
    const field = FIELD_CATALOG.find((f) => f.id === id);
    if (!field) return;

    const next = new Set(selectedSet);
    if (next.has(id)) {
      next.delete(id);
      for (const dependent of FIELD_CATALOG) {
        if (dependent.dependencies?.includes(id) && next.has(dependent.id)) {
          next.delete(dependent.id);
        }
      }
    } else {
      next.add(id);
      for (const dep of field.dependencies ?? []) {
        next.add(dep);
      }
    }
    onChange(Array.from(next));
  }

  const grouped: Record<FieldCategory, typeof FIELD_CATALOG> = {
    time: [], ads: [], community: [],
  };
  for (const f of FIELD_CATALOG) grouped[f.category].push(f);

  return (
    <div className="space-y-4" data-testid="field-picker">
      <div className="text-sm text-muted-foreground">
        Выбрано: {selected.length} из {FIELD_CATALOG.length}
      </div>
      {(Object.keys(grouped) as FieldCategory[]).map((cat) => (
        <div key={cat}>
          <div className="text-sm font-medium mb-2">{CATEGORY_LABELS[cat]}</div>
          <div className="grid grid-cols-2 gap-2">
            {grouped[cat].map((f) => (
              <label
                key={f.id}
                className="flex items-center gap-2 text-sm cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selectedSet.has(f.id)}
                  onChange={() => toggle(f.id)}
                  data-testid={`field-checkbox-${f.id}`}
                />
                <span>{f.label}</span>
                {f.requiresCommunityProfile && (
                  <span className="text-xs text-muted-foreground" title="Требуется профиль сообщества">*</span>
                )}
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

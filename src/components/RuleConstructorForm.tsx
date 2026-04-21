import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, X } from "lucide-react";
import { RULE_OPERATORS, RULE_METRICS } from "../../convex/shared/ruleConstants";

export interface ConditionRow {
  metric: string;
  operator: string;
  value: string;
}

interface Props {
  conditions: ConditionRow[];
  onChange: (rows: ConditionRow[]) => void;
}

export function RuleConstructorForm({ conditions, onChange }: Props) {
  const update = (i: number, patch: Partial<ConditionRow>) => {
    const next = [...conditions];
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };
  const add = () => onChange([...conditions, { metric: "spent", operator: ">", value: "" }]);
  const remove = (i: number) => {
    if (conditions.length === 1) return;
    const next = [...conditions];
    next.splice(i, 1);
    onChange(next);
  };

  return (
    <div className="space-y-3" data-testid="rule-constructor-form">
      {conditions.map((c, i) => (
        <div key={i} className="flex items-end gap-2">
          <div className="flex-1 grid grid-cols-3 gap-2">
            <div>
              {i === 0 && <Label>Метрика</Label>}
              <select
                value={c.metric}
                onChange={(e) => update(i, { metric: e.target.value })}
                className="w-full p-2 rounded-lg border bg-background text-sm"
                data-testid={`condition-metric-${i}`}
              >
                {RULE_METRICS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            <div>
              {i === 0 && <Label>Условие</Label>}
              <select
                value={c.operator}
                onChange={(e) => update(i, { operator: e.target.value })}
                className="w-full p-2 rounded-lg border bg-background text-sm"
                data-testid={`condition-operator-${i}`}
              >
                {RULE_OPERATORS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              {i === 0 && <Label>Значение</Label>}
              <Input
                type="number"
                step="0.01"
                value={c.value}
                onChange={(e) => update(i, { value: e.target.value })}
                placeholder="0"
                data-testid={`condition-value-${i}`}
              />
            </div>
          </div>
          {conditions.length > 1 && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => remove(i)}
              className="mb-0.5"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={add} data-testid="add-condition">
        <Plus className="h-4 w-4 mr-2" />
        Добавить условие (AND)
      </Button>
    </div>
  );
}

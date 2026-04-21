/** Shared between frontend and backend. */
export const RULE_OPERATORS = [
  { value: ">", label: "больше" },
  { value: "<", label: "меньше" },
  { value: ">=", label: "≥" },
  { value: "<=", label: "≤" },
  { value: "==", label: "равно" },
] as const;

export const RULE_METRICS = [
  { value: "spent", label: "Расход", unit: "₽" },
  { value: "leads", label: "Лиды", unit: "" },
  { value: "clicks", label: "Клики", unit: "" },
  { value: "impressions", label: "Показы", unit: "" },
  { value: "cpl", label: "Цена лида", unit: "₽" },
  { value: "ctr", label: "CTR", unit: "%" },
  { value: "cpc", label: "Цена клика", unit: "₽" },
  { value: "reach", label: "Охват", unit: "" },
] as const;

export type RuleOperator = typeof RULE_OPERATORS[number]["value"];
export type RuleMetric = typeof RULE_METRICS[number]["value"];

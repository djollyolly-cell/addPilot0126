// Единый каталог полей отчёта — shared backend + frontend.
// ID полей используется в reportTemplates.fields.

export type FieldCategory = "time" | "ads" | "community";

export interface FieldDefinition {
  id: string;
  label: string;
  category: FieldCategory;
  dependencies?: string[];
  requiresCommunityProfile?: boolean;
}

export const FIELD_CATALOG: FieldDefinition[] = [
  // Time
  { id: "date", label: "Дата", category: "time" },
  { id: "weekday", label: "День недели", category: "time" },

  // Ads metrics
  { id: "impressions", label: "Показы", category: "ads" },
  { id: "clicks", label: "Переходы", category: "ads" },
  { id: "spent", label: "Бюджет без НДС", category: "ads" },
  { id: "spent_with_vat", label: "Бюджет с НДС", category: "ads" },
  { id: "cpc", label: "CPC", category: "ads", dependencies: ["clicks", "spent"] },
  { id: "ctr", label: "CTR", category: "ads", dependencies: ["clicks", "impressions"] },
  { id: "cpm", label: "CPM", category: "ads", dependencies: ["impressions", "spent"] },
  { id: "result_subscribes", label: "Подписки", category: "ads" },
  { id: "result_messages", label: "Сообщения (реклама)", category: "ads" },
  { id: "result_lead_forms", label: "Заявки (формы)", category: "ads" },
  { id: "result_other", label: "Прочие результаты", category: "ads" },
  { id: "cpl", label: "CPL", category: "ads", dependencies: ["result_subscribes", "result_messages", "result_lead_forms", "result_other", "spent"] },

  // Community
  { id: "message_starts", label: "Старты сообщений", category: "community", requiresCommunityProfile: true },
  { id: "phones_count", label: "Номеров найдено", category: "community", requiresCommunityProfile: true },
  { id: "phones_detail", label: "Номера: детали", category: "community", dependencies: ["phones_count"], requiresCommunityProfile: true },
  { id: "senler_subs", label: "Подписки Senler", category: "community", requiresCommunityProfile: true },
];

export const DEFAULT_TEMPLATE_FIELDS = [
  "date", "weekday",
  "spent", "spent_with_vat",
  "impressions", "clicks",
  "cpc", "ctr",
];

export function getField(id: string): FieldDefinition | undefined {
  return FIELD_CATALOG.find((f) => f.id === id);
}

export function isValidField(id: string): boolean {
  return FIELD_CATALOG.some((f) => f.id === id);
}

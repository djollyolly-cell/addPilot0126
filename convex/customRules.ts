import type { MetricsSnapshot, RuleCondition, SpendSnapshot } from "./ruleEngine";

export interface CustomRuleContext {
  spendHistory?: SpendSnapshot[];
  dailyBudget?: number;
  /** Per-handler additional data (orgId, account meta, etc.) */
  meta?: Record<string, unknown>;
}

export type CustomRuleHandler = (
  condition: RuleCondition, // L3 uses single object
  metrics: MetricsSnapshot,
  context?: CustomRuleContext
) => boolean;

export type CustomRuleHandlerTrace = (
  condition: RuleCondition,
  metrics: MetricsSnapshot,
  context?: CustomRuleContext
) => { triggered: boolean; reason: string };

/**
 * Registry of L3 handlers. Each entry has eval + trace + metadata.
 * Add new handlers here when an agency requests a custom rule type.
 */
export const CUSTOM_RULE_HANDLERS: Record<
  string,
  {
    eval: CustomRuleHandler;
    trace: CustomRuleHandlerTrace;
    description: string;
  }
> = {
  /**
   * Example: custom_roi — stops ad if ROI below target.
   * condition.value = target ROI (e.g. 1.5 for 150%)
   * Requires context.meta.revenue (per-account revenue data).
   *
   * NOTE: This is a TEMPLATE handler. In production, `revenue` would come
   * from one of: (a) external CRM webhook → stored in a per-account field,
   * (b) manual entry by agency owner via configSchema UI (Plan 6).
   * Until a real L3 handler is requested by an agency, this serves only
   * as an example of the handler interface. Do NOT wire into production.
   */
  custom_roi: {
    description: "Stop if ROI < target. Requires per-account revenue data.",
    eval: (condition, metrics, context) => {
      const revenue = (context?.meta?.revenue as number) ?? 0;
      if (metrics.spent <= 0) return false;
      const roi = revenue / metrics.spent;
      return roi < condition.value;
    },
    trace: (condition, metrics, context) => {
      const revenue = (context?.meta?.revenue as number) ?? 0;
      if (metrics.spent <= 0) {
        return { triggered: false, reason: "spent=0, ROI неприменим" };
      }
      const roi = revenue / metrics.spent;
      const triggered = roi < condition.value;
      return {
        triggered,
        reason: `ROI = ${roi.toFixed(2)} ${triggered ? "<" : "≥"} target ${condition.value}`,
      };
    },
  },
};

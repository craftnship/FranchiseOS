import { AppError } from "../common/errors";
import { round } from "../common/values";

// Financial model (spec §16) with D-15: monthly figures stored, royalties and marketing fund as
// opex, payback "not achievable" when EBITDA <= 0, tenant pass/fail thresholds.

export interface FeasibilityInput {
  initial_investment: number;
  monthly_revenue: number;
  gross_margin_pct: number; // 0..100
  monthly_fixed_opex: number; // rent, salaries, utilities, etc.
  royalty_pct: number; // % of revenue
  marketing_fund_pct: number; // % of revenue
}

export interface FeasibilityThresholds { max_payback_months: number; min_roi_pct: number }
export const DEFAULT_FEASIBILITY_THRESHOLDS: FeasibilityThresholds = { max_payback_months: 36, min_roi_pct: 25 };

export interface FeasibilityResult {
  monthly_revenue: number;
  gross_profit: number;
  monthly_opex: number;
  monthly_ebitda: number;
  annual_ebitda: number;
  ebitda_margin_pct: number;
  roi_pct: number;
  payback_months: number | null; // null = not achievable
  passed: boolean;
  fail_reasons: string[];
}

export function calculateFeasibility(
  input: FeasibilityInput,
  thresholds: FeasibilityThresholds = DEFAULT_FEASIBILITY_THRESHOLDS,
): FeasibilityResult {
  const bad = Object.entries(input).filter(([, v]) => typeof v !== "number" || !Number.isFinite(v) || v < 0).map(([k]) => k);
  if (bad.length) throw new AppError("VALIDATION_FAILED", "Feasibility inputs must be non-negative numbers.", Object.fromEntries(bad.map((k) => [k, "invalid"])));
  if (input.initial_investment <= 0) throw new AppError("VALIDATION_FAILED", "Initial investment must be greater than zero.", { initial_investment: "must be > 0" });
  if (input.gross_margin_pct > 100) throw new AppError("VALIDATION_FAILED", "Gross margin cannot exceed 100%.", { gross_margin_pct: "max 100" });

  const revenue = input.monthly_revenue;
  const grossProfit = revenue * (input.gross_margin_pct / 100);
  const opex = input.monthly_fixed_opex + revenue * ((input.royalty_pct + input.marketing_fund_pct) / 100);
  const ebitda = grossProfit - opex;
  const annual = ebitda * 12;
  const margin = revenue > 0 ? (ebitda / revenue) * 100 : 0;
  const roi = (annual / input.initial_investment) * 100;
  const payback = ebitda > 0 ? input.initial_investment / ebitda : null;

  const reasons: string[] = [];
  if (payback === null) reasons.push("EBITDA is not positive, so the investment is never paid back.");
  else if (payback > thresholds.max_payback_months) reasons.push(`Payback of ${round(payback, 1)} months exceeds ${thresholds.max_payback_months}.`);
  if (roi < thresholds.min_roi_pct) reasons.push(`ROI of ${round(roi, 1)}% is below ${thresholds.min_roi_pct}%.`);

  return {
    monthly_revenue: round(revenue),
    gross_profit: round(grossProfit),
    monthly_opex: round(opex),
    monthly_ebitda: round(ebitda),
    annual_ebitda: round(annual),
    ebitda_margin_pct: round(margin),
    roi_pct: round(roi),
    payback_months: payback === null ? null : round(payback, 1),
    passed: reasons.length === 0,
    fail_reasons: reasons,
  };
}

export interface Scenario { name: string; revenue_multiplier: number; cost_multiplier: number }
export const DEFAULT_SCENARIOS: Scenario[] = [
  { name: "Best", revenue_multiplier: 1.15, cost_multiplier: 0.95 },
  { name: "Base", revenue_multiplier: 1, cost_multiplier: 1 },
  { name: "Worst", revenue_multiplier: 0.8, cost_multiplier: 1.1 },
];

/** Revenue multiplier scales revenue (and revenue-linked fees); cost multiplier scales fixed opex. */
export function calculateScenarios(input: FeasibilityInput, scenarios: Scenario[] = DEFAULT_SCENARIOS, thresholds?: FeasibilityThresholds) {
  return scenarios.map((s) => ({
    ...s,
    result: calculateFeasibility(
      { ...input, monthly_revenue: input.monthly_revenue * s.revenue_multiplier, monthly_fixed_opex: input.monthly_fixed_opex * s.cost_multiplier },
      thresholds,
    ),
  }));
}

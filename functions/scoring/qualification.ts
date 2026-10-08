import { AppError } from "../common/errors";
import { round } from "../common/values";
import { assertWeightsTotal100, clamp, Weighted } from "./weights";

// Franchisee qualification (spec §18). Weights and thresholds are tenant configuration.
export const DEFAULT_QUALIFICATION_WEIGHTS: Weighted[] = [
  { code: "financial_capacity", weight: 25 },
  { code: "business_experience", weight: 15 },
  { code: "industry_experience", weight: 10 },
  { code: "territory_availability", weight: 15 },
  { code: "investment_readiness", weight: 15 },
  { code: "time_commitment", weight: 10 },
  { code: "profile_quality", weight: 10 },
];

export interface QualificationThresholds { hot: number; qualified: number; nurture: number }
export const DEFAULT_THRESHOLDS: QualificationThresholds = { hot: 80, qualified: 60, nurture: 40 };

export type QualificationClass = "HOT" | "QUALIFIED" | "NURTURE" | "LOW";

/** ratings: each dimension rated 0..100. */
export function scoreQualification(
  ratings: Record<string, number>,
  weights: Weighted[] = DEFAULT_QUALIFICATION_WEIGHTS,
  thresholds: QualificationThresholds = DEFAULT_THRESHOLDS,
): { score: number; classification: QualificationClass; breakdown: Record<string, number> } {
  assertWeightsTotal100(weights, "Qualification");
  const missing = weights.filter((w) => ratings[w.code] === undefined).map((w) => w.code);
  if (missing.length) throw new AppError("VALIDATION_FAILED", "Missing qualification ratings.", Object.fromEntries(missing.map((m) => [m, "required"])));

  const breakdown: Record<string, number> = {};
  let score = 0;
  for (const w of weights) {
    const contribution = (clamp(ratings[w.code]) * w.weight) / 100;
    breakdown[w.code] = round(contribution);
    score += contribution;
  }
  score = round(score);
  return { score, classification: classify(score, thresholds), breakdown };
}

export function classify(score: number, t: QualificationThresholds = DEFAULT_THRESHOLDS): QualificationClass {
  if (score >= t.hot) return "HOT";
  if (score >= t.qualified) return "QUALIFIED";
  if (score >= t.nurture) return "NURTURE";
  return "LOW";
}

/**
 * D-10: territory availability is scored before reservation from the applicant's preferred area:
 * 100 if any eligible territory there is AVAILABLE, 50 if all are RESERVED (may free up), else 0.
 */
export function territoryAvailabilityRating(statuses: string[]): number {
  if (statuses.includes("AVAILABLE")) return 100;
  if (statuses.includes("RESERVED")) return 50;
  return 0;
}

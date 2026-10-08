import { round } from "../common/values";
import { assertWeightsTotal100, clamp, Weighted } from "./weights";

// D-16: territory opportunity score. Inputs are indices normalised to 0..100.
export const DEFAULT_OPPORTUNITY_WEIGHTS: Weighted[] = [
  { code: "population", weight: 30 },
  { code: "market_size", weight: 30 },
  { code: "income_index", weight: 20 },
  { code: "competition_index", weight: 20 }, // inverted: more competition lowers the score
];

export function opportunityScore(
  inputs: { population: number; market_size: number; income_index: number; competition_index: number },
  weights: Weighted[] = DEFAULT_OPPORTUNITY_WEIGHTS,
): number {
  assertWeightsTotal100(weights, "Opportunity");
  const values: Record<string, number> = {
    population: clamp(inputs.population),
    market_size: clamp(inputs.market_size),
    income_index: clamp(inputs.income_index),
    competition_index: 100 - clamp(inputs.competition_index),
  };
  return round(weights.reduce((s, w) => s + (values[w.code] * w.weight) / 100, 0));
}

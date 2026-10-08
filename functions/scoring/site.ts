import { AppError } from "../common/errors";
import { round } from "../common/values";
import { assertWeightsTotal100, clamp } from "./weights";

// Site evaluation (spec §17). Templates are tenant-configurable; the server is authoritative.
export interface TemplateItem { code: string; name: string; weight: number; max_score: number; mandatory: boolean }

export const DEFAULT_SITE_TEMPLATE: TemplateItem[] = [
  { code: "location", name: "Location", weight: 20, max_score: 10, mandatory: true },
  { code: "footfall", name: "Footfall", weight: 15, max_score: 10, mandatory: true },
  { code: "visibility", name: "Visibility", weight: 10, max_score: 10, mandatory: true },
  { code: "competition", name: "Competition", weight: 10, max_score: 10, mandatory: true },
  { code: "rent", name: "Rent", weight: 15, max_score: 10, mandatory: true },
  { code: "demographics", name: "Demographics", weight: 10, max_score: 10, mandatory: true },
  { code: "parking", name: "Parking", weight: 10, max_score: 10, mandatory: false },
  { code: "accessibility", name: "Accessibility", weight: 10, max_score: 10, mandatory: false },
];

export type SiteRecommendation = "RECOMMEND" | "CONDITIONAL" | "REJECT";

// D-16 bands.
export function siteRecommendation(score: number): SiteRecommendation {
  if (score >= 80) return "RECOMMEND";
  if (score >= 65) return "CONDITIONAL";
  return "REJECT";
}

/**
 * ratings are on each item's own scale (0..max_score). Optional items left unrated score zero.
 * Raters score "rent" and "competition" favourably (higher = better for the site), as on the form.
 */
export function scoreSite(ratings: Record<string, number>, template: TemplateItem[] = DEFAULT_SITE_TEMPLATE) {
  assertWeightsTotal100(template.map((t) => ({ code: t.code, weight: t.weight })), "Site evaluation");
  const missing = template.filter((t) => t.mandatory && ratings[t.code] === undefined).map((t) => t.code);
  if (missing.length) throw new AppError("SITE_EVALUATION_INCOMPLETE", "Mandatory criteria are not rated.", Object.fromEntries(missing.map((m) => [m, "required"])));

  let score = 0;
  for (const t of template) {
    const r = ratings[t.code];
    if (r === undefined) continue;
    if (r < 0 || r > t.max_score) throw new AppError("VALIDATION_FAILED", `${t.name} must be between 0 and ${t.max_score}.`, { [t.code]: "out of range" });
    score += (r / t.max_score) * t.weight;
  }
  score = round(clamp(score));
  return { score, recommendation: siteRecommendation(score) };
}

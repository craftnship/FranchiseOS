import { round } from "../common/values";
import { assertWeightsTotal100, Weighted } from "./weights";

// Opening readiness (spec §20, §42) with D-7 blocker rule and D-8 local checklist source.
export const DEFAULT_READINESS_WEIGHTS: Weighted[] = [
  { code: "CONSTRUCTION", weight: 20 },
  { code: "EQUIPMENT", weight: 15 },
  { code: "RECRUITMENT", weight: 15 },
  { code: "TRAINING", weight: 10 },
  { code: "TECHNOLOGY", weight: 10 },
  { code: "COMPLIANCE", weight: 10 },
  { code: "INVENTORY", weight: 10 },
  { code: "MARKETING", weight: 10 },
];

export interface ChecklistItem {
  id: string;
  category: string;
  weight?: number; // relative weight inside its category, default 1
  mandatory: boolean;
  status: "OPEN" | "IN_PROGRESS" | "COMPLETED" | "BLOCKED";
  due_date?: string | null; // YYYY-MM-DD
}

export type Rag = "GREEN" | "AMBER" | "RED";

export interface ReadinessResult {
  score: number;
  weighted_score: number;
  rag: Rag;
  /** Weighted share of the checklist due by today: where the project should be on its plan. */
  expected: number;
  blockers: string[];
  overdue: string[];
  by_category: Record<string, number>;
}

export function isOverdue(item: ChecklistItem, today: string): boolean {
  return item.status !== "COMPLETED" && !!item.due_date && item.due_date < today;
}

/** D-7: a blocker is a mandatory item that is explicitly blocked or overdue, not merely open. */
export function isBlocker(item: ChecklistItem, today: string): boolean {
  return item.mandatory && item.status !== "COMPLETED" && (item.status === "BLOCKED" || isOverdue(item, today));
}

/**
 * Pace-based RAG: a project is judged against the progress its own due dates expect by now, so an
 * early opening on schedule is green. Within 15 points of pace is green and within 30 amber, so once
 * everything is due it matches the old fixed scale (85+ green, 70+ amber). A blocker always makes it red.
 */
export function rag(score: number, expected = 100, blocked = false): Rag {
  if (blocked) return "RED";
  const gap = expected - score;
  if (score >= 85 || gap <= 15) return "GREEN";
  if (gap <= 30) return "AMBER";
  return "RED";
}

export function calculateReadiness(items: ChecklistItem[], today: string, weights: Weighted[] = DEFAULT_READINESS_WEIGHTS): ReadinessResult {
  assertWeightsTotal100(weights, "Readiness");
  const byCategory: Record<string, number> = {};
  let earned = 0;
  let possible = 0;
  let due = 0;
  for (const w of weights) {
    const inCat = items.filter((i) => i.category === w.code);
    if (!inCat.length) continue; // categories without tasks are excluded and the rest renormalised
    const total = inCat.reduce((s, i) => s + (i.weight ?? 1), 0);
    const done = inCat.filter((i) => i.status === "COMPLETED").reduce((s, i) => s + (i.weight ?? 1), 0);
    const pct = total > 0 ? done / total : 0;
    byCategory[w.code] = round(pct * 100);
    // An item with no due date isn't expected yet; finished items count as expected even if early.
    const dueNow = inCat.filter((i) => (i.due_date && i.due_date <= today) || i.status === "COMPLETED").reduce((s, i) => s + (i.weight ?? 1), 0);
    due += total > 0 ? (dueNow / total) * w.weight : 0;
    earned += pct * w.weight;
    possible += w.weight;
  }
  const weighted = possible > 0 ? round((earned / possible) * 100) : 0;
  const blockers = items.filter((i) => isBlocker(i, today)).map((i) => i.id);
  const overdue = items.filter((i) => isOverdue(i, today)).map((i) => i.id);
  const score = blockers.length ? Math.min(weighted, 69) : weighted;
  const expected = possible > 0 ? round((due / possible) * 100) : 0;
  return { score, weighted_score: weighted, rag: rag(score, expected, blockers.length > 0), expected, blockers, overdue, by_category: byCategory };
}

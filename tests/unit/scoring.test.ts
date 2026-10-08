import { describe, expect, it } from "vitest";
import { scoreQualification, classify, territoryAvailabilityRating } from "../../functions/scoring/qualification";
import { scoreSite } from "../../functions/scoring/site";
import { opportunityScore } from "../../functions/scoring/territory";
import { calculateFeasibility, calculateScenarios } from "../../functions/scoring/feasibility";
import { calculateReadiness, ChecklistItem } from "../../functions/scoring/readiness";
import { AppError } from "../../functions/common/errors";

describe("qualification (§18, D-10)", () => {
  const all = (v: number) => ({ financial_capacity: v, business_experience: v, industry_experience: v, territory_availability: v, investment_readiness: v, time_commitment: v, profile_quality: v });
  it("weights a perfect applicant to 100 / HOT", () => {
    expect(scoreQualification(all(100))).toMatchObject({ score: 100, classification: "HOT" });
  });
  it("applies the band edges 80/60/40", () => {
    expect([classify(80), classify(79.99), classify(60), classify(59.9), classify(40), classify(39)]).toEqual(["HOT", "QUALIFIED", "QUALIFIED", "NURTURE", "NURTURE", "LOW"]);
  });
  it("rejects weights that do not total 100%", () => {
    expect(() => scoreQualification(all(50), [{ code: "financial_capacity", weight: 90 }])).toThrow(/total 90%/);
  });
  it("requires every dimension", () => {
    expect(() => scoreQualification({ financial_capacity: 90 })).toThrow(AppError);
  });
  it("scores territory availability before reservation", () => {
    expect([territoryAvailabilityRating(["RESERVED", "AVAILABLE"]), territoryAvailabilityRating(["RESERVED"]), territoryAvailabilityRating([])]).toEqual([100, 50, 0]);
  });
});

describe("site evaluation (§17, D-16)", () => {
  const full = { location: 9, footfall: 8, visibility: 8, competition: 7, rent: 8, demographics: 9, parking: 9, accessibility: 9 };
  it("calculates the weighted score and recommendation server-side", () => {
    // 18 + 12 + 8 + 7 + 12 + 9 + 9 + 9 = 84
    expect(scoreSite(full)).toEqual({ score: 84, recommendation: "RECOMMEND" });
  });
  it("blocks when a mandatory criterion is missing", () => {
    const { rent: _r, ...partial } = full;
    try { scoreSite(partial); throw new Error("expected failure"); } catch (e) { expect((e as AppError).code).toBe("SITE_EVALUATION_INCOMPLETE"); }
  });
  it("rejects out-of-range ratings", () => {
    expect(() => scoreSite({ ...full, footfall: 11 })).toThrow(/between 0 and 10/);
  });
});

describe("territory opportunity (D-16)", () => {
  it("inverts competition", () => {
    expect(opportunityScore({ population: 100, market_size: 100, income_index: 100, competition_index: 0 })).toBe(100);
    expect(opportunityScore({ population: 100, market_size: 100, income_index: 100, competition_index: 100 })).toBe(80);
  });
});

describe("feasibility (§16, D-15)", () => {
  const base = { initial_investment: 3_000_000, monthly_revenue: 1_000_000, gross_margin_pct: 65, monthly_fixed_opex: 400_000, royalty_pct: 6, marketing_fund_pct: 2 };
  it("computes the spec formulas with royalties and marketing as opex", () => {
    const r = calculateFeasibility(base);
    // GP 650k; opex 400k + 80k = 480k; EBITDA 170k/month; annual 2.04M
    expect(r).toMatchObject({ gross_profit: 650000, monthly_opex: 480000, monthly_ebitda: 170000, annual_ebitda: 2040000, ebitda_margin_pct: 17, roi_pct: 68, payback_months: 17.6, passed: true });
  });
  it("marks payback not achievable when EBITDA <= 0", () => {
    const r = calculateFeasibility({ ...base, monthly_fixed_opex: 600_000 });
    expect(r.payback_months).toBeNull();
    expect(r.passed).toBe(false);
  });
  it("fails on the 36-month payback threshold", () => {
    const r = calculateFeasibility({ ...base, initial_investment: 7_000_000 });
    expect(r.passed).toBe(false);
    expect(r.fail_reasons[0]).toMatch(/exceeds 36/);
  });
  it("rejects negative or zero investment", () => {
    expect(() => calculateFeasibility({ ...base, initial_investment: 0 })).toThrow(AppError);
    expect(() => calculateFeasibility({ ...base, monthly_revenue: -1 })).toThrow(AppError);
  });
  it("orders scenarios best > base > worst", () => {
    const [best, b, worst] = calculateScenarios(base);
    expect(best.result.monthly_ebitda).toBeGreaterThan(b.result.monthly_ebitda);
    expect(b.result.monthly_ebitda).toBeGreaterThan(worst.result.monthly_ebitda);
  });
});

describe("readiness (§20, D-7)", () => {
  const today = "2026-10-08";
  const item = (id: string, category: string, status: ChecklistItem["status"], extra: Partial<ChecklistItem> = {}): ChecklistItem =>
    ({ id, category, status, mandatory: true, due_date: "2026-12-01", ...extra });

  it("open-but-on-time mandatory tasks do not force Red", () => {
    const items = ["CONSTRUCTION", "EQUIPMENT", "RECRUITMENT", "TRAINING", "TECHNOLOGY", "COMPLIANCE", "INVENTORY", "MARKETING"]
      .flatMap((c) => [item(c + "1", c, "COMPLETED"), item(c + "2", c, "COMPLETED"), item(c + "3", c, "COMPLETED"), item(c + "4", c, "COMPLETED"), item(c + "5", c, "COMPLETED"), item(c + "6", c, "COMPLETED"), item(c + "7", c, "OPEN")]);
    const r = calculateReadiness(items, today);
    expect(r.blockers).toEqual([]);
    expect(r.score).toBeCloseTo(85.71, 1);
    expect(r.rag).toBe("GREEN");
  });
  it("an overdue mandatory task caps the score at 69 (Red)", () => {
    const items = [item("a", "CONSTRUCTION", "COMPLETED"), item("b", "CONSTRUCTION", "COMPLETED"), item("c", "EQUIPMENT", "COMPLETED"), item("d", "EQUIPMENT", "OPEN", { due_date: "2026-10-01" })];
    const r = calculateReadiness(items, today);
    expect(r.weighted_score).toBeGreaterThan(69);
    expect(r).toMatchObject({ score: 69, rag: "RED", blockers: ["d"], overdue: ["d"] });
  });
  it("a BLOCKED mandatory task is a blocker even when not overdue", () => {
    expect(calculateReadiness([item("x", "COMPLIANCE", "BLOCKED")], today).blockers).toEqual(["x"]);
  });
  it("an overdue optional task is overdue but not a blocker", () => {
    const r = calculateReadiness([item("m", "MARKETING", "OPEN", { mandatory: false, due_date: "2026-01-01" })], today);
    expect(r).toMatchObject({ blockers: [], overdue: ["m"] });
  });
  it("uses within-category task weights", () => {
    const r = calculateReadiness([item("big", "CONSTRUCTION", "COMPLETED", { weight: 3 }), item("small", "CONSTRUCTION", "OPEN", { weight: 1 })], today);
    expect(r.by_category.CONSTRUCTION).toBe(75);
  });
});

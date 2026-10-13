import { round } from "../common/values";

// Franchisee health (docs/health-score.md): one 0–100 score per trading store from five parts, each
// scored on its own, weighted over the parts that have data. Pure: the workflow gathers the inputs.

export type HealthPart = "sales" | "payments" | "compliance" | "reporting" | "customer";
export type HealthBand = "HEALTHY" | "WATCH" | "AT_RISK";
export const HEALTH_PARTS: HealthPart[] = ["sales", "payments", "compliance", "reporting", "customer"];
export const PART_LABEL: Record<HealthPart, string> = { sales: "Sales", payments: "Payments", compliance: "Compliance", reporting: "Reporting", customer: "Customer" };

export interface HealthWeights { sales: number; payments: number; compliance: number; reporting: number; customer: number }
export interface HealthThresholds { healthy_from: number; watch_from: number; part_floor: number }
export interface HealthSettings { weights: HealthWeights; thresholds: HealthThresholds }
export const DEFAULT_HEALTH: HealthSettings = {
  weights: { sales: 35, payments: 25, compliance: 20, reporting: 10, customer: 10 },
  thresholds: { healthy_from: 70, watch_from: 50, part_floor: 25 },
};

export interface HealthInputs {
  /** Average of the last three full months against plan, and how many of those months were under plan. */
  sales: { vs_plan_pct: number; months: number; months_under: number } | null;
  /** What the store owes: oldest overdue age (0 when nothing is overdue yet) and a month's royalty when known. */
  payments: { owed: number; overdue: number; oldest_days: number; monthly_royalty: number | null } | null;
  compliance: { audit_score: number | null; critical_open: number; overdue_actions: number; expired_licences: number; audit_overdue: boolean } | null;
  /** Months due and how they were reported; `feed` when the store's POS sales arrive daily (docs/pos-sales.md). */
  reporting: { due: number; on_time: number; late: number; feed?: FeedInput } | null;
  customer: { complaints: number; open: number } | null;
}

/** `variance`: recent months where the franchisee's report strayed from the POS figure, newest first; −12 means reported 12% under. */
export interface FeedInput { status: "CONNECTED" | "STALE"; last_day: string | null; variance: { period: string; pct: number; pos?: number; reported?: number }[] }

export interface HealthReason { part: HealthPart; score: number; text: string; money: string | null }
export interface PartResult { part: HealthPart; score: number | null; weight: number; detail: string }
export interface HealthResult { score: number | null; band: HealthBand | null; parts: PartResult[]; reasons: HealthReason[]; capped: boolean }

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const inr = (n: number) => (n >= 100_000 ? `₹${round(n / 100_000, 1)} L` : `₹${Math.round(n).toLocaleString("en-IN")}`);

/** Linear interpolation over sorted [x, y] points, flat beyond the ends. */
function interp(points: [number, number][], x: number): number {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1], [x1, y1] = points[i];
    if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }
  return points[points.length - 1][1];
}

const SALES_CURVE: [number, number][] = [[-40, 0], [-30, 20], [-20, 40], [-10, 65], [0, 85], [10, 100]];

export function salesScore(s: NonNullable<HealthInputs["sales"]>): number {
  return clamp(interp(SALES_CURVE, s.vs_plan_pct) - 5 * Math.max(0, s.months_under - 1));
}

export function paymentsScore(p: NonNullable<HealthInputs["payments"]>): number {
  if (p.owed <= 0) return 100;
  const base = p.overdue <= 0 ? 90 : p.oldest_days <= 30 ? 70 : p.oldest_days <= 60 ? 45 : p.oldest_days <= 90 ? 25 : 5;
  const ratio = p.monthly_royalty && p.monthly_royalty > 0 ? p.overdue / p.monthly_royalty : 0;
  return clamp(base - (ratio > 2 ? 15 : ratio > 1 ? 5 : 0));
}

export function complianceScore(c: NonNullable<HealthInputs["compliance"]>): number | null {
  const start = c.audit_score ?? (c.audit_overdue ? 40 : null);
  if (start === null) return null;
  return clamp(start - Math.min(30, 15 * c.critical_open) - Math.min(20, 5 * c.overdue_actions) - Math.min(30, 15 * c.expired_licences) - (c.audit_overdue ? 10 : 0));
}

export function reportingScore(r: NonNullable<HealthInputs["reporting"]>): number | null {
  // A POS feed replaces the report: current is full marks, stale 60. A month where the franchisee's own figure strayed from
  // the POS figure scores 20, under the default weak-part limit, so the store ranks no higher than Watch until the months roll off.
  if (r.feed) return r.feed.variance.length ? 20 : r.feed.status === "CONNECTED" ? 100 : 60;
  if (r.due <= 0) return null;
  return clamp(((r.on_time * 100) + (r.late * 50)) / r.due);
}

export function customerScore(c: NonNullable<HealthInputs["customer"]>): number {
  return clamp(100 - 10 * c.open - 3 * Math.max(0, c.complaints - c.open));
}

const pct = (n: number) => `${Math.abs(round(n, 0))}%`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (p: string) => `${MONTHS[Number(p.slice(5, 7)) - 1] ?? p} ${p.slice(0, 4)}`;

/** What each part says about the store, in plain words; `money` is the version with amounts (finance.view only). */
function describe(part: HealthPart, inputs: HealthInputs, score: number | null): { text: string; money: string | null } {
  switch (part) {
    case "sales": {
      const s = inputs.sales;
      if (!s) return { text: "Too new to measure against plan", money: null };
      const ahead = s.vs_plan_pct >= 0;
      const months = s.months_under ? ` for ${s.months_under} of ${s.months} month${s.months === 1 ? "" : "s"}` : "";
      return { text: ahead ? `Sales ${pct(s.vs_plan_pct)} ahead of plan` : `Sales ${pct(s.vs_plan_pct)} under plan${months}`, money: null };
    }
    case "payments": {
      const p = inputs.payments;
      if (!p || p.owed <= 0) return { text: "Nothing owed", money: null };
      if (p.overdue <= 0) return { text: "Invoices owed, none overdue yet", money: `${inr(p.owed)} owed, none overdue yet` };
      return { text: `Payments overdue, oldest ${p.oldest_days} days`, money: `${inr(p.overdue)} overdue, oldest ${p.oldest_days} days` };
    }
    case "compliance": {
      const c = inputs.compliance;
      if (!c || score === null) return { text: "Not audited yet", money: null };
      const bits = [
        c.audit_score !== null ? `Audit ${round(c.audit_score, 0)}%` : "No audit yet",
        c.critical_open ? `${c.critical_open} critical action${c.critical_open === 1 ? "" : "s"} open` : "",
        c.overdue_actions ? `${c.overdue_actions} action${c.overdue_actions === 1 ? "" : "s"} overdue` : "",
        c.expired_licences ? `${c.expired_licences} licence${c.expired_licences === 1 ? "" : "s"} expired` : "",
        c.audit_overdue ? "audit overdue" : "",
      ].filter(Boolean);
      return { text: bits.join(", "), money: null };
    }
    case "reporting": {
      const r = inputs.reporting;
      if (r?.feed) {
        const v = r.feed.variance[0];
        if (v) {
          const amounts = v.pos != null && v.reported != null ? ` (POS ${inr(v.pos)}, reported ${inr(v.reported)})` : "";
          return { text: v.pct < 0 ? `${monthLabel(v.period)} sales under-reported by ${pct(v.pct)}${amounts}` : `${monthLabel(v.period)} report ${pct(v.pct)} above POS sales${amounts}`, money: null };
        }
        return { text: r.feed.status === "CONNECTED" ? "POS connected, sales come in daily" : `POS feed stale${r.feed.last_day ? ` since ${r.feed.last_day}` : ""}`, money: null };
      }
      if (!r || !r.due) return { text: "No sales reports due yet", money: null };
      const missing = r.due - r.on_time - r.late;
      return { text: r.on_time === r.due ? "All sales reports on time" : `${r.on_time} of ${r.due} sales reports on time${missing ? `, ${missing} missing` : ""}`, money: null };
    }
    case "customer": {
      const c = inputs.customer;
      if (!c) return { text: "Complaints not tracked yet", money: null };
      return { text: c.open ? `${c.open} complaint${c.open === 1 ? "" : "s"} open` : "No open complaints", money: null };
    }
  }
}

/** Scores a store from its inputs; parts with no data are left out and the rest weighted up. */
export function scoreHealth(inputs: HealthInputs, settings: HealthSettings = DEFAULT_HEALTH): HealthResult {
  const raw: Record<HealthPart, number | null> = {
    sales: inputs.sales ? salesScore(inputs.sales) : null,
    payments: inputs.payments ? paymentsScore(inputs.payments) : null,
    compliance: inputs.compliance ? complianceScore(inputs.compliance) : null,
    reporting: inputs.reporting ? reportingScore(inputs.reporting) : null,
    customer: inputs.customer ? customerScore(inputs.customer) : null,
  };
  const parts: PartResult[] = HEALTH_PARTS.map((part) => ({ part, score: raw[part], weight: Math.max(0, settings.weights[part] ?? 0), detail: describe(part, inputs, raw[part]).text }));
  const scored = parts.filter((p) => p.score !== null && p.weight > 0);
  const total = scored.reduce((a, p) => a + p.weight, 0);
  if (!total) return { score: null, band: null, parts, reasons: [], capped: false };
  const score = Math.round(scored.reduce((a, p) => a + (p.score as number) * p.weight, 0) / total);
  const t = settings.thresholds;
  let band: HealthBand = score >= t.healthy_from ? "HEALTHY" : score >= t.watch_from ? "WATCH" : "AT_RISK";
  const capped = band === "HEALTHY" && scored.some((p) => (p.score as number) < t.part_floor);
  if (capped) band = "WATCH";
  const reasons = [...scored].sort((a, b) => (a.score as number) - (b.score as number)).slice(0, 2).map((p) => {
    const d = describe(p.part, inputs, p.score);
    return { part: p.part, score: p.score as number, text: d.text, money: d.money };
  });
  return { score, band, parts, reasons, capped };
}

/** Tenant settings for the score, with defaults where a value is missing or not a number. */
export function healthSettings(settings: Record<string, unknown>): HealthSettings {
  const w = (settings.health_weights ?? {}) as Record<string, unknown>;
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return {
    weights: Object.fromEntries(HEALTH_PARTS.map((p) => [p, n(w[p], DEFAULT_HEALTH.weights[p])])) as unknown as HealthWeights,
    thresholds: {
      healthy_from: n(settings.health_healthy_from, DEFAULT_HEALTH.thresholds.healthy_from),
      watch_from: n(settings.health_watch_from, DEFAULT_HEALTH.thresholds.watch_from),
      part_floor: n(settings.health_part_floor, DEFAULT_HEALTH.thresholds.part_floor),
    },
  };
}

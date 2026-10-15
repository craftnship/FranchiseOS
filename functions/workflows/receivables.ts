import { Row } from "../common/store";
import { toNum } from "../common/values";
import { separateInstalments } from "./funding";

// What the network is owed, aged by days past the due date. Shared by the owner dashboard and the
// franchisee health score, so both age the same invoices the same way: the agreement's fee (fees.ts),
// instalments that are not that same invoice (funding.ts), and royalty invoices (royalties.ts).

export type AgeBucket = "current" | "d1_30" | "d31_60" | "d61_90" | "d90";
export const AGE_BUCKETS: [AgeBucket, string][] = [["current", "Not yet due"], ["d1_30", "1–30 days"], ["d31_60", "31–60 days"], ["d61_90", "61–90 days"], ["d90", "Over 90 days"]];

export interface Owed { kind: "fee" | "royalty"; amount: number; due: string | null; row: Row }

const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/** Days past due as of `today`; 0 when not yet due or undated. */
export function daysLate(due: string | null, today: string): number {
  return due ? Math.max(0, daysBetween(due, today)) : 0;
}

export function bucketOf(due: string | null, today: string): AgeBucket {
  const late = daysLate(due, today);
  return late <= 0 ? "current" : late <= 30 ? "d1_30" : late <= 60 ? "d31_60" : late <= 90 ? "d61_90" : "d90";
}

/** Every unpaid invoice with its balance and due date. */
export function owedRows(agreements: Row[], instalments: Row[], reports: Row[]): Owed[] {
  return [
    ...agreements.filter((a) => a.fee_status && !["PAID", "VOID"].includes(String(a.fee_status)) && toNum(a.fee_balance) > 0).map((a) => ({ kind: "fee" as const, amount: toNum(a.fee_balance), due: day(a.fee_due_date), row: a })),
    ...separateInstalments(instalments, agreements).filter((i) => i.status === "INVOICED" && toNum(i.invoice_balance) > 0).map((i) => ({ kind: "fee" as const, amount: toNum(i.invoice_balance), due: day(i.invoice_due_date), row: i })),
    ...reports.filter((x) => x.status === "INVOICED" && toNum(x.invoice_balance) > 0).map((x) => ({ kind: "royalty" as const, amount: toNum(x.invoice_balance), due: day(x.invoice_due_date), row: x })),
  ];
}

/** The store an owed item belongs to: its project, else the project opened from the same application (signing fees sit on the agreement). */
export function projectOfOwed(projects: Row[]): (row: Row) => string {
  const byApp = new Map(projects.map((p) => [String(p.application_id), String(p.ROWID)]));
  return (row) => String(row.project_id ?? byApp.get(String(row.application_id)) ?? "");
}

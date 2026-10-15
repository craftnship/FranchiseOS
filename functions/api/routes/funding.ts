import { z } from "zod";
import { AppError } from "../../common/errors";
import { authorize, isPortalUser } from "../../common/rbac";
import { Row } from "../../common/store";
import { toNum } from "../../common/values";
import { agreementFor, changeFunding, ensureSchedule, fundingFor, raiseInstalment, refreshInstalment, refundDeposit, saveInstalment, waiveInstalment } from "../../workflows/funding";
import { FEE_TRIGGERS } from "../../workflows/agreements";
import { Call, parse, Router } from "../router";
import { assertOwner, fetchAll, mustGet, signedUrl, staffCan, storeUpload, uploadSchema } from "./shared";

// Funding and fees of a store. fee.manage keeps the franchise fee schedule (adds, changes, raises
// and waives instalments, records deposit refunds); the franchisee or staff with project.write
// record the loan. Everyone on the project can see both.

const text = (max: number) => z.string().trim().max(max);
const day = z.string().date();
const money = z.number().min(0).max(1e12);
const instalmentSchema = z.object({
  kind: z.enum(["FEE", "DEPOSIT"]), label: text(120).min(2), amount: z.number().positive().max(1e12),
  raise_on: z.enum(FEE_TRIGGERS as [string, ...string[]]), task_code: text(60).nullish(), due_on: day.nullish(),
}).strict();
const feeChangeSchema = z.discriminatedUnion("action", [
  instalmentSchema.extend({ action: z.literal("edit") }).strict(),
  z.object({ action: z.literal("raise") }).strict(),
  z.object({ action: z.literal("refresh") }).strict(),
  z.object({ action: z.literal("waive"), note: text(500).min(3) }).strict(),
  z.object({ action: z.literal("refund"), refunded_on: day, note: text(500).nullish() }).strict(),
]);
const fundingSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("plan"), own_capital: money, loan_amount: money, lender: text(120).nullish(), notes: text(2000).nullish() }).strict(),
  z.object({ action: z.literal("applied"), lender: text(120).min(2), applied_on: day, loan_ref: text(100).nullish() }).strict(),
  z.object({ action: z.literal("sanctioned"), sanctioned_on: day, sanctioned_amount: z.number().positive().max(1e12), interest_pct: z.number().min(0).max(50).nullish(), tenure_months: z.number().int().min(1).max(360).nullish(), letter: uploadSchema.optional() }).strict(),
  z.object({ action: z.literal("rejected"), reason: text(500).min(3) }).strict(),
  z.object({ action: z.literal("disbursed"), amount: z.number().positive().max(1e12), disbursed_on: day, note: text(500).nullish() }).strict(),
]);
const listSchema = z.object({ status: z.enum(["SCHEDULED", "INVOICED", "PAID", "WAIVED", "REFUNDED"]).optional(), kind: z.enum(["FEE", "DEPOSIT"]).optional() });

const today = (call: Call) => call.now.toISOString().slice(0, 10);
const books = async (call: Call) => (await call.zoho().catch(() => null))?.books ?? null;
const getProject = async (call: Call) => await assertOwner(call, await mustGet(call.repo, "franchise_projects", call.params.id, "NOT_FOUND"), "NOT_FOUND");
async function getAgreement(call: Call, project: Row): Promise<Row> {
  const a = await agreementFor(call.repo, project);
  if (!a) throw new AppError("INVALID_TRANSITION", "This store has no signed agreement, so it has no fee schedule.");
  return a;
}
async function getInstalment(call: Call): Promise<Row> {
  const r = await mustGet(call.repo, "fee_instalments", call.params.feeId, "NOT_FOUND");
  if (String(r.project_id) !== call.params.id) throw new AppError("NOT_FOUND");
  return r;
}
const noFuture = (call: Call, value: string, field: string) => {
  if (value > today(call)) throw new AppError("VALIDATION_FAILED", "The date can't be in the future.", { [field]: "can't be in the future" });
};

export function fundingRoutes(r: Router): void {
  // Loans and sanction letters: the franchisee, and staff who manage the project or the money.
  r.on("GET", "/projects/:id/funding", null, async (call) => { await staffCan(call, "finance.view", "project.write"); return fundingFor(call.store, call.ctx, await getProject(call), await books(call), today(call)); });

  r.on("POST", "/projects/:id/fees", "fee.manage", async (call) => {
    const project = await getProject(call);
    return saveInstalment(call.store, call.ctx, project, await getAgreement(call, project), parse(instalmentSchema, call.body) as never);
  }, 201);

  r.on("PATCH", "/projects/:id/fees/:feeId", "fee.manage", async (call) => {
    const project = await getProject(call);
    const agreement = await getAgreement(call, project);
    const row = await getInstalment(call);
    const b = parse(feeChangeSchema, call.body);
    switch (b.action) {
      case "edit": { const { action: _a, ...input } = b; return saveInstalment(call.store, call.ctx, project, agreement, input as never, row); }
      case "raise": return raiseInstalment(call.store, call.ctx, await books(call), project, agreement, row, call.now);
      case "refresh": {
        const bk = await books(call);
        if (!bk) throw new AppError("ZOHO_SYNC_FAILED", "Zoho Books is not connected for this tenant.");
        return refreshInstalment(call.store, call.ctx, bk, row, agreement);
      }
      case "waive": return waiveInstalment(call.store, call.ctx, project, row, b.note);
      case "refund": noFuture(call, b.refunded_on, "refunded_on"); return refundDeposit(call.store, call.ctx, project, row, b.refunded_on, b.note ?? null);
    }
  });

  // The franchisee's own capital and loan: the franchisee (portal) or staff with project.write.
  r.on("PATCH", "/projects/:id/funding", null, async (call) => {
    const project = await getProject(call);
    const portal = isPortalUser(call.ctx);
    if (!portal) await authorize(call.ctx, "project.write", call.permissions);
    if (project.status === "CLOSED") throw new AppError("INVALID_TRANSITION", "This project is closed.");
    const b = parse(fundingSchema, call.body);
    for (const [k, v] of Object.entries(b)) if (k.endsWith("_on")) noFuture(call, String(v), k);
    if (b.action === "sanctioned") {
      const { letter, ...rest } = b;
      const sanction_ref = letter ? await storeUpload(call, `projects/${call.params.id}/funding`, letter) : null;
      return changeFunding(call.store, call.ctx, project, { ...rest, sanction_ref }, portal ? "PORTAL" : "STAFF");
    }
    return changeFunding(call.store, call.ctx, project, b, portal ? "PORTAL" : "STAFF");
  });

  r.on("GET", "/projects/:id/funding/sanction-letter", null, async (call) => {
    await staffCan(call, "finance.view", "project.write");
    const project = await getProject(call);
    const plan = await call.repo.findOne("funding_plans", { project_id: String(project.ROWID) });
    return signedUrl(call, String(plan?.sanction_ref ?? ""), "No sanction letter attached.");
  });

  // Network view for finance: every instalment with its store and franchisee.
  r.on("GET", "/fees", "finance.view", async (call) => {
    const q = parse(listSchema, call.query);
    const where: Record<string, string> = { ...(q.status ? { status: q.status } : {}), ...(q.kind ? { kind: q.kind } : {}) };
    const [projects, franchisees, agreements] = await Promise.all([fetchAll(call.repo, "franchise_projects", {}), call.repo.findMany("franchisees", {}, { limit: 300 }), fetchAll(call.repo, "agreements", { status: "SIGNED" })]);
    // Stores nobody has opened since schedules began get theirs now; signing invoices follow their agreement.
    const amap = new Map(agreements.map((a) => [String(a.application_id), a]));
    const scheduled = new Set((await fetchAll(call.repo, "fee_instalments", {})).map((x) => String(x.project_id)));
    for (const p of projects) if (p.status !== "CLOSED" && !scheduled.has(String(p.ROWID))) await ensureSchedule(call.store, call.ctx, p, amap.get(String(p.application_id)) ?? null);
    const byId = new Map(agreements.map((a) => [String(a.ROWID), a]));
    const rows = await Promise.all((await fetchAll(call.repo, "fee_instalments", where)).map((x) => refreshInstalment(call.store, call.ctx, null, x, byId.get(String(x.agreement_id)) ?? null)));
    const pmap = new Map(projects.map((p) => [String(p.ROWID), p]));
    const fmap = new Map(franchisees.map((f) => [String(f.ROWID), f]));
    const t = today(call);
    const items: Row[] = rows.map((x) => {
      const p = pmap.get(String(x.project_id));
      const f = fmap.get(String(x.franchisee_id ?? p?.franchisee_id));
      const overdue = x.status === "INVOICED" && !!x.invoice_due_date && String(x.invoice_due_date).slice(0, 10) < t && toNum(x.invoice_balance) > 0;
      return { ...x, overdue, project_code: p?.project_code ?? null, project_status: p?.status ?? null, franchisee: f ? f.display_name ?? f.franchise_code : null } as Row;
    }).sort((a, b) => String(a.project_code).localeCompare(String(b.project_code)) || toNum(a.seq) - toNum(b.seq));
    const sum = (f: (r: Row) => boolean, k = "amount") => Math.round(items.filter(f).reduce((a, r) => a + toNum(r[k]), 0) * 100) / 100;
    return {
      items,
      totals: {
        scheduled: sum((i) => i.status === "SCHEDULED"), outstanding: sum((i) => i.status === "INVOICED", "invoice_balance"),
        collected: sum((i) => i.status === "PAID", "invoice_total") + sum((i) => i.status === "INVOICED", "invoice_total") - sum((i) => i.status === "INVOICED", "invoice_balance"),
        overdue: items.filter((i) => i.overdue).length, deposits_held: sum((i) => i.kind === "DEPOSIT" && i.status === "PAID"),
      },
    };
  });
}

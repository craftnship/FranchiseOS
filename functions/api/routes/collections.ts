import { z } from "zod";
import { logActivity } from "../../common/audit";
import { AppError } from "../../common/errors";
import { Row } from "../../common/store";
import { toBool, toNum } from "../../common/values";
import {
  addContactNote, collectionSources, collectionsSettings, DEFAULT_LADDER, describeCollection, disputeCollection, LADDER_ROLES, normaliseLadder, OPEN_COLLECTION, PAYMENT_MODES,
  paymentBehaviour, promiseToPay, recordCollectionPayment, remindNow, resumeCollection, stepDue, syncCollections,
} from "../../workflows/collections";
import { daysLate } from "../../workflows/receivables";
import { Call, parse, Router } from "../router";
import { storeNamer } from "./owner";
import { fetchAll, settings as settingsOf } from "./shared";

// Collections (docs/collections.md): finance's worklist of unpaid invoices and what was done about each,
// the ladder under Settings, and the actions that move an item along.

const listSchema = z.object({ status: z.enum(["", "OPEN", "PROMISED", "DISPUTED", "PAID", "overdue", "escalated"]).optional() }).passthrough();
const promiseSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().trim().max(500).optional().nullable() }).strict();
const noteSchema = z.object({ note: z.string().trim().min(1).max(500) }).strict();
const reasonSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const resumeSchema = z.object({ note: z.string().trim().max(500).optional().nullable() }).strict();
const paymentSchema = z.object({
  amount: z.number().positive(), paid_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), mode: z.enum(PAYMENT_MODES),
  reference: z.string().trim().max(100).optional().nullable(), note: z.string().trim().max(300).optional().nullable(),
}).strict();
const ladderSchema = z.object({
  ladder: z.array(z.object({ days: z.number().int().min(-365).max(365), franchisee: z.boolean(), roles: z.array(z.string()).max(5), flag: z.boolean().optional() }).strict()).min(1).max(10),
}).strict();

const today = (call: Call) => call.now.toISOString().slice(0, 10);
const books = async (call: Call) => (await call.zoho().catch(() => null))?.books ?? null;

/** The step label the screen shows: "Due in 3 days", "Due today", "7 days late". */
export const ageLabel = (due: unknown, t: string): string => {
  if (!due) return "No due date";
  const late = daysLate(String(due).slice(0, 10), t);
  if (late > 0) return `${late} day${late === 1 ? "" : "s"} late`;
  const left = Math.round((Date.parse(`${String(due).slice(0, 10)}T00:00:00Z`) - Date.parse(`${t}T00:00:00Z`)) / 86_400_000);
  return left === 0 ? "Due today" : `Due in ${left} day${left === 1 ? "" : "s"}`;
};

export function collectionRoutes(r: Router): void {
  r.on("GET", "/collections", "finance.view", async (call) => {
    const q = parse(listSchema, call.query);
    const t = today(call);
    const src = await collectionSources(call.repo);
    await syncCollections(call.store, call.ctx, t, src);
    const [sites, territories, apps, franchisees, tenant] = await Promise.all([
      fetchAll(call.repo, "sites"), fetchAll(call.repo, "territories"), fetchAll(call.repo, "franchise_applications"), fetchAll(call.repo, "franchisees"), call.store.findOne("tenants", { ROWID: call.ctx.tenantId }),
    ]);
    const { ladder } = collectionsSettings(tenant);
    const place = storeNamer(src.projects, sites, territories, apps, franchisees);
    const frOf = new Map(franchisees.map((f) => [String(f.ROWID), f]));
    const rows = await fetchAll(call.repo, "collections");
    const items = rows.map((c) => {
      const open = OPEN_COLLECTION.includes(String(c.status));
      const late = open ? daysLate(c.due_date ? String(c.due_date).slice(0, 10) : null, t) : 0;
      const fr = frOf.get(String(c.franchisee_id));
      const p = src.projects.find((x) => String(x.ROWID) === String(c.project_id));
      return {
        ...c, what: describeCollection(c), store: c.project_id ? place(c.project_id).name : "Agreement", project_code: p?.project_code ?? null, franchisee: fr ? String(fr.display_name ?? fr.franchise_code) : null,
        days_late: late, age: open ? ageLabel(c.due_date, t) : c.status === "PAID" ? `Paid ${c.paid_on ?? ""}`.trim() : "Closed", overdue: open && late > 0,
        step_due: open ? stepDue(ladder, c.due_date ? String(c.due_date).slice(0, 10) : null, t) : -1, escalated: toBool(c.escalated), promise_broken: toBool(c.promise_broken),
      } as Row;
    });
    const wanted = items.filter((i) => {
      switch (q.status ?? "") {
        case "": return OPEN_COLLECTION.includes(String(i.status));
        case "overdue": return i.overdue;
        case "escalated": return i.escalated && OPEN_COLLECTION.includes(String(i.status));
        default: return i.status === q.status;
      }
    }).sort((a, b) => toNum(b.days_late) - toNum(a.days_late) || toNum(b.amount) - toNum(a.amount));
    const open = items.filter((i) => OPEN_COLLECTION.includes(String(i.status)));
    const sum = (rows: Row[]) => Math.round(rows.reduce((a, x) => a + toNum(x.amount), 0) * 100) / 100;
    const behaviour = paymentBehaviour(src.agreements, src.instalments, src.reports, t);
    return {
      items: wanted, ladder,
      totals: {
        open: sum(open), overdue: sum(open.filter((i) => i.overdue)), count: open.length, overdue_count: open.filter((i) => i.overdue).length,
        escalated: open.filter((i) => i.escalated).length, promised: open.filter((i) => i.status === "PROMISED").length, broken: open.filter((i) => i.promise_broken).length, disputed: open.filter((i) => i.status === "DISPUTED").length,
        rate_pct: behaviour.rate_pct, days_to_pay: behaviour.days_to_pay, billed_90d: behaviour.billed, collected_90d: behaviour.collected,
      },
    };
  });

  r.on("POST", "/collections/:id/promise", "collections.manage", async (call) => {
    const b = parse(promiseSchema, call.body);
    if (b.date < today(call)) throw new AppError("VALIDATION_FAILED", "A promise is for a day that has not passed.", { date: "in the past" });
    return promiseToPay(call.store, call.ctx, call.params.id, b.date, b.note ?? null);
  });
  r.on("POST", "/collections/:id/note", "collections.manage", async (call) => addContactNote(call.store, call.ctx, call.params.id, parse(noteSchema, call.body).note));
  r.on("POST", "/collections/:id/dispute", "collections.manage", async (call) => disputeCollection(call.store, call.ctx, call.params.id, parse(reasonSchema, call.body).reason));
  r.on("POST", "/collections/:id/resume", "collections.manage", async (call) => resumeCollection(call.store, call.ctx, call.params.id, parse(resumeSchema, call.body).note ?? null));
  r.on("POST", "/collections/:id/remind", "collections.manage", async (call) => remindNow(call.store, call.ctx, call.params.id, today(call), call.now));
  r.on("POST", "/collections/:id/payment", "collections.manage", async (call) => {
    const b = parse(paymentSchema, call.body);
    if (b.paid_on > today(call)) throw new AppError("VALIDATION_FAILED", "The payment date cannot be in the future.", { paid_on: "in the future" });
    return recordCollectionPayment(call.store, call.ctx, await books(call), call.params.id, { amount: b.amount, paid_on: b.paid_on, mode: b.mode, reference: b.reference ?? null, note: b.note ?? null }, call.now);
  });

  const view = (tenant: Row | null) => ({ ...collectionsSettings(tenant), roles: LADDER_ROLES, defaults: { ladder: DEFAULT_LADDER } });
  r.on("GET", "/settings/collections", "settings.manage", async (call) => view(await call.store.findOne("tenants", { ROWID: call.ctx.tenantId })));
  r.on("PUT", "/settings/collections", "settings.manage", async (call) => {
    const b = parse(ladderSchema, call.body);
    const ladder = normaliseLadder(b.ladder);
    if (!ladder.length) throw new AppError("VALIDATION_FAILED", "Each step needs the franchisee or at least one role.", { ladder: "nobody to tell" });
    const tenant = await call.store.findOne("tenants", { ROWID: call.ctx.tenantId });
    if (!tenant) throw new AppError("TENANT_NOT_FOUND");
    const s = settingsOf(tenant);
    s.collections = { ...((s.collections as Record<string, unknown>) ?? {}), ladder };
    await call.store.update("tenants", call.ctx.tenantId, { settings_json: JSON.stringify(s) });
    await logActivity(call.store, call.ctx, { entityType: "tenant", entityId: call.ctx.tenantId, action: "settings:collections", metadata: { ladder } });
    return view(await call.store.findOne("tenants", { ROWID: call.ctx.tenantId }));
  });
}

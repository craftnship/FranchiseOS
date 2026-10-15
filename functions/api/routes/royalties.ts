import { z } from "zod";
import { logActivity } from "../../common/audit";
import { AppError } from "../../common/errors";
import { authorize, isPortalUser } from "../../common/rbac";
import { Row } from "../../common/store";
import { toNum } from "../../common/values";
import { attachVariance, posSettings } from "../../workflows/posSales";
import { approveReport, periodLabel, refreshReport, returnReport, royaltyLedger, submitReport } from "../../workflows/royalties";
import { Call, parse, Router } from "../router";
import { assertOwner, fetchAll, mustGet, signedUrl, storeUpload, uploadSchema } from "./shared";
import { regionScope } from "./regions";

// Monthly sales and royalties of opened stores. The franchisee (or finance on their behalf) reports
// a month; royalty.manage approves it into a Books invoice or returns it with a note.

const money = z.coerce.number().min(0).max(1e12);
const salesSchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "use YYYY-MM"),
  gross_sales: money,
  net_sales: money,
  transactions: z.coerce.number().int().min(0).max(1e9).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  report: uploadSchema.optional(),
}).strict();
const pct = z.coerce.number().min(0).max(50);
const ratesSchema = z.object({ royalty_pct: pct, marketing_fund_pct: pct }).strict();
const returnSchema = z.object({ note: z.string().trim().min(3).max(1000) }).strict();
const listSchema = z.object({ status: z.enum(["SUBMITTED", "RETURNED", "INVOICED", "PAID"]).optional(), period: z.string().regex(/^\d{4}-\d{2}$/).optional() });

const today = (call: Call) => call.now.toISOString().slice(0, 10);
const getProject = async (call: Call) => await assertOwner(call, await mustGet(call.repo, "franchise_projects", call.params.id, "NOT_FOUND"), "NOT_FOUND");
async function getReport(call: Call): Promise<Row> {
  const r = await mustGet(call.repo, "sales_reports", call.params.reportId, "NOT_FOUND");
  if (String(r.project_id) !== call.params.id) throw new AppError("NOT_FOUND");
  return r;
}

export function royaltyRoutes(r: Router): void {
  r.on("GET", "/projects/:id/royalties", null, async (call) => royaltyLedger(call.store, call.ctx, await getProject(call), today(call)));

  r.on("POST", "/projects/:id/sales", null, async (call) => {
    const project = await getProject(call);
    const portal = isPortalUser(call.ctx);
    if (portal && !call.ctx.roles.some((x) => x === "FRANCHISEE" || x === "FRANCHISEE_STAFF")) throw new AppError("ACCESS_DENIED", "Only the franchisee reports sales.");
    if (!portal) await authorize(call.ctx, "royalty.manage", call.permissions);
    const { report, ...body } = parse(salesSchema, call.body);
    const file_ref = report ? await storeUpload(call, `projects/${call.params.id}/sales`, report) : undefined;
    const row = await submitReport(call.store, call.ctx, project, { ...body, file_ref }, today(call), portal ? "PORTAL" : "STAFF");
    // The POS figure beside it, when the store has a feed.
    return attachVariance(call.store, call.ctx, project, row, today(call));
  }, 201);

  r.on("GET", "/projects/:id/sales/:reportId/file", null, async (call) => {
    await getProject(call);
    return signedUrl(call, String((await getReport(call)).file_ref ?? ""), "No sales report attached.");
  });

  r.on("POST", "/projects/:id/sales/:reportId/approve", "royalty.manage", async (call) => {
    const project = await getProject(call);
    const books = (await call.zoho().catch(() => null))?.books ?? null;
    return approveReport(call.store, call.ctx, books, project, await getReport(call), call.now);
  });

  r.on("POST", "/projects/:id/sales/:reportId/return", "royalty.manage", async (call) => {
    await getProject(call);
    return returnReport(call.store, call.ctx, await getReport(call), parse(returnSchema, call.body).note);
  });

  r.on("POST", "/projects/:id/sales/:reportId/refresh", "royalty.manage", async (call) => {
    await getProject(call);
    const books = (await call.zoho().catch(() => null))?.books;
    if (!books) throw new AppError("ZOHO_SYNC_FAILED", "Zoho Books is not connected for this tenant.");
    return refreshReport(call.store, call.ctx, books, await getReport(call));
  });

  r.on("PATCH", "/projects/:id/royalty-rates", "royalty.manage", async (call) => {
    const project = await getProject(call);
    const b = parse(ratesSchema, call.body);
    const row = await call.repo.update("franchise_projects", String(project.ROWID), b);
    await logActivity(call.store, call.ctx, {
      entityType: "project", entityId: String(project.ROWID), action: "royalty:rates",
      metadata: { from: { royalty_pct: project.royalty_pct ?? null, marketing_fund_pct: project.marketing_fund_pct ?? null }, to: b },
    });
    return row;
  });

  // Network view for finance: every report, newest month first, with its store and franchisee.
  r.on("GET", "/royalties", "dashboard.view", async (call) => {
    const q = parse(listSchema, call.query);
    const where: Record<string, string> = {};
    if (q.status) where.status = q.status;
    if (q.period) where.period = q.period;
    const [scope, allReports, allProjects, franchisees, tenant] = await Promise.all([
      regionScope(call), fetchAll(call.repo, "sales_reports", where), fetchAll(call.repo, "franchise_projects", { status: "OPENED" }), call.repo.findMany("franchisees", {}, { limit: 300 }), call.store.findOne("tenants", { ROWID: call.ctx.tenantId }),
    ]);
    const pos = posSettings(tenant);
    const projects = allProjects.filter(scope.project), reports = allReports.filter((x) => scope.projectId(x.project_id));
    const pmap = new Map(projects.map((p) => [String(p.ROWID), p]));
    const fmap = new Map(franchisees.map((f) => [String(f.ROWID), f]));
    const items: Row[] = reports.map((x) => {
      const p = pmap.get(String(x.project_id));
      const f = fmap.get(String(x.franchisee_id ?? p?.franchisee_id));
      return { ...x, label: periodLabel(String(x.period)), project_code: p?.project_code ?? null, franchisee: f ? f.display_name ?? f.franchise_code : null } as Row;
    }).sort((a, b) => String(b.period).localeCompare(String(a.period)) || String(a.project_code).localeCompare(String(b.project_code)));
    const sum = (k: string, f: (r: Row) => boolean) => Math.round(items.filter(f).reduce((a, r) => a + toNum(r[k]), 0) * 100) / 100;
    return {
      items, basis: pos.royalty_basis, tolerance_pct: pos.pos_variance_tolerance_pct,
      totals: {
        stores: projects.length, waiting: items.filter((i) => i.status === "SUBMITTED").length, strayed: items.filter((i) => i.status === "SUBMITTED" && i.variance_pct != null && Math.abs(toNum(i.variance_pct)) > pos.pos_variance_tolerance_pct).length,
        invoiced: sum("royalty_amount", (i) => i.status === "INVOICED" || i.status === "PAID") + sum("marketing_amount", (i) => i.status === "INVOICED" || i.status === "PAID"),
        outstanding: sum("invoice_balance", (i) => i.status === "INVOICED"),
      },
    };
  });
}

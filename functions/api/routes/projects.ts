import { z } from "zod";
import { AppError } from "../../common/errors";
import { authorize } from "../../common/rbac";
import { Row } from "../../common/store";
import { syncProjectTasks } from "../../workflows/projectSync";
import { computeReadiness, refreshReadiness, setChecklistBlocked, updateChecklistItem } from "../../workflows/readiness";
import { transitionsFrom } from "../../workflows/stateMachines";
import { activateOnOpening } from "../../workflows/agreements";
import { refreshFee } from "../../workflows/fees";
import { transitionEntity } from "../../workflows/transition";
import { assertDesignApproved, assertSnagsCleared, FITOUT_TASK } from "../../workflows/construction";
import { assertLicencesReady, ensureLicences, LICENCE_STATES, updateLicence } from "../../workflows/licences";
import { logActivity } from "../../common/audit";
import { describeLease, leaseForSite } from "../../workflows/leases";
import { projectForecast } from "../../workflows/forecast";
import { capexFor, OTHER, recordSpend, setBudget, syncBills, updateSpend } from "../../workflows/capex";
import { randomUUID } from "crypto";
import { Call, page, parse, Router } from "../router";
import { isPortalUser } from "../../common/rbac";
import { assertOwner, fetchAll, listByStatus, mustGet, ownerFilter, PORTAL_ROLES, signedUrl, staffDirectory, storeUpload, uploadSchema } from "./shared";

const today = (call: Call) => call.now.toISOString().slice(0, 10);
const OPEN_PROJECT = ["NOT_STARTED", "PLANNING", "IN_PROGRESS", "AT_RISK", "READY_FOR_OPENING"];

/** An opening is delayed when its target date has passed and the store has not opened. */
export function isDelayed(p: Row, todayIso: string): boolean {
  return OPEN_PROJECT.includes(String(p.status)) && !!p.target_opening_date && String(p.target_opening_date).slice(0, 10) < todayIso;
}

const listQuery = page.extend({
  status: z.string().optional(),
  rag: z.enum(["GREEN", "AMBER", "RED"]).optional(),
  risk_level: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  delayed: z.enum(["true", "false"]).optional(),
});

const blockSchema = z.object({ blocked: z.boolean(), reason: z.string().trim().max(1000).optional() }).strict();
const changeSchema = z.object({
  done: z.boolean().optional(),
  owner_user_id: z.string().min(1).nullable().optional(),
  due_date: z.string().date().optional(),
  depends_on: z.array(z.string().min(1).max(60)).max(50).optional(),
  duration_days: z.number().int().min(0).max(730).optional(),
}).strict().refine((b) => Object.keys(b).length > 0, "Nothing to change.");

const date = z.string().date().nullable().optional();
const licenceSchema = z.object({
  status: z.enum(LICENCE_STATES).optional(),
  licence_number: z.string().trim().max(100).nullable().optional(),
  applied_on: date, issued_on: date, expires_on: date,
  notes: z.string().trim().max(2000).nullable().optional(),
  owner_user_id: z.string().min(1).nullable().optional(),
}).strict().refine((b) => Object.keys(b).length > 0, "Nothing to change.");
const newLicenceSchema = z.object({ name: z.string().trim().min(2).max(200), authority: z.string().trim().max(200).optional(), mandatory: z.boolean().default(false) }).strict();

const budgetSchema = z.object({ budget: z.number().nonnegative().max(1e10).optional(), notes: z.string().trim().max(2000).nullable().optional() }).strict().refine((b) => Object.keys(b).length > 0, "Nothing to change.");
const spendSchema = z.object({
  category: z.string().min(1).max(40), vendor: z.string().trim().min(2).max(200), spend_date: z.string().date(), amount: z.number().positive().max(1e10),
  reference: z.string().trim().max(100).optional(), notes: z.string().trim().max(2000).optional(), invoice: uploadSchema.optional(),
}).strict();
const spendChangeSchema = z.object({ category: z.string().min(1).max(40).optional(), void: z.literal(true).optional(), notes: z.string().trim().max(2000).nullable().optional() }).strict().refine((b) => Object.keys(b).length > 0, "Nothing to change.");

async function getSpend(call: Call): Promise<Row> {
  const s = await mustGet(call.repo, "capex_spend", call.params.spendId, "NOT_FOUND");
  if (String(s.project_id) !== call.params.id) throw new AppError("NOT_FOUND");
  return s;
}

async function getLicence(call: Call): Promise<Row> {
  const l = await mustGet(call.repo, "licences", call.params.licId, "NOT_FOUND");
  if (String(l.project_id) !== call.params.id) throw new AppError("NOT_FOUND");
  return l;
}

/** The tasks a task waits for must be other tasks of the project, without making a loop. */
async function checkDependencies(call: Call, codes: string[]): Promise<void> {
  const rows = await call.repo.findMany("opening_checklists", { project_id: call.params.id }, { limit: 300 });
  const item = rows.find((r) => String(r.ROWID) === call.params.itemId);
  if (!item) throw new AppError("NOT_FOUND", "Checklist item not found.");
  const code = String(item.task_code ?? item.ROWID);
  const known = new Set(rows.map((r) => String(r.task_code ?? r.ROWID)));
  const bad = codes.filter((c) => c === code || !known.has(c));
  if (bad.length) throw new AppError("VALIDATION_FAILED", "A task can only wait for other tasks of this project.", { depends_on: bad.join(", ") });
  const trial = rows.map((r) => (String(r.ROWID) === call.params.itemId ? { ...r, depends_on_json: JSON.stringify(codes) } : r));
  const { cycle } = projectForecast({}, trial, today(call));
  if (cycle.includes(code)) throw new AppError("VALIDATION_FAILED", "That would make the tasks wait for each other in a loop.", { depends_on: "loop" });
}

async function getProject(call: Call): Promise<Row> {
  return assertOwner(call, await mustGet(call.repo, "franchise_projects", call.params.id, "NOT_FOUND"), "NOT_FOUND");
}

/**
 * The franchise fee invoice behind a project, refreshed from Books and stored on the agreement
 * (fees.ts). An unpaid fee is a warning only; it never blocks work. Null when there is no invoice;
 * when Books is unreachable the last stored state comes back with stale: true.
 */
async function feeStatus(call: Call, project: Row): Promise<Row | null> {
  const agreement = (await call.repo.findMany("agreements", { application_id: String(project.application_id), status: "SIGNED" }, { limit: 1 }))[0];
  if (!agreement?.zoho_books_invoice_id) return null;
  const shape = (a: Row, inv?: { number: string }) => ({
    invoice_id: a.zoho_books_invoice_id, invoice_number: inv?.number ?? null, status: a.fee_status ? String(a.fee_status) : "unknown",
    total: a.fee_total, balance: a.fee_balance, due_date: a.fee_due_date, paid_on: a.fee_paid_on, paid: a.fee_status === "PAID", checked_at: a.fee_checked_at,
  });
  try {
    const zoho = await call.zoho();
    if (!zoho?.books) return { ...shape(agreement), stale: true };
    const r = await refreshFee(call.store, call.ctx, zoho.books, zoho.crm, agreement, call.now);
    return shape(r.agreement, r.invoice);
  } catch {
    return { ...shape(agreement), stale: true };
  }
}

export function projectRoutes(r: Router): void {
  r.on("GET", "/projects", null, async (call) => {
    const q = parse(listQuery, call.query);
    const where = { ...(q.rag ? { readiness_rag: q.rag } : {}), ...(q.risk_level ? { risk_level: q.risk_level } : {}), ...ownerFilter(call) };
    if (q.delayed !== "true") return listByStatus(call.repo, "franchise_projects", q.status, where, q);
    // Delayed is derived from dates, so it filters the open projects in code.
    const rows = (await Promise.all(OPEN_PROJECT.map((s) => fetchAll(call.repo, "franchise_projects", { ...where, status: s })))).flat();
    return rows.filter((p) => isDelayed(p, today(call))).slice(q.offset, q.offset + q.limit);
  });

  r.on("GET", "/projects/:id", null, async (call) => {
    const project = await getProject(call);
    const checklist = await call.repo.findMany("opening_checklists", { project_id: call.params.id }, { orderBy: "due_date", limit: 300 });
    const perms = call.ctx.roles.includes("SUPER_ADMIN") ? null : await call.permissions(call.ctx.roles);
    const allowed = transitionsFrom("project", String(project.status)).filter((t) => !perms || !t.permission || perms.has(t.permission)).map((t) => t.transition);
    // Staff see who owns each task and who it can be given to; portal users see neither.
    const people = isPortalUser(call.ctx) ? null : await staffDirectory(call);
    const person = (id: unknown) => { const p = id ? people?.get(String(id)) : undefined; return p ? { ROWID: p.ROWID, name: p.name, email: p.email } : null; };
    return {
      ...project, delayed: isDelayed(project, today(call)), allowed_transitions: allowed,
      checklist: people ? checklist.map((i) => ({ ...i, owner: person(i.owner_user_id) })) : checklist,
      ...(people ? { staff: [...people.values()].filter((p) => p.active && !PORTAL_ROLES.includes(p.role)).map(({ ROWID, name, email }) => ({ ROWID, name, email })).sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email)) } : {}),
      fee: await feeStatus(call, project),
      licences: await ensureLicences(call.store, call.ctx, project),
      lease: project.site_id ? await describeLease(call.store, call.ctx, await leaseForSite(call.store, call.ctx, String(project.site_id)), String(project.site_id), today(call)) : null,
    };
  });

  // Licence register: staff record status, numbers and dates; the franchisee can upload certificates.
  r.on("PATCH", "/projects/:id/licences/:licId", "project.write", async (call) => {
    await getProject(call);
    const body = parse(licenceSchema, call.body);
    return updateLicence(call.store, call.ctx, await getLicence(call), body, today(call));
  });

  r.on("POST", "/projects/:id/licences", "project.write", async (call) => {
    const project = await getProject(call);
    const body = parse(newLicenceSchema, call.body);
    const code = `CUSTOM_${randomUUID().slice(0, 8).toUpperCase()}`;
    const row = await call.repo.insert("licences", { ...body, project_id: call.params.id, franchisee_id: project.franchisee_id ?? null, licence_code: code, status: "NOT_STARTED", licence_key: `${call.ctx.tenantId}:${call.params.id}:${code}` });
    await logActivity(call.store, call.ctx, { entityType: "licence", entityId: String(row.ROWID), action: "create", metadata: { project_id: call.params.id, name: body.name } });
    return row;
  }, 201);

  r.on("POST", "/projects/:id/licences/:licId/certificate", null, async (call) => {
    await getProject(call); // portal users only reach their own project
    if (!isPortalUser(call.ctx)) await authorize(call.ctx, "project.write", call.permissions);
    const licence = await getLicence(call);
    const file_ref = await storeUpload(call, `projects/${call.params.id}/licences`, parse(uploadSchema, call.body));
    return updateLicence(call.store, call.ctx, licence, { file_ref }, today(call));
  }, 201);

  r.on("GET", "/projects/:id/licences/:licId/certificate", null, async (call) => {
    await getProject(call);
    return signedUrl(call, String((await getLicence(call)).file_ref ?? ""), "No certificate uploaded.");
  });

  // Capex budget vs actual. Everyone on the project sees it; staff set budgets and recategorise; the
  // franchisee records spend with an invoice; Books bills arrive by sync.
  r.on("GET", "/projects/:id/capex", null, async (call) => {
    const project = await getProject(call);
    const { summary, lines, spend } = await capexFor(call.store, call.ctx, project);
    const books = await call.zoho().then((z) => !!z?.books?.listBills).catch(() => false);
    return { ...summary, lines, spend, books_connected: books, project_code: project.project_code };
  });

  r.on("PATCH", "/projects/:id/capex/lines/:lineId", "project.write", async (call) => {
    const project = await getProject(call);
    const line = await mustGet(call.repo, "capex_lines", call.params.lineId, "NOT_FOUND");
    if (String(line.project_id) !== call.params.id) throw new AppError("NOT_FOUND");
    return setBudget(call.store, call.ctx, project, line, parse(budgetSchema, call.body));
  });

  r.on("POST", "/projects/:id/capex/spend", null, async (call) => {
    const project = await getProject(call);
    const portal = isPortalUser(call.ctx);
    if (!portal) await authorize(call.ctx, "project.write", call.permissions);
    const { invoice, ...body } = parse(spendSchema, call.body);
    if (body.spend_date > today(call)) throw new AppError("VALIDATION_FAILED", "The date can't be in the future.", { spend_date: "can't be in the future" });
    if (portal && !invoice) throw new AppError("VALIDATION_FAILED", "Attach the invoice.", { invoice: "required" });
    const file_ref = invoice ? await storeUpload(call, `projects/${call.params.id}/capex`, invoice) : undefined;
    return recordSpend(call.store, call.ctx, project, { ...body, category: body.category || OTHER, file_ref }, portal ? "PORTAL" : "MANUAL");
  }, 201);

  r.on("PATCH", "/projects/:id/capex/spend/:spendId", "project.write", async (call) => {
    const project = await getProject(call);
    return updateSpend(call.store, call.ctx, project, await getSpend(call), parse(spendChangeSchema, call.body));
  });

  r.on("GET", "/projects/:id/capex/spend/:spendId/invoice", null, async (call) => {
    await getProject(call);
    return signedUrl(call, String((await getSpend(call)).file_ref ?? ""), "No invoice attached.");
  });

  r.on("POST", "/projects/:id/capex/sync", "project.write", async (call) => {
    const project = await getProject(call);
    const books = (await call.zoho().catch(() => null))?.books;
    if (!books?.listBills) throw new AppError("ZOHO_SYNC_FAILED", "Zoho Books is not connected for this tenant.");
    try {
      return await syncBills(call.store, call.ctx, books, project);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError("ZOHO_SYNC_FAILED", "Couldn't read bills from Zoho Books. The Books connection may need the bills permission (ZohoBooks.bills.READ).");
    }
  });

  // Live readiness from the checklist (§20, D-7); nothing is written.
  r.on("GET", "/projects/:id/readiness", null, async (call) => {
    await getProject(call);
    return computeReadiness(call.store, call.ctx, call.params.id, today(call));
  });

  r.on("GET", "/projects/:id/readiness/history", null, async (call) => {
    await getProject(call);
    return call.repo.findMany("readiness_snapshots", { project_id: call.params.id }, { orderBy: "taken_at", desc: true, limit: 90 });
  });

  // Moves the target opening date (e.g. to the forecast). Zoho Projects keeps its own end date.
  r.on("POST", "/projects/:id/target", "project.write", async (call) => {
    const project = await getProject(call);
    const body = parse(z.object({ target_opening_date: z.string().date(), reason: z.string().trim().min(3).max(1000) }).strict(), call.body);
    if (["OPENED", "CLOSED"].includes(String(project.status))) throw new AppError("INVALID_TRANSITION", "The store has already opened.");
    if (body.target_opening_date < today(call)) throw new AppError("VALIDATION_FAILED", "The target can't be in the past.", { target_opening_date: "in the past" });
    const from = project.target_opening_date ? String(project.target_opening_date).slice(0, 10) : null;
    await call.repo.update("franchise_projects", call.params.id, { target_opening_date: body.target_opening_date, forecast_alerted_on: null });
    await logActivity(call.store, call.ctx, { entityType: "project", entityId: call.params.id, action: "project:retarget", metadata: { from, to: body.target_opening_date, reason: body.reason } });
    return refreshReadiness(call.store, call.ctx, call.params.id, { today: today(call), now: call.now, onTransition: call.onTransition });
  });

  // Pulls task progress from Zoho Projects (when connected), then stores readiness and risk.
  r.on("POST", "/projects/:id/sync", "project.write", async (call) => {
    const project = await getProject(call);
    const projects = (await call.zoho())?.projects;
    let sync: unknown = null;
    if (project.zoho_project_id) {
      if (!projects) throw new AppError("ZOHO_SYNC_FAILED", "Zoho Projects is not connected for this tenant.");
      sync = await syncProjectTasks(call.store, call.ctx, projects, call.params.id);
    }
    const readiness = await refreshReadiness(call.store, call.ctx, call.params.id, { today: today(call), now: call.now, onTransition: call.onTransition });
    return { sync, readiness };
  });

  // Flag or clear a blocker ({blocked, reason}), or mark done / reopen, assign and reschedule.
  r.on("PATCH", "/projects/:id/checklist/:itemId", "project.write", async (call) => {
    const project = await getProject(call);
    const raw = (call.body ?? {}) as Record<string, unknown>;
    let item: Row;
    let zoho = false;
    if ("blocked" in raw) {
      const body = parse(blockSchema, raw);
      item = await setChecklistBlocked(call.store, call.ctx, call.params.id, call.params.itemId, body.blocked, body.reason);
    } else {
      const body = parse(changeSchema, raw);
      if (body.owner_user_id) {
        const owner = (await staffDirectory(call)).get(body.owner_user_id);
        if (!owner?.active || PORTAL_ROLES.includes(owner.role)) throw new AppError("VALIDATION_FAILED", "Choose an active staff member.", { owner_user_id: "not an active staff member" });
      }
      if (body.depends_on) await checkDependencies(call, body.depends_on);
      if (body.done) {
        const target = await call.repo.findOne("opening_checklists", { ROWID: call.params.itemId, project_id: call.params.id });
        if (target?.task_code === FITOUT_TASK && target.status !== "COMPLETED") await assertDesignApproved(call.store, call.ctx, call.params.id);
      }
      const linked = !!project.zoho_project_id && (body.done !== undefined || !!body.due_date);
      const projects = linked ? (await call.zoho().catch(() => null))?.projects ?? null : null;
      ({ item, zoho } = await updateChecklistItem(call.store, call.ctx, projects, call.params.id, call.params.itemId, body));
    }
    const readiness = await refreshReadiness(call.store, call.ctx, call.params.id, { today: today(call), now: call.now, onTransition: call.onTransition });
    return { item, zoho, readiness };
  });

  // start, ready_for_opening, open (needs actual_opening_date), close. The engine checks permissions.
  r.on("POST", "/projects/:id/transition", null, async (call) => {
    await getProject(call);
    const body = parse(z.object({ transition: z.string().min(1).max(40), actual_opening_date: z.string().date().optional() }).strict(), call.body);
    if (body.transition === "open") {
      // Every mandatory licence must be issued and valid on the opening day.
      const project = await getProject(call);
      await assertLicencesReady(call.store, call.ctx, project, body.actual_opening_date ?? today(call));
      // Major and critical snags must be fixed and verified (or waived) first.
      await assertSnagsCleared(call.store, call.ctx, call.params.id);
    }
    if (body.actual_opening_date) {
      // The date is written before the engine runs, so check the opener's permission here first.
      if (body.transition !== "open") throw new AppError("VALIDATION_FAILED", "actual_opening_date goes with the open transition.", { actual_opening_date: "unexpected" });
      await authorize(call.ctx, "project.open", call.permissions);
      await call.repo.update("franchise_projects", call.params.id, { actual_opening_date: body.actual_opening_date });
    }
    const project = await transitionEntity("project", call.params.id, body.transition, call.ctx, { store: call.store, permissions: call.permissions, onTransition: call.onTransition });
    if (body.transition !== "open") return project;
    const zoho = await call.zoho().catch(() => null);
    const activation = await activateOnOpening(call.store, call.ctx, zoho?.crm ?? null, { projectId: call.params.id, onTransition: call.onTransition });
    return { ...project, activation };
  });
}

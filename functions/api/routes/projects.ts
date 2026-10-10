import { z } from "zod";
import { AppError } from "../../common/errors";
import { authorize } from "../../common/rbac";
import { Row } from "../../common/store";
import { syncProjectTasks } from "../../workflows/projectSync";
import { computeReadiness, refreshReadiness, setChecklistBlocked, updateChecklistItem } from "../../workflows/readiness";
import { transitionsFrom } from "../../workflows/stateMachines";
import { activateOnOpening } from "../../workflows/agreements";
import { transitionEntity } from "../../workflows/transition";
import { Call, page, parse, Router } from "../router";
import { isPortalUser } from "../../common/rbac";
import { assertOwner, fetchAll, listByStatus, mustGet, ownerFilter, PORTAL_ROLES, staffDirectory } from "./shared";

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
}).strict().refine((b) => Object.keys(b).length > 0, "Nothing to change.");

async function getProject(call: Call): Promise<Row> {
  return assertOwner(call, await mustGet(call.repo, "franchise_projects", call.params.id, "NOT_FOUND"), "NOT_FOUND");
}

/**
 * The franchise fee invoice behind a project, read live from Books. An unpaid fee is a warning
 * only; it never blocks work. Null when there is no invoice; status "unknown" when Books is unreachable.
 */
async function feeStatus(call: Call, project: Row): Promise<Row | null> {
  const agreement = (await call.repo.findMany("agreements", { application_id: String(project.application_id), status: "SIGNED" }, { limit: 1 }))[0];
  const invoiceId = agreement?.zoho_books_invoice_id ? String(agreement.zoho_books_invoice_id) : null;
  if (!invoiceId) return null;
  try {
    const books = (await call.zoho())?.books;
    if (!books) return { invoice_id: invoiceId, status: "unknown" };
    const inv = await books.getInvoice(invoiceId);
    return { invoice_id: invoiceId, invoice_number: inv.number, status: inv.status, total: inv.total, balance: inv.balance, due_date: inv.due_date, paid: inv.status === "paid" || inv.balance <= 0 };
  } catch {
    return { invoice_id: invoiceId, status: "unknown" };
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
    };
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

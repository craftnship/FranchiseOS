import { TenantContext } from "../common/context";
import { logActivity } from "../common/audit";
import { AppError } from "../common/errors";
import { Row, Store, TenantRepo } from "../common/store";

// Hiring and training for an opening store: a staffing plan (people needed per role), the team the
// franchisee hires, and the brand training each person needs, signed off by the franchise team.
// The hiring and training checklist tasks complete themselves when the plan is met.
//
// Staff:     ACTIVE → LEFT
// Training:  SUBMITTED (franchisee) → SIGNED_OFF | RETURNED → SUBMITTED again; staff record SIGNED_OFF directly

export const STAFF_ROLES = ["STORE_MANAGER", "SHIFT_LEAD", "CREW"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
export const ROLE_LABELS: Record<StaffRole, [string, string]> = {
  STORE_MANAGER: ["store manager", "store managers"], SHIFT_LEAD: ["shift lead", "shift leads"], CREW: ["crew member", "crew members"],
};
export const DEFAULT_STAFFING: Record<StaffRole, number> = { STORE_MANAGER: 1, SHIFT_LEAD: 2, CREW: 8 };

export interface TrainingModule { code: string; name: string; roles: StaffRole[]; certificate?: boolean }
/** Brand training each role completes before opening. A certificate module needs the certificate attached. */
export const TRAINING_MODULES: TrainingModule[] = [
  { code: "FOOD_SAFETY", name: "Food safety and hygiene", roles: ["STORE_MANAGER", "SHIFT_LEAD", "CREW"], certificate: true },
  { code: "SERVICE", name: "Brand and guest service", roles: ["STORE_MANAGER", "SHIFT_LEAD", "CREW"] },
  { code: "PRODUCT", name: "Kitchen and product build", roles: ["STORE_MANAGER", "SHIFT_LEAD", "CREW"] },
  { code: "POS", name: "POS and ordering", roles: ["STORE_MANAGER", "SHIFT_LEAD"] },
  { code: "CASH", name: "Cash handling", roles: ["STORE_MANAGER", "SHIFT_LEAD"] },
  { code: "STORE_OPS", name: "Store operations and opening checks", roles: ["STORE_MANAGER"] },
];
export const MODULE_CODES = TRAINING_MODULES.map((m) => m.code) as [string, ...string[]];

export const HIRE_MANAGER_TASK = "HIRE_MANAGER";
export const HIRE_CREW_TASK = "HIRE_CREW";
export const TRAIN_TASK = "TRAIN_CREW";
export const STAFFING_TASKS = [HIRE_MANAGER_TASK, HIRE_CREW_TASK, TRAIN_TASK];

const moduleOf = (code: string) => TRAINING_MODULES.find((m) => m.code === code);
export const modulesFor = (role: string) => TRAINING_MODULES.filter((m) => m.roles.includes(role as StaffRole));
const count = (n: number, role: StaffRole) => `${n} ${ROLE_LABELS[role][n === 1 ? 0 : 1]}`;

/** People needed per role: the project's own plan over the defaults. */
export function planFor(project: Row): Record<StaffRole, number> {
  let own: Record<string, unknown> = {};
  try { own = project.staffing_plan_json ? JSON.parse(String(project.staffing_plan_json)) : {}; } catch { own = {}; }
  return Object.fromEntries(STAFF_ROLES.map((r) => [r, Number.isInteger(own[r]) ? Number(own[r]) : DEFAULT_STAFFING[r]])) as Record<StaffRole, number>;
}

interface Team { staff: Row[]; training: Row[] }
async function team(repo: TenantRepo, projectId: string): Promise<Team> {
  const [staff, training] = await Promise.all([
    repo.findMany("store_staff", { project_id: projectId }, { limit: 300 }),
    repo.findMany("staff_training", { project_id: projectId }, { limit: 2000 }),
  ]);
  return { staff, training };
}

/** Modules a person still needs signed off. */
function missingFor(person: Row, training: Row[]): string[] {
  const signed = new Set(training.filter((t) => String(t.staff_id) === String(person.ROWID) && t.status === "SIGNED_OFF").map((t) => String(t.module_code)));
  return modulesFor(String(person.role_code)).map((m) => m.code).filter((c) => !signed.has(c));
}

/** Hired and fully trained headcount per role, and which staffing tasks that satisfies. */
export function progress(plan: Record<StaffRole, number>, t: Team) {
  const active = t.staff.filter((s) => s.status === "ACTIVE");
  const roles = STAFF_ROLES.map((role) => {
    const people = active.filter((s) => s.role_code === role);
    const trained = people.filter((p) => !missingFor(p, t.training).length).length;
    return { role_code: role, required: plan[role], hired: people.length, trained };
  });
  const by = (r: StaffRole) => roles.find((x) => x.role_code === r)!;
  const met = {
    [HIRE_MANAGER_TASK]: by("STORE_MANAGER").hired >= plan.STORE_MANAGER,
    [HIRE_CREW_TASK]: roles.filter((r) => r.role_code !== "STORE_MANAGER").every((r) => r.hired >= r.required),
    [TRAIN_TASK]: roles.every((r) => r.trained >= r.required),
  } as Record<string, boolean>;
  return { roles, met };
}

/** What still stands between the plan and a task, e.g. "1 of 2 shift leads hired". */
function shortfall(task: string, roles: ReturnType<typeof progress>["roles"]): string[] {
  const pick = task === HIRE_MANAGER_TASK ? roles.filter((r) => r.role_code === "STORE_MANAGER")
    : task === HIRE_CREW_TASK ? roles.filter((r) => r.role_code !== "STORE_MANAGER") : roles;
  const field = task === TRAIN_TASK ? "trained" : "hired";
  return pick.filter((r) => r[field] < r.required).map((r) => `${r[field]} of ${count(r.required, r.role_code)} ${field}`);
}

/** Everything on the team panel. */
export async function staffingFor(store: Store, ctx: TenantContext, project: Row): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const plan = planFor(project);
  const t = await team(repo, String(project.ROWID));
  const { roles, met } = progress(plan, t);
  const order = (s: Row) => STAFF_ROLES.indexOf(String(s.role_code) as StaffRole);
  const staff = t.staff
    .sort((a, b) => (a.status === b.status ? 0 : a.status === "ACTIVE" ? -1 : 1) || order(a) - order(b) || String(a.full_name).localeCompare(String(b.full_name)))
    .map((s) => {
      const mine = t.training.filter((x) => String(x.staff_id) === String(s.ROWID));
      const missing = missingFor(s, t.training);
      return { ...s, training: mine, missing, trained: !missing.length };
    });
  return {
    plan: roles, modules: TRAINING_MODULES, staff, met,
    to_sign_off: t.training.filter((x) => x.status === "SUBMITTED").length,
    custom_plan: !!project.staffing_plan_json,
  };
}

/** Which staffing tasks the plan now meets. */
export async function metTasks(store: Store, ctx: TenantContext, project: Row): Promise<string[]> {
  const t = await team(new TenantRepo(store, ctx.tenantId), String(project.ROWID));
  const { met } = progress(planFor(project), t);
  return STAFFING_TASKS.filter((c) => met[c]);
}

/** A hiring or training task can't be marked done by hand before the plan is met. */
export async function assertStaffingTask(store: Store, ctx: TenantContext, project: Row, task: string): Promise<void> {
  if (!STAFFING_TASKS.includes(task)) return;
  const t = await team(new TenantRepo(store, ctx.tenantId), String(project.ROWID));
  const { roles, met } = progress(planFor(project), t);
  if (met[task]) return;
  const gap = shortfall(task, roles);
  throw new AppError("VALIDATION_FAILED", `This task completes itself once the team is ${task === TRAIN_TASK ? "trained" : "hired"}. Still needed: ${gap.join(", ")}.`, { staffing: gap.join(", ") });
}

export async function setPlan(store: Store, ctx: TenantContext, project: Row, plan: Partial<Record<StaffRole, number>>): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const next = { ...planFor(project), ...plan };
  const from = planFor(project);
  const updated = await repo.update("franchise_projects", String(project.ROWID), { staffing_plan_json: JSON.stringify(next) });
  await logActivity(store, ctx, { entityType: "project", entityId: String(project.ROWID), action: "staffing:plan", metadata: { project_id: String(project.ROWID), from, to: next } });
  return updated;
}

export interface StaffInput { full_name: string; role_code: StaffRole; phone?: string | null; email?: string | null; hired_on: string; start_date?: string | null }

export async function addStaff(store: Store, ctx: TenantContext, project: Row, input: StaffInput, source: "PORTAL" | "STAFF"): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const pid = String(project.ROWID);
  const dup = (await repo.findMany("store_staff", { project_id: pid, status: "ACTIVE" }, { limit: 300 }))
    .find((s) => String(s.full_name).toLowerCase() === input.full_name.toLowerCase() && (!input.phone || !s.phone || s.phone === input.phone));
  if (dup) throw new AppError("VALIDATION_FAILED", `${input.full_name} is already on the team.`, { full_name: "already on the team" });
  const row = await repo.insert("store_staff", {
    project_id: pid, franchisee_id: project.franchisee_id ?? null, full_name: input.full_name, role_code: input.role_code, phone: input.phone ?? null, email: input.email ?? null,
    hired_on: input.hired_on, start_date: input.start_date ?? null, status: "ACTIVE", source, added_by: ctx.userId ?? null,
  });
  await logActivity(store, ctx, { entityType: "project", entityId: pid, action: "staff:hired", metadata: { project_id: pid, staff_id: String(row.ROWID), name: input.full_name, role: input.role_code } });
  return row;
}

export async function updateStaff(store: Store, ctx: TenantContext, project: Row, person: Row, change: Partial<StaffInput>): Promise<Row> {
  if (person.status !== "ACTIVE") throw new AppError("INVALID_TRANSITION", "This person has left the team.");
  const repo = new TenantRepo(store, ctx.tenantId);
  const row = await repo.update("store_staff", String(person.ROWID), change as Row);
  if (change.role_code && change.role_code !== person.role_code) {
    await logActivity(store, ctx, { entityType: "project", entityId: String(project.ROWID), action: "staff:role", metadata: { project_id: String(project.ROWID), staff_id: String(person.ROWID), name: person.full_name, from: person.role_code, to: change.role_code } });
  }
  return row;
}

export async function markLeft(store: Store, ctx: TenantContext, project: Row, person: Row, left_on: string, reason: string | null): Promise<Row> {
  if (person.status !== "ACTIVE") throw new AppError("INVALID_TRANSITION", "This person has already left.");
  const repo = new TenantRepo(store, ctx.tenantId);
  const row = await repo.update("store_staff", String(person.ROWID), { status: "LEFT", left_on, left_reason: reason });
  await logActivity(store, ctx, { entityType: "project", entityId: String(project.ROWID), action: "staff:left", metadata: { project_id: String(project.ROWID), staff_id: String(person.ROWID), name: person.full_name, role: person.role_code, reason } });
  return row;
}

export interface TrainingInput { module_code: string; completed_on: string; score?: number | null; trainer?: string | null; certificate_ref?: string | null }

/**
 * Records a completed module. From the portal it waits for sign-off; staff with project.write are the
 * franchise trainers, so their record is signed off at once.
 */
export async function recordTraining(store: Store, ctx: TenantContext, project: Row, person: Row, input: TrainingInput, source: "PORTAL" | "STAFF", now: Date): Promise<Row> {
  if (person.status !== "ACTIVE") throw new AppError("INVALID_TRANSITION", "This person has left the team.");
  const mod = moduleOf(input.module_code);
  if (!mod || !mod.roles.includes(person.role_code as StaffRole)) throw new AppError("VALIDATION_FAILED", `${ROLE_LABELS[person.role_code as StaffRole]?.[0] ?? "This role"} doesn't take that module.`, { module_code: "not for this role" });
  const repo = new TenantRepo(store, ctx.tenantId);
  const key = `${ctx.tenantId}:${person.ROWID}:${mod.code}`;
  const existing = await repo.findOne("staff_training", { training_key: key });
  if (existing?.status === "SIGNED_OFF") throw new AppError("INVALID_TRANSITION", `${mod.name} is already signed off for ${person.full_name}.`);
  if (existing?.status === "SUBMITTED" && source === "PORTAL") throw new AppError("INVALID_TRANSITION", `${mod.name} for ${person.full_name} is already waiting for sign-off.`);
  const certificate_ref = input.certificate_ref ?? existing?.certificate_ref ?? null;
  if (mod.certificate && source === "PORTAL" && !certificate_ref) throw new AppError("VALIDATION_FAILED", `Attach the ${mod.name.toLowerCase()} certificate.`, { certificate: "required" });
  const at = now.toISOString();
  const signed = source === "STAFF";
  const fields: Row = {
    completed_on: input.completed_on, score: input.score ?? null, trainer: input.trainer ?? null, certificate_ref, source, recorded_by: ctx.userId ?? null, recorded_at: at,
    status: signed ? "SIGNED_OFF" : "SUBMITTED", reviewed_by: signed ? ctx.userId ?? null : null, reviewed_at: signed ? at : null, review_note: null,
  };
  const row = existing ? await repo.update("staff_training", String(existing.ROWID), fields)
    : await repo.insert("staff_training", { project_id: String(project.ROWID), staff_id: String(person.ROWID), module_code: mod.code, training_key: key, ...fields });
  const pid = String(project.ROWID);
  await logActivity(store, ctx, { entityType: "project", entityId: pid, action: signed ? "training:signed_off" : "training:submitted",
    metadata: { project_id: pid, training_id: String(row.ROWID), staff_id: String(person.ROWID), name: person.full_name, module: mod.name, by_trainer: signed } });
  return row;
}

export async function decideTraining(store: Store, ctx: TenantContext, project: Row, record: Row, decision: "SIGNED_OFF" | "RETURNED", note: string | null, now: Date): Promise<Row> {
  if (record.status !== "SUBMITTED") throw new AppError("INVALID_TRANSITION", "This training record isn't waiting for sign-off.");
  if (decision === "RETURNED" && !note) throw new AppError("VALIDATION_FAILED", "Say what's missing.", { note: "required" });
  const repo = new TenantRepo(store, ctx.tenantId);
  const person = await repo.findOne("store_staff", { ROWID: String(record.staff_id) });
  const row = await repo.update("staff_training", String(record.ROWID), { status: decision, reviewed_by: ctx.userId ?? null, reviewed_at: now.toISOString(), review_note: note });
  const pid = String(project.ROWID);
  await logActivity(store, ctx, { entityType: "project", entityId: pid, action: decision === "SIGNED_OFF" ? "training:signed_off" : "training:returned",
    metadata: { project_id: pid, training_id: String(record.ROWID), staff_id: String(record.staff_id), name: person?.full_name ?? null, module: moduleOf(String(record.module_code))?.name ?? record.module_code, note } });
  return row;
}

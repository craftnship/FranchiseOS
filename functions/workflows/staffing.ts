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

export interface RoleDef { code: string; name: string; plural: string; default_count: number }
export interface TrainingModule { code: string; name: string; roles: string[]; certificate?: boolean }
/** The roles a store hires (the first is the manager the hire-manager task waits for) and the training each takes. */
export interface StaffConfig { roles: RoleDef[]; modules: TrainingModule[] }

export const DEFAULT_ROLES: RoleDef[] = [
  { code: "STORE_MANAGER", name: "Store manager", plural: "Store managers", default_count: 1 },
  { code: "SHIFT_LEAD", name: "Shift lead", plural: "Shift leads", default_count: 2 },
  { code: "CREW", name: "Crew member", plural: "Crew members", default_count: 8 },
];
/** Brand training each role completes before opening. A certificate module needs the certificate attached. */
export const TRAINING_MODULES: TrainingModule[] = [
  { code: "FOOD_SAFETY", name: "Food safety and hygiene", roles: ["STORE_MANAGER", "SHIFT_LEAD", "CREW"], certificate: true },
  { code: "SERVICE", name: "Brand and guest service", roles: ["STORE_MANAGER", "SHIFT_LEAD", "CREW"] },
  { code: "PRODUCT", name: "Kitchen and product build", roles: ["STORE_MANAGER", "SHIFT_LEAD", "CREW"] },
  { code: "POS", name: "POS and ordering", roles: ["STORE_MANAGER", "SHIFT_LEAD"] },
  { code: "CASH", name: "Cash handling", roles: ["STORE_MANAGER", "SHIFT_LEAD"] },
  { code: "STORE_OPS", name: "Store operations and opening checks", roles: ["STORE_MANAGER"] },
];
export const DEFAULT_STAFF_CONFIG: StaffConfig = { roles: DEFAULT_ROLES, modules: TRAINING_MODULES };

const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
/** settings_json.staff_roles and .training_modules over the defaults; anything malformed falls back. */
export function staffConfig(tenant: Row | null | undefined): StaffConfig {
  let s: Row = {};
  try { s = tenant?.settings_json ? JSON.parse(String(tenant.settings_json)) : {}; } catch { s = {}; }
  const roles = Array.isArray(s.staff_roles) ? (s.staff_roles as Row[]).filter((r) => CODE.test(String(r?.code)) && typeof r.name === "string" && r.name.trim())
    .map((r) => ({ code: String(r.code), name: String(r.name).trim(), plural: String(r.plural ?? r.name).trim() || String(r.name), default_count: Number.isInteger(r.default_count) && Number(r.default_count) >= 0 ? Number(r.default_count) : 1 })) : [];
  const use = roles.length && new Set(roles.map((r) => r.code)).size === roles.length ? roles : DEFAULT_ROLES;
  const codes = new Set(use.map((r) => r.code));
  const mods = Array.isArray(s.training_modules) ? (s.training_modules as Row[]).filter((m) => CODE.test(String(m?.code)) && typeof m.name === "string" && m.name.trim() && Array.isArray(m.roles))
    .map((m) => ({ code: String(m.code), name: String(m.name).trim(), roles: (m.roles as unknown[]).map(String).filter((r) => codes.has(r)), certificate: m.certificate === true })).filter((m) => m.roles.length) : [];
  const modules = mods.length && new Set(mods.map((m) => m.code)).size === mods.length ? mods
    : use === DEFAULT_ROLES ? TRAINING_MODULES : TRAINING_MODULES.map((m) => ({ ...m, roles: m.roles.filter((r) => codes.has(r)) })).filter((m) => m.roles.length);
  return { roles: use, modules };
}
export async function staffConfigFor(store: Store, tenantId: string): Promise<StaffConfig> {
  return staffConfig(await store.findOne("tenants", { ROWID: tenantId }));
}

export const HIRE_MANAGER_TASK = "HIRE_MANAGER";
export const HIRE_CREW_TASK = "HIRE_CREW";
export const TRAIN_TASK = "TRAIN_CREW";
export const STAFFING_TASKS = [HIRE_MANAGER_TASK, HIRE_CREW_TASK, TRAIN_TASK];

const moduleOf = (cfg: StaffConfig, code: string) => cfg.modules.find((m) => m.code === code);
export const modulesFor = (cfg: StaffConfig, role: string) => cfg.modules.filter((m) => m.roles.includes(role));
const roleOf = (cfg: StaffConfig, code: string) => cfg.roles.find((r) => r.code === code);
const count = (cfg: StaffConfig, n: number, role: string) => `${n} ${(n === 1 ? roleOf(cfg, role)?.name : roleOf(cfg, role)?.plural)?.toLowerCase() ?? role}`;

/** People needed per role: the project's own plan over the role defaults. */
export function planFor(project: Row, cfg: StaffConfig = DEFAULT_STAFF_CONFIG): Record<string, number> {
  let own: Record<string, unknown> = {};
  try { own = project.staffing_plan_json ? JSON.parse(String(project.staffing_plan_json)) : {}; } catch { own = {}; }
  return Object.fromEntries(cfg.roles.map((r) => [r.code, Number.isInteger(own[r.code]) ? Number(own[r.code]) : r.default_count]));
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
function missingFor(cfg: StaffConfig, person: Row, training: Row[]): string[] {
  const signed = new Set(training.filter((t) => String(t.staff_id) === String(person.ROWID) && t.status === "SIGNED_OFF").map((t) => String(t.module_code)));
  return modulesFor(cfg, String(person.role_code)).map((m) => m.code).filter((c) => !signed.has(c));
}

/** Hired and fully trained headcount per role, and which staffing tasks that satisfies. */
export function progress(plan: Record<string, number>, t: Team, cfg: StaffConfig = DEFAULT_STAFF_CONFIG) {
  const active = t.staff.filter((s) => s.status === "ACTIVE");
  const roles = cfg.roles.map(({ code }) => {
    const people = active.filter((s) => s.role_code === code);
    const trained = people.filter((p) => !missingFor(cfg, p, t.training).length).length;
    return { role_code: code, required: plan[code] ?? 0, hired: people.length, trained };
  });
  const manager = cfg.roles[0].code;
  const met = {
    [HIRE_MANAGER_TASK]: roles[0].hired >= roles[0].required,
    [HIRE_CREW_TASK]: roles.filter((r) => r.role_code !== manager).every((r) => r.hired >= r.required),
    [TRAIN_TASK]: roles.every((r) => r.trained >= r.required),
  } as Record<string, boolean>;
  return { roles, met };
}

/** What still stands between the plan and a task, e.g. "1 of 2 shift leads hired". */
function shortfall(cfg: StaffConfig, task: string, roles: ReturnType<typeof progress>["roles"]): string[] {
  const manager = cfg.roles[0].code;
  const pick = task === HIRE_MANAGER_TASK ? roles.filter((r) => r.role_code === manager)
    : task === HIRE_CREW_TASK ? roles.filter((r) => r.role_code !== manager) : roles;
  const field = task === TRAIN_TASK ? "trained" : "hired";
  return pick.filter((r) => r[field] < r.required).map((r) => `${r[field]} of ${count(cfg, r.required, r.role_code)} ${field}`);
}

/** Everything on the team panel. */
export async function staffingFor(store: Store, ctx: TenantContext, project: Row): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const cfg = await staffConfigFor(store, ctx.tenantId);
  const plan = planFor(project, cfg);
  const t = await team(repo, String(project.ROWID));
  const { roles, met } = progress(plan, t, cfg);
  const order = (s: Row) => { const i = cfg.roles.findIndex((r) => r.code === s.role_code); return i < 0 ? cfg.roles.length : i; };
  const staff = t.staff
    .sort((a, b) => (a.status === b.status ? 0 : a.status === "ACTIVE" ? -1 : 1) || order(a) - order(b) || String(a.full_name).localeCompare(String(b.full_name)))
    .map((s) => {
      const mine = t.training.filter((x) => String(x.staff_id) === String(s.ROWID));
      const missing = missingFor(cfg, s, t.training);
      return { ...s, training: mine, missing, trained: !missing.length };
    });
  return {
    plan: roles, roles: cfg.roles, modules: cfg.modules, staff, met,
    to_sign_off: t.training.filter((x) => x.status === "SUBMITTED").length,
    custom_plan: !!project.staffing_plan_json,
  };
}

/** Which staffing tasks the plan now meets. */
export async function metTasks(store: Store, ctx: TenantContext, project: Row): Promise<string[]> {
  const cfg = await staffConfigFor(store, ctx.tenantId);
  const t = await team(new TenantRepo(store, ctx.tenantId), String(project.ROWID));
  const { met } = progress(planFor(project, cfg), t, cfg);
  return STAFFING_TASKS.filter((c) => met[c]);
}

/** A hiring or training task can't be marked done by hand before the plan is met. */
export async function assertStaffingTask(store: Store, ctx: TenantContext, project: Row, task: string): Promise<void> {
  if (!STAFFING_TASKS.includes(task)) return;
  const cfg = await staffConfigFor(store, ctx.tenantId);
  const t = await team(new TenantRepo(store, ctx.tenantId), String(project.ROWID));
  const { roles, met } = progress(planFor(project, cfg), t, cfg);
  if (met[task]) return;
  const gap = shortfall(cfg, task, roles);
  throw new AppError("VALIDATION_FAILED", `This task completes itself once the team is ${task === TRAIN_TASK ? "trained" : "hired"}. Still needed: ${gap.join(", ")}.`, { staffing: gap.join(", ") });
}

export async function setPlan(store: Store, ctx: TenantContext, project: Row, plan: Record<string, number>): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const cfg = await staffConfigFor(store, ctx.tenantId);
  const unknown = Object.keys(plan).filter((k) => !roleOf(cfg, k));
  if (unknown.length) throw new AppError("VALIDATION_FAILED", "Unknown role.", Object.fromEntries(unknown.map((k) => [k, "unknown role"])));
  const from = planFor(project, cfg);
  const next = { ...from, ...plan };
  const updated = await repo.update("franchise_projects", String(project.ROWID), { staffing_plan_json: JSON.stringify(next) });
  await logActivity(store, ctx, { entityType: "project", entityId: String(project.ROWID), action: "staffing:plan", metadata: { project_id: String(project.ROWID), from, to: next } });
  return updated;
}

export interface StaffInput { full_name: string; role_code: string; phone?: string | null; email?: string | null; hired_on: string; start_date?: string | null }

/** A role the tenant's stores hire, or VALIDATION_FAILED. */
export async function assertRole(store: Store, ctx: TenantContext, role: string): Promise<void> {
  if (!roleOf(await staffConfigFor(store, ctx.tenantId), role)) throw new AppError("VALIDATION_FAILED", "Pick one of the store roles.", { role_code: "unknown role" });
}

export async function addStaff(store: Store, ctx: TenantContext, project: Row, input: StaffInput, source: "PORTAL" | "STAFF"): Promise<Row> {
  await assertRole(store, ctx, input.role_code);
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
  if (change.role_code) await assertRole(store, ctx, change.role_code);
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
  const cfg = await staffConfigFor(store, ctx.tenantId);
  const mod = moduleOf(cfg, input.module_code);
  if (!mod || !mod.roles.includes(String(person.role_code))) throw new AppError("VALIDATION_FAILED", `${roleOf(cfg, String(person.role_code))?.name ?? "This role"} doesn't take that module.`, { module_code: "not for this role" });
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
    metadata: { project_id: pid, training_id: String(record.ROWID), staff_id: String(record.staff_id), name: person?.full_name ?? null, module: moduleOf(await staffConfigFor(store, ctx.tenantId), String(record.module_code))?.name ?? record.module_code, note } });
  return row;
}

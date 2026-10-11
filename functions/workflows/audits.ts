import { TenantContext } from "../common/context";
import { logActivity } from "../common/audit";
import { AppError } from "../common/errors";
import { nextBusinessId } from "../common/ids";
import { DuplicateKeyError, Row, Store, TenantRepo } from "../common/store";
import { toBool, toNum } from "../common/values";
import { DEFAULTS } from "../../database/seed/defaults";

// Store audits (plan Phase 2 "Operations"): an auditor scores an opened store against the brand
// standards; every failed standard becomes a corrective action the franchisee answers with evidence
// and the auditor closes or sends back. A red audit books its own follow-up.
//
// Audit:  SCHEDULED → (start) IN_PROGRESS → (complete) COMPLETED;  SCHEDULED/IN_PROGRESS → CANCELLED
// Action: OPEN → (franchisee responds) SUBMITTED → (auditor) CLOSED, or back to OPEN with a note

export const AUDIT_TYPES = ["ROUTINE", "OPENING", "FOLLOW_UP", "SURPRISE"] as const;
export type AuditType = (typeof AUDIT_TYPES)[number];
export type ItemResult = "PASS" | "FAIL" | "NA";
const OPEN_AUDIT = ["SCHEDULED", "IN_PROGRESS"];
const OPEN_ACTION = ["OPEN", "SUBMITTED"];
const AUDITABLE = ["READY_FOR_OPENING", "OPENED"];

export interface Standard { code: string; section: string; text: string; weight: number; critical: boolean }
export interface AuditSettings { every_days: number; first_within_days: number; pass_score: number; amber_score: number; action_days: number; critical_action_days: number; follow_up_days: number; standards: Standard[] }

const round1 = (n: number) => Math.round(n * 10) / 10;
const addDays = (date: string, days: number) => { const d = new Date(date.slice(0, 10) + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);

/** The tenant's standards and timings: settings `audit_standards` and `audit_*` numbers, else the defaults. */
export function auditSettings(tenant: Row | null): AuditSettings {
  let s: Record<string, unknown> = {};
  try { s = tenant?.settings_json ? JSON.parse(String(tenant.settings_json)) : {}; } catch { s = {}; }
  const d = DEFAULTS.audits;
  const n = (k: keyof typeof d, key: string) => (s[key] != null ? toNum(s[key]) : (d[k] as number));
  const raw = (Array.isArray(s.audit_standards) && s.audit_standards.length ? s.audit_standards : d.standards) as Array<Record<string, unknown>>;
  return {
    every_days: n("every_days", "audit_every_days"), first_within_days: n("first_within_days", "audit_first_within_days"),
    pass_score: n("pass_score", "audit_pass_score"), amber_score: n("amber_score", "audit_amber_score"),
    action_days: n("action_days", "audit_action_days"), critical_action_days: n("critical_action_days", "audit_critical_action_days"),
    follow_up_days: n("follow_up_days", "audit_follow_up_days"),
    standards: raw.map((x) => ({ code: String(x.code), section: String(x.section ?? "General"), text: String(x.text), weight: x.weight != null ? toNum(x.weight) : 1, critical: toBool(x.critical) })),
  };
}

/**
 * Score is the weight passed over the weight judged (not-applicable items count for nothing).
 * Green at the pass score, amber down to the amber score; red below it or with any critical fail.
 */
export function scoreOf(items: Array<Record<string, unknown>>, s: Pick<AuditSettings, "pass_score" | "amber_score">) {
  const judged = items.filter((i) => i.verdict === "PASS" || i.verdict === "FAIL");
  const total = judged.reduce((a, i) => a + toNum(i.weight), 0);
  const passed = judged.filter((i) => i.verdict === "PASS").reduce((a, i) => a + toNum(i.weight), 0);
  const score = total > 0 ? round1((passed / total) * 100) : null;
  const critical_fails = items.filter((i) => i.verdict === "FAIL" && toBool(i.critical)).length;
  const rating = score === null ? null : critical_fails > 0 || score < s.amber_score ? "RED" : score < s.pass_score ? "AMBER" : "GREEN";
  return { score, rating, critical_fails, failed: items.filter((i) => i.verdict === "FAIL").length, passed: items.filter((i) => i.verdict === "PASS").length, na: items.filter((i) => i.verdict === "NA").length, unanswered: items.filter((i) => !i.verdict).length };
}

const settingsFor = async (store: Store, ctx: Pick<TenantContext, "tenantId">) => auditSettings(await store.findOne("tenants", { ROWID: ctx.tenantId }));

/** When the store's next audit is due: its first within the set days of opening, then every set days after the last one. */
export function nextDue(project: Row, lastCompleted: Row | null, s: AuditSettings): string | null {
  if (project.status !== "OPENED" || !project.actual_opening_date) return null;
  if (!lastCompleted) return addDays(String(project.actual_opening_date), s.first_within_days);
  return addDays(String(lastCompleted.completed_at).slice(0, 10), s.every_days);
}

export interface ScheduleInput { audit_type: AuditType; planned_for: string; auditor_user_id?: string | null; notes?: string | null }

/** Books an audit. A store has one open audit at a time. */
export async function scheduleAudit(store: Store, ctx: TenantContext, project: Row, input: ScheduleInput): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  if (!AUDITABLE.includes(String(project.status))) throw new AppError("INVALID_TRANSITION", "A store is audited once it's ready to open.");
  const open = (await repo.findMany("audits", { project_id: String(project.ROWID) }, { limit: 300 })).find((a) => OPEN_AUDIT.includes(String(a.status)));
  if (open) throw new AppError("INVALID_TRANSITION", `${open.audit_code} is already booked for this store. Change its date instead.`);
  if (input.auditor_user_id) {
    const u = await repo.findOne("users", { ROWID: input.auditor_user_id });
    if (!u || u.franchisee_id || u.status !== "ACTIVE") throw new AppError("VALIDATION_FAILED", "Choose an active staff member as auditor.", { auditor_user_id: "not a staff member" });
  }
  const code = await nextBusinessId(store, ctx.tenantId, "audit");
  const row = await repo.insert("audits", {
    audit_code: code, tenant_code_key: `${ctx.tenantId}:${code}`, project_id: String(project.ROWID), franchisee_id: project.franchisee_id ?? null, site_id: project.site_id ?? null,
    audit_type: input.audit_type, status: "SCHEDULED", planned_for: input.planned_for, auditor_user_id: input.auditor_user_id ?? ctx.userId, notes: input.notes ?? null,
  });
  await logActivity(store, ctx, { entityType: "project", entityId: String(project.ROWID), action: "audit:scheduled", metadata: { audit_id: String(row.ROWID), audit_code: code, audit_type: input.audit_type, planned_for: input.planned_for, auditor_user_id: row.auditor_user_id } });
  return row;
}

export async function rescheduleAudit(store: Store, ctx: TenantContext, audit: Row, change: { planned_for: string; auditor_user_id?: string | null }): Promise<Row> {
  if (audit.status !== "SCHEDULED") throw new AppError("INVALID_TRANSITION", "Only an audit that hasn't started can be moved.");
  return new TenantRepo(store, ctx.tenantId).update("audits", String(audit.ROWID), { planned_for: change.planned_for, ...(change.auditor_user_id ? { auditor_user_id: change.auditor_user_id } : {}) });
}

export async function cancelAudit(store: Store, ctx: TenantContext, audit: Row, reason: string): Promise<Row> {
  if (!OPEN_AUDIT.includes(String(audit.status))) throw new AppError("INVALID_TRANSITION", "Only an open audit can be cancelled.");
  const row = await new TenantRepo(store, ctx.tenantId).update("audits", String(audit.ROWID), { status: "CANCELLED", summary: reason });
  await logActivity(store, ctx, { entityType: "project", entityId: String(audit.project_id), action: "audit:cancelled", metadata: { audit_id: String(audit.ROWID), audit_code: audit.audit_code, reason } });
  return row;
}

/** Starts an audit: copies the current standards onto it, so later edits to the standards don't change it. */
export async function startAudit(store: Store, ctx: TenantContext, audit: Row, now: Date): Promise<{ audit: Row; items: Row[] }> {
  const repo = new TenantRepo(store, ctx.tenantId);
  if (audit.status === "IN_PROGRESS") return { audit, items: await itemsOf(repo, audit) };
  if (audit.status !== "SCHEDULED") throw new AppError("INVALID_TRANSITION", "This audit is closed.");
  const s = await settingsFor(store, ctx);
  const existing = await itemsOf(repo, audit);
  for (const [i, st] of s.standards.entries()) {
    if (existing.some((x) => x.code === st.code)) continue;
    try {
      existing.push(await repo.insert("audit_items", { audit_id: String(audit.ROWID), seq: i + 1, code: st.code, section: st.section, standard: st.text, weight: st.weight, critical: st.critical, verdict: null, item_key: `${ctx.tenantId}:${audit.ROWID}:${st.code}` }));
    } catch (e) { if (!(e instanceof DuplicateKeyError)) throw e; }
  }
  const row = await repo.update("audits", String(audit.ROWID), { status: "IN_PROGRESS", started_at: now.toISOString(), auditor_user_id: audit.auditor_user_id ?? ctx.userId });
  return { audit: row, items: (await itemsOf(repo, audit)) };
}

export async function itemsOf(repo: TenantRepo, audit: Row): Promise<Row[]> {
  return (await repo.findMany("audit_items", { audit_id: String(audit.ROWID) }, { limit: 200 })).sort((a, b) => toNum(a.seq) - toNum(b.seq));
}

export interface ItemInput { code: string; verdict: ItemResult | null; comments?: string | null; evidence_ref?: string | null }

/** Records results as the auditor walks the store; each save is kept, so a dropped connection loses nothing. */
export async function recordItems(store: Store, ctx: TenantContext, audit: Row, input: ItemInput[]): Promise<Row[]> {
  if (audit.status !== "IN_PROGRESS") throw new AppError("INVALID_TRANSITION", audit.status === "SCHEDULED" ? "Start the audit first." : "This audit is closed.");
  const repo = new TenantRepo(store, ctx.tenantId);
  const items = await itemsOf(repo, audit);
  const out: Row[] = [];
  for (const x of input) {
    const item = items.find((i) => i.code === x.code);
    if (!item) throw new AppError("VALIDATION_FAILED", "That standard isn't part of this audit.", { code: x.code });
    out.push(await repo.update("audit_items", String(item.ROWID), { verdict: x.verdict, ...(x.comments !== undefined ? { comments: x.comments } : {}), ...(x.evidence_ref ? { evidence_ref: x.evidence_ref } : {}) }));
  }
  return out;
}

/**
 * Completes an audit: every standard judged, every fail explained. The score and rating are stored,
 * each fail becomes a corrective action (sooner for critical ones), and a red audit books a follow-up.
 */
export async function completeAudit(store: Store, ctx: TenantContext, audit: Row, project: Row, summary: string | null, now: Date): Promise<{ audit: Row; actions: Row[]; follow_up: Row | null }> {
  if (audit.status !== "IN_PROGRESS") throw new AppError("INVALID_TRANSITION", audit.status === "SCHEDULED" ? "Start the audit first." : "This audit is closed.");
  const repo = new TenantRepo(store, ctx.tenantId);
  const s = await settingsFor(store, ctx);
  const items = await itemsOf(repo, audit);
  const missing = items.filter((i) => !i.verdict);
  if (missing.length) throw new AppError("VALIDATION_FAILED", `${missing.length} standard${missing.length === 1 ? " is" : "s are"} not judged yet.`, { items: missing.map((i) => String(i.code)).join(", ") });
  const silent = items.filter((i) => i.verdict === "FAIL" && !String(i.comments ?? "").trim());
  if (silent.length) throw new AppError("VALIDATION_FAILED", "Say what was wrong for each failed standard.", { items: silent.map((i) => String(i.code)).join(", ") });
  const sc = scoreOf(items, s);
  const today = now.toISOString().slice(0, 10);
  const actions: Row[] = [];
  for (const i of items.filter((x) => x.verdict === "FAIL")) {
    const critical = toBool(i.critical);
    try {
      actions.push(await repo.insert("corrective_actions", {
        audit_id: String(audit.ROWID), project_id: String(audit.project_id), franchisee_id: audit.franchisee_id ?? null, item_code: i.code,
        description: `${i.standard}: ${String(i.comments).trim()}`.slice(0, 2000), severity: critical ? "CRITICAL" : "MAJOR",
        due_date: addDays(today, critical ? s.critical_action_days : s.action_days), status: "OPEN", action_key: `${ctx.tenantId}:${audit.ROWID}:${i.code}`,
      }));
    } catch (e) { if (!(e instanceof DuplicateKeyError)) throw e; }
  }
  const row = await repo.update("audits", String(audit.ROWID), { status: "COMPLETED", completed_at: now.toISOString(), score: sc.score, rating: sc.rating, critical_fails: sc.critical_fails, summary });
  await logActivity(store, ctx, {
    entityType: "project", entityId: String(audit.project_id), action: "audit:completed",
    metadata: { audit_id: String(audit.ROWID), audit_code: audit.audit_code, audit_type: audit.audit_type, score: sc.score, rating: sc.rating, critical_fails: sc.critical_fails, actions: actions.length },
  });
  let follow_up: Row | null = null;
  if (sc.rating === "RED") {
    follow_up = await scheduleAudit(store, ctx, project, { audit_type: "FOLLOW_UP", planned_for: addDays(today, s.follow_up_days), auditor_user_id: String(row.auditor_user_id ?? ctx.userId), notes: `Follow-up to ${audit.audit_code}` });
  }
  return { audit: row, actions, follow_up };
}

/** The franchisee (or staff for them) says what was done, with a photo or document. */
export async function respondAction(store: Store, ctx: TenantContext, action: Row, input: { note: string; evidence_ref?: string | null }, by: "PORTAL" | "STAFF", now: Date): Promise<Row> {
  if (action.status !== "OPEN") throw new AppError("INVALID_TRANSITION", action.status === "SUBMITTED" ? "This action is waiting for the auditor." : "This action is closed.");
  const row = await new TenantRepo(store, ctx.tenantId).update("corrective_actions", String(action.ROWID), {
    status: "SUBMITTED", response_note: input.note, ...(input.evidence_ref ? { evidence_ref: input.evidence_ref } : {}), submitted_at: now.toISOString(), submitted_by: ctx.userId, review_note: null,
  });
  await logActivity(store, ctx, { entityType: "project", entityId: String(action.project_id), action: "action:submitted", metadata: { action_id: String(action.ROWID), audit_id: String(action.audit_id), item_code: action.item_code, by } });
  return row;
}

/** The auditor closes a fixed action, or sends it back with a note and, optionally, a new date. */
export async function reviewAction(store: Store, ctx: TenantContext, action: Row, input: { accept: boolean; note?: string | null; due_date?: string | null }, now: Date): Promise<Row> {
  if (action.status === "CLOSED") throw new AppError("INVALID_TRANSITION", "This action is already closed.");
  if (!input.accept && action.status !== "SUBMITTED") throw new AppError("INVALID_TRANSITION", "Only an action the franchisee has answered can be sent back.");
  if (!input.accept && !input.note) throw new AppError("VALIDATION_FAILED", "Say what still needs doing.", { note: "required" });
  const repo = new TenantRepo(store, ctx.tenantId);
  const patch: Row = input.accept
    ? { status: "CLOSED", closed_at: now.toISOString(), closed_by: ctx.userId, review_note: input.note ?? null }
    : { status: "OPEN", review_note: input.note, ...(input.due_date ? { due_date: input.due_date } : {}) };
  const row = await repo.update("corrective_actions", String(action.ROWID), patch);
  await logActivity(store, ctx, { entityType: "project", entityId: String(action.project_id), action: input.accept ? "action:closed" : "action:reopened", metadata: { action_id: String(action.ROWID), audit_id: String(action.audit_id), item_code: action.item_code, note: input.note ?? null, due_date: row.due_date } });
  return row;
}

const decorateAction = (a: Row, today: string): Row => ({ ...a, overdue: a.status === "OPEN" && !!a.due_date && day(a.due_date)! < today });

/** One store's audits, open actions, latest result and when the next audit is due. */
export async function auditsFor(store: Store, ctx: TenantContext, project: Row, today: string, portal: boolean): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const s = await settingsFor(store, ctx);
  let audits = (await repo.findMany("audits", { project_id: String(project.ROWID) }, { limit: 300 })).sort((a, b) => String(b.completed_at ?? b.planned_for ?? "").localeCompare(String(a.completed_at ?? a.planned_for ?? "")));
  // The franchisee sees finished audits and booked ones, but not a surprise visit.
  if (portal) audits = audits.filter((a) => a.status === "COMPLETED" || (a.status === "SCHEDULED" && a.audit_type !== "SURPRISE"));
  const actions = (await repo.findMany("corrective_actions", { project_id: String(project.ROWID) }, { limit: 500 })).map((a) => decorateAction(a, today));
  const done = audits.filter((a) => a.status === "COMPLETED");
  const last = done[0] ?? null;
  const due = nextDue(project, last, s);
  return {
    audits: audits.map((a) => ({ ...a, actions_open: actions.filter((x) => String(x.audit_id) === String(a.ROWID) && OPEN_ACTION.includes(String(x.status))).length })),
    actions: actions.filter((a) => OPEN_ACTION.includes(String(a.status))).sort((a, b) => String(a.due_date).localeCompare(String(b.due_date))),
    closed_actions: actions.filter((a) => a.status === "CLOSED").length,
    last: last ? { ROWID: last.ROWID, audit_code: last.audit_code, score: last.score, rating: last.rating, completed_at: last.completed_at } : null,
    trend: done.slice(0, 6).reverse().map((a) => ({ audit_code: a.audit_code, score: a.score, rating: a.rating, date: day(a.completed_at) })),
    next_due: due, due_overdue: !!due && due < today && !audits.some((a) => OPEN_AUDIT.includes(String(a.status)) && day(a.planned_for)! <= due),
    auditable: AUDITABLE.includes(String(project.status)),
    pass_score: s.pass_score,
  };
}

/** One audit with its standards by section and its actions. */
export async function auditDetail(store: Store, ctx: TenantContext, audit: Row, today: string): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const s = await settingsFor(store, ctx);
  const items = await itemsOf(repo, audit);
  const [project, auditor, actions] = await Promise.all([
    repo.findOne("franchise_projects", { ROWID: String(audit.project_id) }),
    audit.auditor_user_id ? repo.findOne("users", { ROWID: String(audit.auditor_user_id) }) : null,
    repo.findMany("corrective_actions", { audit_id: String(audit.ROWID) }, { limit: 200 }),
  ]);
  return {
    ...audit, project_code: project?.project_code ?? null, project_status: project?.status ?? null,
    auditor: auditor ? { ROWID: auditor.ROWID, name: auditor.name ?? auditor.email } : null,
    items, progress: scoreOf(items, s), actions: actions.map((a) => decorateAction(a, today)),
    pass_score: s.pass_score, amber_score: s.amber_score,
  };
}

/** Network view: every store that can be audited, its last result, next due date and open actions; and the standards failed most. */
export async function networkAudits(store: Store, ctx: TenantContext, today: string): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const s = await settingsFor(store, ctx);
  const projects = (await Promise.all(AUDITABLE.map((st) => repo.findMany("franchise_projects", { status: st }, { limit: 500 })))).flat();
  const [audits, actions, franchisees] = await Promise.all([repo.findMany("audits", {}, { limit: 2000 }), repo.findMany("corrective_actions", {}, { limit: 3000 }), repo.findMany("franchisees", {}, { limit: 500 })]);
  const fmap = new Map(franchisees.map((f) => [String(f.ROWID), f]));
  const stores = projects.map((p) => {
    const mine = audits.filter((a) => String(a.project_id) === String(p.ROWID));
    const done = mine.filter((a) => a.status === "COMPLETED").sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)));
    const open = mine.find((a) => OPEN_AUDIT.includes(String(a.status))) ?? null;
    const acts = actions.filter((a) => String(a.project_id) === String(p.ROWID) && OPEN_ACTION.includes(String(a.status))).map((a) => decorateAction(a, today));
    const due = nextDue(p, done[0] ?? null, s);
    const f = fmap.get(String(p.franchisee_id));
    return {
      project_id: p.ROWID, project_code: p.project_code, project_status: p.status, franchisee: f ? f.display_name ?? f.franchise_code : null,
      last_audit_id: done[0]?.ROWID ?? null, last_score: done[0]?.score ?? null, last_rating: done[0]?.rating ?? null, last_date: day(done[0]?.completed_at),
      previous_score: done[1]?.score ?? null, next_due: due, booked: open ? { ROWID: open.ROWID, audit_code: open.audit_code, planned_for: day(open.planned_for), status: open.status } : null,
      due_overdue: !!due && due < today && !open, actions_open: acts.length, actions_overdue: acts.filter((a) => a.overdue).length,
    };
  }).sort((a, b) => String(a.next_due ?? "9999").localeCompare(String(b.next_due ?? "9999")));
  // Most-failed standards across each store's latest audit.
  const latest = new Set(stores.map((x) => String(x.last_audit_id ?? "")).filter(Boolean));
  const fails = new Map<string, { code: string; text: string; section: string; stores: number }>();
  for (const id of latest) {
    for (const i of await repo.findMany("audit_items", { audit_id: id, verdict: "FAIL" }, { limit: 200 })) {
      const f = fails.get(String(i.code)) ?? { code: String(i.code), text: String(i.standard), section: String(i.section), stores: 0 };
      f.stores++;
      fails.set(String(i.code), f);
    }
  }
  const scored = stores.filter((x) => x.last_score != null);
  return {
    stores,
    most_failed: [...fails.values()].sort((a, b) => b.stores - a.stores).slice(0, 8),
    totals: {
      stores: stores.length, audited: scored.length, average: scored.length ? round1(scored.reduce((a, x) => a + toNum(x.last_score), 0) / scored.length) : null,
      red: scored.filter((x) => x.last_rating === "RED").length, due: stores.filter((x) => x.due_overdue).length,
      actions_open: stores.reduce((a, x) => a + x.actions_open, 0), actions_overdue: stores.reduce((a, x) => a + x.actions_overdue, 0),
    },
    pass_score: s.pass_score,
  };
}

/** For reminders: open actions past their date, and opened stores past their audit date with nothing booked. */
export async function auditReminders(store: Store, ctx: TenantContext, today: string): Promise<{ actions: Row[]; stores: Array<{ project: Row; due: string }> }> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const s = await settingsFor(store, ctx);
  const actions = (await repo.findMany("corrective_actions", { status: "OPEN" }, { limit: 1000 })).filter((a) => a.due_date && day(a.due_date)! < today);
  const stores: Array<{ project: Row; due: string }> = [];
  const audits = await repo.findMany("audits", {}, { limit: 2000 });
  for (const p of await repo.findMany("franchise_projects", { status: "OPENED" }, { limit: 500 })) {
    const mine = audits.filter((a) => String(a.project_id) === String(p.ROWID));
    if (mine.some((a) => OPEN_AUDIT.includes(String(a.status)))) continue;
    const last = mine.filter((a) => a.status === "COMPLETED").sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)))[0] ?? null;
    const due = nextDue(p, last, s);
    if (due && due < today) stores.push({ project: p, due });
  }
  return { actions, stores };
}

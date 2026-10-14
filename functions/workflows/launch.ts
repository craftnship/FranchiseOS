import { TenantContext } from "../common/context";
import { logActivity } from "../common/audit";
import { AppError } from "../common/errors";
import { DuplicateKeyError, newestFirst, Row, Store, TenantRepo } from "../common/store";
import { toNum, toNumOrNull } from "../common/values";
import { DEFAULTS } from "../../database/seed/defaults";

// Opening day (plan Phase 2 "Operations"): the grand-opening plan, the weekly sales watch for a new
// store's first weeks, and agreement renewals.
//
// Launch task: OPEN → DONE (franchisee for their own tasks, project.write for any) or SKIPPED (staff).
// Sales watch: week n runs from the opening day + 7(n-1); its target is the feasibility monthly revenue
// as a weekly figure, times the ramp for that week. A store is behind when its last two weeks are both
// under the behind mark.

export const LAUNCH_OWNERS = ["FRANCHISEE", "BRAND"] as const;
export type LaunchOwner = (typeof LAUNCH_OWNERS)[number];
export const RENEWAL_STATUSES = ["IN_DISCUSSION", "RENEWING", "NOT_RENEWING", "RENEWED"] as const;
export type RenewalStatus = (typeof RENEWAL_STATUSES)[number];
const PLANNABLE = ["NOT_STARTED", "PLANNING", "IN_PROGRESS", "AT_RISK", "READY_FOR_OPENING", "OPENED"];

export interface LaunchStep { code: string; item: string; owner: LaunchOwner; offset_days: number }
export interface LaunchSettings { watch_weeks: number; on_track_pct: number; behind_pct: number; ramp: number[]; plan: LaunchStep[]; renewal_notice_days: number }

const round1 = (n: number) => Math.round(n * 10) / 10;
export const addDays = (date: string, days: number) => { const d = new Date(date.slice(0, 10) + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** The tenant's plan and thresholds: settings `launch_plan`, `launch_*` and `renewal_notice_days`, else the defaults. */
export function launchSettings(tenant: Row | null): LaunchSettings {
  let s: Record<string, unknown> = {};
  try { s = tenant?.settings_json ? JSON.parse(String(tenant.settings_json)) : {}; } catch { s = {}; }
  const d = DEFAULTS.launch;
  const n = (v: unknown, dflt: number) => (v != null ? toNum(v) : dflt);
  const plan = (Array.isArray(s.launch_plan) && s.launch_plan.length ? s.launch_plan : d.plan) as Array<Record<string, unknown>>;
  return {
    watch_weeks: n(s.launch_watch_weeks, d.watch_weeks), on_track_pct: n(s.launch_on_track_pct, d.on_track_pct), behind_pct: n(s.launch_behind_pct, d.behind_pct),
    ramp: (Array.isArray(s.launch_ramp) && s.launch_ramp.length ? s.launch_ramp : d.ramp).map((x) => toNum(x)),
    plan: plan.map((x) => ({ code: String(x.code), item: String(x.item), owner: x.owner === "BRAND" ? "BRAND" : "FRANCHISEE", offset_days: toNum(x.offset_days) })),
    renewal_notice_days: n(s.renewal_notice_days, d.renewal_notice_days),
  };
}

const settingsFor = async (store: Store, ctx: Pick<TenantContext, "tenantId">) => launchSettings(await store.findOne("tenants", { ROWID: ctx.tenantId }));

/** The feasibility revenue the store was approved on: the application's linked model, else its latest. */
export async function plannedMonthlyRevenue(repo: TenantRepo, project: Row): Promise<number | null> {
  if (!project.application_id) return null;
  const app = await repo.findOne("franchise_applications", { ROWID: String(project.application_id) });
  let model = app?.feasibility_id ? await repo.findOne("feasibility_models", { ROWID: String(app.feasibility_id) }) : null;
  if (!model) {
    const all = await repo.findMany("feasibility_models", { application_id: String(project.application_id) }, { limit: 50 });
    model = all.sort(newestFirst)[0] ?? null;
  }
  const v = toNumOrNull(model?.monthly_revenue);
  return v && v > 0 ? v : null;
}

/** Weekly target for week n (1-based): the monthly plan as a week, times that week's ramp (the last ramp value holds after). */
export function weekTarget(monthly: number | null, week: number, s: Pick<LaunchSettings, "ramp">): number | null {
  if (!monthly) return null;
  const ramp = s.ramp.length ? s.ramp[Math.min(week, s.ramp.length) - 1] : 1;
  return Math.round((monthly * 12) / 52 * ramp);
}

export function rateOf(pct: number | null, s: Pick<LaunchSettings, "on_track_pct" | "behind_pct">): "GREEN" | "AMBER" | "RED" | null {
  if (pct == null) return null;
  return pct >= s.on_track_pct ? "GREEN" : pct >= s.behind_pct ? "AMBER" : "RED";
}

// ── Grand-opening plan ────────────────────────────────────────────────────────────────────────────

const tasksOf = async (repo: TenantRepo, projectId: string) =>
  (await repo.findMany("launch_tasks", { project_id: projectId }, { limit: 200 })).sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)) || toNum(a.seq) - toNum(b.seq));

/**
 * Sets (or moves) the grand-opening day. The first time, the tenant's plan becomes the store's launch
 * tasks; after that, tasks still open move with the date.
 */
export async function planLaunch(store: Store, ctx: TenantContext, project: Row, date: string): Promise<{ project: Row; tasks: Row[] }> {
  const repo = new TenantRepo(store, ctx.tenantId);
  if (!PLANNABLE.includes(String(project.status))) throw new AppError("INVALID_TRANSITION", "This project is closed.");
  const pid = String(project.ROWID);
  const before = day(project.grand_opening_date);
  const existing = await tasksOf(repo, pid);
  if (!existing.length) {
    const s = await settingsFor(store, ctx);
    for (const [i, st] of s.plan.entries()) {
      try {
        await repo.insert("launch_tasks", { project_id: pid, franchisee_id: project.franchisee_id ?? null, task_key: `${ctx.tenantId}:${pid}:${st.code}`, seq: i + 1, code: st.code, item: st.item, owner_side: st.owner, due_date: addDays(date, st.offset_days), status: "OPEN" });
      } catch (e) { if (!(e instanceof DuplicateKeyError)) throw e; }
    }
  } else if (before && before !== date) {
    const shift = daysBetween(before, date);
    for (const t of existing) if (t.status === "OPEN" && t.due_date) await repo.update("launch_tasks", String(t.ROWID), { due_date: addDays(String(t.due_date), shift) });
  }
  const row = await repo.update("franchise_projects", pid, { grand_opening_date: date });
  await logActivity(store, ctx, { entityType: "project", entityId: pid, action: before ? "launch:moved" : "launch:planned", metadata: { grand_opening_date: date, from: before } });
  return { project: row, tasks: await tasksOf(repo, pid) };
}

/** Adds a one-off task to the store's plan. */
export async function addLaunchTask(store: Store, ctx: TenantContext, project: Row, input: { item: string; owner: LaunchOwner; due_date: string }): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const pid = String(project.ROWID);
  if (!project.grand_opening_date) throw new AppError("INVALID_TRANSITION", "Set the grand-opening day first.");
  const n = (await tasksOf(repo, pid)).length + 1;
  const code = `EXTRA_${n}`;
  return repo.insert("launch_tasks", { project_id: pid, franchisee_id: project.franchisee_id ?? null, task_key: `${ctx.tenantId}:${pid}:${code}:${Date.now()}`, seq: 100 + n, code, item: input.item, owner_side: input.owner, due_date: input.due_date, status: "OPEN" });
}

/** Ticks off, skips or reopens a task. The franchisee may only tick off (or reopen) their own. */
export async function changeLaunchTask(store: Store, ctx: TenantContext, task: Row, change: { action: "done" | "skip" | "reopen"; note?: string | null; due_date?: string | null }, portal: boolean, now: Date): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  if (portal && (task.owner_side !== "FRANCHISEE" || change.action === "skip")) throw new AppError("ACCESS_DENIED", "The brand team looks after this task.");
  let patch: Row;
  if (change.action === "done") {
    if (task.status === "DONE") return task;
    patch = { status: "DONE", done_at: now.toISOString(), done_by: ctx.userId, ...(change.note ? { note: change.note } : {}) };
  } else if (change.action === "skip") {
    if (!change.note) throw new AppError("VALIDATION_FAILED", "Say why it's skipped.", { note: "required" });
    patch = { status: "SKIPPED", done_at: now.toISOString(), done_by: ctx.userId, note: change.note };
  } else {
    patch = { status: "OPEN", done_at: null, done_by: null, ...(change.due_date ? { due_date: change.due_date } : {}), ...(change.note ? { note: change.note } : {}) };
  }
  const row = await repo.update("launch_tasks", String(task.ROWID), patch);
  await logActivity(store, ctx, { entityType: "project", entityId: String(task.project_id), action: `launch:${change.action === "done" ? "done" : change.action === "skip" ? "skipped" : "reopened"}`, metadata: { task_id: String(task.ROWID), item: task.item, note: change.note ?? null } });
  return row;
}

// ── First-weeks sales watch ───────────────────────────────────────────────────────────────────────

/** The weeks of the watch window that have finished by today (week 1 starts on the opening day). */
export function finishedWeeks(openedOn: string | null, today: string, s: Pick<LaunchSettings, "watch_weeks">): number {
  if (!openedOn) return 0;
  return Math.max(0, Math.min(s.watch_weeks, Math.floor(daysBetween(openedOn, today) / 7)));
}

/** Records (or corrects) one week's sales. Only a finished week inside the watch can be reported. */
export async function recordWeek(store: Store, ctx: TenantContext, project: Row, input: { week_no: number; net_sales: number; transactions?: number | null }, portal: boolean, now: Date): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const s = await settingsFor(store, ctx);
  const opened = day(project.actual_opening_date);
  if (project.status !== "OPENED" || !opened) throw new AppError("INVALID_TRANSITION", "Weekly sales are reported once the store is open.");
  const today = now.toISOString().slice(0, 10);
  const done = finishedWeeks(opened, today, s);
  if (input.week_no < 1 || input.week_no > s.watch_weeks) throw new AppError("VALIDATION_FAILED", `The watch covers weeks 1 to ${s.watch_weeks}.`, { week_no: "out of range" });
  if (input.week_no > done) throw new AppError("VALIDATION_FAILED", "That week hasn't finished yet.", { week_no: "not finished" });
  const pid = String(project.ROWID);
  const key = `${ctx.tenantId}:${pid}:${input.week_no}`;
  const target = weekTarget(await plannedMonthlyRevenue(repo, project), input.week_no, s);
  const values = { net_sales: input.net_sales, transactions: input.transactions ?? null, target_sales: target, source: portal ? "PORTAL" : "STAFF", entered_by: ctx.userId, entered_at: now.toISOString() };
  const existing = await repo.findOne("launch_sales", { week_key: key });
  const row = existing
    ? await repo.update("launch_sales", String(existing.ROWID), values)
    : await repo.insert("launch_sales", { project_id: pid, franchisee_id: project.franchisee_id ?? null, week_key: key, week_no: input.week_no, week_start: addDays(opened, (input.week_no - 1) * 7), ...values });
  const watch = await launchFor(store, ctx, project, today);
  await logActivity(store, ctx, {
    entityType: "project", entityId: pid, action: existing ? "launch:sales_changed" : "launch:sales",
    metadata: { week_no: input.week_no, net_sales: input.net_sales, target, pct: (watch.weeks as Row[]).find((w) => w.week_no === input.week_no)?.pct ?? null, behind: watch.behind, to_date_pct: watch.to_date_pct },
  });
  return row;
}

/** A store's launch: the grand-opening plan with progress, and the weekly sales watch. */
export async function launchFor(store: Store, ctx: TenantContext, project: Row, today: string): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const s = await settingsFor(store, ctx);
  const pid = String(project.ROWID);
  const tasks: Row[] = (await tasksOf(repo, pid)).map((t) => ({ ...t, overdue: t.status === "OPEN" && !!t.due_date && day(t.due_date)! < today }));
  const opened = project.status === "OPENED" ? day(project.actual_opening_date) : null;
  const monthly = await plannedMonthlyRevenue(repo, project);
  const entered = new Map((await repo.findMany("launch_sales", { project_id: pid }, { limit: 100 })).map((w) => [toNum(w.week_no), w]));
  // Stores opened before the watch existed aren't watched unless someone reports a week for them; every
  // store opened since gets a grand-opening date on the open transition, so it is watched.
  const watched = !!opened && (!!project.grand_opening_date || entered.size > 0);
  const done = watched ? finishedWeeks(opened, today, s) : 0;
  const weeks = watched && opened ? Array.from({ length: s.watch_weeks }, (_, i) => {
    const n = i + 1, w = entered.get(n);
    const target = w?.target_sales != null ? toNum(w.target_sales) : weekTarget(monthly, n, s);
    const sales = w ? toNum(w.net_sales) : null;
    const pct = sales != null && target ? round1((sales / target) * 100) : null;
    return { week_no: n, week_start: addDays(opened, i * 7), week_end: addDays(opened, i * 7 + 6), finished: n <= done, net_sales: sales, transactions: w?.transactions ?? null, target, pct, rating: rateOf(pct, s), ROWID: w?.ROWID ?? null };
  }) : [];
  const reported = weeks.filter((w) => w.net_sales != null);
  const withTarget = reported.filter((w) => w.target);
  const salesSum = withTarget.reduce((a, w) => a + (w.net_sales ?? 0), 0), targetSum = withTarget.reduce((a, w) => a + (w.target ?? 0), 0);
  const to_date_pct = targetSum ? round1((salesSum / targetSum) * 100) : null;
  const lastTwo = reported.slice(-2);
  const behind = lastTwo.length === 2 && lastTwo.every((w) => w.rating === "RED");
  return {
    grand_opening_date: day(project.grand_opening_date), opened_on: opened, planned: !!project.grand_opening_date || tasks.length > 0,
    can_plan: PLANNABLE.includes(String(project.status)),
    tasks, tasks_done: tasks.filter((t) => t.status !== "OPEN").length, tasks_overdue: tasks.filter((t) => t.overdue).length,
    monthly_plan: monthly, watch_weeks: s.watch_weeks, weeks, weeks_finished: done, weeks_missing: weeks.filter((w) => w.finished && w.net_sales == null).length,
    watched, in_watch: watched && daysBetween(opened!, today) < s.watch_weeks * 7 + 7,
    sales_to_date: reported.reduce((a, w) => a + (w.net_sales ?? 0), 0), to_date_pct, to_date_rating: rateOf(to_date_pct, s), behind,
    on_track_pct: s.on_track_pct, behind_pct: s.behind_pct,
  };
}

/** Network view: stores with a grand opening coming up or inside their sales watch. */
export async function networkLaunches(store: Store, ctx: TenantContext, today: string): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const s = await settingsFor(store, ctx);
  const franchisees = new Map((await repo.findMany("franchisees", {}, { limit: 500 })).map((f) => [String(f.ROWID), f]));
  const out: Row[] = [];
  for (const p of await repo.findMany("franchise_projects", {}, { limit: 500 })) {
    const opened = p.status === "OPENED" ? day(p.actual_opening_date) : null;
    const upcoming = !opened && PLANNABLE.includes(String(p.status)) && !!p.grand_opening_date;
    if (!upcoming && !(opened && daysBetween(opened, today) < s.watch_weeks * 7 + 7)) continue;
    const l = await launchFor(store, ctx, p, today);
    if (!upcoming && !l.watched) continue;
    const f = franchisees.get(String(p.franchisee_id));
    const last = (l.weeks as Row[]).filter((w) => w.net_sales != null).at(-1) ?? null;
    out.push({
      project_id: p.ROWID, project_code: p.project_code, project_status: p.status, franchisee: f ? f.display_name ?? f.franchise_code : null,
      grand_opening_date: l.grand_opening_date, opened_on: opened, stage: opened ? "WATCH" : "UPCOMING",
      tasks: (l.tasks as Row[]).length, tasks_done: l.tasks_done, tasks_overdue: l.tasks_overdue,
      week: opened ? Math.min(s.watch_weeks, Math.floor(daysBetween(opened, today) / 7) + 1) : null, weeks_missing: l.weeks_missing,
      last_week: last ? { week_no: last.week_no, pct: last.pct, rating: last.rating } : null,
      sales_to_date: l.sales_to_date, to_date_pct: l.to_date_pct, to_date_rating: l.to_date_rating, behind: l.behind, has_plan: !!l.monthly_plan,
    });
  }
  out.sort((a, b) => (a.stage === b.stage ? String(a.opened_on ?? a.grand_opening_date).localeCompare(String(b.opened_on ?? b.grand_opening_date)) : a.stage === "UPCOMING" ? -1 : 1));
  const watch = out.filter((x) => x.stage === "WATCH");
  return {
    stores: out,
    totals: { upcoming: out.length - watch.length, watching: watch.length, behind: watch.filter((x) => x.behind).length, tasks_overdue: out.reduce((a, x) => a + toNum(x.tasks_overdue), 0), weeks_missing: watch.reduce((a, x) => a + toNum(x.weeks_missing), 0) },
    on_track_pct: s.on_track_pct, behind_pct: s.behind_pct, watch_weeks: s.watch_weeks,
  };
}

// ── Renewals ──────────────────────────────────────────────────────────────────────────────────────

/** Records where a renewal stands. RENEWED needs the new end date, after the current one. */
export async function changeRenewal(store: Store, ctx: TenantContext, agreement: Row, input: { status: RenewalStatus; note?: string | null; renewed_until?: string | null }, now: Date): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  if (agreement.status !== "SIGNED") throw new AppError("INVALID_TRANSITION", "Only a signed agreement can be renewed.");
  if (input.status === "RENEWED") {
    if (!input.renewed_until) throw new AppError("VALIDATION_FAILED", "Give the renewed term's end date.", { renewed_until: "required" });
    if (agreement.expiry_date && input.renewed_until <= day(agreement.expiry_date)!) throw new AppError("VALIDATION_FAILED", "The renewed term must end after the current one.", { renewed_until: "too early" });
  }
  const row = await repo.update("agreements", String(agreement.ROWID), {
    renewal_status: input.status, renewal_note: input.note ?? null, renewal_updated_at: now.toISOString(), renewed_until: input.status === "RENEWED" ? input.renewed_until : null,
  });
  await logActivity(store, ctx, { entityType: "agreement", entityId: String(agreement.ROWID), action: `renewal:${input.status.toLowerCase()}`, metadata: { renewal_status: input.status, renewed_until: input.renewed_until ?? null, note: input.note ?? null, expiry_date: day(agreement.expiry_date) } });
  return row;
}

/** Signed agreements ending within the horizon (or already ended and not settled), with each store's health. */
export async function renewalsDue(store: Store, ctx: TenantContext, today: string, months = 18): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const s = await settingsFor(store, ctx);
  const horizon = addDays(today, Math.round(months * 30.4));
  const [agreements, franchisees, projects, audits, reports] = await Promise.all([
    repo.findMany("agreements", { status: "SIGNED" }, { limit: 1000 }), repo.findMany("franchisees", {}, { limit: 500 }),
    repo.findMany("franchise_projects", {}, { limit: 1000 }), repo.findMany("audits", { status: "COMPLETED" }, { limit: 2000 }), repo.findMany("sales_reports", {}, { limit: 5000 }),
  ]);
  const fmap = new Map(franchisees.map((f) => [String(f.ROWID), f]));
  const rows = agreements.filter((a) => a.expiry_date && day(a.expiry_date)! <= horizon && !(a.renewal_status === "RENEWED" && day(a.renewed_until)! > horizon)).map((a) => {
    const end = day(a.expiry_date)!;
    const project = projects.find((p) => String(p.application_id) === String(a.application_id)) ?? null;
    const lastAudit = project ? audits.filter((x) => String(x.project_id) === String(project.ROWID)).sort((x, y) => String(y.completed_at).localeCompare(String(x.completed_at)))[0] ?? null : null;
    const overdue = project ? reports.filter((r) => String(r.project_id) === String(project.ROWID) && r.status === "INVOICED" && r.invoice_due_date && day(r.invoice_due_date)! < today && toNum(r.invoice_balance) > 0) : [];
    const f = fmap.get(String(a.franchisee_id));
    const left = daysBetween(today, end);
    return {
      ROWID: a.ROWID, agreement_code: a.agreement_code, franchisee: f ? f.display_name ?? f.franchise_code : null, franchisee_id: a.franchisee_id,
      effective_date: day(a.effective_date), expiry_date: end, days_left: left, in_notice: left <= s.renewal_notice_days,
      renewal_status: a.renewal_status ?? null, renewal_note: a.renewal_note ?? null, renewed_until: day(a.renewed_until),
      project_id: project?.ROWID ?? null, project_code: project?.project_code ?? null, project_status: project?.status ?? null,
      last_audit_score: lastAudit?.score ?? null, last_audit_rating: lastAudit?.rating ?? null, royalties_overdue: overdue.length,
    };
  }).sort((a, b) => a.expiry_date.localeCompare(b.expiry_date));
  const open = rows.filter((r) => r.renewal_status !== "RENEWED" && r.renewal_status !== "NOT_RENEWING");
  return {
    agreements: rows, notice_days: s.renewal_notice_days, months,
    totals: { due: rows.length, undecided: open.length, in_notice: open.filter((r) => r.in_notice).length, expired: open.filter((r) => r.days_left < 0).length, renewed: rows.filter((r) => r.renewal_status === "RENEWED").length },
  };
}

/** For reminders: open launch tasks past their date, finished watch weeks with no sales, stores behind, and renewals at a milestone. */
export async function launchReminders(store: Store, ctx: TenantContext, today: string): Promise<{ tasks: Array<{ project: Row; task: Row }>; missing: Array<{ project: Row; week: number; ended: string }>; behind: Array<{ project: Row; week: number; to_date_pct: number | null }>; renewals: Array<{ agreement: Row; days_left: number; milestone: number }> }> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const s = await settingsFor(store, ctx);
  const projects = await repo.findMany("franchise_projects", {}, { limit: 1000 });
  const byId = new Map(projects.map((p) => [String(p.ROWID), p]));
  const tasks = (await repo.findMany("launch_tasks", { status: "OPEN" }, { limit: 2000 }))
    .filter((t) => t.due_date && day(t.due_date)! < today && PLANNABLE.includes(String(byId.get(String(t.project_id))?.status)))
    .map((task) => ({ project: byId.get(String(task.project_id))!, task }));
  const missing: Array<{ project: Row; week: number; ended: string }> = [];
  const behind: Array<{ project: Row; week: number; to_date_pct: number | null }> = [];
  for (const p of projects) {
    const opened = p.status === "OPENED" ? day(p.actual_opening_date) : null;
    if (!opened || daysBetween(opened, today) >= s.watch_weeks * 7 + 14) continue;
    const l = await launchFor(store, ctx, p, today);
    // Only the week just finished is chased, so a store already weeks in doesn't get a backlog of notices.
    const latest = (l.weeks as Row[]).filter((w) => w.finished).at(-1);
    if (latest && latest.net_sales == null && daysBetween(String(latest.week_end), today) <= 7) missing.push({ project: p, week: toNum(latest.week_no), ended: String(latest.week_end) });
    if (l.behind) behind.push({ project: p, week: toNum((l.weeks as Row[]).filter((w) => w.net_sales != null).at(-1)?.week_no), to_date_pct: l.to_date_pct as number | null });
  }
  const renewals: Array<{ agreement: Row; days_left: number; milestone: number }> = [];
  const milestones = [...new Set([s.renewal_notice_days, 90, 30, 0])].filter((m) => m <= s.renewal_notice_days).sort((a, b) => a - b);
  for (const a of await repo.findMany("agreements", { status: "SIGNED" }, { limit: 1000 })) {
    if (!a.expiry_date || a.renewal_status === "RENEWED" || a.renewal_status === "NOT_RENEWING") continue;
    const left = daysBetween(today, day(a.expiry_date)!);
    // The nearest milestone not yet passed: 180, 90, 30 days out, then on the day (and a month after).
    const milestone = milestones.find((m) => left <= m);
    if (milestone !== undefined && left >= -30) renewals.push({ agreement: a, days_left: left, milestone });
  }
  return { tasks, missing, behind, renewals };
}

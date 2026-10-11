import { AppError } from "../common/errors";
import { TenantContext } from "../common/context";
import { logActivity } from "../common/audit";
import { DuplicateKeyError, Row, Store, TenantRepo } from "../common/store";
import { round, toNum } from "../common/values";
import { ZohoProjectsClient } from "../integrations/clients";
import { refreshReadiness, updateChecklistItem } from "./readiness";
import { TransitionDeps, transitionEntity } from "./transition";

// Lease terms per site. Dates that follow from the terms (rent start after the rent-free fit-out
// window, lock-in end, expiry, renewal notice date) are stored so reminders and lists can use them.
// The costly case is a rent start before the store opens: rent is paid on a store with no sales.

export const LEASE_STATES = ["DRAFT", "SIGNED", "TERMINATED"] as const;

export interface LeaseTerms {
  landlord_name?: string | null;
  landlord_contact?: string | null;
  monthly_rent?: number | null;
  cam_monthly?: number | null;
  escalation_pct?: number | null;
  escalation_every_months?: number | null;
  security_deposit?: number | null;
  lease_start?: string | null;
  term_months?: number | null;
  lock_in_months?: number | null;
  rent_free_days?: number | null;
  renewal_notice_days?: number | null;
  notes?: string | null;
}

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const ms = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
export const addDays = (d: string, n: number) => iso(ms(d) + n * DAY);
export function addMonths(d: string, n: number): string {
  const [y, m, dd] = d.slice(0, 10).split("-").map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return iso(Date.UTC(y, m - 1 + n, Math.min(dd, last)));
}
export const daysBetween = (from: string, to: string) => Math.round((ms(to) - ms(from)) / DAY);

/** The dates that follow from the terms; null where a term is missing. */
export function derivedDates(l: Row): { rent_start: string | null; lock_in_end: string | null; expiry_date: string | null; notice_by: string | null } {
  const start = l.lease_start ? String(l.lease_start).slice(0, 10) : null;
  if (!start) return { rent_start: null, lock_in_end: null, expiry_date: null, notice_by: null };
  const expiry = l.term_months ? addDays(addMonths(start, toNum(l.term_months)), -1) : null;
  return {
    rent_start: addDays(start, toNum(l.rent_free_days)),
    lock_in_end: l.lock_in_months ? addDays(addMonths(start, toNum(l.lock_in_months)), -1) : null,
    expiry_date: expiry,
    notice_by: expiry ? addDays(expiry, -toNum(l.renewal_notice_days ?? 90)) : null,
  };
}

/** Rent on `day` and the next step-up, with escalations on each lease anniversary period. */
export function rentSchedule(l: Row, day: string): { current: number; next: { date: string; rent: number } | null } {
  const base = toNum(l.monthly_rent);
  const start = l.lease_start ? String(l.lease_start).slice(0, 10) : null;
  const pct = toNum(l.escalation_pct);
  const every = toNum(l.escalation_every_months) || 12;
  if (!start || !base || !pct) return { current: base, next: null };
  const expiry = derivedDates(l).expiry_date;
  let steps = 0;
  while (addMonths(start, (steps + 1) * every) <= day) steps++;
  const at = (n: number) => round(base * (1 + pct / 100) ** n, 0);
  const nextDate = addMonths(start, (steps + 1) * every);
  return { current: at(steps), next: expiry && nextDate > expiry ? null : { date: nextDate, rent: at(steps + 1) } };
}

/** Days of rent paid before opening (rent start to target opening) and what it costs; null when there is no gap. */
export function openingGap(l: Row, targetOpening: string | null): { days: number; cost: number } | null {
  const rentStart = derivedDates(l).rent_start;
  if (!rentStart || !targetOpening) return null;
  const days = daysBetween(rentStart, targetOpening);
  if (days <= 0) return null;
  return { days, cost: round((toNum(l.monthly_rent) + toNum(l.cam_monthly)) * 12 / 365 * days, 0) };
}

export async function leaseForSite(store: Store, ctx: TenantContext, siteId: string): Promise<Row | null> {
  return new TenantRepo(store, ctx.tenantId).findOne("leases", { lease_key: `${ctx.tenantId}:${siteId}` });
}

/** The opening project on this site that has not opened yet, if any. */
async function projectOnSite(repo: TenantRepo, siteId: string): Promise<Row | null> {
  const projects = await repo.findMany("franchise_projects", { site_id: siteId }, { limit: 10 });
  return projects.find((p) => !["CLOSED"].includes(String(p.status))) ?? null;
}

/** A lease row with what the page needs: derived dates, rent now and next, and the gap to the target opening. */
export async function describeLease(store: Store, ctx: TenantContext, lease: Row | null, siteId: string, today: string): Promise<Row | null> {
  if (!lease) return null;
  const project = await projectOnSite(new TenantRepo(store, ctx.tenantId), siteId);
  const target = project?.status !== "OPENED" && project?.target_opening_date ? String(project.target_opening_date).slice(0, 10) : null;
  return {
    ...lease, ...derivedDates(lease), rent: rentSchedule(lease, today),
    project: project ? { ROWID: project.ROWID, project_code: project.project_code, status: project.status, target_opening_date: project.target_opening_date, actual_opening_date: project.actual_opening_date } : null,
    opening_gap: openingGap(lease, target),
  };
}

function validate(next: Row, today: string): void {
  const fields: Record<string, string> = {};
  const lockIn = toNum(next.lock_in_months), term = toNum(next.term_months);
  if (lockIn && term && lockIn > term) fields.lock_in_months = "can't be longer than the term";
  if (next.rent_free_days && term && toNum(next.rent_free_days) > term * 31) fields.rent_free_days = "longer than the lease";
  if (next.status === "SIGNED") {
    for (const k of ["lease_start", "term_months", "monthly_rent"]) if (!next[k]) fields[k] = "required to sign";
    if (!next.file_ref) fields.file = "upload the signed lease first";
  }
  if (next.signed_on && String(next.signed_on) > today) fields.signed_on = "can't be in the future";
  if (Object.keys(fields).length) throw new AppError("VALIDATION_FAILED", "Check the lease terms.", fields);
}

/**
 * Creates or updates the site's lease. Signing it moves the site to lease signed and completes the
 * project's "Sign lease" task (in Zoho Projects too when linked). Returns the lease and what changed.
 */
export async function saveLease(
  store: Store, ctx: TenantContext, site: Row, change: LeaseTerms & { status?: (typeof LEASE_STATES)[number]; file_ref?: string; signed_on?: string | null },
  opts: { today: string; now: Date; projects: ZohoProjectsClient | null } & Pick<TransitionDeps, "permissions" | "onTransition">,
): Promise<{ lease: Row; site: Row; task_completed: boolean }> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const siteId = String(site.ROWID);
  const existing = await leaseForSite(store, ctx, siteId);
  if (existing?.status === "TERMINATED") throw new AppError("INVALID_TRANSITION", "This lease is terminated.");
  if (existing?.status === "SIGNED" && change.status === "DRAFT") throw new AppError("INVALID_TRANSITION", "A signed lease can't go back to draft.");
  const signing = change.status === "SIGNED" && existing?.status !== "SIGNED";
  const next: Row = { ...(existing ?? { status: "DRAFT", escalation_every_months: 12, renewal_notice_days: 90 }), ...change };
  if (signing && !next.signed_on) next.signed_on = opts.today;
  validate(next, opts.today);
  const fields = { ...change, ...(signing ? { signed_on: next.signed_on } : {}), ...derivedDates(next) };
  let lease: Row;
  if (existing) lease = await repo.update("leases", String(existing.ROWID), fields);
  else {
    try {
      lease = await repo.insert("leases", { site_id: siteId, status: "DRAFT", escalation_every_months: 12, renewal_notice_days: 90, ...fields, lease_key: `${ctx.tenantId}:${siteId}` });
    } catch (e) {
      if (e instanceof DuplicateKeyError) throw new AppError("INVALID_REQUEST", "The lease was just created by someone else. Reload and try again.");
      throw e;
    }
  }
  // The site summary shows rent and deposit; keep them in step with the lease.
  const sitePatch: Row = {};
  if (change.monthly_rent != null) sitePatch.rent = change.monthly_rent;
  if (change.security_deposit != null) sitePatch.deposit = change.security_deposit;
  let siteRow = Object.keys(sitePatch).length ? await repo.update("sites", siteId, sitePatch) : site;
  await logActivity(store, ctx, { entityType: "site", entityId: siteId, action: signing ? "lease:signed" : change.file_ref ? "lease:upload" : existing ? "lease:update" : "lease:create", metadata: { lease_id: lease.ROWID, fields: Object.keys(change) } });

  let taskCompleted = false;
  if (signing) {
    const t = { store, onTransition: opts.onTransition, permissions: opts.permissions };
    if (siteRow.status === "APPROVED") siteRow = await transitionEntity("site", siteId, "start_lease", ctx, t);
    if (siteRow.status === "LEASE_PENDING") siteRow = await transitionEntity("site", siteId, "lease_signed", ctx, t);
    const project = await projectOnSite(repo, siteId);
    const task = project ? (await repo.findMany("opening_checklists", { project_id: String(project.ROWID), task_code: "LEASE" }, { limit: 1 }))[0] : null;
    if (project && task && task.status !== "COMPLETED") {
      await updateChecklistItem(store, ctx, project.zoho_project_id ? opts.projects : null, String(project.ROWID), String(task.ROWID), { done: true });
      await refreshReadiness(store, ctx, String(project.ROWID), { today: opts.today, now: opts.now, onTransition: opts.onTransition });
      taskCompleted = true;
    }
  }
  return { lease, site: siteRow, task_completed: taskCompleted };
}

/** The site's "lease signed" step needs a signed lease in FOS. */
export async function assertLeaseSigned(store: Store, ctx: TenantContext, siteId: string): Promise<void> {
  const lease = await leaseForSite(store, ctx, siteId);
  if (lease?.status !== "SIGNED") throw new AppError("VALIDATION_FAILED", "Record the lease terms and upload the signed lease, then mark it signed.", { lease: "not signed" });
}

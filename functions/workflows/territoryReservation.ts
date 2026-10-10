import { AppError } from "../common/errors";
import { TenantContext } from "../common/context";
import { DuplicateKeyError, Row, Store, TenantRepo } from "../common/store";
import { logActivity } from "../common/audit";
import { log } from "../common/logger";
import { toNum } from "../common/values";

// Territory reservation with conflict protection (spec §29, FOS-024, D-13).
// The unique active_lock_key on territory_reservations is the lock: only one insert can win.

function lockKey(tenantId: string, territoryId: string): string {
  return `${tenantId}:${territoryId}`;
}

export async function reserveTerritory(
  store: Store,
  ctx: TenantContext,
  args: { territoryId: string; applicationId: string; reservationDays: number; now?: Date },
): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const territory = await repo.findOne("territories", { ROWID: args.territoryId });
  if (!territory) throw new AppError("TERRITORY_NOT_FOUND");
  if (territory.status !== "AVAILABLE") throw new AppError("TERRITORY_NOT_AVAILABLE");

  const now = args.now ?? new Date();
  let reservation: Row;
  try {
    reservation = await repo.insert("territory_reservations", {
      territory_id: args.territoryId,
      application_id: args.applicationId,
      reserved_by: ctx.userId,
      status: "ACTIVE",
      reserved_at: now.toISOString(),
      expires_at: new Date(now.getTime() + toNum(args.reservationDays) * 86_400_000).toISOString(),
      active_lock_key: lockKey(ctx.tenantId, args.territoryId),
    });
  } catch (e) {
    if (e instanceof DuplicateKeyError) throw new AppError("TERRITORY_CONFLICT", "This territory was just reserved by someone else.");
    throw e;
  }
  await repo.update("territories", args.territoryId, { status: "RESERVED" });
  await logActivity(store, ctx, { entityType: "territory", entityId: args.territoryId, action: "territory:reserve", metadata: { application_id: args.applicationId } });
  return reservation;
}

export async function releaseTerritory(store: Store, ctx: TenantContext, args: { reservationId: string; reason: "RELEASED" | "EXPIRED" | "CONVERTED" }): Promise<void> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const r = await repo.findOne("territory_reservations", { ROWID: args.reservationId });
  if (!r || r.status !== "ACTIVE") return; // idempotent
  await repo.update("territory_reservations", args.reservationId, { status: args.reason, active_lock_key: `closed:${args.reservationId}` });
  // CONVERTED means the franchise was awarded: territory stays taken.
  await repo.update("territories", String(r.territory_id), { status: args.reason === "CONVERTED" ? "ALLOCATED" : "AVAILABLE" });
  await logActivity(store, ctx, { entityType: "territory", entityId: String(r.territory_id), action: `territory:${args.reason.toLowerCase()}` });
}

// What happens to an active reservation, by the state of its application.
const CONVERT_STATES = ["AGREEMENT_SIGNED", "ONBOARDING", "ACTIVE"];
const CLOSED_STATES = ["REJECTED", "WITHDRAWN", "DECLINED", "DROPPED", "CLOSED"];
// Before a site is in, a reservation lapses after its days; once the deal is moving it holds.
const LAPSING_STATES = ["UNDER_REVIEW", "QUALIFIED", "SITE_REQUIRED", "ON_HOLD"];

/** A signed agreement awards the application's reserved territory for good (ALLOCATED). */
export async function allocateTerritory(store: Store, ctx: TenantContext, applicationId: string): Promise<boolean> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const r = await repo.findOne("territory_reservations", { application_id: applicationId, status: "ACTIVE" });
  if (!r) return false;
  await releaseTerritory(store, ctx, { reservationId: String(r.ROWID), reason: "CONVERTED" });
  return true;
}

/**
 * job_reservation_expiry (D-19), daily: converts reservations of signed applications, frees those of
 * closed applications, and lets reservations lapse past expires_at while the application is still
 * before the site stage. An application that loses its territory has territory_id cleared.
 */
export async function expireReservations(store: Store, ctx: TenantContext, now: Date): Promise<{ expired: number; released: number; allocated: number }> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const out = { expired: 0, released: 0, allocated: 0 };
  for (const r of await repo.findMany("territory_reservations", { status: "ACTIVE" })) {
    const app = await repo.findOne("franchise_applications", { ROWID: String(r.application_id) });
    const state = String(app?.status ?? "");
    let reason: "EXPIRED" | "RELEASED" | "CONVERTED" | null = null;
    if (CONVERT_STATES.includes(state)) reason = "CONVERTED";
    else if (!app || CLOSED_STATES.includes(state)) reason = "RELEASED";
    else if (LAPSING_STATES.includes(state) && new Date(String(r.expires_at)) < now) reason = "EXPIRED";
    if (!reason) continue;
    await releaseTerritory(store, ctx, { reservationId: String(r.ROWID), reason });
    if (reason === "CONVERTED") out.allocated++;
    else {
      reason === "EXPIRED" ? out.expired++ : out.released++;
      if (app && String(app.territory_id) === String(r.territory_id)) await repo.update("franchise_applications", String(app.ROWID), { territory_id: null });
    }
  }
  return out;
}

/** Runs expireReservations for every active tenant; a failing tenant is logged and skipped. */
export async function runReservationJob(store: Store, opts: { now: Date; requestId: string }) {
  const out = { tenants: 0, expired: 0, released: 0, allocated: 0, failed: 0 };
  for (const tenant of await store.findMany("tenants", { status: "ACTIVE" })) {
    const tenantId = String(tenant.ROWID);
    const ctx: TenantContext = { tenantId, userId: "SYSTEM:job", roles: ["SYSTEM"], zohoDc: String(tenant.zoho_dc), requestId: opts.requestId, correlationId: opts.requestId };
    out.tenants++;
    try {
      const r = await expireReservations(store, ctx, opts.now);
      out.expired += r.expired; out.released += r.released; out.allocated += r.allocated;
    } catch (e) {
      out.failed++;
      log("warn", "job.reservations_failed", { tenant_id: tenantId, request_id: opts.requestId, error: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  }
  log("info", "job.reservations", { request_id: opts.requestId, ...out });
  return out;
}

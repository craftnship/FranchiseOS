import { AppError } from "../common/errors";
import { TenantContext } from "../common/context";
import { DuplicateKeyError, Row, Store, TenantRepo } from "../common/store";
import { logActivity } from "../common/audit";
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

/** job_reservation_expiry (D-19). */
export async function expireReservations(store: Store, ctx: TenantContext, now: Date): Promise<number> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const active = await repo.findMany("territory_reservations", { status: "ACTIVE" });
  const expired = active.filter((r) => new Date(String(r.expires_at)) < now);
  for (const r of expired) await releaseTerritory(store, ctx, { reservationId: String(r.ROWID), reason: "EXPIRED" });
  return expired.length;
}

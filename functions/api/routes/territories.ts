import { z } from "zod";
import { AppError } from "../../common/errors";
import { logActivity } from "../../common/audit";
import { nextBusinessId } from "../../common/ids";
import { toNum } from "../../common/values";
import { opportunityScore } from "../../scoring/territory";
import { releaseTerritory, reserveTerritory } from "../../workflows/territoryReservation";
import { DEFAULTS } from "../../../database/seed/defaults";
import { page, parse, Router } from "../router";
import { mustGet } from "./shared";

const index = z.number().min(0).max(100).optional();
const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  country: z.string().trim().max(60).optional(),
  state: z.string().trim().max(60).optional(),
  region: z.string().trim().max(60).optional(),
  city: z.string().trim().min(1).max(60),
  franchise_type: z.string().trim().max(50).optional(),
  population: z.number().int().nonnegative().optional(),
  market_size: z.number().nonnegative().optional(),
  // Indices are normalised 0..100 (D-16).
  population_index: index,
  market_index: index,
  income_index: index,
  competition_index: index,
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
}).strict();
const searchSchema = z.object({
  city: z.string().trim().optional(),
  state: z.string().trim().optional(),
  franchise_type: z.string().trim().optional(),
  status: z.enum(["AVAILABLE", "RESERVED", "ALLOCATED", "BLOCKED"]).default("AVAILABLE"),
}).strict();
const reserveSchema = z.object({ application_id: z.string().min(1) }).strict();
const releaseSchema = z.object({ reservation_id: z.string().min(1).optional() }).strict();

const RESERVABLE_APP_STATES = ["UNDER_REVIEW", "QUALIFIED"];

export function territoryRoutes(r: Router): void {
  r.on("GET", "/territories", "territory.reserve", async (call) => {
    const q = parse(page.extend({ status: z.string().optional(), city: z.string().optional() }), call.query);
    const where = { ...(q.status ? { status: q.status } : {}), ...(q.city ? { city: q.city } : {}) };
    return call.repo.findMany("territories", where, { orderBy: "territory_code", limit: q.limit, offset: q.offset });
  });

  r.on("POST", "/territories", "territory.write", async (call) => {
    const { population_index, market_index, ...body } = parse(createSchema, call.body);
    const hasIndices = [population_index, market_index, body.income_index, body.competition_index].every((v) => v !== undefined);
    const opportunity_score = hasIndices
      ? opportunityScore({ population: population_index!, market_size: market_index!, income_index: body.income_index!, competition_index: body.competition_index! })
      : null;
    const territory_code = await nextBusinessId(call.store, call.ctx.tenantId, "territory");
    const row = await call.repo.insert("territories", {
      ...body, territory_code, tenant_code_key: `${call.ctx.tenantId}:${territory_code}`, status: "AVAILABLE", opportunity_score,
    });
    await logActivity(call.store, call.ctx, { entityType: "territory", entityId: String(row.ROWID), action: "create" });
    return row;
  }, 201);

  r.on("POST", "/territories/search", "territory.reserve", async (call) => {
    const q = parse(searchSchema, call.body);
    const where = Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== "")) as Record<string, string>;
    const rows = await call.repo.findMany("territories", where, { limit: 300 });
    return rows.sort((a, b) => toNum(b.opportunity_score) - toNum(a.opportunity_score));
  });

  r.on("POST", "/territories/:id/reserve", "territory.reserve", async (call) => {
    const { application_id } = parse(reserveSchema, call.body);
    const territory = await mustGet(call.repo, "territories", call.params.id, "TERRITORY_NOT_FOUND");
    const app = await mustGet(call.repo, "franchise_applications", application_id, "APPLICATION_NOT_FOUND");
    if (!RESERVABLE_APP_STATES.includes(String(app.status))) {
      throw new AppError("APPLICATION_INVALID_STATE", `A territory cannot be reserved for an application in ${app.status}.`);
    }
    if (app.territory_id) throw new AppError("TERRITORY_CONFLICT", "This application already holds a territory. Release it first.");
    const rule = await call.repo.findOne("territory_rules", territory.franchise_type ? { franchise_type: String(territory.franchise_type) } : {});
    const reservation = await reserveTerritory(call.store, call.ctx, {
      territoryId: call.params.id, applicationId: application_id, now: call.now,
      reservationDays: rule ? toNum(rule.reservation_days) : DEFAULTS.territoryRule.reservation_days,
    });
    await call.repo.update("franchise_applications", application_id, { territory_id: call.params.id });
    return reservation;
  });

  r.on("POST", "/territories/:id/release", "territory.reserve", async (call) => {
    const { reservation_id } = parse(releaseSchema, call.body);
    await mustGet(call.repo, "territories", call.params.id, "TERRITORY_NOT_FOUND");
    const active = reservation_id
      ? await call.repo.findOne("territory_reservations", { ROWID: reservation_id, territory_id: call.params.id })
      : await call.repo.findOne("territory_reservations", { territory_id: call.params.id, status: "ACTIVE" });
    if (!active || active.status !== "ACTIVE") throw new AppError("TERRITORY_NOT_FOUND", "No active reservation on this territory.");
    await releaseTerritory(call.store, call.ctx, { reservationId: String(active.ROWID), reason: "RELEASED" });
    const app = await call.repo.findOne("franchise_applications", { ROWID: String(active.application_id) });
    if (app && String(app.territory_id) === call.params.id) await call.repo.update("franchise_applications", String(app.ROWID), { territory_id: null });
    return { released: true, reservation_id: String(active.ROWID) };
  });
}

import { z } from "zod";
import { logActivity } from "../../common/audit";
import { AppError } from "../../common/errors";
import { allowed, isPortalUser } from "../../common/rbac";
import { Row } from "../../common/store";
import { toNumOrNull } from "../../common/values";
import { DEFAULT_HEALTH, HEALTH_PARTS, HealthReason, HealthSettings, PART_LABEL, PartResult } from "../../scoring/health";
import { healthHistory, healthSettingsFor, refreshStoreHealth, settingsOf } from "../../workflows/storeHealth";
import { Call, parse, Router } from "../router";
import { storeNamer } from "./owner";
import { regionScope } from "./regions";
import { assertOwner, fetchAll, mustGet } from "./shared";

// Franchisee health (docs/health-score.md) as the dashboard, the store page and the settings read it.
// The score itself is kept on the project by the nightly job (workflows/storeHealth.ts); these routes
// only read it, apart from the recalculation an admin can ask for.


const weight = z.number().min(0).max(100);
const settingsSchema = z.object({
  weights: z.object({ sales: weight, payments: weight, compliance: weight, reporting: weight, customer: weight }).strict(),
  thresholds: z.object({ healthy_from: z.number().int().min(1).max(100), watch_from: z.number().int().min(0).max(99), part_floor: z.number().int().min(0).max(100) }).strict(),
}).strict();

interface Stored { parts?: PartResult[]; reasons?: HealthReason[]; capped?: boolean }
const stored = (p: Row): Stored => { try { return p.health_json ? JSON.parse(String(p.health_json)) : {}; } catch { return {}; } };

/** Reasons in the words the caller may see: amounts only with finance.view. */
const reasonsFor = (s: Stored, finance: boolean) => (s.reasons ?? []).map((r) => ({ part: r.part, label: PART_LABEL[r.part], score: r.score, text: finance && r.money ? r.money : r.text }));

const settingsView = (s: HealthSettings) => ({ weights: s.weights, thresholds: s.thresholds, parts: HEALTH_PARTS.map((p) => ({ part: p, label: PART_LABEL[p] })), defaults: DEFAULT_HEALTH });

async function financeFor(call: Call): Promise<boolean> {
  return !isPortalUser(call.ctx) && allowed(call.ctx, "finance.view", call.permissions);
}

export function healthRoutes(r: Router): void {
  // The network's health: a count per band, every scored store and the lowest five, in the caller's region.
  r.on("GET", "/dashboard/health", "dashboard.view", async (call) => {
    const [projects, sites, territories, apps, franchisees, tenant, scope, finance] = await Promise.all([
      fetchAll(call.repo, "franchise_projects", { status: "OPENED" }), fetchAll(call.repo, "sites"), fetchAll(call.repo, "territories"), fetchAll(call.repo, "franchise_applications"),
      fetchAll(call.repo, "franchisees"), call.store.findOne("tenants", { ROWID: call.ctx.tenantId }), regionScope(call), financeFor(call),
    ]);
    const place = storeNamer(projects, sites, territories, apps, franchisees);
    const trading = projects.filter((p) => p.actual_opening_date && scope.project(p));
    const stores = trading.map((p) => {
      const where = place(p.ROWID), s = stored(p);
      return {
        project_id: String(p.ROWID), project_code: String(p.project_code), name: where.name, city: where.city, region: where.region, franchisee: where.franchisee,
        score: toNumOrNull(p.health_score), band: (p.health_band as string | null) ?? null, capped: !!s.capped, reasons: reasonsFor(s, finance), updated_on: p.health_updated_on ? String(p.health_updated_on).slice(0, 10) : null,
      };
    }).sort((a, b) => (a.score ?? 101) - (b.score ?? 101) || a.name.localeCompare(b.name));
    const scored = stores.filter((s) => s.score !== null);
    const count = (band: string) => scored.filter((s) => s.band === band).length;
    return {
      region: scope.region, region_locked: scope.locked, finance,
      bands: { healthy: count("HEALTHY"), watch: count("WATCH"), at_risk: count("AT_RISK"), unscored: stores.length - scored.length },
      average: scored.length ? Math.round(scored.reduce((a, s) => a + (s.score as number), 0) / scored.length) : null,
      lowest: scored.slice(0, 5), stores,
      thresholds: healthSettingsFor(tenant).thresholds,
      as_of: scored.map((s) => s.updated_on).filter(Boolean).sort().at(-1) ?? null,
    };
  });

  // One store's score, parts, reasons and trend: staff with dashboard.view, or the store's own franchisee.
  r.on("GET", "/projects/:id/health", null, async (call) => {
    const project = assertOwner(call, await mustGet(call.repo, "franchise_projects", call.params.id, "NOT_FOUND"), "NOT_FOUND");
    if (!isPortalUser(call.ctx) && !(await allowed(call.ctx, "dashboard.view", call.permissions))) throw new AppError("ACCESS_DENIED");
    const [tenant, finance] = await Promise.all([call.store.findOne("tenants", { ROWID: call.ctx.tenantId }), financeFor(call)]);
    const s = stored(project);
    const today = call.now.toISOString().slice(0, 10);
    return {
      project_id: String(project.ROWID), project_code: String(project.project_code), trading: project.status === "OPENED" && !!project.actual_opening_date,
      score: toNumOrNull(project.health_score), band: (project.health_band as string | null) ?? null, capped: !!s.capped,
      updated_on: project.health_updated_on ? String(project.health_updated_on).slice(0, 10) : null,
      parts: HEALTH_PARTS.map((part) => { const p = s.parts?.find((x) => x.part === part); return { part, label: PART_LABEL[part], score: p?.score ?? null, weight: p?.weight ?? 0, detail: p?.detail ?? "No data yet" }; }),
      reasons: reasonsFor(s, finance),
      history: await healthHistory(call.repo, String(project.ROWID), today),
      thresholds: healthSettingsFor(tenant).thresholds,
    };
  });

  // Scores every trading store now: for the first run, and after the weights change.
  r.on("POST", "/admin/health/recalculate", "settings.manage", async (call) => {
    const out = await refreshStoreHealth(call.store, call.ctx, call.now.toISOString().slice(0, 10));
    await logActivity(call.store, call.ctx, { entityType: "tenant", entityId: call.ctx.tenantId, action: "health:recalculated", metadata: { ...out } });
    return out;
  });

  r.on("GET", "/settings/health", "settings.manage", async (call) => settingsView(healthSettingsFor(await call.store.findOne("tenants", { ROWID: call.ctx.tenantId }))));

  r.on("PUT", "/settings/health", "settings.manage", async (call) => {
    const b = parse(settingsSchema, call.body);
    if (!Object.values(b.weights).some((w) => w > 0)) throw new AppError("VALIDATION_FAILED", "At least one part needs a weight.", { weights: "all zero" });
    if (b.thresholds.watch_from >= b.thresholds.healthy_from) throw new AppError("VALIDATION_FAILED", "Watch must start below Healthy.", { thresholds: "watch_from must be below healthy_from" });
    const tenant = await call.store.findOne("tenants", { ROWID: call.ctx.tenantId });
    if (!tenant) throw new AppError("TENANT_NOT_FOUND");
    const settings = settingsOf(tenant);
    Object.assign(settings, { health_weights: b.weights, health_healthy_from: b.thresholds.healthy_from, health_watch_from: b.thresholds.watch_from, health_part_floor: b.thresholds.part_floor });
    await call.store.update("tenants", call.ctx.tenantId, { settings_json: JSON.stringify(settings) });
    await logActivity(call.store, call.ctx, { entityType: "tenant", entityId: call.ctx.tenantId, action: "settings:health", metadata: { ...b.weights, ...b.thresholds } });
    return settingsView(healthSettingsFor(await call.store.findOne("tenants", { ROWID: call.ctx.tenantId })));
  });
}

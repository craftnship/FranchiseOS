import { z } from "zod";
import { AppError } from "../../common/errors";
import { Row } from "../../common/store";
import { Call, parse, Router } from "../router";
import { fetchAll, listByStatus } from "./shared";

// Region scope for the dashboards and the map. A region is a territory's `region`; a store, opening or
// application belongs to the region of its site's territory, else its application's territory.
// Staff with a region on their user (regional managers) always see that region, whatever they ask for.

export interface RegionScope {
  region: string | null;
  locked: boolean;
  territory(t: Row): boolean;
  application(a: Row): boolean;
  applicationId(id: unknown): boolean;
  project(p: Row): boolean;
  projectId(id: unknown): boolean;
  franchisee(f: Row): boolean;
}

const ALL: RegionScope = { region: null, locked: false, territory: () => true, application: () => true, applicationId: () => true, project: () => true, projectId: () => true, franchisee: () => true };

const regionQuery = z.object({ region: z.string().trim().max(60).optional() }).passthrough();

/** The region this call is limited to: the caller's own when they have one, else the `region` asked for. */
export function regionFor(call: Pick<Call, "ctx" | "query">): { region: string | null; locked: boolean } {
  if (call.ctx.region) return { region: call.ctx.region, locked: true };
  const q = parse(regionQuery, call.query);
  return { region: q.region || null, locked: false };
}

/** Membership tests for one region, built from the rows that tie records to a territory. */
export function scopeOf(region: string | null, locked: boolean, rows: { territories: Row[]; sites: Row[]; apps: Row[]; projects: Row[] }): RegionScope {
  if (!region) return ALL;
  const key = region.toLowerCase();
  const terIn = new Set(rows.territories.filter((t) => String(t.region ?? "").toLowerCase() === key).map((t) => String(t.ROWID)));
  const siteOf = new Map(rows.sites.map((s) => [String(s.ROWID), s]));
  const siteOfApp = new Map(rows.sites.filter((s) => s.application_id).map((s) => [String(s.application_id), s]));
  const appIn = (a: Row | undefined) => !!a && terIn.has(String(siteOfApp.get(String(a.ROWID))?.territory_id ?? a.territory_id ?? ""));
  const appOf = new Map(rows.apps.map((a) => [String(a.ROWID), a]));
  const projIn = (p: Row | undefined) => {
    if (!p) return false;
    const site = siteOf.get(String(p.site_id ?? ""));
    if (site?.territory_id) return terIn.has(String(site.territory_id));
    return appIn(appOf.get(String(p.application_id ?? "")));
  };
  const appsIn = new Set(rows.apps.filter(appIn).map((a) => String(a.ROWID)));
  const projectsIn = new Set(rows.projects.filter(projIn).map((p) => String(p.ROWID)));
  const franchiseesIn = new Set([...rows.apps.filter((a) => appsIn.has(String(a.ROWID))), ...rows.projects.filter((p) => projectsIn.has(String(p.ROWID)))].map((x) => String(x.franchisee_id ?? "")));
  return {
    region, locked,
    territory: (t) => terIn.has(String(t.ROWID)),
    application: (a) => appsIn.has(String(a.ROWID)),
    applicationId: (id) => appsIn.has(String(id ?? "")),
    project: (p) => projectsIn.has(String(p.ROWID)),
    projectId: (id) => projectsIn.has(String(id ?? "")),
    franchisee: (f) => franchiseesIn.has(String(f.ROWID)),
  };
}

/** The scope for a call, reading the linking tables only when a region applies. */
export async function regionScope(call: Call): Promise<RegionScope> {
  const { region, locked } = regionFor(call);
  if (!region) return ALL;
  const [territories, sites, apps, projects] = await Promise.all([
    fetchAll(call.repo, "territories"), fetchAll(call.repo, "sites"), fetchAll(call.repo, "franchise_applications"), fetchAll(call.repo, "franchise_projects"),
  ]);
  return scopeOf(region, locked, { territories, sites, apps, projects });
}

/**
 * A list limited to the call's region. Without one it is the usual paged query; with one, the matching
 * rows are read in full, kept by `keep` and paged in code, newest first.
 */
export async function listInRegion(call: Call, table: string, status: string | undefined, where: Record<string, string>, pg: { limit: number; offset: number }, keep: (scope: RegionScope) => (row: Row) => boolean): Promise<Row[]> {
  const scope = await regionScope(call);
  if (!scope.region) return listByStatus(call.repo, table, status, where, pg);
  const statuses = (status ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const rows = statuses.length ? (await Promise.all(statuses.map((s) => fetchAll(call.repo, table, { ...where, status: s })))).flat() : await fetchAll(call.repo, table, where);
  const test = keep(scope);
  return rows.filter(test).sort((a, b) => String(b.CREATEDTIME ?? "").localeCompare(String(a.CREATEDTIME ?? ""))).slice(pg.offset, pg.offset + pg.limit);
}

export function regionRoutes(r: Router): void {
  // The regions the dashboard can be filtered to, and the caller's own when they are limited to one.
  r.on("GET", "/dashboard/regions", "dashboard.view", async (call) => {
    const { region, locked } = regionFor(call);
    const territories = await fetchAll(call.repo, "territories");
    const regions = [...new Set(territories.map((t) => String(t.region ?? "").trim()).filter(Boolean))].sort();
    return { regions: locked ? regions.filter((x) => x.toLowerCase() === region!.toLowerCase()) : regions, region, locked };
  });
}

/** Region names a user can be limited to; refuses one no territory uses. */
export async function checkRegion(call: Call, region: string | null | undefined): Promise<string | null> {
  const v = region?.trim();
  if (!v) return null;
  const territories = await fetchAll(call.repo, "territories");
  const match = territories.map((t) => String(t.region ?? "").trim()).find((x) => x.toLowerCase() === v.toLowerCase());
  if (!match) throw new AppError("VALIDATION_FAILED", "No territory is in that region.", { region: "unknown" });
  return match;
}

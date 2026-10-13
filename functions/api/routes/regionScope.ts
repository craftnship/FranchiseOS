import { z } from "zod";
import { Row } from "../../common/store";
import { Call, parse } from "../router";

// Region scope: a region is a territory's `region`; a store, opening or application belongs to the
// region of its site's territory, else its application's territory. Staff with a region on their user
// (regional managers) always see that region, whatever they ask for. Pure: no table reads here.

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

export const ALL_REGIONS: RegionScope = { region: null, locked: false, territory: () => true, application: () => true, applicationId: () => true, project: () => true, projectId: () => true, franchisee: () => true };

const regionQuery = z.object({ region: z.string().trim().max(60).optional() }).passthrough();

/** The region this call is limited to: the caller's own when they have one, else the `region` asked for. */
export function regionFor(call: Pick<Call, "ctx" | "query">): { region: string | null; locked: boolean } {
  if (call.ctx.region) return { region: call.ctx.region, locked: true };
  const q = parse(regionQuery, call.query);
  return { region: q.region || null, locked: false };
}

/** Membership tests for one region, built from the rows that tie records to a territory. */
/** True when the region the caller is held to admits this row: a project, site, application, territory, or a row that carries project_id or application_id. */
export function inScope(scope: RegionScope, row: Row): boolean {
  if (!scope.region) return true;
  if (row.project_code !== undefined) return scope.project(row);
  if (row.application_code !== undefined) return scope.application(row);
  if (row.territory_code !== undefined) return scope.territory(row);
  if (row.site_code !== undefined) return scope.applicationId(row.application_id);
  if (row.project_id) return scope.projectId(row.project_id);
  if (row.application_id) return scope.applicationId(row.application_id);
  return true;
}

export function scopeOf(region: string | null, locked: boolean, rows: { territories: Row[]; sites: Row[]; apps: Row[]; projects: Row[] }): RegionScope {
  if (!region) return ALL_REGIONS;
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


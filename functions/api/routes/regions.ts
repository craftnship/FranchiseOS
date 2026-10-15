import { AppError } from "../../common/errors";
import { Row } from "../../common/store";
import { Call, Router } from "../router";
import { ALL_REGIONS, regionFor, RegionScope, scopeOf } from "./regionScope";
import { fetchAll, listByStatus } from "./shared";

export { regionFor, RegionScope, scopeOf } from "./regionScope";

// Region scope for the dashboards and the map. A region is a territory's `region`; a store, opening or
// application belongs to the region of its site's territory, else its application's territory.
// Staff with a region on their user (regional managers) always see that region, whatever they ask for.

/** The scope for a call, reading the linking tables only when a region applies. */
export async function regionScope(call: Call): Promise<RegionScope> {
  const { region, locked } = regionFor(call);
  if (!region) return ALL_REGIONS;
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

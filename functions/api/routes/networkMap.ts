import { Row } from "../../common/store";
import { toNumOrNull } from "../../common/values";
import { cityCoords } from "../../common/indiaCities";
import { Router } from "../router";
import { fetchAll } from "./shared";
import { storeNamer } from "./owner";

// The network map: open stores, openings in progress and territories not yet taken, each placed by
// its site's coordinates, else its territory's, else its city's centre. Rolled up by state too.

const ACTIVE = ["NOT_STARTED", "PLANNING", "IN_PROGRESS", "AT_RISK", "READY_FOR_OPENING"];
export type PointKind = "store" | "opening" | "territory";
export interface MapPoint { kind: PointKind; id: string; name: string; city: string | null; state: string | null; status: string; detail: string | null; href: string; lat: number; lng: number; located: "site" | "territory" | "city" }

const coordsOf = (row: Row | undefined): [number, number] | null => {
  const lat = toNumOrNull(row?.latitude), lng = toNumOrNull(row?.longitude);
  return lat !== null && lng !== null && (lat || lng) ? [lat, lng] : null;
};

export function networkMapRoutes(r: Router): void {
  r.on("GET", "/dashboard/map", "dashboard.view", async (call) => {
    const [projects, sites, territories, apps, franchisees] = await Promise.all([
      fetchAll(call.repo, "franchise_projects"), fetchAll(call.repo, "sites"), fetchAll(call.repo, "territories"), fetchAll(call.repo, "franchise_applications"), fetchAll(call.repo, "franchisees"),
    ]);
    const by = (rows: Row[]) => new Map(rows.map((x) => [String(x.ROWID), x]));
    const siteOf = by(sites), terOf = by(territories), appOf = by(apps);
    const place = storeNamer(projects, sites, territories, apps, franchisees);
    const points: MapPoint[] = [];
    const unplaced: { kind: PointKind; name: string }[] = [];
    const used = new Set<string>();
    const locate = (site: Row | undefined, ter: Row | undefined, city: unknown) => {
      const s = coordsOf(site); if (s) return { at: s, located: "site" as const };
      const t = coordsOf(ter); if (t) return { at: t, located: "territory" as const };
      const c = cityCoords(city) ?? cityCoords(ter?.name); return c ? { at: c, located: "city" as const } : null;
    };
    for (const p of projects) {
      const kind: PointKind | null = p.status === "OPENED" ? "store" : ACTIVE.includes(String(p.status)) ? "opening" : null;
      if (!kind) continue;
      const site = siteOf.get(String(p.site_id));
      const ter = terOf.get(String(site?.territory_id ?? appOf.get(String(p.application_id))?.territory_id ?? ""));
      if (ter) used.add(String(ter.ROWID));
      const where = place(p.ROWID);
      const loc = locate(site, ter, where.city);
      if (!loc) { unplaced.push({ kind, name: where.name }); continue; }
      points.push({
        kind, id: String(p.ROWID), name: where.name, city: where.city, state: (site?.state ?? ter?.state ?? null) as string | null,
        status: kind === "store" ? "OPENED" : String(p.readiness_rag ?? p.status), detail: where.franchisee,
        href: `/projects/${p.ROWID}`, lat: loc.at[0], lng: loc.at[1], located: loc.located,
      });
    }
    // Territories with no store or opening on them yet: where the network can still grow.
    for (const t of territories) {
      if (used.has(String(t.ROWID)) || !["AVAILABLE", "RESERVED", "ALLOCATED"].includes(String(t.status))) continue;
      const loc = locate(undefined, t, t.city);
      if (!loc) { unplaced.push({ kind: "territory", name: String(t.name ?? t.territory_code) }); continue; }
      const score = toNumOrNull(t.opportunity_score);
      points.push({
        kind: "territory", id: String(t.ROWID), name: String(t.name ?? t.territory_code), city: (t.city ?? null) as string | null, state: (t.state ?? null) as string | null,
        status: String(t.status), detail: score === null ? null : `Opportunity score ${score}`, href: `/territories?status=${t.status}`, lat: loc.at[0], lng: loc.at[1], located: loc.located,
      });
    }
    const states = new Map<string, { state: string; stores: number; openings: number; territories: number }>();
    for (const p of points) {
      const k = p.state ?? "Unknown";
      const s = states.get(k) ?? states.set(k, { state: k, stores: 0, openings: 0, territories: 0 }).get(k)!;
      s[p.kind === "store" ? "stores" : p.kind === "opening" ? "openings" : "territories"]++;
    }
    return {
      points,
      by_state: [...states.values()].sort((a, b) => b.stores - a.stores || b.openings - a.openings || b.territories - a.territories || a.state.localeCompare(b.state)),
      totals: { stores: points.filter((p) => p.kind === "store").length, openings: points.filter((p) => p.kind === "opening").length, territories: points.filter((p) => p.kind === "territory").length },
      unplaced,
    };
  });
}

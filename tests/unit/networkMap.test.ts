import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { cityCoords } from "../../functions/common/indiaCities";
import { newStore } from "./helpers";

const router = buildRouter();

describe("network map", () => {
  it("places stores, openings and open territories, falling back to the city", async () => {
    const store = newStore();
    const t = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
    const tid = t.tenantId;
    const ins = (table: string, row: Record<string, unknown>) => store.insert(table, { tenant_id: tid, ...row });
    await ins("users", { email: "dir@x.test", status: "ACTIVE", role_id: t.roleIds.FRANCHISE_DIRECTOR, external_user_id: "dir" });
    const ter = (n: number, name: string, status: string, extra: Record<string, unknown> = {}) => ins("territories", { territory_code: `TER-${n}`, tenant_code_key: `${tid}:TER-${n}`, name, status, ...extra });
    const t1 = await ter(1, "Chennai T Nagar", "ALLOCATED", { city: "Chennai", state: "Tamil Nadu" });
    const t2 = await ter(2, "Kochi Central", "ALLOCATED", { city: "Kochi", state: "Kerala" });
    await ter(3, "Salem Metro", "AVAILABLE", { city: "Salem", state: "Tamil Nadu", latitude: 11.6, longitude: 78.1, opportunity_score: 72 });
    await ter(4, "Somewhere", "RESERVED", { city: "Nowhere" });
    const s1 = await ins("sites", { site_code: "S1", tenant_code_key: `${tid}:S1`, territory_id: t1.ROWID, city: "Chennai", state: "Tamil Nadu", latitude: 13.04, longitude: 80.23 });
    const s2 = await ins("sites", { site_code: "S2", tenant_code_key: `${tid}:S2`, territory_id: t2.ROWID, city: "Kochi", state: "Kerala" });
    await ins("franchise_projects", { project_code: "P1", tenant_code_key: `${tid}:P1`, site_id: s1.ROWID, status: "OPENED" });
    await ins("franchise_projects", { project_code: "P2", tenant_code_key: `${tid}:P2`, site_id: s2.ROWID, status: "IN_PROGRESS", readiness_rag: "GREEN" });
    const res = (await router.handle({ method: "GET", path: "/api/v1/dashboard/map", query: {}, identity: { externalUserId: "dir", email: "dir@x.test" } }, { store, now: () => new Date("2026-10-13T06:00:00Z") })).body as any;
    const pts = res.data.points.map((p: any) => [p.kind, p.name, p.status, p.located, p.lat]);
    expect(pts).toEqual([
      ["store", "Chennai T Nagar", "OPENED", "site", 13.04],
      ["opening", "Kochi Central", "GREEN", "city", 9.93],
      ["territory", "Salem Metro", "AVAILABLE", "territory", 11.6],
    ]);
    expect(res.data.totals).toEqual({ stores: 1, openings: 1, territories: 1 });
    expect(res.data.unplaced).toEqual([{ kind: "territory", name: "Somewhere" }]);
    expect(res.data.by_state[0]).toEqual({ state: "Tamil Nadu", stores: 1, openings: 0, territories: 1 });
  });

  it("matches a city at the start of a longer name", () => {
    expect(cityCoords("Bengaluru Jayanagar")).toEqual([12.97, 77.59]);
    expect(cityCoords("Navi Mumbai Vashi")).toEqual([19.03, 73.03]);
    expect(cityCoords("Atlantis")).toBeNull();
  });
});

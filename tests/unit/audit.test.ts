import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { buildSelect } from "../../functions/common/catalystStore";
import { newStore } from "./helpers";

const router = buildRouter();

async function setup() {
  const store = newStore();
  const a = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
  const b = await bootstrapTenant(store, { tenantCode: "WAYNE", name: "Wayne", zohoDc: "IN" });
  const tid = a.tenantId;
  const admin = await store.insert("users", { tenant_id: tid, email: "tony@x.test", name: "Tony", status: "ACTIVE", role_id: a.roleIds.SUPER_ADMIN, external_user_id: "tony" });
  await store.insert("users", { tenant_id: tid, email: "pm@x.test", status: "ACTIVE", role_id: a.roleIds.PROJECT_MANAGER, external_user_id: "pm" });
  const p = await store.insert("franchise_projects", { tenant_id: tid, project_code: "PROJ-000001", tenant_code_key: `${tid}:PROJ-000001`, status: "IN_PROGRESS" });
  const log = (t: string, at: string, action: string, entity_type: string, entity_id: string, actor: string, meta: object = {}) =>
    store.insert("activity_logs", { tenant_id: t, entity_type, entity_id, action, actor_user_id: actor, metadata_json: JSON.stringify({ ...meta, correlation_id: "COR-1" }), created_at: at });
  await log(tid, "2026-10-01T09:00:00.000Z", "project:built", "project", String(p.ROWID), "SYSTEM:job");
  await log(tid, "2026-10-05T10:00:00.000Z", "project:retarget", "project", String(p.ROWID), String(admin.ROWID), { from: "2026-12-31", to: "2027-01-11", reason: "Lease signed late" });
  await log(tid, "2026-10-09T11:00:00.000Z", "territory:reserve", "territory", "999", String(admin.ROWID));
  await log(b.tenantId, "2026-10-05T10:00:00.000Z", "project:retarget", "project", "1", "x");
  const call = async (ext: string, query: Record<string, string> = {}) => {
    const res = await router.handle({ method: "GET", path: "/api/v1/audit", query, identity: { externalUserId: ext, email: `${ext}@x.test` } }, { store });
    return res.body as { success: boolean; data?: any; error?: { code: string } };
  };
  return { call, admin, p };
}

describe("activity log viewer", () => {
  it("lists the tenant's activity newest first, with who did it and a link to the record", async () => {
    const s = await setup();
    const r = await s.call("tony");
    expect(r.data.items.map((i: any) => i.action)).toEqual(["territory:reserve", "project:retarget", "project:built"]);
    expect(r.data.items[1]).toMatchObject({
      entity: { label: "PROJ-000001", href: `/projects/${s.p.ROWID}` }, actor: { name: "Tony", email: "tony@x.test" },
      details: { reason: "Lease signed late" }, correlation_id: "COR-1",
    });
    expect(r.data.items[2].actor).toMatchObject({ name: "Scheduled job", system: true });
    expect(r.data.items[0].entity).toBeNull(); // the territory no longer exists
  });

  it("filters by record, person, dates and text, and pages", async () => {
    const s = await setup();
    const actions = async (q: Record<string, string>) => (await s.call("tony", q)).data.items.map((i: any) => i.action);
    expect(await actions({ entity_type: "project" })).toEqual(["project:retarget", "project:built"]);
    expect(await actions({ actor_user_id: String(s.admin.ROWID) })).toEqual(["territory:reserve", "project:retarget"]);
    expect(await actions({ from: "2026-10-05", to: "2026-10-05" })).toEqual(["project:retarget"]);
    expect(await actions({ q: "lease signed" })).toEqual(["project:retarget"]);
    const first = await s.call("tony", { limit: "2" });
    expect(first.data.next_offset).toBe(2);
    const second = await s.call("tony", { limit: "2", offset: "2" });
    expect(second.data).toMatchObject({ next_offset: null, items: [{ action: "project:built" }] });
  });

  it("is for administrators only", async () => {
    const s = await setup();
    expect((await s.call("pm")).error?.code).toBe("ACCESS_DENIED");
    expect((await s.call("tony", { from: "5 Oct" })).error?.code).toBe("VALIDATION_FAILED");
  });

  it("bounds dates in ZCQL", () => {
    expect(buildSelect("activity_logs", { tenant_id: "T1" }, { range: { column: "created_at", from: "2026-10-01", before: "2026-10-06" } }))
      .toBe("SELECT * FROM activity_logs WHERE tenant_id = 'T1' AND created_at >= '2026-10-01 00:00:00' AND created_at < '2026-10-06 00:00:00' LIMIT 300");
  });
});

import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { MemoryFileStorage } from "../../functions/common/files";
import { runReminderJob } from "../../functions/workflows/notifications";
import { newStore } from "./helpers";

const router = buildRouter();
const NOW = new Date("2026-10-09T06:00:00Z");

async function setup() {
  const store = newStore();
  const files = new MemoryFileStorage();
  const t = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
  const tid = t.tenantId;
  const fr = await store.insert("franchisees", { tenant_id: tid, franchise_code: "FR-000001", tenant_code_key: `${tid}:FR-000001`, display_name: "Pepper Potts", status: "ACTIVE" });
  const fr2 = await store.insert("franchisees", { tenant_id: tid, franchise_code: "FR-000002", tenant_code_key: `${tid}:FR-000002`, display_name: "Happy Hogan", status: "ACTIVE" });
  const user = (role: string, ext: string, franchiseeId?: string) => store.insert("users", { tenant_id: tid, email: `${ext}@x.test`, status: "ACTIVE", role_id: t.roleIds[role], external_user_id: ext, franchisee_id: franchiseeId ?? null });
  await user("PROJECT_MANAGER", "pm");
  await user("FRANCHISE_MANAGER", "mgr");
  await user("FRANCHISEE", "pepper", String(fr.ROWID));
  await user("FRANCHISEE", "happy", String(fr2.ROWID));
  const project = await store.insert("franchise_projects", { tenant_id: tid, project_code: "PROJ-000001", tenant_code_key: `${tid}:PROJ-000001`, application_id: "1", franchisee_id: fr.ROWID, status: "IN_PROGRESS", target_opening_date: "2026-10-30" });
  const call = async (ext: string, method: string, path: string, body?: unknown, now = NOW) => {
    const res = await router.handle({ method, path: `/api/v1${path}`, body, identity: { externalUserId: ext, email: `${ext}@x.test` } }, { store, files, now: () => now });
    return res.body as { success: boolean; data?: any; error?: { code: string; fields?: Record<string, string> } };
  };
  const licences = async () => (await call("pm", "GET", `/projects/${project.ROWID}`)).data.licences as any[];
  const inbox = async (ext: string) => (await call(ext, "GET", "/notifications")).data.items as any[];
  return { store, files, project, call, licences, inbox };
}

const pdf = { file_name: "fssai licence.pdf", content_type: "application/pdf", data_base64: Buffer.from("%PDF-1.4 test").toString("base64") };

describe("licence register", () => {
  it("seeds the six India licences once, mandatory first", async () => {
    const s = await setup();
    const first = await s.licences();
    expect(first.map((l) => l.licence_code)).toEqual(["FIRE_NOC", "FSSAI", "GST", "SHOP_EST", "TRADE", "SIGNAGE"]);
    expect(first.every((l) => l.status === "NOT_STARTED")).toBe(true);
    expect(await s.licences()).toHaveLength(6);
    expect(await s.store.findMany("licences", {})).toHaveLength(6);
  });

  it("the franchisee uploads a certificate for their own store only; staff open it through a short link", async () => {
    const s = await setup();
    const fssai = (await s.licences()).find((l) => l.licence_code === "FSSAI");
    const path = `/projects/${s.project.ROWID}/licences/${fssai.ROWID}/certificate`;
    expect((await s.call("happy", "POST", path, pdf)).error?.code).toBe("NOT_FOUND");
    const up = await s.call("pepper", "POST", path, pdf);
    expect(up.data.file_ref).toMatch(/^stratus:tenants\/\d+\/projects\/\d+\/licences\/.+\/fssai_licence\.pdf$/);
    expect((await s.call("pm", "GET", path)).data.url).toMatch(/^memory:/);
    // Only staff record the licence as issued.
    expect((await s.call("pepper", "PATCH", `/projects/${s.project.ROWID}/licences/${fssai.ROWID}`, { status: "ISSUED", issued_on: "2026-10-01" })).error?.code).toBe("ACCESS_DENIED");
    expect((await s.call("pm", "PATCH", `/projects/${s.project.ROWID}/licences/${fssai.ROWID}`, { status: "ISSUED" })).error?.fields).toEqual({ issued_on: "required when issued" });
  });

  it("reminds about missing licences near opening, renewals coming up, and expiry", async () => {
    const s = await setup();
    const ls = await s.licences();
    const trade = ls.find((l) => l.licence_code === "TRADE");
    await s.call("pm", "PATCH", `/projects/${s.project.ROWID}/licences/${trade.ROWID}`, { status: "ISSUED", issued_on: "2026-01-01", expires_on: "2026-11-01" });
    const r1 = await runReminderJob(s.store, { now: NOW, requestId: "R1" });
    expect(r1.licences).toBeGreaterThanOrEqual(2);
    const pm = (await s.inbox("pm")).map((n) => n.title);
    expect(pm).toContain("4 mandatory licences are missing for PROJ-000001");
    expect(pm).toContain("Trade licence for PROJ-000001 expires 1 Nov 2026");
    expect((await s.inbox("pepper")).map((n) => n.title)).toContain("4 mandatory licences are missing for PROJ-000001");

    // After the expiry date the licence is marked expired and people are told.
    await runReminderJob(s.store, { now: new Date("2026-11-03T06:00:00Z"), requestId: "R2" });
    expect((await s.store.findOne("licences", { ROWID: String(trade.ROWID) }))!.status).toBe("EXPIRED");
    expect((await s.inbox("mgr")).map((n) => n.title)).toContain("Trade licence has expired for PROJ-000001");
    // Recording the renewal brings it back.
    const renewed = await s.call("pm", "PATCH", `/projects/${s.project.ROWID}/licences/${trade.ROWID}`, { expires_on: "2027-11-01" }, new Date("2026-11-03T06:00:00Z"));
    expect(renewed.data.status).toBe("ISSUED");
  });

  it("staff add a licence of their own", async () => {
    const s = await setup();
    const added = await s.call("pm", "POST", `/projects/${s.project.ROWID}/licences`, { name: "Liquor licence", authority: "Excise department", mandatory: true });
    expect(added.data).toMatchObject({ name: "Liquor licence", mandatory: true, status: "NOT_STARTED" });
    expect(await s.licences()).toHaveLength(7);
  });
});

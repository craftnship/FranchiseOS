import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { MemoryFileStorage } from "../../functions/common/files";
import { newStore } from "./helpers";
import { franchiseTypeOf } from "../../functions/common/franchiseType";

const router = buildRouter();
const NOW = new Date("2026-10-09T06:00:00Z");
const pdf = { file_name: "fostac.pdf", content_type: "application/pdf", data_base64: Buffer.from("%PDF-1.4 cert").toString("base64") };

async function setup() {
  const store = newStore();
  const files = new MemoryFileStorage();
  const t = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
  const tid = t.tenantId;
  const fr = await store.insert("franchisees", { tenant_id: tid, franchise_code: "FR-000001", tenant_code_key: `${tid}:FR-000001`, display_name: "Pepper Potts", status: "ACTIVE" });
  const fr2 = await store.insert("franchisees", { tenant_id: tid, franchise_code: "FR-000002", tenant_code_key: `${tid}:FR-000002`, display_name: "Happy Hogan", status: "ACTIVE" });
  const user = (role: string, ext: string, franchiseeId?: string) => store.insert("users", { tenant_id: tid, email: `${ext}@x.test`, status: "ACTIVE", role_id: t.roleIds[role], external_user_id: ext, franchisee_id: franchiseeId ?? null });
  await user("PROJECT_MANAGER", "pm");
  await user("TRAINING_MANAGER", "trainer");
  await user("FINANCE_MANAGER", "fin");
  await user("FRANCHISEE", "pepper", String(fr.ROWID));
  await user("FRANCHISEE", "happy", String(fr2.ROWID));
  const project = await store.insert("franchise_projects", { tenant_id: tid, project_code: "PROJ-000001", tenant_code_key: `${tid}:PROJ-000001`, application_id: "1", franchisee_id: fr.ROWID, site_id: "1", status: "IN_PROGRESS", target_opening_date: "2026-11-30" });
  const task = (code: string, item: string) => store.insert("opening_checklists", { tenant_id: tid, project_id: project.ROWID, task_code: code, item, category: "RECRUITMENT", weight: 1, mandatory: true, status: "OPEN", due_date: "2026-11-20" });
  const tasks = { manager: await task("HIRE_MANAGER", "Hire store manager"), crew: await task("HIRE_CREW", "Hire crew"), train: await task("TRAIN_CREW", "Complete crew training") };
  const call = async (ext: string, method: string, path: string, body?: unknown) => {
    const res = await router.handle({ method, path: `/api/v1${path}`, body, identity: { externalUserId: ext, email: `${ext}@x.test` } }, { store, files, now: () => NOW });
    return res.body as { success: boolean; data?: any; error?: { code: string; message?: string; fields?: Record<string, string> } };
  };
  const base = `/projects/${project.ROWID}`;
  const status = async (id: unknown) => (await store.findOne("opening_checklists", { ROWID: String(id) }))?.status;
  const inbox = async (ext: string) => (await call(ext, "GET", "/notifications")).data.items.map((n: any) => n.title) as string[];
  return { store, call, base, tasks, status, inbox, t };
}

describe("hiring", () => {
  it("the franchisee builds the team against the plan, and the hiring tasks complete themselves", async () => {
    const s = await setup();
    // A smaller plan for a kiosk: 1 manager, 1 shift lead, 2 crew.
    expect((await s.call("pepper", "PATCH", `${s.base}/staffing/plan`, { CREW: 2 })).error?.code).toBe("ACCESS_DENIED");
    const plan = await s.call("pm", "PATCH", `${s.base}/staffing/plan`, { SHIFT_LEAD: 1, CREW: 2 });
    expect(plan.data.plan.map((r: any) => [r.role_code, r.required])).toEqual([["STORE_MANAGER", 1], ["SHIFT_LEAD", 1], ["CREW", 2]]);
    // Hiring tasks can't be ticked by hand before the team is there.
    const early = await s.call("pm", "PATCH", `${s.base}/checklist/${s.tasks.crew.ROWID}`, { done: true });
    expect(early.error?.fields).toEqual({ staffing: "0 of 1 shift lead hired, 0 of 2 crew members hired" });
    const hire = (ext: string, full_name: string, role_code: string) => s.call(ext, "POST", `${s.base}/staff`, { full_name, role_code, hired_on: "2026-10-01", phone: "+91 98400 00000" });
    const mgr = await hire("pepper", "Rhodey Rhodes", "STORE_MANAGER");
    expect(mgr.data).toMatchObject({ source: "PORTAL", status: "ACTIVE", tasks_completed: ["HIRE_MANAGER"] });
    expect(await s.status(s.tasks.manager.ROWID)).toBe("COMPLETED");
    expect((await hire("pepper", "Rhodey Rhodes", "CREW")).error?.fields).toEqual({ full_name: "already on the team" });
    expect((await s.call("pepper", "POST", `${s.base}/staff`, { full_name: "Future Hire", role_code: "CREW", hired_on: "2027-01-01" })).error?.fields).toEqual({ hired_on: "can't be in the future" });
    expect((await hire("happy", "Someone", "CREW")).error?.code).toBe("NOT_FOUND");
    expect((await hire("fin", "Someone", "CREW")).error?.code).toBe("ACCESS_DENIED");
    await hire("pepper", "Peter Parker", "SHIFT_LEAD");
    await hire("pepper", "Ned Leeds", "CREW");
    const last = await hire("pm", "MJ Watson", "CREW");
    expect(last.data).toMatchObject({ source: "STAFF", tasks_completed: ["HIRE_CREW"] });
    const team = (await s.call("pepper", "GET", `${s.base}/staffing`)).data;
    expect(team.plan.map((r: any) => r.hired)).toEqual([1, 1, 2]);
    expect(team.met).toEqual({ HIRE_MANAGER: true, HIRE_CREW: true, TRAIN_CREW: false });
    expect(team.staff.map((p: any) => p.full_name)).toEqual(["Rhodey Rhodes", "Peter Parker", "MJ Watson", "Ned Leeds"]);
    // Someone leaving shows as a gap again.
    const ned = team.staff.find((p: any) => p.full_name === "Ned Leeds");
    await s.call("pepper", "PATCH", `${s.base}/staff/${ned.ROWID}`, { action: "leave", left_on: "2026-10-08", reason: "Moved city" });
    const after = (await s.call("pm", "GET", `${s.base}/staffing`)).data;
    expect(after.met.HIRE_CREW).toBe(false);
    expect(after.staff.at(-1)).toMatchObject({ full_name: "Ned Leeds", status: "LEFT" });
    expect((await s.call("pepper", "PATCH", `${s.base}/staff/${ned.ROWID}`, { action: "leave", left_on: "2026-10-08" })).error?.code).toBe("INVALID_TRANSITION");
  });
});

describe("training", () => {
  it("the franchisee records modules, the trainer signs them off, and the training task completes", async () => {
    const s = await setup();
    await s.call("pm", "PATCH", `${s.base}/staffing/plan`, { SHIFT_LEAD: 0, CREW: 1 });
    const mgr = (await s.call("pepper", "POST", `${s.base}/staff`, { full_name: "Rhodey Rhodes", role_code: "STORE_MANAGER", hired_on: "2026-10-01" })).data;
    const crew = (await s.call("pepper", "POST", `${s.base}/staff`, { full_name: "Ned Leeds", role_code: "CREW", hired_on: "2026-10-02" })).data;
    const record = (ext: string, person: any, module_code: string, extra: object = {}) => s.call(ext, "POST", `${s.base}/staff/${person.ROWID}/training`, { module_code, completed_on: "2026-10-07", ...extra });
    // Crew don't take cash handling; food safety needs its certificate from the portal.
    expect((await record("pepper", crew, "CASH")).error?.fields).toEqual({ module_code: "not for this role" });
    expect((await record("pepper", crew, "FOOD_SAFETY")).error?.fields).toEqual({ certificate: "required" });
    const fs = await record("pepper", crew, "FOOD_SAFETY", { certificate: pdf, score: 88 });
    expect(fs.data).toMatchObject({ status: "SUBMITTED", source: "PORTAL", score: 88, tasks_completed: [] });
    expect(await s.inbox("trainer")).toContain("PROJ-000001 training to sign off: Ned Leeds, Food safety and hygiene");
    expect((await record("pepper", crew, "FOOD_SAFETY", { certificate: pdf })).error?.code).toBe("INVALID_TRANSITION");
    // Only the franchise team decides; sending back needs a note and the franchisee hears about it.
    expect((await s.call("pepper", "POST", `${s.base}/training/${fs.data.ROWID}/decision`, { decision: "SIGNED_OFF" })).error?.code).toBe("ACCESS_DENIED");
    expect((await s.call("trainer", "POST", `${s.base}/training/${fs.data.ROWID}/decision`, { decision: "RETURNED" })).error?.fields).toEqual({ note: "required" });
    await s.call("trainer", "POST", `${s.base}/training/${fs.data.ROWID}/decision`, { decision: "RETURNED", note: "The certificate is for a different person." });
    expect(await s.inbox("pepper")).toContain("Ned Leeds's food safety and hygiene training was sent back");
    const again = await record("pepper", crew, "FOOD_SAFETY", { certificate: pdf });
    expect(again.data).toMatchObject({ ROWID: fs.data.ROWID, status: "SUBMITTED", review_note: null });
    await s.call("trainer", "POST", `${s.base}/training/${fs.data.ROWID}/decision`, { decision: "SIGNED_OFF" });
    // The trainer's own records are signed off at once.
    for (const m of ["SERVICE", "PRODUCT"]) expect((await record("trainer", crew, m)).data.status).toBe("SIGNED_OFF");
    let team = (await s.call("pm", "GET", `${s.base}/staffing`)).data;
    expect(team.staff.find((p: any) => p.ROWID === crew.ROWID)).toMatchObject({ trained: true, missing: [] });
    expect(team.staff.find((p: any) => p.ROWID === mgr.ROWID).missing).toEqual(["FOOD_SAFETY", "SERVICE", "PRODUCT", "POS", "CASH", "STORE_OPS"]);
    expect((await s.call("pm", "PATCH", `${s.base}/checklist/${s.tasks.train.ROWID}`, { done: true })).error?.fields).toEqual({ staffing: "0 of 1 store manager trained" });
    const mods = ["FOOD_SAFETY", "SERVICE", "PRODUCT", "POS", "CASH", "STORE_OPS"];
    let lastRes: any;
    for (const m of mods) lastRes = await record("trainer", mgr, m);
    expect(lastRes.data.tasks_completed).toEqual(["TRAIN_CREW"]);
    expect(await s.status(s.tasks.train.ROWID)).toBe("COMPLETED");
    team = (await s.call("pepper", "GET", `${s.base}/staffing`)).data;
    expect(team.plan.map((r: any) => r.trained)).toEqual([1, 0, 1]);
    expect(team.to_sign_off).toBe(0);
    expect((await s.call("pepper", "GET", `${s.base}/training/${fs.data.ROWID}/certificate`)).data.url).toBeTruthy();
    expect((await s.call("happy", "GET", `${s.base}/staffing`)).error?.code).toBe("NOT_FOUND");
  });
});

describe("store setup", () => {
  it("uses the tenant's own roles, training and default format", async () => {
    const s = await setup();
    await s.store.insert("users", { tenant_id: s.t.tenantId, email: "admin@x.test", status: "ACTIVE", role_id: s.t.roleIds.SUPER_ADMIN, external_user_id: "admin" });
    const ev = {
      default_franchise_type: "EV_EXPERIENCE_CENTRE",
      staff_roles: [{ code: "CENTRE_MANAGER", name: "Centre manager", plural: "Centre managers", default_count: 1 }, { code: "TECHNICIAN", name: "EV technician", plural: "EV technicians", default_count: 2 }],
      training_modules: [{ code: "HV_SAFETY", name: "High-voltage safety", roles: ["CENTRE_MANAGER", "TECHNICIAN"], certificate: true }, { code: "TEST_RIDE", name: "Test rides", roles: ["CENTRE_MANAGER"] }],
    };
    expect((await s.call("pm", "PUT", "/settings/store-setup", ev)).error?.code).toBe("ACCESS_DENIED");
    expect((await s.call("admin", "PUT", "/settings/store-setup", { ...ev, training_modules: [{ code: "X_RAY", name: "X", roles: ["CREW"] }] })).error?.fields).toEqual({ training_modules: "unknown role" });
    expect((await s.call("admin", "PUT", "/settings/store-setup", ev)).data).toMatchObject({ default_franchise_type: "EV_EXPERIENCE_CENTRE", staff_roles: ev.staff_roles });
    const team = (await s.call("pepper", "GET", `${s.base}/staffing`)).data;
    expect(team.plan.map((r: any) => [r.role_code, r.required])).toEqual([["CENTRE_MANAGER", 1], ["TECHNICIAN", 2]]);
    expect((await s.call("pepper", "POST", `${s.base}/staff`, { full_name: "Old Crew", role_code: "CREW", hired_on: "2026-10-01" })).error?.fields).toEqual({ role_code: "unknown role" });
    const mgr = await s.call("pepper", "POST", `${s.base}/staff`, { full_name: "Tony Stark", role_code: "CENTRE_MANAGER", hired_on: "2026-10-01" });
    expect(mgr.data.tasks_completed).toEqual(["HIRE_MANAGER"]);
    const hv = await s.call("pepper", "POST", `${s.base}/staff/${mgr.data.ROWID}/training`, { module_code: "HV_SAFETY", completed_on: "2026-10-05" });
    expect(hv.error?.fields).toEqual({ certificate: "required" });
    expect((await s.call("pm", "PATCH", `${s.base}/staffing/plan`, { TECHNICIAN: 3 })).data.plan.map((r: any) => r.required)).toEqual([1, 3]);
    expect((await s.call("pm", "PATCH", `${s.base}/staffing/plan`, { CREW: 3 })).error?.fields).toEqual({ CREW: "unknown role" });
    // A role with people on it can't be dropped.
    expect((await s.call("admin", "PUT", "/settings/store-setup", { ...ev, staff_roles: ev.staff_roles.slice(1), training_modules: [ev.training_modules[0]].map((m) => ({ ...m, roles: ["TECHNICIAN"] })) })).error?.fields).toEqual({ staff_roles: "role in use" });
    // Franchisees without a format of their own get the default, so they find its templates.
    expect(await franchiseTypeOf(s.store, s.t.tenantId, { franchise_type: null })).toBe("EV_EXPERIENCE_CENTRE");
    expect(await franchiseTypeOf(s.store, s.t.tenantId, { franchise_type: "QSR" })).toBe("QSR");
  });
});

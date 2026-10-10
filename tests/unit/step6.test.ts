import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { nextAction } from "../../functions/api/routes/portal";
import { buildSelect } from "../../functions/common/catalystStore";
import { ZohoProjectsClient } from "../../functions/integrations/clients";
import { refreshReadiness, riskLevel, runProjectRiskJob, setChecklistBlocked } from "../../functions/workflows/readiness";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { ctx, newStore } from "./helpers";

type Body = { success: boolean; data?: any; error?: { code: string; fields?: Record<string, string> } };
const router = buildRouter();
const NOW = new Date("2026-10-09T06:00:00Z");
const TODAY = "2026-10-09";

async function setup() {
  const store = newStore();
  const t = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
  const tid = t.tenantId;
  const fr = await store.insert("franchisees", { tenant_id: tid, franchise_code: "FR-000001", tenant_code_key: `${tid}:FR-000001`, display_name: "Pepper Potts", status: "ACTIVE", franchise_type: "QSR" });
  const fr2 = await store.insert("franchisees", { tenant_id: tid, franchise_code: "FR-000002", tenant_code_key: `${tid}:FR-000002`, display_name: "Happy Hogan", status: "PROSPECT", franchise_type: "QSR" });
  const user = (role: string, ext: string, franchiseeId?: string) => store.insert("users", { tenant_id: tid, email: `${ext}@x.test`, status: "ACTIVE", role_id: t.roleIds[role], external_user_id: ext, franchisee_id: franchiseeId ?? null });
  await user("PROJECT_MANAGER", "pm");
  await user("FRANCHISE_DIRECTOR", "dir");
  await user("FRANCHISEE", "pepper", String(fr.ROWID));
  await user("FRANCHISEE", "happy", String(fr2.ROWID));

  const app = (code: string, status: string, franchisee: typeof fr, extra = {}) => store.insert("franchise_applications", { tenant_id: tid, application_code: code, tenant_code_key: `${tid}:${code}`, franchisee_id: franchisee.ROWID, status, preferred_city: "Chennai", ...extra });
  const a1 = await app("APP-000001", "ONBOARDING", fr, { investment_capacity: 4_000_000 });
  await app("APP-000002", "UNDER_REVIEW", fr2, { investment_capacity: 3_000_000, preferred_city: "Mumbai" });
  await app("APP-000003", "DRAFT", fr2, { investment_capacity: 1_000_000 });
  await app("APP-000004", "REJECTED", fr2);

  const project = await store.insert("franchise_projects", { tenant_id: tid, project_code: "PROJ-000001", tenant_code_key: `${tid}:PROJ-000001`, application_id: a1.ROWID, franchisee_id: fr.ROWID, site_id: "1", status: "IN_PROGRESS", target_opening_date: "2027-02-06", zoho_project_id: "ZP1" });
  await store.insert("franchise_projects", { tenant_id: tid, project_code: "PROJ-000002", tenant_code_key: `${tid}:PROJ-000002`, application_id: "x", franchisee_id: fr2.ROWID, site_id: "2", status: "PLANNING", target_opening_date: "2026-09-30" });
  const items = [
    { task_code: "LEASE", category: "CONSTRUCTION", status: "COMPLETED", due_date: "2026-10-01", external_task_id: "T1" },
    { task_code: "FITOUT", category: "CONSTRUCTION", status: "OPEN", due_date: "2026-12-01", external_task_id: "T2" },
    { task_code: "HIRE", category: "RECRUITMENT", status: "OPEN", due_date: "2026-11-01", external_task_id: "T3" },
  ];
  const rows = [];
  for (const i of items) rows.push(await store.insert("opening_checklists", { tenant_id: tid, project_id: project.ROWID, item: i.task_code, weight: 1, mandatory: true, ...i }));
  await store.insert("territories", { tenant_id: tid, territory_code: "TER-000001", tenant_code_key: `${tid}:TER-000001`, name: "Chennai Central", city: "Chennai", status: "AVAILABLE", opportunity_score: 80, latitude: "null" });

  const call = async (ext: string, method: string, path: string, body?: unknown, query?: Record<string, string>) => {
    const res = await router.handle({ method, path: `/api/v1${path}`, body, query, identity: { externalUserId: ext, email: `${ext}@x.test` } }, { store, now: () => NOW });
    return { status: res.status, ...(res.body as Body) };
  };
  return { store, tid, fr, fr2, project, rows, call };
}

describe("readiness and risk (FOS-058, D-7)", () => {
  it("stores readiness with a snapshot, and a blocker moves the project to AT_RISK and back", async () => {
    const s = await setup();
    const c = { ...ctx(["SYSTEM"], s.tid) };
    const first = await refreshReadiness(s.store, c, String(s.project.ROWID), { today: TODAY, now: NOW });
    expect(first).toMatchObject({ score: 28.57, rag: "RED", risk_level: "LOW", status: "IN_PROGRESS", blockers: [] });

    const blocked = await s.call("pm", "PATCH", `/projects/${s.project.ROWID}/checklist/${s.rows[2].ROWID}`, { blocked: true, reason: "No candidates" });
    expect(blocked.data.readiness).toMatchObject({ status: "AT_RISK", blockers: [String(s.rows[2].ROWID)] });
    const cleared = await s.call("pm", "PATCH", `/projects/${s.project.ROWID}/checklist/${s.rows[2].ROWID}`, { blocked: false });
    expect(cleared.data.readiness.status).toBe("IN_PROGRESS");

    expect(await s.store.findMany("readiness_snapshots", { project_id: String(s.project.ROWID) })).toHaveLength(3);
    expect((await s.store.findOne("franchise_projects", { ROWID: String(s.project.ROWID) }))).toMatchObject({ readiness_rag: "RED", risk_level: "LOW" });
  });

  it("judges risk on pace: blockers or overdue items, and low readiness only close to opening", () => {
    const none = { blockers: [], overdue: [] };
    expect(riskLevel({ rag: "RED", ...none }, 120)).toBe("LOW");
    expect(riskLevel({ rag: "RED", ...none }, null)).toBe("LOW");
    expect(riskLevel({ rag: "GREEN", blockers: [], overdue: ["1"] }, 120)).toBe("MEDIUM");
    expect(riskLevel({ rag: "GREEN", blockers: ["1"], overdue: ["1"] }, 120)).toBe("HIGH");
    expect(riskLevel({ rag: "AMBER", ...none }, 25)).toBe("MEDIUM");
    expect(riskLevel({ rag: "RED", ...none }, 10)).toBe("HIGH");
    expect(riskLevel({ rag: "GREEN", ...none }, 5)).toBe("LOW");
  });

  it("lists only the project actions the caller may take, and /me says what they may do", async () => {
    const s = await setup();
    await s.store.update("franchise_projects", String(s.project.ROWID), { status: "PLANNING" });
    expect((await s.call("dir", "GET", `/projects/${s.project.ROWID}`)).data.allowed_transitions).toEqual([]);
    expect((await s.call("pm", "GET", `/projects/${s.project.ROWID}`)).data.allowed_transitions).toEqual(["start"]);
    const me = (await s.call("dir", "GET", "/me")).data;
    expect(me.permissions).toContain("dashboard.view");
    expect(me.permissions).not.toContain("project.write");
  });

  it("only project.write roles can block items; anyone in the tenant can read readiness", async () => {
    const s = await setup();
    expect((await s.call("dir", "PATCH", `/projects/${s.project.ROWID}/checklist/${s.rows[1].ROWID}`, { blocked: true })).error?.code).toBe("ACCESS_DENIED");
    const r = await s.call("dir", "GET", `/projects/${s.project.ROWID}/readiness`);
    expect(r.data).toMatchObject({ by_category: { CONSTRUCTION: 50, RECRUITMENT: 0 } });
  });

  it("the daily risk job syncs Zoho tasks and refreshes every active project; one failure does not stop it", async () => {
    const s = await setup();
    const projects: ZohoProjectsClient = {
      createProject: async () => ({ id: "x" }), getProject: async (id) => ({ id }), createTaskList: async () => ({ id: "x" }),
      createTask: async () => ({ id: "x" }), updateTask: async () => {}, addDependency: async () => {},
      listTasks: async () => [{ id: "T1", status: "Closed", closed: true }, { id: "T2", status: "Closed", closed: true }, { id: "T3", status: "Closed", closed: true }],
      setTaskClosed: async () => {}, rescheduleTask: async () => {},
    };
    const res = await runProjectRiskJob(s.store, async () => projects, { today: TODAY, now: NOW, requestId: "REQ-job" });
    expect(res).toEqual({ projects: 2, synced: 1, at_risk: 1, failed: 0 });
    expect(await s.store.findOne("franchise_projects", { ROWID: String(s.project.ROWID) })).toMatchObject({ readiness_score: 100, readiness_rag: "GREEN", risk_level: "LOW" });
  });

  it("opening a store needs project.open and records the opening date", async () => {
    const s = await setup();
    await s.store.update("franchise_projects", String(s.project.ROWID), { status: "READY_FOR_OPENING" });
    // The licence register blocks the opening until every mandatory licence is issued and valid.
    const blocked = await s.call("pm", "POST", `/projects/${s.project.ROWID}/transition`, { transition: "open", actual_opening_date: "2026-10-09" });
    expect(blocked.error?.code).toBe("LICENCES_MISSING");
    expect(Object.keys(blocked.error?.fields ?? {}).sort()).toEqual(["FIRE_NOC", "FSSAI", "GST", "SHOP_EST", "TRADE"]);
    expect((await s.store.findOne("franchise_projects", { ROWID: String(s.project.ROWID) }))!.actual_opening_date ?? null).toBeNull();
    const licences = (await s.call("pm", "GET", `/projects/${s.project.ROWID}`)).data.licences;
    expect(licences).toHaveLength(6);
    for (const l of licences.filter((l: any) => l.mandatory)) {
      const expires = l.licence_code === "FIRE_NOC" ? "2026-10-09" : l.licence_code === "GST" ? null : "2027-10-08";
      expect((await s.call("pm", "PATCH", `/projects/${s.project.ROWID}/licences/${l.ROWID}`, { status: "ISSUED", licence_number: `N-${l.licence_code}`, issued_on: "2026-09-01", expires_on: expires })).data.status).toBe("ISSUED");
    }
    // A fire NOC that runs out on the opening day doesn't count.
    expect((await s.call("pm", "POST", `/projects/${s.project.ROWID}/transition`, { transition: "open", actual_opening_date: "2026-10-09" })).error?.fields).toEqual({ FIRE_NOC: "expires before opening" });
    const fire = licences.find((l: any) => l.licence_code === "FIRE_NOC");
    expect((await s.call("pm", "PATCH", `/projects/${s.project.ROWID}/licences/${fire.ROWID}`, { expires_on: "2026-08-01" })).error?.fields).toHaveProperty("expires_on");
    await s.call("pm", "PATCH", `/projects/${s.project.ROWID}/licences/${fire.ROWID}`, { expires_on: "2027-09-30" });
    const res = await s.call("pm", "POST", `/projects/${s.project.ROWID}/transition`, { transition: "open", actual_opening_date: "2026-10-09" });
    expect(res.data).toMatchObject({ status: "OPENED", actual_opening_date: "2026-10-09" });
    expect((await s.call("pm", "POST", `/projects/${s.project.ROWID}/transition`, { transition: "start", actual_opening_date: "2026-10-09" })).status).toBe(422);
  });
});

describe("dashboards (FOS-059..063)", () => {
  it("network KPIs carry drill-downs that return the same records", async () => {
    const s = await setup();
    const res = await s.call("dir", "GET", "/dashboard/network");
    expect(res.data).toMatchObject({
      active_franchisees: { value: 1, drill: { path: "/franchisees", query: { status: "ACTIVE" } } },
      applications: { value: 2 },
      pipeline_value: { value: 4_000_000 },
      openings: { value: 2 },
      delayed_openings: { value: 1, drill: { path: "/projects", query: { delayed: "true" } } },
    });
    const drill = await s.call("dir", "GET", res.data.applications.drill.path, undefined, res.data.applications.drill.query);
    expect(drill.data.map((a: any) => a.application_code).sort()).toEqual(["APP-000002", "APP-000003"]);
    const delayed = await s.call("dir", "GET", "/projects", undefined, { delayed: "true" });
    expect(delayed.data.map((p: any) => p.project_code)).toEqual(["PROJ-000002"]);
  });

  it("pipeline funnel, openings by month, risk and territories", async () => {
    const s = await setup();
    const pipeline = (await s.call("dir", "GET", "/dashboard/pipeline")).data;
    expect(pipeline.funnel.find((f: any) => f.stage === "DRAFT").count).toBe(3);
    expect(pipeline.funnel.find((f: any) => f.stage === "ONBOARDING")).toMatchObject({ count: 1, current: 1 });
    const openings = (await s.call("dir", "GET", "/dashboard/openings")).data;
    expect(openings.by_month.find((m: any) => m.month === "2027-02")).toMatchObject({ planned: 1 });
    expect(openings.delayed.value).toBe(1);
    // RED but on pace is not at risk; a blocked mandatory item is.
    await refreshReadiness(s.store, ctx(["SYSTEM"], s.tid), String(s.project.ROWID), { today: TODAY, now: NOW });
    expect((await s.call("dir", "GET", "/dashboard/risk")).data.at_risk.items).toEqual([]);
    await setChecklistBlocked(s.store, ctx(["SYSTEM"], s.tid), String(s.project.ROWID), String(s.rows[2].ROWID), true);
    await refreshReadiness(s.store, ctx(["SYSTEM"], s.tid), String(s.project.ROWID), { today: TODAY, now: NOW });
    const risk = (await s.call("dir", "GET", "/dashboard/risk")).data;
    expect(risk.at_risk.items.map((p: any) => p.project_code)).toEqual(["PROJ-000001"]);
    const territories = (await s.call("dir", "GET", "/dashboard/territories")).data;
    expect(territories.territories[0]).toMatchObject({ territory_code: "TER-000001", opportunity_score: 80, latitude: null });
  });

  it("needs dashboard.view", async () => {
    const s = await setup();
    expect((await s.call("pepper", "GET", "/dashboard/network")).error?.code).toBe("ACCESS_DENIED");
  });
});

describe("global search and portal (FOS-048)", () => {
  it("finds records by code, name or city, and a portal user sees only their own", async () => {
    const s = await setup();
    const staff = await s.call("dir", "GET", "/search", undefined, { q: "chennai" });
    expect(staff.data.map((r: any) => r.type).sort()).toEqual(["application", "application", "application", "territory"]);
    const mine = await s.call("pepper", "GET", "/search", undefined, { q: "APP-" });
    expect(mine.data.map((r: any) => r.title)).toEqual(["APP-000001 · Chennai"]);
  });

  it("portal home shows the franchisee's own project, readiness and next action", async () => {
    const s = await setup();
    const home = (await s.call("pepper", "GET", "/portal/home")).data;
    expect(home.application.application_code).toBe("APP-000001");
    expect(home.project).toMatchObject({ project_code: "PROJ-000001", readiness: { rag: "RED" } });
    expect(home.upcoming_tasks).toHaveLength(2);
    expect(home.next_action).toMatchObject({ owner: "you", path: "/portal/tasks" });
    const other = (await s.call("happy", "GET", "/portal/home")).data;
    expect(other.project).toBeNull();
    expect((await s.call("happy", "GET", `/projects/${s.project.ROWID}`)).status).toBe(404);
    expect((await s.call("dir", "GET", "/portal/home")).error?.code).toBe("ACCESS_DENIED");
  });

  it("next action follows the application state", () => {
    expect(nextAction(null).title).toMatch(/Start/);
    expect(nextAction({ status: "AGREEMENT_PENDING" })).toMatchObject({ owner: "you", path: "/portal/agreement" });
    expect(nextAction({ status: "UNDER_REVIEW" }).owner).toBe("us");
    expect(nextAction({ status: "ONBOARDING" }, { blockers: 2 }).title).toBe("Clear 2 blocked or overdue opening tasks");
  });

  it("builds a ZCQL LIKE for substring search", () => {
    expect(buildSelect("sites", { tenant_id: "T1" }, { contains: { columns: ["city", "site_code"], term: "che*n'" }, limit: 5 }))
      .toBe("SELECT * FROM sites WHERE tenant_id = 'T1' AND (city LIKE '*chen\\'*' OR site_code LIKE '*chen\\'*') LIMIT 5");
  });
});

import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { forecastOpening, PlanTask } from "../../functions/scoring/forecast";
import { newStore } from "./helpers";

const router = buildRouter();
const t = (code: string, due: string, duration: number, depends_on: string[] = [], extra: Partial<PlanTask> = {}): PlanTask =>
  ({ id: code, code, name: code, mandatory: true, done: false, due, duration, depends_on, completed_on: null, ...extra });
const PLAN = [
  t("LEASE", "2026-10-15", 14), t("PERMITS", "2026-10-31", 16, ["LEASE"]), t("FITOUT", "2026-12-15", 45, ["PERMITS"]),
  t("HIRE", "2026-11-20", 50), t("TRAIN", "2026-12-10", 20, ["HIRE"]), t("LAUNCH", "2026-12-20", 5, [], { mandatory: false }),
];

describe("opening forecast", () => {
  it("on plan, the forecast is the target and the critical path is the longest chain", () => {
    const f = forecastOpening(PLAN, "2026-10-09", "2026-12-31");
    expect(f).toMatchObject({ planned_finish: "2026-12-15", forecast_finish: "2026-12-15", slip_days: 0, float_days: 15, forecast_opening: "2026-12-31", critical_path: ["LEASE", "PERMITS", "FITOUT"] });
    expect(f.tasks.find((x) => x.code === "TRAIN")).toMatchObject({ slack: 20, critical: false });
  });

  it("an overdue task pushes everything that waits for it; the float absorbs it until it runs out", () => {
    const f = forecastOpening(PLAN, "2026-10-25", "2026-12-31");
    expect(f.tasks.find((x) => x.code === "PERMITS")).toMatchObject({ finish: "2026-11-10", slip: 10, waiting_on: ["LEASE"] });
    expect(f).toMatchObject({ forecast_finish: "2026-12-25", slip_days: 0, float_days: 5, forecast_opening: "2026-12-31" });
    const late = forecastOpening(PLAN, "2026-11-10", "2026-12-31");
    expect(late.tasks.find((x) => x.code === "FITOUT")).toMatchObject({ finish: "2027-01-10", slack: -11, critical: true });
    expect(late.tasks.find((x) => x.code === "TRAIN")!.critical).toBe(false);
    expect(late).toMatchObject({ slip_days: 11, float_days: 0, forecast_opening: "2027-01-11", critical_path: ["LEASE", "PERMITS", "FITOUT"] });
    // Done early: the rest can't move earlier than planned.
    const done = forecastOpening(PLAN.map((x) => (x.code === "LEASE" ? { ...x, done: true, completed_on: "2026-10-05" } : x)), "2026-10-09", "2026-12-31");
    expect(done.slip_days).toBe(0);
  });

  it("ignores dependencies that loop", () => {
    const f = forecastOpening([t("A", "2026-10-15", 5, ["B"]), t("B", "2026-10-20", 5, ["A"])], "2026-10-09", "2026-11-01");
    expect(f.cycle.sort()).toEqual(["A", "B"]);
    expect(f.slip_days).toBe(0);
  });
});

describe("forecast on a project", () => {
  async function setup() {
    const store = newStore();
    const a = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
    const tid = a.tenantId;
    const fr = await store.insert("franchisees", { tenant_id: tid, franchise_code: "FR-000001", tenant_code_key: `${tid}:FR-000001`, display_name: "Pepper", status: "ACTIVE" });
    for (const [role, ext, f] of [["PROJECT_MANAGER", "pm"], ["PROJECT_MANAGER", "pm2"], ["FRANCHISE_MANAGER", "fm"], ["FRANCHISEE", "pepper", String(fr.ROWID)]]) {
      await store.insert("users", { tenant_id: tid, email: `${ext}@x.test`, status: "ACTIVE", role_id: a.roleIds[role!], external_user_id: ext, franchisee_id: f ?? null });
    }
    const project = await store.insert("franchise_projects", { tenant_id: tid, project_code: "PROJ-000001", tenant_code_key: `${tid}:PROJ-000001`, franchisee_id: fr.ROWID, status: "IN_PROGRESS", target_opening_date: "2026-12-31" });
    const rows: Record<string, any> = {};
    for (const p of PLAN) {
      rows[p.code] = await store.insert("opening_checklists", { tenant_id: tid, project_id: project.ROWID, task_code: p.code, item: p.code, category: "CONSTRUCTION", weight: 1, mandatory: p.mandatory, status: "OPEN", due_date: p.due, duration_days: p.duration, depends_on_json: JSON.stringify(p.depends_on) });
    }
    const call = async (ext: string, method: string, path: string, body?: unknown, now = "2026-11-10T06:00:00Z") => {
      const res = await router.handle({ method, path: `/api/v1${path}`, body, identity: { externalUserId: ext, email: `${ext}@x.test` } }, { store, now: () => new Date(now) });
      return res.body as { success: boolean; data?: any; error?: { code: string; fields?: Record<string, string> } };
    };
    // Forecast notices only; the overdue task also sets off the at-risk notice.
    const inbox = async (ext: string) => ((await call(ext, "GET", "/notifications")).data.items.map((n: any) => n.title) as string[]).filter((x) => x.includes("forecast"));
    return { store, project, rows, call, inbox, base: `/projects/${project.ROWID}` };
  }

  it("stores the forecast, tells the team once, and alerts again only after a further week's slip", async () => {
    const s = await setup();
    const r = await s.call("pm", "POST", `${s.base}/sync`);
    expect(r.data.readiness).toMatchObject({ forecast: { slip_days: 11, forecast_opening: "2027-01-11" }, risk_level: "HIGH" }); // the overdue lease is a blocker
    expect(await s.store.findOne("franchise_projects", { ROWID: String(s.project.ROWID) })).toMatchObject({ forecast_opening_date: "2027-01-11", forecast_slip_days: 11 });
    const title = "PROJ-000001 is now forecast to open 11 Jan 2027";
    expect(await s.inbox("pm2")).toEqual([title]);
    expect(await s.inbox("pepper")).toEqual([title]);
    await s.call("pm", "POST", `${s.base}/sync`, undefined, "2026-11-13T06:00:00Z");
    expect(await s.inbox("pm2")).toHaveLength(1);
    await s.call("pm", "POST", `${s.base}/sync`, undefined, "2026-11-18T06:00:00Z");
    expect(await s.inbox("pm2")).toEqual(["PROJ-000001 is now forecast to open 19 Jan 2027", title]);
  });

  it("moving the target to the forecast puts the project back on plan", async () => {
    const s = await setup();
    await s.call("pm", "POST", `${s.base}/sync`);
    expect((await s.call("pm", "POST", `${s.base}/target`, { target_opening_date: "2027-01-11" })).error?.code).toBe("VALIDATION_FAILED");
    const moved = await s.call("pm", "POST", `${s.base}/target`, { target_opening_date: "2027-01-11", reason: "Lease signed late" });
    expect(moved.data.forecast).toMatchObject({ forecast_opening: "2027-01-11", slip_days: 0 });
    expect(await s.store.findOne("franchise_projects", { ROWID: String(s.project.ROWID) })).toMatchObject({ target_opening_date: "2027-01-11", forecast_slip_days: 0, forecast_alerted_on: null });
  });

  it("staff change what a task waits for, but not into a loop", async () => {
    const s = await setup();
    const lease = s.rows.LEASE.ROWID;
    expect((await s.call("pm", "PATCH", `${s.base}/checklist/${lease}`, { depends_on: ["FITOUT"] })).error?.fields).toEqual({ depends_on: "loop" });
    expect((await s.call("pm", "PATCH", `${s.base}/checklist/${lease}`, { depends_on: ["LEASE"] })).error?.fields).toEqual({ depends_on: "LEASE" });
    const ok = await s.call("pm", "PATCH", `${s.base}/checklist/${s.rows.TRAIN.ROWID}`, { depends_on: ["HIRE", "FITOUT"], duration_days: 10 });
    expect(ok.data.readiness.forecast.tasks.find((x: any) => x.code === "TRAIN")).toMatchObject({ waiting_on: ["HIRE", "FITOUT"], finish: "2027-01-20" });
  });
});

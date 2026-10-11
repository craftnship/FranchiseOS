import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { weekTarget } from "../../functions/workflows/launch";
import { runReminderJob } from "../../functions/workflows/notifications";
import { newStore } from "./helpers";

const router = buildRouter();
const NOW = "2026-10-11T06:00:00Z";

async function setup(project: Record<string, unknown> = {}) {
  const store = newStore();
  const t = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
  const tid = t.tenantId;
  const fr = await store.insert("franchisees", { tenant_id: tid, franchise_code: "FR-000001", tenant_code_key: `${tid}:FR-000001`, display_name: "Pepper Potts", status: "ACTIVE" });
  const user = (role: string, ext: string, franchiseeId?: string) => store.insert("users", { tenant_id: tid, email: `${ext}@x.test`, status: "ACTIVE", role_id: t.roleIds[role], external_user_id: ext, franchisee_id: franchiseeId ?? null });
  await user("SUPER_ADMIN", "tony");
  await user("FRANCHISE_MANAGER", "fm");
  await user("LEGAL_MANAGER", "legal");
  await user("PROJECT_MANAGER", "pm");
  await user("FRANCHISEE", "pepper", String(fr.ROWID));
  const app = await store.insert("franchise_applications", { tenant_id: tid, application_code: "APP-000001", tenant_code_key: `${tid}:APP-000001`, franchisee_id: fr.ROWID, status: "ACTIVE" });
  await store.insert("feasibility_models", { tenant_id: tid, application_id: app.ROWID, site_id: "1", monthly_revenue: 520000, status: "APPROVED" });
  const p = await store.insert("franchise_projects", { tenant_id: tid, project_code: "PROJ-000001", tenant_code_key: `${tid}:PROJ-000001`, application_id: app.ROWID, franchisee_id: fr.ROWID, site_id: "1", status: "READY_FOR_OPENING", target_opening_date: "2026-11-01", ...project });
  const agreement = await store.insert("agreements", { tenant_id: tid, agreement_code: "AGR-000001", tenant_code_key: `${tid}:AGR-000001`, application_id: app.ROWID, franchisee_id: fr.ROWID, status: "SIGNED", effective_date: "2022-03-01", expiry_date: "2027-03-01" });
  const call = async (ext: string, method: string, path: string, body?: unknown, now = NOW) => {
    const res = await router.handle({ method, path: `/api/v1${path}`, body, identity: { externalUserId: ext, email: `${ext}@x.test` } }, { store, now: () => new Date(now) });
    return res.body as { success: boolean; data?: any; error?: { code: string; message?: string } };
  };
  const inbox = async (ext: string) => (await call(ext, "GET", "/notifications")).data.items.map((n: any) => n.title) as string[];
  return { store, tid, project: p, agreement, call, inbox, base: `/projects/${p.ROWID}` };
}

describe("opening day", () => {
  it("turns the monthly feasibility revenue into ramped weekly targets", () => {
    const s = { ramp: [0.5, 1] };
    expect(weekTarget(520000, 1, s)).toBe(60000);
    expect(weekTarget(520000, 2, s)).toBe(120000);
    expect(weekTarget(520000, 9, s)).toBe(120000);
    expect(weekTarget(null, 1, s)).toBeNull();
  });

  it("plans the grand opening, moves open tasks with the date, and lets the franchisee tick off their own", async () => {
    const s = await setup();
    const planned = (await s.call("pm", "PATCH", `${s.base}/launch`, { grand_opening_date: "2026-11-01" })).data;
    expect(planned.tasks).toHaveLength(12);
    const event = planned.tasks.find((t: any) => t.code === "EVENT"), listings = planned.tasks.find((t: any) => t.code === "LISTINGS"), mkt = planned.tasks.find((t: any) => t.code === "MKT_PLAN");
    expect([event.due_date, listings.due_date, mkt.owner_side]).toEqual(["2026-11-01", "2026-10-11", "BRAND"]);
    expect(await s.inbox("pepper")).toEqual(["PROJ-000001: grand opening set for 1 Nov 2026"]);

    // The franchisee ticks off their own task, but not the brand's, and can't skip.
    expect((await s.call("pepper", "PATCH", `/launch-tasks/${listings.ROWID}`, { action: "done" })).data.status).toBe("DONE");
    expect((await s.call("pepper", "PATCH", `/launch-tasks/${mkt.ROWID}`, { action: "done" })).error?.code).toBe("ACCESS_DENIED");
    expect((await s.call("pm", "PATCH", `/launch-tasks/${mkt.ROWID}`, { action: "skip" })).error?.code).toBe("VALIDATION_FAILED");
    expect((await s.call("pm", "PATCH", `/launch-tasks/${mkt.ROWID}`, { action: "skip", note: "Brand-wide campaign covers it" })).data.status).toBe("SKIPPED");

    // A week later: done and skipped tasks stay put, open ones move.
    const moved = (await s.call("pm", "PATCH", `${s.base}/launch`, { grand_opening_date: "2026-11-08" })).data;
    const by = (code: string) => moved.tasks.find((t: any) => t.code === code);
    expect([by("EVENT").due_date, by("LISTINGS").due_date, by("MKT_PLAN").due_date]).toEqual(["2026-11-08", "2026-10-11", "2026-10-04"]);
    expect(moved.project.grand_opening_date).toBe("2026-11-08");

    // Overdue tasks: the franchisee's to them, the brand's to project managers.
    await s.call("pm", "PATCH", `/launch-tasks/${by("LISTINGS").ROWID}`, { action: "reopen" });
    await runReminderJob(s.store, { now: new Date("2026-10-13T03:00:00Z"), requestId: "T" });
    expect(await s.inbox("pepper")).toContain("PROJ-000001: launch task overdue");
    await runReminderJob(s.store, { now: new Date("2026-10-14T03:00:00Z"), requestId: "T" });
    expect((await s.inbox("pepper")).filter((t) => t.includes("launch task"))).toHaveLength(1);
  });

  it("watches weekly sales against plan and flags two weeks running under the behind mark", async () => {
    const s = await setup({ status: "OPENED", actual_opening_date: "2026-09-01", grand_opening_date: "2026-09-01" });
    const watch = (await s.call("pepper", "GET", `${s.base}/launch`)).data;
    expect(watch.weeks_finished).toBe(5);
    expect(watch.weeks[0]).toMatchObject({ week_start: "2026-09-01", week_end: "2026-09-07", target: 72000, finished: true });
    expect((await s.call("pepper", "PATCH", `${s.base}/launch/weeks/6`, { net_sales: 1 })).error?.code).toBe("VALIDATION_FAILED");

    await s.call("pepper", "PATCH", `${s.base}/launch/weeks/1`, { net_sales: 72000, transactions: 410 });
    await s.call("pepper", "PATCH", `${s.base}/launch/weeks/2`, { net_sales: 80000 });
    await s.call("pepper", "PATCH", `${s.base}/launch/weeks/3`, { net_sales: 50000 });
    expect(await s.inbox("fm")).toEqual([]);
    await s.call("pepper", "PATCH", `${s.base}/launch/weeks/4`, { net_sales: 40000 });
    const after = (await s.call("tony", "GET", `${s.base}/launch`)).data;
    expect(after.weeks.slice(0, 4).map((w: any) => [w.pct, w.rating])).toEqual([[100, "GREEN"], [95.2, "GREEN"], [52.1, "RED"], [39.2, "RED"]]);
    expect(after.behind).toBe(true);
    expect(await s.inbox("fm")).toEqual(["PROJ-000001 is behind its launch sales plan"]);

    // Week 5 has finished and isn't reported: the franchisee is chased for it, not the earlier weeks.
    await runReminderJob(s.store, { now: new Date(NOW), requestId: "T" });
    expect((await s.inbox("pepper")).filter((t) => t.startsWith("Report week"))).toEqual(["Report week 5 sales for PROJ-000001"]);

    const net = (await s.call("tony", "GET", "/launches")).data;
    expect(net.totals).toMatchObject({ watching: 1, behind: 1, weeks_missing: 1 });
    expect(net.stores[0]).toMatchObject({ project_code: "PROJ-000001", stage: "WATCH", week: 6, last_week: { week_no: 4, rating: "RED" } });
    expect((await s.call("tony", "GET", "/dashboard/network")).data.launches_behind.value).toBe(1);
    expect((await s.call("pepper", "GET", "/launches")).error?.code).toBe("ACCESS_DENIED");
  });

  it("reminds about renewals at each milestone and tracks the decision", async () => {
    const s = await setup({ status: "OPENED", actual_opening_date: "2022-04-01" });
    await runReminderJob(s.store, { now: new Date(NOW), requestId: "T" });
    await runReminderJob(s.store, { now: new Date("2026-10-12T03:00:00Z"), requestId: "T" });
    expect((await s.inbox("legal")).filter((t) => t.includes("AGR"))).toEqual(["AGR-000001 ends 1 Mar 2027"]);
    expect((await s.inbox("pepper")).filter((t) => t.includes("AGR"))).toEqual(["AGR-000001 ends 1 Mar 2027"]);
    // The 90-day mark sends another.
    await runReminderJob(s.store, { now: new Date("2026-12-02T03:00:00Z"), requestId: "T" });
    expect((await s.inbox("legal")).filter((t) => t.includes("AGR"))).toHaveLength(2);

    const list = (await s.call("fm", "GET", "/renewals")).data;
    expect(list.agreements[0]).toMatchObject({ agreement_code: "AGR-000001", days_left: 141, in_notice: true, project_code: "PROJ-000001" });
    expect((await s.call("fm", "GET", "/dashboard/network")).data.renewals_due.value).toBe(1);

    const a = `/agreements/${s.agreement.ROWID}/renewal`;
    expect((await s.call("pepper", "PATCH", a, { status: "RENEWING" })).error?.code).toBe("ACCESS_DENIED");
    expect((await s.call("fm", "PATCH", a, { status: "RENEWED" })).error?.code).toBe("VALIDATION_FAILED");
    expect((await s.call("fm", "PATCH", a, { status: "RENEWED", renewed_until: "2027-01-01" })).error?.code).toBe("VALIDATION_FAILED");
    expect((await s.call("fm", "PATCH", a, { status: "RENEWED", renewed_until: "2032-03-01", note: "Five more years" })).data).toMatchObject({ renewal_status: "RENEWED", renewed_until: "2032-03-01" });
    expect((await s.call("fm", "GET", "/dashboard/network")).data.renewals_due.value).toBe(0);
    // Renewed: no more reminders.
    await runReminderJob(s.store, { now: new Date("2027-01-31T03:00:00Z"), requestId: "T" });
    expect((await s.inbox("legal")).filter((t) => t.includes("AGR"))).toHaveLength(2);
  });
  it("leaves stores opened before the watch alone until a week is reported for them", async () => {
    const s = await setup({ status: "OPENED", actual_opening_date: "2026-09-20" });
    expect((await s.call("tony", "GET", `${s.base}/launch`)).data).toMatchObject({ watched: false, weeks: [] });
    expect((await s.call("tony", "GET", "/launches")).data.totals.watching).toBe(0);
    await runReminderJob(s.store, { now: new Date(NOW), requestId: "T" });
    expect((await s.inbox("pepper")).filter((t) => t.startsWith("Report week"))).toEqual([]);
    await s.call("pm", "PATCH", `${s.base}/launch/weeks/1`, { net_sales: 90000 });
    expect((await s.call("tony", "GET", `${s.base}/launch`)).data).toMatchObject({ watched: true, weeks_finished: 3 });
  });
});

import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { MemoryFileStorage } from "../../functions/common/files";
import { scoreOf } from "../../functions/workflows/audits";
import { runReminderJob } from "../../functions/workflows/notifications";
import { newStore } from "./helpers";

const router = buildRouter();
const jpg = { file_name: "fix.jpg", content_type: "image/jpeg", data_base64: Buffer.from("\xff\xd8\xff photo").toString("base64") };

async function setup() {
  const store = newStore();
  const files = new MemoryFileStorage();
  const t = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
  const tid = t.tenantId;
  const fr = await store.insert("franchisees", { tenant_id: tid, franchise_code: "FR-000001", tenant_code_key: `${tid}:FR-000001`, display_name: "Pepper Potts", status: "ACTIVE" });
  const fr2 = await store.insert("franchisees", { tenant_id: tid, franchise_code: "FR-000002", tenant_code_key: `${tid}:FR-000002`, display_name: "Happy Hogan", status: "ACTIVE" });
  const user = (role: string, ext: string, franchiseeId?: string) => store.insert("users", { tenant_id: tid, email: `${ext}@x.test`, status: "ACTIVE", role_id: t.roleIds[role], external_user_id: ext, franchisee_id: franchiseeId ?? null });
  const tony = await user("SUPER_ADMIN", "tony");
  await user("OPERATIONS_MANAGER", "ops");
  await user("FRANCHISEE", "pepper", String(fr.ROWID));
  await user("FRANCHISEE", "happy", String(fr2.ROWID));
  const project = await store.insert("franchise_projects", { tenant_id: tid, project_code: "PROJ-000001", tenant_code_key: `${tid}:PROJ-000001`, franchisee_id: fr.ROWID, site_id: "1", status: "OPENED", actual_opening_date: "2026-09-20" });
  const other = await store.insert("franchise_projects", { tenant_id: tid, project_code: "PROJ-000002", tenant_code_key: `${tid}:PROJ-000002`, franchisee_id: fr2.ROWID, site_id: "2", status: "OPENED", actual_opening_date: "2026-08-01" });
  const call = async (ext: string, method: string, path: string, body?: unknown, now = "2026-10-11T06:00:00Z") => {
    const res = await router.handle({ method, path: `/api/v1${path}`, body, identity: { externalUserId: ext, email: `${ext}@x.test` } }, { store, files, now: () => new Date(now) });
    return res.body as { success: boolean; data?: any; error?: { code: string; message?: string; fields?: Record<string, string> } };
  };
  const base = `/projects/${project.ROWID}`;
  const inbox = async (ext: string) => (await call(ext, "GET", "/notifications")).data.items.map((n: any) => n.title) as string[];
  return { store, tid, tony, project, other, call, base, inbox };
}

/** Books, starts and judges an audit: everything passes except the given fails. */
async function runAudit(s: Awaited<ReturnType<typeof setup>>, fails: Record<string, string>, now = "2026-10-11T06:00:00Z") {
  const audit = (await s.call("tony", "POST", `${s.base}/audits`, { audit_type: "ROUTINE", planned_for: "2026-10-11" }, now)).data;
  await s.call("tony", "PATCH", `/audits/${audit.ROWID}`, { action: "start" }, now);
  const detail = (await s.call("tony", "GET", `/audits/${audit.ROWID}`, undefined, now)).data;
  const items = detail.items.map((i: any) => (fails[i.code] ? { code: i.code, verdict: "FAIL", comments: fails[i.code] } : { code: i.code, verdict: "PASS" }));
  await s.call("tony", "PATCH", `/audits/${audit.ROWID}`, { action: "save", items }, now);
  return audit;
}

describe("store audits", () => {
  it("scores the weight passed over the weight judged; a critical fail is red", () => {
    const s = { pass_score: 85, amber_score: 70 };
    expect(scoreOf([{ verdict: "PASS", weight: 3, critical: false }, { verdict: "FAIL", weight: 1, critical: false }, { verdict: "NA", weight: 5, critical: true }], s)).toMatchObject({ score: 75, rating: "AMBER", critical_fails: 0 });
    expect(scoreOf([{ verdict: "PASS", weight: 9, critical: false }, { verdict: "FAIL", weight: 1, critical: "true" }], s)).toMatchObject({ score: 90, rating: "RED", critical_fails: 1 });
    expect(scoreOf([{ verdict: "PASS", weight: 1, critical: false }], s).rating).toBe("GREEN");
  });

  it("books, runs and completes an audit, raising an action for each fail and a follow-up when red", async () => {
    const s = await setup();
    expect((await s.call("ops", "POST", `${s.base}/audits`, { audit_type: "ROUTINE", planned_for: "2026-10-11" })).error?.code).toBe("ACCESS_DENIED");
    const audit = (await s.call("tony", "POST", `${s.base}/audits`, { audit_type: "ROUTINE", planned_for: "2026-10-11" })).data;
    expect(audit).toMatchObject({ audit_code: "AUD-000001", status: "SCHEDULED" });
    expect(await s.inbox("pepper")).toEqual(["PROJ-000001: routine audit booked for 11 Oct 2026"]);
    expect((await s.call("tony", "POST", `${s.base}/audits`, { audit_type: "SURPRISE", planned_for: "2026-10-12" })).error?.message).toBe("AUD-000001 is already booked for this store. Change its date instead.");

    const started = await s.call("tony", "PATCH", `/audits/${audit.ROWID}`, { action: "start" });
    expect(started.data.status).toBe("IN_PROGRESS");
    let d = (await s.call("tony", "GET", `/audits/${audit.ROWID}`)).data;
    expect(d.items).toHaveLength(18);
    expect((await s.call("tony", "PATCH", `/audits/${audit.ROWID}`, { action: "complete" })).error?.message).toBe("18 standards are not judged yet.");
    const all = d.items.map((i: any) => ({ code: i.code, verdict: "PASS" }));
    await s.call("tony", "PATCH", `/audits/${audit.ROWID}`, { action: "save", items: all });
    await s.call("tony", "PATCH", `/audits/${audit.ROWID}`, { action: "save", items: [{ code: "FS_TEMPS", verdict: "FAIL", photo: jpg }, { code: "CL_DINING", verdict: "FAIL", comments: "Washroom out of soap" }] });
    expect((await s.call("tony", "PATCH", `/audits/${audit.ROWID}`, { action: "complete" })).error?.fields).toEqual({ items: "FS_TEMPS" });
    await s.call("tony", "PATCH", `/audits/${audit.ROWID}`, { action: "save", items: [{ code: "FS_TEMPS", verdict: "FAIL", comments: "Walk-in chiller at 9°C" }] });
    d = (await s.call("tony", "GET", `/audits/${audit.ROWID}`)).data;
    expect(d.progress).toMatchObject({ score: 86.1, rating: "RED", critical_fails: 1, unanswered: 0 });

    const done = (await s.call("tony", "PATCH", `/audits/${audit.ROWID}`, { action: "complete", summary: "Good store; the chiller needs fixing today." })).data;
    expect(done.audit).toMatchObject({ status: "COMPLETED", score: 86.1, rating: "RED", critical_fails: 1 });
    expect(done.actions.map((a: any) => [a.item_code, a.severity, a.due_date])).toEqual([["FS_TEMPS", "CRITICAL", "2026-10-14"], ["CL_DINING", "MAJOR", "2026-10-25"]]);
    expect(done.follow_up).toMatchObject({ audit_type: "FOLLOW_UP", planned_for: "2026-11-10", status: "SCHEDULED" });
    expect(await s.inbox("ops")).toEqual(["PROJ-000001 scored 86.1% (red) on audit AUD-000001"]);
    expect((await s.inbox("pepper"))[0]).toBe("PROJ-000001: follow up audit booked for 10 Nov 2026");
    // The photo stays with the standard.
    expect((await s.call("pepper", "GET", `/audits/${audit.ROWID}/items/FS_TEMPS/photo`)).data.url).toBeTruthy();
  });

  it("lets the franchisee answer actions with evidence; the auditor closes or sends them back", async () => {
    const s = await setup();
    const audit = await runAudit(s, { CL_DINING: "Washroom out of soap", BR_UNIFORM: "Two crew without badges" });
    await s.call("tony", "PATCH", `/audits/${audit.ROWID}`, { action: "complete" });
    const mine = (await s.call("pepper", "GET", `${s.base}/audits`)).data;
    expect(mine.last).toMatchObject({ score: 91.7, rating: "GREEN" });
    expect(mine.actions).toHaveLength(2);
    const [a1, a2] = mine.actions;
    expect((await s.call("happy", "PATCH", `/corrective-actions/${a1.ROWID}`, { action: "respond", note: "Done" })).error?.code).toBe("NOT_FOUND");
    expect((await s.call("pepper", "PATCH", `/corrective-actions/${a1.ROWID}`, { action: "close" })).error?.code).toBe("ACCESS_DENIED");
    expect((await s.call("pepper", "PATCH", `/corrective-actions/${a1.ROWID}`, { action: "respond", note: "Refilled and added to the hourly check", evidence: jpg })).data.status).toBe("SUBMITTED");
    expect(await s.inbox("tony")).toEqual(["PROJ-000001 answered a corrective action from AUD-000001"]);
    expect((await s.inbox("ops"))[0]).toBe("PROJ-000001 answered a corrective action from AUD-000001");
    expect((await s.call("tony", "GET", `/corrective-actions/${a1.ROWID}/evidence`)).data.url).toBeTruthy();
    // Sent back with a new date, answered again, then closed.
    expect((await s.call("tony", "PATCH", `/corrective-actions/${a1.ROWID}`, { action: "reopen", note: "Photo doesn't show the dispenser", due_date: "2026-10-15" })).data).toMatchObject({ status: "OPEN", due_date: "2026-10-15" });
    expect((await s.inbox("pepper"))[0]).toBe("PROJ-000001: a corrective action was sent back");
    await s.call("pepper", "PATCH", `/corrective-actions/${a1.ROWID}`, { action: "respond", note: "New photo of the dispenser", evidence: jpg });
    expect((await s.call("tony", "PATCH", `/corrective-actions/${a1.ROWID}`, { action: "close" })).data.status).toBe("CLOSED");
    expect((await s.call("tony", "PATCH", `/corrective-actions/${a2.ROWID}`, { action: "reopen", note: "x1y" })).error?.code).toBe("INVALID_TRANSITION");
    expect((await s.call("pepper", "GET", `${s.base}/audits`)).data).toMatchObject({ closed_actions: 1, actions: [expect.objectContaining({ item_code: "BR_UNIFORM" })] });
  });

  it("hides open and surprise audits from the franchisee", async () => {
    const s = await setup();
    const surprise = (await s.call("tony", "POST", `${s.base}/audits`, { audit_type: "SURPRISE", planned_for: "2026-10-20" })).data;
    expect(await s.inbox("pepper")).toEqual([]);
    expect((await s.call("pepper", "GET", `${s.base}/audits`)).data.audits).toEqual([]);
    expect((await s.call("pepper", "GET", `/audits/${surprise.ROWID}`)).error?.code).toBe("NOT_FOUND");
    expect((await s.call("ops", "GET", `/audits/${surprise.ROWID}`)).data.status).toBe("SCHEDULED");
    expect((await s.call("tony", "PATCH", `/audits/${surprise.ROWID}`, { action: "cancel", reason: "Area manager away" })).data.status).toBe("CANCELLED");
  });

  it("reminds about overdue actions and stores due an audit, and shows the network", async () => {
    const s = await setup();
    const audit = await runAudit(s, { CL_DINING: "Washroom out of soap" });
    await s.call("tony", "PATCH", `/audits/${audit.ROWID}`, { action: "complete" });
    const out = await runReminderJob(s.store, { now: new Date("2026-10-26T03:00:00Z"), requestId: "R" });
    // The action (to ops and the franchisee) and PROJ-000002, never audited since opening on 1 Aug (to ops).
    expect(out.audits).toBe(3);
    expect(await s.inbox("ops")).toEqual(expect.arrayContaining(["PROJ-000001: a major corrective action is overdue", "PROJ-000002 is due an audit"]));
    expect((await runReminderJob(s.store, { now: new Date("2026-10-27T03:00:00Z"), requestId: "R" })).audits).toBe(0);

    const net = (await s.call("ops", "GET", "/audits")).data;
    expect(net.totals).toMatchObject({ stores: 2, audited: 1, average: 94.4, red: 0, due: 1, actions_open: 1 });
    expect(net.stores.map((x: any) => [x.project_code, x.next_due, x.due_overdue])).toEqual([["PROJ-000002", "2026-08-31", true], ["PROJ-000001", "2027-01-09", false]]);
    expect(net.most_failed).toEqual([{ code: "CL_DINING", text: "Dining area, tables and washrooms are clean and stocked", section: "Cleanliness", stores: 1 }]);
    expect((await s.call("tony", "GET", "/dashboard/network")).data.audit_score.value).toBe(94.4);
  });
});

import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { Mailer } from "../../functions/common/context";
import { runReminderJob } from "../../functions/workflows/notifications";
import { newStore } from "./helpers";

const router = buildRouter();

async function setup() {
  const store = newStore();
  const a = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark Industries", zohoDc: "IN" });
  const users: Record<string, string> = {};
  for (const [role, ext] of [["FRANCHISE_MANAGER", "mgr"], ["FRANCHISE_MANAGER", "mgr2"], ["FRANCHISE_DIRECTOR", "dir"], ["FINANCE_MANAGER", "fin"], ["LEGAL_MANAGER", "legal"], ["PROJECT_MANAGER", "pm"]]) {
    users[ext] = String((await store.insert("users", { tenant_id: a.tenantId, email: `${ext}@x.test`, status: "ACTIVE", role_id: a.roleIds[role], external_user_id: ext })).ROWID);
  }
  const sent: Array<{ to: string; subject: string }> = [];
  const mailer: Mailer = { send: async (m) => { sent.push({ to: m.to, subject: m.subject }); } };
  const call = async (ext: string, method: string, path: string, body?: unknown, query?: Record<string, string>) => {
    const res = await router.handle({ method, path: `/api/v1${path}`, body, query, identity: { externalUserId: ext, email: `${ext}@x.test` } }, { store, mailer });
    return res.body as { success: boolean; data?: any; error?: { code: string } };
  };
  const inbox = async (ext: string) => (await call(ext, "GET", "/notifications")).data as { items: any[]; unread: number };
  return { store, a, users, sent, mailer, call, inbox };
}

async function pendingApproval(s: Awaited<ReturnType<typeof setup>>) {
  const fr = await s.call("mgr", "POST", "/franchisees", { display_name: "Wanda" });
  const app = await s.call("mgr", "POST", "/applications", { franchisee_id: String(fr.data.ROWID) });
  const id = String(app.data.ROWID);
  const fm = await s.store.insert("feasibility_models", { tenant_id: s.a.tenantId, application_id: id, site_id: "1", status: "CALCULATED", passed: true, initial_investment: 100 });
  await s.store.update("franchise_applications", id, { status: "FEASIBILITY_REVIEW", site_id: "1", feasibility_id: String(fm.ROWID) });
  const started = await s.call("mgr", "POST", `/applications/${id}/start-approval`);
  return { id, code: String(app.data.application_code), approvalId: String(started.data.approval.ROWID) };
}

describe("notifications", () => {
  it("tells each approver when a step is theirs, and the manager when the chain ends, in-app and by email", async () => {
    const s = await setup();
    const { code, approvalId } = await pendingApproval(s);
    // Step 1 is the franchise manager's: the other manager hears, the one who started it does not.
    expect((await s.inbox("mgr2")).items.map((n) => n.title)).toEqual([`${code} is waiting for your approval`]);
    expect((await s.inbox("mgr")).unread).toBe(0);
    expect(s.sent).toEqual([{ to: "mgr2@x.test", subject: `${code} is waiting for your approval` }]);

    await s.call("mgr", "POST", `/approvals/${approvalId}/approve`, { step: 1 });
    expect((await s.inbox("fin")).items[0]).toMatchObject({ title: `${code} is waiting for your approval`, link: "/approvals", status: "UNREAD", channel: "IN_APP,EMAIL" });
    await s.call("fin", "POST", `/approvals/${approvalId}/approve`, { step: 2 });
    await s.call("legal", "POST", `/approvals/${approvalId}/approve`, { step: 3 });
    await s.call("dir", "POST", `/approvals/${approvalId}/approve`, { step: 4 });
    const mgr = await s.inbox("mgr");
    expect(mgr.items[0].title).toBe(`${code} was approved`);
    expect(mgr.items[0].link).toMatch(/^\/applications\//);
  });

  it("marks one or all read, and never shows or changes someone else's", async () => {
    const s = await setup();
    await pendingApproval(s);
    const [n] = (await s.inbox("mgr2")).items;
    expect((await s.call("dir", "POST", `/notifications/${n.ROWID}/read`)).error?.code).toBe("NOT_FOUND");
    expect((await s.call("mgr2", "POST", `/notifications/${n.ROWID}/read`)).data.status).toBe("READ");
    expect((await s.inbox("mgr2")).unread).toBe(0);
    expect((await s.call("mgr2", "GET", "/notifications", undefined, { unread: "true" })).data.items).toHaveLength(0);
    expect((await s.call("mgr2", "POST", "/notifications/read-all")).data.read).toBe(0);
  });

  it("falls back to super admins when nobody holds the role", async () => {
    const s = await setup();
    const admin = await s.store.insert("users", { tenant_id: s.a.tenantId, email: "admin@x.test", status: "ACTIVE", role_id: s.a.roleIds.SUPER_ADMIN, external_user_id: "admin" });
    await s.store.update("users", s.users.fin, { status: "INACTIVE" });
    const { approvalId, code } = await pendingApproval(s);
    await s.call("mgr", "POST", `/approvals/${approvalId}/approve`, { step: 1 });
    const items = (await s.inbox("admin")).items;
    expect(items.map((n) => n.title)).toContain(`${code} is waiting for your approval`);
    expect(String(items[0].recipient_user_id)).toBe(String(admin.ROWID));
  });

  it("the daily reminders escalate an overdue approval once and nag task owners once a day", async () => {
    const s = await setup();
    const { approvalId, code } = await pendingApproval(s);
    const project = await s.store.insert("franchise_projects", { tenant_id: s.a.tenantId, project_code: "PROJ-000001", status: "IN_PROGRESS", target_opening_date: "2026-12-01" });
    for (const [item, due] of [["Sign lease", "2026-10-01"], ["Hire crew", "2026-10-05"], ["Train crew", "2026-12-01"]]) {
      await s.store.insert("opening_checklists", { tenant_id: s.a.tenantId, project_id: project.ROWID, item, status: "OPEN", mandatory: true, due_date: due, owner_user_id: s.users.pm });
    }
    const later = new Date(Date.now() + 3 * 86_400_000);
    const first = await runReminderJob(s.store, { now: later, requestId: "REQ-1", mailer: s.mailer });
    expect(first).toMatchObject({ approvals: 3, tasks: 1 }); // both managers own step 1; the director gets the escalation
    expect((await s.inbox("dir")).items[0].title).toBe(`${code} approval is overdue`);
    expect((await s.inbox("pm")).items[0].title).toBe("2 tasks are overdue on PROJ-000001");
    expect((await s.store.findOne("approval_instances", { ROWID: approvalId }))!.escalated).toBe(true);
    // Same day again: nothing new.
    expect(await runReminderJob(s.store, { now: later, requestId: "REQ-2" })).toMatchObject({ approvals: 0, tasks: 0 });
  });

  it("an email failure keeps the in-app notice", async () => {
    const s = await setup();
    const broken: Mailer = { send: async () => { throw new Error("Mail sender not verified"); } };
    const fr = await s.call("mgr", "POST", "/franchisees", { display_name: "Wanda" });
    const app = await s.call("mgr", "POST", "/applications", { franchisee_id: String(fr.data.ROWID) });
    const id = String(app.data.ROWID);
    const fm = await s.store.insert("feasibility_models", { tenant_id: s.a.tenantId, application_id: id, site_id: "1", status: "CALCULATED", passed: true, initial_investment: 100 });
    await s.store.update("franchise_applications", id, { status: "FEASIBILITY_REVIEW", site_id: "1", feasibility_id: String(fm.ROWID) });
    const res = await router.handle({ method: "POST", path: `/api/v1/applications/${id}/start-approval`, identity: { externalUserId: "mgr", email: "mgr@x.test" } }, { store: s.store, mailer: broken });
    expect((res.body as any).success).toBe(true);
    const [n] = (await s.inbox("mgr2")).items;
    expect(n.channel).toBe("IN_APP");
    expect(n.sent_at ?? null).toBeNull();
  });
});

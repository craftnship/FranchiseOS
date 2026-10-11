import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { MemoryFileStorage } from "../../functions/common/files";
import { derivedDates, openingGap, rentSchedule } from "../../functions/workflows/leases";
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
  const user = (role: string, ext: string, franchiseeId?: string) => store.insert("users", { tenant_id: tid, email: `${ext}@x.test`, status: "ACTIVE", role_id: t.roleIds[role], external_user_id: ext, franchisee_id: franchiseeId ?? null });
  await user("FRANCHISE_MANAGER", "fm");
  await user("PROJECT_MANAGER", "pm");
  await user("FINANCE_MANAGER", "fin");
  await user("FRANCHISEE", "pepper", String(fr.ROWID));
  const site = await store.insert("sites", { tenant_id: tid, site_code: "SITE-000001", tenant_code_key: `${tid}:SITE-000001`, application_id: "1", franchisee_id: fr.ROWID, territory_id: "1", city: "Pune", status: "APPROVED" });
  const project = await store.insert("franchise_projects", { tenant_id: tid, project_code: "PROJ-000001", tenant_code_key: `${tid}:PROJ-000001`, application_id: "1", franchisee_id: fr.ROWID, site_id: site.ROWID, status: "IN_PROGRESS", target_opening_date: "2026-12-01" });
  const task = await store.insert("opening_checklists", { tenant_id: tid, project_id: project.ROWID, task_code: "LEASE", item: "Sign lease", category: "CONSTRUCTION", weight: 1, mandatory: true, status: "OPEN", due_date: "2026-10-20" });
  const call = async (ext: string, method: string, path: string, body?: unknown, now = NOW) => {
    const res = await router.handle({ method, path: `/api/v1${path}`, body, identity: { externalUserId: ext, email: `${ext}@x.test` } }, { store, files, now: () => now });
    return res.body as { success: boolean; data?: any; error?: { code: string; fields?: Record<string, string> } };
  };
  const inbox = async (ext: string) => (await call(ext, "GET", "/notifications")).data.items.map((n: any) => n.title) as string[];
  const lease = `/sites/${site.ROWID}/lease`;
  return { store, tid, site, project, task, call, inbox, lease };
}

const pdf = { file_name: "lease deed.pdf", content_type: "application/pdf", data_base64: Buffer.from("%PDF-1.4 lease").toString("base64") };
const terms = { landlord_name: "Shah Estates", monthly_rent: 100_000, security_deposit: 600_000, escalation_pct: 5, lease_start: "2026-10-01", term_months: 108, lock_in_months: 36, rent_free_days: 30 };

describe("lease terms", () => {
  it("works out rent start, lock-in, expiry, notice date and the rent step-ups", () => {
    const l = { ...terms, rent_free_days: 45, renewal_notice_days: 90 };
    expect(derivedDates(l)).toEqual({ rent_start: "2026-11-15", lock_in_end: "2029-09-30", expiry_date: "2035-09-30", notice_by: "2035-07-02" });
    expect(rentSchedule(l, "2026-10-09")).toEqual({ current: 100_000, next: { date: "2027-10-01", rent: 105_000 } });
    expect(rentSchedule(l, "2028-10-01")).toEqual({ current: 110_250, next: { date: "2029-10-01", rent: 115_763 } });
    expect(openingGap(l, "2026-12-01")).toEqual({ days: 16, cost: 52_603 });
    expect(openingGap(l, "2026-11-10")).toBeNull();
  });

  it("signing needs the signed deed; then the site moves to lease signed and the Sign lease task completes", async () => {
    const s = await setup();
    const draft = await s.call("fm", "PATCH", s.lease, terms);
    expect(draft.data.lease).toMatchObject({ status: "DRAFT", rent_start: "2026-10-31", expiry_date: "2035-09-30" });
    expect((await s.store.findOne("sites", { ROWID: String(s.site.ROWID) }))!.rent).toBe(100_000);
    expect((await s.call("fm", "PATCH", s.lease, { status: "SIGNED" })).error?.fields).toEqual({ file: "upload the signed lease first" });
    expect((await s.call("fm", "POST", `${s.lease}/document`, pdf)).data.lease.file_ref).toMatch(/^stratus:tenants\/\d+\/sites\/\d+\/lease\/.+\/lease_deed\.pdf$/);
    const signed = await s.call("fm", "PATCH", s.lease, { status: "SIGNED" });
    expect(signed.data).toMatchObject({ lease: { status: "SIGNED", signed_on: "2026-10-09" }, site: { status: "LEASE_SIGNED" }, task_completed: true });
    expect((await s.store.findOne("opening_checklists", { ROWID: String(s.task.ROWID) }))!.status).toBe("COMPLETED");
    expect((await s.call("fm", "PATCH", s.lease, { status: "DRAFT" })).error?.code).toBe("INVALID_TRANSITION");
    // The project page shows the lease too.
    expect((await s.call("pm", "GET", `/projects/${s.project.ROWID}`)).data.lease).toMatchObject({ status: "SIGNED", rent_start: "2026-10-31", opening_gap: { days: 31 } });
  });

  it("the manual lease signed step is refused without a signed lease", async () => {
    const s = await setup();
    await s.store.update("sites", String(s.site.ROWID), { status: "LEASE_PENDING" });
    expect((await s.call("fm", "POST", `/sites/${s.site.ROWID}/transition`, { transition: "lease_signed" })).error?.fields).toEqual({ lease: "not signed" });
  });

  it("warns when rent starts before the store opens, again when the dates move, and not once it fits", async () => {
    const s = await setup();
    await s.call("fm", "PATCH", s.lease, terms);
    const gap = "Rent on PROJ-000001 starts 31 days before opening";
    expect(await s.inbox("pm")).toEqual([gap]);
    expect(await s.inbox("fin")).toEqual([gap]);
    expect(await s.inbox("pepper")).toEqual([gap]);
    expect(await s.inbox("fm")).toEqual([]); // they made the change
    await runReminderJob(s.store, { now: NOW, requestId: "R1" });
    expect(await s.inbox("pm")).toHaveLength(1);
    await s.store.update("franchise_projects", String(s.project.ROWID), { target_opening_date: "2026-11-15" });
    await runReminderJob(s.store, { now: NOW, requestId: "R2" });
    expect(await s.inbox("pm")).toContain("Rent on PROJ-000001 starts 15 days before opening");
    await s.call("fm", "PATCH", s.lease, { rent_free_days: 60 });
    await runReminderJob(s.store, { now: NOW, requestId: "R3" });
    expect(await s.inbox("pm")).toHaveLength(2);
  });

  it("reminds about the renewal notice date and a rent step-up", async () => {
    const s = await setup();
    await s.call("fm", "POST", `${s.lease}/document`, pdf);
    await s.call("fm", "PATCH", s.lease, { ...terms, lease_start: "2025-11-01", term_months: 13, lock_in_months: 12, rent_free_days: 0, status: "SIGNED" });
    await runReminderJob(s.store, { now: NOW, requestId: "R1" });
    expect(await s.inbox("fm")).toEqual(expect.arrayContaining(["Lease for PROJ-000001 needs a renewal decision by 1 Sept 2026", "Rent on PROJ-000001 is running 53 days before opening"]));
    expect(await s.inbox("fin")).toContain("Rent for PROJ-000001 goes up to ₹1,05,000 on 1 Nov 2026");
    expect(await s.inbox("pepper")).toEqual(expect.arrayContaining(["Lease for PROJ-000001 needs a renewal decision by 1 Sept 2026", "Rent for PROJ-000001 goes up to ₹1,05,000 on 1 Nov 2026"]));
  });

  it("the franchisee sees their lease but can't change it", async () => {
    const s = await setup();
    await s.call("fm", "PATCH", s.lease, terms);
    expect((await s.call("pepper", "GET", `/sites/${s.site.ROWID}`)).data.lease).toMatchObject({ landlord_name: "Shah Estates", rent: { current: 100_000 } });
    expect((await s.call("pepper", "PATCH", s.lease, { monthly_rent: 1 })).error?.code).toBe("ACCESS_DENIED");
    expect((await s.call("fm", "PATCH", s.lease, { lock_in_months: 200 })).error?.fields).toEqual({ lock_in_months: "can't be longer than the term" });
  });
});

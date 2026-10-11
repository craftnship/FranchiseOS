import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { MemoryFileStorage } from "../../functions/common/files";
import { newStore } from "./helpers";

const router = buildRouter();
const NOW = "2026-10-11T06:00:00Z";
const pdf = { file_name: "manual.pdf", content_type: "application/pdf", data_base64: Buffer.from("%PDF-1.4 manual").toString("base64") };

async function setup() {
  const store = newStore();
  const files = new MemoryFileStorage();
  const t = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
  const tid = t.tenantId;
  const fr = await store.insert("franchisees", { tenant_id: tid, franchise_code: "FR-000001", tenant_code_key: `${tid}:FR-000001`, display_name: "Pepper Potts", status: "ACTIVE" });
  const fr2 = await store.insert("franchisees", { tenant_id: tid, franchise_code: "FR-000002", tenant_code_key: `${tid}:FR-000002`, display_name: "Happy Hogan", status: "ACTIVE" });
  const user = (role: string, ext: string, franchiseeId?: string) => store.insert("users", { tenant_id: tid, email: `${ext}@x.test`, name: ext, status: "ACTIVE", role_id: t.roleIds[role], external_user_id: ext, franchisee_id: franchiseeId ?? null });
  await user("SUPER_ADMIN", "tony");
  const fm = await user("FRANCHISE_MANAGER", "fm");
  await user("OPERATIONS_MANAGER", "ops");
  await user("FRANCHISEE", "pepper", String(fr.ROWID));
  await user("FRANCHISEE", "happy", String(fr2.ROWID));
  await store.insert("franchise_applications", { tenant_id: tid, application_code: "APP-000001", tenant_code_key: `${tid}:APP-000001`, franchisee_id: fr.ROWID, status: "ACTIVE", owner_user_id: fm.ROWID });
  const opened = await store.insert("franchise_projects", { tenant_id: tid, project_code: "PROJ-000001", tenant_code_key: `${tid}:PROJ-000001`, franchisee_id: fr.ROWID, site_id: "1", status: "OPENED", actual_opening_date: "2026-08-10" });
  const building = await store.insert("franchise_projects", { tenant_id: tid, project_code: "PROJ-000002", tenant_code_key: `${tid}:PROJ-000002`, franchisee_id: fr.ROWID, site_id: "2", status: "IN_PROGRESS", target_opening_date: "2026-11-01" });
  const call = async (ext: string, method: string, path: string, body?: unknown) => {
    const res = await router.handle({ method, path: `/api/v1${path}`, body, identity: { externalUserId: ext, email: `${ext}@x.test` } }, { store, files, now: () => new Date(NOW) });
    return res.body as { success: boolean; data?: any; error?: { code: string } };
  };
  const inbox = async (ext: string) => (await call(ext, "GET", "/notifications")).data.items.map((n: any) => n.title) as string[];
  return { store, tid, fr, fr2, opened, building, call, inbox };
}

describe("portal v2", () => {
  it("gathers what the franchisee has to do across stores, most urgent first", async () => {
    const s = await setup();
    const ins = (table: string, row: Record<string, unknown>) => s.store.insert(table, { tenant_id: s.tid, ...row });
    const b = String(s.building.ROWID), o = String(s.opened.ROWID);
    await ins("opening_checklists", { project_id: b, task_code: "FITOUT", item: "Complete fit-out", status: "IN_PROGRESS", due_date: "2026-10-05", mandatory: true });
    await ins("opening_checklists", { project_id: b, task_code: "POS", item: "Install POS", status: "NOT_STARTED", due_date: "2026-12-20" });
    await ins("licences", { project_id: b, franchisee_id: s.fr.ROWID, licence_code: "FSSAI", name: "FSSAI food business licence", mandatory: true, status: "NOT_STARTED" });
    await ins("snags", { project_id: b, franchisee_id: s.fr.ROWID, snag_no: 3, title: "Loose tile at the counter", status: "OPEN", due_date: "2026-10-14" });
    await ins("sales_reports", { project_id: o, franchisee_id: s.fr.ROWID, period: "2026-08", period_key: `${s.tid}:${o}:2026-08`, status: "INVOICED", invoice_number: "INV-000342", invoice_balance: 87200, invoice_due_date: "2026-09-25" });
    await ins("corrective_actions", { audit_id: "1", project_id: o, franchisee_id: s.fr.ROWID, description: "Cleaning log not signed", severity: "MAJOR", status: "OPEN", due_date: "2026-10-20", action_key: "k1" });
    await ins("corrective_actions", { audit_id: "1", project_id: o, franchisee_id: s.fr.ROWID, description: "Closed one", severity: "MAJOR", status: "CLOSED", action_key: "k2" });
    // Another franchisee's work never shows.
    await ins("corrective_actions", { audit_id: "2", project_id: "999", franchisee_id: s.fr2.ROWID, description: "Not Pepper's", status: "OPEN", action_key: "k3" });

    const todo = (await s.call("pepper", "GET", "/portal/todo")).data;
    const titles = todo.items.map((i: any) => [i.level, i.title, i.project_code ?? null]);
    expect(titles).toEqual([
      ["overdue", "Pay royalty INV-000342: ₹87,200", "PROJ-000001"],
      ["overdue", "Complete fit-out", "PROJ-000002"],
      ["overdue", "Report your Sep 2026 sales", "PROJ-000001"],
      ["due", "Fix snag 3: Loose tile at the counter", "PROJ-000002"],
      ["due", "Apply for the FSSAI food business licence", "PROJ-000002"],
      ["soon", "Fix: Cleaning log not signed", "PROJ-000001"],
    ]);
    expect(todo.counts).toEqual({ overdue: 3, due: 2, soon: 1, info: 0 });
    expect((await s.call("fm", "GET", "/portal/todo")).error?.code).toBe("ACCESS_DENIED");
  });

  it("flags a mandatory licence still missing once the store is open", async () => {
    const s = await setup();
    await s.store.insert("licences", { tenant_id: s.tid, project_id: String(s.opened.ROWID), franchisee_id: s.fr.ROWID, licence_code: "TRADE", name: "Trade licence", mandatory: true, status: "APPLIED" });
    const items = (await s.call("pepper", "GET", "/portal/todo")).data.items;
    expect(items.find((i: any) => i.kind === "licence")).toMatchObject({ level: "overdue", title: "Chase the Trade licence", project_code: "PROJ-000001" });
  });

  it("carries messages both ways, tells the other side, and marks them read", async () => {
    const s = await setup();
    const sent = await s.call("pepper", "POST", "/portal/messages", { text: "Can we move the grand opening a week?", project_id: String(s.building.ROWID) });
    expect(sent.success).toBe(true);
    expect(await s.inbox("fm")).toEqual(["Message from Pepper Potts"]);
    expect((await s.call("pepper", "POST", "/portal/messages", { text: "x", project_id: "999" })).error?.code).toBe("VALIDATION_FAILED");

    const list = (await s.call("ops", "GET", "/messages")).data;
    expect(list[0]).toMatchObject({ franchisee: "Pepper Potts", unread: 1, last_from: "FRANCHISEE" });
    const conv = (await s.call("ops", "GET", `/franchisees/${s.fr.ROWID}/messages`)).data;
    expect(conv.messages.map((m: any) => [m.from_side, m.sender])).toEqual([["FRANCHISEE", "pepper"]]);
    expect((await s.call("ops", "GET", "/messages")).data[0].unread).toBe(0);

    await s.call("ops", "POST", `/franchisees/${s.fr.ROWID}/messages`, { text: "Yes, I'll move it and the launch plan." });
    expect(await s.inbox("pepper")).toEqual(["New message from the brand team"]);
    expect((await s.call("pepper", "GET", "/portal/todo")).data.items.map((i: any) => i.title)).toContain("1 new message from the brand team");
    const mine = (await s.call("pepper", "GET", "/portal/messages")).data;
    expect(mine.map((m: any) => m.message_text)).toEqual(["Can we move the grand opening a week?", "Yes, I'll move it and the launch plan."]);
    expect((await s.call("pepper", "GET", "/portal/todo")).data.items.map((i: any) => i.title)).not.toContain("1 new message from the brand team");
    // The other franchisee sees none of it, and can't reach Pepper's conversation.
    expect((await s.call("happy", "GET", "/portal/messages")).data).toEqual([]);
    expect((await s.call("happy", "GET", `/franchisees/${s.fr.ROWID}/messages`)).error?.code).toBe("ACCESS_DENIED");
  });

  it("shares brand documents with everyone or one franchisee", async () => {
    const s = await setup();
    expect((await s.call("ops", "POST", "/documents", { title: "Operations manual", category: "MANUAL", file: pdf })).error?.code).toBe("ACCESS_DENIED");
    const all = (await s.call("tony", "POST", "/documents", { title: "Operations manual", category: "MANUAL", file: pdf })).data;
    const one = (await s.call("tony", "POST", "/documents", { title: "Your local launch kit", category: "MARKETING", franchisee_id: String(s.fr2.ROWID), file: pdf })).data;
    expect(await s.inbox("pepper")).toEqual(["New document: Operations manual"]);
    expect(await s.inbox("happy")).toEqual(["New document: Your local launch kit", "New document: Operations manual"]);

    expect((await s.call("pepper", "GET", "/portal/documents")).data.library.map((d: any) => d.title)).toEqual(["Operations manual"]);
    expect((await s.call("pepper", "GET", `/documents/${all.ROWID}/file`)).data.url).toBeTruthy();
    expect((await s.call("pepper", "GET", `/documents/${one.ROWID}/file`)).error?.code).toBe("NOT_FOUND");
    await s.call("tony", "PATCH", `/documents/${all.ROWID}`, { action: "archive" });
    expect((await s.call("pepper", "GET", "/portal/documents")).data.library).toEqual([]);
  });
});

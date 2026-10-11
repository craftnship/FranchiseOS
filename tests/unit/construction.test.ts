import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { MemoryFileStorage } from "../../functions/common/files";
import { distanceM } from "../../functions/workflows/construction";
import { newStore } from "./helpers";

const router = buildRouter();
const NOW = new Date("2026-10-09T06:00:00Z");
const pdf = { file_name: "layout v1.pdf", content_type: "application/pdf", data_base64: Buffer.from("%PDF-1.4 test").toString("base64") };
const jpg = { file_name: "front.jpg", content_type: "image/jpeg", data_base64: Buffer.from("jpegdata").toString("base64") };

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
  await user("FINANCE_MANAGER", "fin");
  await user("FRANCHISEE", "pepper", String(fr.ROWID));
  await user("FRANCHISEE", "happy", String(fr2.ROWID));
  const site = await store.insert("sites", { tenant_id: tid, site_code: "SITE-1", tenant_code_key: `${tid}:SITE-1`, application_id: "1", franchisee_id: fr.ROWID, territory_id: "1", city: "Chennai", latitude: 13.0827, longitude: 80.2707, status: "READY_FOR_PROJECT" });
  const project = await store.insert("franchise_projects", { tenant_id: tid, project_code: "PROJ-000001", tenant_code_key: `${tid}:PROJ-000001`, application_id: "1", franchisee_id: fr.ROWID, site_id: site.ROWID, status: "READY_FOR_OPENING", target_opening_date: "2026-10-30" });
  const task = (code: string, item: string) => store.insert("opening_checklists", { tenant_id: tid, project_id: project.ROWID, task_code: code, item, category: "CONSTRUCTION", weight: 1, mandatory: true, status: "OPEN", due_date: "2026-10-20" });
  const design = await task("DESIGN", "Get store design approved");
  const fitout = await task("FITOUT", "Complete fit-out");
  const call = async (ext: string, method: string, path: string, body?: unknown) => {
    const res = await router.handle({ method, path: `/api/v1${path}`, body, identity: { externalUserId: ext, email: `${ext}@x.test` } }, { store, files, now: () => NOW });
    return res.body as { success: boolean; data?: any; error?: { code: string; message?: string; fields?: Record<string, string> } };
  };
  const base = `/projects/${project.ROWID}`;
  const inbox = async (ext: string) => (await call(ext, "GET", "/notifications")).data.items.map((n: any) => n.title) as string[];
  return { store, files, project, call, base, inbox, design, fitout };
}

describe("store design approval", () => {
  it("franchisee sends versions, staff decide, and approval completes the design task", async () => {
    const s = await setup();
    const v1 = await s.call("pepper", "POST", `${s.base}/designs`, { title: "Layout and elevation", file: pdf });
    expect(v1.data).toMatchObject({ version: 1, status: "SUBMITTED" });
    expect(await s.inbox("mgr")).toContain("PROJ-000001 store design v1 is waiting for approval");
    expect((await s.call("pepper", "POST", `${s.base}/designs`, { title: "Again", file: pdf })).error?.code).toBe("INVALID_TRANSITION");
    // The franchisee can't decide; a change request needs a note.
    expect((await s.call("pepper", "POST", `${s.base}/designs/${v1.data.ROWID}/decision`, { decision: "APPROVED" })).error?.code).toBe("ACCESS_DENIED");
    expect((await s.call("pm", "POST", `${s.base}/designs/${v1.data.ROWID}/decision`, { decision: "CHANGES_REQUESTED" })).error?.fields).toEqual({ note: "required" });
    await s.call("pm", "POST", `${s.base}/designs/${v1.data.ROWID}/decision`, { decision: "CHANGES_REQUESTED", note: "Move the counter to the brand standard 1.2 m." });
    expect(await s.inbox("pepper")).toContain("PROJ-000001 store design v1 needs changes");
    // Fit-out can't be marked done without an approved design.
    expect((await s.call("pm", "PATCH", `${s.base}/checklist/${s.fitout.ROWID}`, { done: true })).error?.fields).toEqual({ design: "not approved" });
    const v2 = await s.call("pepper", "POST", `${s.base}/designs`, { title: "Layout v2", file: pdf });
    expect(v2.data.version).toBe(2);
    const ok = await s.call("pm", "POST", `${s.base}/designs/${v2.data.ROWID}/decision`, { decision: "APPROVED" });
    expect(ok.data).toMatchObject({ status: "APPROVED", task_completed: true });
    expect((await s.store.findOne("opening_checklists", { ROWID: String(s.design.ROWID) }))?.status).toBe("COMPLETED");
    expect((await s.call("pm", "PATCH", `${s.base}/checklist/${s.fitout.ROWID}`, { done: true })).success).toBe(true);
    const c = (await s.call("pepper", "GET", `${s.base}/construction`)).data;
    expect(c.design.current.version).toBe(2);
    expect(c.design.approved.version).toBe(2);
    expect(c.design.history).toHaveLength(2);
    // Another franchisee can't see it.
    expect((await s.call("happy", "GET", `${s.base}/construction`)).error?.code).toBe("NOT_FOUND");
  });
});

describe("site photos", () => {
  it("stores time and place, and flags a photo far from the site", async () => {
    const s = await setup();
    const near = await s.call("pepper", "POST", `${s.base}/photos`, { file: jpg, caption: "Shopfront", area: "Front", taken_at: "2026-10-08T10:00:00+05:30", latitude: 13.0830, longitude: 80.2710, accuracy_m: 12 });
    expect(near.data).toMatchObject({ source: "PORTAL", area: "Front", taken_at: "2026-10-08T04:30:00.000Z", latitude: 13.083 });
    expect(near.data.distance_m).toBeLessThan(100);
    const far = await s.call("pm", "POST", `${s.base}/photos`, { file: jpg, latitude: 12.9716, longitude: 77.5946 });
    expect(far.data.source).toBe("STAFF");
    expect(far.data.distance_m).toBeGreaterThan(250_000);
    // No location and a future time: kept without a place, dated now.
    const plain = await s.call("pepper", "POST", `${s.base}/photos`, { file: jpg, taken_at: "2030-01-01T00:00:00Z" });
    expect(plain.data).toMatchObject({ latitude: null, distance_m: null, taken_at: NOW.toISOString() });
    expect((await s.call("pepper", "POST", `${s.base}/photos`, { file: pdf })).error?.fields).toEqual({ file: "not an image" });
    expect((await s.call("fin", "POST", `${s.base}/photos`, { file: jpg })).error?.code).toBe("ACCESS_DENIED");
    const c = (await s.call("pm", "GET", `${s.base}/construction`)).data;
    expect(c.photos).toHaveLength(3);
    expect(c.site_pin).toEqual({ latitude: 13.0827, longitude: 80.2707 });
    expect((await s.call("pepper", "GET", `${s.base}/photos/${near.data.ROWID}/file`)).data.url).toBeTruthy();
    expect(distanceM(13.0827, 80.2707, 13.0827, 80.2707)).toBe(0);
  });
});

describe("snag list", () => {
  it("raised by staff, fixed by the franchisee, verified by staff, and blocks opening while major ones are open", async () => {
    const s = await setup();
    const raise = (title: string, severity: string) => s.call("pm", "POST", `${s.base}/snags`, { title, severity, area: "Kitchen", photo: jpg });
    expect((await s.call("pepper", "POST", `${s.base}/snags`, { title: "Something", severity: "MINOR" })).error?.code).toBe("ACCESS_DENIED");
    const leak = (await raise("Leak under the sink", "MAJOR")).data;
    const paint = (await raise("Paint touch-up by the door", "MINOR")).data;
    const exit = (await raise("Fire exit sign missing", "CRITICAL")).data;
    expect([leak.snag_no, paint.snag_no, exit.snag_no]).toEqual([1, 2, 3]);
    expect(await s.inbox("pepper")).toEqual(expect.arrayContaining(["Major snag #1 at PROJ-000001: Leak under the sink", "Critical snag #3 at PROJ-000001: Fire exit sign missing"]));
    expect((await s.inbox("pepper")).some((t) => t.includes("Paint"))).toBe(false);
    const open = () => s.call("pm", "POST", `${s.base}/transition`, { transition: "open", actual_opening_date: "2026-10-09" });
    // Licences come first; issue them so the snag gate is what stops the opening.
    await s.call("pm", "GET", s.base); // seeds the licence register
    for (const l of await s.store.findMany("licences", { project_id: String(s.project.ROWID) })) await s.store.update("licences", String(l.ROWID), { status: "ISSUED", issued_on: "2026-10-01" });
    const blocked = await open();
    expect(blocked.error?.code).toBe("SNAGS_OPEN");
    expect(blocked.error?.fields).toEqual({ snag_1: "open", snag_3: "open" });
    // Franchisee fixes; staff verify or reopen; only staff close.
    expect((await s.call("pepper", "PATCH", `${s.base}/snags/${leak.ROWID}`, { action: "fix", note: "Pipe replaced", photo: jpg })).data).toMatchObject({ status: "FIXED", fix_note: "Pipe replaced" });
    expect(await s.inbox("pm")).toContain("PROJ-000001 snag #1 marked fixed: Leak under the sink");
    expect((await s.call("pepper", "PATCH", `${s.base}/snags/${leak.ROWID}`, { action: "close" })).error?.code).toBe("ACCESS_DENIED");
    expect((await s.call("happy", "PATCH", `${s.base}/snags/${leak.ROWID}`, { action: "fix" })).error?.code).toBe("NOT_FOUND");
    expect((await open()).error?.fields).toEqual({ snag_1: "fixed, not verified", snag_3: "open" });
    await s.call("pm", "PATCH", `${s.base}/snags/${leak.ROWID}`, { action: "reopen", note: "Still dripping at the joint" });
    expect(await s.inbox("pepper")).toContain("Snag #1 at PROJ-000001 was reopened");
    await s.call("pepper", "PATCH", `${s.base}/snags/${leak.ROWID}`, { action: "fix", note: "Joint resealed" });
    expect((await s.call("pm", "PATCH", `${s.base}/snags/${leak.ROWID}`, { action: "close" })).data.status).toBe("CLOSED");
    expect((await s.call("pm", "PATCH", `${s.base}/snags/${exit.ROWID}`, { action: "waive" })).error?.code).toBe("VALIDATION_FAILED");
    expect((await s.call("pm", "PATCH", `${s.base}/snags/${exit.ROWID}`, { action: "waive", note: "Sign fitted by landlord, inspected on site" })).data.status).toBe("WAIVED");
    const c = (await s.call("pm", "GET", `${s.base}/construction`)).data;
    expect(c.snag_counts).toEqual({ open: 1, fixed: 0, blocking: 0, total: 3 });
    expect(c.snags.map((x: any) => x.snag_no)).toEqual([2, 1, 3]);
    // A minor snag doesn't hold the opening.
    expect((await open()).error?.code).not.toBe("SNAGS_OPEN");
  });
});

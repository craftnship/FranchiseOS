import { describe, expect, it, vi } from "vitest";
import { newStore, ctx } from "./helpers";
import { processOnce } from "../../functions/integrations/idempotency";
import { withRetry, ProviderError } from "../../functions/integrations/retry";
import { resolveZohoEndpoints } from "../../functions/integrations/region";
import { buildSelect, literal, toStoreRow } from "../../functions/common/catalystStore";
import { resolveTenant } from "../../functions/common/tenant";
import { fail, ok } from "../../functions/common/response";
import { AppError } from "../../functions/common/errors";
import { redact } from "../../functions/common/logger";
import { TenantRepo } from "../../functions/common/store";
import { buildOpeningProject } from "../../functions/workflows/projectCreation";
import { QSR_PROJECT_TEMPLATE } from "../../database/seed/defaults";
import { ZohoProjectsClient } from "../../functions/integrations/clients";
import { TABLES } from "../../database/schema/tables";

describe("webhook idempotency (§14, FOS-012/015)", () => {
  it("processes an event once and reports duplicates", async () => {
    const store = newStore();
    const handler = vi.fn(async () => "created");
    const evt = { source: "CRM", eventId: "E1", recordId: "L1", payload: {} };
    expect(await processOnce(store, "T1", evt, handler)).toEqual({ duplicate: false, result: "created" });
    expect(await processOnce(store, "T1", evt, handler)).toEqual({ duplicate: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it("allows a failed event to be retried", async () => {
    const store = newStore();
    const evt = { source: "SIGN", eventId: "E2", recordId: "R1", payload: {} };
    await expect(processOnce(store, "T1", evt, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await processOnce(store, "T1", evt, async () => "ok")).toEqual({ duplicate: false, result: "ok" });
  });
});

describe("retry and dead letter (§29)", () => {
  const log = (store = newStore()) => ({ store, tenantId: "T1", sourceSystem: "PROJECTS", entityType: "project", entityId: "P1", operation: "createTask", requestId: "REQ-1" });
  it("retries retryable errors then succeeds", async () => {
    const l = log();
    let n = 0;
    const r = await withRetry(async () => { if (++n < 3) throw new ProviderError("busy", 503); return "done"; }, l, { sleep: async () => {} });
    expect(r).toBe("done");
    expect((await l.store.findMany("integration_logs", {})).map((x) => x.status)).toEqual(["RETRYING", "RETRYING", "SUCCESS"]);
  });
  it("does not retry a 400 and dead-letters it", async () => {
    const l = log();
    await expect(withRetry(async () => { throw new ProviderError("bad", 400); }, l, { sleep: async () => {} })).rejects.toThrow("bad");
    expect((await l.store.findMany("integration_logs", {})).map((x) => x.status)).toEqual(["DEAD_LETTER"]);
  });
});

describe("project creation saga (§15, FOS-053..056)", () => {
  function fakeProjects(failOnTaskNumber?: number): ZohoProjectsClient & { calls: Record<string, number> } {
    const calls: Record<string, number> = { createProject: 0, createTaskList: 0, createTask: 0, addDependency: 0 };
    let id = 0;
    return {
      calls,
      createProject: async () => { calls.createProject++; return { id: "ZP" + ++id }; },
      getProject: async (pid) => ({ id: pid }),
      createTaskList: async () => { calls.createTaskList++; return { id: "TL" + ++id }; },
      createTask: async () => {
        calls.createTask++;
        if (failOnTaskNumber && calls.createTask === failOnTaskNumber) throw new ProviderError("timeout", 504);
        return { id: "TK" + ++id };
      },
      updateTask: async () => {},
      addDependency: async () => { calls.addDependency++; },
    };
  }
  async function seedProject() {
    const store = newStore();
    const p = await store.insert("franchise_projects", { tenant_id: "T1", project_code: "PROJ-000001", tenant_code_key: "T1:PROJ-000001", status: "NOT_STARTED", target_opening_date: "2027-01-15", zoho_project_id: null });
    return { store, p };
  }
  const deps = QSR_PROJECT_TEMPLATE.reduce((s, t) => s + (t.depends_on?.length ?? 0), 0);

  it("creates project, task lists, tasks and dependencies", async () => {
    const { store, p } = await seedProject();
    const api = fakeProjects();
    const r = await buildOpeningProject(store, ctx(["SYSTEM"]), api, { projectRowId: p.ROWID!, template: QSR_PROJECT_TEMPLATE, startDate: "2026-10-10" });
    expect(r.tasksCreated).toBe(QSR_PROJECT_TEMPLATE.length);
    expect(r.dependenciesCreated).toBe(deps);
    expect(api.calls.createTaskList).toBe(new Set(QSR_PROJECT_TEMPLATE.map((t) => t.category)).size);
    expect((await store.findOne("franchise_projects", { ROWID: p.ROWID! }))!.status).toBe("PLANNING");
  });
  it("resumes after a mid-way failure without recreating the project or tasks", async () => {
    const { store, p } = await seedProject();
    const api = fakeProjects(5);
    const args = { projectRowId: p.ROWID!, template: QSR_PROJECT_TEMPLATE, startDate: "2026-10-10" };
    await expect(buildOpeningProject(store, ctx(["SYSTEM"]), api, args)).rejects.toThrow("timeout");
    const r = await buildOpeningProject(store, ctx(["SYSTEM"]), api, args);
    expect(api.calls.createProject).toBe(1);
    expect(api.calls.createTask).toBe(QSR_PROJECT_TEMPLATE.length + 1); // one failed call, nothing duplicated
    expect(r.tasksCreated).toBe(QSR_PROJECT_TEMPLATE.length - 4);
    const third = await buildOpeningProject(store, ctx(["SYSTEM"]), api, args);
    expect(third).toMatchObject({ tasksCreated: 0, dependenciesCreated: 0 });
  });
});

describe("platform basics", () => {
  it("escapes ZCQL literals and rejects unsafe identifiers", () => {
    expect(literal("O'Reilly")).toBe("'O\\'Reilly'");
    expect(buildSelect("sites", { tenant_id: "T1", city: "x' OR 1=1 --" })).toBe("SELECT * FROM sites WHERE tenant_id = 'T1' AND city = 'x\\' OR 1=1 --' LIMIT 300");
    expect(() => buildSelect("sites; DROP", {})).toThrow(/Unsafe/);
  });
  it("tenant repo always scopes reads and strips tenant_id from updates", async () => {
    const store = newStore();
    const row = await store.insert("sites", { tenant_id: "T2", site_code: "SITE-1", tenant_code_key: "T2:SITE-1", status: "PROPOSED" });
    const repo = new TenantRepo(store, "T1");
    expect(await repo.findOne("sites", { ROWID: row.ROWID! })).toBeNull();
    await expect(repo.update("sites", row.ROWID!, { status: "X" })).rejects.toThrow();
  });
  it("resolves tenant only from the authenticated identity", async () => {
    const dir = {
      findActiveByExternalId: async (id: string) => (id === "cat-1" ? { userId: "U1", tenantId: "T1", roleCodes: ["FRANCHISEE"] } : null),
      findTenant: async (id: string) => (id === "T1" ? { tenantId: "T1", status: "ACTIVE", zohoDc: "IN" } : null),
    };
    await expect(resolveTenant(null, dir, { requestId: "R" })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await expect(resolveTenant({ externalUserId: "nobody", email: "" }, dir, { requestId: "R" })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(await resolveTenant({ externalUserId: "cat-1", email: "" }, dir, { requestId: "R" })).toMatchObject({ tenantId: "T1", zohoDc: "IN" });
  });
  it("uses the §11 envelope and hides unknown errors", () => {
    expect(ok({ a: 1 }, "REQ-1")).toEqual({ success: true, data: { a: 1 }, meta: { request_id: "REQ-1" } });
    expect(fail(new AppError("SITE_NOT_FOUND"), "REQ-2")).toEqual({ status: 404, body: { success: false, error: { code: "SITE_NOT_FOUND", message: "Site not found." }, meta: { request_id: "REQ-2" } } });
    expect(fail(new Error("db password leaked"), "REQ-3").body.error!.message).not.toMatch(/password/);
  });
  it("redacts secrets in logs", () => {
    expect(redact({ refresh_token: "abc", nested: { Authorization: "Bearer x" }, ok: 1 })).toEqual({ refresh_token: "[REDACTED]", nested: { Authorization: "[REDACTED]" }, ok: 1 });
  });
  it("resolves region endpoints", () => {
    expect(resolveZohoEndpoints("IN").crm).toBe("https://www.zohoapis.in/crm/v8");
    expect(resolveZohoEndpoints("eu").sign).toBe("https://sign.zoho.eu/api/v1");
    expect(() => resolveZohoEndpoints("XX")).toThrow();
  });
  it("schema: every table except tenants is tenant-scoped and every reference exists", () => {
    const names = new Set(TABLES.map((t) => t.name));
    for (const t of TABLES) {
      if (t.name !== "tenants") expect(t.columns.some((c) => c.name === "tenant_id"), t.name).toBe(true);
      for (const c of t.columns) if (c.ref) expect(names.has(c.ref), `${t.name}.${c.name} -> ${c.ref}`).toBe(true);
    }
  });
});

describe("Catalyst datetime values", () => {
  it("converts UTC ISO timestamps to the Data Store datetime format and leaves other values alone", () => {
    expect(toStoreRow({ created_at: "2026-10-08T18:16:09.302Z", d: "2026-10-08", n: 1, j: '{"at":"2026-10-08T18:16:09Z"}', x: null }))
      .toEqual({ created_at: "2026-10-08 18:16:09", d: "2026-10-08", n: 1, j: '{"at":"2026-10-08T18:16:09Z"}', x: null });
  });

  it("records a readable error for non-Error throws", async () => {
    const store = newStore();
    await expect(processOnce(store, "t1", { source: "CRM", eventId: "e", recordId: "r", payload: {} }, async () => { throw { code: "INVALID_INPUT" }; })).rejects.toBeTruthy();
    const row = await store.findOne("integration_events", { event_key: "CRM:e:r" });
    expect(row?.error_message).toContain("INVALID_INPUT");
  });
});

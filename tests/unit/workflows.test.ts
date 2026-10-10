import { describe, expect, it } from "vitest";
import { ctx, newStore, permissions } from "./helpers";
import { transitionEntity } from "../../functions/workflows/transition";
import { startApproval, actOnApproval, findOverdueSteps } from "../../functions/workflows/approvals";
import { reserveTerritory, releaseTerritory, expireReservations } from "../../functions/workflows/territoryReservation";
import { nextBusinessId } from "../../functions/common/ids";
import { AppError } from "../../functions/common/errors";
import { DEFAULT_APPROVAL_WORKFLOW } from "../../database/seed/defaults";
import { Store } from "../../functions/common/store";

const code = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return (e as AppError).code ?? String(e); } };

async function seedApplication(store: Store, status = "DRAFT", tenant = "T1") {
  return store.insert("franchise_applications", { tenant_id: tenant, application_code: "APP-000001", tenant_code_key: `${tenant}:APP-000001`, status, franchisee_id: "F1", application_type: "SINGLE_UNIT", preferred_city: "Chennai", investment_capacity: 5_000_000 });
}

describe("transition engine (§10, §40, D-5)", () => {
  const deps = (store: Store) => ({ store, permissions });

  it("moves DRAFT → SUBMITTED for the franchisee and writes an activity log", async () => {
    const store = newStore();
    const app = await seedApplication(store);
    const out = await transitionEntity("application", app.ROWID!, "submit", ctx(["FRANCHISEE"]), deps(store));
    expect(out.status).toBe("SUBMITTED");
    expect(await store.findMany("activity_logs", { entity_id: app.ROWID! })).toHaveLength(1);
  });
  it("rejects an invalid transition", async () => {
    const store = newStore();
    const app = await seedApplication(store);
    expect(await code(transitionEntity("application", app.ROWID!, "qualify", ctx(["FRANCHISE_MANAGER"]), deps(store)))).toBe("APPLICATION_INVALID_STATE");
  });
  it("enforces server-side permissions", async () => {
    const store = newStore();
    const app = await seedApplication(store, "SUBMITTED");
    expect(await code(transitionEntity("application", app.ROWID!, "start_review", ctx(["FRANCHISEE"]), deps(store)))).toBe("ACCESS_DENIED");
  });
  it("users cannot approve directly; only the approval engine (system) can", async () => {
    const store = newStore();
    const app = await seedApplication(store, "APPROVAL_PENDING");
    expect(await code(transitionEntity("application", app.ROWID!, "approve", ctx(["FRANCHISE_DIRECTOR"]), deps(store)))).toBe("ACCESS_DENIED");
    expect(await code(transitionEntity("application", app.ROWID!, "approve", ctx(["SYSTEM"]), deps(store)))).toBe("OK");
  });
  it("requires mandatory data", async () => {
    const store = newStore();
    const app = await seedApplication(store, "UNDER_REVIEW");
    expect(await code(transitionEntity("application", app.ROWID!, "qualify", ctx(["FRANCHISE_MANAGER"]), deps(store)))).toBe("VALIDATION_FAILED");
  });
  it("hold and resume return to the previous state", async () => {
    const store = newStore();
    const app = await seedApplication(store, "FEASIBILITY_REVIEW");
    const c = ctx(["FRANCHISE_MANAGER"]);
    expect((await transitionEntity("application", app.ROWID!, "hold", c, deps(store))).status).toBe("ON_HOLD");
    expect((await transitionEntity("application", app.ROWID!, "resume", c, deps(store))).status).toBe("FEASIBILITY_REVIEW");
  });
  it("cannot reach another tenant's record (FOS-005)", async () => {
    const store = newStore();
    const app = await seedApplication(store, "DRAFT", "T2");
    expect(await code(transitionEntity("application", app.ROWID!, "submit", ctx(["FRANCHISEE"], "T1"), deps(store)))).toBe("APPLICATION_NOT_FOUND");
  });
});

async function seedWorkflow(store: Store, version = 1, tenant = "T1") {
  const wf = await store.insert("approval_workflows", { tenant_id: tenant, code: "FRANCHISE_APPROVAL", status: "ACTIVE", version, entity_type: "application" });
  for (const s of DEFAULT_APPROVAL_WORKFLOW.steps) await store.insert("approval_workflow_steps", { tenant_id: tenant, workflow_id: wf.ROWID, ...s });
  return wf;
}

describe("approval engine (§19, §29, FOS-031/034/043)", () => {
  it("runs the default 4-step chain to APPROVED", async () => {
    const store = newStore();
    await seedWorkflow(store);
    const inst = await startApproval(store, ctx(["FRANCHISE_MANAGER"]), { entityType: "application", entityId: "A1", workflowCode: "FRANCHISE_APPROVAL", facts: { initial_investment: 3_000_000 } });
    const roles = ["FRANCHISE_MANAGER", "FINANCE_MANAGER", "LEGAL_MANAGER", "FRANCHISE_DIRECTOR"];
    const outcomes = [];
    for (let i = 0; i < roles.length; i++) outcomes.push((await actOnApproval(store, ctx([roles[i]]), { approvalId: inst.ROWID!, action: "APPROVE", stepSequence: i + 1 })).outcome);
    expect(outcomes).toEqual(["ADVANCED", "ADVANCED", "ADVANCED", "APPROVED"]);
  });
  it("skips a conditional step whose condition is false", async () => {
    const store = newStore();
    await seedWorkflow(store);
    const inst = await startApproval(store, ctx(["FRANCHISE_MANAGER"]), { entityType: "application", entityId: "A1", workflowCode: "FRANCHISE_APPROVAL", facts: { initial_investment: 0 } });
    expect(JSON.parse(String(inst.steps_json)).map((s: { approver_role: string }) => s.approver_role)).toEqual(["FRANCHISE_MANAGER", "LEGAL_MANAGER", "FRANCHISE_DIRECTOR"]);
  });
  it("only the current approver can act, and replays are rejected", async () => {
    const store = newStore();
    await seedWorkflow(store);
    const inst = await startApproval(store, ctx(["FRANCHISE_MANAGER"]), { entityType: "application", entityId: "A1", workflowCode: "FRANCHISE_APPROVAL", facts: {} });
    expect(await code(actOnApproval(store, ctx(["FRANCHISE_DIRECTOR"]), { approvalId: inst.ROWID!, action: "APPROVE", stepSequence: 1 }))).toBe("APPROVAL_NOT_ALLOWED");
    await actOnApproval(store, ctx(["FRANCHISE_MANAGER"]), { approvalId: inst.ROWID!, action: "APPROVE", stepSequence: 1 });
    expect(await code(actOnApproval(store, ctx(["FRANCHISE_MANAGER"]), { approvalId: inst.ROWID!, action: "APPROVE", stepSequence: 1 }))).toBe("APPROVAL_ALREADY_COMPLETED");
  });
  it("SUPER_ADMIN can decide every step, and each override is recorded", async () => {
    const store = newStore();
    await seedWorkflow(store);
    const inst = await startApproval(store, ctx(["SUPER_ADMIN"]), { entityType: "application", entityId: "A1", workflowCode: "FRANCHISE_APPROVAL", facts: { initial_investment: 3_000_000 } });
    const outcomes = [];
    for (let i = 1; i <= 4; i++) outcomes.push((await actOnApproval(store, ctx(["SUPER_ADMIN"]), { approvalId: inst.ROWID!, action: "APPROVE", stepSequence: i })).outcome);
    expect(outcomes).toEqual(["ADVANCED", "ADVANCED", "ADVANCED", "APPROVED"]);
    const actions = await store.findMany("approval_actions", { approval_id: inst.ROWID! });
    expect(actions.map((a) => a.comments)).toContain("[Super admin override for FINANCE_MANAGER]");
    const logs = await store.findMany("activity_logs", { action: "approval:approve" });
    expect(logs.every((l) => JSON.parse(String(l.metadata_json)).override === true)).toBe(true);
  });
  it("two concurrent clicks record one decision", async () => {
    const store = newStore();
    await seedWorkflow(store);
    const inst = await startApproval(store, ctx(["FRANCHISE_MANAGER"]), { entityType: "application", entityId: "A1", workflowCode: "FRANCHISE_APPROVAL", facts: {} });
    const results = await Promise.all([1, 2].map(() => code(actOnApproval(store, ctx(["FRANCHISE_MANAGER"]), { approvalId: inst.ROWID!, action: "APPROVE", stepSequence: 1 }))));
    expect(results.sort()).toEqual(["APPROVAL_ALREADY_COMPLETED", "OK"]);
  });
  it("prevents two live approvals on one record", async () => {
    const store = newStore();
    await seedWorkflow(store);
    const args = { entityType: "application", entityId: "A1", workflowCode: "FRANCHISE_APPROVAL", facts: {} };
    await startApproval(store, ctx(["FRANCHISE_MANAGER"]), args);
    expect(await code(startApproval(store, ctx(["FRANCHISE_MANAGER"]), args))).toBe("APPROVAL_NOT_ALLOWED");
  });
  it("pins the workflow version so config changes do not affect running instances", async () => {
    const store = newStore();
    await seedWorkflow(store, 1);
    const inst = await startApproval(store, ctx(["FRANCHISE_MANAGER"]), { entityType: "application", entityId: "A1", workflowCode: "FRANCHISE_APPROVAL", facts: {} });
    await seedWorkflow(store, 2);
    expect(inst.workflow_version).toBe(1);
    const next = await startApproval(store, ctx(["FRANCHISE_MANAGER"]), { entityType: "application", entityId: "A2", workflowCode: "FRANCHISE_APPROVAL", facts: {} });
    expect(next.workflow_version).toBe(2);
  });
  it("reject and return need a comment", async () => {
    const store = newStore();
    await seedWorkflow(store);
    const inst = await startApproval(store, ctx(["FRANCHISE_MANAGER"]), { entityType: "application", entityId: "A1", workflowCode: "FRANCHISE_APPROVAL", facts: {} });
    expect(await code(actOnApproval(store, ctx(["FRANCHISE_MANAGER"]), { approvalId: inst.ROWID!, action: "RETURN", stepSequence: 1 }))).toBe("VALIDATION_FAILED");
    const r = await actOnApproval(store, ctx(["FRANCHISE_MANAGER"]), { approvalId: inst.ROWID!, action: "RETURN", stepSequence: 1, comments: "Update rent figures" });
    expect(r.outcome).toBe("RETURNED");
  });
  it("an active delegate can act; an expired one cannot", async () => {
    const store = newStore();
    await seedWorkflow(store);
    const inst = await startApproval(store, ctx(["FRANCHISE_MANAGER"]), { entityType: "application", entityId: "A1", workflowCode: "FRANCHISE_APPROVAL", facts: {} });
    const now = new Date("2026-10-08T12:00:00Z");
    await store.insert("approval_delegations", { tenant_id: "T1", delegator_user_id: "U9", delegate_user_id: "U5", role: "FRANCHISE_MANAGER", starts_at: "2026-10-01T00:00:00Z", ends_at: "2026-10-05T00:00:00Z", status: "ACTIVE" });
    expect(await code(actOnApproval(store, ctx(["REGIONAL_MANAGER"], "T1", "U5"), { approvalId: inst.ROWID!, action: "APPROVE", stepSequence: 1, now }))).toBe("APPROVAL_NOT_ALLOWED");
    await store.insert("approval_delegations", { tenant_id: "T1", delegator_user_id: "U9", delegate_user_id: "U5", role: "FRANCHISE_MANAGER", starts_at: "2026-10-07T00:00:00Z", ends_at: "2026-10-10T00:00:00Z", status: "ACTIVE" });
    expect(await code(actOnApproval(store, ctx(["REGIONAL_MANAGER"], "T1", "U5"), { approvalId: inst.ROWID!, action: "APPROVE", stepSequence: 1, now }))).toBe("OK");
  });
  it("finds steps past their SLA", async () => {
    const store = newStore();
    await seedWorkflow(store);
    await startApproval(store, ctx(["FRANCHISE_MANAGER"]), { entityType: "application", entityId: "A1", workflowCode: "FRANCHISE_APPROVAL", facts: {}, now: new Date("2026-10-01T00:00:00Z") });
    const overdue = await findOverdueSteps(store, "T1", new Date("2026-10-04T00:00:00Z"));
    expect(overdue).toHaveLength(1);
    expect(overdue[0].step.escalation_role).toBe("FRANCHISE_DIRECTOR");
  });
});

describe("territory reservation (§29, FOS-024, D-13)", () => {
  async function seedTerritory(store: Store) {
    return store.insert("territories", { tenant_id: "T1", territory_code: "TER-000001", tenant_code_key: "T1:TER-000001", name: "OMR", status: "AVAILABLE" });
  }
  it("50 parallel reservations produce exactly one success", async () => {
    const store = newStore();
    const t = await seedTerritory(store);
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) =>
      code(reserveTerritory(store, ctx(["FRANCHISE_MANAGER"], "T1", "U" + i), { territoryId: t.ROWID!, applicationId: "A" + i, reservationDays: 30 }))));
    expect(results.filter((r) => r === "OK")).toHaveLength(1);
    expect(results.filter((r) => r === "TERRITORY_CONFLICT" || r === "TERRITORY_NOT_AVAILABLE")).toHaveLength(49);
  });
  it("release frees the territory for the next applicant", async () => {
    const store = newStore();
    const t = await seedTerritory(store);
    const c = ctx(["FRANCHISE_MANAGER"]);
    const r = await reserveTerritory(store, c, { territoryId: t.ROWID!, applicationId: "A1", reservationDays: 30 });
    await releaseTerritory(store, c, { reservationId: r.ROWID!, reason: "RELEASED" });
    expect(await code(reserveTerritory(store, c, { territoryId: t.ROWID!, applicationId: "A2", reservationDays: 30 }))).toBe("OK");
  });
  it("the daily run expires, frees or allocates each reservation by its application's state", async () => {
    const store = newStore();
    const c = ctx(["FRANCHISE_MANAGER"]);
    const sept = new Date("2026-09-01T00:00:00Z");
    const cases: Array<[string, string]> = [["QUALIFIED", "AVAILABLE"], ["FEASIBILITY", "RESERVED"], ["WITHDRAWN", "AVAILABLE"], ["ONBOARDING", "ALLOCATED"]];
    const made = [];
    for (const [i, [state]] of cases.entries()) {
      const t = await store.insert("territories", { tenant_id: "T1", territory_code: `TER-00000${i + 1}`, tenant_code_key: `T1:TER-00000${i + 1}`, name: state, status: "AVAILABLE" });
      const app = await store.insert("franchise_applications", { tenant_id: "T1", status: state, territory_id: t.ROWID });
      await reserveTerritory(store, c, { territoryId: t.ROWID!, applicationId: app.ROWID!, reservationDays: 30, now: sept });
      made.push({ t, app });
    }
    expect(await expireReservations(store, c, new Date("2026-10-08T00:00:00Z"))).toEqual({ expired: 1, released: 1, allocated: 1 });
    for (const [i, [, want]] of cases.entries()) expect((await store.findOne("territories", { ROWID: made[i].t.ROWID! }))!.status).toBe(want);
    // An application that lost its territory no longer points at it; the allocated one keeps it.
    expect((await store.findOne("franchise_applications", { ROWID: made[0].app.ROWID! }))!.territory_id).toBeNull();
    expect((await store.findOne("franchise_applications", { ROWID: made[3].app.ROWID! }))!.territory_id).toBe(made[3].t.ROWID);
    // A second run changes nothing.
    expect(await expireReservations(store, c, new Date("2026-10-08T00:00:00Z"))).toEqual({ expired: 0, released: 0, allocated: 0 });
  });
});

describe("business IDs (§9)", () => {
  it("never issues the same ID under concurrency", async () => {
    const store = newStore();
    const ids = await Promise.all(Array.from({ length: 25 }, () => nextBusinessId(store, "T1", "application")));
    expect(new Set(ids).size).toBe(25);
    expect(ids).toContain("APP-000001");
  });
  it("sequences are per tenant", async () => {
    const store = newStore();
    await nextBusinessId(store, "T1", "site");
    expect(await nextBusinessId(store, "T2", "site")).toBe("SITE-000001");
  });
});

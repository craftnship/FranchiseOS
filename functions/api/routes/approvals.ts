import { z } from "zod";
import { AppError } from "../../common/errors";
import { Row } from "../../common/store";
import { toNum } from "../../common/values";
import { logActivity } from "../../common/audit";
import { isPortalUser } from "../../common/rbac";
import { actOnApproval, ApprovalAction, PinnedStep } from "../../workflows/approvals";
import { transitionEntity } from "../../workflows/transition";
import { Call, page, parse, Router } from "../router";
import { mustGet } from "./shared";

/** Roles that decide approval steps and so can be handed to someone else for a while. */
const APPROVER_ROLES = ["FRANCHISE_MANAGER", "FINANCE_MANAGER", "LEGAL_MANAGER", "FRANCHISE_DIRECTOR"];
const PORTAL_ROLES = ["FRANCHISEE", "FRANCHISEE_STAFF", "VENDOR"];
const MAX_DELEGATION_DAYS = 90;
const delegationSchema = z.object({
  delegate_user_id: z.string().min(1),
  role: z.enum(APPROVER_ROLES as [string, ...string[]]),
  starts_at: z.string().datetime({ offset: true }),
  ends_at: z.string().datetime({ offset: true }),
}).strict();

const actSchema = z.object({ step: z.number().int().positive(), comments: z.string().trim().max(4000).optional() }).strict();

/** What the approval outcome does to the application (§19). */
const APPLICATION_TRANSITION: Record<string, string> = { APPROVED: "approve", RETURNED: "return", REJECTED: "reject" };

function currentStep(instance: Row): PinnedStep | undefined {
  const steps = JSON.parse(String(instance.steps_json)) as PinnedStep[];
  return steps.find((s) => s.sequence === toNum(instance.current_step));
}

async function delegatedRoles(call: Call): Promise<string[]> {
  const rows = await call.repo.findMany("approval_delegations", { delegate_user_id: call.ctx.userId, status: "ACTIVE" });
  return rows.filter((d) => new Date(String(d.starts_at)) <= call.now && call.now <= new Date(String(d.ends_at))).map((d) => String(d.role));
}

async function act(call: Call, action: ApprovalAction) {
  const body = parse(actSchema, call.body);
  const { outcome, instance } = await actOnApproval(call.store, call.ctx, { approvalId: call.params.id, action, stepSequence: body.step, comments: body.comments, now: call.now });
  const transition = APPLICATION_TRANSITION[outcome];
  let entity: Record<string, unknown> | null = null;
  if (transition && instance.entity_type === "application") {
    // Engine-driven: the approver's decision is the authority, so the system permission is granted here only.
    entity = await transitionEntity("application", String(instance.entity_id), transition, call.ctx, {
      store: call.store, onTransition: call.onTransition, permissions: async () => new Set(["system.approval", "application.reject"]),
    });
  }
  return { outcome, approval: instance, entity };
}

/** Staff users with their role code, for naming people and picking a delegate. */
async function staffDirectory(call: Call): Promise<Map<string, { ROWID: string; name: string | null; email: string; role: string; active: boolean }>> {
  const [users, roles] = await Promise.all([call.repo.findMany("users", {}, { limit: 500 }), call.repo.findMany("roles", {}, { limit: 100 })]);
  const roleCode = new Map(roles.map((x) => [String(x.ROWID), String(x.code)]));
  return new Map(users.map((u) => [String(u.ROWID), {
    ROWID: String(u.ROWID), name: u.name ? String(u.name) : null, email: String(u.email),
    role: roleCode.get(String(u.role_id)) ?? "", active: u.status === "ACTIVE" && !u.franchisee_id,
  }]));
}

/** ACTIVE delegations read as scheduled, live or expired by their window. */
function delegationState(d: Row, now: Date): string {
  if (d.status !== "ACTIVE") return String(d.status);
  if (now < new Date(String(d.starts_at))) return "SCHEDULED";
  if (now > new Date(String(d.ends_at))) return "EXPIRED";
  return "ACTIVE";
}

function delegationRoutes(r: Router): void {
  // Delegations this user gave or received; SUPER_ADMIN sees every one in the tenant.
  r.on("GET", "/approvals/delegations", null, async (call) => {
    if (isPortalUser(call.ctx)) throw new AppError("ACCESS_DENIED");
    const admin = call.ctx.roles.includes("SUPER_ADMIN");
    const rows = admin
      ? await call.repo.findMany("approval_delegations", {}, { orderBy: "CREATEDTIME", desc: true, limit: 300 })
      : [
        ...await call.repo.findMany("approval_delegations", { delegator_user_id: call.ctx.userId }, { limit: 300 }),
        ...await call.repo.findMany("approval_delegations", { delegate_user_id: call.ctx.userId }, { limit: 300 }),
      ];
    const people = await staffDirectory(call);
    const person = (id: unknown) => { const p = people.get(String(id)); return p ? { ROWID: p.ROWID, name: p.name, email: p.email } : null; };
    return rows
      .sort((a, b) => String(b.starts_at).localeCompare(String(a.starts_at)))
      .map((d) => ({ ...d, state: delegationState(d, call.now), delegator: person(d.delegator_user_id), delegate: person(d.delegate_user_id) }));
  });

  // People an approval can be handed to: active staff other than the caller.
  r.on("GET", "/approvals/delegates", null, async (call) => {
    if (isPortalUser(call.ctx)) throw new AppError("ACCESS_DENIED");
    const people = await staffDirectory(call);
    return [...people.values()]
      .filter((p) => p.active && p.ROWID !== call.ctx.userId && !PORTAL_ROLES.includes(p.role))
      .map(({ active: _active, ...p }) => p)
      .sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));
  });

  // A person can hand over only an approver role they hold themselves, for a bounded window.
  r.on("POST", "/approvals/delegations", null, async (call) => {
    const body = parse(delegationSchema, call.body);
    if (!call.ctx.roles.includes(body.role)) throw new AppError("APPROVAL_NOT_ALLOWED", `You can only delegate a role you hold. You don't hold ${body.role}.`);
    const starts = new Date(body.starts_at), ends = new Date(body.ends_at);
    if (ends <= starts) throw new AppError("VALIDATION_FAILED", "The end must be after the start.", { ends_at: "must be after the start" });
    if (ends <= call.now) throw new AppError("VALIDATION_FAILED", "The end is already past.", { ends_at: "must be in the future" });
    if (ends.getTime() - starts.getTime() > MAX_DELEGATION_DAYS * 86_400_000) {
      throw new AppError("VALIDATION_FAILED", `A delegation can last at most ${MAX_DELEGATION_DAYS} days.`, { ends_at: `at most ${MAX_DELEGATION_DAYS} days` });
    }
    if (body.delegate_user_id === call.ctx.userId) throw new AppError("VALIDATION_FAILED", "Choose someone other than yourself.", { delegate_user_id: "cannot be yourself" });
    const delegate = (await staffDirectory(call)).get(body.delegate_user_id);
    if (!delegate || !delegate.active || PORTAL_ROLES.includes(delegate.role)) {
      throw new AppError("VALIDATION_FAILED", "The delegate must be an active staff user.", { delegate_user_id: "not an active staff user" });
    }
    const mine = await call.repo.findMany("approval_delegations", { delegator_user_id: call.ctx.userId, role: body.role, status: "ACTIVE" });
    const overlap = mine.find((d) => new Date(String(d.starts_at)) < ends && starts < new Date(String(d.ends_at)));
    if (overlap) throw new AppError("VALIDATION_FAILED", "You already have a delegation for this role in that period. Revoke it first.", { starts_at: "overlaps another delegation" });
    const row = await call.repo.insert("approval_delegations", {
      delegator_user_id: call.ctx.userId, delegate_user_id: body.delegate_user_id, role: body.role,
      starts_at: starts.toISOString(), ends_at: ends.toISOString(), status: "ACTIVE",
    });
    await logActivity(call.store, call.ctx, { entityType: "approval_delegation", entityId: String(row.ROWID), action: "create", metadata: { role: body.role, delegate_user_id: body.delegate_user_id, starts_at: row.starts_at, ends_at: row.ends_at } });
    return { ...row, state: delegationState(row, call.now) };
  }, 201);

  // The delegator ends it early; SUPER_ADMIN can end any.
  r.on("POST", "/approvals/delegations/:id/revoke", null, async (call) => {
    const d = await mustGet(call.repo, "approval_delegations", call.params.id, "NOT_FOUND");
    if (String(d.delegator_user_id) !== call.ctx.userId && !call.ctx.roles.includes("SUPER_ADMIN")) throw new AppError("ACCESS_DENIED");
    if (d.status !== "ACTIVE") return { ...d, state: delegationState(d, call.now) };
    const row = await call.repo.update("approval_delegations", call.params.id, { status: "REVOKED" });
    await logActivity(call.store, call.ctx, { entityType: "approval_delegation", entityId: call.params.id, action: "revoke" });
    return { ...row, state: "REVOKED" };
  });
}

export function approvalRoutes(r: Router): void {
  // Registered first: /approvals/delegations must not be read as /approvals/:id.
  delegationRoutes(r);
  // Inbox: pending approvals whose current step this user can act on, directly or by delegation.
  r.on("GET", "/approvals", null, async (call) => {
    const q = parse(page.extend({ scope: z.enum(["mine", "all"]).default("mine") }), call.query);
    const pending = await call.repo.findMany("approval_instances", { status: "PENDING" }, { orderBy: "step_due_at", limit: 300 });
    const roles = new Set([...call.ctx.roles, ...(await delegatedRoles(call))]);
    const all = q.scope === "all" && (call.ctx.roles.includes("SUPER_ADMIN") || call.ctx.roles.includes("FRANCHISE_DIRECTOR"));
    const shown = pending
      .map((i) => ({ ...i, current: currentStep(i), overdue: new Date(String(i.step_due_at)) < call.now }))
      // SUPER_ADMIN can decide any step (audited override), so every pending approval is theirs.
      .filter((i) => all || call.ctx.roles.includes("SUPER_ADMIN") || (i.current && roles.has(i.current.approver_role)))
      .slice(q.offset, q.offset + q.limit);
    // The record being decided, so the inbox can name it.
    return Promise.all(shown.map(async (i: Row) => {
      const entity = i.entity_type === "application" ? await call.repo.findOne("franchise_applications", { ROWID: String(i.entity_id) }) : null;
      return { ...i, entity: entity && { ROWID: entity.ROWID, code: entity.application_code, city: entity.preferred_city, status: entity.status, franchisee_id: entity.franchisee_id } };
    }));
  });

  r.on("GET", "/approvals/:id", null, async (call) => {
    const instance = await mustGet(call.repo, "approval_instances", call.params.id, "APPROVAL_NOT_FOUND");
    const steps = JSON.parse(String(instance.steps_json)) as PinnedStep[];
    const roles = new Set([...call.ctx.roles, ...(await delegatedRoles(call))]);
    const privileged = call.ctx.roles.includes("SUPER_ADMIN") || call.ctx.roles.includes("FRANCHISE_DIRECTOR");
    if (!privileged && !steps.some((s) => roles.has(s.approver_role))) throw new AppError("APPROVAL_NOT_FOUND");
    const actions = await call.repo.findMany("approval_actions", { approval_id: call.params.id }, { orderBy: "acted_at" });
    return { ...instance, steps, current: currentStep(instance), actions };
  });

  r.on("POST", "/approvals/:id/approve", null, (call) => act(call, "APPROVE"));
  r.on("POST", "/approvals/:id/reject", null, (call) => act(call, "REJECT"));
  r.on("POST", "/approvals/:id/return", null, (call) => act(call, "RETURN"));
}

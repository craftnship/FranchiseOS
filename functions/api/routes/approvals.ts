import { z } from "zod";
import { AppError } from "../../common/errors";
import { Row } from "../../common/store";
import { toNum } from "../../common/values";
import { actOnApproval, ApprovalAction, PinnedStep } from "../../workflows/approvals";
import { transitionEntity } from "../../workflows/transition";
import { Call, page, parse, Router } from "../router";
import { mustGet } from "./shared";

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
      store: call.store, permissions: async () => new Set(["system.approval", "application.reject"]),
    });
  }
  return { outcome, approval: instance, entity };
}

export function approvalRoutes(r: Router): void {
  // Inbox: pending approvals whose current step this user can act on, directly or by delegation.
  r.on("GET", "/approvals", null, async (call) => {
    const q = parse(page.extend({ scope: z.enum(["mine", "all"]).default("mine") }), call.query);
    const pending = await call.repo.findMany("approval_instances", { status: "PENDING" }, { orderBy: "step_due_at", limit: 300 });
    const roles = new Set([...call.ctx.roles, ...(await delegatedRoles(call))]);
    const all = q.scope === "all" && (call.ctx.roles.includes("SUPER_ADMIN") || call.ctx.roles.includes("FRANCHISE_DIRECTOR"));
    return pending
      .map((i) => ({ ...i, current: currentStep(i), overdue: new Date(String(i.step_due_at)) < call.now }))
      .filter((i) => all || (i.current && roles.has(i.current.approver_role)))
      .slice(q.offset, q.offset + q.limit);
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

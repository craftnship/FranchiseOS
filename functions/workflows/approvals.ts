import { AppError } from "../common/errors";
import { TenantContext } from "../common/context";
import { DuplicateKeyError, Row, Store, TenantRepo } from "../common/store";
import { logActivity } from "../common/audit";
import { toBool, toNum } from "../common/values";
import { evaluate, parseCondition } from "./conditions";

// Approval engine (spec §19, §41). Workflows, approver roles, SLAs and escalation are data.

export interface PinnedStep {
  step_id: string;
  sequence: number;
  approver_role: string;
  sla_hours: number;
  escalation_role: string | null;
  mandatory: boolean;
}

export type ApprovalAction = "APPROVE" | "REJECT" | "RETURN";
export type ApprovalOutcome = "ADVANCED" | "APPROVED" | "REJECTED" | "RETURNED";

function steps(instance: Row): PinnedStep[] {
  return JSON.parse(String(instance.steps_json)) as PinnedStep[];
}

/**
 * Starts an approval. Applicable steps are resolved once and pinned on the instance with the
 * workflow version, so later configuration changes do not affect it (§29, FOS-031).
 */
export async function startApproval(
  store: Store,
  ctx: TenantContext,
  args: { entityType: string; entityId: string; workflowCode: string; facts: Record<string, unknown>; now?: Date },
): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const versions = await repo.findMany("approval_workflows", { code: args.workflowCode, status: "ACTIVE" }, { orderBy: "version", desc: true, limit: 1 });
  const workflow = versions[0];
  if (!workflow) throw new AppError("APPROVAL_NOT_FOUND", `No active workflow ${args.workflowCode}.`);

  const allSteps = await store.findMany("approval_workflow_steps", { workflow_id: String(workflow.ROWID) }, { orderBy: "sequence" });
  const pinned: PinnedStep[] = allSteps
    .filter((s) => toBool(s.mandatory) || evaluate(parseCondition(s.condition_json), args.facts))
    .map((s) => ({
      step_id: String(s.ROWID),
      sequence: toNum(s.sequence),
      approver_role: String(s.approver_role),
      sla_hours: toNum(s.sla_hours),
      escalation_role: (s.escalation_role as string) || null,
      mandatory: toBool(s.mandatory),
    }))
    .sort((a, b) => a.sequence - b.sequence);
  if (!pinned.length) throw new AppError("VALIDATION_FAILED", "Workflow resolved to no steps.");

  const now = args.now ?? new Date();
  let instance: Row;
  try {
    instance = await repo.insert("approval_instances", {
      entity_type: args.entityType,
      entity_id: args.entityId,
      workflow_id: String(workflow.ROWID),
      workflow_version: toNum(workflow.version),
      steps_json: JSON.stringify(pinned),
      current_step: pinned[0].sequence,
      step_due_at: new Date(now.getTime() + pinned[0].sla_hours * 3600_000).toISOString(),
      status: "PENDING",
      // Unique while pending: one live approval per entity.
      active_key: `${ctx.tenantId}:${args.entityType}:${args.entityId}`,
      started_at: now.toISOString(),
    });
  } catch (e) {
    if (e instanceof DuplicateKeyError) throw new AppError("APPROVAL_NOT_ALLOWED", "An approval is already running for this record.");
    throw e;
  }
  await logActivity(store, ctx, { entityType: args.entityType, entityId: args.entityId, action: "approval:start", metadata: { approval_id: instance.ROWID, version: workflow.version } });
  return instance;
}

/** True if the actor holds the role directly or through an active delegation (FOS-043). */
async function canActAs(store: Store, ctx: TenantContext, role: string, now: Date): Promise<boolean> {
  if (ctx.roles.includes(role)) return true;
  const delegations = await store.findMany("approval_delegations", { tenant_id: ctx.tenantId, delegate_user_id: ctx.userId, role, status: "ACTIVE" });
  return delegations.some((d) => new Date(String(d.starts_at)) <= now && now <= new Date(String(d.ends_at)));
}

/** Approve / reject / return on the current step. Only the current authorised approver can act (FOS-034). */
export async function actOnApproval(
  store: Store,
  ctx: TenantContext,
  args: { approvalId: string; action: ApprovalAction; stepSequence: number; comments?: string; now?: Date },
): Promise<{ outcome: ApprovalOutcome; instance: Row }> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const now = args.now ?? new Date();
  const instance = await repo.findOne("approval_instances", { ROWID: args.approvalId });
  if (!instance) throw new AppError("APPROVAL_NOT_FOUND");
  if (instance.status !== "PENDING") throw new AppError("APPROVAL_ALREADY_COMPLETED");
  // Replay of an action aimed at an earlier step (§29) is rejected.
  if (toNum(instance.current_step) !== args.stepSequence) throw new AppError("APPROVAL_ALREADY_COMPLETED", "That step has already been decided.");
  if ((args.action === "REJECT" || args.action === "RETURN") && !args.comments?.trim()) {
    throw new AppError("VALIDATION_FAILED", "A comment is required.", { comments: "required" });
  }

  const pinned = steps(instance);
  const idx = pinned.findIndex((s) => s.sequence === args.stepSequence);
  const step = pinned[idx];
  if (!(await canActAs(store, ctx, step.approver_role, now))) throw new AppError("APPROVAL_NOT_ALLOWED");

  try {
    // Unique per (approval, step): a concurrent second click cannot record two decisions.
    await store.insert("approval_actions", {
      tenant_id: ctx.tenantId,
      approval_id: args.approvalId,
      step_id: step.step_id,
      actor_user_id: ctx.userId,
      action: args.action,
      comments: args.comments ?? "",
      acted_at: now.toISOString(),
      action_key: `${args.approvalId}:${step.sequence}`,
    });
  } catch (e) {
    if (e instanceof DuplicateKeyError) throw new AppError("APPROVAL_ALREADY_COMPLETED");
    throw e;
  }

  let outcome: ApprovalOutcome;
  let patch: Row;
  const next = pinned[idx + 1];
  if (args.action === "APPROVE" && next) {
    outcome = "ADVANCED";
    patch = { current_step: next.sequence, step_due_at: new Date(now.getTime() + next.sla_hours * 3600_000).toISOString(), escalated: false };
  } else {
    outcome = args.action === "APPROVE" ? "APPROVED" : args.action === "REJECT" ? "REJECTED" : "RETURNED";
    patch = { status: outcome, completed_at: now.toISOString(), active_key: `closed:${args.approvalId}` };
  }
  const updated = await repo.update("approval_instances", args.approvalId, patch);
  await logActivity(store, ctx, { entityType: String(instance.entity_type), entityId: String(instance.entity_id), action: `approval:${args.action.toLowerCase()}`, metadata: { approval_id: args.approvalId, step: step.sequence, outcome } });
  return { outcome, instance: updated };
}

/** SLA sweep for job_approval_sla (D-19): pending steps past due get escalated once. */
export async function findOverdueSteps(store: Store, tenantId: string, now: Date): Promise<Array<{ instance: Row; step: PinnedStep }>> {
  const pending = await store.findMany("approval_instances", { tenant_id: tenantId, status: "PENDING" });
  return pending
    .filter((i) => !toBool(i.escalated) && new Date(String(i.step_due_at)) < now)
    .map((i) => ({ instance: i, step: steps(i).find((s) => s.sequence === toNum(i.current_step))! }));
}

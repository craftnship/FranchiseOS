import { z } from "zod";
import { AppError } from "../../common/errors";
import { authorize, isPortalUser } from "../../common/rbac";
import { addLaunchTask, changeLaunchTask, changeRenewal, LAUNCH_OWNERS, launchFor, networkLaunches, planLaunch, recordWeek, RENEWAL_STATUSES, renewalsDue } from "../../workflows/launch";
import { Call, parse, Router } from "../router";
import { assertOwner, mustGet } from "./shared";

// Opening day. project.write sets the grand-opening day and runs the plan; the franchisee ticks off
// their own launch tasks and reports weekly sales for the first weeks. agreement.write tracks renewals.

const text = (max: number) => z.string().trim().max(max);
const day = z.string().date();
const planSchema = z.object({ grand_opening_date: day }).strict();
const taskSchema = z.object({ item: text(200).min(3), owner: z.enum(LAUNCH_OWNERS), due_date: day }).strict();
const taskChangeSchema = z.object({ action: z.enum(["done", "skip", "reopen"]), note: text(1000).nullish(), due_date: day.nullish() }).strict();
const weekSchema = z.object({ net_sales: z.number().min(0).max(1e11), transactions: z.number().int().min(0).max(1e8).nullish() }).strict();
const renewalSchema = z.object({ status: z.enum(RENEWAL_STATUSES), note: text(2000).nullish(), renewed_until: day.nullish() }).strict();

const today = (call: Call) => call.now.toISOString().slice(0, 10);
const getProject = async (call: Call) => assertOwner(call, await mustGet(call.repo, "franchise_projects", call.params.id, "NOT_FOUND"), "NOT_FOUND");
/** The franchisee acts on their own store; staff need project.write. */
const portalOrWrite = async (call: Call) => { if (!isPortalUser(call.ctx)) await authorize(call.ctx, "project.write", call.permissions); };

export function launchRoutes(r: Router): void {
  r.on("GET", "/projects/:id/launch", null, async (call) => launchFor(call.store, call.ctx, await getProject(call), today(call)));

  r.on("PATCH", "/projects/:id/launch", "project.write", async (call) => {
    const b = parse(planSchema, call.body);
    return planLaunch(call.store, call.ctx, await getProject(call), b.grand_opening_date);
  });

  r.on("POST", "/projects/:id/launch/tasks", "project.write", async (call) => addLaunchTask(call.store, call.ctx, await getProject(call), parse(taskSchema, call.body)), 201);

  r.on("PATCH", "/launch-tasks/:taskId", null, async (call) => {
    const task = assertOwner(call, await mustGet(call.repo, "launch_tasks", call.params.taskId, "NOT_FOUND"), "NOT_FOUND");
    await portalOrWrite(call);
    const b = parse(taskChangeSchema, call.body);
    if (b.due_date && b.due_date < today(call)) throw new AppError("VALIDATION_FAILED", "The date can't be in the past.", { due_date: "in the past" });
    return changeLaunchTask(call.store, call.ctx, task, b, isPortalUser(call.ctx), call.now);
  });

  r.on("PATCH", "/projects/:id/launch/weeks/:week", null, async (call) => {
    const project = await getProject(call);
    await portalOrWrite(call);
    const week = Number(call.params.week);
    if (!Number.isInteger(week)) throw new AppError("VALIDATION_FAILED", "Week must be a number.", { week_no: "not a number" });
    return recordWeek(call.store, call.ctx, project, { week_no: week, ...parse(weekSchema, call.body) }, isPortalUser(call.ctx), call.now);
  });

  r.on("GET", "/launches", "dashboard.view", async (call) => networkLaunches(call.store, call.ctx, today(call)));

  r.on("GET", "/renewals", "dashboard.view", async (call) => {
    const months = Number(call.query.months ?? 18);
    return renewalsDue(call.store, call.ctx, today(call), Number.isFinite(months) && months > 0 && months <= 60 ? months : 18);
  });

  r.on("PATCH", "/agreements/:id/renewal", "agreement.write", async (call) => {
    const agreement = await mustGet(call.repo, "agreements", call.params.id, "NOT_FOUND");
    return changeRenewal(call.store, call.ctx, agreement, parse(renewalSchema, call.body), call.now);
  });
}

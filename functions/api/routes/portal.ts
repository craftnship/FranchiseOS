import { AppError } from "../../common/errors";
import { Row } from "../../common/store";
import { computeReadiness } from "../../workflows/readiness";
import { Router } from "../router";
import { FUNNEL } from "./dashboards";

// Franchisee portal home (spec §25, plan Step 6.3): the signed-in franchisee's own application, site,
// agreement and project, plus the one next action. Other portal pages use the shared list routes,
// which already filter portal users to their own records.

export interface NextAction { owner: "you" | "us"; title: string; detail?: string; path?: string }

const CLOSED = ["REJECTED", "WITHDRAWN"];

export function nextAction(app: Row | null, extra: { blockers?: number; overdue?: number } = {}): NextAction {
  if (!app) return { owner: "you", title: "Start your franchise application", path: "/portal/application" };
  switch (String(app.status)) {
    case "DRAFT": return { owner: "you", title: "Complete and submit your application", detail: "Upload your documents, then submit.", path: "/portal/application" };
    case "SUBMITTED": case "UNDER_REVIEW": case "QUALIFIED": return { owner: "us", title: "We are reviewing your application" };
    case "SITE_REQUIRED": return { owner: "you", title: "Propose a site for your store", path: "/portal/site" };
    case "SITE_SUBMITTED": case "FEASIBILITY_REVIEW": case "APPROVAL_PENDING": return { owner: "us", title: "We are evaluating your site" };
    case "APPROVED": return { owner: "us", title: "Your franchise agreement is being prepared" };
    case "AGREEMENT_PENDING": return { owner: "you", title: "Sign your franchise agreement", detail: "Check your email for the Zoho Sign request.", path: "/portal/agreement" };
    case "AGREEMENT_SIGNED": case "ONBOARDING": case "ACTIVE":
      if (extra.blockers) return { owner: "you", title: `Clear ${extra.blockers} blocked or overdue opening task${extra.blockers > 1 ? "s" : ""}`, path: "/portal/tasks" };
      return { owner: "you", title: "Work through your opening tasks", detail: extra.overdue ? `${extra.overdue} task(s) are overdue.` : undefined, path: "/portal/tasks" };
    case "ON_HOLD": return { owner: "us", title: "Your application is on hold", detail: "Your franchise manager will be in touch." };
    default: return { owner: "us", title: CLOSED.includes(String(app.status)) ? "This application is closed" : "No action needed right now" };
  }
}

export function portalRoutes(r: Router): void {
  r.on("GET", "/portal/home", "portal.view", async (call) => {
    const franchiseeId = call.ctx.franchiseeId;
    if (!franchiseeId) throw new AppError("ACCESS_DENIED", "Portal user is not linked to a franchisee.");
    const own = { franchisee_id: franchiseeId };
    const [franchisee, apps, sites, agreements, projects] = await Promise.all([
      call.repo.findOne("franchisees", { ROWID: franchiseeId }),
      call.repo.findMany("franchise_applications", own, { orderBy: "CREATEDTIME", desc: true, limit: 20 }),
      call.repo.findMany("sites", own, { orderBy: "CREATEDTIME", desc: true, limit: 5 }),
      call.repo.findMany("agreements", own, { orderBy: "CREATEDTIME", desc: true, limit: 5 }),
      call.repo.findMany("franchise_projects", own, { orderBy: "CREATEDTIME", desc: true, limit: 5 }),
    ]);
    // The application furthest along is the one the franchisee is working on.
    const open = apps.filter((a) => !CLOSED.includes(String(a.status))).sort((a, b) => FUNNEL.indexOf(String(b.status)) - FUNNEL.indexOf(String(a.status)));
    const application = open[0] ?? apps[0] ?? null;
    const project = application ? projects.find((p) => p.application_id === application.ROWID) ?? null : null;
    const today = call.now.toISOString().slice(0, 10);
    const readiness = project ? await computeReadiness(call.store, call.ctx, String(project.ROWID), today) : null;
    const tasks = project
      ? (await call.repo.findMany("opening_checklists", { project_id: String(project.ROWID) }, { orderBy: "due_date", limit: 300 })).filter((t) => t.status !== "COMPLETED").slice(0, 5)
      : [];
    return {
      franchisee,
      application,
      site: application ? sites.find((s) => s.application_id === application.ROWID) ?? null : null,
      agreement: application ? agreements.find((a) => a.application_id === application.ROWID) ?? null : null,
      project: project && readiness ? { ...project, readiness: { score: readiness.score, rag: readiness.rag, blockers: readiness.blockers.length, overdue: readiness.overdue.length } } : project,
      upcoming_tasks: tasks,
      next_action: nextAction(application, { blockers: readiness?.blockers.length, overdue: readiness?.overdue.length }),
    };
  });
}

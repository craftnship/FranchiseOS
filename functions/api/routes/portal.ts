import { z } from "zod";
import { AppError } from "../../common/errors";
import { authorize, isPortalUser } from "../../common/rbac";
import { Row } from "../../common/store";
import { brandDocuments, conversation, DOC_CATEGORIES, inbox, ownRecords, portalLogins, portalTodo, sendMessage, shareDocument } from "../../workflows/portalHub";
import { mustGet, signedUrl, storeUpload, uploadSchema } from "./shared";
import { computeReadiness } from "../../workflows/readiness";
import { Call, parse, Router } from "../router";
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
    // A franchisee with several stores picks one; the default is the application furthest along.
    const picked = call.query?.project_id ? projects.find((p) => String(p.ROWID) === String(call.query!.project_id)) ?? null : null;
    const application = (picked && apps.find((a) => a.ROWID === picked.application_id)) || open[0] || apps[0] || null;
    const project = picked ?? (application ? projects.find((p) => p.application_id === application.ROWID) ?? null : null);
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
      stores: projects.map((p) => ({ ROWID: p.ROWID, project_code: p.project_code, status: p.status })),
      next_action: nextAction(application, { blockers: readiness?.blockers.length, overdue: readiness?.overdue.length }),
    };
  });
}

const text = (max: number) => z.string().trim().max(max);
const contextSchema = z.object({ type: z.enum(["APPLICATION", "AGREEMENT", "PROJECT"]), id: z.string().min(1) }).strict();
// project_id is the older shape of "about this store"; context covers applications and agreements too.
const messageSchema = z.object({ text: text(4000).min(1), context: contextSchema.nullish(), project_id: z.string().min(1).nullish(), attachment: uploadSchema.optional() }).strict();
const contextOf = (b: z.infer<typeof messageSchema>) => b.context ?? (b.project_id ? { type: "PROJECT" as const, id: b.project_id } : null);
const documentSchema = z.object({ title: text(160).min(2), category: z.enum(DOC_CATEGORIES), notes: text(1000).nullish(), franchisee_id: z.string().min(1).nullish(), file: uploadSchema }).strict();
const today = (call: Call) => call.now.toISOString().slice(0, 10);
const mine = (call: Call): string => {
  if (!call.ctx.franchiseeId) throw new AppError("ACCESS_DENIED", "Portal user is not linked to a franchisee.");
  return String(call.ctx.franchiseeId);
};

/** Portal v2: the to-do list, documents and messages. Staff see the library and every conversation. */
export function portalHubRoutes(r: Router): void {
  r.on("GET", "/portal/todo", "portal.view", async (call) => portalTodo(call.store, call.ctx, mine(call), today(call)));

  r.on("GET", "/portal/documents", "portal.view", async (call) => {
    const fid = mine(call);
    return { library: await brandDocuments(call.repo, fid), records: await ownRecords(call.repo, fid) };
  });
  r.on("GET", "/documents", "dashboard.view", async (call) => brandDocuments(call.repo, null));
  r.on("POST", "/documents", "document.share", async (call) => {
    const b = parse(documentSchema, call.body);
    const file_ref = await storeUpload(call, "documents", b.file);
    return shareDocument(call.store, call.ctx, { title: b.title, category: b.category, notes: b.notes ?? null, franchisee_id: b.franchisee_id ?? null, file_ref }, call.now);
  }, 201);
  r.on("PATCH", "/documents/:docId", "document.share", async (call) => {
    parse(z.object({ action: z.literal("archive") }).strict(), call.body);
    const doc = await mustGet(call.repo, "brand_documents", call.params.docId, "NOT_FOUND");
    return call.repo.update("brand_documents", String(doc.ROWID), { status: "ARCHIVED" });
  });
  r.on("GET", "/documents/:docId/file", null, async (call) => {
    const doc = await mustGet(call.repo, "brand_documents", call.params.docId, "NOT_FOUND");
    if (isPortalUser(call.ctx) ? doc.status !== "ACTIVE" || (doc.franchisee_id && String(doc.franchisee_id) !== String(call.ctx.franchiseeId)) : false) throw new AppError("NOT_FOUND");
    return signedUrl(call, String(doc.file_ref ?? ""), "No file attached.");
  });

  r.on("GET", "/portal/messages", "portal.view", async (call) => conversation(call.store, call.ctx, mine(call), "FRANCHISEE", call.now));
  r.on("POST", "/portal/messages", "portal.view", async (call) => {
    const fid = mine(call), b = parse(messageSchema, call.body);
    const attachment_ref = b.attachment ? await storeUpload(call, `messages/${fid}`, b.attachment) : null;
    return sendMessage(call.store, call.ctx, fid, "FRANCHISEE", { text: b.text, context: contextOf(b), attachment_ref }, call.now);
  }, 201);
  r.on("GET", "/messages", "dashboard.view", async (call) => inbox(call.store, call.ctx));
  r.on("GET", "/franchisees/:id/messages", "dashboard.view", async (call) => {
    const f = await mustGet(call.repo, "franchisees", call.params.id, "NOT_FOUND");
    const portal_users = (await portalLogins(call.repo, String(f.ROWID))).length;
    return { franchisee: { ROWID: f.ROWID, display_name: f.display_name, franchise_code: f.franchise_code, email: f.email ?? null, portal_users }, ...await conversation(call.store, call.ctx, String(f.ROWID), "BRAND", call.now) };
  });
  r.on("POST", "/franchisees/:id/messages", "dashboard.view", async (call) => {
    const f = await mustGet(call.repo, "franchisees", call.params.id, "NOT_FOUND"), b = parse(messageSchema, call.body);
    const attachment_ref = b.attachment ? await storeUpload(call, `messages/${f.ROWID}`, b.attachment) : null;
    return sendMessage(call.store, call.ctx, String(f.ROWID), "BRAND", { text: b.text, context: contextOf(b), attachment_ref }, call.now);
  }, 201);
  r.on("GET", "/messages/:msgId/attachment", null, async (call) => {
    const m = await mustGet(call.repo, "messages", call.params.msgId, "NOT_FOUND");
    if (isPortalUser(call.ctx) && String(m.franchisee_id) !== String(call.ctx.franchiseeId)) throw new AppError("NOT_FOUND");
    if (!isPortalUser(call.ctx)) await authorize(call.ctx, "dashboard.view", call.permissions);
    return signedUrl(call, String(m.attachment_ref ?? ""), "No attachment.");
  });
}

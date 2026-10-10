import { Mailer, TenantContext } from "../common/context";
import { log } from "../common/logger";
import { DuplicateKeyError, Row, Store, TenantRepo } from "../common/store";
import { toBool, toNum } from "../common/values";
import { expireLicences, renewDays } from "./licences";

// Notifications (spec §23): an in-app inbox per user, copied by email when a mailer is configured.
// Events come from the activity log (notifyFromActivity), so every path that records an action,
// whether API, webhook or job, alerts the same people. Daily reminders come from runReminderJob.

export type { Mailer };

export interface Notice {
  kind: string;
  title: string;
  body?: string;
  /** App route, e.g. /projects/123. */
  link?: string;
  entityType: string;
  entityId: string;
  /** Everyone active in these roles (and their active delegates when `delegates`). */
  roles?: string[];
  userIds?: string[];
  delegates?: boolean;
  /** Same key, same person: delivered once. Reminders use it so a daily run does not repeat them. */
  dedupe?: string;
}

const DEFAULT_APP_URL = "https://franchiseos-60082871087.development.catalystserverless.in/app/";

/** "1 Oct 2026" for a date or ISO string. */
const nice = (d: unknown) => {
  const t = Date.parse(String(d).length === 10 ? `${d}T00:00:00Z` : String(d));
  return Number.isNaN(t) ? String(d ?? "") : new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
};

const human = (code: string) => code.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

/** Active users of the tenant holding any of `roles`. */
export async function usersInRoles(store: Store, tenantId: string, roles: string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (const code of new Set(roles)) {
    const role = await store.findOne("roles", { tenant_code_key: `${tenantId}:ROLE:${code}` });
    if (role) out.push(...await store.findMany("users", { tenant_id: tenantId, role_id: String(role.ROWID), status: "ACTIVE" }));
  }
  return out;
}

/** Portal users of a franchisee, so the franchisee hears about their own store. */
async function portalUsers(store: Store, tenantId: string, franchiseeId: unknown): Promise<string[]> {
  if (!franchiseeId) return [];
  return (await store.findMany("users", { tenant_id: tenantId, franchisee_id: String(franchiseeId), status: "ACTIVE" })).map((u) => String(u.ROWID));
}

async function recipients(store: Store, ctx: TenantContext, n: Notice, now: Date): Promise<Row[]> {
  const byId = new Map<string, Row>();
  const roles = n.roles ?? [];
  for (const u of await usersInRoles(store, ctx.tenantId, roles)) byId.set(String(u.ROWID), u);
  if (n.delegates && roles.length) {
    for (const role of roles) {
      for (const d of await store.findMany("approval_delegations", { tenant_id: ctx.tenantId, role, status: "ACTIVE" })) {
        if (new Date(String(d.starts_at)) > now || now > new Date(String(d.ends_at))) continue;
        const u = await store.findOne("users", { ROWID: String(d.delegate_user_id), tenant_id: ctx.tenantId, status: "ACTIVE" });
        if (u) byId.set(String(u.ROWID), u);
      }
    }
  }
  // Nobody holds the role yet: the tenant's super admins hear about it instead of no one.
  if (roles.length && !byId.size) for (const u of await usersInRoles(store, ctx.tenantId, ["SUPER_ADMIN"])) byId.set(String(u.ROWID), u);
  for (const id of n.userIds ?? []) {
    if (!id || byId.has(id)) continue;
    const u = await store.findOne("users", { ROWID: id, tenant_id: ctx.tenantId, status: "ACTIVE" });
    if (u) byId.set(id, u);
  }
  // The person who acted already knows.
  byId.delete(ctx.userId);
  return [...byId.values()];
}

function emailOf(n: Notice, appUrl: string) {
  const url = n.link ? `${appUrl.replace(/\/?$/, "/")}#${n.link}` : appUrl;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1f2933;max-width:560px">
<p style="font-size:16px;font-weight:600;margin:0 0 8px">${esc(n.title)}</p>
${n.body ? `<p style="margin:0 0 16px">${esc(n.body)}</p>` : ""}
<p style="margin:0 0 24px"><a href="${esc(url)}" style="background:#2557d6;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">Open in FranchiseOS</a></p>
<p style="font-size:12px;color:#6b7785;margin:0">You get this because of your role in FranchiseOS.</p></div>`;
  return { subject: n.title, html, text: `${n.title}\n\n${n.body ?? ""}\n\n${url}` };
}

/**
 * Delivers a notice to each recipient once: an inbox row, then an email when the context has a
 * mailer and the tenant has not turned email off. Never throws; a failure is logged.
 */
export async function deliver(store: Store, ctx: TenantContext, n: Notice, now = new Date()): Promise<number> {
  try {
    const people = await recipients(store, ctx, n, now);
    if (!people.length) return 0;
    const tenant = await store.findOne("tenants", { ROWID: ctx.tenantId });
    const settings = (() => { try { return JSON.parse(String(tenant?.settings_json ?? "{}")); } catch { return {}; } })();
    const emailOn = !!ctx.mailer && settings.notify_email !== false;
    const appUrl = String(settings.app_url ?? process.env.FOS_APP_URL ?? DEFAULT_APP_URL);
    let delivered = 0;
    for (const u of people) {
      const uid = String(u.ROWID);
      let row: Row;
      try {
        row = await store.insert("notifications", {
          tenant_id: ctx.tenantId, recipient_user_id: uid, channel: "IN_APP", template_code: n.kind,
          entity_type: n.entityType, entity_id: n.entityId, title: n.title.slice(0, 250), body: n.body ?? null, link: n.link ?? null,
          status: "UNREAD", created_at: now.toISOString(),
          dedupe_key: n.dedupe ? `${ctx.tenantId}:${n.dedupe}:${uid}` : `${ctx.tenantId}:${n.kind}:${n.entityId}:${uid}:${now.getTime()}:${Math.random().toString(36).slice(2, 8)}`,
        });
      } catch (e) {
        if (e instanceof DuplicateKeyError) continue;
        throw e;
      }
      delivered++;
      if (!emailOn || !u.email) continue;
      try {
        await ctx.mailer!.send({ to: String(u.email), ...emailOf(n, appUrl) });
        await store.update("notifications", String(row.ROWID), { sent_at: new Date().toISOString(), channel: "IN_APP,EMAIL" });
      } catch (e) {
        log("warn", "notify.email_failed", { tenant_id: ctx.tenantId, request_id: ctx.requestId, kind: n.kind, error: String((e as Error)?.message ?? e).slice(0, 300) });
      }
    }
    return delivered;
  } catch (e) {
    log("warn", "notify.failed", { tenant_id: ctx.tenantId, request_id: ctx.requestId, kind: n.kind, error: String((e as Error)?.message ?? e).slice(0, 300) });
    return 0;
  }
}

// ---- Events from the activity log -------------------------------------------------------------

type Entry = { entityType: string; entityId: string; action: string; metadata?: Record<string, unknown> };
type Rule = (store: Store, ctx: TenantContext, e: Entry, repo: TenantRepo) => Promise<Notice | null>;

const CODE_FIELD: Record<string, [string, string]> = {
  application: ["franchise_applications", "application_code"],
  project: ["franchise_projects", "project_code"],
  agreement: ["agreements", "agreement_code"],
  territory: ["territories", "territory_code"],
  site: ["sites", "site_code"],
};

async function codeOf(repo: TenantRepo, entityType: string, id: string): Promise<{ code: string; row: Row | null }> {
  const f = CODE_FIELD[entityType];
  const row = f ? await repo.findOne(f[0], { ROWID: id }) : null;
  return { code: row && f ? String(row[f[1]] ?? id) : `${entityType} ${id}`, row };
}

async function franchiseeName(repo: TenantRepo, id: unknown): Promise<string> {
  const f = id ? await repo.findOne("franchisees", { ROWID: String(id) }) : null;
  return f ? String(f.legal_name || f.display_name || f.franchise_code) : "the franchisee";
}

const linkTo = (entityType: string, id: string) => (entityType === "application" ? `/applications/${id}` : entityType === "project" ? `/projects/${id}` : entityType === "agreement" ? `/agreements/${id}` : entityType === "site" ? `/sites/${id}` : "/");

const waitingApproval: Rule = async (store, ctx, e, repo) => {
  if (e.action === "approval:approve" && e.metadata?.outcome !== "ADVANCED") return null;
  const instance = await repo.findOne("approval_instances", { ROWID: String(e.metadata?.approval_id) });
  if (!instance || instance.status !== "PENDING") return null;
  const step = (JSON.parse(String(instance.steps_json)) as Array<{ sequence: number; approver_role: string }>).find((s) => s.sequence === toNum(instance.current_step));
  if (!step) return null;
  const { code } = await codeOf(repo, e.entityType, e.entityId);
  const due = new Date(String(instance.step_due_at));
  return {
    kind: "approval.waiting", entityType: e.entityType, entityId: e.entityId, roles: [step.approver_role], delegates: true,
    title: `${code} is waiting for your approval`,
    body: `Step ${step.sequence}, ${human(step.approver_role)}. Due by ${due.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}.`,
    link: "/approvals", dedupe: `approval:${instance.ROWID}:${step.sequence}`,
  };
};

const approvalDecided: Rule = async (_s, _c, e, repo) => {
  const outcome = String(e.metadata?.outcome ?? "");
  if (!["APPROVED", "REJECTED", "RETURNED"].includes(outcome)) return null;
  const { code, row } = await codeOf(repo, e.entityType, e.entityId);
  const word = outcome === "APPROVED" ? "approved" : outcome === "REJECTED" ? "rejected" : "returned for changes";
  return {
    kind: `approval.${outcome.toLowerCase()}`, entityType: e.entityType, entityId: e.entityId,
    roles: ["FRANCHISE_MANAGER"], userIds: row?.owner_user_id ? [String(row.owner_user_id)] : [],
    title: `${code} was ${word}`,
    body: outcome === "APPROVED" ? "The franchise approval chain is complete. The agreement can be sent." : "See the approval history for the approver's comment.",
    link: linkTo(e.entityType, e.entityId),
  };
};

const RULES: Record<string, Rule> = {
  "approval:start": waitingApproval,
  "approval:approve": async (s, c, e, r) => (await waitingApproval(s, c, e, r)) ?? approvalDecided(s, c, e, r),
  "approval:reject": approvalDecided,
  "approval:return": approvalDecided,
  "create:crm": async (_s, _c, e, repo) => {
    if (e.entityType !== "application") return null;
    const { code, row } = await codeOf(repo, "application", e.entityId);
    return { kind: "application.new", entityType: "application", entityId: e.entityId, roles: ["FRANCHISE_MANAGER"],
      title: `New application ${code} from CRM`, body: `${await franchiseeName(repo, row?.franchisee_id)}${row?.preferred_city ? `, ${row.preferred_city}` : ""}. Review and score it.`,
      link: linkTo("application", e.entityId) };
  },
  "agreement:signed": async (_s, _c, e, repo) => {
    const { code, row } = await codeOf(repo, "agreement", e.entityId);
    return { kind: "agreement.signed", entityType: "agreement", entityId: e.entityId, roles: ["FRANCHISE_MANAGER", "FRANCHISE_DIRECTOR", "FINANCE_MANAGER"],
      title: `${code} was signed by ${await franchiseeName(repo, row?.franchisee_id)}`, body: "Onboarding has started: CRM account, fee invoice and opening project.",
      link: linkTo("agreement", e.entityId), dedupe: `agreement-signed:${e.entityId}` };
  },
  "transition:declined": async (_s, _c, e, repo) => agreementEnded(repo, e, "declined"),
  "transition:expired": async (_s, _c, e, repo) => agreementEnded(repo, e, "expired"),
  "transition:flag_risk": async (_s, _c, e, repo) => {
    if (e.entityType !== "project") return null;
    const { code, row } = await codeOf(repo, "project", e.entityId);
    const items = await repo.findMany("opening_checklists", { project_id: e.entityId });
    const today = new Date().toISOString().slice(0, 10);
    const blocked = items.filter((i) => i.status === "BLOCKED").length;
    const overdue = items.filter((i) => i.status !== "COMPLETED" && toBool(i.mandatory) && i.due_date && String(i.due_date).slice(0, 10) < today).length;
    const parts = [blocked && `${blocked} blocked`, overdue && `${overdue} overdue`].filter(Boolean).join(" and ");
    return { kind: "project.at_risk", entityType: "project", entityId: e.entityId, roles: ["PROJECT_MANAGER", "FRANCHISE_MANAGER"],
      title: `${code} is at risk`, body: `${parts ? `Mandatory tasks: ${parts}.` : "The opening is at risk."} Target opening ${row?.target_opening_date ? nice(String(row.target_opening_date).slice(0, 10)) : "not set"}.`,
      link: linkTo("project", e.entityId) };
  },
  "transition:open": async (_s, _c, e, repo) => {
    if (e.entityType !== "project") return null;
    const { code, row } = await codeOf(repo, "project", e.entityId);
    return { kind: "project.opened", entityType: "project", entityId: e.entityId, roles: ["FRANCHISE_DIRECTOR", "FRANCHISE_MANAGER", "FINANCE_MANAGER"],
      title: `${await franchiseeName(repo, row?.franchisee_id)} opened (${code})`, body: `Opened on ${row?.actual_opening_date ? nice(String(row.actual_opening_date).slice(0, 10)) : "today"}. The franchise is now active.`,
      link: linkTo("project", e.entityId), dedupe: `project-opened:${e.entityId}` };
  },
  "fee:paid": async (_s, _c, e, repo) => {
    const { code, row } = await codeOf(repo, "agreement", e.entityId);
    return { kind: "fee.paid", entityType: "agreement", entityId: e.entityId, roles: ["FINANCE_MANAGER", "FRANCHISE_MANAGER"],
      title: `Franchise fee paid on ${code}`, body: `${await franchiseeName(repo, row?.franchisee_id)} paid invoice ${e.metadata?.invoice ?? ""}`.trim() + ".",
      link: linkTo("agreement", e.entityId), dedupe: `fee-paid:${e.entityId}` };
  },
  "fee:status": async (_s, _c, e, repo) => {
    if (e.metadata?.status !== "OVERDUE") return null;
    const { code, row } = await codeOf(repo, "agreement", e.entityId);
    return { kind: "fee.overdue", entityType: "agreement", entityId: e.entityId, roles: ["FINANCE_MANAGER", "FRANCHISE_MANAGER"],
      title: `Franchise fee overdue on ${code}`, body: `${await franchiseeName(repo, row?.franchisee_id)} owes ₹${toNum(e.metadata?.balance).toLocaleString("en-IN")} on invoice ${e.metadata?.invoice ?? ""}`.trim() + ".",
      link: linkTo("agreement", e.entityId), dedupe: `fee-overdue:${e.entityId}:${row?.fee_due_date ?? ""}` };
  },
  "territory:expired": async (_s, _c, e, repo) => {
    const { code, row } = await codeOf(repo, "territory", e.entityId);
    return { kind: "territory.expired", entityType: "territory", entityId: e.entityId, roles: ["FRANCHISE_MANAGER", "REGIONAL_MANAGER"],
      title: `Reservation on ${code} lapsed`, body: `${row?.name ?? "The territory"} is available again.`, link: "/territories" };
  },
  "licence:expired": async (store, ctx, e, repo) => {
    const l = await repo.findOne("licences", { ROWID: e.entityId });
    if (!l) return null;
    const { code } = await codeOf(repo, "project", String(l.project_id));
    return { kind: "licence.expired", entityType: "project", entityId: String(l.project_id), roles: ["PROJECT_MANAGER", "FRANCHISE_MANAGER"],
      userIds: [...(l.owner_user_id ? [String(l.owner_user_id)] : []), ...await portalUsers(store, ctx.tenantId, l.franchisee_id)],
      title: `${l.name} has expired for ${code}`, body: `It expired on ${nice(String(l.expires_on).slice(0, 10))}. Renew it and record the new expiry date.`,
      link: linkTo("project", String(l.project_id)), dedupe: `licence-expired:${l.ROWID}:${String(l.expires_on).slice(0, 10)}` };
  },
  "licence:rejected": async (store, ctx, e, repo) => {
    const l = await repo.findOne("licences", { ROWID: e.entityId });
    if (!l) return null;
    const { code } = await codeOf(repo, "project", String(l.project_id));
    return { kind: "licence.rejected", entityType: "project", entityId: String(l.project_id), roles: ["PROJECT_MANAGER"],
      userIds: await portalUsers(store, ctx.tenantId, l.franchisee_id),
      title: `${l.name} application was rejected for ${code}`, body: l.notes ? String(l.notes).slice(0, 300) : "Reapply and update the licence register.",
      link: linkTo("project", String(l.project_id)) };
  },
  "checklist:updated": async (_s, _c, e, repo) => {
    const owner = e.metadata?.owner_user_id;
    if (!owner) return null;
    const item = await repo.findOne("opening_checklists", { ROWID: e.entityId });
    const { code } = await codeOf(repo, "project", String(e.metadata?.project_id));
    return { kind: "task.assigned", entityType: "project", entityId: String(e.metadata?.project_id), userIds: [String(owner)],
      title: `You own "${item?.item ?? "a task"}" on ${code}`, body: item?.due_date ? `Due ${nice(String(item.due_date).slice(0, 10))}.` : undefined,
      link: linkTo("project", String(e.metadata?.project_id)) };
  },
};

async function agreementEnded(repo: TenantRepo, e: Entry, word: string): Promise<Notice | null> {
  if (e.entityType !== "agreement") return null;
  const { code, row } = await codeOf(repo, "agreement", e.entityId);
  return { kind: `agreement.${word}`, entityType: "agreement", entityId: e.entityId, roles: ["FRANCHISE_MANAGER", "LEGAL_MANAGER"],
    title: `${code} was ${word} by ${await franchiseeName(repo, row?.franchisee_id)}`, body: "Resend the agreement or close the application.",
    link: linkTo("agreement", e.entityId) };
}

/** Called by logActivity: turns a recorded action into a notice when a rule matches. Never throws. */
export async function notifyFromActivity(store: Store, ctx: TenantContext, entry: Entry): Promise<void> {
  const rule = RULES[entry.action];
  if (!rule || !ctx.tenantId) return;
  try {
    const notice = await rule(store, ctx, entry, new TenantRepo(store, ctx.tenantId));
    if (notice) await deliver(store, ctx, notice);
  } catch (e) {
    log("warn", "notify.rule_failed", { tenant_id: ctx.tenantId, action: entry.action, error: String((e as Error)?.message ?? e).slice(0, 300) });
  }
}

// ---- Daily reminders --------------------------------------------------------------------------

const ACTIVE_PROJECTS = ["PLANNING", "IN_PROGRESS", "AT_RISK", "READY_FOR_OPENING"];
const LAPSING_APPS = ["UNDER_REVIEW", "QUALIFIED", "SITE_REQUIRED", "ON_HOLD"];
const UNSIGNED_DAYS = 7;
const EXPIRY_WARN_DAYS = 5;
const day = (d: Date) => d.toISOString().slice(0, 10);

/** One tenant's reminders: overdue approvals (escalated once), overdue tasks, late openings, licences expiring or missing, unsigned agreements, holds about to lapse. */
export async function sendReminders(store: Store, ctx: TenantContext, now: Date) {
  const repo = new TenantRepo(store, ctx.tenantId);
  const today = day(now);
  const out = { approvals: 0, tasks: 0, openings: 0, agreements: 0, reservations: 0, licences: 0 };
  await expireLicences(store, ctx, today);

  for (const instance of await repo.findMany("approval_instances", { status: "PENDING" })) {
    if (toBool(instance.escalated) || new Date(String(instance.step_due_at)) >= now) continue;
    const step = (JSON.parse(String(instance.steps_json)) as Array<{ sequence: number; approver_role: string; escalation_role: string | null }>).find((s) => s.sequence === toNum(instance.current_step));
    if (!step) continue;
    const { code } = await codeOf(repo, String(instance.entity_type), String(instance.entity_id));
    out.approvals += await deliver(store, ctx, {
      kind: "approval.overdue", entityType: String(instance.entity_type), entityId: String(instance.entity_id),
      roles: [step.approver_role, ...(step.escalation_role ? [step.escalation_role] : [])], delegates: true,
      title: `${code} approval is overdue`, body: `Step ${step.sequence}, ${human(step.approver_role)}, was due ${nice(instance.step_due_at)}.${step.escalation_role ? ` Escalated to ${human(step.escalation_role)}.` : ""}`,
      link: "/approvals", dedupe: `approval-overdue:${instance.ROWID}:${step.sequence}`,
    }, now);
    await repo.update("approval_instances", String(instance.ROWID), { escalated: true });
  }

  for (const project of await repo.findMany("franchise_projects", {})) {
    if (!ACTIVE_PROJECTS.includes(String(project.status))) continue;
    const pid = String(project.ROWID);
    const late = (await repo.findMany("opening_checklists", { project_id: pid }))
      .filter((i) => i.status !== "COMPLETED" && i.owner_user_id && i.due_date && String(i.due_date).slice(0, 10) < today);
    const byOwner = new Map<string, Row[]>();
    for (const i of late) byOwner.set(String(i.owner_user_id), [...(byOwner.get(String(i.owner_user_id)) ?? []), i]);
    for (const [owner, items] of byOwner) {
      const names = items.slice(0, 3).map((i) => i.item).join(", ") + (items.length > 3 ? ", …" : "");
      out.tasks += await deliver(store, ctx, {
        kind: "task.overdue", entityType: "project", entityId: pid, userIds: [owner],
        title: `${items.length} task${items.length === 1 ? " is" : "s are"} overdue on ${project.project_code}`, body: `${names}.`,
        link: linkTo("project", pid), dedupe: `tasks-overdue:${pid}:${owner}:${today}`,
      }, now);
    }
    if (project.target_opening_date && String(project.target_opening_date).slice(0, 10) < today) {
      out.openings += await deliver(store, ctx, {
        kind: "project.late", entityType: "project", entityId: pid, roles: ["PROJECT_MANAGER", "FRANCHISE_MANAGER"],
        title: `${project.project_code} has passed its target opening date`, body: `Target was ${nice(String(project.target_opening_date).slice(0, 10))}. Set a new date or open the store.`,
        link: linkTo("project", pid), dedupe: `opening-late:${pid}:${String(project.target_opening_date).slice(0, 10)}`,
      }, now);
    }
  }

  // Licences: renewals coming up, and mandatory ones still missing within 30 days of opening.
  const tenant = await store.findOne("tenants", { ROWID: ctx.tenantId });
  const projectsById = new Map((await repo.findMany("franchise_projects", {})).map((p) => [String(p.ROWID), p]));
  const missingByProject = new Map<string, Row[]>();
  for (const l of await repo.findMany("licences", {})) {
    const project = projectsById.get(String(l.project_id));
    if (!project || ["CLOSED"].includes(String(project.status))) continue;
    if (l.status === "ISSUED" && l.expires_on) {
      const left = (Date.parse(`${String(l.expires_on).slice(0, 10)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
      if (left >= 0 && left <= renewDays(tenant, String(l.licence_code))) {
        out.licences += await deliver(store, ctx, {
          kind: "licence.expiring", entityType: "project", entityId: String(l.project_id), roles: ["PROJECT_MANAGER"],
          userIds: [...(l.owner_user_id ? [String(l.owner_user_id)] : []), ...await portalUsers(store, ctx.tenantId, l.franchisee_id)],
          title: `${l.name} for ${project.project_code} expires ${nice(String(l.expires_on).slice(0, 10))}`, body: `${Math.round(left)} days left. Start the renewal with ${l.authority ?? "the authority"}.`,
          link: linkTo("project", String(l.project_id)), dedupe: `licence-expiring:${l.ROWID}:${String(l.expires_on).slice(0, 10)}`,
        }, now);
      }
    }
    const target = project.target_opening_date ? String(project.target_opening_date).slice(0, 10) : null;
    const soon = target && ACTIVE_PROJECTS.includes(String(project.status)) && (Date.parse(`${target}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000 <= 30;
    if (soon && toBool(l.mandatory) && l.status !== "ISSUED") missingByProject.set(String(l.project_id), [...(missingByProject.get(String(l.project_id)) ?? []), l]);
  }
  const week = day(new Date(now.getTime() - ((now.getUTCDay() + 6) % 7) * 86_400_000));
  for (const [pid, missing] of missingByProject) {
    const project = projectsById.get(pid)!;
    out.licences += await deliver(store, ctx, {
      kind: "licence.missing", entityType: "project", entityId: pid, roles: ["PROJECT_MANAGER", "FRANCHISE_MANAGER"],
      userIds: await portalUsers(store, ctx.tenantId, project.franchisee_id),
      title: `${missing.length} mandatory licence${missing.length === 1 ? " is" : "s are"} missing for ${project.project_code}`,
      body: `${missing.map((l) => l.name).join(", ")}. The store can't open without them; target opening ${nice(String(project.target_opening_date).slice(0, 10))}.`,
      link: linkTo("project", pid), dedupe: `licences-missing:${pid}:${week}`,
    }, now);
  }

  for (const a of await repo.findMany("agreements", {})) {
    if (!["SENT", "VIEWED"].includes(String(a.status))) continue;
    const sent = await repo.findMany("activity_logs", { entity_type: "agreement", entity_id: String(a.ROWID), action: "transition:send" }, { limit: 1 });
    const sentAt = sent[0]?.created_at ? new Date(String(sent[0].created_at)) : null;
    if (!sentAt || now.getTime() - sentAt.getTime() < UNSIGNED_DAYS * 86_400_000) continue;
    out.agreements += await deliver(store, ctx, {
      kind: "agreement.unsigned", entityType: "agreement", entityId: String(a.ROWID), roles: ["FRANCHISE_MANAGER"],
      title: `${a.agreement_code} is still unsigned`, body: `Sent ${nice(sentAt.toISOString())} to ${await franchiseeName(repo, a.franchisee_id)}${a.status === "VIEWED" ? ", who has opened it" : ""}.`,
      link: linkTo("agreement", String(a.ROWID)), dedupe: `agreement-unsigned:${a.ROWID}`,
    }, now);
  }

  for (const r of await repo.findMany("territory_reservations", { status: "ACTIVE" })) {
    const left = (new Date(String(r.expires_at)).getTime() - now.getTime()) / 86_400_000;
    if (left < 0 || left > EXPIRY_WARN_DAYS) continue;
    const app = await repo.findOne("franchise_applications", { ROWID: String(r.application_id) });
    if (!app || !LAPSING_APPS.includes(String(app.status))) continue;
    const { code, row } = await codeOf(repo, "territory", String(r.territory_id));
    out.reservations += await deliver(store, ctx, {
      kind: "territory.expiring", entityType: "application", entityId: String(app.ROWID), roles: ["FRANCHISE_MANAGER", "REGIONAL_MANAGER"],
      userIds: app.owner_user_id ? [String(app.owner_user_id)] : [],
      title: `${code} hold for ${app.application_code} lapses ${nice(r.expires_at)}`, body: `${row?.name ?? "The territory"} frees up unless a site is submitted first.`,
      link: linkTo("application", String(app.ROWID)), dedupe: `territory-expiring:${r.ROWID}`,
    }, now);
  }
  return out;
}

/** job_reminders (daily): sendReminders for every active tenant; a failing tenant is logged and skipped. */
export async function runReminderJob(store: Store, opts: { now: Date; requestId: string; mailer?: Mailer }) {
  const total = { tenants: 0, approvals: 0, tasks: 0, openings: 0, agreements: 0, reservations: 0, licences: 0, failed: 0 };
  for (const tenant of await store.findMany("tenants", { status: "ACTIVE" })) {
    const tenantId = String(tenant.ROWID);
    const ctx: TenantContext = { tenantId, userId: "SYSTEM:reminders", roles: ["SYSTEM"], zohoDc: String(tenant.zoho_dc), requestId: opts.requestId, correlationId: opts.requestId, mailer: opts.mailer };
    total.tenants++;
    try {
      const r = await sendReminders(store, ctx, opts.now);
      for (const k of Object.keys(r) as Array<keyof typeof r>) total[k] += r[k];
    } catch (e) {
      total.failed++;
      log("warn", "job.reminders_failed", { tenant_id: tenantId, request_id: opts.requestId, error: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  }
  log("info", "job.reminders", { request_id: opts.requestId, ...total });
  return total;
}

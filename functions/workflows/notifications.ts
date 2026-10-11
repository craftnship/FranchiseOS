import { overdueOrders } from "./purchasing";
import { overdueInstalments } from "./funding";
import { auditReminders } from "./audits";
import { launchReminders } from "./launch";
import { Mailer, TenantContext } from "../common/context";
import { log } from "../common/logger";
import { DuplicateKeyError, Row, Store, TenantRepo } from "../common/store";
import { toBool, toNum } from "../common/values";
import { expireLicences, renewDays } from "./licences";
import { derivedDates, openingGap, rentSchedule } from "./leases";
import { duePeriods, nextPeriod, periodLabel, royaltySettings } from "./royalties";

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

const launchDate: Rule = async (store, ctx, e, repo) => {
  const { code, row } = await codeOf(repo, "project", e.entityId);
  const users = await portalUsers(store, ctx.tenantId, row?.franchisee_id);
  if (!users.length) return null;
  return { kind: "launch.planned", entityType: "project", entityId: e.entityId, userIds: users,
    title: e.action === "launch:moved" ? `${code}: grand opening moved to ${nice(e.metadata?.grand_opening_date)}` : `${code}: grand opening set for ${nice(e.metadata?.grand_opening_date)}`,
    body: e.action === "launch:moved" ? "Your launch tasks moved with it." : "Your launch tasks are on the Opening day page.", link: "/portal/launch", dedupe: `launch-date:${e.entityId}:${e.metadata?.grand_opening_date}` };
};

/** Two weeks in a row under the behind mark tells the franchise and operations managers, once per week. */
const launchBehind: Rule = async (_s, _c, e, repo) => {
  const m = e.metadata ?? {};
  if (!m.behind) return null;
  const { code } = await codeOf(repo, "project", e.entityId);
  return { kind: "launch.behind", entityType: "project", entityId: e.entityId, roles: ["FRANCHISE_MANAGER", "OPERATIONS_MANAGER"],
    title: `${code} is behind its launch sales plan`, body: `Week ${m.week_no} came in at ${m.pct ?? "—"}% of plan, the second week running below target${m.to_date_pct != null ? `; ${m.to_date_pct}% to date` : ""}.`,
    link: linkTo("project", e.entityId), dedupe: `launch-behind:${e.entityId}:${m.week_no}` };
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
  "project:forecast": async (store, ctx, e, repo) => {
    const { code, row } = await codeOf(repo, "project", e.entityId);
    const m = e.metadata ?? {};
    const path = (m.critical_path ?? []) as string[];
    return { kind: "project.forecast", entityType: "project", entityId: e.entityId, roles: ["PROJECT_MANAGER", "FRANCHISE_MANAGER"],
      userIds: await portalUsers(store, ctx.tenantId, row?.franchisee_id),
      title: `${code} is now forecast to open ${nice(m.forecast)}`,
      body: `${m.slip_days} day${m.slip_days === 1 ? "" : "s"} after the target of ${nice(m.target)}.${path.length ? ` Critical path: ${path.join(" → ")}.` : ""}`,
      link: linkTo("project", e.entityId), dedupe: `forecast:${e.entityId}:${m.forecast}` };
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
  "royalty:submitted": async (_s, _c, e, repo) => royaltySubmitted(e, repo),
  "royalty:resubmitted": async (_s, _c, e, repo) => royaltySubmitted(e, repo),
  "royalty:returned": async (store, ctx, e, repo) => {
    const m = e.metadata ?? {};
    const { code, row } = await codeOf(repo, "project", String(m.project_id));
    return { kind: "royalty.returned", entityType: "project", entityId: String(m.project_id), userIds: await portalUsers(store, ctx.tenantId, row?.franchisee_id),
      title: `Your ${monthName(m.period)} sales report for ${code} needs a correction`, body: String(m.note ?? ""), link: "/portal/sales" };
  },
  "royalty:invoiced": async (store, ctx, e, repo) => {
    const m = e.metadata ?? {};
    if (m.zero) return null;
    const { code, row } = await codeOf(repo, "project", String(m.project_id));
    return { kind: "royalty.invoiced", entityType: "project", entityId: String(m.project_id), userIds: await portalUsers(store, ctx.tenantId, row?.franchisee_id),
      title: `Royalty invoice for ${monthName(m.period)}: ${inr(toNum(m.royalty) + toNum(m.marketing))}`,
      body: `${code}: royalty ${inr(toNum(m.royalty))}${toNum(m.marketing) ? ` and marketing fund ${inr(toNum(m.marketing))}` : ""} on net sales of ${inr(toNum(m.net_sales))}.${m.invoice_number ? ` Books invoice ${m.invoice_number}.` : ""}`,
      link: "/portal/sales" };
  },
  "design:submitted": async (_s, _c, e, repo) => {
    const m = e.metadata ?? {};
    const { code, row } = await codeOf(repo, "project", e.entityId);
    return { kind: "design.submitted", entityType: "project", entityId: e.entityId, roles: ["FRANCHISE_MANAGER", "PROJECT_MANAGER"],
      title: `${code} store design v${m.version} is waiting for approval`, body: `${await franchiseeName(repo, row?.franchisee_id)}: ${String(m.title ?? "")}. Fit-out waits for it.`,
      link: linkTo("project", e.entityId), dedupe: `design-submitted:${m.design_id}` };
  },
  "design:approved": async (store, ctx, e, repo) => designDecided(store, ctx, e, repo, true),
  "design:changes": async (store, ctx, e, repo) => designDecided(store, ctx, e, repo, false),
  "snag:raised": async (store, ctx, e, repo) => {
    const m = e.metadata ?? {};
    if (m.severity === "MINOR") return null;
    const { code, row } = await codeOf(repo, "project", e.entityId);
    return { kind: "snag.raised", entityType: "project", entityId: e.entityId, userIds: await portalUsers(store, ctx.tenantId, row?.franchisee_id),
      title: `${human(String(m.severity))} snag #${m.snag_no} at ${code}: ${String(m.title ?? "")}`, body: "Fix it and mark it fixed with a photo. The store can't open until it's cleared.",
      link: "/portal/construction", dedupe: `snag-raised:${m.snag_id}` };
  },
  "snag:fixed": async (_s, _c, e, repo) => {
    const m = e.metadata ?? {};
    const { code } = await codeOf(repo, "project", e.entityId);
    return { kind: "snag.fixed", entityType: "project", entityId: e.entityId, roles: ["PROJECT_MANAGER", "FRANCHISE_MANAGER"],
      title: `${code} snag #${m.snag_no} marked fixed: ${String(m.title ?? "")}`, body: "Check it and close it, or reopen it with a note.",
      link: linkTo("project", e.entityId) };
  },
  "snag:reopened": async (store, ctx, e, repo) => {
    const m = e.metadata ?? {};
    const { code, row } = await codeOf(repo, "project", e.entityId);
    return { kind: "snag.reopened", entityType: "project", entityId: e.entityId, userIds: await portalUsers(store, ctx.tenantId, row?.franchisee_id),
      title: `Snag #${m.snag_no} at ${code} was reopened`, body: `${String(m.title ?? "")}: ${String(m.note ?? "")}`, link: "/portal/construction" };
  },
  "training:submitted": async (_s, _c, e, repo) => {
    const m = e.metadata ?? {};
    const { code } = await codeOf(repo, "project", e.entityId);
    return { kind: "training.submitted", entityType: "project", entityId: e.entityId, roles: ["TRAINING_MANAGER", "PROJECT_MANAGER"],
      title: `${code} training to sign off: ${String(m.name ?? "")}, ${String(m.module ?? "")}`, body: "Sign it off, or send it back with a note.",
      link: linkTo("project", e.entityId) };
  },
  "training:returned": async (store, ctx, e, repo) => {
    const m = e.metadata ?? {};
    const { row } = await codeOf(repo, "project", e.entityId);
    return { kind: "training.returned", entityType: "project", entityId: e.entityId, userIds: await portalUsers(store, ctx.tenantId, row?.franchisee_id),
      title: `${String(m.name ?? "")}'s ${String(m.module ?? "training").toLowerCase()} training was sent back`, body: String(m.note ?? ""), link: "/portal/team" };
  },
  "po:placed": async (_s, _c, e, repo) => {
    const m = e.metadata ?? {};
    if (m.source !== "PORTAL") return null;
    const { code } = await codeOf(repo, "project", e.entityId);
    return { kind: "po.placed", entityType: "project", entityId: e.entityId, roles: ["PROJECT_MANAGER"],
      title: `${code} placed ${String(m.po_number)} with ${String(m.vendor ?? "a vendor")} for ${inr(toNum(m.total))}`, body: "Confirm it once the vendor commits to a delivery date.",
      link: linkTo("project", e.entityId), dedupe: `po-placed:${m.po_id}` };
  },
  "po:confirmed": async (store, ctx, e, repo) => {
    const m = e.metadata ?? {};
    const { row } = await codeOf(repo, "project", e.entityId);
    return { kind: "po.confirmed", entityType: "project", entityId: e.entityId, userIds: await portalUsers(store, ctx.tenantId, row?.franchisee_id),
      title: `${String(m.po_number)} is confirmed: ${String(m.vendor ?? "the vendor")} delivers ${nice(m.expected_delivery)}`, body: "Mark it delivered when it arrives.",
      link: "/portal/orders", dedupe: `po-confirmed:${m.po_id}:${m.expected_delivery}` };
  },
  "po:delivered": async (_s, _c, e, repo) => {
    const m = e.metadata ?? {};
    const { code } = await codeOf(repo, "project", e.entityId);
    return { kind: "po.delivered", entityType: "project", entityId: e.entityId, roles: ["PROJECT_MANAGER"],
      title: `${code}: ${String(m.po_number)} from ${String(m.vendor ?? "the vendor")} was delivered`, body: `${inr(toNum(m.total))} is added to the store's capex.`,
      link: linkTo("project", e.entityId), dedupe: `po-delivered:${m.po_id}` };
  },
  "po:cancelled": async (store, ctx, e, repo) => {
    const m = e.metadata ?? {};
    const { code, row } = await codeOf(repo, "project", e.entityId);
    return { kind: "po.cancelled", entityType: "project", entityId: e.entityId, roles: ["PROJECT_MANAGER"], userIds: await portalUsers(store, ctx.tenantId, row?.franchisee_id),
      title: `${code}: ${String(m.po_number)} with ${String(m.vendor ?? "the vendor")} was cancelled`, body: String(m.reason ?? ""),
      link: linkTo("project", e.entityId), dedupe: `po-cancelled:${m.po_id}` };
  },
  "fee:invoiced": async (store, ctx, e, repo) => {
    const m = e.metadata ?? {};
    const { row } = await codeOf(repo, "project", e.entityId);
    return { kind: "fee.invoiced", entityType: "project", entityId: e.entityId, userIds: await portalUsers(store, ctx.tenantId, row?.franchisee_id),
      title: `${m.kind === "DEPOSIT" ? "Security deposit" : `Franchise fee: ${String(m.label ?? "instalment")}`} invoiced for ${inr(toNum(m.amount))}${m.invoice_number ? ` (${String(m.invoice_number)})` : ""}`,
      body: m.due ? `Due ${nice(m.due)}. The invoice is in your email from Zoho Books.` : "The invoice is in your email from Zoho Books.", link: "/portal/funding", dedupe: `fee-invoiced:${m.fee_id}` };
  },
  "fee:instalment_paid": async (_s, _c, e, repo) => {
    const m = e.metadata ?? {};
    const { code } = await codeOf(repo, "project", e.entityId);
    return { kind: "fee.instalment_paid", entityType: "project", entityId: e.entityId, roles: ["FINANCE_MANAGER"],
      title: `${code} paid ${m.kind === "DEPOSIT" ? "the security deposit" : `“${String(m.label ?? "instalment")}”`} (${inr(toNum(m.amount))})`, body: m.invoice_number ? `Invoice ${String(m.invoice_number)} is settled in Books.` : "",
      link: linkTo("project", e.entityId), dedupe: `fee-paid:${m.fee_id}` };
  },
  "loan:sanctioned": async (_s, _c, e, repo) => {
    const m = e.metadata ?? {};
    const { code } = await codeOf(repo, "project", e.entityId);
    const short = toNum(m.sanctioned_amount) < toNum(m.requested);
    return { kind: "loan.sanctioned", entityType: "project", entityId: e.entityId, roles: ["FINANCE_MANAGER", "PROJECT_MANAGER"],
      title: `${code}: ${String(m.lender ?? "the bank")} sanctioned ${inr(toNum(m.sanctioned_amount))}`, body: short ? `That's ${inr(toNum(m.requested) - toNum(m.sanctioned_amount))} less than asked for. Check the funding gap.` : "The loan is secured; disbursements follow.",
      link: linkTo("project", e.entityId), dedupe: `loan-sanctioned:${e.entityId}:${m.sanctioned_amount}` };
  },
  "loan:rejected": async (_s, _c, e, repo) => {
    const m = e.metadata ?? {};
    const { code } = await codeOf(repo, "project", e.entityId);
    return { kind: "loan.rejected", entityType: "project", entityId: e.entityId, roles: ["FINANCE_MANAGER", "PROJECT_MANAGER"],
      title: `${code}: the loan from ${String(m.lender ?? "the bank")} was rejected`, body: `${String(m.reason ?? "")} The opening may need another lender or more own capital.`.trim(),
      link: linkTo("project", e.entityId) };
  },
  "loan:disbursed": async (_s, _c, e, repo) => {
    const m = e.metadata ?? {};
    const { code } = await codeOf(repo, "project", e.entityId);
    return { kind: "loan.disbursed", entityType: "project", entityId: e.entityId, roles: ["FINANCE_MANAGER"],
      title: `${code}: ${inr(toNum(m.amount))} of the loan disbursed`, body: `${inr(toNum(m.total))} of ${inr(toNum(m.sanctioned_amount))} disbursed so far.`,
      link: linkTo("project", e.entityId), dedupe: `loan-disbursed:${e.entityId}:${m.total}` };
  },
  "launch:planned": async (store, ctx, e, repo) => launchDate(store, ctx, e, repo),
  "launch:moved": async (store, ctx, e, repo) => launchDate(store, ctx, e, repo),
  "launch:sales": launchBehind,
  "launch:sales_changed": launchBehind,
  "renewal:not_renewing": async (store, ctx, e, repo) => {
    const { code, row } = await codeOf(repo, "agreement", e.entityId);
    return { kind: "renewal.not_renewing", entityType: "agreement", entityId: e.entityId, roles: ["FRANCHISE_DIRECTOR", "FRANCHISE_MANAGER"],
      title: `${code} won't be renewed`, body: `${await franchiseeName(repo, row?.franchisee_id)}'s agreement ends ${nice(e.metadata?.expiry_date)}.${e.metadata?.note ? ` ${String(e.metadata.note)}` : ""}`,
      link: linkTo("agreement", e.entityId) };
  },
  "message:from_franchisee": async (_s, _c, e, repo) => {
    const f = await repo.findOne("franchisees", { ROWID: e.entityId });
    const apps = await repo.findMany("franchise_applications", { franchisee_id: e.entityId }, { limit: 20 });
    const owner = apps.map((a) => a.owner_user_id).find(Boolean);
    return { kind: "message.received", entityType: "franchisee", entityId: e.entityId, ...(owner ? { userIds: [String(owner)] } : { roles: ["FRANCHISE_MANAGER"] }),
      title: `Message from ${f?.display_name ?? f?.franchise_code ?? "a franchisee"}`, body: String(e.metadata?.preview ?? ""), link: `/messages/${e.entityId}` };
  },
  "message:from_brand": async (store, ctx, e) => {
    const users = await portalUsers(store, ctx.tenantId, e.entityId);
    if (!users.length) return null;
    return { kind: "message.received", entityType: "franchisee", entityId: e.entityId, userIds: users, title: "New message from the brand team", body: String(e.metadata?.preview ?? ""), link: "/portal/messages" };
  },
  "document:shared": async (store, ctx, e) => {
    const m = e.metadata ?? {};
    const notice = { kind: "document.shared", entityType: "document", entityId: e.entityId, title: `New document: ${String(m.title)}`, body: "It's in Documents on your portal.", link: "/portal/documents" };
    if (m.franchisee_id) { const users = await portalUsers(store, ctx.tenantId, m.franchisee_id); return users.length ? { ...notice, userIds: users } : null; }
    return { ...notice, roles: ["FRANCHISEE", "FRANCHISEE_STAFF"] };
  },
  "audit:scheduled": async (store, ctx, e, repo) => {
    const m = e.metadata ?? {};
    const { code, row } = await codeOf(repo, "project", e.entityId);
    const auditor = m.auditor_user_id && m.auditor_user_id !== ctx.userId ? [String(m.auditor_user_id)] : [];
    // A surprise visit is not announced to the store.
    const franchisee = m.audit_type === "SURPRISE" ? [] : await portalUsers(store, ctx.tenantId, row?.franchisee_id);
    if (!auditor.length && !franchisee.length) return null;
    return { kind: "audit.scheduled", entityType: "project", entityId: e.entityId, userIds: [...auditor, ...franchisee],
      title: `${code}: ${human(String(m.audit_type ?? "routine")).toLowerCase()} audit booked for ${nice(m.planned_for)}`, body: `${String(m.audit_code)} checks the store against the brand standards.`,
      link: linkTo("project", e.entityId), dedupe: `audit-scheduled:${m.audit_id}:${m.planned_for}` };
  },
  "audit:completed": async (store, ctx, e, repo) => {
    const m = e.metadata ?? {};
    const { code, row } = await codeOf(repo, "project", e.entityId);
    const acts = toNum(m.actions);
    return { kind: "audit.completed", entityType: "project", entityId: e.entityId, roles: ["OPERATIONS_MANAGER"], userIds: await portalUsers(store, ctx.tenantId, row?.franchisee_id),
      title: `${code} scored ${m.score ?? "—"}% (${human(String(m.rating ?? "")).toLowerCase()}) on audit ${String(m.audit_code)}`,
      body: `${acts ? `${acts} corrective action${acts === 1 ? "" : "s"} to fix` : "Nothing to fix"}${toNum(m.critical_fails) ? `, ${m.critical_fails} on a critical standard` : ""}.`,
      link: linkTo("project", e.entityId), dedupe: `audit-completed:${m.audit_id}` };
  },
  "action:submitted": async (_s, _c, e, repo) => {
    const m = e.metadata ?? {};
    const { code } = await codeOf(repo, "project", e.entityId);
    const audit = await repo.findOne("audits", { ROWID: String(m.audit_id) });
    return { kind: "action.submitted", entityType: "project", entityId: e.entityId, roles: ["OPERATIONS_MANAGER"], userIds: audit?.auditor_user_id ? [String(audit.auditor_user_id)] : [],
      title: `${code} answered a corrective action from ${String(audit?.audit_code ?? "an audit")}`, body: "Check the evidence and close it or send it back.",
      link: `/audits/${m.audit_id}` };
  },
  "action:reopened": async (store, ctx, e, repo) => {
    const m = e.metadata ?? {};
    const { code, row } = await codeOf(repo, "project", e.entityId);
    return { kind: "action.reopened", entityType: "project", entityId: e.entityId, userIds: await portalUsers(store, ctx.tenantId, row?.franchisee_id),
      title: `${code}: a corrective action was sent back`, body: `${String(m.note ?? "")}${m.due_date ? ` New date: ${nice(m.due_date)}.` : ""}`.trim(), link: "/portal/audits" };
  },
  "capex:overrun": async (_s, _c, e, repo) => {
    const { code } = await codeOf(repo, "project", e.entityId);
    const cats = (e.metadata?.categories ?? []) as Array<{ name: string; budget: number; actual: number }>;
    const total = e.metadata?.total as { budget: number; actual: number } | null;
    const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
    const title = total ? `${code} is over its capex budget` : cats.length === 1 ? `${cats[0].name} is over budget on ${code}` : `${cats.length} capex categories are over budget on ${code}`;
    const parts = [...(total ? [`Total ${inr(total.actual)} spent against ${inr(total.budget)}`] : []), ...cats.map((c) => `${c.name} ${inr(c.actual)} against ${inr(c.budget)}`)];
    return { kind: "capex.overrun", entityType: "project", entityId: e.entityId, roles: ["FINANCE_MANAGER", "FRANCHISE_MANAGER", "PROJECT_MANAGER"],
      title, body: `${parts.join("; ")}.`, link: linkTo("project", e.entityId) };
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

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const monthName = (p: unknown) => periodLabel(String(p ?? ""));

async function designDecided(store: Store, ctx: TenantContext, e: Entry, repo: TenantRepo, approved: boolean): Promise<Notice> {
  const m = e.metadata ?? {};
  const { code, row } = await codeOf(repo, "project", e.entityId);
  return { kind: approved ? "design.approved" : "design.changes", entityType: "project", entityId: e.entityId, userIds: await portalUsers(store, ctx.tenantId, row?.franchisee_id),
    title: approved ? `${code} store design v${m.version} is approved` : `${code} store design v${m.version} needs changes`,
    body: approved ? "Fit-out can go ahead to the approved drawings." : `${String(m.note ?? "")} Send a new version when it's ready.`,
    link: "/portal/construction", dedupe: `design-decided:${m.design_id}` };
}

async function royaltySubmitted(e: Entry, repo: TenantRepo): Promise<Notice> {
  const m = e.metadata ?? {};
  const { code, row } = await codeOf(repo, "project", String(m.project_id));
  return { kind: "royalty.submitted", entityType: "project", entityId: String(m.project_id), roles: ["FINANCE_MANAGER"],
    title: `${code} reported ${monthName(m.period)} sales`, body: `${await franchiseeName(repo, row?.franchisee_id)}: net sales ${inr(toNum(m.net_sales))}. Approve it to raise the royalty invoice.`,
    link: linkTo("project", String(m.project_id)), dedupe: `royalty-submitted:${e.entityId}:${m.net_sales}` };
}

/**
 * Lease alerts for one lease, each delivered once: rent starting before the store opens (again when
 * either date moves), the renewal notice date coming up, and a rent step-up within 30 days.
 */
export async function leaseNotices(store: Store, ctx: TenantContext, lease: Row, now: Date): Promise<number> {
  if (lease.status === "TERMINATED") return 0;
  const repo = new TenantRepo(store, ctx.tenantId);
  const today = day(now);
  const site = await repo.findOne("sites", { ROWID: String(lease.site_id) });
  if (!site) return 0;
  const project = (await repo.findMany("franchise_projects", { site_id: String(site.ROWID) }, { limit: 10 })).find((p) => p.status !== "CLOSED") ?? null;
  const where = project ? String(project.project_code) : String(site.site_code);
  const link = project ? linkTo("project", String(project.ROWID)) : linkTo("site", String(site.ROWID));
  const franchisee = await portalUsers(store, ctx.tenantId, site.franchisee_id);
  const d = derivedDates(lease);
  let n = 0;
  const target = project && ACTIVE_PROJECTS.includes(String(project.status)) && project.target_opening_date ? String(project.target_opening_date).slice(0, 10) : null;
  const gap = openingGap(lease, target);
  if (gap && d.rent_start && target) {
    const started = d.rent_start <= today;
    // Once rent is running, what matters is the rent still to pay before the doors open.
    const days = started ? Math.max(0, Math.round((Date.parse(`${target}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)) : gap.days;
    const cost = Math.round(gap.cost * (days / gap.days));
    if (days > 0) n += await deliver(store, ctx, {
      kind: "lease.rent_before_opening", entityType: project ? "project" : "site", entityId: String(project?.ROWID ?? site.ROWID), roles: ["FRANCHISE_MANAGER", "PROJECT_MANAGER", "FINANCE_MANAGER"], userIds: franchisee,
      title: started ? `Rent on ${where} is running ${days} days before opening` : `Rent on ${where} starts ${days} days before opening`,
      body: started
        ? `Rent started ${nice(d.rent_start)} and the target opening is ${nice(target)}: about ${inr(cost)} more before the store earns. Bring the opening forward where you can.`
        : `The rent-free period ends ${nice(d.rent_start)} but the target opening is ${nice(target)}. That is about ${inr(cost)} of rent before the store earns. Bring the opening forward or ask the landlord for a longer fit-out period.`,
      link, dedupe: `lease-gap:${lease.ROWID}:${d.rent_start}:${target}`,
    }, now);
  }
  if (lease.status === "SIGNED" && d.notice_by && d.expiry_date) {
    const left = (Date.parse(`${d.notice_by}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
    if (left <= 60 && d.expiry_date >= today) {
      n += await deliver(store, ctx, {
        kind: "lease.renewal", entityType: "site", entityId: String(site.ROWID), roles: ["FRANCHISE_MANAGER"], userIds: franchisee,
        title: `Lease for ${where} needs a renewal decision by ${nice(d.notice_by)}`,
        body: `The lease ends ${nice(d.expiry_date)}${lease.landlord_name ? ` (landlord ${lease.landlord_name})` : ""}. Give notice or agree the renewal terms before then.`,
        link: linkTo("site", String(site.ROWID)), dedupe: `lease-renewal:${lease.ROWID}:${d.expiry_date}`,
      }, now);
    }
  }
  if (lease.status === "SIGNED") {
    const next = rentSchedule(lease, today).next;
    if (next && (Date.parse(`${next.date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000 <= 30) {
      n += await deliver(store, ctx, {
        kind: "lease.escalation", entityType: "site", entityId: String(site.ROWID), roles: ["FINANCE_MANAGER"], userIds: franchisee,
        title: `Rent for ${where} goes up to ${inr(next.rent)} on ${nice(next.date)}`,
        body: `A ${toNum(lease.escalation_pct)}% step-up under the lease.`, link, dedupe: `lease-escalation:${lease.ROWID}:${next.date}`,
      }, now);
    }
  }
  return n;
}

/** One tenant's reminders: overdue approvals (escalated once), overdue tasks, late openings, licences expiring or missing, unsigned agreements, holds about to lapse. */
export async function sendReminders(store: Store, ctx: TenantContext, now: Date) {
  const repo = new TenantRepo(store, ctx.tenantId);
  const today = day(now);
  const out = { approvals: 0, tasks: 0, openings: 0, agreements: 0, reservations: 0, licences: 0, leases: 0, sales: 0, deliveries: 0, fees: 0, funding: 0, audits: 0, launch: 0, renewals: 0 };
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

  for (const lease of await repo.findMany("leases", {})) out.leases += await leaseNotices(store, ctx, lease, now);

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

  out.sales += await salesReminders(store, ctx, repo, today, now);

  // Confirmed orders past their delivery date: the project manager and the franchisee chase the vendor.
  for (const po of overdueOrders(await repo.findMany("purchase_orders", { status: "CONFIRMED" }), today)) {
    const project = projectsById.get(String(po.project_id));
    if (!project || project.status === "CLOSED") continue;
    const vendor = await repo.findOne("vendors", { ROWID: String(po.vendor_id) });
    out.deliveries += await deliver(store, ctx, {
      kind: "po.overdue", entityType: "project", entityId: String(po.project_id), roles: ["PROJECT_MANAGER"], userIds: await portalUsers(store, ctx.tenantId, po.franchisee_id),
      title: `${po.po_number} from ${vendor?.name ?? "the vendor"} is late`, body: `It was due ${nice(String(po.expected_delivery).slice(0, 10))} for ${project.project_code}. Chase the vendor and update the date.`,
      link: linkTo("project", String(po.project_id)), dedupe: `po-overdue:${po.ROWID}:${String(po.expected_delivery).slice(0, 10)}`,
    }, now);
  }

  // Fee instalments past their due date (the signing invoice is chased per agreement above).
  const signed = new Map((await repo.findMany("agreements", { status: "SIGNED" }, { limit: 300 })).map((a) => [String(a.ROWID), a]));
  for (const f of overdueInstalments(await repo.findMany("fee_instalments", { status: "INVOICED" }, { limit: 300 }), signed, today)) {
    const project = projectsById.get(String(f.project_id));
    if (!project) continue;
    const due = String(f.invoice_due_date).slice(0, 10);
    out.fees += await deliver(store, ctx, {
      kind: "fee.instalment_overdue", entityType: "project", entityId: String(f.project_id), roles: ["FINANCE_MANAGER"], userIds: await portalUsers(store, ctx.tenantId, f.franchisee_id),
      title: `${project.project_code}: ${f.kind === "DEPOSIT" ? "security deposit" : `fee instalment “${f.label}”`} is overdue`, body: `${inr(toNum(f.invoice_balance))} on ${f.invoice_number ?? "the invoice"} was due ${nice(due)}.`,
      link: linkTo("project", String(f.project_id)), dedupe: `fee-inst-overdue:${f.ROWID}:${due}`,
    }, now);
  }

  // Corrective actions past their date, and opened stores past their audit date with nothing booked.
  const due = await auditReminders(store, ctx, today);
  for (const a of due.actions) {
    const project = projectsById.get(String(a.project_id));
    if (!project) continue;
    const by = String(a.due_date).slice(0, 10);
    out.audits += await deliver(store, ctx, {
      kind: "action.overdue", entityType: "project", entityId: String(a.project_id), roles: ["OPERATIONS_MANAGER"], userIds: await portalUsers(store, ctx.tenantId, a.franchisee_id),
      title: `${project.project_code}: a ${String(a.severity).toLowerCase()} corrective action is overdue`, body: `${String(a.description).slice(0, 200)} It was due ${nice(by)}.`,
      link: linkTo("project", String(a.project_id)), dedupe: `action-overdue:${a.ROWID}:${by}`,
    }, now);
  }
  for (const { project, due: by } of due.stores) {
    out.audits += await deliver(store, ctx, {
      kind: "audit.due", entityType: "project", entityId: String(project.ROWID), roles: ["OPERATIONS_MANAGER"],
      title: `${project.project_code} is due an audit`, body: `It was due ${nice(by)} and none is booked.`,
      link: linkTo("project", String(project.ROWID)), dedupe: `audit-due:${project.ROWID}:${by}`,
    }, now);
  }

  // Opening day: launch tasks past their date, finished watch weeks with no sales, and renewals coming up.
  const launch = await launchReminders(store, ctx, today);
  for (const { project, task } of launch.tasks) {
    const by = String(task.due_date).slice(0, 10);
    const mine = task.owner_side === "FRANCHISEE";
    out.launch += await deliver(store, ctx, {
      kind: "launch.task_overdue", entityType: "project", entityId: String(project.ROWID), ...(mine ? { userIds: await portalUsers(store, ctx.tenantId, project.franchisee_id) } : { roles: ["PROJECT_MANAGER"] }),
      title: `${project.project_code}: launch task overdue`, body: `${task.item} was due ${nice(by)}.`,
      link: mine ? "/portal/launch" : linkTo("project", String(project.ROWID)), dedupe: `launch-task:${task.ROWID}:${by}`,
    }, now);
  }
  for (const { project, week, ended } of launch.missing) {
    out.launch += await deliver(store, ctx, {
      kind: "launch.sales_due", entityType: "project", entityId: String(project.ROWID), userIds: await portalUsers(store, ctx.tenantId, project.franchisee_id),
      title: `Report week ${week} sales for ${project.project_code}`, body: `The week ended ${nice(ended)}. The brand team tracks your first weeks against plan.`,
      link: "/portal/launch", dedupe: `launch-week:${project.ROWID}:${week}`,
    }, now);
  }
  for (const { agreement, days_left, milestone } of launch.renewals) {
    const end = String(agreement.expiry_date).slice(0, 10);
    out.renewals += await deliver(store, ctx, {
      kind: "renewal.due", entityType: "agreement", entityId: String(agreement.ROWID), roles: ["FRANCHISE_MANAGER", "LEGAL_MANAGER"], userIds: await portalUsers(store, ctx.tenantId, agreement.franchisee_id),
      title: days_left < 0 ? `${agreement.agreement_code} ended ${nice(end)} without a renewal` : `${agreement.agreement_code} ends ${nice(end)}`,
      body: days_left < 0 ? "Record the renewal, or that it won't be renewed." : `${days_left} days left. ${agreement.renewal_status ? `Renewal is ${human(String(agreement.renewal_status)).toLowerCase()}.` : "Start the renewal conversation."}`,
      link: linkTo("agreement", String(agreement.ROWID)), dedupe: `renewal:${agreement.ROWID}:${end}:${milestone}`,
    }, now);
  }

  // A loan not yet sanctioned when fit-out is a month away puts the opening at risk.
  for (const plan of await repo.findMany("funding_plans", {}, { limit: 300 })) {
    if (!["PLANNED", "APPLIED", "REJECTED"].includes(String(plan.status))) continue;
    const project = projectsById.get(String(plan.project_id));
    if (!project || !["NOT_STARTED", "PLANNING", "IN_PROGRESS", "AT_RISK"].includes(String(project.status))) continue;
    const fitout = await repo.findOne("opening_checklists", { project_id: String(plan.project_id), task_code: "FITOUT" });
    const by = fitout?.due_date ? String(fitout.due_date).slice(0, 10) : null;
    if (!by || fitout?.status === "COMPLETED" || Math.round((Date.parse(by) - Date.parse(today)) / 86400000) > 30) continue;
    out.funding += await deliver(store, ctx, {
      kind: "funding.at_risk", entityType: "project", entityId: String(plan.project_id), roles: ["FINANCE_MANAGER", "PROJECT_MANAGER"], userIds: await portalUsers(store, ctx.tenantId, plan.franchisee_id),
      title: `${project.project_code}: the loan isn't sanctioned and fit-out is due ${nice(by)}`, body: `The ${inr(toNum(plan.loan_amount))} loan is ${human(String(plan.status)).toLowerCase()}. Without it the fit-out may stall.`,
      link: linkTo("project", String(plan.project_id)), dedupe: `funding-risk:${plan.project_id}:${plan.status}`,
    }, now);
  }
  return out;
}

/** Days after the due day before finance and the franchise manager hear that a report is missing. */
const SALES_LATE_DAYS = 5;

/**
 * Opened stores whose sales for a finished month are missing (or returned and not yet fixed): the
 * franchisee is reminded on the due day, and finance and the franchise manager hear a few days later.
 */
async function salesReminders(store: Store, ctx: TenantContext, repo: TenantRepo, today: string, now: Date): Promise<number> {
  const { report_due_day } = royaltySettings(await store.findOne("tenants", { ROWID: ctx.tenantId }));
  let sent = 0;
  for (const project of await repo.findMany("franchise_projects", { status: "OPENED" }, { limit: 300 })) {
    const pid = String(project.ROWID);
    const reports = new Map((await repo.findMany("sales_reports", { project_id: pid }, { limit: 300 })).map((r) => [String(r.period), r]));
    const missing = duePeriods(project, today).filter((p) => { const r = reports.get(p); return !r || r.status === "RETURNED"; });
    for (const p of missing.slice(-3)) {
      const dueOn = `${nextPeriod(p)}-${String(report_due_day).padStart(2, "0")}`;
      if (today < dueOn) continue;
      const late = Math.round((Date.parse(today) - Date.parse(dueOn)) / 86_400_000);
      sent += await deliver(store, ctx, {
        kind: "sales.due", entityType: "project", entityId: pid, userIds: await portalUsers(store, ctx.tenantId, project.franchisee_id),
        title: `Report your ${periodLabel(p)} sales for ${project.project_code}`, body: `It was due ${nice(dueOn)}. Your royalty invoice is raised from it.`,
        link: "/portal/sales", dedupe: `sales-due:${pid}:${p}`,
      }, now);
      if (late >= SALES_LATE_DAYS) {
        sent += await deliver(store, ctx, {
          kind: "sales.late", entityType: "project", entityId: pid, roles: ["FINANCE_MANAGER", "FRANCHISE_MANAGER"],
          title: `${project.project_code} hasn't reported ${periodLabel(p)} sales`, body: `${await franchiseeName(repo, project.franchisee_id)} is ${late} days past the ${nice(dueOn)} due date.`,
          link: linkTo("project", pid), dedupe: `sales-late:${pid}:${p}`,
        }, now);
      }
    }
  }
  return sent;
}

/** job_reminders (daily): sendReminders for every active tenant; a failing tenant is logged and skipped. */
export async function runReminderJob(store: Store, opts: { now: Date; requestId: string; mailer?: Mailer }) {
  const total = { tenants: 0, approvals: 0, tasks: 0, openings: 0, agreements: 0, reservations: 0, licences: 0, leases: 0, sales: 0, deliveries: 0, fees: 0, funding: 0, audits: 0, launch: 0, renewals: 0, failed: 0 };
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

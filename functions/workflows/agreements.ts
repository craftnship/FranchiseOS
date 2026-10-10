import { AppError } from "../common/errors";
import { TenantContext } from "../common/context";
import { logActivity } from "../common/audit";
import { nextBusinessId } from "../common/ids";
import { log } from "../common/logger";
import { PermissionLookup } from "../common/rbac";
import { Row, Store, TenantRepo } from "../common/store";
import { toBool, toNum } from "../common/values";
import { ZohoBooksClient, ZohoCrmClient, ZohoProjectsClient, ZohoSignClient } from "../integrations/clients";
import { processOnce } from "../integrations/idempotency";
import { ProviderError } from "../integrations/retry";
import { CRM_ACCOUNT_FIELDS, CRM_LEAD_FIELDS } from "../integrations/crmSync";
import { DEFAULTS } from "../../database/seed/defaults";
import { buildOpeningProject, TemplateTask } from "./projectCreation";
import { allocateTerritory } from "./territoryReservation";
import { transitionEntity, TransitionDeps } from "./transition";

// Agreement and onboarding (plan Step 5, FOS-045..056). Sending creates the agreement and its Zoho
// Sign request; a signed request drives the onboarding pipeline below. Every step of that pipeline
// checks a stored id or state first, so replays and retries only finish what is left.

/** Engine-driven steps act on the signature itself, so the system permissions are granted here only. */
export const SYSTEM_PERMISSIONS: PermissionLookup = async () => new Set(["system.sign", "system.project", "agreement.write"]);

const OPEN_AGREEMENT = ["DRAFT", "SENT", "VIEWED"];
const RESENDABLE = ["DECLINED", "EXPIRED", "VOIDED"];

export interface OnboardingSettings {
  agreement_term_years: number;
  opening_target_days: number;
  franchise_fee: number;
  projects_dependencies: boolean;
  currency: string;
  /** Books payment terms in days for the fee invoice. */
  books_payment_terms: number;
  /** Books tax (e.g. GST 18%) applied to the fee line; none when unset. */
  books_tax_id: string | null;
  /** Email the fee invoice to the franchisee; false only marks it sent. */
  books_email_invoice: boolean;
}

export function onboardingSettings(tenant: Row | null): OnboardingSettings {
  let s: Record<string, unknown> = {};
  try { s = tenant?.settings_json ? JSON.parse(String(tenant.settings_json)) : {}; } catch { s = {}; }
  const d = DEFAULTS.onboarding;
  return {
    agreement_term_years: s.agreement_term_years != null ? toNum(s.agreement_term_years) : d.agreement_term_years,
    opening_target_days: s.opening_target_days != null ? toNum(s.opening_target_days) : d.opening_target_days,
    franchise_fee: s.franchise_fee != null ? toNum(s.franchise_fee) : d.franchise_fee,
    projects_dependencies: s.projects_dependencies != null ? toBool(s.projects_dependencies) : d.projects_dependencies,
    currency: String(tenant?.currency ?? "INR"),
    books_payment_terms: s.books_payment_terms != null ? toNum(s.books_payment_terms) : d.books_payment_terms,
    books_tax_id: s.books_tax_id ? String(s.books_tax_id) : null,
    books_email_invoice: s.books_email_invoice != null ? toBool(s.books_email_invoice) : d.books_email_invoice,
  };
}

function dateOnly(d: Date): string { return d.toISOString().slice(0, 10); }
function addYears(date: string, years: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCFullYear(d.getUTCFullYear() + years);
  d.setUTCDate(d.getUTCDate() - 1);
  return dateOnly(d);
}
function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return dateOnly(d);
}

type Deps = Pick<TransitionDeps, "onTransition">;

/**
 * Sends the franchise agreement for an APPROVED application (or resends after a decline, expiry or
 * void). Returns the open agreement unchanged if one was already sent.
 */
export async function sendAgreement(
  store: Store,
  ctx: TenantContext,
  sign: ZohoSignClient,
  args: { applicationId: string; permissions: PermissionLookup } & Deps,
): Promise<{ agreement: Row; sent: boolean }> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const app = await repo.findOne("franchise_applications", { ROWID: args.applicationId });
  if (!app) throw new AppError("APPLICATION_NOT_FOUND");
  const agreements = await repo.findMany("agreements", { application_id: args.applicationId }, { orderBy: "ROWID", desc: true, limit: 20 });
  if (agreements.some((a) => a.status === "SIGNED")) throw new AppError("AGREEMENT_ALREADY_SIGNED");
  const open = agreements.find((a) => OPEN_AGREEMENT.includes(String(a.status)));
  if (open && open.zoho_sign_request_id) return { agreement: open, sent: false };

  const resend = app.status === "AGREEMENT_PENDING" && !open && agreements.some((a) => RESENDABLE.includes(String(a.status)));
  if (app.status !== "APPROVED" && !resend && !(open && app.status === "AGREEMENT_PENDING")) {
    throw new AppError("APPLICATION_INVALID_STATE", `Cannot send an agreement for an application in state ${app.status}.`);
  }

  const franchisee = await repo.findOne("franchisees", { ROWID: String(app.franchisee_id) });
  if (!franchisee) throw new AppError("FRANCHISEE_NOT_FOUND");
  if (!franchisee.email) throw new AppError("VALIDATION_FAILED", "The franchisee needs an email address to sign.", { email: "required" });
  const type = String(franchisee.franchise_type || "QSR");
  const templates = await repo.findMany("agreement_templates", { franchise_type: type, status: "ACTIVE" }, { orderBy: "version", desc: true, limit: 1 });
  const template = templates[0];
  if (!template?.zoho_sign_template_id) {
    throw new AppError("VALIDATION_FAILED", `No Zoho Sign template is set for ${type} agreements.`, { zoho_sign_template_id: "required" });
  }

  // A DRAFT left by an interrupted send is reused, so a retry never allocates a second code.
  let agreement = open;
  if (!agreement) {
    const code = await nextBusinessId(store, ctx.tenantId, "agreement");
    agreement = await repo.insert("agreements", {
      agreement_code: code, tenant_code_key: `${ctx.tenantId}:${code}`, application_id: args.applicationId,
      franchisee_id: String(franchisee.ROWID), template_id: String(template.ROWID), status: "DRAFT", zoho_sign_request_id: null,
    });
  }
  const ref = await sign.sendFromTemplate(String(template.zoho_sign_template_id), {
    requestName: `${agreement.agreement_code} ${franchisee.display_name ?? ""}`.trim(),
    recipient: { name: String(franchisee.display_name ?? franchisee.legal_name ?? "Franchisee"), email: String(franchisee.email) },
    fieldData: { agreement_code: String(agreement.agreement_code), franchisee_name: String(franchisee.legal_name ?? franchisee.display_name ?? ""), application_code: String(app.application_code) },
  });
  await repo.update("agreements", String(agreement.ROWID), { zoho_sign_request_id: ref.id });
  const deps = { store, permissions: args.permissions, onTransition: args.onTransition };
  agreement = await transitionEntity("agreement", String(agreement.ROWID), "send", ctx, deps);
  if (app.status === "APPROVED") await transitionEntity("application", args.applicationId, "send_agreement", ctx, deps);
  return { agreement, sent: true };
}

export interface OnboardingClients {
  crm: ZohoCrmClient | null;
  /** For the signed PDF; without it the PDF step is skipped. */
  sign?: ZohoSignClient | null;
  books: ZohoBooksClient | null;
  projects: ZohoProjectsClient | null;
}

export type SignOutcome =
  | { action: "duplicate" }
  | { action: "ignored"; reason: string }
  | { action: "updated"; agreement_id: string; status: string }
  | { action: "onboarded"; agreement_id: string; result: OnboardingResult };

/** Sign request status (and the webhook's viewed notice) to the agreement transition it drives. */
function signTransition(status: string, viewed: boolean): string | null {
  switch (status) {
    case "completed": return "signed";
    case "declined": return "declined";
    case "expired": return "expired";
    case "recalled": return "void";
    case "inprogress": return viewed ? "viewed" : null;
    default: return null;
  }
}

/**
 * Handles a Zoho Sign callback. Only the request id is taken from the payload: the status is read
 * back from Sign, so a forged or replayed callback cannot sign an agreement.
 */
export async function handleSignEvent(
  store: Store,
  ctx: TenantContext,
  clients: OnboardingClients & { sign: ZohoSignClient },
  args: { requestId: string; operation?: string; now?: Date } & Deps,
): Promise<SignOutcome> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const agreement = await repo.findOne("agreements", { zoho_sign_request_id: args.requestId });
  if (!agreement) return { action: "ignored", reason: "No agreement uses this Sign request." };
  const state = await clients.sign.getRequest(args.requestId);
  const viewed = /viewed/i.test(args.operation ?? "");
  const transition = signTransition(state.status, viewed);
  if (!transition) return { action: "ignored", reason: `Sign request is ${state.status}.` };

  const res = await processOnce(store, ctx.tenantId, { source: "SIGN", eventId: transition, recordId: args.requestId, payload: { request_id: args.requestId, status: state.status, operation: args.operation ?? null } }, async (): Promise<SignOutcome> => {
    if (transition !== "signed") {
      const current = await repo.getById("agreements", String(agreement.ROWID));
      if (!OPEN_AGREEMENT.includes(String(current.status))) return { action: "ignored", reason: `Agreement is already ${current.status}.` };
      const updated = await transitionEntity("agreement", String(agreement.ROWID), transition, ctx, { store, permissions: SYSTEM_PERMISSIONS, onTransition: args.onTransition });
      return { action: "updated", agreement_id: String(agreement.ROWID), status: String(updated.status) };
    }
    const signedAt = state.completedAt ? new Date(state.completedAt) : args.now ?? new Date();
    const result = await onboardSignedAgreement(store, ctx, clients, { agreementId: String(agreement.ROWID), signedAt, now: args.now, onTransition: args.onTransition });
    return { action: "onboarded", agreement_id: String(agreement.ROWID), result };
  });
  return res.duplicate ? { action: "duplicate" } : res.result;
}

export interface OnboardingResult {
  project_id: string;
  zoho_account_id: string | null;
  zoho_contact_id: string | null;
  document_ref: string | null;
  zoho_books_customer_id: string | null;
  zoho_books_invoice_id: string | null;
  zoho_project_id: string | null;
  tasks_created: number;
  /** Steps that could not finish; a retry runs only these. */
  pending: string[];
}

/**
 * Post-signature pipeline (spec §15, D-17): agreement SIGNED, application AGREEMENT_SIGNED, opening
 * project row, application ONBOARDING, franchisee ACTIVE, CRM lead converted to Account + Contact,
 * signed PDF on the Account, Books customer and fee invoice (sent), Zoho project.
 * Local state changes run first so a Zoho outage never blocks them. A failing Zoho step does not stop
 * the others; the run then throws so the event stays retryable.
 */
export async function onboardSignedAgreement(
  store: Store,
  ctx: TenantContext,
  clients: OnboardingClients,
  args: { agreementId: string; signedAt?: Date; now?: Date } & Deps,
): Promise<OnboardingResult> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const now = args.now ?? new Date();
  const deps = { store, permissions: SYSTEM_PERMISSIONS, onTransition: args.onTransition };
  const tenant = await store.findOne("tenants", { ROWID: ctx.tenantId });
  const settings = onboardingSettings(tenant);

  let agreement = await repo.findOne("agreements", { ROWID: args.agreementId });
  if (!agreement) throw new AppError("AGREEMENT_NOT_FOUND");
  if (["SENT", "VIEWED"].includes(String(agreement.status))) {
    const signedAt = args.signedAt ?? now;
    const effective = dateOnly(signedAt);
    await repo.update("agreements", args.agreementId, { signed_at: signedAt.toISOString(), effective_date: effective, expiry_date: addYears(effective, settings.agreement_term_years) });
    agreement = await transitionEntity("agreement", args.agreementId, "signed", ctx, deps);
    await logActivity(store, ctx, { entityType: "agreement", entityId: args.agreementId, action: "agreement:signed", metadata: { zoho_sign_request_id: agreement.zoho_sign_request_id } });
  }
  if (agreement.status !== "SIGNED") throw new AppError("INVALID_TRANSITION", `Agreement is ${agreement.status}, not signed.`);

  const appId = String(agreement.application_id);
  let app = await repo.getById("franchise_applications", appId);
  if (app.status === "AGREEMENT_PENDING") app = await transitionEntity("application", appId, "agreement_signed", ctx, deps);

  // Opening project row (once per application), then ONBOARDING.
  let project = await repo.findOne("franchise_projects", { application_id: appId });
  if (!project) {
    const code = await nextBusinessId(store, ctx.tenantId, "project");
    project = await repo.insert("franchise_projects", {
      project_code: code, tenant_code_key: `${ctx.tenantId}:${code}`, application_id: appId,
      franchisee_id: String(agreement.franchisee_id), site_id: app.site_id ?? null, zoho_project_id: null,
      status: "NOT_STARTED", target_opening_date: addDays(dateOnly(now), settings.opening_target_days),
    });
    await logActivity(store, ctx, { entityType: "project", entityId: String(project.ROWID), action: "create:agreement", metadata: { agreement_id: args.agreementId } });
  }
  if (app.status === "AGREEMENT_SIGNED") app = await transitionEntity("application", appId, "start_onboarding", ctx, deps);
  // The reserved territory now belongs to this franchisee.
  await allocateTerritory(store, ctx, appId);

  const pending: string[] = [];
  const failures: string[] = [];
  const step = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (e) {
      const error = String((e as Error)?.message ?? e).slice(0, 300);
      pending.push(name);
      failures.push(`${name} (${error})`);
      log("warn", "onboarding.step_failed", { tenant_id: ctx.tenantId, request_id: ctx.requestId, step: name, error });
    }
  };

  const franchiseeId = String(agreement.franchisee_id);
  let franchisee = await repo.getById("franchisees", franchiseeId);
  const name = String(franchisee.legal_name || franchisee.display_name || franchisee.franchise_code);
  // A signed agreement makes the franchisee a partner, whatever happens in Zoho below.
  if (franchisee.status !== "ACTIVE") {
    franchisee = await repo.update("franchisees", franchiseeId, { status: "ACTIVE" });
    await logActivity(store, ctx, { entityType: "franchisee", entityId: franchiseeId, action: "activate:signed", metadata: { agreement_id: args.agreementId } });
  }

  await step("crm_account", async () => {
    const crm = clients.crm;
    if (!crm) return;
    if (!franchisee.zoho_account_id) {
      // Converting keeps the lead's history on the new Account and Contact; a lead already
      // converted or deleted falls back to a plain Account.
      let ids: { accountId: string; contactId: string | null } | null = null;
      if (franchisee.zoho_lead_id) {
        ids = await crm.convertLead(String(franchisee.zoho_lead_id)).catch((e) => {
          log("warn", "crm.lead_convert_failed", { tenant_id: ctx.tenantId, request_id: ctx.requestId, error: String((e as Error)?.message ?? e).slice(0, 300) });
          return null;
        });
      }
      const accountId = ids?.accountId ?? (await crm.createAccount({ Account_Name: name, Description: `FranchiseOS ${franchisee.franchise_code}` })).id;
      franchisee = await repo.update("franchisees", franchiseeId, { zoho_account_id: accountId, zoho_contact_id: ids?.contactId ?? null });
    }
    await crm.updateAccount(String(franchisee.zoho_account_id), {
      ...(franchisee.phone ? { Phone: franchisee.phone } : {}),
      ...(app.preferred_city ? { Billing_City: app.preferred_city } : {}),
      ...(app.preferred_state ? { Billing_State: app.preferred_state } : {}),
      ...(app.preferred_country ? { Billing_Country: app.preferred_country } : {}),
      Description: `FranchiseOS ${franchisee.franchise_code}${franchisee.email ? ` · ${franchisee.email}` : ""}`,
      [CRM_ACCOUNT_FIELDS.franchiseCode]: franchisee.franchise_code,
      [CRM_ACCOUNT_FIELDS.applicationCode]: app.application_code,
      [CRM_ACCOUNT_FIELDS.applicationStatus]: app.status,
      [CRM_ACCOUNT_FIELDS.targetOpening]: project!.target_opening_date ? String(project!.target_opening_date).slice(0, 10) : null,
    });
  });

  await step("signed_pdf", async () => {
    if (agreement!.document_ref || !clients.sign || !clients.crm || !franchisee.zoho_account_id || !agreement!.zoho_sign_request_id) return;
    const file = await clients.sign.downloadSigned(String(agreement!.zoho_sign_request_id));
    const ext = file.type === "application/zip" ? "zip" : "pdf";
    const att = await clients.crm.attachFile("Accounts", String(franchisee.zoho_account_id), { ...file, name: `${agreement!.agreement_code} signed.${ext}` });
    agreement = await repo.update("agreements", args.agreementId, { document_ref: `crm:Accounts/${franchisee.zoho_account_id}/Attachments/${att.id}` });
  });

  let invoiceId = (agreement.zoho_books_invoice_id as string | null) ?? null;
  const email = franchisee.email ? String(franchisee.email) : undefined;
  await step("books_customer", async () => {
    if (franchisee.zoho_books_customer_id || !clients.books) return;
    const found = await clients.books.findCustomer(name, email);
    const ref = found ?? await clients.books.createCustomer({ contact_name: name, company_name: franchisee.legal_name ? String(franchisee.legal_name) : undefined, email, phone: franchisee.phone ? String(franchisee.phone) : undefined });
    franchisee = await repo.update("franchisees", franchiseeId, { zoho_books_customer_id: ref.id });
  });
  if (settings.franchise_fee > 0 && clients.books && franchisee.zoho_books_customer_id && !invoiceId) {
    const books = clients.books;
    await step("books_invoice", async () => {
      const code = String(agreement!.agreement_code);
      const ref = await books.findInvoice(code) ?? await books.createInvoice({
        customer_id: String(franchisee.zoho_books_customer_id), reference_number: code, date: dateOnly(now), payment_terms: settings.books_payment_terms,
        line_items: [{ name: "Franchise fee", description: `Initial franchise fee, agreement ${code}`, rate: settings.franchise_fee, quantity: 1, ...(settings.books_tax_id ? { tax_id: settings.books_tax_id } : {}) }],
      });
      invoiceId = ref.id;
      await repo.update("agreements", args.agreementId, { zoho_books_invoice_id: ref.id });
    });
  }
  if (invoiceId && clients.books) {
    const books = clients.books;
    await step("books_invoice_send", async () => {
      // Only a draft is sent, so a retry never emails the franchisee twice.
      const inv = await books.getInvoice(invoiceId!);
      if (inv.status !== "draft") return;
      await books.sendInvoice(invoiceId!, settings.books_email_invoice && email ? [email] : []);
    });
  }

  let build: { zohoProjectId: string; tasksCreated: number } | null = null;
  if (clients.projects) {
    const projects = clients.projects;
    await step("zoho_project", async () => {
      build = await buildOpeningProject(store, ctx, projects, {
        projectRowId: String(project!.ROWID),
        template: await loadProjectTemplate(repo, String(franchisee.franchise_type || "QSR")),
        startDate: dateOnly(now),
        dependencies: settings.projects_dependencies,
      });
    });
  }

  const after = await repo.getById("franchise_projects", String(project.ROWID));
  const result: OnboardingResult = {
    project_id: String(project.ROWID),
    zoho_account_id: (franchisee.zoho_account_id as string) ?? null,
    zoho_contact_id: (franchisee.zoho_contact_id as string) ?? null,
    document_ref: (agreement.document_ref as string) ?? null,
    zoho_books_customer_id: (franchisee.zoho_books_customer_id as string) ?? null,
    zoho_books_invoice_id: invoiceId,
    zoho_project_id: (after.zoho_project_id as string) ?? null,
    tasks_created: (build as { tasksCreated: number } | null)?.tasksCreated ?? 0,
    pending,
  };
  if (pending.length) throw new ProviderError(`Onboarding incomplete: ${failures.join("; ")}`, 502);
  return result;
}

/** The tenant's latest ACTIVE project template for a franchise type. */
export async function loadProjectTemplate(repo: TenantRepo, franchiseType: string): Promise<TemplateTask[]> {
  const templates = await repo.findMany("project_templates", { franchise_type: franchiseType, status: "ACTIVE" }, { orderBy: "version", desc: true, limit: 1 });
  if (!templates[0]) throw new AppError("PROJECT_CREATION_FAILED", `No active ${franchiseType} project template.`);
  const rows = await repo.findMany("project_template_tasks", { template_id: String(templates[0].ROWID) }, { limit: 300 });
  if (!rows.length) throw new AppError("PROJECT_CREATION_FAILED", "The project template has no tasks.");
  return rows.map((r) => ({
    code: String(r.code), name: String(r.name), category: String(r.category), mandatory: toBool(r.mandatory),
    weight: r.weight == null ? 1 : toNum(r.weight), offset_days: toNum(r.offset_days),
    depends_on: JSON.parse(String(r.depends_on_json || "[]")) as string[],
  }));
}

/**
 * A store that opened makes its application ACTIVE and its franchisee ACTIVE, and records the
 * opening date on the CRM Account. CRM failures are logged, never block the opening.
 */
export async function activateOnOpening(
  store: Store,
  ctx: TenantContext,
  crm: ZohoCrmClient | null,
  args: { projectId: string } & Deps,
): Promise<{ application_status: string; franchisee_status: string }> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const project = await repo.getById("franchise_projects", args.projectId);
  if (project.status !== "OPENED") throw new AppError("INVALID_TRANSITION", `Project is ${project.status}, not opened.`);
  let app = await repo.getById("franchise_applications", String(project.application_id));
  if (app.status === "ONBOARDING") {
    app = await transitionEntity("application", String(app.ROWID), "activate", ctx, { store, permissions: async () => new Set(["system.opening"]), onTransition: args.onTransition });
  }
  let franchisee = await repo.getById("franchisees", String(project.franchisee_id));
  if (franchisee.status !== "ACTIVE") {
    franchisee = await repo.update("franchisees", String(franchisee.ROWID), { status: "ACTIVE" });
    await logActivity(store, ctx, { entityType: "franchisee", entityId: String(franchisee.ROWID), action: "activate:opened", metadata: { project_id: args.projectId } });
  }
  if (crm && franchisee.zoho_account_id) {
    await crm.updateAccount(String(franchisee.zoho_account_id), { [CRM_ACCOUNT_FIELDS.openedOn]: String(project.actual_opening_date ?? "").slice(0, 10) || null })
      .catch((e) => log("warn", "crm.opening_push_failed", { tenant_id: ctx.tenantId, request_id: ctx.requestId, error: String((e as Error)?.message ?? e).slice(0, 300) }));
  }
  return { application_status: String(app.status), franchisee_status: String(franchisee.status) };
}

import { TenantContext } from "../common/context";
import { logActivity } from "../common/audit";
import { nextBusinessId } from "../common/ids";
import { Row, Store, TenantRepo } from "../common/store";
import { toNum } from "../common/values";
import { ZohoCrmClient } from "../integrations/clients";
import { CRM_LEAD_FIELDS, pushApplicationStatus } from "../integrations/crmSync";
import { processOnce } from "../integrations/idempotency";
import { applyContactChanges, contactFieldsFrom } from "../workflows/crmContacts";

// D-9: a CRM lead reaching the trigger status creates the franchisee and a DRAFT application.
export const DEFAULT_CRM_TRIGGER_STATUS = "Pre-Qualified";
const CLOSED_APP_STATES = ["REJECTED", "WITHDRAWN"];
/** Written to the lead's FOS_Application_Status when the lead cannot become an application yet. */
export const NEEDS_CONTACT = "NEEDS_CONTACT_DETAILS";

export type LeadOutcome =
  | { action: "duplicate" }
  | { action: "ignored"; reason: string }
  | { action: "created" | "existing"; franchisee_id: string; application_id: string; application_code: string; crm_updated: boolean };

function text(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v);
  return s ? s.slice(0, 200) : null;
}

/**
 * Only the lead id is taken from the webhook. Everything else is read back from CRM, so a forged
 * or stale payload cannot inject data, and the event key uses the lead's Modified_Time.
 */
export async function handleCrmLead(
  store: Store,
  ctx: TenantContext,
  crm: ZohoCrmClient,
  args: { leadId: string; triggerStatus?: string; sleep?: (ms: number) => Promise<void> },
): Promise<LeadOutcome> {
  const lead = await crm.getLead(args.leadId);
  const modified = text(lead.Modified_Time) ?? "unknown";
  const res = await processOnce(store, ctx.tenantId, { source: "CRM", eventId: `lead:${modified}`, recordId: args.leadId, payload: { id: args.leadId, modified } }, async () => {
    const trigger = args.triggerStatus ?? DEFAULT_CRM_TRIGGER_STATUS;
    if (lead.Lead_Status !== trigger) return { action: "ignored", reason: `Lead status is ${lead.Lead_Status ?? "empty"}, not ${trigger}.` } as LeadOutcome;
    // A franchisee FOS cannot reach (no email, no phone) would carry blanks into Sign and Books.
    if (!text(lead.Email) && !text(lead.Mobile) && !text(lead.Phone)) {
      if (lead[CRM_LEAD_FIELDS.applicationStatus] !== NEEDS_CONTACT) {
        await crm.updateLead(args.leadId, { [CRM_LEAD_FIELDS.applicationStatus]: NEEDS_CONTACT }).catch(() => undefined);
      }
      return { action: "ignored", reason: "The lead has no email or phone; it is marked NEEDS_CONTACT_DETAILS in CRM." } as LeadOutcome;
    }
    return upsertFromLead(store, ctx, crm, args.leadId, lead, args.sleep);
  });
  return res.duplicate ? { action: "duplicate" } : res.result;
}

async function upsertFromLead(store: Store, ctx: TenantContext, crm: ZohoCrmClient, leadId: string, lead: Row, sleep?: (ms: number) => Promise<void>): Promise<LeadOutcome> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const franchiseType = text(lead[CRM_LEAD_FIELDS.franchiseType]) ?? "QSR";

  let franchisee = await repo.findOne("franchisees", { zoho_lead_id: leadId });
  if (!franchisee) {
    const code = await nextBusinessId(store, ctx.tenantId, "franchisee");
    const name = text(lead.Full_Name) ?? ([text(lead.First_Name), text(lead.Last_Name)].filter(Boolean).join(" ") || null) ?? text(lead.Company);
    franchisee = await repo.insert("franchisees", {
      franchise_code: code, tenant_code_key: `${ctx.tenantId}:${code}`, display_name: name ?? "Unnamed lead",
      legal_name: text(lead.Company), email: text(lead.Email), phone: text(lead.Mobile) ?? text(lead.Phone),
      status: "PROSPECT", franchise_type: franchiseType, zoho_lead_id: leadId,
    });
    await logActivity(store, ctx, { entityType: "franchisee", entityId: String(franchisee.ROWID), action: "create:crm", metadata: { lead_id: leadId } });
  } else if (!franchisee.zoho_contact_id) {
    // Before conversion the lead is where contact details are kept, so its edits come across.
    const changed = await applyContactChanges(store, ctx, franchisee, contactFieldsFrom({ lead }), "crm_lead");
    if (changed.length) franchisee = { ...franchisee, ...contactFieldsFrom({ lead }) };
  }

  const apps = await repo.findMany("franchise_applications", { zoho_lead_id: leadId });
  let app = apps.find((a) => !CLOSED_APP_STATES.includes(String(a.status)));
  let action: "created" | "existing" = "existing";
  if (!app) {
    const code = await nextBusinessId(store, ctx.tenantId, "application");
    const capacity = lead[CRM_LEAD_FIELDS.investmentCapacity];
    app = await repo.insert("franchise_applications", {
      application_code: code, tenant_code_key: `${ctx.tenantId}:${code}`, franchisee_id: String(franchisee.ROWID),
      application_type: "UNIT", status: "DRAFT", zoho_lead_id: leadId,
      preferred_country: text(lead.Country), preferred_state: text(lead[CRM_LEAD_FIELDS.preferredState]) ?? text(lead.State),
      preferred_city: text(lead[CRM_LEAD_FIELDS.preferredCity]) ?? text(lead.City),
      investment_capacity: capacity == null || capacity === "" ? null : toNum(capacity),
    });
    action = "created";
    await logActivity(store, ctx, { entityType: "application", entityId: String(app.ROWID), action: "create:crm", metadata: { lead_id: leadId } });
  }

  const crm_updated = await pushApplicationStatus(store, ctx, crm, app, { sleep });
  return { action, franchisee_id: String(franchisee.ROWID), application_id: String(app.ROWID), application_code: String(app.application_code), crm_updated };
}

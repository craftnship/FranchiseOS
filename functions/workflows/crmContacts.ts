import { TenantContext } from "../common/context";
import { logActivity } from "../common/audit";
import { log } from "../common/logger";
import { Row, Store, TenantRepo } from "../common/store";
import { ZohoCrmClient } from "../integrations/clients";

// CRM edits → FOS (two-way sync). After intake, contact details are maintained in CRM: on the lead
// until it is converted at signing, then on the Contact (person) and Account (company). FOS copies
// them onto the franchisee so Sign, Books and the portal use current details. Blank CRM values
// never wipe what FOS has.

const text = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
  return s ? s.slice(0, 200) : null;
};

const personName = (r: Row) => text(r.Full_Name) ?? ([text(r.First_Name), text(r.Last_Name)].filter(Boolean).join(" ") || null);

/** The franchisee fields a CRM record speaks for. */
export function contactFieldsFrom(source: { lead?: Row | null; contact?: Row | null; account?: Row | null }): Partial<Record<"display_name" | "legal_name" | "email" | "phone", string>> {
  const out: Partial<Record<"display_name" | "legal_name" | "email" | "phone", string>> = {};
  const person = source.contact ?? source.lead ?? null;
  const set = (k: keyof typeof out, v: string | null) => { if (v) out[k] = v; };
  if (person) {
    set("display_name", personName(person));
    set("email", text(person.Email));
    set("phone", text(person.Mobile) ?? text(person.Phone));
  }
  // An Account made without a lead has no Contact; its own phone stands in.
  if (!person && source.account) set("phone", text(source.account.Phone));
  set("legal_name", source.account ? text(source.account.Account_Name) : source.lead ? text(source.lead.Company) : null);
  return out;
}

/** Writes the fields that differ, with an activity entry naming them. Returns the changed field names. */
export async function applyContactChanges(store: Store, ctx: TenantContext, franchisee: Row, fields: ReturnType<typeof contactFieldsFrom>, source: string): Promise<string[]> {
  const changed = Object.entries(fields).filter(([k, v]) => v !== (franchisee[k] == null ? null : String(franchisee[k])));
  if (!changed.length) return [];
  const patch = Object.fromEntries(changed);
  await new TenantRepo(store, ctx.tenantId).update("franchisees", String(franchisee.ROWID), patch);
  await logActivity(store, ctx, {
    entityType: "franchisee", entityId: String(franchisee.ROWID), action: "update:crm",
    metadata: { source, changes: Object.fromEntries(changed.map(([k, v]) => [k, { from: franchisee[k] ?? null, to: v }])) },
  });
  return changed.map(([k]) => k);
}

/** Reads one franchisee's CRM records and copies any changed contact details. */
export async function pullFranchiseeContact(store: Store, ctx: TenantContext, crm: ZohoCrmClient, franchisee: Row): Promise<string[]> {
  if (franchisee.zoho_contact_id || franchisee.zoho_account_id) {
    const [contact, account] = await Promise.all([
      franchisee.zoho_contact_id ? crm.getContact(String(franchisee.zoho_contact_id)) : null,
      franchisee.zoho_account_id ? crm.getAccount(String(franchisee.zoho_account_id)) : null,
    ]);
    return applyContactChanges(store, ctx, franchisee, contactFieldsFrom({ contact, account }), "crm_contact");
  }
  if (franchisee.zoho_lead_id) {
    return applyContactChanges(store, ctx, franchisee, contactFieldsFrom({ lead: await crm.getLead(String(franchisee.zoho_lead_id)) }), "crm_lead");
  }
  return [];
}

/** Every CRM-linked franchisee of one tenant; one failure never stops the rest. */
export async function syncTenantContacts(store: Store, ctx: TenantContext, crm: ZohoCrmClient) {
  const repo = new TenantRepo(store, ctx.tenantId);
  const out = { checked: 0, updated: 0, failed: 0 };
  for (let offset = 0; offset < 3000; offset += 300) {
    const rows = await repo.findMany("franchisees", {}, { limit: 300, offset });
    for (const f of rows) {
      if (!f.zoho_lead_id && !f.zoho_account_id && !f.zoho_contact_id) continue;
      out.checked++;
      try {
        if ((await pullFranchiseeContact(store, ctx, crm, f)).length) out.updated++;
      } catch (e) {
        out.failed++;
        log("warn", "crm.contact_sync_failed", { tenant_id: ctx.tenantId, request_id: ctx.requestId, franchisee_id: String(f.ROWID), error: String((e as Error)?.message ?? e).slice(0, 300) });
      }
    }
    if (rows.length < 300) break;
  }
  return out;
}

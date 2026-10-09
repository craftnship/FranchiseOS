// Idempotent tenant bootstrap (plan Step 1). Creates the tenant and its default roles,
// permissions, scoring templates, approval workflow, opening template and territory rule.
// Every insert is find-or-create, so re-running after a partial failure completes the seed.
import { ROLES } from "../../functions/common/rbac";
import { Row, Store } from "../../functions/common/store";
import { DEFAULTS, DEFAULT_APPROVAL_WORKFLOW, DEFAULT_REQUIRED_DOCUMENTS, QSR_PROJECT_TEMPLATE, ROLE_PERMISSIONS } from "./defaults";

export interface TenantSeed {
  tenantCode: string;
  name: string;
  zohoDc: string;
  timezone?: string;
  currency?: string;
  franchiseType?: string;
}

export interface BootstrapResult {
  tenantId: string;
  roleIds: Record<string, string>;
  created: number;
}

const ROLE_NAMES: Record<string, string> = Object.fromEntries(
  ROLES.map((r) => [r, r.split("_").map((w) => w[0] + w.slice(1).toLowerCase()).join(" ")]),
);

export async function bootstrapTenant(store: Store, seed: TenantSeed): Promise<BootstrapResult> {
  let created = 0;
  const ensure = async (table: string, where: Record<string, string | number>, row: Row): Promise<Row> => {
    const found = await store.findOne(table, where);
    if (found) return found;
    created++;
    return store.insert(table, { ...where, ...row });
  };

  const tenant = await ensure("tenants", { tenant_code: seed.tenantCode }, {
    name: seed.name,
    status: "ACTIVE",
    zoho_dc: seed.zohoDc,
    timezone: seed.timezone ?? "Asia/Kolkata",
    currency: seed.currency ?? "INR",
    settings_json: JSON.stringify({ required_documents: DEFAULT_REQUIRED_DOCUMENTS, qualification_thresholds: DEFAULTS.qualification.thresholds, feasibility_thresholds: DEFAULTS.feasibility.thresholds }),
  });
  const tid = String(tenant.ROWID);
  const type = seed.franchiseType ?? "QSR";

  const roleIds: Record<string, string> = {};
  for (const code of ROLES) {
    const role = await ensure("roles", { tenant_code_key: `${tid}:ROLE:${code}` }, { tenant_id: tid, code, name: ROLE_NAMES[code] });
    roleIds[code] = String(role.ROWID);
  }
  for (const [code, perms] of Object.entries(ROLE_PERMISSIONS)) {
    for (const perm of perms) {
      await ensure("role_permissions", { perm_key: `${tid}:${code}:${perm}` }, { tenant_id: tid, role_id: roleIds[code], permission_code: perm });
    }
  }

  const qt = await ensure("qualification_templates", { tenant_id: tid, franchise_type: type, version: 1 }, {
    status: "ACTIVE",
    hot_threshold: DEFAULTS.qualification.thresholds.hot,
    qualified_threshold: DEFAULTS.qualification.thresholds.qualified,
    nurture_threshold: DEFAULTS.qualification.thresholds.nurture,
  });
  for (const w of DEFAULTS.qualification.weights) {
    await ensure("qualification_template_items", { tenant_id: tid, template_id: String(qt.ROWID), code: w.code }, { name: humanize(w.code), weight: w.weight });
  }

  const et = await ensure("evaluation_templates", { tenant_id: tid, franchise_type: type, version: 1 }, { name: `${type} site evaluation`, status: "ACTIVE" });
  for (const item of DEFAULTS.siteTemplate) {
    await ensure("evaluation_template_items", { tenant_id: tid, template_id: String(et.ROWID), code: item.code }, { name: item.name, weight: item.weight, max_score: item.max_score, mandatory: item.mandatory });
  }

  const wf = DEFAULT_APPROVAL_WORKFLOW;
  const workflow = await ensure("approval_workflows", { tenant_id: tid, code: wf.code, version: wf.version }, { name: wf.name, entity_type: wf.entity_type, status: "ACTIVE" });
  for (const s of wf.steps) {
    await ensure("approval_workflow_steps", { tenant_id: tid, workflow_id: String(workflow.ROWID), sequence: s.sequence }, {
      approver_role: s.approver_role, sla_hours: s.sla_hours, mandatory: s.mandatory, escalation_role: s.escalation_role, condition_json: s.condition_json,
    });
  }

  const pt = await ensure("project_templates", { tenant_id: tid, franchise_type: type, version: 1 }, { name: `${type} store opening`, status: "ACTIVE" });
  for (const t of QSR_PROJECT_TEMPLATE) {
    await ensure("project_template_tasks", { tenant_id: tid, template_id: String(pt.ROWID), code: t.code }, {
      name: t.name, category: t.category, mandatory: t.mandatory, weight: t.weight ?? 1, offset_days: t.offset_days, depends_on_json: JSON.stringify(t.depends_on ?? []),
    });
  }

  // The Zoho Sign template id is set once the tenant has built its agreement template in Sign.
  await ensure("agreement_templates", { tenant_id: tid, franchise_type: type, version: 1 }, { name: `${type} franchise agreement`, status: "ACTIVE", zoho_sign_template_id: null });

  await ensure("territory_rules", { tenant_id: tid, franchise_type: type }, { ...DEFAULTS.territoryRule });

  return { tenantId: tid, roleIds, created };
}

function humanize(code: string): string {
  const s = code.replace(/_/g, " ");
  return s[0].toUpperCase() + s.slice(1);
}

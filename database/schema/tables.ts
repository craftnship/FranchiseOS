// Catalyst Data Store schema for FranchiseOS (plan §6). ROWID, CREATORID, CREATEDTIME and
// MODIFIEDTIME are added automatically by Catalyst and are not listed.
// Foreign keys reference ROWID. "unique" columns are the concurrency locks from D-13.

export type ColType = "varchar" | "text" | "int" | "bigint" | "double" | "boolean" | "date" | "datetime" | "encrypted";

export interface Column { name: string; type: ColType; unique?: boolean; required?: boolean; ref?: string; searchable?: boolean }
export interface Table { name: string; phase: "MVP" | "PHASE2"; columns: Column[] }

const c = (name: string, type: ColType, extra: Partial<Column> = {}): Column => ({ name, type, ...extra });
const tenant = c("tenant_id", "bigint", { required: true, ref: "tenants" });
const fk = (name: string, ref: string, required = true) => c(name, "bigint", { ref, required });
const status = c("status", "varchar", { required: true });
const code = (name: string) => [c(name, "varchar", { required: true, searchable: true }), c("tenant_code_key", "varchar", { unique: true, required: true })];

export const TABLES: Table[] = [
  // Platform
  { name: "tenants", phase: "MVP", columns: [c("tenant_code", "varchar", { unique: true, required: true }), c("name", "varchar", { required: true }), status, c("zoho_dc", "varchar", { required: true }), c("timezone", "varchar"), c("currency", "varchar"), c("settings_json", "text")] },
  { name: "users", phase: "MVP", columns: [tenant, c("email", "varchar", { required: true, searchable: true }), c("name", "varchar"), status, fk("role_id", "roles"), c("external_user_id", "varchar", { unique: true, required: true }), fk("franchisee_id", "franchisees", false)] },
  { name: "roles", phase: "MVP", columns: [tenant, c("code", "varchar", { required: true }), c("name", "varchar"), c("tenant_code_key", "varchar", { unique: true })] },
  { name: "role_permissions", phase: "MVP", columns: [tenant, fk("role_id", "roles"), c("permission_code", "varchar", { required: true }), c("perm_key", "varchar", { unique: true })] },
  { name: "tenant_integrations", phase: "MVP", columns: [tenant, c("provider", "varchar", { required: true }), c("zoho_dc", "varchar"), c("org_id", "varchar"), c("portal_id", "varchar"), c("refresh_token", "encrypted"), c("webhook_secret", "encrypted"), status, c("provider_key", "varchar", { unique: true })] },
  { name: "feature_flags", phase: "MVP", columns: [tenant, c("flag", "varchar", { required: true }), c("enabled", "boolean"), c("flag_key", "varchar", { unique: true })] },
  { name: "id_sequences", phase: "MVP", columns: [tenant, c("prefix", "varchar", { required: true }), c("seq_no", "bigint", { required: true }), c("seq_key", "varchar", { unique: true, required: true })] },

  // Franchisee and application
  { name: "franchisees", phase: "MVP", columns: [tenant, ...code("franchise_code"), c("display_name", "varchar", { searchable: true }), c("legal_name", "varchar"), c("email", "varchar"), c("phone", "varchar"), status, c("franchise_type", "varchar"), c("zoho_lead_id", "varchar"), c("zoho_account_id", "varchar"), c("zoho_contact_id", "varchar"), c("zoho_books_customer_id", "varchar")] },
  { name: "franchise_applications", phase: "MVP", columns: [tenant, ...code("application_code"), fk("franchisee_id", "franchisees"), c("application_type", "varchar"), status, c("held_from", "varchar"), c("preferred_country", "varchar"), c("preferred_state", "varchar"), c("preferred_city", "varchar", { searchable: true }), c("investment_capacity", "double"), c("qualification_score", "double"), c("qualification_class", "varchar"), c("score_breakdown_json", "text"), c("risk_score", "double"), fk("territory_id", "territories", false), fk("site_id", "sites", false), fk("feasibility_id", "feasibility_models", false), fk("owner_user_id", "users", false), c("zoho_lead_id", "varchar")] },
  { name: "application_documents", phase: "MVP", columns: [tenant, fk("application_id", "franchise_applications"), c("document_type", "varchar", { required: true }), c("file_ref", "varchar"), c("document_number", "varchar"), c("issue_date", "date"), c("expiry_date", "date"), c("verification_status", "varchar"), fk("verified_by", "users", false), c("rejection_reason", "text")] },
  { name: "qualification_templates", phase: "MVP", columns: [tenant, c("franchise_type", "varchar"), c("version", "int"), status, c("hot_threshold", "double"), c("qualified_threshold", "double"), c("nurture_threshold", "double")] },
  { name: "qualification_template_items", phase: "MVP", columns: [tenant, fk("template_id", "qualification_templates"), c("code", "varchar"), c("name", "varchar"), c("weight", "double")] },

  // Territory and site
  { name: "territories", phase: "MVP", columns: [tenant, ...code("territory_code"), c("name", "varchar", { searchable: true }), c("country", "varchar"), c("state", "varchar"), c("region", "varchar"), c("city", "varchar", { searchable: true }), c("franchise_type", "varchar"), status, c("opportunity_score", "double"), c("population", "bigint"), c("market_size", "double"), c("income_index", "double"), c("competition_index", "double"), c("latitude", "double"), c("longitude", "double")] },
  { name: "territory_rules", phase: "MVP", columns: [tenant, c("franchise_type", "varchar"), c("territory_level", "varchar"), c("radius_km", "double"), c("exclusive", "boolean"), c("max_locations", "int"), c("reservation_days", "int")] },
  { name: "territory_reservations", phase: "MVP", columns: [tenant, fk("territory_id", "territories"), fk("application_id", "franchise_applications"), fk("reserved_by", "users"), status, c("reserved_at", "datetime"), c("expires_at", "datetime"), c("active_lock_key", "varchar", { unique: true, required: true })] },
  { name: "sites", phase: "MVP", columns: [tenant, ...code("site_code"), fk("application_id", "franchise_applications"), fk("franchisee_id", "franchisees"), fk("territory_id", "territories"), c("address_line_1", "varchar"), c("city", "varchar", { searchable: true }), c("state", "varchar"), c("postal_code", "varchar"), c("latitude", "double"), c("longitude", "double"), c("area_sqft", "double"), c("rent", "double"), c("deposit", "double"), status, c("site_score", "double"), c("recommendation", "varchar")] },
  { name: "evaluation_templates", phase: "MVP", columns: [tenant, c("franchise_type", "varchar"), c("name", "varchar"), c("version", "int"), status] },
  { name: "evaluation_template_items", phase: "MVP", columns: [tenant, fk("template_id", "evaluation_templates"), c("code", "varchar"), c("name", "varchar"), c("weight", "double"), c("max_score", "double"), c("mandatory", "boolean")] },
  { name: "site_evaluations", phase: "MVP", columns: [tenant, fk("site_id", "sites"), fk("template_id", "evaluation_templates"), c("ratings_json", "text"), c("score", "double"), c("recommendation", "varchar"), c("strengths", "text"), c("risks", "text"), c("photo_refs_json", "text"), c("gps_lat", "double"), c("gps_lng", "double"), fk("evaluated_by", "users")] },

  // Feasibility
  { name: "feasibility_models", phase: "MVP", columns: [tenant, fk("application_id", "franchise_applications"), fk("site_id", "sites"), c("currency", "varchar"), c("initial_investment", "double"), c("monthly_revenue", "double"), c("gross_margin_pct", "double"), c("monthly_fixed_opex", "double"), c("royalty_pct", "double"), c("marketing_fund_pct", "double"), c("monthly_opex", "double"), c("monthly_ebitda", "double"), c("annual_ebitda", "double"), c("ebitda_margin_pct", "double"), c("roi_pct", "double"), c("payback_months", "double"), c("passed", "boolean"), c("fail_reasons_json", "text"), status] },
  { name: "feasibility_inputs", phase: "MVP", columns: [tenant, fk("feasibility_id", "feasibility_models"), c("category", "varchar"), c("item", "varchar"), c("amount", "double"), c("assumption", "text")] },
  { name: "feasibility_scenarios", phase: "MVP", columns: [tenant, fk("feasibility_id", "feasibility_models"), c("name", "varchar"), c("revenue_multiplier", "double"), c("cost_multiplier", "double"), c("revenue", "double"), c("ebitda", "double"), c("roi", "double"), c("payback_months", "double")] },

  // Approvals
  { name: "approval_workflows", phase: "MVP", columns: [tenant, c("code", "varchar"), c("name", "varchar"), c("entity_type", "varchar"), status, c("version", "int")] },
  { name: "approval_workflow_steps", phase: "MVP", columns: [tenant, fk("workflow_id", "approval_workflows"), c("sequence", "int"), c("approver_role", "varchar"), c("condition_json", "text"), c("sla_hours", "int"), c("mandatory", "boolean"), c("escalation_role", "varchar")] },
  { name: "approval_instances", phase: "MVP", columns: [tenant, c("entity_type", "varchar"), c("entity_id", "bigint"), fk("workflow_id", "approval_workflows"), c("workflow_version", "int"), c("steps_json", "text"), c("current_step", "int"), c("step_due_at", "datetime"), c("escalated", "boolean"), status, c("active_key", "varchar", { unique: true }), c("started_at", "datetime"), c("completed_at", "datetime")] },
  { name: "approval_actions", phase: "MVP", columns: [tenant, fk("approval_id", "approval_instances"), fk("step_id", "approval_workflow_steps"), fk("actor_user_id", "users"), c("action", "varchar"), c("comments", "text"), c("acted_at", "datetime"), c("action_key", "varchar", { unique: true })] },
  { name: "approval_delegations", phase: "MVP", columns: [tenant, fk("delegator_user_id", "users"), fk("delegate_user_id", "users"), c("role", "varchar"), c("starts_at", "datetime"), c("ends_at", "datetime"), status] },

  // Agreement and project
  { name: "agreement_templates", phase: "MVP", columns: [tenant, c("franchise_type", "varchar"), c("name", "varchar"), c("zoho_sign_template_id", "varchar"), c("version", "int"), status] },
  { name: "agreements", phase: "MVP", columns: [tenant, ...code("agreement_code"), fk("application_id", "franchise_applications"), fk("franchisee_id", "franchisees"), fk("template_id", "agreement_templates"), status, c("zoho_sign_request_id", "varchar", { unique: true }), c("effective_date", "date"), c("expiry_date", "date"), c("signed_at", "datetime"), c("document_ref", "varchar"), c("zoho_books_invoice_id", "varchar")] },
  { name: "project_templates", phase: "MVP", columns: [tenant, c("franchise_type", "varchar"), c("name", "varchar"), c("version", "int"), status] },
  { name: "project_template_tasks", phase: "MVP", columns: [tenant, fk("template_id", "project_templates"), c("code", "varchar"), c("name", "varchar"), c("category", "varchar"), c("mandatory", "boolean"), c("weight", "double"), c("offset_days", "int"), c("depends_on_json", "text")] },
  { name: "franchise_projects", phase: "MVP", columns: [tenant, ...code("project_code"), fk("application_id", "franchise_applications"), fk("franchisee_id", "franchisees"), fk("site_id", "sites"), c("zoho_project_id", "varchar", { unique: true }), status, c("target_opening_date", "date"), c("actual_opening_date", "date"), c("readiness_score", "double"), c("readiness_rag", "varchar"), c("risk_level", "varchar")] },
  { name: "opening_checklists", phase: "MVP", columns: [tenant, fk("project_id", "franchise_projects"), c("task_code", "varchar"), c("category", "varchar"), c("item", "varchar"), c("weight", "double"), c("mandatory", "boolean"), status, c("due_date", "date"), fk("owner_user_id", "users", false), c("external_task_id", "varchar"), c("external_tasklist_id", "varchar"), c("external_status", "varchar"), c("depends_on_json", "text"), c("dependencies_synced", "boolean")] },
  { name: "readiness_snapshots", phase: "MVP", columns: [tenant, fk("project_id", "franchise_projects"), c("score", "double"), c("rag", "varchar"), c("blockers", "int"), c("overdue", "int"), c("taken_at", "datetime")] },

  // Integration, activity, notification
  { name: "integration_events", phase: "MVP", columns: [tenant, c("source_system", "varchar"), c("event_id", "varchar"), c("record_id", "varchar"), c("event_key", "varchar", { unique: true, required: true }), status, c("payload_json", "text"), c("error_message", "text"), c("processed_at", "datetime")] },
  { name: "integration_logs", phase: "MVP", columns: [tenant, c("source_system", "varchar"), c("entity_type", "varchar"), c("entity_id", "varchar"), c("operation", "varchar"), status, c("attempt", "int"), c("request_id", "varchar"), c("external_id", "varchar"), c("error_code", "varchar"), c("error_message", "text")] },
  { name: "activity_logs", phase: "MVP", columns: [tenant, c("entity_type", "varchar"), c("entity_id", "varchar"), c("action", "varchar"), c("actor_user_id", "varchar"), c("metadata_json", "text"), c("created_at", "datetime")] },
  { name: "notifications", phase: "MVP", columns: [tenant, fk("recipient_user_id", "users"), c("channel", "varchar"), c("template_code", "varchar"), c("entity_type", "varchar"), c("entity_id", "varchar"), status, c("sent_at", "datetime")] },

  // Phase 2 (D-17, D-18)
  { name: "funding_plans", phase: "PHASE2", columns: [tenant, fk("application_id", "franchise_applications"), c("own_capital", "double"), c("loan_amount", "double"), c("lender", "varchar"), status, c("milestones_json", "text")] },
  { name: "audits", phase: "PHASE2", columns: [tenant, ...code("audit_code"), fk("franchisee_id", "franchisees"), fk("site_id", "sites"), c("audit_type", "varchar"), status, c("score", "double"), c("audited_at", "datetime"), fk("auditor_user_id", "users")] },
  { name: "audit_items", phase: "PHASE2", columns: [tenant, fk("audit_id", "audits"), c("code", "varchar"), c("result", "varchar"), c("evidence_ref", "varchar"), c("comments", "text")] },
  { name: "corrective_actions", phase: "PHASE2", columns: [tenant, fk("audit_id", "audits"), c("description", "text"), fk("owner_user_id", "users"), c("due_date", "date"), status] },
];

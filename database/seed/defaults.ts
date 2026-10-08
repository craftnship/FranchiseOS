// Default configuration seeded per tenant (plan Step 1). Values come from the spec and accepted decisions.
import { DEFAULT_QUALIFICATION_WEIGHTS, DEFAULT_THRESHOLDS } from "../../functions/scoring/qualification";
import { DEFAULT_SITE_TEMPLATE } from "../../functions/scoring/site";
import { DEFAULT_READINESS_WEIGHTS } from "../../functions/scoring/readiness";
import { DEFAULT_SCENARIOS, DEFAULT_FEASIBILITY_THRESHOLDS } from "../../functions/scoring/feasibility";
import { TemplateTask } from "../../functions/workflows/projectCreation";

export const ROLE_PERMISSIONS: Record<string, string[]> = {
  FRANCHISE_DIRECTOR: ["application.review", "application.reject", "application.activate", "approval.start", "site.approve", "project.open", "dashboard.view"],
  FRANCHISE_MANAGER: ["application.review", "application.reject", "application.withdraw", "approval.start", "site.write", "site.evaluate", "feasibility.write", "agreement.write", "territory.reserve", "dashboard.view"],
  FINANCE_MANAGER: ["feasibility.write", "dashboard.view"],
  LEGAL_MANAGER: ["agreement.write"],
  PROJECT_MANAGER: ["project.write", "project.open", "dashboard.view"],
  TRAINING_MANAGER: ["project.write"],
  OPERATIONS_MANAGER: ["dashboard.view"],
  REGIONAL_MANAGER: ["site.write", "site.evaluate", "territory.reserve"],
  FRANCHISEE: ["application.submit", "application.withdraw", "portal.view"],
  FRANCHISEE_STAFF: ["portal.view"],
  VENDOR: ["portal.view"],
};

// D-11 default franchise approval chain.
export const DEFAULT_APPROVAL_WORKFLOW = {
  code: "FRANCHISE_APPROVAL",
  name: "Franchise approval",
  entity_type: "application",
  version: 1,
  steps: [
    { sequence: 1, approver_role: "FRANCHISE_MANAGER", sla_hours: 48, mandatory: true, escalation_role: "FRANCHISE_DIRECTOR", condition_json: null },
    { sequence: 2, approver_role: "FINANCE_MANAGER", sla_hours: 48, mandatory: false, escalation_role: "FRANCHISE_DIRECTOR",
      condition_json: JSON.stringify({ field: "initial_investment", op: "gt", value: 0 }) }, // tenant raises this threshold
    { sequence: 3, approver_role: "LEGAL_MANAGER", sla_hours: 48, mandatory: true, escalation_role: "FRANCHISE_DIRECTOR", condition_json: null },
    { sequence: 4, approver_role: "FRANCHISE_DIRECTOR", sla_hours: 72, mandatory: true, escalation_role: "SUPER_ADMIN", condition_json: null },
  ],
};

// Pilot QSR opening template (D-12: lease is a mandatory Construction task).
export const QSR_PROJECT_TEMPLATE: TemplateTask[] = [
  { code: "LEASE", name: "Sign lease", category: "CONSTRUCTION", mandatory: true, offset_days: 14 },
  { code: "PERMITS", name: "Obtain building permits", category: "COMPLIANCE", mandatory: true, offset_days: 30, depends_on: ["LEASE"] },
  { code: "FITOUT", name: "Complete fit-out", category: "CONSTRUCTION", mandatory: true, weight: 3, offset_days: 75, depends_on: ["PERMITS"] },
  { code: "EQUIP_ORDER", name: "Order kitchen equipment", category: "EQUIPMENT", mandatory: true, offset_days: 40, depends_on: ["LEASE"] },
  { code: "EQUIP_INSTALL", name: "Install and commission equipment", category: "EQUIPMENT", mandatory: true, offset_days: 85, depends_on: ["FITOUT", "EQUIP_ORDER"] },
  { code: "HIRE_MANAGER", name: "Hire store manager", category: "RECRUITMENT", mandatory: true, offset_days: 50 },
  { code: "HIRE_CREW", name: "Hire crew", category: "RECRUITMENT", mandatory: true, weight: 2, offset_days: 75, depends_on: ["HIRE_MANAGER"] },
  { code: "TRAIN_CREW", name: "Complete crew training", category: "TRAINING", mandatory: true, offset_days: 90, depends_on: ["HIRE_CREW"] },
  { code: "POS", name: "Install POS and network", category: "TECHNOLOGY", mandatory: true, offset_days: 85, depends_on: ["FITOUT"] },
  { code: "FOOD_LICENSE", name: "Obtain food safety licence", category: "COMPLIANCE", mandatory: true, offset_days: 80 },
  { code: "OPENING_STOCK", name: "Receive opening inventory", category: "INVENTORY", mandatory: true, offset_days: 92, depends_on: ["EQUIP_INSTALL"] },
  { code: "LAUNCH_CAMPAIGN", name: "Run launch campaign", category: "MARKETING", mandatory: false, offset_days: 95 },
];

export const DEFAULTS = {
  qualification: { weights: DEFAULT_QUALIFICATION_WEIGHTS, thresholds: DEFAULT_THRESHOLDS },
  siteTemplate: DEFAULT_SITE_TEMPLATE,
  readinessWeights: DEFAULT_READINESS_WEIGHTS,
  feasibility: { scenarios: DEFAULT_SCENARIOS, thresholds: DEFAULT_FEASIBILITY_THRESHOLDS },
  territoryRule: { territory_level: "CITY_ZONE", radius_km: 3, exclusive: true, max_locations: 1, reservation_days: 30 },
};

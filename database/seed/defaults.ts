// Default configuration seeded per tenant (plan Step 1). Values come from the spec and accepted decisions.
import { DEFAULT_QUALIFICATION_WEIGHTS, DEFAULT_THRESHOLDS } from "../../functions/scoring/qualification";
import { DEFAULT_SITE_TEMPLATE } from "../../functions/scoring/site";
import { DEFAULT_READINESS_WEIGHTS } from "../../functions/scoring/readiness";
import { DEFAULT_SCENARIOS, DEFAULT_FEASIBILITY_THRESHOLDS } from "../../functions/scoring/feasibility";
import { TemplateTask } from "../../functions/workflows/projectCreation";

export const ROLE_PERMISSIONS: Record<string, string[]> = {
  FRANCHISE_DIRECTOR: ["application.review", "application.reject", "application.activate", "approval.start", "site.approve", "project.open", "dashboard.view", "finance.view"],
  FRANCHISE_MANAGER: ["application.review", "application.reject", "application.withdraw", "approval.start", "site.write", "site.evaluate", "feasibility.write", "agreement.write", "territory.reserve", "territory.write", "dashboard.view"],
  FINANCE_MANAGER: ["feasibility.write", "dashboard.view", "finance.view"],
  LEGAL_MANAGER: ["agreement.write"],
  PROJECT_MANAGER: ["project.write", "project.open", "dashboard.view"],
  TRAINING_MANAGER: ["project.write"],
  OPERATIONS_MANAGER: ["dashboard.view"],
  REGIONAL_MANAGER: ["site.write", "site.evaluate", "territory.reserve", "territory.write", "dashboard.view"],
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
  { code: "DESIGN", name: "Get store design approved", category: "CONSTRUCTION", mandatory: true, offset_days: 25, depends_on: ["LEASE"] },
  { code: "FITOUT", name: "Complete fit-out", category: "CONSTRUCTION", mandatory: true, weight: 3, offset_days: 75, depends_on: ["PERMITS", "DESIGN"] },
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

/** Documents an application needs before submit, unless the tenant overrides required_documents. */
export const DEFAULT_REQUIRED_DOCUMENTS = ["ID_PROOF", "ADDRESS_PROOF", "BANK_STATEMENT"];

export const DEFAULTS = {
  qualification: { weights: DEFAULT_QUALIFICATION_WEIGHTS, thresholds: DEFAULT_THRESHOLDS },
  siteTemplate: DEFAULT_SITE_TEMPLATE,
  readinessWeights: DEFAULT_READINESS_WEIGHTS,
  feasibility: { scenarios: DEFAULT_SCENARIOS, thresholds: DEFAULT_FEASIBILITY_THRESHOLDS },
  territoryRule: { territory_level: "CITY_ZONE", radius_km: 3, exclusive: true, max_locations: 1, reservation_days: 30 },
  // Step 5. franchise_fee 0 means no Books invoice until the tenant sets its fee (D-17).
  onboarding: { agreement_term_years: 5, opening_target_days: 120, franchise_fee: 0, projects_dependencies: false, books_payment_terms: 15, books_email_invoice: true },
  // The franchise fee schedule (funding.ts): shares of the fee and when each is invoiced. One
  // instalment on signing keeps the single fee invoice; a refundable security deposit is optional.
  // Store audits (audits.ts): brand standards an opened store is scored on. Weight counts toward the
  // score; a failed critical item fails the audit whatever the score.
  audits: {
    every_days: 90, first_within_days: 30, pass_score: 85, amber_score: 70, action_days: 14, critical_action_days: 3, follow_up_days: 30,
    standards: [
      { code: "FS_TEMPS", section: "Food safety", text: "Fridge, freezer and hot-holding temperatures are logged and in range", weight: 3, critical: true },
      { code: "FS_DATES", section: "Food safety", text: "All prepared food is date-labelled and nothing is past its use-by", weight: 3, critical: true },
      { code: "FS_HANDWASH", section: "Food safety", text: "Hand-wash stations are stocked and staff wash hands between tasks", weight: 2, critical: true },
      { code: "FS_PESTS", section: "Food safety", text: "No sign of pests; the pest-control log is current", weight: 3, critical: true },
      { code: "CL_KITCHEN", section: "Cleanliness", text: "Kitchen surfaces, equipment and floors are clean", weight: 2, critical: false },
      { code: "CL_DINING", section: "Cleanliness", text: "Dining area, tables and washrooms are clean and stocked", weight: 2, critical: false },
      { code: "CL_SCHEDULE", section: "Cleanliness", text: "The cleaning schedule is followed and signed off", weight: 1, critical: false },
      { code: "BR_SIGNAGE", section: "Brand", text: "Signage, menu boards and lighting are working and current", weight: 1, critical: false },
      { code: "BR_MENU", section: "Brand", text: "Only the approved menu and prices are on sale", weight: 2, critical: false },
      { code: "BR_UNIFORM", section: "Brand", text: "Staff are in full, clean uniform with name badges", weight: 1, critical: false },
      { code: "PR_RECIPE", section: "Product", text: "Products are made to recipe and portion spec", weight: 3, critical: false },
      { code: "PR_QUALITY", section: "Product", text: "A test order meets taste, temperature and presentation standards", weight: 2, critical: false },
      { code: "SV_SPEED", section: "Service", text: "Orders are served within the target time", weight: 2, critical: false },
      { code: "SV_GREETING", section: "Service", text: "Guests are greeted and thanked; complaints are handled by the book", weight: 1, critical: false },
      { code: "OP_LICENCES", section: "Operations", text: "Licences and certificates are valid and displayed", weight: 2, critical: true },
      { code: "OP_CASH", section: "Operations", text: "Cash handling and the POS day-end follow procedure", weight: 2, critical: false },
      { code: "OP_SAFETY", section: "Operations", text: "Fire extinguishers are in date and exits are clear", weight: 2, critical: true },
      { code: "PE_TRAINING", section: "People", text: "Every staff member on shift has finished food-safety training", weight: 2, critical: false },
    ],
  },
  fees: { plan: [{ kind: "FEE", label: "On signing", pct: 100, trigger: "SIGNING" }], security_deposit: 0 },
  // Opening day (launch.ts): the grand-opening plan, dated from the grand-opening day (negative is
  // before it); the weekly sales watch for a new store's first weeks against its feasibility revenue,
  // ramped up week by week; and when agreement renewal reminders start.
  launch: {
    watch_weeks: 12, on_track_pct: 85, behind_pct: 70,
    ramp: [0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1, 1, 1, 1, 1, 1],
    plan: [
      { code: "MKT_PLAN", item: "Agree the local launch marketing plan and budget", owner: "BRAND", offset_days: -28 },
      { code: "LISTINGS", item: "Set up Google Business and delivery-app listings", owner: "FRANCHISEE", offset_days: -21 },
      { code: "INVITES", item: "Invite local press, influencers and neighbours", owner: "FRANCHISEE", offset_days: -14 },
      { code: "PRINT", item: "Print launch flyers, banners and opening-offer vouchers", owner: "FRANCHISEE", offset_days: -14 },
      { code: "SOFT_LAUNCH", item: "Run a soft launch for friends and family", owner: "FRANCHISEE", offset_days: -5 },
      { code: "STOCK_UP", item: "Stock up for twice the expected opening-week demand", owner: "FRANCHISEE", offset_days: -3 },
      { code: "ROSTER", item: "Publish the opening-week roster with extra crew", owner: "FRANCHISEE", offset_days: -3 },
      { code: "BRAND_TEAM", item: "Brand support team on site", owner: "BRAND", offset_days: 0 },
      { code: "EVENT", item: "Grand-opening event and ribbon cutting", owner: "FRANCHISEE", offset_days: 0 },
      { code: "DEBRIEF", item: "Opening-day debrief: sales, wait times and issues", owner: "BRAND", offset_days: 1 },
      { code: "REVIEWS", item: "Answer the first online reviews", owner: "FRANCHISEE", offset_days: 7 },
      { code: "CHECK_IN", item: "Two-week check-in with the franchisee", owner: "BRAND", offset_days: 14 },
    ],
    renewal_notice_days: 180,
  },
};

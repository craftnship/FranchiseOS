// State machines from spec §10, extended with accepted decisions D-4 (agreement machine),
// D-5 (negative states), D-6 (site sign-off vs franchise approval) and D-12 (lease as a project task).

export type EntityType = "application" | "site" | "project" | "agreement";

export interface Rule {
  from: string[];
  transition: string;
  /** Target state, or a function for transitions such as "resume" that return to a stored state. */
  to: string | ((entity: Record<string, unknown>) => string);
  permission: string;
  requiredFields?: string[];
  /** Extra fields written with the transition (e.g. held_from). */
  sideFields?: (entity: Record<string, unknown>) => Record<string, unknown>;
}

const APP_OPEN = [
  "DRAFT", "SUBMITTED", "UNDER_REVIEW", "QUALIFIED", "SITE_REQUIRED", "SITE_SUBMITTED",
  "FEASIBILITY_REVIEW", "APPROVAL_PENDING", "APPROVED", "AGREEMENT_PENDING",
];

const application: Rule[] = [
  { from: ["DRAFT"], transition: "submit", to: "SUBMITTED", permission: "application.submit",
    requiredFields: ["franchisee_id", "application_type", "preferred_city", "investment_capacity"] },
  { from: ["SUBMITTED"], transition: "start_review", to: "UNDER_REVIEW", permission: "application.review" },
  { from: ["UNDER_REVIEW"], transition: "qualify", to: "QUALIFIED", permission: "application.review",
    requiredFields: ["qualification_score"] },
  { from: ["QUALIFIED"], transition: "require_site", to: "SITE_REQUIRED", permission: "application.review",
    requiredFields: ["territory_id"] },
  { from: ["SITE_REQUIRED"], transition: "site_submitted", to: "SITE_SUBMITTED", permission: "site.write" },
  { from: ["SITE_SUBMITTED"], transition: "start_feasibility", to: "FEASIBILITY_REVIEW", permission: "feasibility.write" },
  { from: ["FEASIBILITY_REVIEW"], transition: "start_approval", to: "APPROVAL_PENDING", permission: "approval.start",
    requiredFields: ["site_id", "feasibility_id"] },
  // Driven by the approval engine (system permission), never directly by a user.
  { from: ["APPROVAL_PENDING"], transition: "approve", to: "APPROVED", permission: "system.approval" },
  { from: ["APPROVAL_PENDING"], transition: "return", to: "FEASIBILITY_REVIEW", permission: "system.approval" },
  { from: ["APPROVAL_PENDING", "UNDER_REVIEW"], transition: "reject", to: "REJECTED", permission: "application.reject" },
  { from: ["APPROVED"], transition: "send_agreement", to: "AGREEMENT_PENDING", permission: "agreement.write" },
  { from: ["AGREEMENT_PENDING"], transition: "agreement_signed", to: "AGREEMENT_SIGNED", permission: "system.sign" },
  { from: ["AGREEMENT_SIGNED"], transition: "start_onboarding", to: "ONBOARDING", permission: "system.project" },
  // A franchise goes live when its store opens (activateOnOpening), never by hand.
  { from: ["ONBOARDING"], transition: "activate", to: "ACTIVE", permission: "system.opening" },
  { from: APP_OPEN, transition: "withdraw", to: "WITHDRAWN", permission: "application.withdraw" },
  { from: APP_OPEN, transition: "hold", to: "ON_HOLD", permission: "application.review",
    sideFields: (e) => ({ held_from: e.status }) },
  { from: ["ON_HOLD"], transition: "resume", to: (e) => String(e.held_from), permission: "application.review",
    requiredFields: ["held_from"], sideFields: () => ({ held_from: null }) },
];

const SITE_OPEN = ["PROPOSED", "SCREENING", "SITE_VISIT", "EVALUATION", "FEASIBILITY", "APPROVAL_PENDING", "APPROVED", "LEASE_PENDING"];

const site: Rule[] = [
  { from: ["PROPOSED"], transition: "screen", to: "SCREENING", permission: "site.write" },
  { from: ["SCREENING"], transition: "schedule_visit", to: "SITE_VISIT", permission: "site.write" },
  { from: ["SITE_VISIT"], transition: "start_evaluation", to: "EVALUATION", permission: "site.evaluate" },
  { from: ["EVALUATION"], transition: "evaluated", to: "FEASIBILITY", permission: "site.evaluate", requiredFields: ["site_score"] },
  { from: ["FEASIBILITY"], transition: "request_signoff", to: "APPROVAL_PENDING", permission: "site.write" },
  // D-6: lightweight manager sign-off on the site alone.
  { from: ["APPROVAL_PENDING"], transition: "approve", to: "APPROVED", permission: "site.approve" },
  { from: ["APPROVAL_PENDING"], transition: "return", to: "EVALUATION", permission: "site.approve" },
  { from: ["SCREENING", "EVALUATION", "APPROVAL_PENDING"], transition: "reject", to: "REJECTED", permission: "site.approve" },
  { from: ["APPROVED"], transition: "start_lease", to: "LEASE_PENDING", permission: "site.write" },
  { from: ["LEASE_PENDING"], transition: "lease_signed", to: "LEASE_SIGNED", permission: "site.write" },
  { from: ["LEASE_SIGNED"], transition: "ready", to: "READY_FOR_PROJECT", permission: "site.write" },
  { from: SITE_OPEN, transition: "drop", to: "DROPPED", permission: "site.write" },
];

const project: Rule[] = [
  { from: ["NOT_STARTED"], transition: "plan", to: "PLANNING", permission: "system.project", requiredFields: ["zoho_project_id"] },
  { from: ["PLANNING"], transition: "start", to: "IN_PROGRESS", permission: "project.write" },
  { from: ["IN_PROGRESS"], transition: "flag_risk", to: "AT_RISK", permission: "system.project" },
  { from: ["AT_RISK"], transition: "clear_risk", to: "IN_PROGRESS", permission: "system.project" },
  { from: ["IN_PROGRESS"], transition: "ready_for_opening", to: "READY_FOR_OPENING", permission: "project.write" },
  { from: ["READY_FOR_OPENING"], transition: "open", to: "OPENED", permission: "project.open", requiredFields: ["actual_opening_date"] },
  { from: ["OPENED"], transition: "close", to: "CLOSED", permission: "project.write" },
];

// D-4: agreement machine (not defined in the spec).
const agreement: Rule[] = [
  { from: ["DRAFT"], transition: "send", to: "SENT", permission: "agreement.write", requiredFields: ["zoho_sign_request_id"] },
  { from: ["SENT"], transition: "viewed", to: "VIEWED", permission: "system.sign" },
  { from: ["SENT", "VIEWED"], transition: "signed", to: "SIGNED", permission: "system.sign" },
  { from: ["SENT", "VIEWED"], transition: "declined", to: "DECLINED", permission: "system.sign" },
  { from: ["SENT", "VIEWED"], transition: "expired", to: "EXPIRED", permission: "system.sign" },
  { from: ["DRAFT", "SENT", "VIEWED"], transition: "void", to: "VOIDED", permission: "agreement.write" },
];

export const STATE_MACHINES: Record<EntityType, Rule[]> = { application, site, project, agreement };

export const ENTITY_TABLE: Record<EntityType, string> = {
  application: "franchise_applications",
  site: "sites",
  project: "franchise_projects",
  agreement: "agreements",
};

export function findRule(entityType: EntityType, fromState: string, transition: string): Rule | undefined {
  return STATE_MACHINES[entityType].find((r) => r.transition === transition && r.from.includes(fromState));
}

/** Transitions from a state with the permission each needs (undefined: no extra permission). */
export function transitionsFrom(entityType: EntityType, fromState: string): { transition: string; permission?: string }[] {
  return STATE_MACHINES[entityType].filter((r) => r.from.includes(fromState)).map((r) => ({ transition: r.transition, permission: r.permission }));
}

export function allowedTransitions(entityType: EntityType, fromState: string): string[] {
  return STATE_MACHINES[entityType].filter((r) => r.from.includes(fromState)).map((r) => r.transition);
}

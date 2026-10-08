# FranchiseOS: Step by Step Implementation Plan

Source: *FranchiseOS Complete Catalyst Implementation Specification* (docx, dated October 8, 2026, status "Implementation Ready").
Prepared: October 8, 2026. This plan supersedes the earlier plan in `/plan/`, which was based on a different document.

Section numbers like §15 refer to the specification.

---

## 1. What we are building, in one paragraph

FranchiseOS is a multi-tenant SaaS app on Zoho Catalyst that runs a franchise brand's expansion pipeline. Catalyst holds the franchise-specific data and rules (applications, territories, sites, feasibility, approvals, readiness). Zoho CRM stays the system of record for leads and contacts, Zoho Sign for signatures, Zoho Projects for opening execution and Zoho Books for accounting (§Executive Summary). The MVP is "done" only when one real lead can travel this path with no manual database edits (§50):

**CRM Lead → Application → Qualification → Territory → Site → Feasibility → Approval → Zoho Sign → Zoho Projects → Opening Readiness → Launch**

## 2. Your 16 lifecycle stages mapped to the spec

The spec covers your full lifecycle, but not all of it in the MVP. Funding is the one stage the spec does not cover at all.

| # | Your stage | Spec module | Phase | Zoho product | Catalyst pieces |
|---|---|---|---|---|---|
| 1 | Lead | CRM sync (§14, FOS-009..015) | MVP | CRM | `fos_crm_webhook`, idempotency table |
| 2 | Qualification | Applications + scoring (§18) | MVP | CRM (status write-back) | `fos_application_*`, portal wizard |
| 3 | Territory | Territories + reservation (§29) | MVP | none | `fos_territory_*`, reservation lock |
| 4 | Franchisee | Franchisee record (§8) | MVP | CRM Account, Books customer | `franchisees` table |
| 5 | Site | Sites + evaluation (§17, §26) | MVP | none | `fos_site_*`, Stratus for photos |
| 6 | Financial feasibility | Feasibility model (§16) | MVP | none | `fos_feasibility_*` |
| 7 | Approval | Approval engine (§19) | MVP | none | `fos_approval_*`, SLA job |
| 8 | Agreement | Agreements (§15) | MVP | Sign | `fos_agreement_create`, Sign webhook |
| 9 | Funding | **Not in spec** | Proposed: Phase 2 | Books (fees, invoices) | new `funding_plans` table (see D-17) |
| 10 | Construction | Readiness category "Construction" 20% (§20) | MVP (as tasks) | Projects | `fos_project_*`, readiness |
| 11 | Hiring | Readiness category "Recruitment" 15% | MVP (as tasks) | Projects; Zoho Recruit later | readiness |
| 12 | Training | Readiness category "Training" 10%; full module Phase 2 (§44) | MVP tasks, Phase 2 module | Projects; Zoho Learn/TrainerCentral later | readiness |
| 13 | Launch | Project `OPENED` state (§10) | MVP | Projects | project state machine |
| 14 | Operations | Phase 2 (§44) | Phase 2 | Desk (support), Books (royalties) | new module |
| 15 | Audit | Audits + corrective actions (§11 APIs) | Phase 2 | none | new `audits` tables |
| 16 | Renewal | Renewal pipeline (§22 job) | Phase 3 | Sign (renewal agreement) | `job_renewal_pipeline` |

## 3. Architecture on Catalyst

| Need (spec) | Catalyst service | Notes |
|---|---|---|
| React + TS + Vite corporate UI and franchisee portal (§5, §23, §25) | Slate (or Web Client Hosting) | One app, two route trees: corporate and `/portal`. PWA for site-visit mode. |
| REST `/api/v1` (§11) | API Gateway + Advanced I/O functions | Recommend one Advanced I/O function per domain with an Express router, not one function per endpoint (see D-14). |
| Auth (§6, FOS-003) | Catalyst Authentication | Map Catalyst user → `users.external_user_id` → tenant and role. |
| Domain data (§8) | Data Store | Real column types and unique constraints defined in §6 below. |
| Documents, site photos (§6, §26) | Stratus | Store only the object key in `file_ref`; serve with signed URLs. |
| Dashboard/config cache (§4) | Cache | Disposable; short TTL. |
| Global search (§4) | Search | Index code, name, city columns. |
| Scheduled jobs (§22) | Job Scheduling (Job functions) | Verify current Job Scheduling docs at build time (Appendix B). |
| CRM and Sign webhooks (§14) | Advanced I/O function behind API Gateway, or Signals with Zoho CRM as publisher | Signals is worth trying for CRM events; Sign still needs a webhook. |
| Email notifications | Catalyst Mail | Channel not specified in the spec (D-21). |
| OAuth to Zoho apps (§6) | Custom per-tenant OAuth, tokens in encrypted columns | Catalyst Connections are project-level, so they suit a single pilot tenant only (D-2). |
| AI insights (§21, §43) | Deferred | Not in the MVP module list (D-20). |
| Analytics (§4) | Zoho Analytics | Phase 2. MVP dashboards come from the `/dashboard/*` APIs. |

Shared backend building blocks, built once in Step 1 and used everywhere:

1. `withRequest` middleware: request_id, correlation_id, structured JSON logging (§28), uniform success/error envelope (§11).
2. `resolveTenant`: authenticated user → `TenantContext {tenantId, userId, roles, zohoDc}` (§39). Never read tenant_id from the request.
3. `authorize(permission)`: server-side RBAC from `role_permissions`.
4. `repo`: a Data Store wrapper that injects `tenant_id` into every ZCQL query and refuses to run a query without it.
5. `transitionEntity` state engine (§40) with declarative rules per entity.
6. `audit.log` → `activity_logs`.
7. `nextBusinessId(prefix)` for FR-/APP-/TER-/SITE-/AGR-/PROJ-/AUD- codes (§9).
8. `ZohoRegionResolver` + provider adapters (CRM, Projects, Sign, Books) with retry, backoff and dead-letter (§13, §29, §37).

## 4. Before Step 1: what I need from you

1. **Zoho data center** for the Catalyst project (US, EU, IN, AU, JP, CA, SA, UAE). This also decides where every tenant's data lives (D-3).
2. **Pilot tenant**: the brand and franchise type for the design-partner customer (the spec suggests restaurant/QSR, §45).
3. **Zoho org access** for that tenant: CRM, Sign, Projects, Books admin accounts (Projects portal ID, Books organization ID).
4. **A Git repository** to build in (none is attached to this project yet).
5. Answers, or a "go with the defaults", for the open decisions in §7.

## 5. The step by step plan

Each step lists what gets built, the backlog stories from Appendix A (the canonical numbering, see D-1), and the exit check. The 12-week cadence from §33 is kept.

### Step 0: Setup and decisions (before week 1)
- Confirm defaults in §7, pick the DC, create Development and Production environments.
- Create the repo with the §38 layout: `client/`, `functions/{api,webhooks,integrations,workflows,scoring,scheduled,common}`, `database/{schema,seed,migrations}`, `docs/`, `tests/{unit,integration,e2e}`.
- CI: lint, typecheck, unit tests, TypeScript build to JS (Catalyst runs Node, so functions ship compiled), deploy to Development.
- **Exit:** empty Catalyst project deploys from CI to Development repeatably (FOS-001).

### Step 1: Platform foundation (weeks 1–2) — FOS-001..008
1. Create all Data Store tables from §6 of this plan, including the tables the spec references but never defines.
2. Seed: roles (§7), permissions, default evaluation template (§17 weights), default qualification weights (§18), default readiness weights (§20), default approval workflow (D-11), project template for the pilot franchise type.
3. Catalyst Authentication, user-to-tenant mapping, `resolveTenant`, RBAC.
4. API Gateway routes for `/api/v1/*`, with webhooks on separate unauthenticated routes protected by a shared secret.
5. Logging, error codes (§27), audit trail, business ID generator.
- **Exit:** unauthenticated call returns `AUTH_REQUIRED`; user of tenant A cannot read any row of tenant B (automated test); two concurrent ID requests never return the same code.

### Step 2: CRM and Applications (weeks 3–4) — FOS-009..021
1. Per-tenant Zoho OAuth (or a Catalyst Connection for the single pilot), region-aware CRM adapter.
2. CRM webhook → `integration_events` idempotency check → create or update franchisee + application (D-9 for the trigger), write status back to the CRM Lead.
3. Application CRUD, document checklist with Stratus upload, submission validation (`APPLICATION_DOCUMENT_MISSING`).
4. Franchisee portal: application wizard Business → Personal → Financial → Experience → Territory → Documents → Review → Submit (§25).
5. Qualification scoring with configurable weights that must total 100%, and Hot/Qualified/Nurture/Low classification (§18).
6. Generic state engine applied to Application, including the reject/return/withdraw states the spec leaves out (D-5).
- **Exit:** the same CRM event sent twice creates one application; a submitted application gets a persisted score and class.

### Step 3: Territory and Site (weeks 5–6) — FOS-022..031
1. Territory CRUD, territory rules (radius, exclusivity, max locations, reservation days), eligibility search by tenant and franchise type.
2. Reservation with conflict protection: only one request can move AVAILABLE → RESERVED (D-13 for the mechanism); release; auto-expiry job.
3. Opportunity scoring for territories (formula not given in spec, D-16).
4. Site CRUD, map/location, evaluation templates (weights total 100%), server-side weighted site score and recommendation (§17).
5. Site-visit mode in the PWA: GPS, camera to Stratus, footfall/visibility/parking inputs, submit (§26).
6. Site approval endpoint.
- **Exit:** 50 parallel reservation requests on one territory produce exactly one success and 49 `TERRITORY_CONFLICT`; a regional manager completes an evaluation on a phone.

### Step 4: Feasibility and Approval (weeks 7–8) — FOS-032..044
1. Feasibility inputs by category, calculation per §16 (gross profit, EBITDA, EBITDA margin, ROI, payback), scenarios with revenue and cost multipliers (base, best, worst).
2. Feasibility guardrails: pass/fail thresholds and the zero/negative EBITDA case (D-15).
3. Approval engine (§19, §41): versioned workflow config, condition evaluation, instance pinned to workflow version, inbox, approve/reject/return, delegation, SLA timers and escalation job.
- **Exit:** only the current authorised approver can act; replaying an action on a completed step is rejected; changing config mid-flight does not affect running instances.

### Step 5: Agreement and Opening Project (weeks 9–10) — FOS-045..057
1. Zoho Sign adapter, agreement templates, create and send request, store `zoho_sign_request_id`.
2. Sign webhook processed idempotently; on signed: agreement SIGNED, application AGREEMENT_SIGNED, CRM Account created/updated, Books customer created (and franchise fee invoice if D-17 says so).
3. Project creation (§15): resolve template by franchise type → create Zoho Project → persist ID → task lists → tasks → dependencies → persist task IDs. Each sub-step is checkpointed so a failure retries only that step, never the whole project.
4. Project sync job: pull task status from Projects into `opening_checklists`.
- **Exit:** a simulated "signed" callback, replayed three times, creates exactly one project with all tasks; killing the run halfway and retrying finishes the same project.

### Step 6: Readiness, portal, dashboards, golden E2E (weeks 11–12) — FOS-058..063
1. Readiness engine: weighted completion by category (§20) plus blocker and overdue rules (D-7), Green ≥85 / Amber 70–84 / Red <70.
2. Project risk job (overdue tasks, blockers), notifications.
3. Franchisee portal: site, agreement, project and "next action" views, own records only.
4. Executive dashboards: network, pipeline/funnel, openings, risk, each KPI drilling into filtered records (§24).
5. Global search.
6. Golden E2E (§32) in staging, then the launch gates (§49).
- **Exit:** the golden path passes in staging with no manual database edits. This is the MVP release gate.

### Step 7: Pilot and production
Staging → integration tests → golden E2E → UAT with the design partner → feature-flagged production → limited pilot → GA (§36), with the monitoring targets in §35 (≥99.5% core API success, zero unexplained dead letters, tested backup/recovery).

### Later phases (after the MVP is proven, §44)
- **Phase 2:** Funding (proposed), Training, Launch, Operations, Audits and Corrective Actions, Compliance, Zoho Analytics feed, Zoho Desk for franchisee support.
- **Phase 3:** Performance, Renewal (agreement expiry → renewal work → new Sign request), Expansion, Franchise Health.
- **Phase 4:** Territory Intelligence, failure prediction, next-location recommendation, AI insights beyond the assistive explanations.

## 6. Data model: what to create

The spec lists every column as `string/json/number/date` with the same note, so real types must be chosen. Proposed Catalyst Data Store types are below. Every table also gets Catalyst's automatic ROWID, CREATORID, CREATEDTIME and MODIFIEDTIME.

**Defined in the spec (26 tables):** tenants, users, roles, role_permissions, franchisees, franchise_applications, application_documents, territories, territory_rules, sites, evaluation_templates, evaluation_template_items, site_evaluations, feasibility_models, feasibility_inputs, feasibility_scenarios, approval_workflows, approval_workflow_steps, approval_instances, approval_actions, agreements, franchise_projects, opening_checklists, integration_logs, activity_logs, notifications.

Type conventions:
- Business codes (`*_code`): varchar, unique per tenant (enforced with a composite `tenant_code_key` unique column, because Data Store uniqueness is per column).
- Foreign keys between our tables: Foreign Key columns to ROWID (not to business codes).
- Money: double, with the currency on the parent row. Percentages stored as 0–100 doubles.
- Scores: double 0–100. Weights: double, validated to total 100.
- Status fields: varchar validated against the state machine enum in code.
- `*_json`, `strengths`, `risks`, `metadata_json`, `condition_json`: text holding JSON.
- Dates: `date` for business dates (`target_opening_date`, `expiry_date`), `datetime` for events (`signed_at`, `acted_at`).
- Flags (`mandatory`, `exclusive`): boolean. Note the Catalyst quirk that booleans can come back as strings; normalise in the repo layer.

**Referenced by the spec but missing from its data model (add these):**

| Table | Why it is needed | Spec reference |
|---|---|---|
| `integration_events` | Webhook idempotency key store (unique on source+event+record) | §14 |
| `id_sequences` | Concurrency-safe business IDs | §9 |
| `territory_reservations` | Reservation holder, expiry, unique active lock per territory | §29, `reservation_days` |
| `qualification_templates` / `_items` | Configurable qualification weights and thresholds | §18, FOS-020 |
| `agreement_templates` | Sign template per franchise type | FOS-046 |
| `project_templates` / `_tasks` | Task lists, tasks, dependencies, readiness category, weight, mandatory flag | §15, FOS-052 |
| `approval_delegations` | Delegate approver for a date range | FOS-043 |
| `tenant_integrations` | Per-tenant Zoho DC, org/portal IDs, encrypted refresh tokens | §6, §37 |
| `readiness_snapshots` | History of readiness score for trend and delay dashboards | §24 |
| `feature_flags` | Per-tenant module flags | §36 |
| `audits`, `audit_items`, `corrective_actions` | Field audits (AUD- IDs and `/audits` APIs exist, tables do not) | §9, §11 (Phase 2) |
| `funding_plans` | Your "Funding" stage (proposed) | not in spec (Phase 2) |

## 7. Contradictions and open decisions

**Status: all 23 defaults accepted by Santa on October 8, 2026.** These are now decisions, not proposals.

| ID | Issue found in the spec | Recommended default |
|---|---|---|
| D-1 | **Story IDs disagree.** §34 acceptance criteria use different numbers from Appendix A (e.g. §34 FOS-048 is "Portal" but Appendix A FOS-048 is "send signature"; §34 FOS-052 is "E2E" but Appendix A FOS-052 is "project templates"). §33 ends at FOS-052 while Appendix A runs to FOS-063, and §33 puts CRM in weeks 3–4 while Appendix A FOS-009/010 (CRM OAuth/webhook) fall inside the weeks 1–2 range. | Treat Appendix A as the canonical list, re-map §34's criteria onto it by title, and re-cut the weeks as in §5 above. |
| D-2 | **Per-tenant Zoho connections** (§6) versus Catalyst Connections, which are set up per Catalyst project, not per customer. | Build our own per-tenant OAuth flow with tokens in encrypted columns of `tenant_integrations`. Use a Catalyst Connection only for the single pilot tenant if speed matters. |
| D-3 | **Tenant data residency.** `tenants.zoho_dc` lets each tenant's Zoho apps live in any region, but all Catalyst data sits in one Catalyst project DC. | One Catalyst project per region when you sell into a new region; pilot in one DC. |
| D-4 | **Golden E2E expects `Application = APPROVED` after the agreement is signed**, but the state machine moves it to `AGREEMENT_SIGNED`. It also expects `Project = CREATED`, which is not a project state, and `Agreement = SIGNED` with no agreement state machine defined. | E2E expects `AGREEMENT_SIGNED` (then `ONBOARDING`), project `PLANNING` with an external project ID, and a new agreement machine: DRAFT → SENT → VIEWED → SIGNED, plus DECLINED/EXPIRED/VOIDED. |
| D-5 | **No negative states.** The approval engine can reject and return, but Application and Site machines have no REJECTED, RETURNED, WITHDRAWN or ON_HOLD. | Add REJECTED, WITHDRAWN, ON_HOLD to Application; REJECTED, DROPPED to Site; "return" moves back to the previous review state. |
| D-6 | **Two overlapping approvals.** Site has its own FEASIBILITY → APPROVAL_PENDING → APPROVED and `/sites/:id/approve`, while Application also goes through FEASIBILITY_REVIEW → APPROVAL_PENDING. | Site approval is a lightweight manager sign-off on the site alone. The franchise approval (approval engine) runs on the Application and covers franchisee + territory + site + feasibility together. |
| D-7 | **Readiness blockers make every project Red.** §42 treats any mandatory task not yet completed as a blocker and caps the score at 69, so every project stays Red until its last mandatory task closes. §20 also says "minimum Red", which reads as the opposite of a cap. | A blocker is a mandatory task that is overdue or explicitly flagged blocked. A blocker caps the score at 69 (Red). Open-but-on-time mandatory tasks only count toward the weighted score. |
| D-8 | **Readiness data source.** §42 reads tasks straight from Zoho Projects; the data model has `opening_checklists` with weights and mandatory flags. | Sync Projects tasks into `opening_checklists` (weights and flags come from our template, since Projects has no such fields) and compute readiness locally. |
| D-9 | **Where an application starts.** §32 says "Convert / create Application" but doesn't say what CRM event triggers it, or whether the portal can start one without a CRM lead. | A CRM lead reaching a chosen status (e.g. "Application Sent") creates a DRAFT application and invites the prospect to the portal. Portal sign-ups also create a CRM lead, so CRM always has the lead. |
| D-10 | **Qualification depends on territory before territory is chosen.** "Territory Availability" (15%) is scored at qualification, but reservation comes later. | Score it from availability of the applicant's preferred city/state at scoring time; re-score after reservation. |
| D-11 | **No default approval chain.** Roles exist but no steps, SLAs or conditions are given. | Franchise Manager (48h) → Finance Manager (48h) → Legal Manager (48h) → Franchise Director (72h); Finance step mandatory when investment exceeds a tenant threshold; escalate to the next role up. |
| D-12 | **Lease vs project start.** Site goes LEASE_PENDING → LEASE_SIGNED → READY_FOR_PROJECT, but §15 creates the project when the agreement is signed. | Create the project on agreement signed (§15). Lease signing is a mandatory task in the Construction list, so an unsigned lease shows as a blocker. |
| D-13 | **Concurrency on Data Store.** Atomic reservation and safe ID generation (§9, §29) are required, but Data Store has no row locks or multi-statement transactions. | Use unique-column constraints as locks: insert into `territory_reservations` with a unique `active_lock_key`; insert into `id_sequences` with a unique code and retry on collision. Prove it with the parallel test in Step 3. |
| D-14 | **Function inventory doesn't match the API list.** No functions for franchisee CRUD, territory CRUD, approval inbox, audits, or three of the five dashboards; Sign is handled by both `fos_agreement_status` and `fos_sign_webhook`; "Internal" is not a Catalyst function type. | Group by domain into ~10 Advanced I/O functions (applications, territories, sites, feasibility, approvals, agreements, projects, dashboards, webhooks, admin), plus Job functions. Internal helpers are shared modules, not deployed functions. |
| D-15 | **Feasibility gaps.** No pass/fail thresholds although `FEASIBILITY_FAILED` exists; payback is undefined when EBITDA ≤ 0; it is unclear whether stored `ebitda` is monthly or annual; royalties and marketing fund fees, normally the biggest franchise costs, are missing. | Store monthly figures and derive annual. Payback = "not achievable" when EBITDA ≤ 0. Add royalty % and marketing fund % as opex inputs. Tenant thresholds, defaulting to fail when payback > 36 months or ROI < 25%. |
| D-16 | **Unspecified formulas.** Territory opportunity score and site recommendation bands are not defined. | Opportunity = weighted population, market size, income index and inverse competition index (configurable). Site bands: ≥80 Recommend, 65–79 Conditional, <65 Reject. |
| D-17 | **Funding is in your lifecycle but not in the spec**, and the Books adapter is defined but no workflow uses it. | MVP: on agreement signed, create the Books customer and a franchise fee invoice. Phase 2: a Funding module (own capital, loans, disbursement milestones) gated before construction starts. |
| D-18 | **Audits are on the API list** (§11) but are a Phase 2 module and have no tables. "Audit" also means the audit trail. | Leave `/audits` out of the MVP. Call the trail "activity log" in code to avoid the name clash. |
| D-19 | **Jobs missing from §22** that other sections need: reservation expiry, approval SLA escalation, project sync. Also `job_renewal_pipeline` is listed although Renewal is Phase 3. | Add `job_reservation_expiry` (hourly), `job_approval_sla` (hourly), `job_project_sync` (every 30 min). Keep renewal off until Phase 3. |
| D-20 | **AI scope.** `fos_ai_service` is in the inventory, but AI is not in the MVP module list, and no model or provider is named. | Out of MVP. When added, an external LLM behind the schema-validated contract in §43, never changing state. |
| D-21 | **Notification channel** not specified. | Email through Catalyst Mail plus an in-app inbox; WhatsApp/SMS later. |
| D-22 | **Webhook security.** CRM and Sign webhooks hit public endpoints; no verification method is specified. | Shared secret per tenant in the webhook URL or header, plus Sign's own signature check if available (verify at build time). |
| D-23 | **12 weeks is tight** for 63 stories, with portal, notifications, search, dashboards and E2E all in the last two weeks. | Keep the order, but treat site-visit mode, search and the risk dashboard as stretch items so they can slip without blocking the golden path. |

## 8. Risks to watch

- Zoho Projects V3 support for creating task dependencies by API, and Zoho Sign regional endpoints: verify before Step 5 (Appendix B says the same).
- Data Store query limits (ZCQL row caps per query) for dashboards: aggregate with cached summaries if dashboards slow down.
- Per-tenant OAuth (D-2) is the largest piece the spec understates. If the first customer is a single brand, a single-tenant pilot removes it from the critical path.

# FranchiseOS API (`/api/v1`)

Served by one Advanced I/O function, `fos_api` (D-14), source in `functions/api/`. Every route needs a
Catalyst Authentication session; the tenant, user and roles come from the `users` row whose
`external_user_id` matches the signed-in Catalyst user, never from the request. Responses use the
§11 envelope `{ success, data | error, meta.request_id }`.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | /me | signed in | Caller's user, tenant, roles |
| GET | /franchisees | signed in | Portal users see only their own |
| POST | /franchisees | application.review | Issues `FR-` code |
| GET, PATCH | /franchisees/:id | signed in / application.review | |
| GET | /applications | signed in | `status`, `franchisee_id` filters; portal users see their own |
| POST | /applications | application.review, or application.submit for own franchisee | Starts in DRAFT, issues `APP-` code |
| GET, PATCH | /applications/:id | owner or staff | PATCH: portal users only in DRAFT; staff in DRAFT, UNDER_REVIEW, ON_HOLD |
| POST | /applications/:id/documents | owner or staff | Metadata plus Stratus `file_ref` |
| POST | /applications/:id/documents/:docId/verify | application.review | VERIFIED or REJECTED (reason required) |
| POST | /applications/:id/submit | application.submit | Fails with APPLICATION_DOCUMENT_MISSING until `required_documents` are present |
| POST | /applications/:id/score | application.review | §18 weights from the tenant template; D-10 territory availability |
| POST | /applications/:id/transition | per state machine | start_review, qualify, require_site, hold, resume, withdraw, reject |
| POST | /applications/:id/start-approval | approval.start | Needs a calculated, passing feasibility model |
| GET | /territories | territory.reserve | |
| POST | /territories | territory.write | Issues `TER-` code, D-16 opportunity score from 0–100 indices |
| POST | /territories/search | territory.reserve | Sorted by opportunity score |
| POST | /territories/:id/reserve | territory.reserve | Unique lock: concurrent requests get TERRITORY_CONFLICT |
| POST | /territories/:id/release | territory.reserve | |
| GET | /sites | signed in | |
| POST | /sites | site.write, or application.submit for own application | Moves a SITE_REQUIRED application to SITE_SUBMITTED |
| GET, PATCH | /sites/:id | owner or staff / site.write | |
| POST | /sites/:id/evaluate | site.evaluate | §17 template, D-16 bands, moves site to FEASIBILITY |
| POST | /sites/:id/approve | site.approve | D-6 sign-off; REJECT band cannot be approved |
| POST | /sites/:id/transition | per state machine | screen, schedule_visit, start_evaluation, request_signoff, return, reject, start_lease, lease_signed, ready, drop |
| POST | /feasibility | feasibility.write | Moves SITE_SUBMITTED application to FEASIBILITY_REVIEW |
| GET | /feasibility/:id | feasibility.write | With line items and scenarios |
| POST | /feasibility/:id/calculate | feasibility.write | D-15 model, tenant thresholds |
| POST | /feasibility/:id/scenarios | feasibility.write | Best/Base/Worst by default, upserted by name |
| GET | /approvals | signed in | Inbox: steps the caller can act on, including delegations |
| GET | /approvals/:id | approver on the chain | With recorded actions |
| POST | /approvals/:id/approve, /reject, /return | current step's approver | Body `{ step, comments }`; final outcome moves the application |

Not in this release: projects, agreements, dashboards and the Sign webhook (plan Steps 5–6).

## CRM lead intake (D-9)

`POST /webhooks/crm/lead/{TENANT_CODE}` on the `fos_webhooks` function, with header
`x-fos-webhook-secret` (or `?token=`) matching `tenant_integrations.webhook_secret` for provider ZOHO.
Body `{ "lead_id": "<CRM lead id>" }`. Only the id is trusted: the lead is read back from CRM. When its
Lead Status is **Pre-Qualified** (tenant setting `crm_trigger_status`), the lead becomes a franchisee
plus a DRAFT application, and `FOS_Application_Code` / `FOS_Application_Status` are written back to the
lead. Every later application status change is written back too. The same lead edit delivered twice is
processed once (`integration_events`).

CRM Leads custom fields (created 2026-10-08): `Investment_Capacity`, `Franchise_Type`, `Preferred_City`,
`Preferred_State`, `FOS_Application_Code`, `FOS_Application_Status`.

Setup in Zoho CRM: a workflow rule on Leads (when Lead Status is updated to Pre-Qualified) with a
webhook action that POSTs `lead_id = ${Leads.Lead Id}` to the gateway URL with the secret header.

Function env variables: `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET` (a Zoho Self Client in the IN data center).
The refresh token (scope `ZohoCRM.modules.leads.ALL`) is stored per tenant in `tenant_integrations.refresh_token`.

## Deploying

```
npm ci
npm run package:functions      # tsc, then copies dist/ into catalyst/functions/fos_api/
cd catalyst && catalyst deploy --only functions
```

Then add two API Gateway routes: `/api/v1/{path:.*}` (ANY) to `fos_api` with Catalyst
Authentication, and `/webhooks/{path:.*}` (POST) to `fos_webhooks` with no authentication (the
shared secret is checked in code).

## First user

Users are linked by `users.external_user_id` = the Catalyst Authentication user id. Add a row with the
tenant id, that id, `status` ACTIVE and the role id from `database/catalyst/development-seed.json`.

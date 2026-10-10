# Deploying the pilot (Development)

Run these on a computer with Node 20+ and the repo cloned.

1. Install and sign in to the Catalyst CLI (once):
   ```
   npm install -g zcatalyst-cli
   catalyst login
   ```
2. Put the function secrets in `catalyst/env.local.json` (copy `catalyst/env.example.json`).
   The file is gitignored; never commit it.
   - `fos_api` and `fos_webhooks`: `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`
     (a Self Client from api-console.zoho.in; refresh token with scopes
     `ZohoCRM.modules.leads.ALL,ZohoCRM.modules.accounts.ALL,ZohoCRM.modules.contacts.ALL,ZohoCRM.modules.attachments.ALL,ZohoSign.documents.ALL,ZohoSign.templates.ALL,ZohoBooks.contacts.ALL,ZohoBooks.invoices.ALL,ZohoProjects.portals.READ,ZohoProjects.projects.ALL,ZohoProjects.tasklists.ALL,ZohoProjects.tasks.ALL`;
     the Sign, Books and Projects scopes are needed from Step 5 on)
   - `fos_webhooks`: `FOS_CRM_WEBHOOK_SECRET`, a long random string (letters and digits)
  - `fos_webhooks` (optional): `FOS_SIGN_WEBHOOK_SECRET`, the secret key set on the Zoho Sign webhook.
    When set, every Sign callback must carry a valid `X-ZS-WEBHOOK-SIGNATURE`.
3. Build and deploy:
   ```
   git checkout claude/step5-agreements
   npm ci
   cd catalyst && catalyst project:use && cd ..   # pick FranchiseOS, Development
   npm run deploy:functions                        # or: npm run package:functions && node scripts/deployFunctions.mjs fos_webhooks
   ```
   A plain `catalyst deploy` with an empty `env_variables` in `catalyst-config.json` wiped the values
   entered in the console (seen on 9 Oct). The committed configs no longer list `env_variables`, and
   the script fills them from `env.local.json` for the deploy only, then restores the committed config,
   so the values survive either way.

The CRM webhook ("CRM Lead") posts to `/server/fos_webhooks/webhooks/crm/lead/STARK` with custom
parameter `x-fos-webhook-secret` and module parameter `lead-id` (Leads > Lead Id). CRM sends these as
headers, and header names with `_` are dropped on the way in, so use the hyphen.

The Stark Industries tenant already has its `tenant_integrations` row (provider ZOHO, data center IN);
the function reads the refresh token and webhook secret from these env variables for the pilot.

After the deploy, the API Gateway routes and the CRM workflow rule are set up from the project thread.

## Step 5: agreement and opening project

What each piece reads, so the signed-agreement flow can run end to end:

| Setting | Where | Pilot value |
|---|---|---|
| Books organization | `tenant_integrations.org_id` | 60091318927 |
| Projects portal | `tenant_integrations.portal_id` | 60091315097 |
| Projects owner | tenant `settings_json.projects_owner_zpuid` | the portal user who owns opening projects |
| Task open status | tenant `settings_json.projects_open_status_id` (used by Reopen) | 481772000000000185 |
| Task closed status | tenant `settings_json.projects_closed_status_id` (used by Mark done) | 481772000000000188 |
| Franchise fee | tenant `settings_json.franchise_fee` (0 skips the invoice) | 500000 |
| Fee payment terms | tenant `settings_json.books_payment_terms` (days) | 15 (default) |
| Fee tax | tenant `settings_json.books_tax_id` (a Books tax id, e.g. GST 18%) | unset: no tax |
| Email the fee invoice | tenant `settings_json.books_email_invoice` (false only marks it sent) | true (default) |
| Agreement term, opening target | `agreement_term_years` (5), `opening_target_days` (120) | defaults |
| Sign template | `agreement_templates.zoho_sign_template_id` (QSR, version 1), id or template name | Franchise_Agreement |
| Task dependencies in Zoho | `settings_json.projects_dependencies` | false until the V3 endpoint is verified |

The Sign template needs one signer role; the franchisee is assigned to it. Text fields named
`agreement_code`, `franchisee_name` and `application_code` are filled in when present.

Zoho Sign webhook (Settings > Developer settings > Webhooks), events "Completed", "Declined",
"Expired", "Recalled" and optionally "Viewed":
`https://franchiseos-60082871087.development.catalystserverless.in/server/fos_webhooks/webhooks/sign/STARK?token=<FOS_CRM_WEBHOOK_SECRET>`.
Only the request id is taken from the callback; its status is read back from Sign.

When a step after signing fails (a Zoho outage, a timeout), the callback answers 502, and a replay
of the callback or `POST /api/v1/agreements/{id}/onboard` finishes only the unfinished steps.

## Step 6: risk job, web app and sign-in

**Risk job.** Fill the `fos_jobs` section of `catalyst/env.local.json` with the same three Zoho values
as `fos_api`, then `node scripts/deployFunctions.mjs fos_jobs`. In the console, Cloud Scale > Cron,
create a cron "project_risk" that calls `fos_jobs` daily (for example 06:00 IST).

**Web app.** `npm run deploy:client` builds `client/` and deploys it to Web Client Hosting. It is served
at `https://franchiseos-60082871087.development.catalystserverless.in/app/` and calls `/server/fos_api`.

**Sign-in.** Turn on Cloud Scale > Authentication (Hosted login, Email) and add users there. Each
person also needs a `users` row before the API lets them in:

| Column | Value |
|---|---|
| tenant_id | 62105000000093292 (Stark Industries) |
| external_user_id | the Catalyst Authentication user id |
| email, name | the person |
| status | ACTIVE |
| role_id | the `roles` row for their role (e.g. FRANCHISE_DIRECTOR; FRANCHISEE for portal users) |
| franchisee_id | portal users only: their `franchisees` row, so they see only their own records |
 Once real sign-ins work, set `test_routes_enabled` to false in the tenant
settings so the test agreement route stops answering.

## Phase A: lifecycle loop

- On signing: the franchisee becomes ACTIVE; the CRM lead is converted to an Account and Contact
  (a plain Account if conversion fails); the Account gets Phone, billing city/state and the
  `FOS_Franchise_Code`, `FOS_Application_Code`, `FOS_Application_Status`, `FOS_Target_Opening`
  fields; the signed PDF from Zoho Sign is attached to the Account (`agreements.document_ref`);
  the Books customer is matched by email; the fee invoice gets payment terms and tax and is
  emailed to the franchisee once.
- After conversion, application status is written to the Account; to the lead only while the lead
  is unconverted. FOS writes pass `trigger: []`, so they never fire CRM workflow rules.
- On opening (project `open`): the application becomes ACTIVE, the franchisee ACTIVE, and the
  Account's `FOS_Opened_On` is set.
- A CRM lead with no email and no phone is not imported; its `FOS_Application_Status` is set to
  `NEEDS_CONTACT_DETAILS`. Adding an email or phone and saving the lead imports it.
- The project page reads the fee invoice from Books and warns while it is unpaid. It never blocks work.
- Data Store: `franchisees.zoho_contact_id` (varchar). CRM: the five `FOS_*` fields on Accounts.

## Document uploads and delegation

- Stratus: create a **protected** bucket `fos-docs-62105` (Cloud Scale → Stratus). Opening Stratus in the console once is also what lets tools manage it later.
- `fos_api` env var: `FOS_STRATUS_BUCKET=fos-docs-62105`. Without it the app keeps working and documents can only be added as links.
- `fos_api` now uses `zcatalyst-sdk-node` 3.x (Stratus needs it); `npm run package:functions` installs it.
- Files are stored under `tenants/<tenant>/applications/<application>/…` and opened through 5-minute signed links. Uploads are PDF, JPG, PNG or WebP, up to 5 MB.
- Delegation needs no setup: managers use Approvals → Delegations.

## Two-way sync: fee payments and CRM edits

- `fos_jobs` now runs a second daily step after the risk job: every signed agreement whose fee is
  not settled is read from Books, and every CRM-linked franchisee is refreshed from its lead (before
  signing) or its Contact and Account (after). Deploy `fos_jobs` with `fos_api`.
- Data Store: `agreements` has `fee_status`, `fee_total`, `fee_balance`, `fee_due_date`,
  `fee_paid_on` and `fee_checked_at` (created in Development on 2026-10-10).
- CRM Accounts have `FOS_Fee_Status` (text) and `FOS_Fee_Paid_On` (date), written when the fee
  status changes.
- On demand: "Check fees in Books" on the dashboard (`POST /fees/sync`) and "Refresh from CRM" on the
  franchisees list (`POST /franchisees/:id/sync-crm`). Opening a project page also refreshes its fee.
- Blank CRM values never overwrite FOS data. Every change is in the activity log
  (`fee:paid`, `fee:status`, `update:crm`).

## Territories

- Managers with `territory.write` (Franchise Manager, Regional Manager) add, edit, block and unblock
  territories on the Territories page (`POST /territories`, `PATCH /territories/:id`). Only an
  available territory can be blocked; a reserved one is released first.
- Signing an agreement marks the application's reserved territory ALLOCATED.
- `fos_jobs` runs a third daily step: reservations of signed applications become allocations, those
  of rejected or withdrawn applications are freed, and reservations past `reservation_days` (30)
  lapse while the application is still before the site stage. Later stages keep their hold.
- Not linked to CRM Territory Management, which is off in the pilot CRM.

## Notifications

- Every signed-in user has an inbox (the bell in the top bar). Events: an approval step waiting
  for you, an approval decided, a new application from CRM, an agreement signed, declined or
  expired, a project at risk or opened, a fee paid or overdue, a reservation lapsed, a task assigned.
- `fos_jobs` runs a fourth daily step, reminders: approvals past their SLA (escalated once to the
  step's escalation role), overdue tasks to their owners, projects past their target opening date,
  agreements unsigned after 7 days, and territory holds lapsing within 5 days. Each reminder is
  delivered once (a daily one once per day).
- Recipients are the active users holding the event's roles, plus active approval delegates; the
  person who acted is left out. When nobody holds a role, the tenant's super admins get it.
- Email: add and verify a sender in the console (Cloud Scale > Mail), then set `FOS_MAIL_FROM` to
  that address for `fos_api`, `fos_webhooks` and `fos_jobs` in `env.local.json`. Without it, the
  inbox still works and no email is sent. Tenant settings: `notify_email` (false turns email off),
  `app_url` (the link in emails; defaults to the Development web app).
- Data Store: `notifications` has `title`, `body`, `link`, `read_at`, `created_at` and a unique
  `dedupe_key` (created in Development on 2026-10-10).

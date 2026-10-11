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
     `ZohoCRM.modules.leads.ALL,ZohoCRM.modules.accounts.ALL,ZohoCRM.modules.contacts.ALL,ZohoCRM.modules.attachments.ALL,ZohoSign.documents.ALL,ZohoSign.templates.ALL,ZohoBooks.contacts.ALL,ZohoBooks.invoices.ALL,ZohoBooks.bills.READ,ZohoProjects.portals.READ,ZohoProjects.projects.ALL,ZohoProjects.tasklists.ALL,ZohoProjects.tasks.ALL`;
     the Sign, Books and Projects scopes are needed from Step 5 on; `ZohoBooks.bills.READ` from the capex budget on)
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

## Licences

- Each opening project gets a licence register: FSSAI, trade licence, fire NOC, Shop and
  Establishment, GST (mandatory) and signage permit (optional). A tenant replaces the list with
  `settings_json.licence_types` (`code`, `name`, `authority`, `mandatory`, `renew_days`). Staff can
  add a one-off licence to a project.
- Staff with `project.write` record status, number and dates on the project page. The franchisee
  uploads certificates from the portal's Opening tasks page; files go to Stratus under
  `tenants/<t>/projects/<p>/licences/`.
- The store can't be marked opened until every mandatory licence is issued and still valid on the
  opening day (`LICENCES_MISSING`).
- The daily reminder step marks licences past their expiry as expired, reminds before renewal
  (`renew_days`, 45 by default), and warns weekly when mandatory licences are missing within 30
  days of the target opening date.
- Data Store: `licences` table (created in Development on 2026-10-10, id 62105000000060469).
- Existing open projects get their register the first time someone opens the project page or the
  opening is attempted.

## Capex budget

- Each opening project gets a capex budget: the feasibility investment split into nine categories
  (civil and interiors 30%, kitchen equipment 25%, furniture 10%, signage 5%, IT and POS 5%,
  licences and deposits 3%, opening stock 5%, launch marketing 7%, contingency 10%), rounded to the
  nearest ₹1,000. A tenant replaces the split with `settings_json.capex_categories`
  (`code`, `name`, `share`). Staff with `project.write` change any line's budget.
- Actuals:
  - Zoho Books vendor bills whose reference number contains the project code, e.g.
    `PROJ-000012 KITCHEN`. The word after the code picks the category; without one the bill goes
    to Other until staff move it. Voided and draft bills don't count. The project page has
    "Sync from Books", and `fos_jobs` pulls bills daily in the two-way sync step.
  - Spend recorded by staff, or by the franchisee from the portal with the invoice attached
    (stored in Stratus under `tenants/<t>/projects/<p>/capex/`). Staff can void a recorded entry.
- When a category with a budget, or the total, goes over budget, finance, the franchise manager and
  the project manager get one notice. `settings_json.capex_tolerance_pct` allows a margin first.
- Books needs `ZohoBooks.bills.READ` on the refresh token used by `fos_api` and `fos_jobs`. Until
  the token has it, "Sync from Books" says so and recorded spend still works.
- Data Store: `capex_lines` and `capex_spend` (created in Development on 2026-10-10).

## Leases

- Each site has one lease, recorded on the site page by staff with `site.write` once the site
  reaches feasibility: landlord, monthly rent, maintenance (CAM), security deposit, escalation
  (% and how often, yearly by default), lease start, rent-free fit-out period, term, lock-in and
  renewal notice (90 days by default). FOS works out the rent start, lock-in end, expiry, the
  date renewal notice is due, and the rent after each step-up. Rent and deposit also update the
  site summary.
- Marking the lease signed needs the start date, term, rent and the signed deed uploaded (stored
  in Stratus under `tenants/<t>/sites/<s>/lease/`). It moves an approved or lease-pending site to
  lease signed and completes the project's "Sign lease" task (in Zoho Projects too when linked).
  The site's manual "Lease signed" step now needs a signed lease.
- The project page shows the lease. Alerts, each sent once, to the franchise manager, project
  manager, finance and the franchisee:
  - rent starting before the target opening, with the rent paid before the store earns; sent
    again when either date moves (on save and in the daily reminder step)
  - the renewal notice date within 60 days (franchise manager and franchisee)
  - a rent step-up within 30 days (finance and franchisee)
- Data Store: `leases` table (created in Development on 2026-10-11).

## Opening forecast

- Each checklist task has a length in days and the tasks it waits for (from the template, editable
  in the task's Edit dialog by staff with `project.write`; loops are refused). An open task is
  forecast to finish on the latest of its due date, today, or its predecessors' finish plus its
  length. The store can open the day after the last mandatory task, so the gap before the target
  is float; once that runs out the forecast opening slips past the target.
- The project page shows the target, the forecast opening, days behind or to spare, and the
  critical path (the chain setting the date). The checklist marks critical tasks, what each is
  waiting for, and a likely finish when a task runs past its due date. Readiness risk is at least
  medium while the forecast slips, and high at 14 days or more.
- The forecast is stored on the project on every readiness refresh (sync, task edits and the daily
  risk job). The project team and the franchisee hear once when it first slips, and again only
  when it moves a further 7 days or more; going back on plan resets this.
- "Move target to …" (with a reason, audited as `project:retarget`) sets the target to the
  forecast. Zoho Projects keeps its own end date. Dependency and length edits stay in FOS.
- Data Store columns (created in Development on 2026-10-11): `opening_checklists.duration_days`,
  `opening_checklists.completed_on`, `franchise_projects.forecast_opening_date`,
  `franchise_projects.forecast_slip_days`, `franchise_projects.forecast_alerted_on`.

## Royalties and sales

- Every opened store reports each calendar month's sales, from its opening month on: gross, net,
  bills and an optional POS report (stored in Stratus under `tenants/<t>/projects/<p>/sales/`).
  The franchisee reports from the portal ("Sales reports"); staff with `royalty.manage` can report
  for them. A report can be changed until it is invoiced.
- Rates are a percent of net sales: the store's own rate (set on the project page with
  `royalty.manage`, audited as `royalty:rates`), else its feasibility model's royalty and
  marketing fund, else `settings_json.royalty_pct` / `marketing_fund_pct`.
- `royalty.manage` approves a report into one Zoho Books invoice (reference
  `ROY-<project code>-<YYYYMM>`) with a Royalty line and a Marketing fund line, using the tenant's
  Books tax and payment terms, and marks it sent; or returns it with a note. The franchisee hears
  either way. The two-way sync in `fos_jobs` marks invoices paid. Books uses the existing invoices
  scope; no new scope is needed.
- Reports are due on day `settings_json.sales_report_due_day` (default 7) of the next month. The
  franchisee is reminded on the due day; finance and the franchise manager hear once a month is
  5 or more days late.
- `royalty.manage` is super-admin only by default; add it to the Finance manager role in
  `role_permissions` when finance should approve.
- Staff see every report on Operations > Royalties (`dashboard.view`).
- Data Store: `sales_reports`, plus `franchise_projects.royalty_pct` and
  `franchise_projects.marketing_fund_pct` (created in Development on 2026-10-11).

## Owner analytics

- Overview > Analytics (`dashboard.view`, `GET /analytics?months=3|6|12|24&region=`) covers the last
  finished months, filtered by territory region.
- Sales: net sales reported per month (returned reports left out), royalty and marketing fund
  billed, collected and unpaid. Each store shows its average over its last three reported months
  against its feasibility monthly revenue, the change from the month before, and how many due
  months it reported. The store table exports to CSV.
- Opening speed: days from agreement signed to store opened (median, by region) and opening date
  against target.
- Funnel: how many applications reached each stage (at it or past it, now or before), the share
  that moved on to the next stage, and the median days spent at a stage. The days come from status
  changes made in FranchiseOS, so records imported straight into the Data Store show none.
- Computed live from the Data Store; no new tables or scopes.

## Activity log

- Admin → Activity log lists every activity_logs entry for the tenant, newest first: when, what
  (with the raw action code), the record (linked to its page), and who did it (a person, or the
  scheduled job, Zoho CRM or Zoho Sign). Click a row for its details and correlation id, which
  matches the request id in the function logs.
- Filters: record type, person, from/to dates, and text search over actions and details. The
  filters are in the URL, so a filtered view can be shared. "Export CSV" downloads every matching
  entry (up to 5,000).
- Needs `audit.view`. Only SUPER_ADMIN has it by default; grant it to another role in
  role_permissions if someone else should see the log. API: `GET /audit`.

## Users and roles

- Admin → Users and roles (needs `user.admin`, SUPER_ADMIN only by default) lists everyone with a
  FranchiseOS account: role, franchisee (for portal users), status and when they were added.
  Below it, every role with how many active people hold it and what it can do (read-only).
- "Add person" takes their email, name, role and, for franchisee roles, the franchisee. They
  start as Invited and become Active the first time they sign in: matched by the Catalyst user
  the invitation created, or else by their verified Catalyst sign-in email. No more hand-made
  rows in the users table.
- Invitation emails: set `FOS_AUTH_ZAID` on fos_api to the environment's ZAID (Catalyst console
  → Settings → Environments; Development and Production differ) and, optionally, `FOS_APP_URL`
  for where the invitation lands. FOS then registers the person in Catalyst Authentication,
  which emails them to set a password. Without it, add them in Catalyst Authentication yourself
  (or let them sign up); FOS links them on first sign-in.
- Edit changes name, role and franchisee. Deactivate stops sign-in and notifications at once;
  Reactivate restores it. You can't deactivate yourself or change your own role, and the last
  active super admin can't be removed. Every change is in the activity log (`user:*`).

## Integration health and alerts

- Admin → Integration health (needs `integration.admin`, SUPER_ADMIN only by default):
  - Needs attention: CRM status updates that gave up after their retries (dead letters) and
    CRM lead or Sign callbacks that failed. Retry runs the call again (a lead or Sign event is
    re-read from Zoho, so it is safe to repeat); a failed retry is replaced by its own new item.
    Resolve takes a reason and clears an item that was fixed another way. Both are audited
    (`integration:retried`, `integration:resolved`).
  - Daily job: each step of fos_jobs (project risk, two-way sync, reservations, reminders) with
    its last run, last success and error. Steps now run independently, so one failing step no
    longer stops the rest; the cron still reports failure if any step failed.
  - Last 7 days: worked, retried and gave-up counts by system, and the Zoho connection (ids only;
    whether a token and webhook secret are stored, never their values).
- Alerts: super admins get an in-app notice (and email when mail is on) when a Zoho call gives
  up, a webhook fails, or a job step fails. Each repeats at most once a day per item.
- No Data Store changes: rows go in `integration_logs` (jobs as source `FOS_JOBS`) and
  `integration_events`, with the new status `RESOLVED`.

## Rotating the webhook secret

The CRM lead webhook and the Sign callback URL both carry `FOS_CRM_WEBHOOK_SECRET`. fos_webhooks
can accept the old and the new secret side by side for a few days, so nothing breaks while each
sender is switched over. Integration health → Zoho connection shows "From the function settings"
when the secret comes from env.local.json (a secret stored on the tenant_integrations row would
take precedence).

1. Make a new secret on your Mac and keep it on the clipboard (never paste it into chat):
   `openssl rand -hex 32 | pbcopy`
2. In `catalyst/env.local.json`, inside `fos_webhooks`:
   - copy the current `FOS_CRM_WEBHOOK_SECRET` line and rename the copy's key to
     `FOS_CRM_WEBHOOK_SECRET_PREVIOUS` (same old value);
   - paste the new secret as the value of `FOS_CRM_WEBHOOK_SECRET`;
   - add `"FOS_CRM_WEBHOOK_SECRET_PREVIOUS_UNTIL": "YYYY-MM-DD"`, about a week ahead. The old
     secret stops working after that day, and is never accepted without this date.
3. Deploy fos_webhooks. Both secrets work now.
4. Switch each sender to the new secret:
   - Zoho CRM → Setup → Automation → Actions → Webhooks → the FOS lead webhook → header
     `x-fos-webhook-secret`.
   - Zoho Sign → Settings → Developer settings → Webhooks → the FOS callback URL's `token=`.
5. Watch the fos_webhooks logs for `webhook.previous_secret_used`. Each entry names the route
   still on the old secret. When none appear for a day, delete the two `..._PREVIOUS` lines and
   deploy fos_webhooks again.

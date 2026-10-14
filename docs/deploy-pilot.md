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

## Construction

Each opening project has a Construction panel (staff) and a Construction page in the franchisee portal.

- **Store design.** The franchisee (or staff) sends the layout and elevation drawings as a PDF or image. Each resend is a new version, and only one can wait for review at a time. Anyone with `project.write` approves it or requests changes with a note. Approval completes the "Get store design approved" (DESIGN) checklist task, in Zoho Projects too when the project is linked, and refreshes readiness. The FITOUT task can't be marked done until a design is approved.
- **Site photos.** Staff and the franchisee add photos with a caption and area. The time comes from the photo (a future time becomes now), and the location is optional, asked for in the browser. A photo more than 500 m from the site's pin is flagged.
- **Snag list.** Staff raise snags as minor, major or critical, with an optional photo. The franchisee marks them fixed with a note and photo; staff verify (close), reopen with a note, or waive with a reason. Major and critical snags that are open or fixed but not verified stop the store opening (`SNAGS_OPEN`); minor ones don't.
- Notifications: a design waiting for approval goes to franchise and project managers; the decision, major or critical snags and reopened snags go to the franchisee; fixed snags go to project and franchise managers.
- New projects get the DESIGN task from the template, and FITOUT now depends on it. Seeding only adds this for new tenants; for STARK in Development the DESIGN row was added to `project_template_tasks` and FITOUT's `depends_on_json` set to `["PERMITS","DESIGN"]` by hand on 2026-10-11. Do the same for any other existing tenant. Existing projects have no DESIGN task, so approving a design there completes nothing, but the fit-out rule still applies.
- Tables `design_reviews`, `site_photos` and `snags` were created in Development on 2026-10-11. Photo coordinates are stored to 4 decimal places (about 11 m).

## Hiring and training

Each project has a Team and training panel (staff) and a Team page in the franchisee portal.

- **Staffing plan.** By default a store needs 1 store manager, 2 shift leads and 8 crew. Anyone with `project.write` can change the numbers for a project (Edit plan); the plan is stored on the project (`staffing_plan_json`).
- **Team.** The franchisee (or staff) adds each person they hire with role, phone, email and hire date. Someone who leaves is marked as left with their last day; they stay in the history but stop counting towards the plan.
- **Training.** Each role has brand modules: food safety and hygiene (certificate required from the portal), brand and guest service, kitchen and product build for everyone; POS and cash handling for shift leads and managers; store operations for the manager. The franchisee records a module as done (date, optional score, trainer and certificate) and it waits for sign-off. Training and project managers sign it off or send it back with a note. A record staff add themselves is signed off at once.
- **Checklist tasks.** "Hire store manager" completes when the plan's managers are hired, "Hire crew" when the shift leads and crew are hired, and "Complete crew training" when enough people in every role have all their modules signed off. They complete in Zoho Projects too when linked. They can't be marked done by hand before the plan is met.
- Notifications: a module waiting for sign-off goes to training and project managers; a module sent back goes to the franchisee.
- Tables `store_staff` and `staff_training`, and the column `franchise_projects.staffing_plan_json`, were created in Development on 2026-10-11.

## Vendors and purchase orders

Operations → Vendors holds the approved supplier catalogue; each opening project has an Equipment and supplies panel, and the franchisee portal an Orders page.

- **Catalogue.** Vendors (name, what they supply, contact, GSTIN, city) and their items (price before tax, unit, lead time, capex category). An item marked as part of the standard package says how many every store needs. Only `vendor.manage` changes the catalogue; it is a new permission, held by super admins only until a role is given it. A suspended vendor or retired item can't be ordered; orders already placed carry on.
- **Orders.** The franchisee (or staff with `project.write`) orders from one approved vendor at a time; prices are copied from the catalogue. Each order gets a number like `PO-PROJ-000012-01` and a needed-by date (kitchen equipment: the install task's due date; opening stock: its task; anything else: the target opening). Staff confirm it with the vendor's delivery date; a date after it's needed, or a confirmed order past its date, shows as late. The franchisee or staff mark it delivered with an optional delivery note. The franchisee can cancel only while an order is placed; staff can cancel until delivery.
- **Capex.** A delivered order is added to the project's capex as spend (source "Purchase order"), one entry per category. Don't record the same invoice again by hand.
- **Checklist tasks.** "Order kitchen equipment" completes when the standard kitchen equipment is all on order, and "Receive opening inventory" when the standard opening stock is delivered, in Zoho Projects too when linked. Neither, nor "Install and commission equipment", can be marked done by hand before the package allows it. A category with no standard items doesn't hold anything back.
- Notifications: an order placed from the portal goes to project managers; a confirmed date and a cancellation go to the franchisee; a delivery goes to project managers; a confirmed order past its date reminds both sides daily (job_reminders).
- Tables `vendors`, `vendor_items` and `purchase_orders` were created in Development on 2026-10-11. The catalogue starts empty.

## Funding and fees

Each opening project has a Franchise fee and deposit panel and a Funding panel; Contracts → Franchise fees lists every instalment across the network, and the franchisee portal has a Funding and fees page.

- **Fee plan.** Tenant settings `fee_plan` split `franchise_fee` into instalments, each a share (`pct`) or `amount` with a trigger: `SIGNING`, `TASK` (with `task`, a checklist task code such as `FITOUT`), `OPENING`, or `DATE` (with `days` after signing). `security_deposit` adds a refundable deposit invoiced on signing, without tax. With no `fee_plan` the whole fee is invoiced on signing, exactly as before. Example: `"fee_plan": [{"label":"On signing","pct":40,"trigger":"SIGNING"},{"label":"At fit-out","pct":30,"trigger":"TASK","task":"FITOUT"},{"label":"On opening","pct":30,"trigger":"OPENING"}], "security_deposit": 100000`.
- **Signing.** The onboarding invoice now covers only the plan's share on signing, and the plan is kept on the agreement (`fee_plan_json`), so later changes to the tenant plan don't move signed stores. Agreements signed before this keep what they were billed: their one fee invoice, or nothing. Adding a plan later never bills a signed store; fee.manage can add instalments to one by hand.
- **Raising and payment.** job_two_way_sync raises each instalment as a Books invoice (reference `FEE-<agreement>-<n>`, emailed like the fee invoice) once its trigger is met, and brings payments back. `fee.manage` can also raise one early, add or change instalments that aren't invoiced yet, waive one, and record a deposit refund. `fee.manage` is a new permission, held by super admins only until a role is given it. The signing instalment follows the agreement's own fee status.
- **Funding.** The franchisee (or staff with `project.write`) records own capital and the bank loan: applied, sanctioned (amount, rate, tenure, sanction letter) or rejected, then each disbursement. The panel shows what's secured against the capex budget and the gap.
- Notifications: an invoiced instalment goes to the franchisee; a paid one to finance managers; an overdue one reminds finance and the franchisee daily; a loan sanctioned, rejected or disbursed goes to finance (and project managers for the first two); a loan still not sanctioned when fit-out is due within 30 days alerts finance, project managers and the franchisee once per loan state.
- The dashboard's fee tiles include later instalments and drill into Franchise fees.
- Tables `fee_instalments` and `funding_plans`, and `agreements.fee_plan_json`, were created in Development on 2026-10-11. STARK's settings got the example plan above on 2026-10-11; it applies to agreements signed from then on.

## Store audits

Opened stores (and stores ready to open) get brand-standard audits. Each project page has a Store audits panel, Operations → Store audits shows the whole network, and the franchisee portal has an Audits page.

- **Standards.** Tenant settings `audit_standards` replace the 18 built-in standards (food safety, cleanliness, brand, product, service, operations, people). Each is `{"code","section","text","weight","critical"}`. Other keys: `audit_every_days` (90), `audit_first_within_days` of opening (30), `audit_pass_score` (85), `audit_amber_score` (70), `audit_action_days` (14), `audit_critical_action_days` (3), `audit_follow_up_days` (30).
- **Running one.** `audit.conduct` books an audit (routine, pre-opening, follow-up or surprise) with an auditor, starts it at the store and judges each standard Pass, Fail or N/A on a phone, with a note on each fail and an optional photo. Every answer saves as it's given. One open audit per store.
- **Scoring.** The score is the weight passed over the weight judged (N/A doesn't count). Green is at or above the pass mark with no critical fails; red is any critical fail or below the amber mark. Completing an audit turns each fail into a corrective action for the franchisee, due in 3 days if critical and 14 otherwise. A red audit books a follow-up audit 30 days later.
- **Corrective actions.** The franchisee marks each fixed with a note and photo; the auditor closes it or sends it back with a new due date. The franchisee sees finished audits only, and never a surprise visit before it happens.
- `audit.conduct` is a new permission, held by super admins only until a role is given it in role_permissions. Anyone with `dashboard.view` can see audits and the network page.
- Notifications: a booked audit goes to the auditor and franchisee (not for surprise visits); a completed one to operations managers and the franchisee; an answered action to operations managers and the auditor; a sent-back one to the franchisee. Daily reminders cover overdue corrective actions and stores due an audit.
- The dashboard's Brand standards tile is the average latest score of opened stores and drills into Store audits.
- Tables `audits`, `audit_items` and `corrective_actions` were created in Development on 2026-10-11. The item verdict column is `verdict` because Catalyst reserves `result`.

## Opening day

Each project page has an Opening day panel; Operations → New stores lists grand openings coming up and stores in their first weeks; Contracts → Renewals lists agreements ending in the next 18 months; the franchisee portal has an Opening day page.

- **Grand-opening plan.** `project.write` sets the grand-opening day, which builds the store's launch tasks from settings `launch_plan` (each `{"code","item","owner":"FRANCHISEE"|"BRAND","offset_days"}`, negative before the day; 12 built-in tasks from the marketing plan four weeks out to a two-week check-in). Moving the day moves tasks still to do. The franchisee ticks off their own tasks; staff can tick off, skip (with a reason) or add any.
- **First-weeks sales watch.** Opening a store sets its grand-opening day if none was planned, which starts the watch. For `launch_watch_weeks` (12) the franchisee reports each week's net sales (week 1 starts on the opening day). Each week's plan is the feasibility monthly revenue as a weekly figure times `launch_ramp` (60%, 70%, 80%, 85%, 90%, 95%, then 100%). On plan is at or above `launch_on_track_pct` (85); two weeks running below `launch_behind_pct` (70) marks the store behind and tells franchise and operations managers. Stores opened before this release aren't watched unless someone reports a week for them.
- **Renewals.** `agreement.write` records where each renewal stands: in discussion, renewing, not renewing, or renewed (with the new end date). Reminders go to franchise and legal managers and the franchisee at `renewal_notice_days` (180), 90 and 30 days before the end, and on the day, until a decision is recorded. "Not renewing" tells the franchise director. The list shows each store's last audit score and overdue royalties.
- No new permissions: launch tasks use `project.write`, renewals `agreement.write`, the network pages `dashboard.view`.
- Reminders: overdue launch tasks (the franchisee's to them, the brand's to project managers), and the week just finished if it isn't reported.
- The dashboard adds New stores behind plan and Renewals due.
- Tables `launch_tasks` and `launch_sales`, `franchise_projects.grand_opening_date`, and `agreements.renewal_status`, `renewal_note`, `renewal_updated_at` and `renewed_until` were created in Development on 2026-10-11.

## Franchisee portal v2

The portal home now opens with what needs the franchisee, and the portal adds To do, Messages and Documents pages. Staff get Overview → Messages and Operations → Brand documents.

- **To do.** One list across every store and module, most urgent first (overdue, due now, coming up, for information): signing and the signing fee, an application to finish or a site to propose, blocked or due opening tasks, missing licences and licence renewals, monthly sales to report or fix, unpaid royalty invoices and fee instalments, open audit actions and snags, a design needing changes, returned training, late deliveries to confirm, the franchisee's own launch tasks and launch weeks to report, and unread brand messages. Each item links to the page where it's done. The nav shows how many items are overdue or due.
- **Messages.** One conversation per franchisee, optionally about a store, with an attachment. A franchisee message tells the owner of their application (or franchise managers if there isn't one); a brand reply tells the franchisee's portal users. Opening the conversation marks the other side's messages read. Any staff member with `dashboard.view` can read and reply.
- **Documents.** The brand library (manuals, marketing, training, policies, forms) shared with every franchisee or one, plus the franchisee's own files from other modules (licences, lease, sanction letter, designs, sales report files, delivery notes, training certificates). Sharing tells the franchisees who can see it; removing a document hides it from the portal.
- New permission `document.share` (share or remove brand documents) is super-admin only by default; add it to a role in `role_permissions` (for example Marketing or Operations manager) when they should share documents. Everyone with `dashboard.view` can see the library.
- Tables `brand_documents` and `messages` were created in Development on 2026-10-11.

## Polish pass (2026-10-11)

- **Portal.** New Application and Site pages: a franchisee starts or edits their draft application, adds documents, submits (once the required documents are in), and proposes a site, or a replacement if one is rejected. The franchise manager (or the application's owner) is told on submit and on a proposed site. Franchisees with more than one store pick the store in the top bar. Notices open the matching portal page. The nav is grouped into My franchise, Getting started, Opening and Trading. An open store with a mandatory licence still missing shows as overdue on the to-do list.
- **Phones.** Tables show one card per row. An open store's project page leads with opening day, sales and royalties and audits; the opening checklist follows under "Before opening".
- **Fixes.** Without Zoho Projects, signing builds the opening checklist in FranchiseOS and the project starts planning (it used to stay Not started). Re-running onboarding adopts a signing-fee invoice the daily fee run already raised, so the fee is never billed twice. Approvals can't be decided while the application is on hold, and are closed when it is withdrawn or rejected. Applications can be rejected at any open stage. A site proposed after a rejected or dropped one replaces it on the application (feasibility is redone); feasibility and approval refuse a rejected site or another franchisee's. A resubmitted sales report with the same figures tells finance again. Moving an audit tells the store and the auditor. Linked application documents must be web links. Refunded deposits no longer count as collected.
- Not changed: a closed store can't report its final months yet (there is no closing date to stop at).
- **Zoho links.** The agreement's Integration card links to the request in Zoho Sign, the CRM account the signed copy is filed on, and the invoice in Zoho Books, and has a "Download signed agreement" button (fetched from Zoho Sign into Stratus and opened through a short-lived link). Fee and royalty invoice numbers open in Zoho Books for staff. The web addresses come from the tenant's Zoho data center and Books organization.

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

## Branding (2026-10-11)

Admin → Settings → Branding sets the company name, a tagline, the logo and a brand colour. They
replace FranchiseOS in the sidebar (staff and portal), the app's own sign-in screen, the browser
tab title and icon, and notification emails ("Open in <name>", button colour).

- Stored in `tenants.settings_json.branding` (`name`, `tagline`, `color`, `logo_ref`). The logo is a
  PNG, JPG or WebP up to 1 MB in the Stratus bucket under `tenants/<t>/branding/`, served by a
  short-lived signed link. No new table or column.
- `GET /api/v1/branding` answers signed-out visitors too, with only the name, tagline, colour and
  logo link. Signed out, it shows the tenant named by the optional `FOS_PUBLIC_TENANT` env var
  (a tenant code such as `STARK`), else the only active tenant.
- `PUT /api/v1/settings/branding` needs the new permission `settings.manage`, which is
  super-admin only by default.
- **Catalyst's hosted sign-in page** ("Continue to sign in" leads there) is not part of the app.
  Brand it in the Catalyst console, in the Authentication section's hosted login page settings
  (the menu path was not checked from here): upload the same logo and set the title. Do this once
  per environment.

## Store setup (2026-10-12)

Admin → Settings → Store setup (`settings.manage`) makes three things that were QSR-only per tenant:

- **Default format** (`settings_json.default_franchise_type`, fallback `QSR`): new franchisees, CRM
  leads without a format, and agreements or projects for a franchisee without one use it to find
  their agreement and project templates.
- **Store roles** (`settings_json.staff_roles`: `code`, `name`, `plural`, `default_count`): the people
  a store hires and how many a new store needs. The first role is the manager the `HIRE_MANAGER`
  task waits for; the others count towards `HIRE_CREW`. A role with active staff can't be removed.
- **Training modules** (`settings_json.training_modules`: `code`, `name`, `roles`, `certificate`):
  what each role completes; `TRAIN_CREW` completes when everyone planned is trained.

Without these settings the restaurant defaults stay (store manager, shift lead, crew; food safety
and so on). API: `GET` and `PUT /api/v1/settings/store-setup`.

## Owner dashboard (2026-10-13)

The dashboard now opens with the brand owner's view. New endpoint `GET /dashboard/owner?months=1|3|6|12` (`dashboard.view`) returns:
- revenue for the chosen finished months against the same length before;
- receivables aged by days past due;
- the store league table;
- compliance (latest audit RAG, corrective actions, licence expiries, audits overdue);
- the "Needs your attention" items.

Other changes:
- `/dashboard/risk` items now carry the store name, partner, reasons and forecast slip.
- `/dashboard/network` adds `slipping_openings`.
- `/dashboard/pipeline` stages add `value` and `to_next_pct`.
- `/projects?slipping=true` lists openings forecast to miss their target.
- "Save as PDF" uses the browser's print dialog with an A4 landscape print layout.

No schema, permission or setting changes.

## Pace-based readiness (2026-10-13)

Readiness RAG is judged against the progress the checklist's own due dates expect by today (`expected` on the readiness result), not a fixed score:
- within 15 points of pace (or 85%+ done) is green;
- within 30 points is amber;
- anything further behind is red;
- a blocker is always red.

Once everything is due, this matches the old 85/70 scale. An opening past its target date is now HIGH risk.

Stored colours change on each project's next readiness refresh: the daily risk job, or any checklist change.

## Network map (2026-10-13)

The dashboard has a map of India in its "Network" section.
- It shows open stores (green), openings in progress (coloured by readiness) and territories without a store yet (outlined).
- A "By state" table sits beside it.
- `GET /dashboard/map` (`dashboard.view`) places each point using the first location it finds:
  - the site's latitude/longitude;
  - else the territory's;
  - else the centre of a known city (`functions/common/indiaCities.ts`).
- Anything it can't place is listed under the map.
- The state shapes are bundled in the app (`client/src/components/indiaMap.ts`, from @svg-maps/india, CC BY 4.0), so the map needs no outside map service.

No schema, permission or setting changes.

## Finance access and review fixes (2026-10-13)

- **`finance.view`** is a new permission. It gates the money on the dashboard:
  - royalty billed and collection
  - receivables and their ageing
  - each store's unpaid amount
  - overdue fee and royalty items in "Needs your attention"
  - the fee KPIs on `/dashboard/network`
  - the Franchise fees page (`GET /fees`)
  - "Check fees in Books" (`POST /fees/sync`)
- Without `finance.view`, the dashboard still shows network sales, reporting, store performance, compliance and openings. A project's own fee schedule on its page is unchanged.
- New tenants get `finance.view` for Franchise Director and Finance Manager. An existing tenant needs two `role_permissions` rows, one for each role: `permission_code = finance.view`, `perm_key = <tenant_id>:<ROLE>:finance.view`. Until those rows exist, only super admins see the money.
- **Signing fees count once.** An instalment raised on signing is the agreement's own fee even when it has no Books invoice id.
- **Inserts are retried only after a clear throttle reply.** A dropped connection is no longer retried, because the row may already have been saved.
- **The openings tile** shows how many openings are on pace, instead of the average readiness.
- **The map shows its CC BY 4.0 credit.**
- **Failed job steps** record the full error.

## Regional view (2026-10-13)

- **Region filter.** The dashboard has a region picker, shown when territories use more than one `region`. Every panel follows it: `/dashboard/network`, `/owner`, `/pipeline`, `/openings`, `/risk`, `/territories`, `/map` and `/analytics` all take `?region=`, and `GET /dashboard/regions` lists the regions.
- **How records get a region.** A store or opening takes its site's territory, else its application's territory. An application takes its site's territory, else its own. Fees, reports, audits, licences and purchase orders follow their store.
- **Regional managers.** A user with a `region` on their row always sees that region on these endpoints, whatever they ask for. Regional managers must have one: user admin refuses a regional manager without a region, and refuses a region no territory uses. Any other staff user can also be limited to a region. Franchisee and vendor users can't be.
- **New permission grant.** `REGIONAL_MANAGER` now gets `dashboard.view` (not `finance.view`). An existing tenant needs:
  - the `region` varchar column added to `users`
  - a `role_permissions` row for `REGIONAL_MANAGER` with `perm_key = <tenant_id>:REGIONAL_MANAGER:dashboard.view`
  - a region set on each existing regional manager
- **List pages** (projects, applications, sites, territories, franchisees, royalties, audits) follow the same region and lock since 8f17312.

## Franchisee health score (2026-10-13)

One 0–100 score per trading store from sales against plan, payments, compliance and reporting, with the two weakest parts in plain words. Design and scoring in `docs/health-score.md`.

- **Schema.** `franchise_projects` gains `health_score` (double), `health_band`, `health_json` (text), `health_updated_on` (date) and `health_alerted_band`. New table `store_health`: `tenant_id`, `project_id`, `as_of` (date), `score` (double), `band`, `parts_json` (text), `health_key` (varchar, unique). Add the columns and create the table before deploying the functions.
- **Job.** The 03:30 job gains a `store_health` step after `two_way_sync`. It scores every open store, keeps the day's `store_health` row (a rerun updates it), logs `health:band_changed`, and notifies the franchise and operations managers and the store's regional manager when a store enters At risk or recovers to Healthy, once per change.
- **First run.** After deploying, call `POST /admin/health/recalculate` as a super admin (or press “Score now” on the dashboard's Franchisee health panel, or “Rescore now” under Admin → Settings → Health score). The first run alerts for every store already At risk.
- **API.** `GET /dashboard/health` (dashboard.view, follows `?region=` and the region lock), `GET /projects/:id/health` (staff with dashboard.view, or the store's franchisee), `POST /admin/health/recalculate` and `GET`/`PUT /settings/health` (settings.manage). Amounts in the reasons appear only with `finance.view`. No new permission.
- **Screens.** Dashboard: a Franchisee health panel beside Compliance, and a Health column in the store league. Map: a “Colour by health” switch. Store page: a Franchisee health card at the top of an open store (the franchisee sees it too). Settings: the weights and band limits.
- **Demo expectations (aadai).** Chennai Healthy; Coimbatore and Madurai on Watch or At risk from their overdue amounts and plan shortfall; Hyderabad scored without the sales part (too new); Mysuru not scored (still opening). The first run should alert FRANCHISE_MANAGER and OPERATIONS_MANAGER users and the South regional manager for every At risk store, so expect those emails.

## Hardening (2026-10-13)

Platform fixes from the enterprise review (`reviews/review-2026-10-13-enterprise.md` in the project files). No schema change; functions and the web app both deploy.

- **Row ceiling.** `findMany` now pages past ZCQL's 300 rows up to the limit asked for (10,000 when none is given) and logs `store.row_cap` when that is reached. Daily loops no longer stop at the 301st store.
- **Invoice claim.** Approving a sales report or raising an instalment first takes a claim, an `integration_events` row with `source_system = FOS`, so two approvals at once raise one Books invoice. A claim that failed can be taken again; one left behind by a timed-out function frees itself after 10 minutes. These rows show on Integration health as "Royalty invoice" or "Fee invoice" only when they failed.
- **Stuck webhook events.** An event still PROCESSING after 10 minutes is listed under "Needs attention" and can be retried.
- **Transitions** re-read the record just before writing it; a second person moving the same record is told to refresh.
- **Access.** A regional manager's region now bounds every record read or written by id. Loans, capex and the sanction letter need `project.write` or `finance.view`; staff records need `project.write` or `dashboard.view`; agreement fee amounts show only with `finance.view` (the status still shows). In practice the Legal manager loses those reads and the Operations manager loses loans and capex; grant `finance.view` or `project.write` to a role that needs them. A vendor user is never linked to a franchisee, a user with no role is refused, and only a super admin can make or unmake a super admin. User emails are checked within the tenant only.
- **Zoho calls** time out after 15 seconds (60 for uploads and downloads). A read is tried three times after a refusal, a server error or a timeout; a write only after a refusal.
- **Logs.** Every API call logs one `api.request` line with method, path, HTTP status, duration and request id. A job step that lost some tenants or records now records as failed and alerts super admins, instead of passing quietly.
- **To check in the Catalyst console (not code):** under Data Store → each table → Permissions, the App User role must have no read or write rights on any table. The API runs with admin scope and does its own tenant isolation; if App User could read, any signed-in user could query every table through the Data Store REST API.


## POS sales feed (2026-10-13)

Daily sales from each store's POS into FranchiseOS, so royalty can be billed on what the POS recorded rather than what the franchisee typed in. Design in `docs/pos-sales.md`.

- **Schema.** Two new tables and six new columns, to create before deploying the functions:
  - `franchisee_connections`: `tenant_id`, `franchisee_id`, `provider` (varchar, required), `zoho_dc`, `org_id`, `org_name`, `refresh_token` (encrypted), `scopes`, `status`, `connected_by`, `connected_at` (datetime), `last_pulled_at` (datetime), `last_error` (text), `conn_key` (varchar, unique, required).
  - `pos_sales`: `tenant_id`, `project_id`, `franchisee_id`, `day` (date, required), `day_key` (varchar, unique, required), `gross_sales`, `discounts`, `returns`, `net_sales`, `tax` (double), `transactions` (int), `source`, `pulled_at` (datetime).
  - `franchise_projects` gains `pos_location_id` (varchar), `pos_status` (varchar), `pos_last_day` (date).
  - `sales_reports` gains `basis` (varchar), `pos_net_sales`, `reported_net_sales`, `variance_pct` (double).
- **Zoho API console.** Franchisees consent through a **Server-based** OAuth client whose Authorized Redirect URI is the web app's address, exactly `https://franchiseos-60082871087.development.catalystserverless.in/app/` (with the trailing slash). The brand's own client (`ZOHO_CLIENT_ID`) is a Self Client, which has no redirect URI, so add a second client: Add Client → Server-based Applications, name "FranchiseOS Franchisee Books", homepage and redirect URI as above. The consent asks for `ZohoBooks.invoices.READ`, `ZohoBooks.creditnotes.READ` and `ZohoBooks.settings.READ`.
- **Function environment (fos_api and fos_jobs).** `ZOHO_POS_CLIENT_ID` and `ZOHO_POS_CLIENT_SECRET` (or `ZOHO_FRANCHISEE_CLIENT_ID`/`SECRET`; both names are read): the new client's ID and secret (when unset, the brand's `ZOHO_CLIENT_ID`/`SECRET` are used, which only works for a Server-based client). `FOS_STATE_SECRET`: a long random string; it signs the state that ties a Zoho consent back to the franchisee who started it. Optional `FOS_WEB_URL` when the app is served from an address other than the tenant's `app_url` setting or the default above; it must match the redirect URI registered on the client. Set the secrets in the console, never in chat or in the repository.
- **Connecting.** On the portal home, an opened store's franchisee sees “Your Zoho Books” with a Connect button. Zoho's consent page comes back to the app, which stores the connection (asking which organisation when the account runs several). “Pull now” fetches straight away; the nightly job pulls every connection. A franchisee with several stores in one Books organisation needs `pos_location_id` set on each store (no screen yet; set it on the row) or only a single store is fed.
- **Uploads.** Stores whose POS does not post to Books upload a CSV (`date, gross_sales, discounts, returns, tax, transactions`) from the store page or the portal's Sales reports page. Rows are checked line by line; a day uploaded again is replaced.
- **Job.** The 03:30 job gains a `pos_sales` step between `two_way_sync` and `store_health`: pulls each connection (90 days on the first pull or when a store fell behind, else 3 days), marks a store `STALE` after 2 days without a new day, puts the POS figure and the difference on every open report of the last three months, and, when the tenant bills on POS, closes each due month from POS sales. A connection that fails is marked FAILING, the franchisee and the franchise managers hear once, and it is tried again each night.
- **Settings → Royalties** (`settings.manage`): what royalty is billed on (`REPORTED`, the default, or `POS`), the tolerance (default 5%), whether complete in-tolerance months are approved and invoiced by the job (default off), and the report due day. “Pull POS sales now” runs the step for the tenant (`integration.admin`).
- **With the POS basis.** On the due day the month's report is written from the POS feed (`basis = POS`), the franchisee's own figure kept as `reported_net_sales` with `variance_pct`, and it waits for finance like any other report. A month with a missing day, or a difference beyond the tolerance, is never approved on its own. An invoiced month is never rewritten.
- **Screens.** Portal home: the connection card and each store's feed. Store page and portal Sales reports: “Daily sales from POS” (the month's days, gaps, the reported figure and the difference, CSV upload). Royalties: a POS sales column and a “vs POS” difference on each month, “From POS” on reports closed from it, and how many waiting reports differ. Dashboard: “POS coverage” under Stores trading, and “POS” items in Needs your attention (“Coimbatore Sep 2026: sales under-reported by 11%”). Health score: a store with a feed is judged on it (100 current, 60 stale, 20 when a recent month's report strayed from the POS figure, which holds the store at Watch, with the reason “Sep 2026 sales under-reported by 11% (POS ₹21.1 L, reported ₹18.8 L)”).
- **Routes.** `GET /portal/connections`, `POST /portal/connections/zoho/start`, `POST /portal/connections/zoho/exchange`, `POST /portal/connections/:id/organization`, `POST /portal/connections/:id/pull`, `DELETE /portal/connections/:id` (the franchisee); `GET /projects/:id/pos` (the store's franchisee, or staff with `dashboard.view`); `POST /projects/:id/pos/upload` (the franchisee, or `royalty.manage`); `POST /admin/pos/pull` (`integration.admin`); `GET`/`PUT /settings/royalties` (`settings.manage`). No new permission.
- **Demo (aadai).** No demo franchisee has a Books organisation, so use uploads: three months of daily rows for Chennai, Bengaluru and Coimbatore, with Coimbatore's September POS figure about 12% above its reported figure, then set the basis to POS under Settings → Royalties and press “Pull POS sales now” to close the months. Expect POS coverage 3 of 5, Coimbatore September waiting for finance with the difference in red, and a “POS” item on the dashboard.

## Job fixes (2026-10-14)

- The `pos_sales` step wrote its actor, `SYSTEM:job`, into `sales_reports.submitted_by`, a user foreign key, so the Data Store refused every month the job tried to close on its own; only the "Pull POS sales now" button, pressed by a person, worked. Rows written by a job now leave `submitted_by` and `reviewed_by` null (`actorId` in `functions/common/context.ts`); `source = POS` says where the row came from.
- Integration health read each step's last run from the newest 300 log rows, so on a busy night the early steps (`project_risk`, `reservation_expiry`) fell outside the window and showed a stale date. It now reads each step's own rows.

## ROWIDs are not in time order (2026-10-14)

The Data Store hands ROWIDs out in blocks per server, so a row written on the 14th can carry a lower ROWID than one written on the 13th (seen on `integration_logs`: the 14 Oct `project_risk` run was …127437, the 13 Oct run …138172). Anything that picked "the latest" by ROWID could pick an old row: the job runs on Integration health, the activity feed's order, the feasibility model a store's royalty rate comes from (`ratesFor`, the owner dashboard, analytics, store health, the launch plan), the newest agreement for an application, site photos and designs, purchase orders. All of them now go by `CREATEDTIME`, with ROWID only as a tie-break (`oldestFirst` / `newestFirst` in `functions/common/store.ts`); ROWID order remains for paging, where any stable order will do.

## Collections, phase 1 (2026-10-14)

Unpaid fees, instalments and royalty invoices are chased on a ladder, worked by finance from one list, and offline payments are recorded in Books. Design and detail in `docs/collections.md`.

- **Data Store (Development):** create table `collections` with the columns listed in `docs/collections.md` (`collection_key` unique, `project_id` and `franchisee_id` nullable foreign keys, booleans `escalated` and `promise_broken`, ints `step` and `reminders_sent` and `days_to_pay`, dates `due_date`, `invoiced_on`, `step_sent_on`, `promise_date`, `paid_on`, `closed_on`, datetimes `promised_at`, `disputed_at`, `last_contact_at`, text `promise_note`, `dispute_reason`, `last_contact_note`). Add `paid_on` (date) to `sales_reports`. As with every table, the App User role gets no rights.
- **Permission:** `collections.manage` is new. Finance Manager holds it: the seed gives it to new tenants, and STARK on Development has the `role_permissions` row (`permission_code = collections.manage`, `perm_key = <tenant_id>:FINANCE_MANAGER:collections.manage`, added 2026-10-14). Reading the list needs only `finance.view`. Any other brand tenant needs the same row.
- **Books scope:** recording a payment calls `POST /customerpayments`, which needs `ZohoBooks.customerpayments.CREATE` on the brand's refresh token. Until the token is regenerated with it, "Record payment" fails with Books' own reason and nothing is written.
- **Job:** the `reminders` step now runs the ladder (counted as `fees` for franchisee reminders and `collections` for staff escalations in the job log). The daily "instalment overdue" reminder is retired.
- **Screens:** Contracts → Collections (finance.view); Settings → Collections (the ladder); the dashboard's Receivables panel shows collected %, days to pay and the escalated, missed-promise and disputed counts, and the stores table has days to pay; "Collection" items in Needs your attention replace the plain overdue item for an escalated, disputed or promise-missed invoice.
- **Demo (aadai):** the overdue ₹7.96 L becomes a worklist. Run the reminders step (or wait for 03:30) and the items land on the steps their ages have reached; record a promise on one, a dispute on another, and a bank transfer with a UTR on a third, then watch the dashboard's collected % and the health reasons move.

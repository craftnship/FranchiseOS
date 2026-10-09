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

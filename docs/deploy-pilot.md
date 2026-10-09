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
     `ZohoCRM.modules.leads.ALL,ZohoCRM.modules.accounts.ALL,ZohoCRM.modules.contacts.ALL,ZohoSign.documents.ALL,ZohoSign.templates.ALL,ZohoBooks.contacts.ALL,ZohoBooks.invoices.ALL,ZohoProjects.portals.READ,ZohoProjects.projects.ALL,ZohoProjects.tasklists.ALL,ZohoProjects.tasks.ALL`;
     the Sign, Books and Projects scopes are needed from Step 5 on)
   - `fos_webhooks`: `FOS_CRM_WEBHOOK_SECRET`, a long random string (letters and digits)
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
| Franchise fee | tenant `settings_json.franchise_fee` | 0 skips the invoice |
| Agreement term, opening target | `agreement_term_years` (5), `opening_target_days` (120) | defaults |
| Sign template | `agreement_templates.zoho_sign_template_id` (QSR, version 1) | from Zoho Sign |
| Task dependencies in Zoho | `settings_json.projects_dependencies` | false until the V3 endpoint is verified |

The Sign template needs one signer role; the franchisee is assigned to it. Text fields named
`agreement_code`, `franchisee_name` and `application_code` are filled in when present.

Zoho Sign webhook (Settings > Developer settings > Webhooks), events "Completed", "Declined",
"Expired", "Recalled" and optionally "Viewed":
`https://franchiseos-60082871087.development.catalystserverless.in/server/fos_webhooks/webhooks/sign/STARK?token=<FOS_CRM_WEBHOOK_SECRET>`.
Only the request id is taken from the callback; its status is read back from Sign.

When a step after signing fails (a Zoho outage, a timeout), the callback answers 502, and a replay
of the callback or `POST /api/v1/agreements/{id}/onboard` finishes only the unfinished steps.

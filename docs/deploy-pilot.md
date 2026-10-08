# Deploying the pilot (Development)

Run these on a computer with Node 20+ and the repo cloned.

1. Install and sign in to the Catalyst CLI (once):
   ```
   npm install -g zcatalyst-cli
   catalyst login
   ```
2. Build and deploy both functions:
   ```
   git checkout claude/api-step1
   npm ci
   npm run package:functions
   cd catalyst
   catalyst project:use        # pick FranchiseOS, Development
   catalyst deploy --only functions
   ```
3. In the Catalyst console (FranchiseOS > Serverless > Functions), add environment variables:
   - on `fos_api` and `fos_webhooks`: `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`
     (a Self Client from api-console.zoho.in, refresh token with scope `ZohoCRM.modules.leads.ALL`)
   - on `fos_webhooks`: `FOS_CRM_WEBHOOK_SECRET`, any long random string. CRM sends it as the
     `x-fos-webhook-secret` header.

The Stark Industries tenant already has its `tenant_integrations` row (provider ZOHO, data center IN);
the function reads the refresh token and webhook secret from these env variables for the pilot.

After the deploy, the API Gateway routes and the CRM workflow rule are set up from the project thread.

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

Not in this release: projects, agreements, dashboards, CRM and Sign webhooks (plan Steps 2 and 5–6).

## Deploying

```
npm ci
npm run package:functions      # tsc, then copies dist/ into catalyst/functions/fos_api/
cd catalyst && catalyst deploy --only functions:fos_api
```

Then add one API Gateway route: source `/api/v1/{path:.*}` (method ANY), target the `fos_api`
Advanced I/O function, authentication "Catalyst Authentication".

## First user

Users are linked by `users.external_user_id` = the Catalyst Authentication user id. Add a row with the
tenant id, that id, `status` ACTIVE and the role id from `database/catalyst/development-seed.json`.

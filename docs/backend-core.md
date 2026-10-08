# FranchiseOS backend core

Built from the FranchiseOS implementation spec and the plan in `../franchiseos-implementation-plan.md`, with all 23 recommended defaults (D-1..D-23) applied.

## What is here

| Path | Contents |
|---|---|
| `functions/common` | Tenant resolution, RBAC, error envelope, structured logging with secret redaction, tenant-scoped repository, Catalyst Data Store adapter with ZCQL escaping, business ID generator, activity log |
| `functions/workflows` | State machines (application, site, project, agreement), transition engine, approval engine (versioned, conditional steps, delegation, SLA sweep), territory reservation with conflict lock, checkpointed Zoho Projects creation |
| `functions/scoring` | Qualification, site evaluation, territory opportunity, feasibility with scenarios, opening readiness |
| `functions/integrations` | Zoho region resolver, retry with backoff and dead letter, webhook idempotency, provider client contracts |
| `database/schema/tables.ts` | 42 Data Store tables (38 MVP, 4 phase 2) with real column types, foreign keys and unique lock columns |
| `database/seed/defaults.ts` | Role permissions, default approval chain, QSR opening template, default weights and thresholds |
| `tests/unit` | 53 unit tests |

## Run

```
npm install
npm run typecheck
npm test
```

## Not built yet

API handlers and API Gateway routes, CRM and Sign webhook handlers, real Zoho HTTP clients, Job functions, the React client and portal. These follow in plan Steps 2 to 6.

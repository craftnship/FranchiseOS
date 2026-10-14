# Collections

Royalty, fee and instalment invoices that get paid without anyone chasing them. The POS feed (docs/pos-sales.md) fixed how much is billed; this is the next leak, collection. Today FranchiseOS raises the Books invoice, emails it, and waits for the nightly sync to notice a payment. The demo network carries ₹15.06 L in receivables with ₹7.96 L overdue, and the payment part of the health score is what pulls stores down.

Everything stays inside Zoho: Zoho Books holds the invoices and payments as it does today, and Zoho Payments (the brand's own account, in INR) takes the money. Nothing here changes a franchisee's Books.

## Decisions (2026-10-14)

- **No late fee.** The agreement template does not provide for one, so the ladder reminds and escalates without charging. If a brand wants one later it is a clause in the template plus one setting.
- **Zoho Payments is not activated on the brand's Books organisation.** Pay now links and UPI AutoPay therefore wait (phase 2). Activation is the brand's step: Books → Settings → Online Payments → Zoho Payments, with business KYC (PAN, GSTIN, bank account) and Zoho's verification, which takes days. Until then the invoice carries the bank details Books prints on it, and finance records what arrives.

## Phase 1, built 2026-10-14

What runs now, with only the brand's Books:

1. **The reminder ladder** (`functions/workflows/collections.ts`, run inside the daily `reminders` step). Every unpaid fee, instalment and royalty invoice gets a `collections` row. Each day the row moves to the ladder step its age has reached and the people on that step hear once, by email and inbox: by default the franchisee 3 days before due and on the due day, the franchisee and the franchise manager at 7 days late, the franchisee and finance at 15, the director and finance at 30 (flagged). An invoice that is already late when it first appears goes straight to the step its age has reached, not through every earlier one. The old daily "instalment overdue" reminder is gone; the ladder replaces it for every kind of invoice.
2. **The worklist** (Contracts → Collections, `finance.view`): every open item with store, what it is for, the Books invoice, the amount, its age and step, and the last thing done about it. Filters: open, overdue, escalated, promised, disputed, paid. Actions (`collections.manage`: Finance Manager and super admins): **Record payment** (below), **Promise** (a date and a note; the ladder waits until that day, and finance hears once if it passes unpaid), **Note** (a call, a meeting), **Dispute** (pauses reminders with a reason) and **Resume**, **Remind now** (today's reminder to the franchisee, whatever the ladder says). Everything lands in the activity log (`collection:promise`, `collection:note`, `collection:disputed`, `collection:resumed`, `collection:reminded`, `collection:payment`).
3. **Recording offline payments.** Most franchisees pay by NEFT or RTGS. Finance enters the amount, date, mode and UTR; FranchiseOS records a customer payment in Zoho Books against the invoice (`POST /customerpayments`, needs the `ZohoBooks.customerpayments.CREATE` scope on the brand's token), re-reads the invoice, and the fee, instalment or report closes exactly as it would from the nightly sync. Books stays the ledger.
4. **Payment behaviour** (`paymentBehaviour`): over the last 90 days, what was billed and what of it is collected (collection rate), and the average days from invoice to payment across the three sources, with `sales_reports.paid_on` now kept so royalty invoices count. The owner dashboard's Receivables panel shows both plus escalated, missed-promise and disputed counts; the stores table has days to pay per store (over 180 days).
5. **Health score, payments part:** an invoice on a flagged step caps the part at 25 ("Payment escalated, 55 days overdue"); a store that takes more than 30 days to pay on average loses 10 points even with nothing owed ("Nothing owed, pays in 41 days on average").
6. **Settings → Collections** (`settings.manage`): the ladder, editable per step (days from due, franchisee, roles, flag), saved as `settings_json.collections.ladder`.

Tables: **`collections`** (`collection_key` unique = `<KIND>:<source ROWID>`, `kind` FEE | INSTALMENT | ROYALTY, `source_id`, `project_id`, `franchisee_id`, `invoice_number`, `zoho_books_invoice_id`, `period`, `label`, `amount` (the balance), `total`, `due_date`, `invoiced_on`, `status` OPEN | PROMISED | DISPUTED | PAID | CLOSED, `step`, `step_sent_on`, `reminders_sent`, `escalated`, `promise_date`, `promise_note`, `promised_at`, `promise_broken`, `dispute_reason`, `disputed_at`, `last_contact_at`, `last_contact_note`, `paid_on`, `days_to_pay`, `closed_on`) and the new column `sales_reports.paid_on` (date).

API: `GET /collections?status=` (finance.view); `POST /collections/:id/promise|note|dispute|resume|remind|payment` (collections.manage); `GET|PUT /settings/collections` (settings.manage). Owner dashboard: `receivables.collections { rate_pct, billed_90d, collected_90d, days_to_pay, open, escalated, broken_promises, promised, disputed }`, per store `days_to_pay`, attention items of kind "Collection".

Tests: `tests/unit/collections.test.ts` (the ladder step by step and the jump for an already-late invoice; a promise holding the ladder and being broken; dispute and resume; remind now; a bank transfer recorded in Books closing the report and measuring days to pay; an item paid in Books closing on its own; ladder settings; the health scoring; the behaviour window).

Phase 2 (Pay now, autopay, webhooks) is the design below; it slots onto these rows without rework.

## What it adds

1. **Pay online from every invoice.** Every invoice FranchiseOS raises carries Zoho Payments, so the invoice email from Books and the invoice's own page have Pay now with UPI, card and net banking. The portal shows a Pay button on each open invoice that opens that page.
2. **Autopay.** A franchisee sets up a UPI AutoPay mandate once, from the portal. On the due day the system collects the invoice on the mandate and Books records the payment. See the limits below before promising "silent" debits: above ₹15,000 the franchisee confirms each debit with their UPI PIN, so for most royalty invoices autopay means a request that lands in their UPI app on the due day, approved with one tap, rather than money that moves on its own.
3. **A dunning ladder** the tenant configures: a reminder before due, one on the due day, then escalations at 7, 15 and 30 days late to the franchise manager, finance and the director. Email and in-app now; Cliq or WhatsApp later.
4. **Payments arrive by themselves.** A Books payment webhook tells FranchiseOS the moment a payment is recorded, whatever the channel (gateway, autopay, or a bank transfer finance typed in), and the invoice, report or instalment is marked paid the same minute. The nightly sync stays as the safety net.
5. **Owner dashboard:** collection rate, average days to pay per store, autopay coverage ("3 of 5 stores on autopay"), and the overdue line that falls once autopay starts. A store on autopay with nothing overdue scores full marks on the payment part of the health score.

## What Zoho offers, checked 2026-10-14

From the Zoho Payments India help and API docs (links at the end):

- **Methods:** UPI (0.5% fee, T+1 payout), cards (2%, India-issued only, T+2), net banking (2%), wallets and bank transfer on request. Payments are collected only within India and in INR. Most methods are enabled within 10 business days of the account going live.
- **UPI AutoPay** is the only mandate type; there is no e-NACH or card mandate. Enrolment costs ₹7.50, each execution ₹5 (up to ₹1,000) or ₹15. "Available on request", so it has to be asked for on the account. Executions above ₹15,000 need the customer's UPI PIN. NPCI allows executions only before 10:00, 13:00–17:00 and after 21:30, and the customer must be notified at least 24 hours before each debit. A mandate cannot be changed once created; the customer can pause or cancel it from their UPI app. The per-execution cap NPCI sets for this category is to be confirmed with Zoho (₹1 L is the usual figure); a royalty invoice above the cap goes out on a Pay now link instead.
- **Mandate flow (API):** create a customer, create a mandate enrolment session, the customer authorises in the Zoho Payments widget (hosted in the portal page with the account's public key), then for each debit: send the mandate notification (`mandate_id`, `amount`, `execution_date`, `invoice_number`), wait 24 hours, create an execution session (`type: mandate_execution`, valid 3 days), execute (`mandate_id`, `payments_session_id`, `mandate_notification_id`, `invoice_number`, `reference_number`). Up to 3 retries an hour apart inside one session. Zoho's own help says mandate executions through the API "are not automated and must be triggered manually", which is exactly what the job does.
- **Webhooks:** registered by API (`POST /webhooks`, scope `ZohoPay.settings.CREATE`) with an HTTPS URL and `enabled_events`; the response carries an HMAC-SHA256 `signing_key`, shown once. Events: `payment.succeeded`, `payment.failed`, `payment_link.paid`, `mandate.active`, `mandate.paused`, `mandate.resumed`, `mandate.inactive`, `refund.succeeded`, `refund.failed`. A payment payload carries `payment_id`, `reference_number`, `invoice_number`, `amount`, `status`, `payment_method` (with `mandate_id` for autopay) and `meta_data`.
- **Books:** a gateway is integrated once at the organisation, then each invoice says which integrated gateways it accepts (the payment section under Terms & Conditions). The API shape for setting that on a new invoice (`payment_options.payment_gateways`) is undocumented and is the first thing to try in Development; the fallback is Books' organisation setting that puts the gateway on every new invoice.

## Design

### Pay now

- `approveReport`, the fee and instalment invoicing in `fees.ts` and `funding.ts` keep raising invoices as they do; the Books client gains `payment_options` on `createInvoice` when the tenant's collections setting `online_payments` is on, and `getInvoice` also returns `invoice_url` (Books' shareable invoice page, which carries Pay now). The URL is stored beside the invoice state (`invoice_url` on `agreements`, `fee_instalments` and `sales_reports`).
- The portal's open invoices (home to-dos and the Funding and Sales pages) get a **Pay** button to that page. Staff see the same link on the store page and in Contracts → Franchise fees, so finance can send it in a chat.
- Nothing else changes for a tenant whose Books has no gateway: the setting stays off and the invoices go out as today.

### Autopay

- New table **`payment_mandates`**: `franchisee_id`, `provider` (ZOHO_PAYMENTS), `zp_customer_id`, `mandate_id`, `status` (PENDING, ACTIVE, PAUSED, INACTIVE), `max_amount`, `upi_handle_masked`, `activated_at`, `last_execution_at`, `last_error`, `mandate_key` (unique, `tenant:franchisee:mandate_id`). One active mandate per franchisee; it covers every store the franchisee runs.
- **Setup from the portal** (Funding and fees page, and a card on the portal home while none exists): "Set up autopay" opens the Zoho Payments widget on the page with an enrolment session the API created (`POST /portal/autopay/start`). When the widget reports success the row is PENDING; `mandate.active` from the webhook makes it ACTIVE. The franchisee sees status, the UPI handle, and "Pause or cancel from your UPI app". Staff with `finance.view` see the same on the franchisee page.
- **Collecting on it.** New table **`invoice_collections`**: one row per invoice being collected, `kind` (FEE, INSTALMENT, ROYALTY), `source_row_id`, `zoho_books_invoice_id`, `invoice_number`, `amount`, `due_date`, `mandate_id`, `notification_id`, `notified_at`, `session_id`, `payment_id`, `status` (SCHEDULED, NOTIFIED, EXECUTED, PAID, FAILED, OFF_MANDATE), `attempts`, `last_error`, `dunning_step` (the highest ladder step sent), `last_reminded_on`. The new job step **`collections`** (after `two_way_sync`, before `store_health`) does, per tenant:
  1. Every unpaid invoice of a franchisee with an ACTIVE mandate gets a row. Two days before due it sends the mandate notification for the balance (within the mandate's cap; above it the row goes OFF_MANDATE and the dunning ladder handles it with Pay now).
  2. On or after the due day, when 24 hours have passed since the notification, it creates the execution session and executes inside the next NPCI window (the 03:30 run is inside "before 10:00"). Retries: 3 an hour apart in one session; the step runs them on the following nights rather than waiting, so a failed debit is retried on the next two nights, then the row is FAILED, the franchisee and finance are told once, and the ladder takes over.
  3. `payment.succeeded` for a mandate execution records a customer payment in Books against the invoice (`POST /customerpayments`), so Books stays the ledger; the Books payment webhook (below) then marks the FranchiseOS row paid like any other payment.
- A paused or cancelled mandate (`mandate.paused`, `mandate.inactive`) stops scheduling, tells finance and the franchise manager once, and shows on the franchisee page.

### Dunning ladder

- Tenant setting `collections.dunning`, a list of steps, default:

  | Days from due | Who | What |
  |---|---|---|
  | −3 | franchisee | "Invoice ROY-… for ₹… is due on 7 Nov" with Pay now; skipped when an active mandate will collect it |
  | 0 | franchisee | due today |
  | 7 | franchisee, FRANCHISE_MANAGER | 7 days late |
  | 15 | franchisee, FINANCE_MANAGER | 15 days late |
  | 30 | FRANCHISE_DIRECTOR, FINANCE_MANAGER | escalated; the store is flagged on the dashboard and the health reason says so |

- The reminders job sends each step once per invoice (`dedupe` `dun:<invoice>:<step>`), via the existing `deliver`, so email and inbox work as they do today. It replaces the daily "fee overdue" and "instalment overdue" reminders, which stop (one ladder for every kind of invoice).
- The ladder never runs on a DRAFT or VOID invoice, or on an invoice under ₹100.

### Payments arrive

- **Books payment webhook** `POST /webhooks/books/payment/:TENANT`, sent by a Books Workflow Rule on Customer Payment created or updated (set up once per tenant in Books: Settings → Automation → Workflow Rules → Customer Payments → Webhook, header `x-fos-webhook-secret` with the tenant's existing webhook secret). The handler reads the payment's invoices, refreshes each one with the existing `refreshFee` / `refreshReport` / instalment refresh, marks `invoice_collections` PAID, and logs `payment:received` so the franchisee ("Thanks, ₹… received for ROY-…") and finance hear. Idempotent on `payment_id` through `integration_events`.
- **Zoho Payments webhook** `POST /webhooks/payments/:TENANT`, verified with the signing key (HMAC-SHA256 over the raw body; the header name is in Zoho's verification guide and is confirmed in Development). Handles `mandate.*` (mandate status), `payment.succeeded` / `payment.failed` for mandate executions (record in Books, or mark the collection FAILED with Zoho's `failure_code`), and ignores the rest. The signing key is stored encrypted on the tenant's `tenant_integrations` row (`payments_webhook_key`), with `FOS_PAYMENTS_WEBHOOK_KEY` as the pilot fallback like the CRM secret.
- The nightly `two_way_sync` keeps reading unpaid invoices, so a lost webhook costs a day, not a payment.

### Dashboard, health and attention

- **Owner dashboard, Collections tile** (finance.view): collection rate over the last 90 days (collected ÷ billed, by invoice date), average days to pay (payment date − invoice date, paid invoices of the last 6 months), autopay coverage (franchisees with an ACTIVE mandate over franchisees with an open store), and the overdue series by week so the drop after autopay is visible. Per store in the stores table: days to pay and an autopay pill.
- **Needs your attention:** "Madurai: ROY-… 15 days late, ₹…" at step 15 and above, kind "Collection"; "Madurai autopay paused" when a mandate stops; "Madurai autopay failed twice" on a FAILED collection.
- **Health score, payments part:** unchanged scoring, plus: an ACTIVE mandate with nothing overdue scores 100 even while an invoice is open ("Autopay on, nothing overdue"); an invoice at ladder step 30 caps the part at 25 whatever the amount ("ROY-… 30 days late, escalated").

### Settings

Settings → Collections (`settings.manage`): online payments on/off, autopay on/off (shown only when the Zoho Payments account id is configured), the ladder (editable days and roles), and who is told when a mandate pauses. Readable through `GET /settings/collections`, written with `PUT`.

### Permissions

`finance.view` sees everything above. `fee.manage` waives late fees. New **`collections.manage`**: run a collection by hand ("Collect now" on an invoice with a mandate, outside the job), cancel a scheduled collection, and re-register the webhook. Finance Manager holds it from 2026-10-14 (seeded for new tenants; one `role_permissions` row on STARK), as do super admins.

### Configuration

- Brand Zoho client (the existing Self Client): add scopes `ZohoPay.payments.CREATE`, `ZohoPay.payments.READ`, `ZohoPay.mandates.CREATE`, `ZohoPay.mandates.READ`, `ZohoPay.settings.CREATE` and Books' `ZohoBooks.customerpayments.CREATE` when the token is regenerated. Scope names are confirmed against the API docs when the client is updated.
- Env on `fos_api`, `fos_jobs`, `fos_webhooks`: `ZOHO_PAYMENTS_ACCOUNT_ID`; on the web app, the account's public key for the widget (`VITE_ZOHO_PAYMENTS_KEY`), which is not a secret. `FOS_PAYMENTS_WEBHOOK_KEY` as the pilot fallback for the signing key.
- Books: Zoho Payments integrated on the brand's organisation; the Workflow Rule for customer payments pointed at `fos_webhooks`.

## API

- `GET /portal/invoices` — the franchisee's open invoices across their stores with `pay_url`, due date, days late, and whether autopay will collect it.
- `POST /portal/autopay/start` → `{ session_id, public_key }` for the widget; `GET /portal/autopay` → the mandate; `DELETE /portal/autopay` records the cancel request (the mandate itself is cancelled in the UPI app).
- `GET /franchisees/:id/collections` (finance.view) — mandate, open invoices with ladder step and schedule, payments received.
- `POST /collections/:id/collect` (collections.manage) — notify and schedule now; `DELETE /collections/:id` — take an invoice off the mandate.
- `POST /fees/late/:id/waive` (fee.manage).
- `GET /settings/collections`, `PUT /settings/collections` (settings.manage).
- Webhooks: `POST /webhooks/books/payment/:TENANT`, `POST /webhooks/payments/:TENANT`.
- Owner dashboard: `revenue.collections { rate_pct, days_to_pay, autopay: { on, total }, overdue_series }`; per store `days_to_pay`, `autopay`.

## Build order

1. **Pay now and payments arriving** (no Zoho Payments API yet): `invoice_url` and `payment_options` on invoices, the portal Pay button, the Books payment webhook, `invoice_collections` and the dunning ladder, the Collections tile and attention items, health changes for step 30. Demo-able with the brand's Books alone.
2. **Autopay**: `payment_mandates`, the portal widget, the `collections` job step, the Zoho Payments webhook, autopay coverage and the health bonus.

## Tests

Unit tests with a fake Books and a fake Payments client: the ladder sends each step once and skips the pre-due step when a mandate is active; a payment webhook marks a royalty, a fee and an instalment paid and is idempotent; a mandate execution follows the 24-hour rule and the NPCI window, retries twice, then fails over to the ladder; a paused mandate stops scheduling; the dashboard rate, days to pay and coverage; the health bonus and cap. Webhook signature checks for both routes, including a wrong key and a replay.

## Demo (aadai)

With Zoho Payments in test mode on the brand's account: switch on online payments, run the ladder against the ₹7.96 L overdue (Madurai's and Hyderabad's royalty invoices land at steps 7 and 15), set up autopay for Chennai in the test widget, then post a test `payment.succeeded` and a Books payment for Madurai's oldest invoice and watch the overdue line, the attention list and Madurai's health reason change. If the account is not live yet, the Books payment webhook alone still demonstrates payments arriving: record a payment in Books and the portal and dashboard update within the minute.

## To confirm on the Zoho side

1. When Zoho Payments is activated on the brand's Books organisation, which methods are live (UPI, cards, net banking)? UPI AutoPay is "on request": ask for it at activation.
2. The NPCI per-execution cap for this business category, and whether the brand wants invoices above it split or sent on Pay now.

## Sources

- Zoho Payments India, payment methods: https://www.zoho.com/in/payments/help/settings/methods
- Zoho Payments India, mandates overview: https://www.zoho.com/in/payments/help/mandates
- Zoho Payments, creating and executing mandates: https://www.zoho.com/in/payments/developerdocs/mandates/create-execute-mandates
- Zoho Payments API, webhooks and events: https://www.zoho.com/in/payments/api/v1/webhooks and https://www.zoho.com/in/payments/api/v1/webhooks-events/
- Zoho Books, online payments on invoices: https://www.zoho.com/in/books/kb/payments/online-payment.md

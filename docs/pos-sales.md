# POS sales feed

Daily sales straight from each store's own Zoho Books, so royalty is worked out from what the till recorded rather than what the franchisee typed in at month end. Under-reporting is the largest leak in franchising; this closes it without leaving the Zoho ecosystem.

## The decision behind it

Each franchisee is its own company with its own GSTIN, so its sales live in the franchisee's own Zoho Books organisation (fed by Zoho's POS or any till that posts to Books), not the brand's. FranchiseOS therefore connects to **each franchisee's Books**, read-only, with the franchisee's consent. The brand's own Books stays what it is today: where the brand raises fee and royalty invoices.

Stores whose till does not post to Books (or no till at all) can upload a daily CSV instead. The feed, the comparison and the royalty logic are the same whichever way the rows arrive.

## Connecting a store

1. On the portal home, a **Connect your Zoho Books** card (one per franchisee, covering all their stores). The owner clicks Connect.
2. `POST /portal/connections/zoho/start` returns the Zoho consent URL: the POS OAuth client (`ZOHO_POS_CLIENT_ID`, a Server-based client; the brand's own client when that is one too), scopes `ZohoBooks.invoices.READ`, `ZohoBooks.creditnotes.READ`, `ZohoBooks.settings.READ`, `access_type=offline`, and a signed `state` (tenant, franchisee, user, expiry, HMAC with `FOS_STATE_SECRET`).
3. Zoho sends the browser to the web app at `/connect/zoho/callback?code=…&state=…`. That page posts both to `POST /portal/connections/zoho/exchange`, which checks the state, swaps the code for a refresh token, lists the organisations the token can see, and stores the connection. If the token sees more than one organisation the page asks which one is the store's.
4. The connection row holds `provider = ZOHO_BOOKS`, `org_id`, the refresh token (encrypted column), the scopes, who connected it and when, the last pull and the last error. The franchisee can disconnect; the brand can see the status.

Each store (project) is tied to one connection through its franchisee. A franchisee with several stores in one Books organisation maps each store to a Books **branch** or **location** when Books has them (`pos_location_id` on the project); otherwise all of the organisation's sales count for the one store.

The same mechanism will later serve the brand's own connection (today a token set by hand in the console).

## Data

- **`franchisee_connections`**: `tenant_id`, `franchisee_id`, `provider`, `zoho_dc`, `org_id`, `org_name`, `refresh_token` (encrypted), `scopes`, `status` (ACTIVE, FAILING, DISCONNECTED), `connected_by`, `connected_at`, `last_pulled_at`, `last_error`, `conn_key` unique (`tenant:franchisee:provider`).
- **`pos_sales`**: one row per store per day. `tenant_id`, `project_id`, `franchisee_id`, `day` (date), `day_key` unique (`tenant:project:day`), `gross_sales`, `discounts`, `returns`, `net_sales` (gross − discounts − returns, before tax), `tax`, `transactions`, `source` (BOOKS, UPLOAD), `pulled_at`. About 30 rows per store per month; reads are always by date range, never the whole table.
- **`franchise_projects`** gains `pos_location_id` and `pos_status` (CONNECTED, STALE, NONE), `pos_last_day`.
- **`sales_reports`** gains `pos_net_sales`, `reported_net_sales`, `variance_pct`, `basis` (REPORTED, POS). `net_sales` stays the figure royalty is billed on.

## Pulling

A `pos_sales` step in the daily job, after `two_way_sync`:

- For each active connection: Books invoices with `date` in the window (status not `draft` or `void`), summed per day: `sub_total` as gross, `discount_total`, `tax_total`; credit notes in the window as returns. The window is the last 3 days, or the last 90 days on the first pull (and whenever a store's last pulled day is older than 3 days). Rows are upserted by `day_key`, so a rerun corrects rather than duplicates.
- A failing connection (token revoked, organisation gone) is marked FAILING with the error, the franchisee is notified once (`pos.connection_failed`), and the store's `pos_status` becomes STALE after 2 days without a new day.
- Uploads: `POST /projects/:id/pos/upload` takes a CSV (`date, gross_sales, discounts, returns, tax, transactions`) from the franchisee or staff, validated row by row, upserted the same way with `source = UPLOAD`.

## Royalty on real sales

Tenant setting `royalty_basis`: `REPORTED` (today's behaviour) or `POS`. A store with a feed follows `POS`; a store with none falls back to `REPORTED`, and the owner dashboard shows how many stores are on each.

With `POS`, on the report due day the job closes the month itself: it sums `pos_sales` for the month, writes or updates the month's `sales_reports` row with `basis = POS`, `source = POS`, `net_sales = pos_net_sales`, and submits it. The franchisee's own figure, when they entered one, is kept in `reported_net_sales` and the difference in `variance_pct`.

- Variance within `pos_variance_tolerance_pct` (default 5) and `royalty_auto_approve = true`: the report is approved and invoiced by the job, with the usual claim so it is billed once.
- Otherwise the report waits for finance as today, with the variance shown in red on the Royalties screen and a "Needs your attention" item: "Madurai reported ₹5.6 L, the till says ₹6.4 L (−12%)".
- A month with a gap in the feed (missing days) is never auto-approved; the gap is listed on the report.

`royalty_auto_approve` defaults to `false` for the pilot; it is a settings switch under Admin → Settings → Royalties.

## Health score

The Reporting part gains the feed: a store on the feed scores 100 when its feed is current, 60 when stale, and the "missing report" case no longer applies to it. A variance above tolerance in any of the last three months drops Reporting to 20, under the weak-part limit, so the store ranks no higher than Watch until those months roll off, with the reason "Till and report differ by 12% in Sep 2026". Under-reporting is the leak the feed exists to find, so it is never a two-point footnote.

## Screens

- **Portal home**: the Connect card, with status, organisation name, last pull and Disconnect. Per store: "Till connected · last day 12 Oct" or "Upload daily sales".
- **Royalties** (store page and the brand's Royalties page): each month shows POS net, reported net and the variance; the basis badge on the row; the feed status in the header.
- **Owner dashboard**: "Till coverage: 4 of 5 stores" beside Stores trading; the revenue series uses POS where a store has it. The attention list carries variance and stale-feed items.
- **Admin → Settings → Royalties**: basis, tolerance, auto-approve.

## API

| Route | Permission | Does |
|---|---|---|
| `POST /portal/connections/zoho/start` | `portal.view` (franchisee) | Consent URL with signed state |
| `POST /portal/connections/zoho/exchange` | `portal.view` | Stores the connection; lists organisations when there are several |
| `GET /portal/connections` | `portal.view` | The franchisee's connections and each store's feed status |
| `DELETE /portal/connections/:id` | `portal.view` | Disconnects (token dropped) |
| `GET /projects/:id/pos` | portal owner or staff with `dashboard.view` | Daily rows for a month, feed status, gaps |
| `POST /projects/:id/pos/upload` | portal owner or `royalty.manage` | CSV upload |
| `POST /admin/pos/pull` | `integration.admin` | Runs the pull now |
| `GET`/`PUT /settings/royalties` | `settings.manage` | Basis, tolerance, auto-approve |

## Deploy

1. On the Zoho API console, a Server-based client with the web app's address as its redirect URI (the brand's Self Client cannot take one). Its ID and secret go in `ZOHO_POS_CLIENT_ID` and `ZOHO_POS_CLIENT_SECRET` on fos_api and fos_jobs.
2. Set `FOS_STATE_SECRET` (long random) on fos_api and fos_jobs.
3. Create `franchisee_connections` and `pos_sales`; add the columns on `franchise_projects` and `sales_reports`.
4. Deploy the functions and the web app.

## Tests

The state is signed and expires; the exchange refuses a tampered state and a franchisee who is not the one in it; the pull sums invoices and credit notes per day and reruns without duplicates; a failing connection is marked and notified once; the month closes from POS rows with the variance against the franchisee's figure; within tolerance plus auto-approve invoices once; a gap blocks auto-approval; CSV upload validates rows; the health Reporting part reads the feed.

## Demo (aadai)

No demo franchisee has a Books organisation, so the demo uses uploads: three months of daily rows for Chennai, Bengaluru and Coimbatore (Coimbatore's till 12% above its reported September) and no feed for Madurai and Hyderabad. The Royalties screen then shows the variance, the owner dashboard "Till coverage: 3 of 5", and Coimbatore's September waits for finance with the difference in red.

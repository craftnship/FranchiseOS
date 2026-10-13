# Franchisee health score

One number per trading store that says how the franchisee is doing, with the two things dragging it down in plain words. It is for the brand owner's dashboard, the store page and the map, and it warns the brand team months before a store fails.

## The score

A 0–100 score made of five parts. Each part scores 0–100 on its own, and the score is the weighted average of the parts that have data.

| Part | Weight | What it measures |
|---|---|---|
| Sales | 35 | Average of the last three full reported months against the feasibility plan, less a penalty for each month under plan |
| Payments | 25 | How old the oldest unpaid fee or royalty invoice is, and how the overdue amount compares with a month's royalty |
| Compliance | 20 | The latest audit score, less open critical and overdue actions, expired licences and an overdue audit |
| Reporting | 10 | Share of the last six sales reports that came in on time, by the tenant's report due day; for a store on the POS feed, whether the feed is current and whether a recent report strayed from it |
| Customer | 10 | Complaints from Zoho Desk. Left out until Desk is linked |

- A part with no data (a store too new to have a full month, no audit yet, nothing owed) is left out and the other weights scale up.
- A store that has opened but has no data in any part is **unscored**. Openings in progress are not scored.
- The weights live in tenant settings (`health_weights`) and can be changed under Admin → Settings → Health.

### How each part scores

**Sales.** Average net sales over the last three full months, against the feasibility model's monthly revenue:

| Vs plan | Score |
|---|---|
| +10% or better | 100 |
| 0% | 85 |
| −10% | 65 |
| −20% | 40 |
| −30% | 20 |
| −40% or worse | 0 |

Points between the rows are interpolated, then 5 points come off for each month under plan after the first. Without a plan or a full reported month, the part is left out.

**Payments.** Nothing owed scores 100. Otherwise the oldest overdue item sets the base (not yet overdue 90, 1–30 days 70, 31–60 days 45, 61–90 days 25, over 90 days 5), then 5 points come off when the overdue amount is more than a month's royalty and 15 when it is more than two months'. Owed items are the same ones the Receivables panel ages: the agreement's fee, instalments and royalty invoices.

**Compliance.** Starts from the latest completed audit's score. Then 15 points come off per open critical action (up to 30), 5 per overdue action (up to 20), 15 per expired licence (up to 30), and 10 when the next audit is overdue. A store never audited scores 40 when its first audit is overdue, and is otherwise left out.

**Reporting.** Over the last six months due, a report on time counts 100, late 50, missing 0. A store on the POS sales feed (docs/pos-sales.md) is judged by the feed instead: 100 while it is current, 60 when stale, and 20 when the franchisee's figure for any of the last three months differs from the POS figure by more than the tolerance. 20 is under the default weak-part limit, so such a store ranks no higher than Watch until those months roll off, with the reason "Sep 2026 sales under-reported by 12% (POS ₹6.4 L, reported ₹5.6 L)".

## Bands

| Band | Score |
|---|---|
| Healthy | 70 or more |
| Watch | 50–69 |
| At risk | under 50 |

If any one part scores under 25, the store ranks no higher than Watch, whatever its total. The limits (`health_healthy_from`, `health_watch_from`, `health_part_floor`) are tenant settings too.

## Reasons

Every scored store carries its two weakest parts in plain words, for example "Sales 18% under plan for 3 months" or "₹1.2 L overdue, oldest 45 days". Amounts appear only for people with `finance.view`; everyone else sees "Payments overdue, oldest 45 days".

## Data

- `franchise_projects` gains `health_score`, `health_band`, `health_json` (the parts and reasons), `health_updated_on` and `health_alerted_band`.
- A new `store_health` table keeps one row per store per day: `project_id`, `as_of`, `score`, `band`, `parts_json`, with `health_key` (`tenant:project:as_of`) unique so a rerun updates rather than duplicates.
- The receivables calculation moves out of the owner dashboard into `workflows/receivables.ts`, so the dashboard and the score age debt the same way.

## Daily job

A `store_health` step runs in the 03:30 job after `two_way_sync`. For each trading store it recomputes the score, writes the project columns and the day's `store_health` row, and:

- writes an activity log entry (`health:band_changed`) when the band changes;
- notifies the franchise and operations managers and the store's regional manager when a store enters At risk, or recovers to Healthy from At risk. `health_alerted_band` records the last band alerted, so each change alerts once.

`POST /admin/health/recalculate` runs the same step now, for the first run and after the weights change.

## API

| Route | Permission | Returns |
|---|---|---|
| `GET /dashboard/health` | `dashboard.view` | Count per band, every scored store with its band and reasons, the five lowest, thresholds. Follows `region` and the caller's region lock |
| `GET /projects/:id/health` | staff with `dashboard.view`, or the store's own franchisee | Score, band, parts, reasons and up to 26 weeks of history |
| `POST /admin/health/recalculate` | `settings.manage` | Stores scored, bands changed, alerts sent |
| `GET` and `PUT /settings/health` | `settings.manage` | Weights and band limits |

## Screens

- **Dashboard:** a Health panel with the band bar and the five lowest stores, each with its reasons, linking to the store. The store league gains a Health column.
- **Map:** a "Colour by health" switch colours open stores by band.
- **Store page:** a Health card with the score, each part, the reasons and a trend over the last 26 weeks.
- **Settings:** the weights and band limits.

## Tests

Each part's edge cases, the weights scaling when a part is missing, the 25-point rule, the reasons text with and without finance access, no duplicate `store_health` row when the job reruns, the alert sent once per change, and the region filter on the dashboard.

## Deploy

1. Add the five columns to `franchise_projects` and create `store_health`.
2. Deploy the functions and the web app.
3. Call `POST /admin/health/recalculate` once as a super admin.

## Demo check (aadai)

Chennai should be Healthy; Coimbatore and Madurai on Watch (Madurai possibly At risk from its overdue amount); Hyderabad scored without the sales part because it is too new; Mysuru not scored because it is still opening. If the first run differs, suspect the scoring before the data.

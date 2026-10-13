import { lazy, ReactNode, Suspense } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, can, drillHref, Kpi, Row } from "../api";
import { useAction, useLoad } from "../hooks";
import { DataTable, date, Donut, Icon, inr, inrShort, KpiTile, label, Loaded, PageHeader, Panel, Pill, Progress, toneOf } from "../components/ui";
import { HealthPanel } from "../components/Health";

// The map's state shapes are a large chunk, so they load after the rest of the page.
const NetworkMap = lazy(() => import("../components/NetworkMap"));

// The brand owner's home: what the network earns and is owed, what needs a decision today, how
// stores rank and comply, then expansion and openings. Every number links to the records behind it.

type Network = Record<string, Kpi>;
const PERIODS: [string, string][] = [["1", "Last month"], ["3", "Last 3 months"], ["6", "Last 6 months"], ["12", "Last 12 months"]];
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Signed change with an arrow, so the direction never rests on colour alone. */
function Delta({ v, against }: { v: unknown; against: string }) {
  const n = num(v);
  if (n === null) return <span className="kpi-hint">No figures for {against}</span>;
  const cls = n > 0 ? "up" : n < 0 ? "down" : "";
  return <span className={`delta ${cls}`}>{n > 0 ? "▲" : n < 0 ? "▼" : "■"} {Math.abs(n)}%<span className="muted"> vs {against}</span></span>;
}

/** A headline figure with its change and an optional 12-month sparkline. */
function Headline({ title, value, to, children, spark }: { title: string; value: string; to: string; children?: ReactNode; spark?: number[] }) {
  const max = Math.max(1, ...(spark ?? []));
  return (
    <Link className="kpi headline" to={to} title="View the records">
      <div className="kpi-top"><span className="kpi-label">{title}</span></div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">{children}</div>
      {spark && spark.length > 1 && (
        <svg className="spark" viewBox={`0 0 ${spark.length * 10} 30`} preserveAspectRatio="none" aria-hidden="true">
          {spark.map((v, i) => <rect key={i} x={i * 10 + 1.5} width="7" y={30 - (v / max) * 28} height={(v / max) * 28} rx="1.5" className={i === spark.length - 1 ? "last" : ""} />)}
        </svg>
      )}
    </Link>
  );
}

const KIND_ICON: Record<string, string> = { Approval: "check", "Sales report": "history", Royalty: "money", Fee: "money", "Audit action": "audit", Audit: "audit", Licence: "agreements", "Purchase order": "box", Renewal: "sync", Launch: "flag" };

export function Dashboard() {
  const [params, setParams] = useSearchParams();
  const months = params.get("months") ?? "1";
  // Every panel follows the region picked here; a regional manager always sees their own (server-side).
  const region = params.get("region") ?? "";
  const rq = region ? { region } : {};
  const regions = useLoad(() => api<Row>("GET", "/dashboard/regions"), []);
  const network = useLoad(() => api<Network>("GET", "/dashboard/network", { query: rq }), [region]);
  const owner = useLoad(() => api<Row>("GET", "/dashboard/owner", { query: { months, ...rq } }), [months, region]);
  const pipeline = useLoad(() => api<Row>("GET", "/dashboard/pipeline", { query: rq }), [region]);
  const openings = useLoad(() => api<Row>("GET", "/dashboard/openings", { query: rq }), [region]);
  const risk = useLoad(() => api<Row>("GET", "/dashboard/risk", { query: rq }), [region]);
  const territories = useLoad(() => api<Row>("GET", "/dashboard/territories", { query: rq }), [region]);
  const reload = () => [regions, network, owner, pipeline, openings, risk, territories].forEach((l) => l.reload());
  const fees = useAction(() => { network.reload(); owner.reload(); });
  // Fee figures are refreshed daily from Books; this checks the unpaid ones now.
  const checkFees = () => fees.run("fees", () => api<Row>("POST", "/fees/sync"),
    (r) => (r.paid ? `${r.paid} fee${r.paid === 1 ? "" : "s"} newly paid in Books.` : r.checked ? `Checked ${r.checked} unpaid fee${r.checked === 1 ? "" : "s"} in Books; nothing new.` : "No unpaid fees to check."));
  const setParam = (k: string, v: string, fallback: string) => { const n = new URLSearchParams(params); if (v === fallback) n.delete(k); else n.set(k, v); setParams(n, { replace: true }); };
  const setMonths = (v: string) => setParam("months", v, "1");
  const rg = regions.data;
  const shownRegion = rg?.locked ? String(rg.region) : region;
  const o = owner.data;
  // Renewals and launches come from the network KPIs; they join the owner's list as "soon" items.
  const n0 = network.data;
  const extra: Row[] = [];
  if (n0?.renewals_due?.value) extra.push({ kind: "Renewal", tone: "warn", title: `${n0.renewals_due.value} agreement${n0.renewals_due.value === 1 ? "" : "s"} due for renewal`, detail: "Inside the notice period with nothing decided", href: "/renewals" });
  if (n0?.launches_behind?.value) extra.push({ kind: "Launch", tone: "warn", title: `${n0.launches_behind.value} new store${n0.launches_behind.value === 1 ? "" : "s"} behind the launch sales plan`, detail: `Of ${n0.launches_watching?.value} in their first weeks`, href: "/launches" });
  const attention: Row[] = o ? [...o.attention.items.filter((i: Row) => i.tone === "bad"), ...extra, ...o.attention.items.filter((i: Row) => i.tone !== "bad")] : [];
  const tally = (t: string) => attention.filter((i) => i.tone === t).length;
  const asOf = o ? new Date(String(o.as_of)).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : null;

  return (
    <div className="dashboard">
      <PageHeader title="Network overview"
        subtitle={o ? <>{shownRegion ? <><strong>{shownRegion}</strong> region · </> : null}Trading figures for <strong>{o.period.label}</strong> against {o.period.previous_label} · As of {asOf}</> : "Trading, compliance, expansion and openings"}
        actions={<>
          {rg?.locked ? <span className="region-pill" title="You see your region only"><Icon name="territories" size={14} />{String(rg.region)}</span>
            : rg && rg.regions.length > 1 && <select aria-label="Region" value={region} onChange={(e) => setParam("region", e.target.value, "")}><option value="">All regions</option>{rg.regions.map((x: string) => <option key={x} value={x}>{x}</option>)}</select>}
          <select aria-label="Period" value={months} onChange={(e) => setMonths(e.target.value)}>{PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          {can("finance.view") && <button className="btn secondary" onClick={checkFees} disabled={!!fees.busy}><Icon name="money" size={16} />{fees.busy ? "Checking…" : "Check fees in Books"}</button>}
          <button className="btn secondary" onClick={() => window.print()}><Icon name="folder" size={16} />Save as PDF</button>
          <button className="btn" onClick={reload}><Icon name="sync" size={16} />Refresh</button>
        </>} />
      {fees.notice && <div className="notice ok"><Icon name="check" />{fees.notice}</div>}
      {fees.error && <div className="notice bad"><Icon name="alert" />{fees.error.message}</div>}

      <h2 className="section-title">Revenue</h2>
      <Loaded load={owner}>{(d) => {
        const r = d.revenue, rc = d.receivables;
        return (
          <div className="kpis">
            <Headline title="Network sales" value={inrShort(r.net_sales)} to={`/analytics?months=${Math.max(3, Number(months))}`} spark={r.series.map((m: Row) => Number(m.net_sales))}>
              <Delta v={r.net_sales_change_pct} against={d.period.previous_label} />
            </Headline>
            {/* Before the month's reports are reviewed, billed is ₹0; show what they will raise instead. */}
            {d.finance && (!r.royalty && r.royalty_pending
              ? <Headline title="Royalty + fund due" value={inrShort(r.royalty_pending)} to="/royalties">
                  <span className="kpi-hint warn-text">{r.awaiting_review} report{r.awaiting_review === 1 ? "" : "s"} awaiting review</span>
                  <span className="kpi-hint">Billed once approved</span>
                </Headline>
              : <Headline title="Royalty + fund billed" value={inrShort(r.royalty)} to="/royalties">
                  {r.royalty || !r.reports ? <Delta v={r.royalty_change_pct} against={d.period.previous_label} /> : <span className="kpi-hint">Reports in, not yet invoiced</span>}
                  {r.collection_pct !== null && <span className="kpi-hint">{r.collection_pct}% collected</span>}
                  {r.royalty_pending > 0 && <span className="kpi-hint">+ {inrShort(r.royalty_pending)} on {r.awaiting_review} awaiting review</span>}
                </Headline>)}
            {d.finance && <Headline title="Receivables" value={inrShort(rc.total)} to="/fees">
              <span className={`kpi-hint ${rc.overdue ? "bad-text" : ""}`}>{rc.overdue ? `${inrShort(rc.overdue)} overdue` : "Nothing overdue"}</span>
              <span className="kpi-hint">Fees {inrShort(rc.fees)} · Royalty {inrShort(rc.royalty)}</span>
            </Headline>}
            <Headline title="Stores trading" value={String(r.stores_trading)} to="/projects?status=OPENED">
              <span className="kpi-hint">{r.reporting_pct === null ? "No reports due" : `${r.reports} of ${r.due} sales reports in (${r.reporting_pct}%)`}</span>
            </Headline>
          </div>
        );
      }}</Loaded>

      {/* Receivables are for finance.view only; without it the attention list takes the full width. */}
      <div className={o?.finance === false ? "row" : "row c21"}>
        <Panel title={<>Needs your attention{o && <span className="count-pill">{attention.length}</span>}</>}
          action={o && <span className="legend"><span><i className="sw bad" />{tally("bad")} urgent</span><span><i className="sw warn" />{tally("warn")} soon</span><span><i className="sw info" />{tally("info")} to review</span></span>} flush>
          <Loaded load={owner}>{() => {
            const items = attention;
            if (!items.length) return <div className="state">Nothing is waiting on the brand team right now.</div>;
            return (
              <ul className="attention">
                {items.slice(0, 12).map((i, k) => (
                  <li key={k} className={i.tone}>
                    <Link to={i.href}>
                      <span className={`att-icon ${i.tone}`}><Icon name={KIND_ICON[i.kind] ?? "alert"} size={15} /></span>
                      <span className="att-body"><span className="att-title">{i.title}</span><span className="att-detail">{i.kind} · {i.detail}</span></span>
                      <Icon name="chevron" size={14} />
                    </Link>
                  </li>
                ))}
                {items.length > 12 && <li className="more muted">And {items.length - 12} more</li>}
              </ul>
            );
          }}</Loaded>
        </Panel>

        {o?.finance !== false && <Panel title="Receivables ageing" action={<Link to="/fees?overdue=true">Overdue fees</Link>}>
          <Loaded load={owner}>{(d) => {
            const rc = d.receivables, max = Math.max(1, ...rc.ageing.map((b: Row) => Number(b.amount)));
            return (
              <>
                <ul className="ageing">
                  {rc.ageing.map((b: Row) => (
                    <li key={b.key} className={b.key}>
                      <span>{b.label}</span>
                      <span className="track"><span className="bar" style={{ width: `${(Number(b.amount) / max) * 100}%` }} /></span>
                      <span className="num">{b.amount ? inrShort(Number(b.amount)) : "—"}</span>
                    </li>
                  ))}
                </ul>
                <dl className="mini-facts">
                  <div><dt>Total owed</dt><dd>{inr(rc.total)}</dd></div>
                  <div><dt>Overdue</dt><dd className={rc.overdue ? "bad-text" : ""}>{inr(rc.overdue)}</dd></div>
                </dl>
                <p className="muted small">Unpaid franchise fees, instalments and royalty invoices from Books, by days past their due date.</p>
              </>
            );
          }}</Loaded>
        </Panel>}
      </div>

      <div className="row c21">
        <HealthPanel region={region} />
        <Panel title="Compliance" action={<Link to="/audits">Audits</Link>}>
          <Loaded load={owner}>{(d) => {
            const c = d.compliance, a = c.audits;
            const total = a.green + a.amber + a.red + a.not_audited;
            return (
              <>
                <div className="donut-wrap">
                  <Donut parts={[{ value: a.green, tone: "good" }, { value: a.amber, tone: "warn" }, { value: a.red, tone: "bad" }, { value: a.not_audited, tone: "neutral" }]} caption="stores" center={<strong>{a.average_score === null ? "—" : `${a.average_score}%`}</strong>} />
                  <ul className="breakdown">
                    <li><span className="sw good" /><Link to="/audits">Green</Link><span className="num">{a.green}</span></li>
                    <li><span className="sw warn" /><Link to="/audits">Amber</Link><span className="num">{a.amber}</span></li>
                    <li><span className="sw bad" /><Link to="/audits">Red</Link><span className="num">{a.red}</span></li>
                    <li><span className="sw neutral" /><Link to="/audits">Not audited</Link><span className="num">{a.not_audited}</span></li>
                  </ul>
                </div>
                <p className="muted small" style={{ margin: ".25rem 0 .75rem" }}>Latest audit of {total} trading store{total === 1 ? "" : "s"}; the centre is the average score.</p>
                <dl className="mini-facts three">
                  <div><dt>Open actions</dt><dd>{c.actions.open}</dd><span className={c.actions.overdue ? "bad-text" : "muted"}>{c.actions.overdue} overdue</span></div>
                  <div><dt>Critical</dt><dd className={c.actions.critical ? "bad-text" : ""}>{c.actions.critical}</dd><span className="muted">{c.actions.waiting_review} to review</span></div>
                  <div><dt>Licences</dt><dd className={c.licences.expired ? "bad-text" : ""}>{c.licences.expired} expired</dd><span className={c.licences.expiring_30 ? "warn-text" : "muted"}>{c.licences.expiring_30} in 30 days, {c.licences.expiring_90} in 90</span></div>
                </dl>
                {a.overdue > 0 && <p className="warn-text small" style={{ margin: ".75rem 0 0" }}>{a.overdue} store{a.overdue === 1 ? " is" : "s are"} overdue for an audit with none scheduled.</p>}
              </>
            );
          }}</Loaded>
        </Panel>
      </div>

      <div className="row">
        <Panel title="Store performance" action={<Link to="/analytics">Full analytics</Link>} flush>
          <Loaded load={owner} empty={(d) => !d.stores.length} emptyText="No store has opened yet.">{(d) => {
            const all: Row[] = d.stores;
            const top = all.length > 10 ? all.slice(0, 5) : all;
            const bottom = all.length > 10 ? all.slice(-5) : [];
            const cols = [
              { key: "rank", label: "#", render: (s: Row) => <span className="muted">{all.indexOf(s) + 1}</span> },
              { key: "name", label: "Store", render: (s: Row) => <span><strong>{s.name}</strong><span className="cell-sub">{s.franchisee ?? s.project_code}</span></span> },
              { key: "avg_net_sales", label: "Avg month", align: "right" as const, sort: (s: Row) => Number(s.avg_net_sales ?? -1), render: (s: Row) => (s.avg_net_sales === null ? "—" : inrShort(Number(s.avg_net_sales))) },
              { key: "vs_plan_pct", label: "Vs plan", align: "right" as const, sort: (s: Row) => Number(s.vs_plan_pct ?? -999), render: (s: Row) => (s.avg_net_sales === null ? <span className="muted" title="No full trading month reported yet">Too new</span> : <PlanDelta v={s.vs_plan_pct} />) },
              { key: "sales_per_sqft", label: "Per sq ft", align: "right" as const, render: (s: Row) => (s.sales_per_sqft === null ? "—" : `₹${Number(s.sales_per_sqft).toLocaleString("en-IN")}`) },
              { key: "health_score", label: "Health", align: "right" as const, sort: (s: Row) => Number(s.health_score ?? -1), render: (s: Row) => (s.health_score === null ? <span className="muted" title="Not scored yet">—</span> : <span className={`health-chip ${String(s.health_band).toLowerCase()}`} title={label(s.health_band)}>{s.health_score}</span>) },
              { key: "audit_rating", label: "Audit", render: (s: Row) => (s.audit_rating ? <span title={`Score ${s.audit_score}%`}><Pill value={s.audit_rating} /></span> : <span className="muted">Not audited</span>) },
              { key: "unpaid", label: "Unpaid", align: "right" as const, render: (s: Row) => (Number(s.unpaid) ? <span className="bad-text">{inrShort(Number(s.unpaid))}</span> : <span className="muted">—</span>) },
            ].filter((c) => d.finance || c.key !== "unpaid");
            return (
              <>
                {bottom.length > 0 && <div className="table-caption">Top five</div>}
                <DataTable rows={top} columns={cols} href={(s) => `/projects/${s.project_id}`} />
                {bottom.length > 0 && <><div className="table-caption">Bottom five</div><DataTable rows={bottom} columns={cols} href={(s) => `/projects/${s.project_id}`} /></>}
                <p className="panel-foot muted">Average of each store's last three full reported months (a part opening month is left out); plan is the feasibility model's monthly revenue.</p>
              </>
            );
          }}</Loaded>
        </Panel>

      </div>

      <h2 className="section-title">Network</h2>
      <Suspense fallback={<div className="panel"><div className="panel-body state">Loading the map…</div></div>}><NetworkMap region={region} /></Suspense>

      <h2 className="section-title">Growth and openings</h2>
      <Loaded load={network}>{(n) => (
        <div className="kpis">
          <KpiTile label="Active franchisees" kpi={n.active_franchisees} icon="franchisees" hint="Signed and trading partners" />
          <KpiTile label="Open applications" kpi={n.applications} icon="applications" tone="info" hint={n.pipeline_value?.value ? `${inrShort(n.pipeline_value.value)} investment capacity` : "Draft to agreement pending"} />
          <KpiTile label="Openings in progress" kpi={n.openings} icon="projects" tone="info" hint={n.openings?.value ? `On pace: ${n.openings_on_pace?.value ?? 0} of ${n.openings.value}` : "Planning to ready for opening"} />
          <OpeningRisk n={n} />
        </div>
      )}</Loaded>

      <div className="row c21">
        <Panel title="Expansion funnel" action={pipeline.data && <span className="muted">Signed from all applications <strong style={{ color: "var(--text)" }}>{pipeline.data.conversion_pct ?? 0}%</strong>{network.data?.average_payback_months?.value ? <> · Payback <strong style={{ color: "var(--text)" }}>{network.data.average_payback_months.value} mo</strong></> : null}</span>}>
          <Loaded load={pipeline}>{(p) => {
            const stages: Row[] = p.funnel.filter((f: Row) => f.stage !== "DRAFT");
            const max = Math.max(1, ...stages.map((f) => f.current));
            return (
              <>
                <ul className="funnel stages">
                  <li className="head"><span>Stage</span><span>Applications there now</span><span>Value</span><span title="Share of those that reached this stage that went on to the next">Went on</span></li>
                  {stages.map((f) => (
                    <li key={f.stage}>
                      <Link to={drillHref({ value: f.current, drill: f.drill })!} title={`${f.count} reached ${label(f.stage).toLowerCase()}`}>{label(f.stage)}</Link>
                      <span className="track"><span className="bar" style={{ width: `${(f.current / max) * 100}%`, opacity: f.current ? 1 : 0 }} /><span className="n">{f.current || ""}</span></span>
                      <span className="num muted">{f.value ? inrShort(Number(f.value)) : "—"}</span>
                      <span className="num">{f.to_next_pct === null ? "" : `${f.to_next_pct}%`}</span>
                    </li>
                  ))}
                </ul>
                <div className="chips" style={{ marginTop: ".9rem" }}>
                  {p.closed.map((c: Row) => <Link key={c.status} className="chip" to={drillHref(c as Kpi)!}><Pill value={c.status} /><span className="n">{c.value}</span></Link>)}
                </div>
              </>
            );
          }}</Loaded>
        </Panel>

        <Panel title="Opening readiness">
          <Loaded load={risk}>{(r) => {
            const total = r.rag.reduce((s: number, x: Row) => s + x.value, 0);
            return (
              <>
                <div className="donut-wrap">
                  <Donut parts={r.rag.map((x: Row) => ({ value: x.value, tone: toneOf(x.rag) }))} caption="in progress" center={<strong>{total}</strong>} />
                  <ul className="breakdown">
                    {r.rag.map((x: Row) => (
                      <li key={x.rag}><span className={`sw ${toneOf(x.rag)}`} /><Link to={drillHref(x as Kpi)!}>{label(x.rag)}</Link><span className="num">{x.value}</span></li>
                    ))}
                    <li><span className="sw bad" /><Link to={drillHref(r.at_risk)!}>Need attention</Link><span className="num">{r.at_risk.value}</span></li>
                  </ul>
                </div>
                <Loaded load={openings}>{(op) => {
                  const next = op.by_month.filter((m: Row) => m.month >= new Date().toISOString().slice(0, 7) && m.planned).slice(0, 3);
                  return next.length ? (
                    <dl className="mini-facts three" style={{ marginTop: "1rem" }}>
                      {next.map((m: Row) => <div key={m.month}><dt>{new Date(m.month + "-01T00:00:00Z").toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" })}</dt><dd>{m.planned}</dd><span className="muted">to open</span></div>)}
                    </dl>
                  ) : null;
                }}</Loaded>
              </>
            );
          }}</Loaded>
        </Panel>
      </div>

      <Panel title="Openings that need attention" action={<Link to="/projects?risk_level=HIGH">View all</Link>} flush>
        <Loaded load={risk} empty={(r) => !r.at_risk.items.length} emptyText="Every opening is on track.">{(r) => (
          <DataTable rows={r.at_risk.items} href={(p) => `/projects/${p.id}`} columns={[
            { key: "name", label: "Store", render: (p) => <span><strong>{p.name}</strong><span className="cell-sub">{p.franchisee ?? p.project_code}</span></span> },
            { key: "reasons", label: "Why", render: (p) => (p.reasons?.length ? <ul className="reasons">{p.reasons.map((x: string) => <li key={x}>{x}</li>)}</ul> : <span className="muted">Readiness behind pace</span>) },
            { key: "readiness_score", label: "Readiness", sort: (p) => Number(p.readiness_score ?? 0), render: (p) => <Progress value={p.readiness_score} rag={p.readiness_rag} /> },
            { key: "target_opening_date", label: "Target", render: (p) => date(p.target_opening_date) },
            { key: "slip_days", label: "Forecast", sort: (p) => Number(p.slip_days ?? 0), render: (p) => (p.slip_days ? <span><span className="bad-text">{p.slip_days} days late</span><span className="cell-sub">{date(p.forecast_opening_date)}</span></span> : <span className="muted">On target</span>) },
          ]} />
        )}</Loaded>
      </Panel>

      <div className="row c21">
        <Panel title="Store openings by month" action={<span className="legend"><span><i className="sw opened" />Opened</span><span><i className="sw planned" />Planned</span></span>}>
          <Loaded load={openings}>{(op) => {
            const max = Math.max(1, ...op.by_month.map((m: Row) => m.planned + m.opened));
            const now = new Date().toISOString().slice(0, 7);
            const fmt = (m: string) => new Date(m + "-01T00:00:00Z").toLocaleDateString("en-IN", { month: "short", timeZone: "UTC" });
            return (
              <>
                <div className="chart-cols" role="img" aria-label="Planned and opened stores by month">
                  {op.by_month.map((m: Row) => (
                    <div key={m.month} className={`col ${m.month === now ? "now" : ""}`} title={`${m.month}: ${m.opened} opened, ${m.planned} planned`}>
                      {m.opened + m.planned > 0 && <span className="val">{m.opened + m.planned}</span>}
                      <span className="seg planned" style={{ height: `${(m.planned / max) * 82}%` }} />
                      <span className="seg opened" style={{ height: `${(m.opened / max) * 82}%`, borderRadius: m.planned ? 0 : undefined }} />
                    </div>
                  ))}
                </div>
                <div className="chart-x">{op.by_month.map((m: Row) => <span key={m.month}>{fmt(m.month)}</span>)}</div>
              </>
            );
          }}</Loaded>
        </Panel>

        <Panel title="Territories" action={<Link to="/territories">All territories</Link>}>
          <Loaded load={territories}>{(t) => {
            const total = t.by_status.reduce((s: number, x: Row) => s + x.value, 0);
            return (
              <div className="donut-wrap">
                <Donut parts={t.by_status.map((x: Row) => ({ value: x.value, tone: toneOf(x.status) }))} caption="territories" center={<strong>{total}</strong>} />
                <ul className="breakdown">
                  {t.by_status.map((x: Row) => (
                    <li key={x.status}><span className={`sw ${toneOf(x.status)}`} /><Link to={`/territories?status=${x.status}`}>{label(x.status)}</Link><span className="num">{x.value}</span></li>
                  ))}
                </ul>
              </div>
            );
          }}</Loaded>
        </Panel>
      </div>
    </div>
  );
}

function PlanDelta({ v }: { v: unknown }) {
  const n = num(v);
  if (n === null) return <span className="muted">—</span>;
  return <span className={n >= 0 ? "good-text" : n <= -15 ? "bad-text" : "warn-text"}>{n > 0 ? "+" : n < 0 ? "−" : ""}{Math.abs(n)}%</span>;
}

/** Delayed (past target) and forecast to slip, side by side: one late now, one heading that way. */
function OpeningRisk({ n }: { n: Network }) {
  const delayed = n.delayed_openings, slipping = n.slipping_openings;
  return (
    <div className="kpi split">
      <div className="kpi-top"><span className="kpi-label">Opening dates at risk</span><span className={`kpi-icon ${delayed?.value || slipping?.value ? "bad" : "good"}`}><Icon name="clock" size={16} /></span></div>
      <div className="split-row">
        <Link to={drillHref(delayed)!}><span className="kpi-value">{delayed?.value ?? "—"}</span><span className="kpi-hint">Past target</span></Link>
        {slipping && <Link to={drillHref(slipping)!}><span className="kpi-value">{slipping.value ?? "—"}</span><span className="kpi-hint">Forecast to slip</span></Link>}
      </div>
    </div>
  );
}

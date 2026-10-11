import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, Row } from "../api";
import { useLoad } from "../hooks";
import { DataTable, date, inr, inrShort, label, Loaded, PageHeader, Panel } from "../components/ui";

const RANGES: [string, string][] = [["3", "Last 3 months"], ["6", "Last 6 months"], ["12", "Last 12 months"], ["24", "Last 24 months"]];
const monthLabel = (p: unknown) => new Date(`${String(p)}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const pctText = (v: unknown) => (num(v) === null ? "—" : `${num(v)}%`);
/** Signed change with an arrow, so the direction never rests on color alone. */
function Change({ v, suffix = "%" }: { v: unknown; suffix?: string }) {
  const n = num(v);
  if (n === null) return <span className="muted">—</span>;
  const tone = n > 0 ? "var(--good)" : n < 0 ? "var(--bad)" : undefined;
  return <span style={{ color: tone, whiteSpace: "nowrap" }}>{n > 0 ? "▲ +" : n < 0 ? "▼ −" : ""}{Math.abs(n)}{suffix}</span>;
}

function csv(rows: Row[], cols: [string, string][], name: string) {
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [cols.map(([, h]) => cell(h)).join(","), ...rows.map((r) => cols.map(([k]) => cell(r[k])).join(","))];
  const url = URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

/** Monthly net sales across the network: one series, with the month's detail on hover. */
function SalesChart({ series }: { series: Row[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...series.map((m) => Number(m.net_sales)));
  const h = hover === null ? null : series[hover];
  return (
    <div className="sales-chart" onMouseLeave={() => setHover(null)}>
      <div className="chart-cols" role="img" aria-label="Net sales reported by month">
        {series.map((m, i) => (
          <div key={m.period} className={`col hit ${hover === i ? "on" : ""}`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0}>
            {Number(m.net_sales) > 0 && series.length <= 12 && <span className="val">{inrShort(Number(m.net_sales))}</span>}
            <span className="seg sales" style={{ height: `${(Number(m.net_sales) / max) * 82}%` }} />
          </div>
        ))}
        {h && (
          <div className="chart-tip" style={{ left: `${((hover! + 0.5) / series.length) * 100}%` }}>
            <strong>{h.label}</strong>
            <span>Net sales <b>{inr(Number(h.net_sales))}</b></span>
            <span>Royalty + fund billed <b>{inr(Number(h.royalty))}</b></span>
            <span>Collected <b>{inr(Number(h.collected))}</b></span>
            <span>Stores reported <b>{h.stores_reporting} of {h.stores_due}</b></span>
          </div>
        )}
      </div>
      <div className="chart-x">{series.map((m, i) => <span key={m.period}>{series.length > 12 && i % 3 ? "" : String(m.label).replace(" 20", " ’")}</span>)}</div>
    </div>
  );
}

const STORE_CSV: [string, string][] = [["project_code", "Store"], ["franchisee", "Franchisee"], ["city", "City"], ["region", "Region"], ["opened_on", "Opened"], ["net_sales", "Net sales"], ["avg_net_sales", "Avg month (last 3)"], ["plan_net_sales", "Plan per month"], ["vs_plan_pct", "Vs plan %"], ["change_pct", "Last month change %"], ["royalty", "Royalty + fund billed"], ["unpaid", "Unpaid"], ["months_reported", "Months reported"], ["months_due", "Months due"]];

/** Owner analytics: how stores trade, how fast they open, and where the funnel leaks. */
export function Analytics() {
  const [params, setParams] = useSearchParams();
  const months = params.get("months") ?? "12";
  const region = params.get("region") ?? "";
  const load = useLoad(() => api<Row>("GET", "/analytics", { query: { months, region } }), [months, region]);
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n); };
  return (
    <>
      <PageHeader title="Analytics" crumbs={[["Overview"], ["Analytics"]]} subtitle="Store sales and royalty, opening speed and the expansion funnel."
        actions={<>
          <select aria-label="Period" value={months} onChange={(e) => set("months", e.target.value)}>{RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <select aria-label="Region" value={region} onChange={(e) => set("region", e.target.value)}>
            <option value="">All regions</option>
            {(load.data?.regions as string[] | undefined ?? (region ? [region] : [])).map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </>} />
      <Loaded load={load}>{(a) => {
        const s = a.sales as Row, t = s.totals as Row, o = a.openings as Row, p = a.pipeline as Row;
        const stages = (p.stages as Row[]).filter((x) => x.stage !== "DRAFT");
        const maxReached = Math.max(1, ...stages.map((x) => Number(x.reached)));
        const range = `${(s.series as Row[])[0]?.label} to ${(s.series as Row[]).at(-1)?.label}`;
        return (
          <>
            <dl className="summary">
              <div><dt>Net sales</dt><dd>{inrShort(Number(t.net_sales))}</dd><span className="cell-sub">{range}</span></div>
              <div><dt>Royalty + fund billed</dt><dd>{inrShort(Number(t.royalty))}</dd><span className="cell-sub">{inrShort(Number(t.collected))} collected, {inrShort(Number(t.unpaid))} unpaid</span></div>
              <div><dt>Average store month</dt><dd>{t.avg_store_month === null ? "—" : inrShort(Number(t.avg_store_month))}</dd><span className="cell-sub">Typical store vs plan <Change v={t.median_vs_plan_pct} /></span></div>
              <div><dt>Reports in</dt><dd>{pctText(t.reporting_pct)}</dd><span className="cell-sub">of months due, {t.stores} opened store{t.stores === 1 ? "" : "s"}</span></div>
            </dl>

            <Panel title="Net sales by month" action={<span className="muted">As reported by stores; returned reports excluded</span>}>
              {Number(t.net_sales) > 0 ? <SalesChart series={(s.series as Row[]).slice(Math.max(0, Math.min((s.series as Row[]).findIndex((m) => Number(m.stores_due) > 0), (s.series as Row[]).length - 3)))} /> : <div className="state">No sales reported in this period.</div>}
            </Panel>

            <Panel title="Stores" flush action={<button className="btn ghost sm" disabled={!(s.stores as Row[]).length} onClick={() => csv(s.stores as Row[], STORE_CSV, `store-sales-${a.period_from}-${a.period_to}.csv`)}>Export CSV</button>}>
              <DataTable rows={s.stores as Row[]} href={(r) => `/projects/${r.project_id}`} searchKeys={["project_code", "franchisee", "city", "region"]} empty="No opened stores in this region." columns={[
                { key: "project_code", label: "Store", render: (r) => <><Link to={`/projects/${r.project_id}`} className="code">{r.project_code}</Link><span className="cell-sub">{r.franchisee ?? ""}</span></> },
                { key: "city", label: "Place", render: (r) => <>{r.city ?? "—"}<span className="cell-sub">{r.region ?? ""}</span></> },
                { key: "net_sales", label: "Net sales", align: "right", sort: (r) => Number(r.net_sales), render: (r) => inr(Number(r.net_sales)) },
                { key: "avg_net_sales", label: "Avg month", align: "right", sort: (r) => Number(r.avg_net_sales ?? -1), render: (r) => r.avg_net_sales === null ? <span className="muted">—</span> : <>{inr(Number(r.avg_net_sales))}{r.plan_net_sales && <span className="cell-sub">Plan {inr(Number(r.plan_net_sales))}</span>}</> },
                { key: "vs_plan_pct", label: "Vs plan", align: "right", sort: (r) => Number(r.vs_plan_pct ?? -1e9), render: (r) => <Change v={r.vs_plan_pct} /> },
                { key: "change_pct", label: "Last month", align: "right", sort: (r) => Number(r.change_pct ?? -1e9), render: (r) => <><Change v={r.change_pct} />{r.last_period && <span className="cell-sub">{monthLabel(r.last_period)}</span>}</> },
                { key: "royalty", label: "Billed", align: "right", sort: (r) => Number(r.royalty), render: (r) => <>{inr(Number(r.royalty))}{Number(r.unpaid) > 0 && <span className="cell-sub">{inr(Number(r.unpaid))} unpaid</span>}</> },
                { key: "reporting_pct", label: "Reported", align: "right", sort: (r) => Number(r.reporting_pct ?? -1), render: (r) => <span style={{ color: r.months_due > r.months_reported ? "var(--warn)" : undefined }}>{r.months_reported} of {r.months_due}</span> },
              ]} />
            </Panel>

            <div className="row c2">
              <Panel title="Opening speed" flush>
                <dl className="summary flat">
                  <div><dt>Signing to opening</dt><dd>{o.median_days_to_open === null ? "—" : `${o.median_days_to_open} days`}</dd><span className="cell-sub">median</span></div>
                  <div><dt>Opened on time</dt><dd>{pctText(o.on_time_pct)}</dd><span className="cell-sub">{o.avg_days_late === null ? "" : Number(o.avg_days_late) > 0 ? `${o.avg_days_late} days late on average` : `${Math.abs(Number(o.avg_days_late))} days early on average`}</span></div>
                </dl>
                <DataTable rows={o.by_region as Row[]} empty="No stores opened yet." columns={[
                  { key: "region", label: "Region" },
                  { key: "opened", label: "Opened", align: "right" },
                  { key: "median_days_to_open", label: "Median days", align: "right", render: (r) => r.median_days_to_open ?? "—" },
                  { key: "on_time_pct", label: "On time", align: "right", render: (r) => pctText(r.on_time_pct) },
                ]} />
                <DataTable rows={o.items as Row[]} href={(r) => `/projects/${r.project_id}`} empty="" columns={[
                  { key: "project_code", label: "Store", render: (r) => <span className="code">{r.project_code}</span> },
                  { key: "signed_on", label: "Signed", render: (r) => date(r.signed_on) },
                  { key: "opened_on", label: "Opened", render: (r) => date(r.opened_on) },
                  { key: "days_to_open", label: "Days", align: "right", render: (r) => r.days_to_open === null || Number(r.days_to_open) < 0 ? "—" : r.days_to_open },
                  { key: "days_late", label: "Vs target", align: "right", render: (r) => r.days_late === null ? "—" : Number(r.days_late) > 0 ? <span style={{ color: "var(--bad)" }}>{r.days_late} days late</span> : Number(r.days_late) < 0 ? `${-Number(r.days_late)} days early` : "On the day" },
                ]} />
              </Panel>

              <Panel title="Expansion funnel" action={<span className="muted">Submitted to signed <strong style={{ color: "var(--text)" }}>{pctText(p.signed_pct)}</strong></span>}>
                <ul className="funnel conv">
                  <li className="head"><span>Stage</span><span>Reached</span><span className="num">Next</span><span className="num">Days</span></li>
                  {stages.map((x) => (
                    <li key={x.stage} title={`${x.reached} reached ${label(x.stage).toLowerCase()}; ${x.current} there now`}>
                      <Link to={`/applications?status=${x.stage}`}>{label(x.stage)}</Link>
                      <span className="track"><span className="bar" style={{ width: `${(Number(x.reached) / maxReached) * 100}%` }} /><span className="n">{x.reached}</span></span>
                      <span className="num">{pctText(x.to_next_pct)}</span>
                      <span className="num muted">{x.median_days ?? "—"}</span>
                    </li>
                  ))}
                </ul>
                <p className="muted" style={{ margin: ".75rem 0 0", fontSize: ".8rem" }}>
                  Next is the share that moved on to the following stage. Days is the median time spent at a stage, from status changes made in FranchiseOS.
                  {" "}Closed: {(p.closed as Row[]).map((c) => `${label(c.status).toLowerCase()} ${c.count}`).join(", ")}.
                </p>
              </Panel>
            </div>
          </>
        );
      }}</Loaded>
    </>
  );
}

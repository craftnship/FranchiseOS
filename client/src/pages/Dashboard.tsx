import { Link } from "react-router-dom";
import { api, drillHref, Kpi, Row } from "../api";
import { useLoad } from "../hooks";
import { date, inrShort, KpiTile, Loaded, Pill } from "../components/ui";

type Network = Record<string, Kpi>;

export function Dashboard() {
  const network = useLoad(() => api<Network>("GET", "/dashboard/network"), []);
  const pipeline = useLoad(() => api<Row>("GET", "/dashboard/pipeline"), []);
  const openings = useLoad(() => api<Row>("GET", "/dashboard/openings"), []);
  const risk = useLoad(() => api<Row>("GET", "/dashboard/risk"), []);
  return (
    <>
      <h1>Network</h1>
      <Loaded load={network}>{(n) => (
        <div className="kpis">
          <KpiTile label="Active franchisees" kpi={n.active_franchisees} />
          <KpiTile label="Active locations" kpi={n.active_locations} />
          <KpiTile label="Open applications" kpi={n.applications} />
          <KpiTile label="Pipeline value" kpi={n.pipeline_value} format={inrShort} />
          <KpiTile label="Openings in progress" kpi={n.openings} />
          <KpiTile label="Delayed openings" kpi={n.delayed_openings} />
          <KpiTile label="Network readiness" kpi={n.network_health} format={(v) => `${v}%`} />
          <KpiTile label="Average payback" kpi={n.average_payback_months} format={(v) => `${v} mo`} />
        </div>
      )}</Loaded>

      <div className="grid2">
        <section className="card">
          <h2>Expansion funnel</h2>
          <Loaded load={pipeline}>{(p) => {
            const max = Math.max(1, ...p.funnel.map((f: Row) => f.count));
            return (
              <ul className="funnel">
                {p.funnel.map((f: Row) => (
                  <li key={f.stage}>
                    <Link to={drillHref({ value: f.current, drill: f.drill })!}>{f.stage.replace(/_/g, " ").toLowerCase()}</Link>
                    <span className="bar" style={{ width: `${(f.count / max) * 100}%` }} />
                    <span className="num">{f.count}</span>
                  </li>
                ))}
              </ul>
            );
          }}</Loaded>
        </section>

        <section className="card">
          <h2>Openings by month</h2>
          <Loaded load={openings}>{(o) => {
            const max = Math.max(1, ...o.by_month.map((m: Row) => m.planned + m.opened));
            return (
              <div className="months" role="img" aria-label="Planned and opened stores by month">
                {o.by_month.map((m: Row) => (
                  <div key={m.month} className="month" title={`${m.month}: ${m.opened} opened, ${m.planned} planned`}>
                    <div className="stack">
                      <span className="planned" style={{ height: `${(m.planned / max) * 100}%` }} />
                      <span className="opened" style={{ height: `${(m.opened / max) * 100}%` }} />
                    </div>
                    <span className="mlabel">{m.month.slice(5)}</span>
                  </div>
                ))}
              </div>
            );
          }}</Loaded>
          <p className="legend"><span className="sw opened" /> opened <span className="sw planned" /> planned</p>
        </section>
      </div>

      <section className="card">
        <h2>Projects at risk</h2>
        <Loaded load={risk} empty={(r) => !r.at_risk.items.length}>{(r) => (
          <table>
            <thead><tr><th>Project</th><th>Status</th><th>Readiness</th><th>Target opening</th></tr></thead>
            <tbody>{r.at_risk.items.map((p: Row) => (
              <tr key={p.id}><td><Link to={`/projects/${p.id}`}>{p.project_code}</Link></td><td><Pill value={p.status} /></td><td>{p.readiness_score ?? "-"} <Pill value={p.readiness_rag} /></td><td>{date(p.target_opening_date)}</td></tr>
            ))}</tbody>
          </table>
        )}</Loaded>
      </section>
    </>
  );
}

import { Link } from "react-router-dom";
import { api, drillHref, Kpi, Row } from "../api";
import { useLoad } from "../hooks";
import { DataTable, date, Donut, Icon, inrShort, KpiTile, label, Loaded, PageHeader, Panel, Pill, Progress, toneOf } from "../components/ui";

type Network = Record<string, Kpi>;

export function Dashboard() {
  const network = useLoad(() => api<Network>("GET", "/dashboard/network"), []);
  const pipeline = useLoad(() => api<Row>("GET", "/dashboard/pipeline"), []);
  const openings = useLoad(() => api<Row>("GET", "/dashboard/openings"), []);
  const risk = useLoad(() => api<Row>("GET", "/dashboard/risk"), []);
  const territories = useLoad(() => api<Row>("GET", "/dashboard/territories"), []);
  const reload = () => [network, pipeline, openings, risk, territories].forEach((l) => l.reload());
  const today = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return (
    <>
      <PageHeader title="Network overview" subtitle={`Expansion pipeline, store openings and readiness · ${today}`}
        actions={<><Link className="btn secondary" to="/projects?delayed=true"><Icon name="clock" size={16} />Delayed openings</Link><button className="btn" onClick={reload}><Icon name="sync" size={16} />Refresh</button></>} />

      <Loaded load={network}>{(n) => (
        <div className="kpis">
          <KpiTile label="Active franchisees" kpi={n.active_franchisees} icon="franchisees" hint="Signed and trading partners" />
          <KpiTile label="Active locations" kpi={n.active_locations} icon="store" tone="good" hint="Stores opened" />
          <KpiTile label="Open applications" kpi={n.applications} icon="applications" tone="info" hint="Draft to agreement pending" />
          <KpiTile label="Pipeline value" kpi={n.pipeline_value} format={inrShort} icon="money" tone="good" hint="Investment capacity in open applications" />
          <KpiTile label="Openings in progress" kpi={n.openings} icon="projects" tone="info" hint="Planning to ready for opening" />
          <KpiTile label="Delayed openings" kpi={n.delayed_openings} icon="clock" tone="bad" hint="Past target opening date" />
          <KpiTile label="Network readiness" kpi={n.network_health} format={(v) => `${v}%`} icon="pulse" tone="warn" hint="Average readiness of openings" />
          <KpiTile label="Average payback" kpi={n.average_payback_months} format={(v) => `${v} mo`} icon="clock" tone="accent" hint="Across approved feasibility models" />
        </div>
      )}</Loaded>

      <div className="row c21">
        <Panel title="Expansion funnel" action={pipeline.data && <span className="muted">Conversion <strong style={{ color: "var(--text)" }}>{pipeline.data.conversion_pct ?? 0}%</strong></span>}>
          <Loaded load={pipeline}>{(p) => {
            const max = Math.max(1, ...p.funnel.map((f: Row) => f.count));
            return (
              <>
                <ul className="funnel">
                  {p.funnel.map((f: Row) => (
                    <li key={f.stage}>
                      <Link to={drillHref({ value: f.current, drill: f.drill })!} title={`${f.current} currently at this stage`}>{label(f.stage)}</Link>
                      <span className="track"><span className="bar" style={{ width: `${(f.count / max) * 100}%` }} /></span>
                      <span className="num">{f.count}</span>
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
              <div className="donut-wrap">
                <Donut parts={r.rag.map((x: Row) => ({ value: x.value, tone: toneOf(x.rag) }))} caption="in progress" center={<strong>{total}</strong>} />
                <ul className="breakdown">
                  {r.rag.map((x: Row) => (
                    <li key={x.rag}><span className={`sw ${toneOf(x.rag)}`} /><Link to={drillHref(x as Kpi)!}>{label(x.rag)}</Link><span className="num">{x.value}</span></li>
                  ))}
                  <li><span className="sw bad" /><Link to={drillHref(r.at_risk)!}>At risk</Link><span className="num">{r.at_risk.value}</span></li>
                </ul>
              </div>
            );
          }}</Loaded>
        </Panel>
      </div>

      <div className="row c21">
        <Panel title="Store openings by month" action={<span className="legend"><span><i className="sw opened" />Opened</span><span><i className="sw planned" />Planned</span></span>}>
          <Loaded load={openings}>{(o) => {
            const max = Math.max(1, ...o.by_month.map((m: Row) => m.planned + m.opened));
            const now = new Date().toISOString().slice(0, 7);
            const fmt = (m: string) => new Date(m + "-01T00:00:00Z").toLocaleDateString("en-IN", { month: "short", timeZone: "UTC" });
            return (
              <>
                <div className="chart-cols" role="img" aria-label="Planned and opened stores by month">
                  {o.by_month.map((m: Row) => (
                    <div key={m.month} className={`col ${m.month === now ? "now" : ""}`} title={`${m.month}: ${m.opened} opened, ${m.planned} planned`}>
                      {m.opened + m.planned > 0 && <span className="val">{m.opened + m.planned}</span>}
                      <span className="seg planned" style={{ height: `${(m.planned / max) * 82}%` }} />
                      <span className="seg opened" style={{ height: `${(m.opened / max) * 82}%`, borderRadius: m.planned ? 0 : undefined }} />
                    </div>
                  ))}
                </div>
                <div className="chart-x">{o.by_month.map((m: Row) => <span key={m.month}>{fmt(m.month)}</span>)}</div>
              </>
            );
          }}</Loaded>
        </Panel>

        <Panel title="Territories">
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

      <Panel title="Openings that need attention" action={<Link to="/projects?risk_level=HIGH">View all</Link>} flush>
        <Loaded load={risk} empty={(r) => !r.at_risk.items.length} emptyText="No opening is at risk right now.">{(r) => (
          <DataTable rows={r.at_risk.items} href={(p) => `/projects/${p.id}`} columns={[
            { key: "project_code", label: "Project", render: (p) => <span className="code">{p.project_code}</span> },
            { key: "status", label: "Status", render: (p) => <Pill value={p.status} /> },
            { key: "readiness_score", label: "Readiness", sort: (p) => Number(p.readiness_score ?? 0), render: (p) => <Progress value={p.readiness_score} rag={p.readiness_rag} /> },
            { key: "readiness_rag", label: "RAG", render: (p) => <Pill value={p.readiness_rag} /> },
            { key: "target_opening_date", label: "Target opening", render: (p) => date(p.target_opening_date) },
          ]} />
        )}</Loaded>
      </Panel>
    </>
  );
}

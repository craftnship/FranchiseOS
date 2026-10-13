import { useState } from "react";
import { Link } from "react-router-dom";
import { api, can, Row } from "../api";
import { useAction, useLoad } from "../hooks";
import { Field, Form, FormError } from "./forms";
import { Donut, Icon, Loaded, Panel, Pill, Progress } from "./ui";

// Franchisee health (docs/health-score.md): the network's bands and weakest stores on the dashboard,
// one store's score and trend on its page, and the weights under Admin → Settings.

export const BAND_LABEL: Record<string, string> = { HEALTHY: "Healthy", WATCH: "Watch", AT_RISK: "At risk" };
const partRag = (score: number | null) => (score === null ? undefined : score >= 70 ? "GREEN" : score >= 50 ? "AMBER" : "RED");

function Score({ value, band }: { value: number | null; band: string | null }) {
  if (value === null) return <span className="health-score none" title="Not enough data to score yet">—</span>;
  return <span className={`health-score ${String(band ?? "").toLowerCase()}`}>{value}</span>;
}

/** The dashboard panel: how many stores sit in each band, and the five that need a look. */
export function HealthPanel({ region = "" }: { region?: string }) {
  const load = useLoad(() => api<Row>("GET", "/dashboard/health", { query: region ? { region } : {} }), [region]);
  const act = useAction(load.reload);
  const score = () => act.run("score", () => api<Row>("POST", "/admin/health/recalculate"), (r) => `Scored ${r.scored} of ${r.stores} trading store${r.stores === 1 ? "" : "s"}.`);
  return (
    <Panel title="Franchisee health" action={can("settings.manage") ? <button type="button" className="btn ghost sm" disabled={!!act.busy} onClick={score}>{act.busy ? "Scoring…" : "Score now"}</button> : <Link to="/projects?status=OPENED">All stores</Link>}>
      {act.notice && <div className="notice ok"><Icon name="check" />{act.notice}</div>}
      <FormError error={act.error} />
      <Loaded load={load} empty={(d) => !d.stores.length} emptyText="No store has opened yet.">{(d) => {
        const b = d.bands, total = b.healthy + b.watch + b.at_risk + b.unscored;
        return (
          <>
            <div className="donut-wrap">
              <Donut parts={[{ value: b.healthy, tone: "good" }, { value: b.watch, tone: "warn" }, { value: b.at_risk, tone: "bad" }, { value: b.unscored, tone: "neutral" }]} caption="stores" center={<strong>{d.average === null ? "—" : d.average}</strong>} />
              <ul className="breakdown">
                <li><span className="sw good" /><Link to="/projects?status=OPENED">Healthy</Link><span className="num">{b.healthy}</span></li>
                <li><span className="sw warn" /><Link to="/projects?status=OPENED">Watch</Link><span className="num">{b.watch}</span></li>
                <li><span className="sw bad" /><Link to="/projects?status=OPENED">At risk</Link><span className="num">{b.at_risk}</span></li>
                <li><span className="sw neutral" /><Link to="/projects?status=OPENED">Not scored yet</Link><span className="num">{b.unscored}</span></li>
              </ul>
            </div>
            <p className="muted small" style={{ margin: ".25rem 0 .75rem" }}>
              {d.as_of ? <>Sales, payments, compliance and reporting of {total} trading store{total === 1 ? "" : "s"}; the centre is the average score. Healthy from {d.thresholds.healthy_from}, Watch from {d.thresholds.watch_from}.</> : <>Not scored yet. The score runs every night{can("settings.manage") ? ", or now with “Score now”" : ""}.</>}
            </p>
            {d.lowest.length > 0 && <>
              <div className="field-label" style={{ marginBottom: ".35rem" }}>Needing a look</div>
              <ul className="health-list">
                {d.lowest.map((s: Row) => (
                  <li key={s.project_id}>
                    <Link to={`/projects/${s.project_id}`} className="health-row">
                      <Score value={s.score} band={s.band} />
                      <span className="health-who"><strong>{s.name}</strong><span className="cell-sub">{s.franchisee ?? s.project_code}{s.capped ? " · held at Watch by one weak part" : ""}</span></span>
                      <Pill value={s.band} />
                    </Link>
                    <ul className="reasons">{s.reasons.map((r: Row) => <li key={r.part}>{r.text}</li>)}</ul>
                  </li>
                ))}
              </ul>
            </>}
          </>
        );
      }}</Loaded>
    </Panel>
  );
}

/** One store's health on its page, for the brand team and the franchisee alike. */
export function HealthCard({ projectId }: { projectId: string }) {
  const load = useLoad(() => api<Row>("GET", `/projects/${projectId}/health`), [projectId]);
  // A store that has not opened yet (or an error reading it) has no card; the page says the rest.
  if (!load.data || !load.data.trading) return null;
  return (
    <Loaded load={load}>{(d) => (
      <Panel title="Franchisee health" action={d.band ? <Pill value={d.band} /> : <span className="muted">Not scored yet</span>}>
        <div className="health-head">
          <Score value={d.score} band={d.band} />
          <div>
            {d.score === null
              ? <p className="muted" style={{ margin: 0 }}>Scored every night once the store has a full month of trading, a bill or an audit.</p>
              : <>
                <ul className="reasons" style={{ paddingLeft: "1rem" }}>{d.reasons.map((r: Row) => <li key={r.part}>{r.text}</li>)}</ul>
                <p className="muted small" style={{ margin: ".35rem 0 0" }}>Out of 100, as of {d.updated_on}{d.capped ? ". Held at Watch because one part is very weak" : ""}.</p>
              </>}
          </div>
          {d.history.length > 1 && <Trend history={d.history} thresholds={d.thresholds} />}
        </div>
        <dl className="health-parts">
          {d.parts.map((p: Row) => (
            <div key={p.part}>
              <dt>{p.label}<span className="muted"> · {p.weight}%</span></dt>
              <dd><Progress value={p.score} rag={partRag(p.score)} /></dd>
              <span className="muted small">{p.detail}</span>
            </div>
          ))}
        </dl>
      </Panel>
    )}</Loaded>
  );
}

/** The score over the last months, with the band limits drawn across. */
function Trend({ history, thresholds }: { history: Row[]; thresholds: Row }) {
  const w = 160, h = 44, n = history.length;
  const x = (i: number) => (n === 1 ? w / 2 : (i / (n - 1)) * w);
  const y = (v: number) => h - (v / 100) * h;
  const pts = history.map((p: Row, i: number) => (p.score === null ? null : `${x(i).toFixed(1)},${y(Number(p.score)).toFixed(1)}`)).filter(Boolean).join(" ");
  return (
    <svg className="health-trend" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={`Health over the last ${n} days`}>
      <line x1={0} x2={w} y1={y(thresholds.healthy_from)} y2={y(thresholds.healthy_from)} className="limit good" />
      <line x1={0} x2={w} y1={y(thresholds.watch_from)} y2={y(thresholds.watch_from)} className="limit bad" />
      <polyline points={pts} />
    </svg>
  );
}

interface Settings { weights: Record<string, number>; thresholds: { healthy_from: number; watch_from: number; part_floor: number }; parts: { part: string; label: string }[]; defaults: Settings }

/** Admin → Settings → Health score: the weights and the band limits. */
export function HealthSettings() {
  const load = useLoad(() => api<Settings>("GET", "/settings/health"), []);
  return <Loaded load={load}>{(d) => <HealthSettingsForm initial={d} />}</Loaded>;
}

function HealthSettingsForm({ initial }: { initial: Settings }) {
  const [s, setS] = useState(initial);
  const act = useAction();
  const num = (v: string) => (v === "" ? 0 : Math.max(0, Number(v)));
  const total = Object.values(s.weights).reduce((a, b) => a + b, 0);
  const save = async () => {
    const r = await act.run("save", () => api<Settings>("PUT", "/settings/health", { body: { weights: s.weights, thresholds: s.thresholds } }), "Saved. Stores are rescored tonight, or now with “Rescore now”.");
    if (r) setS(r);
  };
  const rescore = () => act.run("score", () => api<Row>("POST", "/admin/health/recalculate"), (r) => `Rescored ${r.scored} of ${r.stores} trading store${r.stores === 1 ? "" : "s"}; ${r.changed} changed band.`);
  return (
    <Panel title="Health score" action={<button type="button" className="btn ghost sm" disabled={!!act.busy} onClick={rescore}>{act.busy === "score" ? "Scoring…" : "Rescore now"}</button>}>
      {act.notice && <div className="notice ok"><Icon name="check" />{act.notice}</div>}
      <Form onSubmit={save} footer={<><button className="btn" disabled={!!act.busy || !total}>{act.busy === "save" ? "Saving…" : "Save health score"}</button><button type="button" className="btn ghost" onClick={() => setS({ ...s, weights: s.defaults.weights, thresholds: s.defaults.thresholds })}>Use defaults</button></>}>
        <div className="span">
          <div className="field-label">Weights</div>
          <p className="field-hint" style={{ margin: "0 0 .5rem" }}>How much each part counts. A part with no data for a store is left out and the others scale up. Customer counts once Zoho Desk is linked.</p>
          <div className="health-weights">
            {s.parts.map((p) => (
              <label key={p.part}><span>{p.label}</span><input type="number" min={0} max={100} value={s.weights[p.part]} onChange={(e) => setS({ ...s, weights: { ...s.weights, [p.part]: num(e.target.value) } })} /><span className="muted small">{total ? Math.round((s.weights[p.part] / total) * 100) : 0}%</span></label>
            ))}
          </div>
        </div>
        <Field label="Healthy from" hint="Scores at or above this are Healthy."><input type="number" min={1} max={100} value={s.thresholds.healthy_from} onChange={(e) => setS({ ...s, thresholds: { ...s.thresholds, healthy_from: num(e.target.value) } })} /></Field>
        <Field label="Watch from" hint="Scores at or above this, under Healthy, are Watch; below is At risk."><input type="number" min={0} max={99} value={s.thresholds.watch_from} onChange={(e) => setS({ ...s, thresholds: { ...s.thresholds, watch_from: num(e.target.value) } })} /></Field>
        <Field label="Weak-part limit" hint="A store with any part under this ranks no higher than Watch. 0 turns it off."><input type="number" min={0} max={100} value={s.thresholds.part_floor} onChange={(e) => setS({ ...s, thresholds: { ...s.thresholds, part_floor: num(e.target.value) } })} /></Field>
        <div className="span"><FormError error={act.error} /></div>
      </Form>
    </Panel>
  );
}

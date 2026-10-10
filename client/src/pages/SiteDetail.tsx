import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, can, Row } from "../api";
import { useAction, useLoad } from "../hooks";
import { ConfirmDialog, Dialog, Field, Form, FormError } from "../components/forms";
import { DataTable, date, Facts, Icon, inr, label, Loaded, PageHeader, Panel, Pill } from "../components/ui";
import { StatusPath } from "./Applications";

const PATH = ["PROPOSED", "SCREENING", "SITE_VISIT", "EVALUATION", "FEASIBILITY", "APPROVAL_PENDING", "APPROVED", "LEASE_PENDING", "LEASE_SIGNED", "READY_FOR_PROJECT"];
/** Forward steps are primary buttons; closing ones ask for a reason. */
const ACTIONS: Record<string, { text: string; kind?: "secondary" | "danger"; reason?: boolean; body?: string }> = {
  screen: { text: "Start screening" },
  schedule_visit: { text: "Schedule site visit" },
  start_evaluation: { text: "Start evaluation" },
  request_signoff: { text: "Request sign-off" },
  return: { text: "Send back to evaluation", kind: "secondary", reason: true, body: "The site goes back for another evaluation." },
  start_lease: { text: "Start lease" },
  lease_signed: { text: "Lease signed" },
  ready: { text: "Ready for project" },
  reject: { text: "Reject site", kind: "danger", reason: true, body: "The site is rejected. The application will need another site." },
  drop: { text: "Drop site", kind: "danger", reason: true, body: "The site is no longer being pursued." },
};

export function SiteDetail() {
  const { id } = useParams();
  const load = useLoad(() => api<Row>("GET", `/sites/${id}`), [id]);
  const act = useAction(load.reload);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const move = (t: string, comments?: string) =>
    act.run(t, () => api<Row>("POST", `/sites/${id}/transition`, { body: { transition: t, ...(comments ? { comments } : {}) } }), (r) => `${ACTIONS[t]?.text ?? label(t)} done. The site is ${label(r.status).toLowerCase()}.`)
      .then((r) => r && setConfirm(null));
  return (
    <Loaded load={load}>{(s) => {
      const allowed = (s.transitions as Row[]).filter((t) => ACTIONS[t.transition] && (!t.permission || can(t.permission))).map((t) => String(t.transition));
      const canEvaluate = s.status === "EVALUATION" && can("site.evaluate");
      const canApprove = s.status === "APPROVAL_PENDING" && can("site.approve");
      const evals = (s.evaluations ?? []) as Row[];
      return (
        <>
          <PageHeader title={s.site_code} badges={<Pill value={s.status} />} crumbs={[["Expansion"], ["Sites", "/sites"], [s.site_code]]}
            subtitle={[s.address_line_1, s.city, s.state].filter(Boolean).join(", ")}
            actions={<>
              {s.application_id && <Link className="btn secondary" to={`/applications/${s.application_id}`}><Icon name="applications" size={16} />Application</Link>}
              {allowed.map((t) => (
                <button key={t} className={ACTIONS[t].kind === "danger" ? "btn danger-ghost" : ACTIONS[t].kind === "secondary" ? "btn secondary" : "btn"} disabled={!!act.busy}
                  onClick={() => (ACTIONS[t].reason ? setConfirm(t) : move(t))}>{act.busy === t ? "Working…" : ACTIONS[t].text}</button>
              ))}
              {canEvaluate && <button className="btn" onClick={() => setEvaluating(true)}>Evaluate site</button>}
              {canApprove && <button className="btn" disabled={!!act.busy || s.recommendation === "REJECT"} title={s.recommendation === "REJECT" ? "Sites scored below 65 cannot be approved" : undefined}
                onClick={() => act.run("approve", () => api("POST", `/sites/${id}/approve`), "Site approved.")}><Icon name="check" size={16} />{act.busy === "approve" ? "Approving…" : "Approve site"}</button>}
            </>} />
          {act.notice && <div className="notice ok"><Icon name="check" />{act.notice}</div>}
          {act.error && !confirm && <FormError error={act.error} />}
          <dl className="summary">
            <div><dt>Site score</dt><dd>{s.site_score ?? "—"}{s.recommendation && <Pill value={s.recommendation} tone={s.recommendation === "RECOMMEND" ? "good" : s.recommendation === "REJECT" ? "bad" : "warn"} />}</dd></div>
            <div><dt>Area</dt><dd>{s.area_sqft ? `${Number(s.area_sqft).toLocaleString("en-IN")} sq ft` : "—"}</dd></div>
            <div><dt>Monthly rent</dt><dd>{s.rent ? inr(Number(s.rent)) : "—"}</dd></div>
            <div><dt>Deposit</dt><dd>{s.deposit ? inr(Number(s.deposit)) : "—"}</dd></div>
          </dl>
          {PATH.includes(s.status) && <Panel title="Progress"><StatusPath steps={PATH} current={s.status} /></Panel>}
          <div className="row c2">
            <Panel title="Location">
              <Facts items={[["Address", s.address_line_1], ["City", s.city], ["State", s.state], ["Postal code", s.postal_code], ["Created", date(s.CREATEDTIME)], ["Last updated", date(s.MODIFIEDTIME)]]} />
            </Panel>
            <Panel title="Latest evaluation">
              {evals[0] ? <EvaluationSummary e={evals[0]} template={s.evaluation_template} /> : <div className="muted">{s.status === "EVALUATION" ? "Ready to evaluate." : "Not evaluated yet."}</div>}
            </Panel>
          </div>
          {evals.length > 1 && (
            <Panel title="Evaluation history" flush>
              <DataTable rows={evals} columns={[
                { key: "CREATEDTIME", label: "Date", render: (e) => date(e.CREATEDTIME) },
                { key: "score", label: "Score", align: "right" },
                { key: "recommendation", label: "Recommendation", render: (e) => label(e.recommendation) },
                { key: "risks", label: "Risks", render: (e) => e.risks ?? "—" },
              ]} />
            </Panel>
          )}
          {evaluating && <EvaluateDialog site={s} onClose={() => setEvaluating(false)} onSaved={(r) => { setEvaluating(false); load.reload(); act.say(`Scored ${r.evaluation.score}: ${label(r.evaluation.recommendation).toLowerCase()}. The site moves to feasibility.`); }} />}
          {confirm && (
            <ConfirmDialog title={`${ACTIONS[confirm].text}?`} confirm={ACTIONS[confirm].text} danger={ACTIONS[confirm].kind === "danger"} comment="required"
              body={<p className="muted" style={{ margin: 0 }}>{ACTIONS[confirm].body}</p>} busy={!!act.busy} error={act.error}
              onClose={() => { setConfirm(null); act.clear(); }} onConfirm={(c) => move(confirm, c)} />
          )}
        </>
      );
    }}</Loaded>
  );
}

function EvaluationSummary({ e, template }: { e: Row; template: Row[] }) {
  const ratings = JSON.parse(String(e.ratings_json ?? "{}")) as Record<string, number>;
  return (
    <div className="stack">
      <div className="kv-big">{e.score}<small>of 100 · {label(e.recommendation)} · {date(e.CREATEDTIME)}</small></div>
      <dl className="facts">{(template.length ? template : Object.keys(ratings).map((code) => ({ code, name: label(code), max_score: 10 }))).map((t) => (
        <div key={t.code}><dt>{t.name}</dt><dd>{ratings[t.code] ?? "—"} <span className="muted">/ {t.max_score}</span></dd></div>
      ))}</dl>
      {e.strengths && <div><span className="field-label">Strengths</span><p style={{ margin: ".2rem 0 0" }}>{e.strengths}</p></div>}
      {e.risks && <div><span className="field-label">Risks</span><p style={{ margin: ".2rem 0 0" }}>{e.risks}</p></div>}
    </div>
  );
}

function EvaluateDialog({ site, onClose, onSaved }: { site: Row; onClose: () => void; onSaved: (r: Row) => void }) {
  const template = site.evaluation_template as Row[];
  const [ratings, setRatings] = useState<Record<string, number | null>>(Object.fromEntries(template.map((t) => [t.code, Math.round(Number(t.max_score) / 2)])));
  const [strengths, setStrengths] = useState("");
  const [risks, setRisks] = useState("");
  const act = useAction();
  const totalWeight = template.reduce((s, t) => s + Number(t.weight), 0) || 100;
  const score = template.reduce((s, t) => s + ((ratings[t.code] ?? 0) / Number(t.max_score)) * Number(t.weight), 0) * (100 / totalWeight);
  const save = async () => {
    const body = { ratings: Object.fromEntries(Object.entries(ratings).filter(([, v]) => v !== null)) as Record<string, number>, ...(strengths.trim() ? { strengths: strengths.trim() } : {}), ...(risks.trim() ? { risks: risks.trim() } : {}) };
    const r = await act.run("eval", () => api<Row>("POST", `/sites/${site.ROWID}/evaluate`, { body }));
    if (r) onSaved(r);
  };
  return (
    <Dialog title={`Evaluate ${site.site_code}`} subtitle="Rate each factor where higher is better for the site, rent and competition included. 80 or more is recommended; below 65 cannot be approved." onClose={onClose} wide>
      <Form onSubmit={save} footer={<><span className="muted" style={{ marginRight: "auto" }}>Score <strong>{Math.round(score)}</strong> · {score >= 80 ? "Recommend" : score >= 65 ? "Conditional" : "Reject"}</span>
        <button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={!!act.busy}>{act.busy ? "Saving…" : "Save evaluation"}</button></>}>
        <div className="rating-list span">
          {template.map((t) => (
            <div key={t.code} className="rating-row">
              <span>{t.name}<span className="cell-sub">Weight {t.weight}{t.mandatory ? "" : " · optional, scores zero if not rated"}</span></span>
              {ratings[t.code] == null
                ? <button type="button" className="btn ghost sm" onClick={() => setRatings((r) => ({ ...r, [t.code]: Math.round(Number(t.max_score) / 2) }))}>Rate</button>
                : <input type="range" min={0} max={Number(t.max_score)} step={1} value={ratings[t.code] ?? 0} onChange={(e) => setRatings((r) => ({ ...r, [t.code]: Number(e.target.value) }))} aria-label={t.name} />}
              <span className="num">{ratings[t.code] == null ? "—" : `${ratings[t.code]}/${t.max_score}`}{!t.mandatory && ratings[t.code] != null && <button type="button" className="btn ghost sm" title="Not rated" aria-label={`Clear ${t.name}`} onClick={() => setRatings((r) => ({ ...r, [t.code]: null }))}>×</button>}</span>
            </div>
          ))}
        </div>
        <Field label="Strengths" span><textarea rows={2} value={strengths} onChange={(e) => setStrengths(e.target.value)} /></Field>
        <Field label="Risks" span><textarea rows={2} value={risks} onChange={(e) => setRisks(e.target.value)} /></Field>
        <div className="span"><FormError error={act.error} /></div>
      </Form>
    </Dialog>
  );
}

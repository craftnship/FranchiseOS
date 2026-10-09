import { Link } from "react-router-dom";
import { api, Row } from "../api";
import { useLoad } from "../hooks";
import { date, Loaded, Pill } from "../components/ui";
import { Checklist, ReadinessCard } from "./Projects";

export function PortalHome() {
  const load = useLoad(() => api<Row>("GET", "/portal/home"), []);
  return (
    <Loaded load={load}>{(h) => (
      <>
        <h1>Welcome{h.franchisee?.display_name ? `, ${h.franchisee.display_name}` : ""}</h1>
        <section className={`card next ${h.next_action.owner}`}>
          <div className="muted">{h.next_action.owner === "you" ? "Your next step" : "With our team"}</div>
          <h2>{h.next_action.title}</h2>
          {h.next_action.detail && <p>{h.next_action.detail}</p>}
          {h.next_action.path && <Link to={h.next_action.path}>Go</Link>}
        </section>
        <div className="grid3">
          <section className="card"><h2>Application</h2>{h.application ? <p>{h.application.application_code} <Pill value={h.application.status} /></p> : <p className="muted">Not started</p>}</section>
          <section className="card"><h2>Site</h2>{h.site ? <p>{h.site.site_code} · {h.site.city} <Pill value={h.site.status} /></p> : <p className="muted">No site yet</p>}</section>
          <section className="card"><h2>Agreement</h2>{h.agreement ? <p>{h.agreement.agreement_code} <Pill value={h.agreement.status} />{h.agreement.signed_at ? ` · signed ${date(h.agreement.signed_at)}` : ""}</p> : <p className="muted">Not sent yet</p>}</section>
        </div>
        {h.project && (
          <section className="card">
            <h2>Store opening {h.project.project_code} <Pill value={h.project.readiness?.rag} /></h2>
            <p>Readiness {h.project.readiness?.score ?? "-"}% · target opening {date(h.project.target_opening_date)}</p>
            <h3>Coming up</h3>
            <Checklist items={h.upcoming_tasks} />
            <Link to="/portal/tasks">All tasks</Link>
          </section>
        )}
      </>
    )}</Loaded>
  );
}

export function PortalTasks() {
  const home = useLoad(() => api<Row>("GET", "/portal/home"), []);
  return (
    <Loaded load={home}>{(h) => h.project ? <ProjectTasks id={String(h.project.ROWID)} /> : <div className="state">Your opening tasks appear here once your agreement is signed.</div>}</Loaded>
  );
}

function ProjectTasks({ id }: { id: string }) {
  const project = useLoad(() => api<Row>("GET", `/projects/${id}`), [id]);
  const readiness = useLoad(() => api<Row>("GET", `/projects/${id}/readiness`), [id]);
  return (
    <>
      <h1>Opening tasks</h1>
      <Loaded load={readiness}>{(r) => <ReadinessCard r={r} />}</Loaded>
      <Loaded load={project}>{(p) => <section className="card"><Checklist items={p.checklist} /></section>}</Loaded>
    </>
  );
}

export function PortalAgreement() {
  const load = useLoad(() => api<Row[]>("GET", "/agreements"), []);
  return (
    <>
      <h1>Your agreement</h1>
      <Loaded load={load} empty={(d) => !d.length}>{(rows) => (
        <ul className="plain">{rows.map((g) => (
          <li key={g.ROWID} className="card">
            <h2>{g.agreement_code} <Pill value={g.status} /></h2>
            {g.status === "SENT" || g.status === "VIEWED" ? <p>Check your email for the Zoho Sign request and sign it there.</p> : null}
            {g.signed_at && <p>Signed {date(g.signed_at)} · valid {date(g.effective_date)} to {date(g.expiry_date)}</p>}
          </li>
        ))}</ul>
      )}</Loaded>
    </>
  );
}

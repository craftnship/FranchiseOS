import { Link } from "react-router-dom";
import { api, Row } from "../api";
import { useLoad } from "../hooks";
import { date, Facts, Icon, Loaded, PageHeader, Panel, Pill, Progress } from "../components/ui";
import { Checklist, ReadinessCard } from "./Projects";
import { LicencePanel } from "../components/Licences";

export function PortalHome() {
  const load = useLoad(() => api<Row>("GET", "/portal/home"), []);
  return (
    <Loaded load={load}>{(h) => (
      <>
        <PageHeader title={`Welcome${h.franchisee?.display_name ? `, ${h.franchisee.display_name}` : ""}`} subtitle="Your franchise journey at a glance." />
        <section className={`next-action ${h.next_action.owner}`}>
          <div>
            <small>{h.next_action.owner === "you" ? "Your next step" : "With our team"}</small>
            <h2>{h.next_action.title}</h2>
            {h.next_action.detail && <p>{h.next_action.detail}</p>}
          </div>
          {h.next_action.path && <Link className="btn" to={h.next_action.path}>Continue<Icon name="chevron" size={16} /></Link>}
        </section>
        <div className="row c3">
          <Panel title="Application">{h.application ? <div className="stat-line"><span className="code">{h.application.application_code}</span><Pill value={h.application.status} /></div> : <p className="muted">Not started</p>}</Panel>
          <Panel title="Site">{h.site ? <div className="stat-line">{h.site.site_code} · {h.site.city}<Pill value={h.site.status} /></div> : <p className="muted">No site yet</p>}</Panel>
          <Panel title="Agreement">{h.agreement ? <><div className="stat-line">{h.agreement.agreement_code}<Pill value={h.agreement.status} /></div>{h.agreement.signed_at && <p className="muted">Signed {date(h.agreement.signed_at)}</p>}</> : <p className="muted">Not sent yet</p>}</Panel>
        </div>
        {h.project && (
          <Panel title={<>Store opening {h.project.project_code}<Pill value={h.project.readiness?.rag} /></>} action={<Link to="/portal/tasks">All tasks</Link>} flush>
            <div className="panel-body"><Facts items={[["Readiness", <Progress value={h.project.readiness?.score} rag={h.project.readiness?.rag} />], ["Target opening", date(h.project.target_opening_date)]]} /></div>
            <Checklist items={h.upcoming_tasks} />
          </Panel>
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
      <PageHeader title="Opening tasks" subtitle="Everything that has to be done before your store opens." />
      <Loaded load={readiness}>{(r) => <ReadinessCard r={r} />}</Loaded>
      <Loaded load={project}>{(p) => <>
        <Panel title="Checklist" flush><Checklist items={p.checklist} /></Panel>
        <LicencePanel projectId={id} licences={(p.licences ?? []) as Row[]} editable={false} onChanged={project.reload} />
      </>}</Loaded>
    </>
  );
}

export function PortalAgreement() {
  const load = useLoad(() => api<Row[]>("GET", "/agreements"), []);
  return (
    <>
      <PageHeader title="Your agreement" />
      <Loaded load={load} empty={(d) => !d.length} emptyText="Your agreement appears here once it is sent.">{(rows) => (
        <>{rows.map((g) => (
          <Panel key={g.ROWID} title={<>{g.agreement_code}<Pill value={g.status} /></>}>
            {g.status === "SENT" || g.status === "VIEWED" ? <div className="notice warn"><Icon name="send" />Check your email for the Zoho Sign request and sign it there.</div> : null}
            <Facts items={[["Signed", date(g.signed_at)], ["Effective", date(g.effective_date)], ["Expires", date(g.expiry_date)]]} />
          </Panel>
        ))}</>
      )}</Loaded>
    </>
  );
}

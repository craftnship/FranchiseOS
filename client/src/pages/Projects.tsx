import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError, can, Row } from "../api";
import { useLoad } from "../hooks";
import { date, ErrorState, Loaded, Pill } from "../components/ui";

const TRANSITION_LABEL: Record<string, string> = { start: "Start work", ready_for_opening: "Mark ready for opening", open: "Mark opened", close: "Close project" };

export function Projects() {
  const [params] = useSearchParams();
  const query = Object.fromEntries(params.entries());
  const load = useLoad(() => api<Row[]>("GET", "/projects", { query: { ...query, limit: "100" } }), [params.toString()]);
  const filtered = Object.keys(query).length > 0;
  return (
    <>
      <h1>Opening projects</h1>
      {filtered && <p className="muted">Filtered: {Object.entries(query).map(([k, v]) => `${k.replace(/_/g, " ")} ${v.replace(/,/g, ", ").toLowerCase()}`).join("; ")} · <Link to="/projects">Show all</Link></p>}
      <Loaded load={load} empty={(d) => !d.length}>{(rows) => (
        <table>
          <thead><tr><th>Project</th><th>Status</th><th>Readiness</th><th>Risk</th><th>Target opening</th></tr></thead>
          <tbody>{rows.map((p) => (
            <tr key={p.ROWID}><td><Link to={`/projects/${p.ROWID}`}>{p.project_code}</Link></td><td><Pill value={p.status} /></td><td>{p.readiness_score ?? "-"} <Pill value={p.readiness_rag} /></td><td><Pill value={p.risk_level} /></td><td>{date(p.target_opening_date)}</td></tr>
          ))}</tbody>
        </table>
      )}</Loaded>
    </>
  );
}

/** Readiness card shared by the staff project page and the portal. */
export function ReadinessCard({ r }: { r: Row }) {
  return (
    <section className="card">
      <h2>Readiness <span className="big">{r.score}%</span> <Pill value={r.rag} /></h2>
      {r.score !== r.weighted_score && <p className="muted">Capped at {r.score}% by {r.blockers.length} blocker(s); tasks are {r.weighted_score}% done by weight.</p>}
      <ul className="cats">
        {Object.entries(r.by_category as Record<string, number>).map(([c, v]) => (
          <li key={c}><span>{c.toLowerCase()}</span><span className="bar"><span style={{ width: `${v}%` }} /></span><span className="num">{v}%</span></li>
        ))}
      </ul>
      {(r.blocker_items?.length ?? 0) > 0 && <p><strong>Blockers:</strong> {r.blocker_items.map((i: Row) => i.item).join(", ")}</p>}
      {(r.overdue_items?.length ?? 0) > 0 && <p><strong>Overdue:</strong> {r.overdue_items.map((i: Row) => i.item).join(", ")}</p>}
    </section>
  );
}

export function ProjectDetail() {
  const { id } = useParams();
  const project = useLoad(() => api<Row>("GET", `/projects/${id}`), [id]);
  const readiness = useLoad(() => api<Row>("GET", `/projects/${id}/readiness`), [id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await fn(); project.reload(); readiness.reload(); } catch (e) { setError(e as ApiError); } finally { setBusy(null); }
  };
  const transition = (t: string) => run(t, () => {
    const body: Row = { transition: t };
    if (t === "open") {
      const d = window.prompt("Opening date (YYYY-MM-DD)", new Date().toISOString().slice(0, 10));
      if (!d) return Promise.resolve();
      body.actual_opening_date = d;
    }
    return api("POST", `/projects/${id}/transition`, { body });
  });
  return (
    <Loaded load={project}>{(p) => (
      <>
        <h1>{p.project_code} <Pill value={p.status} /> {p.delayed && <span className="pill bad">delayed</span>}</h1>
        <p className="muted">Target opening {date(p.target_opening_date)}{p.actual_opening_date ? ` · opened ${date(p.actual_opening_date)}` : ""}{p.zoho_project_id ? " · linked to Zoho Projects" : ""}</p>
        <div className="actions">
          {can("project.write") && <button onClick={() => run("sync", () => api("POST", `/projects/${id}/sync`))} disabled={!!busy}>{busy === "sync" ? "Syncing…" : "Sync from Zoho Projects"}</button>}
          {(p.allowed_transitions as string[]).filter((t) => TRANSITION_LABEL[t]).map((t) => (
            <button key={t} className="secondary" onClick={() => transition(t)} disabled={!!busy}>{TRANSITION_LABEL[t]}</button>
          ))}
        </div>
        {error && <ErrorState error={error} />}
        <Loaded load={readiness}>{(r) => <ReadinessCard r={r} />}</Loaded>
        <section className="card">
          <h2>Opening checklist</h2>
          <Checklist items={p.checklist} busy={busy} onToggle={!can("project.write") ? undefined : (item) => run(`b${item.ROWID}`, () => api("PATCH", `/projects/${id}/checklist/${item.ROWID}`, { body: { blocked: item.status !== "BLOCKED" } }))} />
        </section>
      </>
    )}</Loaded>
  );
}

export function Checklist({ items, onToggle, busy }: { items: Row[]; onToggle?: (item: Row) => void; busy?: string | null }) {
  const today = new Date().toISOString().slice(0, 10);
  if (!items.length) return <div className="state">No tasks yet.</div>;
  return (
    <table>
      <thead><tr><th>Task</th><th>Category</th><th>Status</th><th>Due</th>{onToggle && <th />}</tr></thead>
      <tbody>{items.map((i) => {
        const overdue = i.status !== "COMPLETED" && i.due_date && String(i.due_date).slice(0, 10) < today;
        return (
          <tr key={i.ROWID}>
            <td>{i.item}{String(i.mandatory) === "true" || i.mandatory === true ? "" : <span className="muted"> (optional)</span>}</td>
            <td>{String(i.category).toLowerCase()}</td>
            <td><Pill value={i.status} /> {overdue && <span className="pill bad">overdue</span>}</td>
            <td>{date(i.due_date)}</td>
            {onToggle && <td>{i.status !== "COMPLETED" && <button className="link" disabled={busy === `b${i.ROWID}`} onClick={() => onToggle(i)}>{i.status === "BLOCKED" ? "Unblock" : "Flag blocked"}</button>}</td>}
          </tr>
        );
      })}</tbody>
    </table>
  );
}

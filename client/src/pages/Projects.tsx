import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api, ApiError, can, Row } from "../api";
import { useFranchiseeNames, useLoad } from "../hooks";
import { DataTable, date, Donut, ErrorState, Icon, inr, label, Loaded, PageHeader, Panel, Pill, Progress, toneOf } from "../components/ui";
import { StatusPath } from "./Applications";

const TRANSITION_LABEL: Record<string, string> = { start: "Start work", ready_for_opening: "Mark ready for opening", open: "Mark opened", close: "Close project" };
const PATH = ["PLANNING", "IN_PROGRESS", "READY_FOR_OPENING", "OPENED"];
const STATUS_ORDER = ["PLANNING", "IN_PROGRESS", "AT_RISK", "READY_FOR_OPENING", "OPENED", "CLOSED"];
const VIEWS: [string, Record<string, string>][] = [
  ["All", {}], ["In flight", { status: "PLANNING,IN_PROGRESS,AT_RISK,READY_FOR_OPENING" }], ["At risk", { status: "AT_RISK" }],
  ["High risk", { risk_level: "HIGH" }], ["Delayed", { delayed: "true" }], ["Opened", { status: "OPENED" }],
];
const daysTo = (d: unknown) => (d ? Math.round((Date.parse(String(d).slice(0, 10)) - Date.parse(new Date().toISOString().slice(0, 10))) / 86400000) : null);

export function Projects() {
  const [params, setParams] = useSearchParams();
  const query = Object.fromEntries(params.entries());
  const load = useLoad(() => api<Row[]>("GET", "/projects", { query: { ...query, limit: "200" } }), [params.toString()]);
  const names = useFranchiseeNames();
  const key = JSON.stringify(query);
  const known = VIEWS.some(([, q]) => JSON.stringify(q) === key);
  return (
    <>
      <PageHeader title="Opening projects" crumbs={[["Operations"], ["Opening projects"]]} subtitle="Store openings with live readiness, risk and target dates." />
      <Loaded load={load}>{(rows) => (
        <DataTable rows={rows} href={(p) => `/projects/${p.ROWID}`} searchKeys={["project_code", "status", "readiness_rag", "risk_level"]}
          toolbar={<div className="chips">
            {VIEWS.map(([text, q]) => <button key={text} className={`chip ${JSON.stringify(q) === key ? "on" : ""}`} onClick={() => setParams(q)}>{text}</button>)}
            {!known && <span className="chip on">Filtered: {Object.entries(query).map(([k, v]) => `${label(k)} ${label(v)}`).join(", ")}</span>}
          </div>}
          columns={[
            { key: "project_code", label: "Project", render: (p) => <span className="code">{p.project_code}</span> },
            { key: "franchisee_id", label: "Franchisee", sort: (p) => names[p.franchisee_id] ?? "", render: (p) => names[p.franchisee_id] ?? <span className="muted">—</span> },
            { key: "status", label: "Status", sort: (p) => STATUS_ORDER.indexOf(p.status), render: (p) => <Pill value={p.status} /> },
            { key: "readiness_score", label: "Readiness", sort: (p) => Number(p.readiness_score ?? -1), render: (p) => <Progress value={p.readiness_score} rag={p.readiness_rag} /> },
            { key: "readiness_rag", label: "RAG", render: (p) => <Pill value={p.readiness_rag} /> },
            { key: "risk_level", label: "Risk", sort: (p) => ["LOW", "MEDIUM", "HIGH"].indexOf(p.risk_level), render: (p) => <Pill value={p.risk_level} /> },
            { key: "target_opening_date", label: "Target opening", render: (p) => {
              const d = daysTo(p.target_opening_date);
              const open = !["OPENED", "CLOSED"].includes(p.status);
              return <>{date(p.target_opening_date)}{open && d !== null && <span className="cell-sub" style={{ color: d < 0 ? "var(--bad)" : undefined }}>{d < 0 ? `${-d} days late` : `in ${d} days`}</span>}</>;
            } },
            { key: "actual_opening_date", label: "Opened", render: (p) => date(p.actual_opening_date) },
          ]} />
      )}</Loaded>
    </>
  );
}

/** Readiness panel shared by the staff project page and the portal. */
export function ReadinessCard({ r }: { r: Row }) {
  return (
    <Panel title="Readiness" action={<Pill value={r.rag} />}>
      <div className="ready-hero">
        <Donut size={120} parts={[{ value: r.score, tone: toneOf(r.rag) }, { value: 100 - r.score, tone: "transparent" }]} center={<strong>{r.score}%</strong>} caption="ready" />
        <div className="ready-meta">
          {r.score !== r.weighted_score
            ? <p>Capped at <strong>{r.score}%</strong> by {r.blockers.length} blocker{r.blockers.length === 1 ? "" : "s"}. Tasks are {r.weighted_score}% done by weight.</p>
            : <p>Tasks are <strong>{r.weighted_score}%</strong> done by weight.</p>}
          {(r.blocker_items?.length ?? 0) > 0 && <div className="issue-list"><span className="muted">Blockers</span>{r.blocker_items.map((i: Row) => <Pill key={i.item} value={i.item} tone="bad" />)}</div>}
          {(r.overdue_items?.length ?? 0) > 0 && <div className="issue-list"><span className="muted">Overdue</span>{r.overdue_items.map((i: Row) => <Pill key={i.item} value={i.item} tone="warn" />)}</div>}
        </div>
      </div>
      <h3 className="muted" style={{ fontSize: ".72rem", textTransform: "uppercase", letterSpacing: ".05em", margin: "1.2rem 0 .5rem" }}>By category</h3>
      <ul className="cats">
        {Object.entries(r.by_category as Record<string, number>).map(([c, v]) => (
          <li key={c}><span>{label(c)}</span><Progress value={v} rag={v >= 85 ? "GREEN" : v >= 70 ? "AMBER" : v > 0 ? "RED" : undefined} /></li>
        ))}
      </ul>
    </Panel>
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
    <Loaded load={project}>{(p) => {
      const d = daysTo(p.target_opening_date);
      const done = (p.checklist as Row[]).filter((i) => i.status === "COMPLETED").length;
      return (
        <>
          <PageHeader title={p.project_code} badges={<><Pill value={p.status} />{p.delayed && <Pill value="Delayed" tone="bad" />}</>}
            crumbs={[["Operations"], ["Opening projects", "/projects"], [p.project_code]]}
            subtitle={p.zoho_project_id ? "Linked to Zoho Projects" : "Not linked to Zoho Projects"}
            actions={<>
              {can("project.write") && p.zoho_project_id && <button className="btn secondary" onClick={() => run("sync", () => api("POST", `/projects/${id}/sync`))} disabled={!!busy}><Icon name="sync" size={16} />{busy === "sync" ? "Syncing…" : "Sync from Zoho Projects"}</button>}
              {(p.allowed_transitions as string[]).filter((t) => TRANSITION_LABEL[t]).map((t) => (
                <button key={t} className={t === "close" ? "btn secondary" : "btn"} onClick={() => transition(t)} disabled={!!busy}>{TRANSITION_LABEL[t]}</button>
              ))}
            </>} />
          {error && <ErrorState error={error} />}
          <FeeNotice fee={p.fee} />
          <dl className="summary">
            <div><dt>Readiness</dt><dd>{p.readiness_score ?? "—"}%<Pill value={p.readiness_rag} /></dd></div>
            <div><dt>Risk</dt><dd><Pill value={p.risk_level} /></dd></div>
            <div><dt>Target opening</dt><dd>{date(p.target_opening_date)}</dd></div>
            <div><dt>{p.actual_opening_date ? "Opened" : "Days to opening"}</dt><dd style={{ color: !p.actual_opening_date && d !== null && d < 0 ? "var(--bad)" : undefined }}>{p.actual_opening_date ? date(p.actual_opening_date) : d === null ? "—" : d < 0 ? `${-d} days late` : `${d} days`}</dd></div>
          </dl>
          {PATH.includes(p.status) && <Panel title="Lifecycle"><StatusPath steps={PATH} current={p.status} /></Panel>}
          <Loaded load={readiness}>{(r) => <ReadinessCard r={r} />}</Loaded>
          <Panel title="Opening checklist" action={<span className="muted">{done} of {p.checklist.length} complete</span>} flush>
            <Checklist items={p.checklist} busy={busy} onToggle={!can("project.write") ? undefined : (item) => run(`b${item.ROWID}`, () => api("PATCH", `/projects/${id}/checklist/${item.ROWID}`, { body: { blocked: item.status !== "BLOCKED" } }))} />
          </Panel>
        </>
      );
    }}</Loaded>
  );
}

export function Checklist({ items, onToggle, busy }: { items: Row[]; onToggle?: (item: Row) => void; busy?: string | null }) {
  const today = new Date().toISOString().slice(0, 10);
  if (!items.length) return <div className="state">No tasks yet.</div>;
  return (
    <DataTable rows={items} columns={[
      { key: "item", label: "Task", render: (i) => <>{i.item}{String(i.mandatory) === "true" || i.mandatory === true ? null : <span className="cell-sub">Optional</span>}</> },
      { key: "category", label: "Category", render: (i) => label(i.category) },
      { key: "weight", label: "Weight", align: "right", sort: (i) => Number(i.weight ?? 0) },
      { key: "status", label: "Status", render: (i) => {
        const overdue = i.status !== "COMPLETED" && i.due_date && String(i.due_date).slice(0, 10) < today;
        return <span className="chips"><Pill value={i.status} />{overdue && <Pill value="Overdue" tone="bad" />}</span>;
      } },
      { key: "due_date", label: "Due", render: (i) => date(i.due_date) },
      ...(onToggle ? [{ key: "_act", label: "", render: (i: Row) => i.status !== "COMPLETED" && <button className={i.status === "BLOCKED" ? "btn ghost sm" : "btn danger-ghost sm"} disabled={busy === `b${i.ROWID}`} onClick={() => onToggle(i)}>{i.status === "BLOCKED" ? "Unblock" : "Flag blocked"}</button> }] : []),
    ]} />
  );
}

/** The franchise fee from Books: a warning while unpaid, never a block on the work. */
function FeeNotice({ fee }: { fee: Row | null | undefined }) {
  if (!fee) return null;
  if (fee.status === "unknown") return <div className="notice warn"><Icon name="alert" />Couldn't check the franchise fee in Zoho Books just now.</div>;
  if (fee.paid) return <div className="notice ok"><Icon name="check" />Franchise fee {fee.invoice_number} is paid.</div>;
  return (
    <div className="notice warn"><Icon name="money" />
      Franchise fee {fee.invoice_number || "invoice"} is unpaid: {inr(Number(fee.balance))} of {inr(Number(fee.total))} outstanding{fee.due_date ? `, due ${date(fee.due_date)}` : ""} ({label(fee.status)}). Work can continue.
    </div>
  );
}

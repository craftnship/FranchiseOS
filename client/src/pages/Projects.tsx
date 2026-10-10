import { ReactNode, useCallback, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api, ApiError, can, Row } from "../api";
import { useAction, useFranchiseeNames, useLoad } from "../hooks";
import { ConfirmDialog, Dialog, Field, Form, FormError } from "../components/forms";
import { DataTable, date, Donut, Icon, inr, label, Loaded, PageHeader, Panel, Pill, Progress, toneOf } from "../components/ui";
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
  const reload = useCallback(() => { project.reload(); readiness.reload(); }, [project.reload, readiness.reload]);
  const act = useAction(reload);
  const [opening, setOpening] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [blocking, setBlocking] = useState<Row | null>(null);
  const transition = (t: string) => act.run(t, () => api<Row>("POST", `/projects/${id}/transition`, { body: { transition: t } }), (r) => `${TRANSITION_LABEL[t]} done. The project is ${label(r.status).toLowerCase()}.`);
  const patch = (item: Row, body: Row, done: string) => act.run(`i${item.ROWID}`, () => api<Row>("PATCH", `/projects/${id}/checklist/${item.ROWID}`, { body }), (r) => `${item.item}: ${done}${r.zoho ? " Zoho Projects is updated too." : ""}`);
  return (
    <Loaded load={project}>{(p) => {
      const d = daysTo(p.target_opening_date);
      const items = p.checklist as Row[];
      const done = items.filter((i) => i.status === "COMPLETED").length;
      const writable = can("project.write") && !["OPENED", "CLOSED"].includes(p.status);
      return (
        <>
          <PageHeader title={p.project_code} badges={<><Pill value={p.status} />{p.delayed && <Pill value="Delayed" tone="bad" />}</>}
            crumbs={[["Operations"], ["Opening projects", "/projects"], [p.project_code]]}
            subtitle={p.zoho_project_id ? "Linked to Zoho Projects" : "Not linked to Zoho Projects"}
            actions={<>
              {can("project.write") && p.zoho_project_id && <button className="btn secondary" onClick={() => act.run("sync", () => api<Row>("POST", `/projects/${id}/sync`), (r) => r.sync ? `Synced from Zoho Projects: ${r.sync.updated} task${r.sync.updated === 1 ? "" : "s"} changed.` : "Readiness refreshed.")} disabled={!!act.busy}><Icon name="sync" size={16} />{act.busy === "sync" ? "Syncing…" : "Sync from Zoho Projects"}</button>}
              {(p.allowed_transitions as string[]).filter((t) => TRANSITION_LABEL[t]).map((t) => (
                <button key={t} className={t === "close" ? "btn secondary" : "btn"} disabled={!!act.busy} onClick={() => (t === "open" ? setOpening(true) : transition(t))}>
                  {t === "open" && <Icon name="store" size={16} />}{act.busy === t ? "Working…" : TRANSITION_LABEL[t]}
                </button>
              ))}
            </>} />
          {act.notice && <div className="notice ok"><Icon name="check" />{act.notice}</div>}
          {act.error && !opening && !editing && !blocking && <FormError error={act.error} />}
          <FeeNotice fee={p.fee} />
          <dl className="summary">
            <div><dt>Readiness</dt><dd>{p.readiness_score ?? "—"}%<Pill value={p.readiness_rag} /></dd></div>
            <div><dt>Risk</dt><dd><Pill value={p.risk_level} /></dd></div>
            <div><dt>Target opening</dt><dd>{date(p.target_opening_date)}</dd></div>
            <div><dt>{p.actual_opening_date ? "Opened" : "Days to opening"}</dt><dd style={{ color: !p.actual_opening_date && d !== null && d < 0 ? "var(--bad)" : undefined }}>{p.actual_opening_date ? date(p.actual_opening_date) : d === null ? "—" : d < 0 ? `${-d} days late` : `${d} days`}</dd></div>
          </dl>
          {PATH.includes(p.status) && <Panel title="Lifecycle"><StatusPath steps={PATH} current={p.status} /></Panel>}
          <Loaded load={readiness}>{(r) => <ReadinessCard r={r} />}</Loaded>
          <Panel title="Opening checklist" action={<span className="muted">{done} of {items.length} complete</span>} flush>
            <Checklist items={items} actions={!writable ? undefined : (i) => {
              const busy = act.busy === `i${i.ROWID}`;
              return (
                <span className="panel-actions">
                  {i.status === "COMPLETED"
                    ? <button className="btn ghost sm" disabled={busy} onClick={() => patch(i, { done: false }, "reopened.")}>Reopen</button>
                    : <button className="btn sm" disabled={busy} onClick={() => patch(i, { done: true }, "marked done.")}><Icon name="check" size={14} />{busy ? "Saving…" : "Mark done"}</button>}
                  <button className="btn ghost sm" disabled={busy} onClick={() => setEditing(i)}>Edit</button>
                  {i.status === "BLOCKED"
                    ? <button className="btn ghost sm" disabled={busy} onClick={() => patch(i, { blocked: false }, "unblocked.")}>Unblock</button>
                    : i.status !== "COMPLETED" && <button className="btn danger-ghost sm" disabled={busy} onClick={() => setBlocking(i)}>Flag blocked</button>}
                </span>
              );
            }} />
          </Panel>
          {opening && <OpenStoreDialog project={p} items={items} busy={act.busy === "open"} error={act.error} onClose={() => { setOpening(false); act.clear(); }}
            onOpen={(date) => act.run("open", () => api<Row>("POST", `/projects/${id}/transition`, { body: { transition: "open", actual_opening_date: date } }), "The store is open. The franchisee is now active.").then((r) => r && setOpening(false))} />}
          {editing && <TaskDialog item={editing} staff={(p.staff ?? []) as Row[]} linked={!!(p.zoho_project_id && editing.external_task_id)} busy={!!act.busy} error={act.error}
            onClose={() => { setEditing(null); act.clear(); }} onSave={(body) => patch(editing, body, "saved.").then((r) => r && setEditing(null))} />}
          {blocking && <ConfirmDialog title={`Flag “${blocking.item}” as blocked?`} confirm="Flag blocked" danger comment="required" busy={!!act.busy} error={act.error}
            body={<p className="muted" style={{ margin: 0 }}>A blocked mandatory task holds readiness down and moves the project to at risk until it is cleared.</p>}
            onClose={() => { setBlocking(null); act.clear(); }} onConfirm={(reason) => patch(blocking, { blocked: true, reason }, "flagged as blocked.").then((r) => r && setBlocking(null))} />}
        </>
      );
    }}</Loaded>
  );
}

/** Confirms the opening date and says what opening does, with any tasks still open. */
function OpenStoreDialog({ project, items, busy, error, onOpen, onClose }: { project: Row; items: Row[]; busy: boolean; error: ApiError | null; onOpen: (date: string) => void; onClose: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [day, setDay] = useState(today);
  const open = items.filter((i) => i.status !== "COMPLETED" && (i.mandatory === true || String(i.mandatory) === "true"));
  return (
    <Dialog title={`Open ${project.project_code}`} subtitle="Record the day the store opened its doors." onClose={onClose}>
      <Form onSubmit={() => day && onOpen(day)} footer={<>
        <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={busy || !day || day > today}><Icon name="store" size={16} />{busy ? "Opening…" : "Mark opened"}</button>
      </>}>
        <Field label="Opening date" hint={project.target_opening_date ? `Target was ${date(project.target_opening_date)}.` : undefined} error={day > today ? "can't be in the future" : undefined}>
          <input type="date" value={day} max={today} onChange={(e) => setDay(e.target.value)} required autoFocus />
        </Field>
        <div className="span muted">Opening makes the application and the franchisee active, and records the opening date on their CRM account.</div>
        {open.length > 0 && <div className="span notice warn"><Icon name="alert" /><span>{open.length} mandatory task{open.length === 1 ? " is" : "s are"} still open: {open.slice(0, 4).map((i) => i.item).join(", ")}{open.length > 4 ? ", …" : ""}.</span></div>}
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

/** Owner and due date of one checklist task. */
function TaskDialog({ item, staff, linked, busy, error, onSave, onClose }: { item: Row; staff: Row[]; linked: boolean; busy: boolean; error: ApiError | null; onSave: (body: Row) => void; onClose: () => void }) {
  const [owner, setOwner] = useState(String(item.owner_user_id ?? ""));
  const [due, setDue] = useState(item.due_date ? String(item.due_date).slice(0, 10) : "");
  const save = () => {
    const body: Row = {};
    if (owner !== String(item.owner_user_id ?? "")) body.owner_user_id = owner || null;
    if (due && due !== String(item.due_date ?? "").slice(0, 10)) body.due_date = due;
    if (Object.keys(body).length) onSave(body); else onClose();
  };
  return (
    <Dialog title={String(item.item)} subtitle={label(item.category)} onClose={onClose}>
      <Form onSubmit={save} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy}>{busy ? "Saving…" : "Save"}</button></>}>
        <Field label="Owner" span>
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">No owner</option>
            {staff.map((p) => <option key={p.ROWID} value={p.ROWID}>{p.name ?? p.email}</option>)}
          </select>
        </Field>
        <Field label="Due date" span hint={linked ? "The task in Zoho Projects moves to end on this day, keeping its length." : undefined}>
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} required />
        </Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

export function Checklist({ items, actions }: { items: Row[]; actions?: (item: Row) => ReactNode }) {
  const today = new Date().toISOString().slice(0, 10);
  if (!items.length) return <div className="state">No tasks yet.</div>;
  const owners = items.some((i) => i.owner !== undefined);
  return (
    <DataTable rows={items} columns={[
      { key: "item", label: "Task", render: (i) => <>{i.item}{String(i.mandatory) === "true" || i.mandatory === true ? null : <span className="cell-sub">Optional</span>}</> },
      { key: "category", label: "Category", render: (i) => label(i.category) },
      ...(owners ? [{ key: "owner", label: "Owner", sort: (i: Row) => i.owner?.name ?? i.owner?.email ?? "~", render: (i: Row) => i.owner ? (i.owner.name ?? i.owner.email) : <span className="muted">—</span> }] : []),
      { key: "weight", label: "Weight", align: "right", sort: (i) => Number(i.weight ?? 0) },
      { key: "status", label: "Status", render: (i) => {
        const overdue = i.status !== "COMPLETED" && i.due_date && String(i.due_date).slice(0, 10) < today;
        // Zoho's own status name (Delayed, To be Tested…) when it says more than the FOS status.
        const zoho = i.external_status && !["open", "closed", label(i.status).toLowerCase()].includes(String(i.external_status).toLowerCase()) ? String(i.external_status) : null;
        return <><span className="chips"><Pill value={i.status} />{overdue && <Pill value="Overdue" tone="bad" />}</span>{zoho && <span className="cell-sub">{zoho} in Zoho</span>}</>;
      } },
      { key: "due_date", label: "Due", render: (i) => date(i.due_date) },
      ...(actions ? [{ key: "_act", label: "", render: actions }] : []),
    ]} />
  );
}

/** The franchise fee from Books: a warning while unpaid, never a block on the work. */
function FeeNotice({ fee }: { fee: Row | null | undefined }) {
  if (!fee) return null;
  if (fee.status === "unknown") return <div className="notice warn"><Icon name="alert" />Couldn't check the franchise fee in Zoho Books just now.</div>;
  if (fee.paid) return <div className="notice ok"><Icon name="check" />Franchise fee {fee.invoice_number ?? ""} is paid{fee.paid_on ? ` (${date(fee.paid_on)})` : ""}.</div>;
  return (
    <div className="notice warn"><Icon name="money" />
      Franchise fee {fee.invoice_number || "invoice"} is unpaid: {inr(Number(fee.balance))} of {inr(Number(fee.total))} outstanding{fee.due_date ? `, due ${date(fee.due_date)}` : ""} ({label(fee.status)}). Work can continue.
    </div>
  );
}

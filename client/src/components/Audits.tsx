import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, can, Row } from "../api";
import { useAction, useLoad } from "../hooks";
import { upload } from "./Construction";
import { Dialog, Field, Form, FormError } from "./forms";
import { DataTable, date, Icon, Loaded, PageHeader, Panel, Pill } from "./ui";

const RATING_TONE: Record<string, string> = { GREEN: "good", AMBER: "warn", RED: "bad" };
const STATUS_TEXT: Record<string, string> = { SCHEDULED: "Booked", IN_PROGRESS: "In progress", COMPLETED: "Completed", CANCELLED: "Cancelled" };
const STATUS_TONE: Record<string, string> = { SCHEDULED: "info", IN_PROGRESS: "warn", COMPLETED: "good", CANCELLED: "neutral" };
const TYPE_TEXT: Record<string, string> = { ROUTINE: "Routine", OPENING: "Pre-opening", FOLLOW_UP: "Follow-up", SURPRISE: "Surprise" };
const ACTION_TEXT: Record<string, string> = { OPEN: "To fix", SUBMITTED: "Waiting for review", CLOSED: "Closed" };
const ACTION_TONE: Record<string, string> = { OPEN: "warn", SUBMITTED: "info", CLOSED: "good" };
const DOCS = "image/jpeg,image/png,image/webp,application/pdf";
const today = () => new Date().toISOString().slice(0, 10);
const openUrl = async (path: string) => { const r = await api<{ url: string }>("GET", path); window.open(r.url, "_blank", "noopener"); };

export function Score({ score, rating }: { score: unknown; rating: unknown }) {
  if (score === null || score === undefined) return <span className="muted">—</span>;
  return <span style={{ display: "inline-flex", alignItems: "center", gap: ".4rem" }}><strong>{Number(score)}%</strong><Pill value={rating} tone={RATING_TONE[String(rating)]} /></span>;
}

function ActionStatus({ a }: { a: Row }) {
  return a.overdue ? <Pill value="Overdue" tone="bad" /> : <Pill value={ACTION_TEXT[String(a.status)] ?? a.status} tone={ACTION_TONE[String(a.status)]} />;
}

type ActDlg = null | { kind: "respond" | "reopen"; action: Row };

/** Corrective actions with the right buttons for who is looking: the franchisee answers, audit.conduct reviews. */
function ActionsTable({ actions, portal, onChanged, empty }: { actions: Row[]; portal?: boolean; onChanged: () => void; empty: string }) {
  const act = useAction(onChanged);
  const [dlg, setDlg] = useState<ActDlg>(null);
  const conduct = !portal && can("audit.conduct");
  const close = () => { setDlg(null); act.clear(); };
  const patch = (a: Row, body: Row, msg: string) => act.run(`a${a.ROWID}`, () => api<Row>("PATCH", `/corrective-actions/${a.ROWID}`, { body }), msg);
  return (
    <>
      {act.notice && <div className="notice ok" style={{ margin: ".75rem 1rem 0" }}><Icon name="check" />{act.notice}</div>}
      {act.error && !dlg && <div style={{ margin: ".75rem 1rem 0" }}><FormError error={act.error} /></div>}
      {portal ? (
        // The franchisee answers on a phone, so each action is a row of its own rather than a wide table.
        <ul className="module-list">
          {actions.map((a) => (
            <li key={String(a.ROWID)}>
              <span style={{ flex: "1 1 14rem" }}>{a.description}
                <span className="cell-sub">
                  <Pill value={a.severity === "CRITICAL" ? "Critical" : "Major"} tone={a.severity === "CRITICAL" ? "bad" : "warn"} />{" "}
                  {a.status === "CLOSED" ? `Closed ${date(a.closed_at)}` : <span style={{ color: a.overdue ? "var(--bad)" : undefined }}>Due {date(a.due_date)}</span>}
                </span>
                {a.review_note && a.status !== "CLOSED" && <span className="cell-sub" style={{ color: "var(--warn)" }}>Sent back: {a.review_note}</span>}
                {a.response_note && a.status === "SUBMITTED" && <span className="cell-sub">You said: {a.response_note}</span>}
              </span>
              <span className="panel-actions"><ActionStatus a={a} />{a.status === "OPEN" && <button className="btn sm" disabled={act.busy === `a${a.ROWID}`} onClick={() => setDlg({ kind: "respond", action: a })}>Mark fixed</button>}</span>
            </li>
          ))}
          {!actions.length && empty && <li className="muted">{empty}</li>}
        </ul>
      ) : <DataTable rows={actions} empty={empty} columns={[
        { key: "description", label: "What to fix", render: (a) => <span style={{ display: "block", minWidth: "12rem" }}>{a.description}
          {a.response_note && <span className="cell-sub">Franchisee: {a.response_note}</span>}
          {a.review_note && a.status !== "CLOSED" && <span className="cell-sub" style={{ color: "var(--warn)" }}>Sent back: {a.review_note}</span>}</span> },
        { key: "severity", label: "Severity", render: (a) => <Pill value={a.severity === "CRITICAL" ? "Critical" : "Major"} tone={a.severity === "CRITICAL" ? "bad" : "warn"} /> },
        { key: "due_date", label: "Due", render: (a) => a.status === "CLOSED" ? <span className="muted">Closed {date(a.closed_at)}</span> : <span style={{ color: a.overdue ? "var(--bad)" : undefined }}>{date(a.due_date)}</span> },
        { key: "status", label: "Status", render: (a) => <ActionStatus a={a} /> },
        { key: "actions", label: "", align: "right", render: (a) => {
          const busy = act.busy === `a${a.ROWID}`;
          return (
            <span className="panel-actions">
              {a.evidence_ref && <button className="btn ghost sm" onClick={() => act.run("ev", () => openUrl(`/corrective-actions/${a.ROWID}/evidence`))}>Evidence</button>}
              {(portal || conduct) && a.status === "OPEN" && <button className="btn sm" disabled={busy} onClick={() => setDlg({ kind: "respond", action: a })}>{portal ? "Mark fixed" : "Record fix"}</button>}
              {conduct && a.status === "SUBMITTED" && <><button className="btn sm" disabled={busy} onClick={() => patch(a, { action: "close" }, "Action closed.")}>Close</button><button className="btn ghost sm" disabled={busy} onClick={() => setDlg({ kind: "reopen", action: a })}>Send back</button></>}
            </span>
          );
        } },
      ]} />}
      {dlg?.kind === "respond" && <RespondDialog action={dlg.action} busy={act.busy === `a${dlg.action.ROWID}`} error={act.error} onClose={close}
        onSave={(body) => patch(dlg.action, { action: "respond", ...body }, "Sent for review.").then((r) => r && setDlg(null))} />}
      {dlg?.kind === "reopen" && <ReopenDialog action={dlg.action} busy={act.busy === `a${dlg.action.ROWID}`} error={act.error} onClose={close}
        onSave={(body) => patch(dlg.action, { action: "reopen", ...body }, "Sent back to the franchisee.").then((r) => r && setDlg(null))} />}
    </>
  );
}

function RespondDialog({ action, busy, error, onSave, onClose }: { action: Row; busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  return (
    <Dialog title="What was done?" subtitle={String(action.description)} onClose={onClose}>
      <Form onSubmit={async () => onSave({ note: note.trim(), ...(file ? { evidence: await upload(file) } : {}) })}
        footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || note.trim().length < 3}>{busy ? "Sending…" : "Send for review"}</button></>}>
        <Field label="What you fixed" span><textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} required autoFocus /></Field>
        <Field label="Photo or document (optional)" hint="Shows the fix. Up to 5 MB." span><input type="file" accept={DOCS} capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

function ReopenDialog({ action, busy, error, onSave, onClose }: { action: Row; busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const [note, setNote] = useState("");
  const [due, setDue] = useState("");
  return (
    <Dialog title="Send it back" subtitle={String(action.response_note ?? action.description)} onClose={onClose}>
      <Form onSubmit={() => onSave({ note: note.trim(), ...(due ? { due_date: due } : {}) })}
        footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || note.trim().length < 3}>{busy ? "Sending…" : "Send back"}</button></>}>
        <Field label="What still needs doing" span><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} required autoFocus /></Field>
        <Field label="New due date (optional)"><input type="date" min={today()} value={due} onChange={(e) => setDue(e.target.value)} /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

/** A store's audits and open corrective actions, on the project page and the portal. */
export function AuditPanel({ projectId, portal }: { projectId: string; portal?: boolean }) {
  const load = useLoad(() => api<Row>("GET", `/projects/${projectId}/audits`), [projectId]);
  const act = useAction(load.reload);
  const [booking, setBooking] = useState(false);
  const conduct = !portal && can("audit.conduct");
  const href = (a: Row) => (portal ? `/portal/audits/${a.ROWID}` : `/audits/${a.ROWID}`);
  return (
    <Loaded load={load}>{(d) => {
      if (!d.auditable && !(d.audits as Row[]).length) return null;
      const audits = d.audits as Row[], last = d.last as Row | null;
      const open = audits.find((a) => a.status === "SCHEDULED" || a.status === "IN_PROGRESS");
      return (
        <Panel title="Store audits" flush action={conduct && !open && d.auditable && <button className="btn sm" onClick={() => setBooking(true)}>Book audit</button>}>
          <dl className="summary flat">
            <div><dt>Last audit</dt><dd>{last ? <Score score={last.score} rating={last.rating} /> : "—"}{last && <span className="cell-sub">{date(last.completed_at)}</span>}</dd></div>
            <div><dt>Trend</dt><dd>{(d.trend as Row[]).length > 1 ? (d.trend as Row[]).map((t) => `${t.score}`).join(" → ") : "—"}</dd></div>
            <div><dt>{open ? "Booked" : "Next due"}</dt><dd style={{ color: d.due_overdue ? "var(--bad)" : undefined }}>{open ? date(open.planned_for) : d.next_due ? date(d.next_due) : "—"}{d.due_overdue && <span className="cell-sub">Overdue</span>}</dd></div>
            <div><dt>Actions to fix</dt><dd style={{ color: (d.actions as Row[]).some((a) => a.overdue) ? "var(--bad)" : undefined }}>{(d.actions as Row[]).length}</dd></div>
          </dl>
          {act.notice && <div className="notice ok" style={{ margin: ".75rem 1rem 0" }}><Icon name="check" />{act.notice}</div>}
          {open && conduct && <div className="notice info" style={{ margin: ".75rem 1rem 0" }}><Icon name="clock" /><span>{open.audit_code} ({TYPE_TEXT[String(open.audit_type)]}) is {open.status === "IN_PROGRESS" ? "in progress" : `booked for ${date(open.planned_for)}`}. <Link to={`/audits/${open.ROWID}`}>{open.status === "IN_PROGRESS" ? "Continue it" : "Open it"}</Link></span></div>}
          {(d.actions as Row[]).length > 0 && <>
            <h3 className="sub-head">Corrective actions</h3>
            <ActionsTable actions={d.actions as Row[]} portal={portal} onChanged={load.reload} empty="" />
          </>}
          <h3 className="sub-head">Audits</h3>
          <DataTable rows={audits} href={href} empty={portal ? "No audits yet." : "No audits yet. Book the first one."} columns={[
            { key: "audit_code", label: "Audit", render: (a) => <><Link to={href(a)}>{a.audit_code}</Link><span className="cell-sub">{TYPE_TEXT[String(a.audit_type)] ?? a.audit_type}</span></> },
            { key: "planned_for", label: "Date", render: (a) => date(a.completed_at ?? a.planned_for) },
            { key: "status", label: "Status", render: (a) => <Pill value={STATUS_TEXT[String(a.status)]} tone={STATUS_TONE[String(a.status)]} /> },
            { key: "score", label: "Score", render: (a) => <Score score={a.score} rating={a.rating} /> },
            { key: "actions_open", label: "Open actions", align: "right", render: (a) => a.status === "COMPLETED" ? a.actions_open : "—" },
          ]} />
          {booking && <BookDialog busy={act.busy === "book"} error={act.error} onClose={() => { setBooking(false); act.clear(); }}
            onSave={(body) => act.run("book", () => api<Row>("POST", `/projects/${projectId}/audits`, { body }), (r) => `${r.audit_code} booked for ${date(r.planned_for)}.`).then((r) => r && setBooking(false))} />}
        </Panel>
      );
    }}</Loaded>
  );
}

function BookDialog({ busy, error, onSave, onClose }: { busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const people = useLoad(() => api<Row[]>("GET", "/audits/auditors"), []);
  const [v, setV] = useState({ audit_type: "ROUTINE", planned_for: today(), auditor_user_id: "", notes: "" });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((p) => ({ ...p, [k]: e.target.value }));
  return (
    <Dialog title="Book an audit" subtitle="The franchisee is told unless it's a surprise visit." onClose={onClose}>
      <Form onSubmit={() => onSave({ audit_type: v.audit_type, planned_for: v.planned_for, ...(v.auditor_user_id ? { auditor_user_id: v.auditor_user_id } : {}), ...(v.notes.trim() ? { notes: v.notes.trim() } : {}) })}
        footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !v.planned_for}>{busy ? "Booking…" : "Book audit"}</button></>}>
        <Field label="Type"><select value={v.audit_type} onChange={set("audit_type")}>{Object.entries(TYPE_TEXT).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Date"><input type="date" min={today()} value={v.planned_for} onChange={set("planned_for")} required /></Field>
        <Field label="Auditor" span><select value={v.auditor_user_id} onChange={set("auditor_user_id")}><option value="">Me</option>{(people.data ?? []).map((p) => <option key={String(p.ROWID)} value={String(p.ROWID)}>{p.name}</option>)}</select></Field>
        <Field label="Notes (optional)" span><input value={v.notes} onChange={set("notes")} maxLength={1000} /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

/** One audit: the auditor's checklist while it runs, the result once it's done. */
export function AuditPage({ portal }: { portal?: boolean }) {
  const { id } = useParams();
  const nav = useNavigate();
  const load = useLoad(() => api<Row>("GET", `/audits/${id}`), [id]);
  const act = useAction(load.reload);
  const [completing, setCompleting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const conduct = !portal && can("audit.conduct");
  const change = (body: Row, msg: string) => act.run(String(body.action), () => api<Row>("PATCH", `/audits/${id}`, { body }), msg);
  return (
    <Loaded load={load}>{(a) => {
      const items = a.items as Row[], pr = a.progress as Row;
      const live = a.status === "IN_PROGRESS" && conduct;
      const sections = [...new Set(items.map((i) => String(i.section)))];
      const judged = items.length - Number(pr.unanswered);
      return (
        <>
          <PageHeader title={`${a.audit_code} · ${a.project_code ?? ""}`} badges={<><Pill value={STATUS_TEXT[String(a.status)]} tone={STATUS_TONE[String(a.status)]} />{a.status === "COMPLETED" && <Pill value={a.rating} tone={RATING_TONE[String(a.rating)]} />}</>}
            crumbs={portal ? [["My franchise"], ["Audits", "/portal/audits"], [String(a.audit_code)]] : [["Operations"], ["Audits", "/audits"], [String(a.project_code ?? ""), `/projects/${a.project_id}`], [String(a.audit_code)]]}
            subtitle={`${TYPE_TEXT[String(a.audit_type)] ?? a.audit_type} audit${a.auditor ? ` by ${a.auditor.name}` : ""} · ${a.status === "COMPLETED" ? `completed ${date(a.completed_at)}` : `planned for ${date(a.planned_for)}`}`}
            actions={conduct && <>
              {a.status === "SCHEDULED" && <button className="btn" disabled={!!act.busy} onClick={() => change({ action: "start" }, "Audit started. Judge each standard as you go; every answer is saved.")}>{act.busy === "start" ? "Starting…" : "Start audit"}</button>}
              {(a.status === "SCHEDULED" || a.status === "IN_PROGRESS") && <button className="btn secondary" onClick={() => setCancelling(true)}>Cancel audit</button>}
            </>} />
          {act.notice && <div className="notice ok"><Icon name="check" />{act.notice}</div>}
          {act.error && !completing && !cancelling && <FormError error={act.error} />}
          {a.status === "SCHEDULED" && <div className="notice info"><Icon name="clock" />{conduct ? "Start the audit when you're at the store." : "This audit hasn't started."}</div>}
          {a.status !== "SCHEDULED" && <>
            <dl className="summary">
              <div><dt>{a.status === "COMPLETED" ? "Score" : "Score so far"}</dt><dd><Score score={pr.score} rating={pr.rating} /></dd></div>
              <div><dt>Judged</dt><dd>{judged} of {items.length}</dd></div>
              <div><dt>Failed</dt><dd style={{ color: pr.failed ? "var(--warn)" : undefined }}>{pr.failed}{pr.critical_fails > 0 && <span className="cell-sub" style={{ color: "var(--bad)" }}>{pr.critical_fails} critical</span>}</dd></div>
              <div><dt>Pass mark</dt><dd>{a.pass_score}%<span className="cell-sub">no critical fails</span></dd></div>
            </dl>
            {a.summary && <div className="notice info"><Icon name="history" /><span>{a.summary}</span></div>}
            {sections.map((sec) => (
              <Panel key={sec} title={sec} flush>
                <ul className="audit-list">
                  {items.filter((i) => i.section === sec).map((i) => <AuditItem key={String(i.ROWID)} auditId={String(id)} item={i} live={live} onSaved={load.reload} />)}
                </ul>
              </Panel>
            ))}
            {(a.actions as Row[]).length > 0 && <Panel title="Corrective actions" flush><ActionsTable actions={a.actions as Row[]} portal={portal} onChanged={load.reload} empty="" /></Panel>}
            {live && <div className="audit-bar"><span>{judged} of {items.length} judged{pr.score != null ? ` · ${pr.score}%` : ""}</span><button className="btn" disabled={judged < items.length} onClick={() => setCompleting(true)}>Complete audit</button></div>}
          </>}
          {completing && <CompleteDialog progress={pr} busy={act.busy === "complete"} error={act.error} onClose={() => { setCompleting(false); act.clear(); }}
            onSave={(summary) => act.run("complete", () => api<Row>("PATCH", `/audits/${id}`, { body: { action: "complete", ...(summary ? { summary } : {}) } }),
              (r) => `Completed: ${r.audit.score}%. ${r.actions.length ? `${r.actions.length} corrective action${r.actions.length === 1 ? "" : "s"} sent to the franchisee.` : "Nothing to fix."}${r.follow_up ? ` Follow-up ${r.follow_up.audit_code} booked for ${date(r.follow_up.planned_for)}.` : ""}`).then((r) => r && setCompleting(false))} />}
          {cancelling && <CancelDialog busy={act.busy === "cancel"} error={act.error} onClose={() => { setCancelling(false); act.clear(); }}
            onSave={(reason) => act.run("cancel", () => api<Row>("PATCH", `/audits/${id}`, { body: { action: "cancel", reason } }), "Audit cancelled.").then((r) => { if (r) { setCancelling(false); nav(`/projects/${a.project_id}`); } })} />}
        </>
      );
    }}</Loaded>
  );
}

/** One standard: Pass, Fail or N/A, a note and a photo; each change is saved straight away. */
function AuditItem({ auditId, item, live, onSaved }: { auditId: string; item: Row; live: boolean; onSaved: () => void }) {
  const [comments, setComments] = useState(String(item.comments ?? ""));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async (patch: Row) => {
    setBusy(true); setErr(null);
    try { await api("PATCH", `/audits/${auditId}`, { body: { action: "save", items: [{ code: item.code, verdict: item.verdict ?? null, comments: comments.trim() || null, ...patch }] } }); onSaved(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const verdict = (r: string) => <button type="button" className={`verdict ${r.toLowerCase()} ${item.verdict === r ? "on" : ""}`} disabled={!live || busy} aria-pressed={item.verdict === r} onClick={() => save({ verdict: item.verdict === r ? null : r })}>{r === "NA" ? "N/A" : r === "PASS" ? "Pass" : "Fail"}</button>;
  return (
    <li className={item.verdict === "FAIL" ? "failed" : ""}>
      <div className="audit-q">
        <span>{item.standard}{(item.critical === true || item.critical === "true") && <span className="badge bad" style={{ marginLeft: ".4rem" }}><i />Critical</span>}</span>
        {(live || item.comments) && item.verdict === "FAIL" && (live
          ? <input placeholder="What was wrong?" aria-label={`What was wrong: ${item.standard}`} value={comments} onChange={(e) => setComments(e.target.value)} onBlur={() => comments.trim() !== String(item.comments ?? "") && save({})} maxLength={1000} />
          : <span className="cell-sub" style={{ color: "var(--warn)" }}>{item.comments}</span>)}
        {!live && item.verdict !== "FAIL" && item.comments && <span className="cell-sub">{item.comments}</span>}
        {err && <span className="cell-sub" style={{ color: "var(--bad)" }}>{err}</span>}
      </div>
      <div className="audit-a">
        {live ? <>{verdict("PASS")}{verdict("FAIL")}{verdict("NA")}
          <label className="btn ghost sm" title="Add a photo"><input type="file" accept="image/*" capture="environment" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) await save({ photo: await upload(f) }); }} />{item.evidence_ref ? "Photo ✓" : "Photo"}</label></>
          : <>{item.verdict ? <Pill value={item.verdict === "NA" ? "N/A" : item.verdict === "PASS" ? "Pass" : "Fail"} tone={item.verdict === "PASS" ? "good" : item.verdict === "FAIL" ? "bad" : "neutral"} /> : <span className="muted">—</span>}
            {item.evidence_ref && <button className="btn ghost sm" onClick={() => openUrl(`/audits/${auditId}/items/${item.code}/photo`)}>Photo</button>}</>}
      </div>
    </li>
  );
}

function CompleteDialog({ progress, busy, error, onSave, onClose }: { progress: Row; busy: boolean; error: ApiError | null; onSave: (summary: string) => void; onClose: () => void }) {
  const [summary, setSummary] = useState("");
  return (
    <Dialog title="Complete the audit" subtitle={<>Score {progress.score}% ({String(progress.rating).toLowerCase()}). {progress.failed ? `${progress.failed} failed standard${progress.failed === 1 ? "" : "s"} become corrective actions for the franchisee.` : "Nothing failed."}{progress.rating === "RED" ? " A follow-up audit is booked." : ""}</>} onClose={onClose}>
      <Form onSubmit={() => onSave(summary.trim())} footer={<><button type="button" className="btn secondary" onClick={onClose}>Back</button><button className="btn" disabled={busy}>{busy ? "Completing…" : "Complete audit"}</button></>}>
        <Field label="Summary for the franchisee (optional)" span><textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={2000} autoFocus /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

function CancelDialog({ busy, error, onSave, onClose }: { busy: boolean; error: ApiError | null; onSave: (reason: string) => void; onClose: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <Dialog title="Cancel this audit?" subtitle="Results recorded so far are kept but won't count." onClose={onClose}>
      <Form onSubmit={() => onSave(reason.trim())} footer={<><button type="button" className="btn secondary" onClick={onClose}>Keep it</button><button className="btn danger" disabled={busy || reason.trim().length < 3}>{busy ? "Cancelling…" : "Cancel audit"}</button></>}>
        <Field label="Reason" span><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required autoFocus /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

/** Portal: the franchisee's audits and what to fix. */
export function PortalAudits() {
  const home = useLoad(() => api<Row>("GET", "/portal/home"), []);
  return (
    <>
      <PageHeader title="Audits" subtitle="How your store scored against the brand standards, and what to fix." />
      <Loaded load={home}>{(h) => h.project && ["READY_FOR_OPENING", "OPENED", "CLOSED"].includes(String(h.project.status)) ? <AuditPanel projectId={String(h.project.ROWID)} portal />
        : <div className="state">Audits start once your store is ready to open.</div>}</Loaded>
    </>
  );
}

/** Staff: every auditable store, its last score and next due date, and the standards failed most. */
export function Audits() {
  const load = useLoad(() => api<Row>("GET", "/audits"), []);
  return (
    <>
      <PageHeader title="Audits" crumbs={[["Operations"], ["Audits"]]} subtitle="Brand-standard audits of opened stores and the corrective actions they raised." />
      <Loaded load={load}>{(d) => {
        const t = d.totals as Row;
        return (
          <>
            <dl className="summary">
              <div><dt>Average score</dt><dd>{t.average != null ? `${t.average}%` : "—"}<span className="cell-sub">{t.audited} of {t.stores} stores audited</span></dd></div>
              <div><dt>Red stores</dt><dd style={{ color: t.red ? "var(--bad)" : undefined }}>{t.red}</dd></div>
              <div><dt>Due an audit</dt><dd style={{ color: t.due ? "var(--warn)" : undefined }}>{t.due}</dd></div>
              <div><dt>Open actions</dt><dd>{t.actions_open}{t.actions_overdue > 0 && <span className="cell-sub" style={{ color: "var(--bad)" }}>{t.actions_overdue} overdue</span>}</dd></div>
            </dl>
            <Panel flush>
              <DataTable rows={d.stores as Row[]} href={(r) => `/projects/${r.project_id}`} searchKeys={["project_code", "franchisee"]} empty="No stores to audit yet." columns={[
                { key: "project_code", label: "Store", render: (r) => <><Link to={`/projects/${r.project_id}`}>{String(r.project_code)}</Link><span className="cell-sub">{String(r.franchisee ?? "")}</span></> },
                { key: "last_score", label: "Last audit", sort: (r) => Number(r.last_score ?? -1), render: (r) => r.last_score != null ? <><Score score={r.last_score} rating={r.last_rating} /><span className="cell-sub">{date(r.last_date)}{r.previous_score != null ? ` · was ${r.previous_score}%` : ""}</span></> : <span className="muted">Never audited</span> },
                { key: "next_due", label: "Next audit", render: (r) => r.booked ? <>{date(r.booked.planned_for)}<span className="cell-sub">{r.booked.audit_code} {r.booked.status === "IN_PROGRESS" ? "in progress" : "booked"}</span></> : r.next_due ? <span style={{ color: r.due_overdue ? "var(--bad)" : undefined }}>{r.due_overdue ? "Overdue since " : "Due "}{date(r.next_due)}</span> : <span className="muted">After opening</span> },
                { key: "actions_open", label: "Open actions", align: "right", render: (r) => <>{r.actions_open}{r.actions_overdue > 0 && <span className="cell-sub" style={{ color: "var(--bad)" }}>{r.actions_overdue} overdue</span>}</> },
              ]} />
            </Panel>
            {(d.most_failed as Row[]).length > 0 && <Panel title="Standards failed most" flush>
              <ul className="module-list">{(d.most_failed as Row[]).map((f) => <li key={String(f.code)}><span>{f.text}<span className="cell-sub">{f.section}</span></span><span>{f.stores} store{f.stores === 1 ? "" : "s"}</span></li>)}</ul>
            </Panel>}
          </>
        );
      }}</Loaded>
    </>
  );
}

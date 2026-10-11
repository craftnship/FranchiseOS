import { useEffect, useState } from "react";
import { api, ApiError, Row } from "../api";
import { useAction, useLoad } from "../hooks";
import { Dialog, Field, Form, FormError } from "./forms";
import { DataTable, date, Icon, label, Loaded, PageHeader, Panel, Pill } from "./ui";

const DESIGN_TONE: Record<string, string> = { SUBMITTED: "info", APPROVED: "good", CHANGES_REQUESTED: "warn" };
const DESIGN_TEXT: Record<string, string> = { SUBMITTED: "Waiting for review", APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested" };
const SNAG_TONE: Record<string, string> = { OPEN: "bad", FIXED: "info", CLOSED: "good", WAIVED: "neutral" };
const SNAG_TEXT: Record<string, string> = { OPEN: "Open", FIXED: "Fixed, to verify", CLOSED: "Closed", WAIVED: "Waived" };
const SEV_TONE: Record<string, string> = { MINOR: "neutral", MAJOR: "warn", CRITICAL: "bad" };
const AREAS = ["Front", "Dining", "Kitchen", "Counter", "Storage", "Washroom", "Signage", "Exterior", "Other"];
const IMAGES = "image/jpeg,image/png,image/webp";
const DRAWINGS = "application/pdf,image/jpeg,image/png,image/webp";

const toBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",", 2)[1] ?? "");
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});
export const upload = async (file: File) => ({ file_name: file.name, content_type: file.type || "application/octet-stream", data_base64: await toBase64(file) });
const when = (v: unknown) => (v ? new Date(String(v).replace(" ", "T") + (String(v).includes("T") ? "" : "Z")).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const distance = (m: unknown) => (m === null || m === undefined ? null : Number(m) < 1000 ? `${Number(m)} m from the site` : `${(Number(m) / 1000).toFixed(1)} km from the site`);
const open = async (path: string, query?: Record<string, string>) => { const r = await api<{ url: string }>("GET", path, { query }); window.open(r.url, "_blank", "noopener"); };

/** Where the device is, if the person allows it; never blocks the upload. */
function locate(): Promise<{ latitude: number; longitude: number; accuracy_m: number } | null> {
  if (!("geolocation" in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => navigator.geolocation.getCurrentPosition(
    (p) => resolve({ latitude: +p.coords.latitude.toFixed(6), longitude: +p.coords.longitude.toFixed(6), accuracy_m: Math.round(p.coords.accuracy) }),
    () => resolve(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }));
}

/** A photo loads its short-lived link when it is shown. */
function Thumb({ path, alt }: { path: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { let live = true; api<{ url: string }>("GET", path).then((r) => live && setUrl(r.url)).catch(() => live && setFailed(true)); return () => { live = false; }; }, [path]);
  if (failed) return <span className="thumb empty"><Icon name="alert" size={16} /></span>;
  return url ? <a className="thumb" href={url} target="_blank" rel="noopener noreferrer"><img src={url} alt={alt} loading="lazy" /></a> : <span className="thumb empty" />;
}

/**
 * Design approval, site photos and snags for one opening project. `editable` is staff with
 * project.write; `portal` is the franchisee.
 */
export function ConstructionPanel({ projectId, editable, portal, closed }: { projectId: string; editable: boolean; portal?: boolean; closed?: boolean }) {
  const load = useLoad(() => api<Row>("GET", `/projects/${projectId}/construction`), [projectId]);
  const act = useAction(load.reload);
  const [dialog, setDialog] = useState<null | { kind: "design" } | { kind: "decide"; design: Row; decision: "APPROVED" | "CHANGES_REQUESTED" } | { kind: "photo" } | { kind: "snag" } | { kind: "fix"; snag: Row } | { kind: "note"; snag: Row; action: "reopen" | "waive" }>(null);
  const [showAll, setShowAll] = useState(false);
  const base = `/projects/${projectId}`;
  const canAdd = !closed && (editable || !!portal);
  const close = () => { setDialog(null); act.clear(); };
  const done = (r: unknown) => { if (r) setDialog(null); };

  return (
    <Loaded load={load}>{(c) => {
      const d = c.design as Row, cur = d.current as Row | null, approved = d.approved as Row | null;
      const photos = c.photos as Row[], snags = c.snags as Row[], n = c.snag_counts as Row;
      const shown = showAll ? photos : photos.slice(0, 8);
      const snagAct = (s: Row, body: Row, msg: string) => act.run(`s${s.ROWID}`, () => api<Row>("PATCH", `${base}/snags/${s.ROWID}`, { body }), msg);
      return (
        <>
          {act.notice && <div className="notice ok"><Icon name="check" />{act.notice}</div>}
          {act.error && !dialog && <FormError error={act.error} />}

          <Panel title="Store design" action={canAdd && (!cur || cur.status !== "SUBMITTED") && <button className="btn sm" onClick={() => setDialog({ kind: "design" })}>{cur ? "Send a new version" : "Send design for approval"}</button>}>
            {!cur ? <p className="muted" style={{ margin: 0 }}>{portal ? "Send your store layout and elevation drawings for brand approval. Fit-out starts once they're approved." : "No design sent yet. Fit-out can't be marked done until a design is approved."}</p> : (
              <div className="design-row">
                <div>
                  <strong>v{cur.version} · {cur.title}</strong> <Pill value={DESIGN_TEXT[String(cur.status)]} tone={DESIGN_TONE[String(cur.status)]} />
                  <span className="cell-sub">Sent {when(cur.submitted_at)}{cur.reviewed_at ? `, decided ${when(cur.reviewed_at)}` : ""}</span>
                  {cur.notes && <p className="muted" style={{ margin: ".35rem 0 0" }}>{String(cur.notes)}</p>}
                  {cur.review_note && <div className={`notice ${cur.status === "APPROVED" ? "ok" : "warn"}`} style={{ marginTop: ".5rem" }}><Icon name={cur.status === "APPROVED" ? "check" : "alert"} /><span>{String(cur.review_note)}</span></div>}
                  {approved && approved.ROWID !== cur.ROWID && <span className="cell-sub">Approved version in force: v{approved.version}</span>}
                </div>
                <span className="panel-actions">
                  <button className="btn ghost sm" disabled={!!act.busy} onClick={() => act.run("df", () => open(`${base}/designs/${cur.ROWID}/file`))}>Drawings</button>
                  {editable && cur.status === "SUBMITTED" && <>
                    <button className="btn sm" onClick={() => setDialog({ kind: "decide", design: cur, decision: "APPROVED" })}><Icon name="check" size={14} />Approve</button>
                    <button className="btn danger-ghost sm" onClick={() => setDialog({ kind: "decide", design: cur, decision: "CHANGES_REQUESTED" })}>Request changes</button>
                  </>}
                </span>
              </div>
            )}
            {(d.history as Row[]).length > 1 && (
              <details className="history"><summary className="muted">Earlier versions</summary>
                <ul>{(d.history as Row[]).slice(1).map((h) => <li key={String(h.ROWID)}>v{h.version} · {h.title} · {DESIGN_TEXT[String(h.status)]}{h.review_note ? `: ${h.review_note}` : ""} <button className="btn ghost sm" onClick={() => act.run("df", () => open(`${base}/designs/${h.ROWID}/file`))}>Drawings</button></li>)}</ul>
              </details>
            )}
          </Panel>

          <Panel title="Site photos" action={<span className="panel-actions"><span className="muted">{photos.length} photo{photos.length === 1 ? "" : "s"}</span>{canAdd && <button className="btn sm" onClick={() => setDialog({ kind: "photo" })}>Add photo</button>}</span>}>
            {!photos.length ? <p className="muted" style={{ margin: 0 }}>{canAdd ? "Add progress photos as work moves. Each one keeps the time it was taken and, if you allow it, where." : "No photos yet."}</p> : (
              <>
                <div className="photo-grid">
                  {shown.map((p) => (
                    <figure key={String(p.ROWID)}>
                      <Thumb path={`${base}/photos/${p.ROWID}/file`} alt={String(p.caption ?? p.area ?? "Site photo")} />
                      <figcaption>
                        <strong>{p.caption || p.area || "Site photo"}</strong>
                        <span>{when(p.taken_at)}{p.area && p.caption ? ` · ${p.area}` : ""} · {p.source === "PORTAL" ? "Franchisee" : "Staff"}</span>
                        {p.latitude === null || p.latitude === undefined ? <span className="muted">No location</span>
                          : <a href={`https://www.google.com/maps?q=${p.latitude},${p.longitude}`} target="_blank" rel="noopener noreferrer" style={{ color: Number(p.distance_m) > 500 ? "var(--warn)" : undefined }}>
                            {Number(p.distance_m) > 500 && "⚠ "}{distance(p.distance_m) ?? `${Number(p.latitude).toFixed(4)}, ${Number(p.longitude).toFixed(4)}`}</a>}
                      </figcaption>
                    </figure>
                  ))}
                </div>
                {photos.length > 8 && <button className="btn ghost sm" style={{ marginTop: ".75rem" }} onClick={() => setShowAll(!showAll)}>{showAll ? "Show fewer" : `Show all ${photos.length}`}</button>}
              </>
            )}
          </Panel>

          <Panel title="Snag list" flush action={<span className="panel-actions"><span className="muted">{n.open} open, {n.fixed} to verify</span>{editable && !closed && <button className="btn sm" onClick={() => setDialog({ kind: "snag" })}>Raise snag</button>}</span>}>
            {Number(n.blocking) > 0 && <div className="notice warn" style={{ margin: ".75rem 1rem 0" }}><Icon name="alert" /><span>{n.blocking} major or critical snag{Number(n.blocking) === 1 ? "" : "s"} must be fixed and verified, or waived, before the store can open.</span></div>}
            <DataTable rows={snags} empty="No snags raised." columns={[
              { key: "snag_no", label: "#", width: "3rem", render: (s) => <span className="code">{s.snag_no}</span> },
              { key: "title", label: "Snag", render: (s) => <span style={{ display: "block", minWidth: "12rem", color: s.status === "CLOSED" || s.status === "WAIVED" ? "var(--muted)" : undefined }}>{s.title}<span className="cell-sub">{[s.area, s.due_date && `due ${date(s.due_date)}`, s.fix_note && `Fix: ${s.fix_note}`, s.close_note && (s.status === "WAIVED" ? `Waived: ${s.close_note}` : `Note: ${s.close_note}`)].filter(Boolean).join(" · ")}</span></span> },
              { key: "severity", label: "Severity", render: (s) => <Pill value={label(s.severity)} tone={SEV_TONE[String(s.severity)]} /> },
              { key: "status", label: "Status", render: (s) => <Pill value={SNAG_TEXT[String(s.status)]} tone={SNAG_TONE[String(s.status)]} /> },
              { key: "actions", label: "", align: "right", render: (s) => {
                const busy = act.busy === `s${s.ROWID}`;
                const live = s.status === "OPEN" || s.status === "FIXED";
                return (
                  <span className="panel-actions">
                    {s.photo_ref && <button className="btn ghost sm" onClick={() => act.run("sp", () => open(`${base}/snags/${s.ROWID}/photo`))}>Photo</button>}
                    {s.fix_photo_ref && <button className="btn ghost sm" onClick={() => act.run("sp", () => open(`${base}/snags/${s.ROWID}/photo`, { which: "fix" }))}>Fix photo</button>}
                    {!closed && s.status === "OPEN" && (portal || editable) && <button className="btn sm" disabled={busy} onClick={() => setDialog({ kind: "fix", snag: s })}>Mark fixed</button>}
                    {editable && !closed && s.status === "FIXED" && <button className="btn sm" disabled={busy} onClick={() => snagAct(s, { action: "close" }, `Snag #${s.snag_no} closed.`)}><Icon name="check" size={14} />Verify</button>}
                    {editable && !closed && (s.status === "FIXED" || s.status === "CLOSED") && <button className="btn ghost sm" disabled={busy} onClick={() => setDialog({ kind: "note", snag: s, action: "reopen" })}>Reopen</button>}
                    {editable && !closed && live && <button className="btn ghost sm" disabled={busy} onClick={() => setDialog({ kind: "note", snag: s, action: "waive" })}>Waive</button>}
                  </span>
                );
              } },
            ]} />
          </Panel>

          {dialog?.kind === "design" && <DesignDialog busy={act.busy === "design"} error={act.error} onClose={close}
            onSave={(body) => act.run("design", () => api<Row>("POST", `${base}/designs`, { body }), (r) => `Design v${r.version} sent for approval.`).then(done)} />}
          {dialog?.kind === "decide" && <NoteDialog title={dialog.decision === "APPROVED" ? `Approve design v${dialog.design.version}?` : `Request changes to v${dialog.design.version}`}
            hint={dialog.decision === "APPROVED" ? "Fit-out can go ahead to these drawings. The design task is completed." : "The franchisee sees your note and sends a new version."}
            noteLabel={dialog.decision === "APPROVED" ? "Note (optional)" : "What needs to change"} required={dialog.decision !== "APPROVED"} confirm={dialog.decision === "APPROVED" ? "Approve" : "Request changes"}
            busy={act.busy === "decide"} error={act.error} onClose={close}
            onSave={(note) => act.run("decide", () => api<Row>("POST", `${base}/designs/${dialog.design.ROWID}/decision`, { body: { decision: dialog.decision, ...(note ? { note } : {}) } }),
              (r) => r.status === "APPROVED" ? `Design v${r.version} approved.${r.task_completed ? " The design task is done." : ""}` : "Changes requested.").then(done)} />}
          {dialog?.kind === "photo" && <PhotoDialog busy={act.busy === "photo"} error={act.error} onClose={close}
            onSave={(body) => act.run("photo", () => api<Row>("POST", `${base}/photos`, { body }), (r) => r.distance_m != null && Number(r.distance_m) > 500 ? `Photo added. It was taken ${distance(r.distance_m)}.` : "Photo added.").then(done)} />}
          {dialog?.kind === "snag" && <SnagDialog busy={act.busy === "snag"} error={act.error} onClose={close}
            onSave={(body) => act.run("snag", () => api<Row>("POST", `${base}/snags`, { body }), (r) => `Snag #${r.snag_no} raised.`).then(done)} />}
          {dialog?.kind === "fix" && <FixDialog snag={dialog.snag} busy={act.busy === `s${dialog.snag.ROWID}`} error={act.error} onClose={close}
            onSave={(body) => snagAct(dialog.snag, { action: "fix", ...body }, `Snag #${dialog.snag.snag_no} marked fixed.`).then(done)} />}
          {dialog?.kind === "note" && <NoteDialog title={`${dialog.action === "reopen" ? "Reopen" : "Waive"} snag #${dialog.snag.snag_no}`} hint={String(dialog.snag.title)}
            noteLabel={dialog.action === "reopen" ? "What's still wrong" : "Why it can be waived"} required confirm={dialog.action === "reopen" ? "Reopen" : "Waive"}
            busy={act.busy === `s${dialog.snag.ROWID}`} error={act.error} onClose={close}
            onSave={(note) => snagAct(dialog.snag, { action: dialog.action, note }, `Snag #${dialog.snag.snag_no} ${dialog.action === "reopen" ? "reopened" : "waived"}.`).then(done)} />}
        </>
      );
    }}</Loaded>
  );
}

function DesignDialog({ busy, error, onSave, onClose }: { busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  return (
    <Dialog title="Send store design" subtitle="Layout, elevation and signage drawings as one PDF, or an image." onClose={onClose}>
      <Form onSubmit={async () => file && onSave({ title: title.trim(), ...(notes.trim() ? { notes: notes.trim() } : {}), file: await upload(file) })}
        footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !file || title.trim().length < 2}>{busy ? "Sending…" : "Send for approval"}</button></>}>
        <Field label="Title" span><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Layout and elevation" required autoFocus /></Field>
        <Field label="Drawings" hint="PDF, JPG or PNG, up to 5 MB." span><input type="file" accept={DRAWINGS} onChange={(e) => setFile(e.target.files?.[0] ?? null)} required /></Field>
        <Field label="Notes" span><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

function PhotoDialog({ busy, error, onSave, onClose }: { busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState("");
  const [area, setArea] = useState("Front");
  const [where, setWhere] = useState(true);
  const [locating, setLocating] = useState(false);
  const submit = async () => {
    if (!file) return;
    setLocating(where);
    const pos = where ? await locate() : null;
    setLocating(false);
    // A camera photo's file time is when it was taken; an old file keeps its own time.
    onSave({ file: await upload(file), area, ...(caption.trim() ? { caption: caption.trim() } : {}), taken_at: new Date(file.lastModified || Date.now()).toISOString(), ...(pos ?? {}) });
  };
  return (
    <Dialog title="Add site photo" subtitle="On a phone, this opens the camera." onClose={onClose}>
      <Form onSubmit={submit} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || locating || !file}>{locating ? "Getting location…" : busy ? "Uploading…" : "Add photo"}</button></>}>
        <Field label="Photo" hint="JPG, PNG or WebP, up to 5 MB." span><input type="file" accept={IMAGES} capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required autoFocus /></Field>
        <Field label="Area"><select value={area} onChange={(e) => setArea(e.target.value)}>{AREAS.map((a) => <option key={a}>{a}</option>)}</select></Field>
        <Field label="Caption"><input value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={300} placeholder="Ceiling grid done" /></Field>
        <label className="check span"><input type="checkbox" checked={where} onChange={(e) => setWhere(e.target.checked)} /> Add my current location</label>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

function SnagDialog({ busy, error, onSave, onClose }: { busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const [v, setV] = useState({ title: "", area: "Kitchen", severity: "MINOR", due_date: "" });
  const [file, setFile] = useState<File | null>(null);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((p) => ({ ...p, [k]: e.target.value }));
  return (
    <Dialog title="Raise snag" subtitle="Major and critical snags stop the store opening until they're cleared." onClose={onClose}>
      <Form onSubmit={async () => onSave({ title: v.title.trim(), area: v.area, severity: v.severity, ...(v.due_date ? { due_date: v.due_date } : {}), ...(file ? { photo: await upload(file) } : {}) })}
        footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || v.title.trim().length < 3}>{busy ? "Saving…" : "Raise snag"}</button></>}>
        <Field label="What's wrong" span><input value={v.title} onChange={set("title")} maxLength={300} required autoFocus /></Field>
        <Field label="Area"><select value={v.area} onChange={set("area")}>{AREAS.map((a) => <option key={a}>{a}</option>)}</select></Field>
        <Field label="Severity"><select value={v.severity} onChange={set("severity")}><option value="MINOR">Minor</option><option value="MAJOR">Major</option><option value="CRITICAL">Critical</option></select></Field>
        <Field label="Fix by (optional)"><input type="date" value={v.due_date} onChange={set("due_date")} /></Field>
        <Field label="Photo (optional)"><input type="file" accept={IMAGES} capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

function FixDialog({ snag, busy, error, onSave, onClose }: { snag: Row; busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  return (
    <Dialog title={`Mark snag #${snag.snag_no} fixed`} subtitle={String(snag.title)} onClose={onClose}>
      <Form onSubmit={async () => onSave({ ...(note.trim() ? { note: note.trim() } : {}), ...(file ? { photo: await upload(file) } : {}) })}
        footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy}>{busy ? "Saving…" : "Mark fixed"}</button></>}>
        <Field label="What was done" span><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} autoFocus /></Field>
        <Field label="Photo of the fix" hint="Helps the team verify it without a visit." span><input type="file" accept={IMAGES} capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

function NoteDialog({ title, hint, noteLabel, required, confirm, busy, error, onSave, onClose }: { title: string; hint: string; noteLabel: string; required?: boolean; confirm: string; busy: boolean; error: ApiError | null; onSave: (note: string) => void; onClose: () => void }) {
  const [note, setNote] = useState("");
  return (
    <Dialog title={title} subtitle={hint} onClose={onClose}>
      <Form onSubmit={() => onSave(note.trim())} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || (!!required && note.trim().length < 3)}>{busy ? "Saving…" : confirm}</button></>}>
        <Field label={noteLabel} span><textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} required={required} autoFocus /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

/** Portal: the franchisee's design, photos and snags. */
export function PortalConstruction() {
  const home = useLoad(() => api<Row>("GET", "/portal/home"), []);
  return (
    <>
      <PageHeader title="Construction" subtitle="Your store design, site photos and the snags to fix before opening." />
      <Loaded load={home}>{(h) => h.project ? <ConstructionPanel projectId={String(h.project.ROWID)} editable={false} portal closed={h.project.status === "CLOSED"} />
        : <div className="state">Construction starts once your agreement is signed.</div>}</Loaded>
    </>
  );
}

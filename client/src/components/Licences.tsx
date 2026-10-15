import { useRef, useState } from "react";
import { api, ApiError, Row } from "../api";
import { useAction } from "../hooks";
import { Dialog, Field, Form, FormError } from "./forms";
import { DataTable, date, Icon, label, Panel, Pill } from "./ui";

const STATES = ["NOT_STARTED", "APPLIED", "ISSUED", "REJECTED", "EXPIRED"];
const ACCEPT = "application/pdf,image/jpeg,image/png,image/webp";
const TONE: Record<string, string> = { ISSUED: "good", APPLIED: "info", NOT_STARTED: "neutral", REJECTED: "bad", EXPIRED: "bad" };
const isTrue = (v: unknown) => v === true || String(v) === "true";

const toBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",", 2)[1] ?? "");
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

/** Mandatory licences not issued, or not valid on `day`: what stops the store opening. */
export function missingLicences(licences: Row[], day: string): Row[] {
  return licences.filter((l) => isTrue(l.mandatory) && (l.status !== "ISSUED" || (l.expires_on && String(l.expires_on).slice(0, 10) <= day)));
}

/**
 * The store's licence register. Staff edit status, numbers and dates; everyone on the project,
 * the franchisee included, can upload a certificate.
 */
export function LicencePanel({ projectId, licences, editable, onChanged }: { projectId: string; licences: Row[]; editable: boolean; onChanged: () => void }) {
  const act = useAction(onChanged);
  const [editing, setEditing] = useState<Row | null>(null);
  const [adding, setAdding] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<Row | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const issued = licences.filter((l) => l.status === "ISSUED").length;
  const missing = missingLicences(licences, today);
  const base = `/projects/${projectId}/licences`;

  const pick = (l: Row) => { setTarget(l); file.current?.click(); };
  const upload = async (f: File | undefined) => {
    if (!f || !target) return;
    const l = target;
    if (file.current) file.current.value = "";
    await act.run(`u${l.ROWID}`, async () => api<Row>("POST", `${base}/${l.ROWID}/certificate`, { body: { file_name: f.name, content_type: f.type, data_base64: await toBase64(f) } }), `${l.name}: certificate uploaded.`);
  };
  const view = (l: Row) => act.run(`v${l.ROWID}`, async () => { const r = await api<{ url: string }>("GET", `${base}/${l.ROWID}/certificate`); window.open(r.url, "_blank", "noopener"); });
  const save = (l: Row, body: Row) => act.run("save", () => api<Row>("PATCH", `${base}/${l.ROWID}`, { body }), `${l.name} saved.`).then((r) => r && setEditing(null));
  const add = (body: Row) => act.run("add", () => api<Row>("POST", base, { body }), `${body.name} added.`).then((r) => r && setAdding(false));

  return (
    <Panel title="Licences" action={<span className="panel-actions"><span className="muted">{issued} of {licences.length} issued</span>{editable && <button className="btn ghost sm" onClick={() => setAdding(true)}>Add licence</button>}</span>} flush>
      {missing.length > 0 && <div className="notice warn" style={{ margin: ".75rem 1rem 0" }}><Icon name="alert" /><span>The store can't open until {missing.length === 1 ? "this licence is" : `these ${missing.length} licences are`} issued: {missing.map((l) => l.name).join(", ")}.</span></div>}
      {act.notice && <div className="notice ok" style={{ margin: ".75rem 1rem 0" }}><Icon name="check" />{act.notice}</div>}
      {act.error && !editing && !adding && <div style={{ margin: ".75rem 1rem 0" }}><FormError error={act.error} /></div>}
      <input ref={file} type="file" accept={ACCEPT} hidden onChange={(e) => upload(e.target.files?.[0])} />
      <DataTable rows={licences} empty="No licences yet." columns={[
        { key: "name", label: "Licence", render: (l) => <>{l.name}<span className="cell-sub">{isTrue(l.mandatory) ? "Mandatory" : "Optional"}{l.authority ? ` · ${l.authority}` : ""}</span></> },
        { key: "status", label: "Status", render: (l) => <Pill value={l.status} tone={TONE[String(l.status)]} /> },
        { key: "licence_number", label: "Number", render: (l) => l.licence_number ? <span className="code">{l.licence_number}</span> : <span className="muted">—</span> },
        { key: "issued_on", label: "Issued", render: (l) => date(l.issued_on) },
        { key: "expires_on", label: "Expires", sort: (l) => String(l.expires_on ?? "9999"), render: (l) => {
          if (!l.expires_on) return <span className="muted">{l.status === "ISSUED" ? "No expiry" : "—"}</span>;
          const soon = l.status === "ISSUED" && (Date.parse(String(l.expires_on).slice(0, 10)) - Date.parse(today)) / 86400000 <= 45;
          return <span style={{ color: soon || l.status === "EXPIRED" ? "var(--bad)" : undefined }}>{date(l.expires_on)}</span>;
        } },
        { key: "actions", label: "", align: "right", render: (l) => (
          <span className="panel-actions">
            {l.file_ref && <button className="btn ghost sm" disabled={!!act.busy} onClick={() => view(l)}>Certificate</button>}
            <button className="btn ghost sm" disabled={!!act.busy} onClick={() => pick(l)}>{act.busy === `u${l.ROWID}` ? "Uploading…" : l.file_ref ? "Replace" : "Upload"}</button>
            {editable && <button className="btn sm" disabled={!!act.busy} onClick={() => setEditing(l)}>Update</button>}
          </span>
        ) },
      ]} />
      {editing && <LicenceDialog licence={editing} busy={act.busy === "save"} error={act.error} onSave={(b) => save(editing, b)} onClose={() => { setEditing(null); act.clear(); }} />}
      {adding && <AddLicenceDialog busy={act.busy === "add"} error={act.error} onSave={add} onClose={() => { setAdding(false); act.clear(); }} />}
    </Panel>
  );
}

function LicenceDialog({ licence, busy, error, onSave, onClose }: { licence: Row; busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const init = { status: String(licence.status), licence_number: String(licence.licence_number ?? ""), applied_on: String(licence.applied_on ?? "").slice(0, 10), issued_on: String(licence.issued_on ?? "").slice(0, 10), expires_on: String(licence.expires_on ?? "").slice(0, 10), notes: String(licence.notes ?? "") };
  const [v, setV] = useState(init);
  const set = (k: keyof typeof init) => (e: { target: { value: string } }) => setV((p) => ({ ...p, [k]: e.target.value }));
  const today = new Date().toISOString().slice(0, 10);
  const submit = () => {
    const body: Row = {};
    for (const k of Object.keys(init) as (keyof typeof init)[]) if (v[k] !== init[k]) body[k] = k === "status" ? v[k] : v[k].trim() || null;
    if (Object.keys(body).length) onSave(body); else onClose();
  };
  return (
    <Dialog title={String(licence.name)} subtitle={licence.authority ? String(licence.authority) : undefined} onClose={onClose}>
      <Form onSubmit={submit} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy}>{busy ? "Saving…" : "Save"}</button></>}>
        <Field label="Status"><select value={v.status} onChange={set("status")}>{STATES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
        <Field label="Licence number"><input value={v.licence_number} onChange={set("licence_number")} maxLength={100} /></Field>
        <Field label="Applied on"><input type="date" value={v.applied_on} max={today} onChange={set("applied_on")} /></Field>
        <Field label="Issued on"><input type="date" value={v.issued_on} max={today} onChange={set("issued_on")} required={v.status === "ISSUED"} /></Field>
        <Field label="Expires on" hint="Leave empty if it doesn't expire. Reminders start before this date." span><input type="date" value={v.expires_on} onChange={set("expires_on")} /></Field>
        <Field label="Notes" span><textarea rows={2} value={v.notes} onChange={set("notes")} maxLength={2000} placeholder={v.status === "REJECTED" ? "Why it was rejected, and what to fix" : undefined} /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

function AddLicenceDialog({ busy, error, onSave, onClose }: { busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [authority, setAuthority] = useState("");
  const [mandatory, setMandatory] = useState(false);
  return (
    <Dialog title="Add licence" subtitle="For a permit this store needs beyond the standard list." onClose={onClose}>
      <Form onSubmit={() => onSave({ name: name.trim(), ...(authority.trim() ? { authority: authority.trim() } : {}), mandatory })} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || name.trim().length < 2}>{busy ? "Adding…" : "Add licence"}</button></>}>
        <Field label="Licence" span><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} placeholder="e.g. Health trade licence" autoFocus /></Field>
        <Field label="Issuing authority" span><input value={authority} onChange={(e) => setAuthority(e.target.value)} maxLength={200} /></Field>
        <label className="span check"><input type="checkbox" checked={mandatory} onChange={(e) => setMandatory(e.target.checked)} /> Mandatory: the store can't open without it</label>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, Row } from "../api";
import { useAction } from "../hooks";
import { ConfirmDialog, Dialog, Field, Form, FormError } from "./forms";
import { date, Facts, Icon, inr, Panel, Pill } from "./ui";

const ACCEPT = "application/pdf,image/jpeg,image/png,image/webp";
const TONE: Record<string, string> = { DRAFT: "warn", SIGNED: "good", TERMINATED: "neutral" };

const toBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",", 2)[1] ?? "");
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

const months = (n: unknown) => { const m = Number(n); return !m ? null : m % 12 === 0 ? `${m / 12} year${m === 12 ? "" : "s"}` : `${m} months`; };

/** Rent running before the store opens: the expensive case, shown wherever the lease appears. */
export function GapNotice({ lease }: { lease: Row }) {
  const g = lease.opening_gap as Row | null;
  if (!g || !lease.project) return null;
  return (
    <div className="notice bad" style={{ margin: ".75rem 1rem 0" }}><Icon name="alert" />
      <span>Rent starts {date(lease.rent_start)}, {g.days} days before the target opening of {lease.project.project_code} on {date(lease.project.target_opening_date)}. That is about {inr(Number(g.cost))} of rent before the store earns.</span>
    </div>
  );
}

function LeaseFacts({ l }: { l: Row }) {
  const rent = l.rent as Row;
  return (
    <div className="panel-body">
      <Facts items={[
        ["Landlord", l.landlord_name ? <>{l.landlord_name}{l.landlord_contact && <span className="cell-sub">{l.landlord_contact}</span>}</> : null],
        ["Monthly rent", l.monthly_rent ? <>{inr(Number(rent.current))}{rent.next && <span className="cell-sub">{inr(Number(rent.next.rent))} from {date(rent.next.date)}</span>}</> : null],
        ["Escalation", l.escalation_pct ? `${l.escalation_pct}% every ${Number(l.escalation_every_months ?? 12) === 12 ? "year" : months(l.escalation_every_months)}` : "None"],
        ["Maintenance (CAM)", l.cam_monthly ? `${inr(Number(l.cam_monthly))} a month` : null],
        ["Security deposit", l.security_deposit ? inr(Number(l.security_deposit)) : null],
        ["Lease start", l.lease_start ? date(l.lease_start) : null],
        ["Rent-free period", l.lease_start ? <>{l.rent_free_days ? `${l.rent_free_days} days` : "None"}<span className="cell-sub">Rent from {date(l.rent_start)}</span></> : null],
        ["Lock-in", l.lock_in_months ? <>{months(l.lock_in_months)}<span className="cell-sub">Until {date(l.lock_in_end)}</span></> : null],
        ["Term", l.term_months ? <>{months(l.term_months)}<span className="cell-sub">Ends {date(l.expiry_date)}</span></> : null],
        ["Renewal notice", l.notice_by ? <>By {date(l.notice_by)}<span className="cell-sub">{l.renewal_notice_days ?? 90} days before the end</span></> : null],
        ...(l.signed_on ? [["Signed", date(l.signed_on)] as [string, string]] : []),
      ]} />
      {l.notes && <p className="muted" style={{ margin: ".75rem 0 0" }}>{l.notes}</p>}
    </div>
  );
}

/** The site's lease: terms, the signed deed, and signing (which moves the site to lease signed). */
export function LeasePanel({ siteId, lease, editable, signable, onChanged }: { siteId: string; lease: Row | null; editable: boolean; signable: boolean; onChanged: () => void }) {
  const act = useAction(onChanged);
  const [editing, setEditing] = useState(false);
  const [signing, setSigning] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const base = `/sites/${siteId}/lease`;
  const l = lease;
  const live = !l || l.status !== "TERMINATED";
  const ready = !!(l?.lease_start && l?.term_months && l?.monthly_rent && l?.file_ref);
  const upload = async (f: File | undefined) => {
    if (!f) return;
    if (file.current) file.current.value = "";
    await act.run("upload", async () => api<Row>("POST", `${base}/document`, { body: { file_name: f.name, content_type: f.type, data_base64: await toBase64(f) } }), "Lease document uploaded.");
  };
  const view = () => act.run("view", async () => { const r = await api<{ url: string }>("GET", `${base}/document`); window.open(r.url, "_blank", "noopener"); });
  const close = () => { setEditing(false); setSigning(false); act.clear(); };
  return (
    <Panel title={<>Lease{l && <Pill value={l.status} tone={TONE[String(l.status)]} />}</>} flush action={<span className="panel-actions">
      {l?.file_ref && <button className="btn ghost sm" disabled={!!act.busy} onClick={view}>View lease</button>}
      {editable && live && <button className="btn ghost sm" disabled={!!act.busy} onClick={() => file.current?.click()}>{act.busy === "upload" ? "Uploading…" : l?.file_ref ? "Replace document" : "Upload signed lease"}</button>}
      {editable && live && <button className={l ? "btn ghost sm" : "btn sm"} onClick={() => setEditing(true)}>{l ? "Edit terms" : "Record lease terms"}</button>}
      {editable && signable && l?.status === "DRAFT" && <button className="btn sm" disabled={!ready || !!act.busy} title={ready ? undefined : "Needs start date, term, rent and the signed document"} onClick={() => setSigning(true)}><Icon name="check" size={14} />Mark signed</button>}
    </span>}>
      <input ref={file} type="file" accept={ACCEPT} hidden onChange={(e) => upload(e.target.files?.[0])} />
      {l && <GapNotice lease={l} />}
      {act.notice && <div className="notice ok" style={{ margin: ".75rem 1rem 0" }}><Icon name="check" />{act.notice}</div>}
      {act.error && !editing && !signing && <div style={{ margin: ".75rem 1rem 0" }}><FormError error={act.error} /></div>}
      {l ? <LeaseFacts l={l} /> : <div className="state">No lease recorded yet.{editable ? " Record the terms as they are agreed; upload the signed deed to mark it signed." : ""}</div>}
      {editing && <LeaseDialog lease={l} busy={act.busy === "save"} error={act.error} onClose={close}
        onSave={(body) => act.run("save", () => api<Row>("PATCH", base, { body }), "Lease terms saved.").then((r) => r && setEditing(false))} />}
      {signing && <ConfirmDialog title="Mark the lease signed?" confirm="Mark signed" busy={!!act.busy} error={act.error} onClose={close}
        body={<p className="muted" style={{ margin: 0 }}>The site moves to lease signed and the project's "Sign lease" task is completed. The terms can still be corrected later.</p>}
        onConfirm={() => act.run("sign", () => api<Row>("PATCH", base, { body: { status: "SIGNED" } }), (r) => `Lease signed.${r.task_completed ? " The Sign lease task is done." : ""}`).then((r) => r && setSigning(false))} />}
    </Panel>
  );
}

const FIELDS = ["landlord_name", "landlord_contact", "monthly_rent", "cam_monthly", "security_deposit", "escalation_pct", "escalation_every_months", "lease_start", "term_months", "lock_in_months", "rent_free_days", "renewal_notice_days", "notes"] as const;
const NUMERIC = new Set(["monthly_rent", "cam_monthly", "security_deposit", "escalation_pct", "escalation_every_months", "term_months", "lock_in_months", "rent_free_days", "renewal_notice_days"]);

function LeaseDialog({ lease, busy, error, onSave, onClose }: { lease: Row | null; busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const init = Object.fromEntries(FIELDS.map((k) => [k, lease?.[k] == null ? (k === "escalation_every_months" ? "12" : k === "renewal_notice_days" ? "90" : "") : String(lease[k]).slice(0, k === "lease_start" ? 10 : undefined)])) as Record<(typeof FIELDS)[number], string>;
  const [v, setV] = useState(init);
  const set = (k: (typeof FIELDS)[number]) => (e: { target: { value: string } }) => setV((p) => ({ ...p, [k]: e.target.value }));
  const submit = () => {
    const body: Row = {};
    for (const k of FIELDS) if (v[k] !== init[k] || (!lease && v[k] !== "")) body[k] = v[k].trim() === "" ? null : NUMERIC.has(k) ? Number(v[k]) : v[k].trim();
    if (Object.keys(body).length) onSave(body); else onClose();
  };
  const num = (k: (typeof FIELDS)[number], props: Record<string, unknown> = {}) => <input type="number" min={0} step="any" value={v[k]} onChange={set(k)} {...props} />;
  return (
    <Dialog title={lease ? "Lease terms" : "Record lease terms"} subtitle="Rent starts when the rent-free fit-out period ends. FOS warns when that is before the store opens." onClose={onClose} wide>
      <Form onSubmit={submit} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy}>{busy ? "Saving…" : "Save"}</button></>}>
        <Field label="Landlord"><input value={v.landlord_name} onChange={set("landlord_name")} maxLength={200} autoFocus /></Field>
        <Field label="Landlord contact"><input value={v.landlord_contact} onChange={set("landlord_contact")} maxLength={200} placeholder="Phone or email" /></Field>
        <Field label="Monthly rent (₹)">{num("monthly_rent")}</Field>
        <Field label="Maintenance / CAM a month (₹)">{num("cam_monthly")}</Field>
        <Field label="Security deposit (₹)">{num("security_deposit")}</Field>
        <Field label="Lease start"><input type="date" value={v.lease_start} onChange={set("lease_start")} /></Field>
        <Field label="Rent-free period (days)" hint="The fit-out window before rent is due.">{num("rent_free_days", { step: 1 })}</Field>
        <Field label="Term (months)">{num("term_months", { step: 1 })}</Field>
        <Field label="Lock-in (months)">{num("lock_in_months", { step: 1 })}</Field>
        <Field label="Escalation (%)">{num("escalation_pct", { max: 100 })}</Field>
        <Field label="Escalation every (months)">{num("escalation_every_months", { min: 1, step: 1 })}</Field>
        <Field label="Renewal notice (days before the end)">{num("renewal_notice_days", { step: 1 })}</Field>
        <Field label="Notes" span><textarea rows={2} value={v.notes} onChange={set("notes")} maxLength={2000} /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

/** Read-only lease summary for the project page. */
export function LeaseSummary({ lease, siteId }: { lease: Row | null; siteId: unknown }) {
  if (!siteId) return null;
  return (
    <Panel title={<>Lease{lease && <Pill value={lease.status} tone={TONE[String(lease.status)]} />}</>} flush action={<Link to={`/sites/${siteId}`}>Open site</Link>}>
      {lease ? <><GapNotice lease={lease} /><LeaseFacts l={lease} /></> : <div className="state">No lease recorded on the site yet.</div>}
    </Panel>
  );
}

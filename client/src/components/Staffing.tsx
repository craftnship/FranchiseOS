import { useState } from "react";
import { api, ApiError, Row, portalHome } from "../api";
import { useAction, useLoad } from "../hooks";
import { upload } from "./Construction";
import { Dialog, Field, Form, FormError } from "./forms";
import { DataTable, date, Icon, Loaded, PageHeader, Panel, Pill } from "./ui";

// The tenant's store roles (Settings → Store setup), as the staffing API returns them; the first is the manager.
let ROLES: [string, string, string][] = [["STORE_MANAGER", "Store manager", "Store managers"], ["SHIFT_LEAD", "Shift lead", "Shift leads"], ["CREW", "Crew", "Crew"]];
const roleName = (code: unknown) => ROLES.find((r) => r[0] === code)?.[1] ?? String(code ?? "");
const TRAIN_TONE: Record<string, string> = { SUBMITTED: "info", SIGNED_OFF: "good", RETURNED: "warn" };
const TRAIN_TEXT: Record<string, string> = { SUBMITTED: "Waiting for sign-off", SIGNED_OFF: "Signed off", RETURNED: "Sent back" };
const CERTS = "application/pdf,image/jpeg,image/png,image/webp";
const today = () => new Date().toISOString().slice(0, 10);
const open = async (path: string) => { const r = await api<{ url: string }>("GET", path); window.open(r.url, "_blank", "noopener"); };

type DialogState = null | { kind: "plan" } | { kind: "add" } | { kind: "edit"; person: Row } | { kind: "leave"; person: Row } | { kind: "training"; personId: string };

/**
 * The store team against the staffing plan, and each person's brand training. `editable` is staff
 * with project.write (they set the plan and sign training off); `portal` is the franchisee.
 */
export function StaffingPanel({ projectId, editable, portal, closed, onTasks }: { projectId: string; editable: boolean; portal?: boolean; closed?: boolean; onTasks?: () => void }) {
  const load = useLoad(() => api<Row>("GET", `/projects/${projectId}/staffing`), [projectId]);
  const act = useAction(load.reload);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [showLeft, setShowLeft] = useState(false);
  const base = `/projects/${projectId}`;
  const canAdd = !closed && (editable || !!portal);
  const close = () => { setDialog(null); act.clear(); };
  const done = (r: unknown) => { if (r) setDialog(null); };
  /** Says which checklist tasks the change completed, and refreshes the checklist. */
  const tasksNote = (r: Row) => {
    const t = (r.tasks_completed ?? []) as string[];
    if (t.length) onTasks?.();
    const names: Record<string, string> = { HIRE_MANAGER: `Hire ${ROLES[0][1].toLowerCase()}`, HIRE_CREW: "Hire the team", TRAIN_CREW: "Complete team training" };
    return t.length ? ` ${t.map((c) => `“${names[c] ?? c}”`).join(" and ")} ${t.length === 1 ? "is" : "are"} now done.` : "";
  };

  return (
    <Loaded load={load}>{(s) => {
      const plan = s.plan as Row[], staff = s.staff as Row[], modules = s.modules as Row[];
      if (Array.isArray(s.roles) && s.roles.length) ROLES = (s.roles as Row[]).map((r) => [String(r.code), String(r.name), String(r.plural)]);
      const active = staff.filter((p) => p.status === "ACTIVE");
      const shown = showLeft ? staff : active;
      const left = staff.length - active.length;
      const person = dialog?.kind === "training" ? staff.find((p) => String(p.ROWID) === dialog.personId) : undefined;
      return (
        <Panel title="Team and training" flush action={<span className="panel-actions">
          {editable && !closed && <button className="btn ghost sm" onClick={() => setDialog({ kind: "plan" })}>Edit plan</button>}
          {canAdd && <button className="btn sm" onClick={() => setDialog({ kind: "add" })}>Add person</button>}
        </span>}>
          {act.notice && <div className="notice ok" style={{ margin: ".75rem 1rem 0" }}><Icon name="check" />{act.notice}</div>}
          {act.error && !dialog && <div style={{ margin: ".75rem 1rem 0" }}><FormError error={act.error} /></div>}
          <div className="staff-plan">
            {plan.map((r) => {
              const full = Number(r.trained) >= Number(r.required);
              return (
                <div key={String(r.role_code)}>
                  <span className="muted">{ROLES.find((x) => x[0] === r.role_code)?.[2]}</span>
                  <strong>{r.hired} <span className="muted">of {r.required} hired</span></strong>
                  <span style={{ color: full ? "var(--good)" : undefined }}>{full && Number(r.required) > 0 ? "✓ " : ""}{r.trained} trained</span>
                </div>
              );
            })}
          </div>
          {editable && Number(s.to_sign_off) > 0 && <div className="notice info" style={{ margin: "0 1rem .75rem" }}><Icon name="bell" /><span>{s.to_sign_off} training record{Number(s.to_sign_off) === 1 ? " is" : "s are"} waiting for your sign-off.</span></div>}
          <DataTable rows={shown} empty={portal ? "Add the people you hire. Their training is tracked here too." : "No one hired yet."} columns={[
            { key: "full_name", label: "Name", render: (p) => <span style={{ display: "block", minWidth: "10rem", color: p.status === "LEFT" ? "var(--muted)" : undefined }}>{p.full_name}
              <span className="cell-sub">{p.status === "LEFT" ? `Left ${date(p.left_on)}${p.left_reason ? `: ${p.left_reason}` : ""}` : [p.phone, `hired ${date(p.hired_on)}`].filter(Boolean).join(" · ")}</span></span> },
            { key: "role_code", label: "Role", render: (p) => roleName(p.role_code) },
            { key: "training", label: "Training", render: (p) => {
              if (p.status === "LEFT") return <span className="muted">—</span>;
              const need = modules.filter((m) => (m.roles as string[]).includes(String(p.role_code))).length;
              const recs = p.training as Row[];
              const waiting = recs.filter((t) => t.status === "SUBMITTED").length, back = recs.filter((t) => t.status === "RETURNED").length;
              return <span className="panel-actions" style={{ justifyContent: "flex-start" }}>
                {p.trained ? <Pill value="Trained" tone="good" /> : <span>{need - (p.missing as string[]).length} of {need}</span>}
                {waiting > 0 && <Pill value={`${waiting} to sign off`} tone="info" />}
                {back > 0 && <Pill value={`${back} sent back`} tone="warn" />}
              </span>;
            } },
            { key: "actions", label: "", align: "right", render: (p) => p.status === "LEFT" ? null : (
              <span className="panel-actions">
                <button className="btn sm" onClick={() => setDialog({ kind: "training", personId: String(p.ROWID) })}>Training</button>
                {canAdd && <button className="btn ghost sm" onClick={() => setDialog({ kind: "edit", person: p })}>Edit</button>}
                {canAdd && <button className="btn ghost sm" onClick={() => setDialog({ kind: "leave", person: p })}>Left</button>}
              </span>
            ) },
          ]} />
          {left > 0 && <button className="btn ghost sm" style={{ margin: ".5rem 1rem .75rem" }} onClick={() => setShowLeft(!showLeft)}>{showLeft ? "Hide people who left" : `Show ${left} who left`}</button>}

          {dialog?.kind === "plan" && <PlanDialog plan={plan} busy={act.busy === "plan"} error={act.error} onClose={close}
            onSave={(body) => act.run("plan", () => api<Row>("PATCH", `${base}/staffing/plan`, { body }), (r) => `Staffing plan saved.${tasksNote(r)}`).then(done)} />}
          {(dialog?.kind === "add" || dialog?.kind === "edit") && <StaffDialog person={dialog.kind === "edit" ? dialog.person : null} busy={act.busy === "staff"} error={act.error} onClose={close}
            onSave={(body) => act.run("staff", () => dialog.kind === "edit" ? api<Row>("PATCH", `${base}/staff/${dialog.person.ROWID}`, { body }) : api<Row>("POST", `${base}/staff`, { body }),
              (r) => `${r.full_name} ${dialog.kind === "edit" ? "updated" : "added to the team"}.${tasksNote(r)}`).then(done)} />}
          {dialog?.kind === "leave" && <LeaveDialog person={dialog.person} busy={act.busy === "leave"} error={act.error} onClose={close}
            onSave={(body) => act.run("leave", () => api<Row>("PATCH", `${base}/staff/${dialog.person.ROWID}`, { body: { action: "leave", ...body } }), `${dialog.person.full_name} marked as left.`).then(done)} />}
          {dialog?.kind === "training" && person && <TrainingDialog person={person} modules={modules} base={base} editable={editable && !closed} canRecord={canAdd} portal={!!portal}
            busy={act.busy} error={act.error} notice={act.notice} onClose={close} onClear={act.clear}
            onRecord={(body) => act.run("record", () => api<Row>("POST", `${base}/staff/${person.ROWID}/training`, { body }),
              (r) => `${r.status === "SIGNED_OFF" ? "Training signed off" : "Training sent for sign-off"} for ${person.full_name}.${tasksNote(r)}`)}
            onDecide={(t, decision, note) => act.run(`t${t.ROWID}`, () => api<Row>("POST", `${base}/training/${t.ROWID}/decision`, { body: { decision, ...(note ? { note } : {}) } }),
              (r) => `${decision === "SIGNED_OFF" ? "Signed off" : "Sent back"} for ${person.full_name}.${tasksNote(r)}`)} />}
        </Panel>
      );
    }}</Loaded>
  );
}

function PlanDialog({ plan, busy, error, onSave, onClose }: { plan: Row[]; busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const [v, setV] = useState<Record<string, string>>(Object.fromEntries(plan.map((r) => [String(r.role_code), String(r.required)])));
  return (
    <Dialog title="Staffing plan" subtitle="People this store needs before it opens. The hiring and training tasks complete when the plan is met." onClose={onClose}>
      <Form onSubmit={() => onSave(Object.fromEntries(Object.entries(v).map(([k, n]) => [k, Number(n)])))}
        footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || Object.values(v).some((n) => n === "" || Number(n) < 0)}>{busy ? "Saving…" : "Save plan"}</button></>}>
        {ROLES.map(([code, one]) => <Field key={code} label={one}><input type="number" min={0} max={100} step={1} value={v[code] ?? ""} onChange={(e) => setV((p) => ({ ...p, [code]: e.target.value }))} required /></Field>)}
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

function StaffDialog({ person, busy, error, onSave, onClose }: { person: Row | null; busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const [v, setV] = useState({ full_name: String(person?.full_name ?? ""), role_code: String(person?.role_code ?? ROLES[ROLES.length - 1][0]), phone: String(person?.phone ?? ""), email: String(person?.email ?? ""), hired_on: String(person?.hired_on ?? today()).slice(0, 10), start_date: String(person?.start_date ?? "").slice(0, 10) });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((p) => ({ ...p, [k]: e.target.value }));
  const submit = () => {
    const common = { full_name: v.full_name.trim(), role_code: v.role_code, phone: v.phone.trim() || null, email: v.email.trim() || null, start_date: v.start_date || null };
    onSave(person ? common : { ...common, hired_on: v.hired_on });
  };
  return (
    <Dialog title={person ? `Edit ${person.full_name}` : "Add to the team"} onClose={onClose}>
      <Form onSubmit={submit} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || v.full_name.trim().length < 2}>{busy ? "Saving…" : person ? "Save" : "Add person"}</button></>}>
        <Field label="Full name" span><input value={v.full_name} onChange={set("full_name")} maxLength={120} required autoFocus /></Field>
        <Field label="Role"><select value={v.role_code} onChange={set("role_code")}>{ROLES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></Field>
        <Field label="Phone"><input type="tel" value={v.phone} onChange={set("phone")} maxLength={20} placeholder="+91 98400 00000" /></Field>
        <Field label="Email"><input type="email" value={v.email} onChange={set("email")} maxLength={200} /></Field>
        {!person && <Field label="Hired on"><input type="date" value={v.hired_on} max={today()} onChange={set("hired_on")} required /></Field>}
        <Field label="Starts on (optional)"><input type="date" value={v.start_date} onChange={set("start_date")} /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

function LeaveDialog({ person, busy, error, onSave, onClose }: { person: Row; busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const [day, setDay] = useState(today());
  const [reason, setReason] = useState("");
  return (
    <Dialog title={`${person.full_name} has left`} subtitle="They stay in the history but no longer count towards the plan." onClose={onClose}>
      <Form onSubmit={() => onSave({ left_on: day, ...(reason.trim() ? { reason: reason.trim() } : {}) })}
        footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn danger" disabled={busy}>{busy ? "Saving…" : "Mark as left"}</button></>}>
        <Field label="Last day"><input type="date" value={day} max={today()} onChange={(e) => setDay(e.target.value)} required autoFocus /></Field>
        <Field label="Reason (optional)" span><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

/** One person's modules: record completion, attach the certificate, and (staff) sign off or send back. */
function TrainingDialog({ person, modules, base, editable, canRecord, portal, busy, error, notice, onRecord, onDecide, onClose, onClear }: {
  person: Row; modules: Row[]; base: string; editable: boolean; canRecord: boolean; portal: boolean; busy: string | null; error: ApiError | null; notice: string | null;
  onRecord: (b: Row) => Promise<unknown>; onDecide: (t: Row, d: "SIGNED_OFF" | "RETURNED", note?: string) => Promise<unknown>; onClose: () => void; onClear: () => void;
}) {
  const mine = modules.filter((m) => (m.roles as string[]).includes(String(person.role_code)));
  const rec = (code: unknown) => (person.training as Row[]).find((t) => t.module_code === code);
  const [form, setForm] = useState<null | { module: Row; returning?: Row }>(null);
  const [v, setV] = useState({ completed_on: today(), score: "", trainer: "", note: "" });
  const [file, setFile] = useState<File | null>(null);
  const start = (module: Row, returning?: Row) => { onClear(); setForm({ module, returning }); setV({ completed_on: today(), score: "", trainer: "", note: "" }); setFile(null); };
  const after = (r: unknown) => { if (r) setForm(null); };
  const needsCert = !!form?.module.certificate && portal && !rec(form.module.code)?.certificate_ref;
  return (
    <Dialog wide title={`${person.full_name} · training`} subtitle={`${roleName(person.role_code)}. ${portal ? "Record each module when it's done; the franchise team signs it off." : "Records you add are signed off at once."}`} onClose={onClose}>
      {notice && !form && <div className="notice ok" style={{ margin: "0 1.2rem .5rem" }}><Icon name="check" />{notice}</div>}
      <ul className="module-list">
        {mine.map((m) => {
          const t = rec(m.code);
          const rowBusy = busy === `t${t?.ROWID}`;
          return (
            <li key={String(m.code)}>
              <div>
                <strong>{m.name}</strong>{m.certificate ? <span className="muted"> · certificate needed</span> : null}
                <span className="cell-sub">{t ? [`Completed ${date(t.completed_on)}`, t.score != null && `score ${t.score}%`, t.trainer && `by ${t.trainer}`].filter(Boolean).join(" · ") : "Not done yet"}</span>
                {t?.status === "RETURNED" && t.review_note && <span className="cell-sub" style={{ color: "var(--warn)" }}>Sent back: {t.review_note}</span>}
              </div>
              <span className="panel-actions">
                {t && <Pill value={TRAIN_TEXT[String(t.status)]} tone={TRAIN_TONE[String(t.status)]} />}
                {t?.certificate_ref && <button className="btn ghost sm" onClick={() => open(`${base}/training/${t.ROWID}/certificate`)}>Certificate</button>}
                {editable && t?.status === "SUBMITTED" && <>
                  <button className="btn sm" disabled={rowBusy} onClick={() => onDecide(t, "SIGNED_OFF")}><Icon name="check" size={14} />Sign off</button>
                  <button className="btn danger-ghost sm" disabled={rowBusy} onClick={() => start(m, t)}>Send back</button>
                </>}
                {canRecord && (!t || t.status === "RETURNED") && <button className="btn ghost sm" onClick={() => start(m)}>{t ? "Record again" : "Record"}</button>}
              </span>
            </li>
          );
        })}
      </ul>
      {form && (form.returning ? (
        <Form onSubmit={() => onDecide(form.returning!, "RETURNED", v.note.trim()).then(after)}
          footer={<><button type="button" className="btn secondary" onClick={() => setForm(null)}>Cancel</button><button className="btn" disabled={busy === `t${form.returning.ROWID}` || v.note.trim().length < 3}>Send back</button></>}>
          <Field label={`What's missing for ${form.module.name}`} span><textarea rows={2} value={v.note} onChange={(e) => setV((p) => ({ ...p, note: e.target.value }))} maxLength={1000} required autoFocus /></Field>
          <div className="span"><FormError error={error} /></div>
        </Form>
      ) : (
        <Form onSubmit={async () => onRecord({ module_code: form.module.code, completed_on: v.completed_on, ...(v.score !== "" ? { score: Number(v.score) } : {}), ...(v.trainer.trim() ? { trainer: v.trainer.trim() } : {}), ...(file ? { certificate: await upload(file) } : {}) }).then(after)}
          footer={<><button type="button" className="btn secondary" onClick={() => setForm(null)}>Cancel</button><button className="btn" disabled={busy === "record" || (needsCert && !file)}>{busy === "record" ? "Saving…" : portal ? "Send for sign-off" : "Record and sign off"}</button></>}>
          <h3 className="span" style={{ margin: 0, fontSize: ".95rem" }}>{form.module.name}</h3>
          <Field label="Completed on"><input type="date" value={v.completed_on} max={today()} onChange={(e) => setV((p) => ({ ...p, completed_on: e.target.value }))} required /></Field>
          <Field label="Score % (optional)"><input type="number" min={0} max={100} value={v.score} onChange={(e) => setV((p) => ({ ...p, score: e.target.value }))} /></Field>
          <Field label="Trainer (optional)"><input value={v.trainer} onChange={(e) => setV((p) => ({ ...p, trainer: e.target.value }))} maxLength={120} /></Field>
          <Field label={form.module.certificate ? "Certificate" : "Certificate (optional)"} hint="PDF or a photo, up to 5 MB."><input type="file" accept={CERTS} onChange={(e) => setFile(e.target.files?.[0] ?? null)} required={needsCert} /></Field>
          <div className="span"><FormError error={error} /></div>
        </Form>
      ))}
      {!form && error && <div style={{ padding: "0 1.25rem 1rem" }}><FormError error={error} /></div>}
    </Dialog>
  );
}

/** Portal: the franchisee's team and training. */
export function PortalTeam() {
  const home = useLoad(() => portalHome(), []);
  return (
    <>
      <PageHeader title="Team and training" subtitle="The people you hire for the store and the brand training each one completes before opening." />
      <Loaded load={home}>{(h) => h.project ? <StaffingPanel projectId={String(h.project.ROWID)} editable={false} portal closed={h.project.status === "CLOSED"} />
        : <div className="state">Hiring starts once your agreement is signed.</div>}</Loaded>
    </>
  );
}

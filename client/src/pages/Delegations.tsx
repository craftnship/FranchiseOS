import { useState } from "react";
import { api, hasRole, myRoles, Row } from "../api";
import { useAction, useLoad } from "../hooks";
import { ConfirmDialog, Dialog, Field, Form, FormError, useFields } from "../components/forms";
import { DataTable, date, Icon, label, Loaded, Panel, Pill } from "../components/ui";

const APPROVER_ROLES = ["FRANCHISE_MANAGER", "FINANCE_MANAGER", "LEGAL_MANAGER", "FRANCHISE_DIRECTOR"];
const STATE_TONE: Record<string, string> = { ACTIVE: "good", SCHEDULED: "info", EXPIRED: "neutral", REVOKED: "neutral" };
const who = (p: Row | null) => (p ? p.name || p.email : "—");
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (d: string, n: number) => new Date(new Date(`${d}T00:00:00`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

/** Hand an approver role to a colleague for a while, and see or end the handovers that apply to you. */
export function DelegationsPanel({ onChange }: { onChange?: () => void }) {
  const load = useLoad(() => api<Row[]>("GET", "/approvals/delegations"), []);
  const act = useAction(() => { load.reload(); onChange?.(); });
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<Row | null>(null);
  const roles = myRoles().filter((r) => APPROVER_ROLES.includes(r));
  const admin = hasRole("SUPER_ADMIN");
  return (
    <Panel title="Delegations" flush action={roles.length > 0 && <button className="btn secondary sm" onClick={() => setCreating(true)}>Delegate my approvals</button>}>
      {act.notice && <div className="notice ok" style={{ margin: ".75rem 1.15rem 0" }}><Icon name="check" />{act.notice}</div>}
      {act.error && !revoking && <div style={{ margin: ".75rem 1.15rem 0" }}><FormError error={act.error} /></div>}
      <Loaded load={load}>{(rows) => (
        <DataTable rows={rows} empty={roles.length ? "No delegations. Use one when you're away so approvals don't wait for you." : "No delegations involve you."} columns={[
          { key: "role", label: "Role", render: (d) => label(d.role) },
          { key: "delegator", label: "From", sort: (d) => who(d.delegator), render: (d) => who(d.delegator) },
          { key: "delegate", label: "To", sort: (d) => who(d.delegate), render: (d) => who(d.delegate) },
          { key: "starts_at", label: "Period", render: (d) => <>{date(d.starts_at)} to {date(d.ends_at)}</> },
          { key: "state", label: "Status", render: (d) => <Pill value={d.state} tone={STATE_TONE[d.state]} /> },
          { key: "_act", label: "", render: (d) => d.status === "ACTIVE" && d.state !== "EXPIRED" && (admin || roles.includes(d.role)) &&
            <button className="btn danger-ghost sm" disabled={!!act.busy} onClick={() => setRevoking(d)}>Revoke</button> },
        ]} />
      )}</Loaded>
      {creating && <DelegateDialog roles={roles} onClose={() => setCreating(false)} onSaved={(d) => { setCreating(false); load.reload(); onChange?.(); act.say(`${d.delegate ? who(d.delegate) : "Your delegate"} can decide ${label(d.role).toLowerCase()} steps from ${date(d.starts_at)} to ${date(d.ends_at)}.`); }} />}
      {revoking && (
        <ConfirmDialog title="Revoke this delegation?" confirm="Revoke" danger busy={!!act.busy} error={act.error} onClose={() => { setRevoking(null); act.clear(); }}
          body={<p className="muted" style={{ margin: 0 }}>{who(revoking.delegate)} stops deciding {label(revoking.role).toLowerCase()} steps straight away.</p>}
          onConfirm={() => act.run("revoke", () => api("POST", `/approvals/delegations/${revoking.ROWID}/revoke`), "Delegation revoked.").then((r) => r && setRevoking(null))} />
      )}
    </Panel>
  );
}

function DelegateDialog({ roles, onClose, onSaved }: { roles: string[]; onClose: () => void; onSaved: (d: Row) => void }) {
  const people = useLoad(() => api<Row[]>("GET", "/approvals/delegates"), []);
  const f = useFields({ role: roles[0] ?? "", delegate_user_id: "", from: today(), to: plusDays(today(), 7) });
  const act = useAction();
  const save = async () => {
    // Whole days in the user's own time zone: from the start of the first day to the end of the last.
    const r = await act.run("save", () => api<Row>("POST", "/approvals/delegations", { body: {
      role: f.values.role, delegate_user_id: f.values.delegate_user_id,
      starts_at: new Date(`${f.values.from}T00:00:00`).toISOString(), ends_at: new Date(`${f.values.to}T23:59:59`).toISOString(),
    } }));
    if (r) onSaved({ ...r, delegate: (people.data ?? []).find((p) => String(p.ROWID) === f.values.delegate_user_id) ?? null });
  };
  return (
    <Dialog title="Delegate your approvals" subtitle="While it lasts, they can approve, send back or reject steps that wait on your role. You keep your own access." onClose={onClose}>
      <Form onSubmit={save} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={!!act.busy || !f.values.delegate_user_id}>{act.busy ? "Saving…" : "Delegate"}</button></>}>
        <Field label="Role" error={act.error?.fields?.role}><select {...f.bind("role")}>{roles.map((r) => <option key={r} value={r}>{label(r)}</option>)}</select></Field>
        <Field label="Delegate to" error={act.error?.fields?.delegate_user_id}>
          <select {...f.bind("delegate_user_id")} disabled={people.loading}>
            <option value="">{people.loading ? "Loading…" : "Choose a colleague"}</option>
            {(people.data ?? []).map((p) => <option key={p.ROWID} value={p.ROWID}>{p.name || p.email} · {label(p.role)}</option>)}
          </select>
        </Field>
        <Field label="From" error={act.error?.fields?.starts_at}><input type="date" {...f.bind("from")} min={today()} /></Field>
        <Field label="To" hint="Up to 90 days" error={act.error?.fields?.ends_at}><input type="date" {...f.bind("to")} min={f.values.from} /></Field>
        <div className="span"><FormError error={act.error} /></div>
      </Form>
    </Dialog>
  );
}

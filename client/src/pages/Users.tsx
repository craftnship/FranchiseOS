import { useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, currentUser, Row } from "../api";
import { useAction, useLoad } from "../hooks";
import { ConfirmDialog, Dialog, Field, Form, FormError } from "../components/forms";
import { DataTable, date, Icon, label, Loaded, PageHeader, Panel, Pill } from "../components/ui";

const STATUS_TONE: Record<string, string> = { ACTIVE: "good", INVITED: "info", INACTIVE: "neutral" };
const PORTAL = new Set(["FRANCHISEE", "FRANCHISEE_STAFF"]);
const permLabel = (p: string) => (p === "*" ? "Everything" : label(p.replace(".", " ")));

/** People who can sign in to FranchiseOS, their roles, and what each role may do. */
export function Users() {
  const load = useLoad(() => api<Row>("GET", "/admin/users"), []);
  const me = currentUser();
  const act = useAction(load.reload);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [toggling, setToggling] = useState<Row | null>(null);
  const done = () => { setAdding(false); setEditing(null); setToggling(null); };
  const close = () => { done(); act.clear(); };
  return (
    <>
      <PageHeader title="Users and roles" crumbs={[["Admin"], ["Users and roles"]]} subtitle="Who can sign in, what role they hold, and what each role can do."
        actions={<button className="btn" onClick={() => setAdding(true)}><Icon name="franchisees" size={16} />Add person</button>} />
      {act.notice && <div className="notice ok"><Icon name="check" />{act.notice}</div>}
      {act.error && !adding && !editing && !toggling && <FormError error={act.error} />}
      <Loaded load={load}>{(d) => {
        const users = d.users as Row[];
        const roles = d.roles as Row[];
        return (
          <>
            <Panel title="People" flush action={<Link to="/admin/activity?entity_type=user">Activity</Link>}>
              <DataTable rows={users} searchKeys={["name", "email", "role", "status"]} columns={[
                { key: "name", label: "Name", sort: (u) => String(u.name ?? u.email), render: (u) => <>{u.name ?? <span className="muted">—</span>}<span className="cell-sub">{u.email}</span></> },
                { key: "role", label: "Role", render: (u) => (u.role ? label(u.role) : <span className="muted">No role</span>) },
                { key: "franchisee", label: "Franchisee", sort: (u) => String(u.franchisee?.name ?? "~"), render: (u) => u.franchisee?.name ?? <span className="muted">—</span> },
                { key: "status", label: "Status", render: (u) => <>{<Pill value={u.status === "INVITED" ? "Invited" : u.status} tone={STATUS_TONE[String(u.status)]} />}{u.status === "INVITED" && <span className="cell-sub">Not signed in yet</span>}</> },
                { key: "created_at", label: "Added", render: (u) => date(u.created_at) },
                { key: "_act", label: "", render: (u) => (
                  <span className="panel-actions">
                    <button className="btn ghost sm" onClick={() => setEditing(u)}>Edit</button>
                    {u.id === me?.user_id ? null : u.status === "INACTIVE"
                      ? <button className="btn ghost sm" onClick={() => setToggling(u)}>Reactivate</button>
                      : <button className="btn danger-ghost sm" onClick={() => setToggling(u)}>Deactivate</button>}
                  </span>
                ) },
              ]} />
            </Panel>
            <Panel title="Roles" flush>
              <DataTable rows={roles} columns={[
                { key: "code", label: "Role", sort: (r) => roles.indexOf(r), render: (r) => <>{label(r.code)}{r.portal && <span className="cell-sub">Franchisee portal</span>}</> },
                { key: "active_users", label: "People", align: "right", sort: (r) => Number(r.active_users) },
                { key: "permissions", label: "Can", render: (r) => (r.permissions as string[]).length
                  ? <span className="chips">{(r.permissions as string[]).map((p) => <span key={p} className="chip static" title={p}>{permLabel(p)}</span>)}</span>
                  : <span className="muted">View only</span> },
              ]} />
              <p className="panel-foot muted">What each role can do applies to everyone in the tenant who holds it. It can't be edited here yet.</p>
            </Panel>
            {(adding || editing) && <UserDialog user={editing} roles={roles} franchisees={d.franchisees as Row[]} invites={!!d.invites_by_email} busy={!!act.busy} error={act.error} onClose={close}
              onSave={(body) => (editing
                ? act.run("save", () => api<Row>("PATCH", `/admin/users/${editing.id}`, { body }), "Saved.")
                : act.run("save", () => api<Row>("POST", "/admin/users", { body }), (r) => r.email_sent ? `Added ${body.email}. Catalyst has emailed them an invitation.` : `Added ${body.email}. They get access the first time they sign in with that email.`)
              ).then((r) => r && done())} />}
            {toggling && <ConfirmDialog title={toggling.status === "INACTIVE" ? `Reactivate ${toggling.name ?? toggling.email}?` : `Deactivate ${toggling.name ?? toggling.email}?`}
              confirm={toggling.status === "INACTIVE" ? "Reactivate" : "Deactivate"} danger={toggling.status !== "INACTIVE"} busy={!!act.busy} error={act.error} onClose={close}
              body={<p className="muted" style={{ margin: 0 }}>{toggling.status === "INACTIVE" ? "They can sign in again with their current role." : "They can't sign in or receive notifications until reactivated. Their past work stays in the activity log."}</p>}
              onConfirm={() => act.run("toggle", () => api<Row>("PATCH", `/admin/users/${toggling.id}`, { body: { status: toggling.status === "INACTIVE" ? "ACTIVE" : "INACTIVE" } }), (r) => `${r.name ?? r.email} is ${label(r.status === "INVITED" ? "invited" : r.status).toLowerCase()}.`).then((r) => r && done())} />}
          </>
        );
      }}</Loaded>
    </>
  );
}

function UserDialog({ user, roles, franchisees, invites, busy, error, onSave, onClose }: { user: Row | null; roles: Row[]; franchisees: Row[]; invites: boolean; busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState(String(user?.name ?? ""));
  const [role, setRole] = useState(String(user?.role ?? ""));
  const [fr, setFr] = useState(String(user?.franchisee?.id ?? ""));
  const portal = PORTAL.has(role) || role === "VENDOR";
  const submit = () => {
    if (!user) return onSave({ email: email.trim(), name: name.trim(), role, franchisee_id: portal && fr ? fr : null });
    const body: Row = {};
    if (name.trim() !== String(user.name ?? "")) body.name = name.trim();
    if (role !== user.role) body.role = role;
    const nextFr = portal ? fr || null : null;
    if ((nextFr ?? "") !== String(user.franchisee?.id ?? "")) body.franchisee_id = nextFr;
    if (Object.keys(body).length) onSave(body); else onClose();
  };
  const f = error?.fields ?? {};
  return (
    <Dialog title={user ? String(user.name ?? user.email) : "Add a person"} subtitle={user ? String(user.email) : invites ? "Catalyst emails them an invitation to set a password." : "They get access the first time they sign in with this email."} onClose={onClose}>
      <Form onSubmit={submit} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !role || (!user && !email)}>{busy ? "Saving…" : user ? "Save" : "Add person"}</button></>}>
        {!user && <Field label="Work email" span error={f.email}><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={200} autoFocus /></Field>}
        <Field label="Name" span error={f.name}><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoFocus={!!user} /></Field>
        <Field label="Role" span error={f.role}>
          <select value={role} onChange={(e) => setRole(e.target.value)} required>
            <option value="" disabled>Choose a role</option>
            {roles.map((r) => <option key={String(r.code)} value={String(r.code)}>{label(r.code)}</option>)}
          </select>
        </Field>
        {portal && <Field label="Franchisee" span error={f.franchisee_id} hint="Portal users only see this franchisee's records.">
          <select value={fr} onChange={(e) => setFr(e.target.value)} required={role !== "VENDOR"}>
            <option value="">{role === "VENDOR" ? "None" : "Choose a franchisee"}</option>
            {franchisees.map((x) => <option key={String(x.id)} value={String(x.id)}>{String(x.name)}</option>)}
          </select>
        </Field>}
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

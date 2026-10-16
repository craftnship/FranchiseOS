import { useState } from "react";
import { api, Row } from "../api";
import { useAction, useLoad } from "../hooks";
import { Dialog, Field, Form, FormError, useFields } from "./forms";
import { label } from "./ui";

// Staff start an application from the brand app, for a franchisee already on file or for a new
// prospect created in the same step. The CRM lead webhook and the portal are the other two ways in.

const FORMATS = ["UNIT", "MULTI_UNIT", "MASTER", "AREA_DEVELOPER"];
const NEW = "__new";

export function NewApplicationDialog({ franchisee, onClose, onCreated }: { franchisee?: Row; onClose: () => void; onCreated: (app: Row) => void }) {
  const fixed = franchisee ?? null;
  const list = useLoad(() => (fixed ? Promise.resolve([] as Row[]) : api<Row[]>("GET", "/franchisees", { query: { limit: "300" } })), [fixed?.ROWID]);
  const [who, setWho] = useState<string>(fixed ? String(fixed.ROWID) : "");
  // A franchisee created here is kept if the application step fails, so a retry doesn't create them twice.
  const [made, setMade] = useState<Row | null>(null);
  const f = useFields({
    display_name: "", legal_name: "", email: "", phone: "", franchise_type: "",
    application_type: "UNIT", investment_capacity: "", preferred_country: "India", preferred_state: "", preferred_city: "",
  });
  const act = useAction();
  const creating = !made && who === NEW;
  const chosen = made ?? fixed ?? (list.data ?? []).find((r) => String(r.ROWID) === who) ?? null;
  const save = async () => {
    const r = await act.run("save", async () => {
      let franchisee_id = made ? String(made.ROWID) : who;
      if (creating) {
        const fr = await api<Row>("POST", "/franchisees", { body: {
          display_name: f.values.display_name.trim(), legal_name: f.text("legal_name"), email: f.text("email"), phone: f.text("phone"), franchise_type: f.text("franchise_type"),
        } });
        setMade(fr);
        franchisee_id = String(fr.ROWID);
      }
      return api<Row>("POST", "/applications", { body: {
        franchisee_id, application_type: f.values.application_type, preferred_country: f.text("preferred_country"), preferred_state: f.text("preferred_state"),
        preferred_city: f.text("preferred_city"), investment_capacity: f.num("investment_capacity"),
      } });
    });
    if (r) onCreated(r);
  };
  const ready = made || fixed || (creating ? !!f.values.display_name.trim() : !!who);
  const people = [...(list.data ?? [])].sort((a, b) => String(a.display_name ?? "").localeCompare(String(b.display_name ?? "")));
  return (
    <Dialog title="New application" subtitle={chosen ? `For ${chosen.display_name ?? chosen.franchise_code}` : "Pick the franchisee, or add a new prospect, then say where and how they want to open."} onClose={onClose}>
      <Form onSubmit={save} footer={<>
        <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={!!act.busy || !ready}>{act.busy ? "Creating…" : "Create application"}</button>
      </>}>
        {!fixed && !made && (
          <Field label="Franchisee" span hint={list.loading ? "Loading franchisees…" : undefined}>
            <select value={who} onChange={(e) => setWho(e.target.value)} required autoFocus>
              <option value="">Choose…</option>
              {people.map((p) => <option key={p.ROWID} value={String(p.ROWID)}>{p.display_name ?? p.franchise_code} · {p.franchise_code}{p.status && p.status !== "ACTIVE" ? ` · ${label(p.status)}` : ""}</option>)}
              <option value={NEW}>+ New franchisee…</option>
            </select>
          </Field>
        )}
        {creating && <>
          <Field label="Name" span><input {...f.bind("display_name")} required maxLength={200} placeholder="Person or company applying" autoFocus /></Field>
          <Field label="Legal name" span><input {...f.bind("legal_name")} maxLength={200} /></Field>
          <Field label="Email" neededFor="to send the agreement"><input type="email" {...f.bind("email")} /></Field>
          <Field label="Phone"><input {...f.bind("phone")} maxLength={30} /></Field>
          <Field label="Franchise type" span hint="Leave blank for the brand's default."><input {...f.bind("franchise_type")} maxLength={50} placeholder="e.g. QSR" /></Field>
        </>}
        <Field label="Format"><select {...f.bind("application_type")}>{FORMATS.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
        <Field label="Investment capacity (₹)" neededFor="to submit"><input type="number" min={0} step={100000} {...f.bind("investment_capacity")} /></Field>
        <Field label="City" neededFor="to submit"><input {...f.bind("preferred_city")} maxLength={60} /></Field>
        <Field label="State"><input {...f.bind("preferred_state")} maxLength={60} /></Field>
        <Field label="Country" span><input {...f.bind("preferred_country")} maxLength={60} /></Field>
        <div className="span"><FormError error={act.error} /></div>
      </Form>
    </Dialog>
  );
}

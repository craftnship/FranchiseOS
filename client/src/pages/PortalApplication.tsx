import { useState } from "react";
import { api, Row, portalHome } from "../api";
import { useAction, useLoad } from "../hooks";
import { Field, Form, FormError, useFields } from "../components/forms";
import { DataTable, date, Facts, Icon, inr, label, Loaded, PageHeader, Panel, Pill } from "../components/ui";
import { DocumentDialog, DocumentsPanel, SiteDialog } from "./ApplicationDetail";
import { FUNNEL, StatusPath } from "./Applications";

// The franchisee's own application and site, so they can apply, upload documents, submit and
// propose a site without the brand team doing it for them.

const FORMATS = ["UNIT", "MULTI_UNIT", "MASTER", "AREA_DEVELOPER"];
/** Documents can change until the application is qualified (same as the staff page). */
const DOC_STATES = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "QUALIFIED", "ON_HOLD"];
const DEAD_SITE = ["REJECTED", "DROPPED"];

/** The application the portal works on: the one furthest along, as on the portal home. */
function useMyApplication() {
  const home = useLoad(() => portalHome(), []);
  const id = home.data?.application?.ROWID ? String(home.data.application.ROWID) : null;
  const app = useLoad(() => (id ? api<Row>("GET", `/applications/${id}`) : Promise.resolve(null as unknown as Row)), [id]);
  return { home, app, reload: () => { home.reload(); app.reload(); } };
}

export function PortalApplication() {
  const { home, app, reload } = useMyApplication();
  const act = useAction();
  const [adding, setAdding] = useState(false);
  return (
    <>
      <PageHeader title="Your application" subtitle="Tell us where and how you'd like to open, add your documents, then submit." />
      {act.notice && <div className="notice ok"><Icon name="check" />{act.notice}</div>}
      <Loaded load={home}>{(h) => !h.application
        ? <ApplicationForm onSaved={() => { act.say("Application started. Add your documents next."); reload(); }} />
        : <Loaded load={app}>{(a) => {
          const draft = a.status === "DRAFT";
          const docs = (a.documents ?? []) as Row[];
          const missing = ((a.required_documents ?? []) as string[]).filter((t) => !docs.some((d) => d.document_type === t && d.verification_status !== "REJECTED"));
          return <>
            {FUNNEL.includes(String(a.status)) && <Panel title={<>{a.application_code}<Pill value={a.status} /></>}><StatusPath steps={FUNNEL} current={String(a.status)} /></Panel>}
            {draft
              ? <ApplicationForm a={a} onSaved={() => { act.say("Saved."); reload(); }} />
              : <Panel title="Details"><Facts items={[["Format", label(String(a.application_type ?? ""))], ["City", [a.preferred_city, a.preferred_state].filter(Boolean).join(", ") || "—"], ["Country", a.preferred_country ?? "—"], ["Investment capacity", a.investment_capacity ? inr(a.investment_capacity) : "—"]]} /></Panel>}
            <DocumentsPanel a={a} busy={null} onVerify={() => {}} onAdd={DOC_STATES.includes(String(a.status)) ? () => setAdding(true) : undefined} />
            {draft && (
              <section className="next-action you">
                <div><small>When you're ready</small><h2>Submit your application</h2><p>{missing.length ? `Add your ${missing.map((t) => label(t).toLowerCase()).join(", ").replace(/, ([^,]*)$/, " and $1")} first.` : "The brand team reviews it and gets back to you. You can't change the details after this."}</p></div>
                <button className="btn" disabled={act.busy === "submit" || missing.length > 0} onClick={() => act.run("submit", () => api<Row>("POST", `/applications/${a.ROWID}/submit`), "Submitted. We'll review it and be in touch.").then((r) => r && reload())}>
                  {act.busy === "submit" ? "Submitting…" : "Submit"}<Icon name="chevron" size={16} />
                </button>
              </section>
            )}
            {act.error && <FormError error={act.error} />}
            {adding && <DocumentDialog a={a} required={(a.required_documents ?? []) as string[]} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); act.say("Document added."); app.reload(); }} />}
          </>;
        }}</Loaded>}
      </Loaded>
    </>
  );
}

function ApplicationForm({ a, onSaved }: { a?: Row; onSaved: () => void }) {
  const f = useFields({
    application_type: String(a?.application_type ?? "UNIT"), preferred_country: String(a?.preferred_country ?? "India"), preferred_state: String(a?.preferred_state ?? ""),
    preferred_city: String(a?.preferred_city ?? ""), investment_capacity: a?.investment_capacity != null ? String(a.investment_capacity) : "",
  });
  const act = useAction();
  const save = async () => {
    const body = { application_type: f.values.application_type, preferred_country: f.text("preferred_country"), preferred_state: f.text("preferred_state"), preferred_city: f.text("preferred_city"), investment_capacity: f.num("investment_capacity") };
    const r = await act.run("save", () => (a ? api<Row>("PATCH", `/applications/${a.ROWID}`, { body }) : api<Row>("POST", "/applications", { body })));
    if (r) onSaved();
  };
  return (
    <Panel title={a ? "Details" : "Start your application"}>
      <Form onSubmit={save} footer={<button className="btn" disabled={!!act.busy || !f.values.preferred_city.trim()}>{act.busy ? "Saving…" : a ? "Save" : "Start application"}</button>}>
        <Field label="Format"><select {...f.bind("application_type")}>{FORMATS.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
        <Field label="Investment capacity (₹)"><input type="number" min={0} {...f.bind("investment_capacity")} /></Field>
        <Field label="City"><input {...f.bind("preferred_city")} /></Field>
        <Field label="State"><input {...f.bind("preferred_state")} /></Field>
        <Field label="Country"><input {...f.bind("preferred_country")} /></Field>
        <div className="span"><FormError error={act.error} /></div>
      </Form>
    </Panel>
  );
}

export function PortalSite() {
  const { home, app, reload } = useMyApplication();
  const sites = useLoad(() => api<Row[]>("GET", "/sites"), []);
  const act = useAction();
  const [proposing, setProposing] = useState(false);
  return (
    <>
      <PageHeader title="Your site" subtitle="Propose the location for your store. The brand team visits and evaluates it." />
      {act.notice && <div className="notice ok"><Icon name="check" />{act.notice}</div>}
      <Loaded load={home}>{(h) => !h.application ? <div className="state">Start your application first.</div> : <Loaded load={app}>{(a) => {
        const mine = ((sites.data ?? []) as Row[]).filter((s) => String(s.application_id ?? "") === String(a.ROWID) || String(s.ROWID) === String(a.site_id ?? ""));
        const current = mine.find((s) => String(s.ROWID) === String(a.site_id ?? ""));
        const canPropose = a.status === "SITE_REQUIRED" || (["SITE_SUBMITTED", "FEASIBILITY_REVIEW"].includes(String(a.status)) && (!current || DEAD_SITE.includes(String(current.status))));
        return <>
          {canPropose
            ? <section className="next-action you"><div><small>Your next step</small><h2>{current ? "Propose a replacement site" : "Propose a site for your store"}</h2><p>Give the address, size and rent. You can add more detail with the brand team later.</p></div>
                <button className="btn" onClick={() => setProposing(true)}>Propose site<Icon name="chevron" size={16} /></button></section>
            : !mine.length && <div className="state">{FUNNEL.indexOf(String(a.status)) < FUNNEL.indexOf("SITE_REQUIRED") ? "Once your application is qualified, you can propose a site here." : "No site yet."}</div>}
          {mine.length > 0 && <Panel title="Proposed sites" flush>
            <DataTable rows={mine} empty="No site yet." columns={[
              { key: "site_code", label: "Site", render: (s) => <>{s.site_code}{String(s.ROWID) === String(a.site_id ?? "") && <span className="cell-sub">For your application</span>}</> },
              { key: "address_line_1", label: "Address", render: (s) => <>{s.address_line_1 ?? "—"}<span className="cell-sub">{[s.city, s.state].filter(Boolean).join(", ")}</span></> },
              { key: "area_sqft", label: "Area", align: "right", render: (s) => (s.area_sqft ? `${s.area_sqft} sq ft` : "—") },
              { key: "rent", label: "Rent", align: "right", render: (s) => (s.rent ? inr(s.rent) : "—") },
              { key: "status", label: "Status", render: (s) => <Pill value={s.status} /> },
              { key: "CREATEDTIME", label: "Proposed", render: (s) => date(s.CREATEDTIME) },
            ]} />
          </Panel>}
          {proposing && <SiteDialog a={a} onClose={() => setProposing(false)} onSaved={() => { setProposing(false); act.say("Site proposed. The brand team will be in touch to visit it."); sites.reload(); reload(); }} />}
        </>;
      }}</Loaded>}</Loaded>
    </>
  );
}

import { ReactNode, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, can, Row } from "../api";
import { useAction, useLoad } from "../hooks";
import { ConfirmDialog, Dialog, Field, Form, FormError, useFields } from "../components/forms";
import { DataTable, date, Facts, Icon, inr, label, Loaded, PageHeader, Panel, Pill } from "../components/ui";
import { ApprovalPanel } from "./Approvals";
import { FUNNEL, StatusPath } from "./Applications";

/** Qualification criteria (§18), rated 0 to 100; weights mirror the default template. */
const CRITERIA: [code: string, name: string, weight: number][] = [
  ["financial_capacity", "Financial capacity", 25], ["business_experience", "Business experience", 15], ["industry_experience", "Industry experience", 10],
  ["territory_availability", "Territory availability", 15], ["investment_readiness", "Investment readiness", 15], ["time_commitment", "Time commitment", 10],
  ["profile_quality", "Profile quality", 10],
];
const DOC_TYPES = ["ID_PROOF", "ADDRESS_PROOF", "BANK_STATEMENT", "PAN_CARD", "GST_CERTIFICATE", "INCOME_TAX_RETURN", "PROPERTY_DOCUMENT", "OTHER"];
/** Documents can change until the application is qualified. */
const DOC_STATES = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "QUALIFIED", "ON_HOLD"];
const TERRITORY_STATES = ["UNDER_REVIEW", "QUALIFIED"];
const RELEASE_STATES = ["UNDER_REVIEW", "QUALIFIED", "SITE_REQUIRED", "ON_HOLD", "REJECTED", "WITHDRAWN"];
const FEASIBILITY_STATES = ["SITE_SUBMITTED", "FEASIBILITY_REVIEW"];

/** Side actions in the page header; forward steps live in the next-step card. */
const SIDE: Record<string, { text: string; danger?: boolean; confirm: string; body: string }> = {
  hold: { text: "Put on hold", confirm: "Put on hold", body: "Work pauses until someone resumes it. It returns to the stage it is in now." },
  withdraw: { text: "Withdraw", danger: true, confirm: "Withdraw", body: "The applicant is no longer going ahead. This closes the application." },
  reject: { text: "Reject", danger: true, confirm: "Reject", body: "This closes the application as rejected. Any reserved territory should be released." },
};

const truthy = (v: unknown) => v === true || String(v) === "true";
const pct = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : `${+Number(v).toFixed(1)}%`);

type Open = null | "score" | "doc" | "site" | "feasibility" | "recalc" | `confirm:${string}` | "release";

export function ApplicationDetail() {
  const { id } = useParams();
  const load = useLoad(() => api<Row>("GET", `/applications/${id}`), [id]);
  const agreements = useLoad(() => api<Row[]>("GET", "/agreements", { query: { application_id: id } }), [id]);
  const sites = useLoad(() => api<Row[]>("GET", "/sites", { query: { application_id: id } }), [id]);
  const reload = () => { load.reload(); agreements.reload(); sites.reload(); };
  const act = useAction(reload);
  const [open, setOpen] = useState<Open>(null);
  const close = () => { setOpen(null); act.clear(); };

  const transition = (t: string, done: string) => act.run(t, () => api<Row>("POST", `/applications/${id}/transition`, { body: { transition: t } }), done).then((r) => r && setOpen(null));

  return (
    <Loaded load={load}>{(a) => {
      const can_ = (t: string) => (a.transitions as Row[]).some((r) => r.transition === t && (!r.permission || can(r.permission)));
      const side = Object.keys(SIDE).filter(can_);
      const canSend = can("agreement.write") && (a.status === "APPROVED" || a.status === "AGREEMENT_PENDING");
      const sendAgreement = () => act.run("agreement", () => api<Row>("POST", `/applications/${id}/agreement`),
        (r) => (r.sent ? `Agreement ${r.agreement.agreement_code} sent for signature.` : `Agreement ${r.agreement.agreement_code} was already sent.`));
      const confirmKey = open?.startsWith("confirm:") ? open.slice(8) : null;
      return (
        <>
          <PageHeader title={a.application_code} badges={<Pill value={a.status} />} crumbs={[["Expansion"], ["Applications", "/applications"], [a.application_code]]}
            subtitle={[a.preferred_city, a.preferred_state, label(a.application_type ?? "")].filter(Boolean).join(" · ")}
            actions={<>
              {side.map((t) => <button key={t} className={SIDE[t].danger ? "btn danger-ghost" : "btn secondary"} onClick={() => setOpen(`confirm:${t}`)} disabled={!!act.busy}>{SIDE[t].text}</button>)}
              {canSend && a.status === "AGREEMENT_PENDING" && <button className="btn secondary" onClick={sendAgreement} disabled={!!act.busy}><Icon name="send" size={16} />{act.busy === "agreement" ? "Sending…" : "Resend agreement"}</button>}
            </>} />
          {act.notice && <div className="notice ok"><Icon name="check" />{act.notice}</div>}
          {act.error && !open && <FormError error={act.error} />}

          <NextStep a={a} busy={act.busy} can_={can_} setOpen={setOpen} transition={transition} sendAgreement={canSend ? sendAgreement : undefined}
            startApproval={() => act.run("approval", () => api<Row>("POST", `/applications/${id}/start-approval`), "Approval started. The franchise manager has the first step.")}
            submit={() => act.run("submit", () => api<Row>("POST", `/applications/${id}/submit`), "Submitted for review.")} />

          <dl className="summary">
            <div><dt>Investment capacity</dt><dd>{a.investment_capacity ? inr(Number(a.investment_capacity)) : "—"}</dd></div>
            <div><dt>Qualification</dt><dd>{a.qualification_score ?? "—"}{a.qualification_class && <span className="badge info"><i />{label(a.qualification_class)}</span>}</dd></div>
            <div><dt>Territory</dt><dd>{a.territory?.territory_code ?? "—"}</dd></div>
            <div><dt>Feasibility ROI</dt><dd>{a.feasibility?.status === "CALCULATED" ? pct(a.feasibility.roi_pct) : "—"}</dd></div>
          </dl>
          {FUNNEL.includes(a.status) && <Panel title="Progress"><StatusPath steps={FUNNEL} current={a.status} /></Panel>}

          <div className="row c2">
            <Panel title="Application details">
              <Facts items={[
                ["Application", a.application_code], ["Format", label(a.application_type ?? "")], ["Country", a.preferred_country], ["State", a.preferred_state], ["City", a.preferred_city],
                ["Status", <Pill value={a.status} />], ...(a.held_from ? [["Held from", label(a.held_from)] as [string, string]] : []), ["Created", date(a.CREATEDTIME)], ["Last updated", date(a.MODIFIEDTIME)],
              ]} />
            </Panel>
            <QualificationPanel a={a} onScore={can("application.review") && ["SUBMITTED", "UNDER_REVIEW", "QUALIFIED"].includes(a.status) ? () => setOpen("score") : undefined} />
          </div>

          <DocumentsPanel a={a} onAdd={DOC_STATES.includes(a.status) ? () => setOpen("doc") : undefined}
            onVerify={(doc, status, reason) => act.run(`v${doc.ROWID}`, () => api("POST", `/applications/${id}/documents/${doc.ROWID}/verify`, { body: { verification_status: status, ...(reason ? { rejection_reason: reason } : {}) } }),
              `${label(doc.document_type)} ${status === "VERIFIED" ? "verified" : "rejected"}.`)} busy={act.busy} />

          <div className="row c2">
            <TerritoryPanel a={a} busy={act.busy} onRelease={() => setOpen("release")}
              onReserve={(t) => act.run(`r${t.ROWID}`, () => api("POST", `/territories/${t.ROWID}/reserve`, { body: { application_id: String(a.ROWID) } }), `${t.territory_code} reserved for this application.`)} />
            <SitesPanel a={a} sites={sites.data ?? []} onPropose={a.status === "SITE_REQUIRED" && can("site.write") ? () => setOpen("site") : undefined} />
          </div>

          {(a.feasibility || FEASIBILITY_STATES.includes(a.status)) && (
            <FeasibilityPanel a={a} busy={act.busy} onCreate={() => setOpen("feasibility")} onEdit={() => setOpen("recalc")}
              onCalculate={() => act.run("calc", () => api<Row>("POST", `/feasibility/${a.feasibility_id}/calculate`, { body: {} }), (r) => (truthy(r.passed) ? "Feasibility calculated: it passes the thresholds." : "Feasibility calculated: it does not pass yet."))}
              onScenarios={() => act.run("scen", () => api("POST", `/feasibility/${a.feasibility_id}/scenarios`, { body: {} }), "Best, base and worst cases updated.")} />
          )}

          {a.approval && <ApprovalPanel approval={a.approval} onDone={(m) => { reload(); act.say(m); window.scrollTo({ top: 0, behavior: "smooth" }); }} />}

          {(agreements.data?.length ?? 0) > 0 && (
            <Panel title="Agreement" flush>
              <DataTable rows={agreements.data!} href={(g) => `/agreements/${g.ROWID}`} columns={[
                { key: "agreement_code", label: "Agreement", render: (g) => <span className="code">{g.agreement_code}</span> },
                { key: "status", label: "Status", render: (g) => <Pill value={g.status} /> },
                { key: "CREATEDTIME", label: "Sent", render: (g) => date(g.CREATEDTIME) },
                { key: "signed_at", label: "Signed", render: (g) => date(g.signed_at) },
              ]} />
            </Panel>
          )}

          {open === "score" && <ScoreDialog a={a} onClose={close} onSaved={(r) => { close(); reload(); act.say(`Scored ${r.qualification_score}: ${label(r.qualification_class)}.`); }} />}
          {open === "doc" && <DocumentDialog a={a} required={a.required_documents} onClose={close} onSaved={(d) => { close(); reload(); act.say(`${label(d.document_type)} added.`); }} />}
          {open === "site" && <SiteDialog a={a} onClose={close} onSaved={(s) => { close(); reload(); act.say(`${s.site_code} proposed. The application is now waiting on the site evaluation.`); }} />}
          {(open === "feasibility" || open === "recalc") && <FeasibilityDialog a={a} edit={open === "recalc"} onClose={close} onSaved={(m) => { close(); reload(); act.say(m); }} />}
          {open === "release" && a.territory && (
            <ConfirmDialog title={`Release ${a.territory.territory_code}?`} confirm="Release territory" danger busy={!!act.busy} error={act.error} onClose={close}
              body={<p className="muted" style={{ margin: 0 }}>The territory becomes available to other applications again.</p>}
              onConfirm={() => act.run("release", () => api("POST", `/territories/${a.territory.ROWID}/release`, { body: {} }), `${a.territory.territory_code} released.`).then((r) => r && setOpen(null))} />
          )}
          {confirmKey && SIDE[confirmKey] && (
            <ConfirmDialog title={`${SIDE[confirmKey].text} ${a.application_code}?`} confirm={SIDE[confirmKey].confirm} danger={SIDE[confirmKey].danger} busy={!!act.busy} error={act.error} onClose={close}
              body={<p className="muted" style={{ margin: 0 }}>{SIDE[confirmKey].body}</p>}
              onConfirm={() => transition(confirmKey, `${a.application_code}: ${SIDE[confirmKey].text.toLowerCase()} done.`)} />
          )}
        </>
      );
    }}</Loaded>
  );
}

/** What has to happen next for this application, with the button that does it. */
function NextStep({ a, busy, can_, setOpen, transition, submit, startApproval, sendAgreement }: {
  a: Row; busy: string | null; can_: (t: string) => boolean; setOpen: (o: Open) => void; transition: (t: string, done: string) => void;
  submit: () => void; startApproval: () => void; sendAgreement?: () => void;
}) {
  const docs = (a.documents ?? []) as Row[];
  const missing = ((a.required_documents ?? []) as string[]).filter((t) => !docs.some((d) => d.document_type === t && d.verification_status !== "REJECTED"));
  const f = a.feasibility as Row | null;
  const current = a.approval?.steps?.find((s: Row) => Number(s.sequence) === Number(a.approval.current_step));
  const btn = (key: string, text: string, onClick: () => void, opts: { disabled?: boolean; secondary?: boolean; title?: string } = {}) =>
    <button key={key} className={`btn ${opts.secondary ? "secondary" : ""}`} onClick={onClick} disabled={!!busy || opts.disabled} title={opts.title}>{busy === key ? "Working…" : text}</button>;

  let title: string, body: ReactNode, buttons: ReactNode[] = [];
  switch (a.status) {
    case "DRAFT":
      title = "Collect the documents, then submit";
      body = missing.length ? `Still needed: ${missing.map(label).join(", ")}.` : "All required documents are in. Submit it for review.";
      if (can("application.submit")) buttons = [btn("submit", "Submit for review", submit, { disabled: missing.length > 0, title: missing.length ? "Add the required documents first" : undefined })];
      break;
    case "SUBMITTED":
      title = "Start the review";
      body = "Check the documents and begin the qualification review.";
      if (can_("start_review")) buttons = [btn("start_review", "Start review", () => transition("start_review", "Review started."))];
      break;
    case "UNDER_REVIEW":
      title = a.qualification_score == null ? "Score the applicant" : "Qualify the applicant";
      body = a.qualification_score == null ? "Rate the applicant on each criterion. You can reserve a territory at the same time." : `Scored ${a.qualification_score} (${label(a.qualification_class)}). Mark them qualified to move on.`;
      if (can("application.review")) buttons.push(btn("score", a.qualification_score == null ? "Score applicant" : "Rescore", () => setOpen("score"), { secondary: a.qualification_score != null }));
      if (can_("qualify")) buttons.push(btn("qualify", "Mark qualified", () => transition("qualify", "Marked qualified."), { disabled: a.qualification_score == null }));
      break;
    case "QUALIFIED":
      title = a.territory ? "Ask for a site" : "Reserve a territory";
      body = a.territory ? `${a.territory.territory_code} is reserved. Ask the applicant to propose a site in it.` : "Find an available territory below and reserve it for this applicant.";
      if (can_("require_site")) buttons = [btn("require_site", "Request a site", () => transition("require_site", "Site requested."), { disabled: !a.territory, title: a.territory ? undefined : "Reserve a territory first" })];
      break;
    case "SITE_REQUIRED":
      title = "Propose a site";
      body = `Add the proposed store location in ${a.territory?.name ?? "the reserved territory"}.`;
      if (can("site.write")) buttons = [btn("site", "Propose site", () => setOpen("site"))];
      break;
    case "SITE_SUBMITTED":
      title = "Evaluate the site and build the feasibility model";
      body = "Take the site through screening, the visit and its evaluation, and enter the financials.";
      if (a.site_id) buttons.push(<Link key="site" className="btn secondary" to={`/sites/${a.site_id}`}>Open site</Link>);
      if (can("feasibility.write")) buttons.push(btn("feasibility", "Build feasibility", () => setOpen("feasibility")));
      break;
    case "FEASIBILITY_REVIEW":
      if (!f || f.status !== "CALCULATED") { title = "Calculate the feasibility"; body = "Run the model on the inputs to see ROI and payback."; }
      else if (!truthy(f.passed)) { title = "Feasibility does not pass yet"; body = (f.fail_reasons as string[] | undefined)?.join(" ") || "Adjust the inputs and recalculate."; }
      else { title = "Start the approval"; body = `ROI ${pct(f.roi_pct)}, payback ${f.payback_months} months. Send it to the approval chain.`; }
      if (f && truthy(f.passed) && f.status === "CALCULATED" && can("approval.start")) buttons = [btn("approval", "Start approval", startApproval)];
      break;
    case "APPROVAL_PENDING":
      title = current ? `Waiting on the ${label(current.approver_role).toLowerCase()}` : "In approval";
      body = current ? `Step ${current.sequence} of ${a.approval.steps.length}${a.approval.step_due_at ? `, due ${date(a.approval.step_due_at)}` : ""}. The decision is below.` : "The approval chain is running.";
      break;
    case "APPROVED":
      title = "Send the franchise agreement";
      body = "It goes to the franchisee through Zoho Sign.";
      if (sendAgreement) buttons = [btn("agreement", "Send franchise agreement", sendAgreement)];
      break;
    case "AGREEMENT_PENDING": title = "Waiting for the signature"; body = "The franchisee has the agreement in Zoho Sign. Signing starts onboarding automatically."; break;
    case "AGREEMENT_SIGNED": title = "Onboarding is starting"; body = "CRM, Books and the opening project are being set up."; break;
    case "ONBOARDING":
      title = "Open the store";
      body = "Track the opening project. Activate the franchise once the store is trading.";
      buttons.push(<Link key="p" className="btn secondary" to="/projects">Opening projects</Link>);
      if (can_("activate")) buttons.push(btn("activate", "Activate franchise", () => transition("activate", "The franchise is active.")));
      break;
    case "ACTIVE": title = "This franchise is live"; body = "Nothing is waiting."; break;
    case "ON_HOLD":
      title = "On hold";
      body = `Paused from ${label(a.held_from ?? "")}. Resume to pick it up where it stopped.`;
      if (can_("resume")) buttons = [btn("resume", "Resume", () => transition("resume", "Resumed."))];
      break;
    default: title = `${label(a.status)}`; body = "This application is closed.";
  }
  return (
    <div className="next-action us">
      <div><small>Next step</small><h2>{title}</h2><p className="muted">{body}</p></div>
      {buttons.length > 0 && <div className="next-buttons">{buttons}</div>}
    </div>
  );
}

function QualificationPanel({ a, onScore }: { a: Row; onScore?: () => void }) {
  const b = a.score_breakdown as Record<string, number> | null;
  return (
    <Panel title="Qualification" action={onScore && <button className="btn secondary sm" onClick={onScore}>{a.qualification_score == null ? "Score" : "Rescore"}</button>}>
      {a.qualification_score == null ? <div className="muted">Not scored yet.</div> : (
        <div className="stack">
          <div className="kv-big">{a.qualification_score}<small>of 100 · {label(a.qualification_class)}</small></div>
          {b && <dl className="facts">{CRITERIA.map(([code, name, w]) => <div key={code}><dt>{name}</dt><dd>{b[code] ?? "—"} <span className="muted">/ {w}</span></dd></div>)}</dl>}
        </div>
      )}
    </Panel>
  );
}

function DocumentsPanel({ a, onAdd, onVerify, busy }: { a: Row; onAdd?: () => void; onVerify: (doc: Row, status: "VERIFIED" | "REJECTED", reason?: string) => void; busy: string | null }) {
  const docs = (a.documents ?? []) as Row[];
  const required = (a.required_documents ?? []) as string[];
  const [rejecting, setRejecting] = useState<Row | null>(null);
  const review = can("application.review");
  return (
    <Panel title="Documents" flush action={onAdd && <button className="btn secondary sm" onClick={onAdd}>Add document</button>}>
      <div className="req-docs"><span className="muted">Required</span>{required.map((t) => {
        const d = docs.find((x) => x.document_type === t && x.verification_status !== "REJECTED");
        return <Pill key={t} value={label(t)} tone={!d ? "bad" : d.verification_status === "VERIFIED" ? "good" : "warn"} />;
      })}</div>
      <DataTable rows={docs} empty="No documents yet." columns={[
        { key: "document_type", label: "Document", render: (d) => <>{label(d.document_type)}{d.document_number && <span className="cell-sub">{d.document_number}</span>}</> },
        { key: "file_ref", label: "File", render: (d) => <DocumentLink a={a} d={d} /> },
        { key: "expiry_date", label: "Expires", render: (d) => date(d.expiry_date) },
        { key: "verification_status", label: "Status", render: (d) => <>{<Pill value={d.verification_status} tone={d.verification_status === "PENDING" ? "warn" : undefined} />}{d.rejection_reason && <span className="cell-sub">{d.rejection_reason}</span>}</> },
        ...(review ? [{ key: "_act", label: "", render: (d: Row) => d.verification_status === "PENDING" && (
          <span className="panel-actions">
            <button className="btn ghost sm" disabled={busy === `v${d.ROWID}`} onClick={() => onVerify(d, "VERIFIED")}>Verify</button>
            <button className="btn danger-ghost sm" disabled={busy === `v${d.ROWID}`} onClick={() => setRejecting(d)}>Reject</button>
          </span>
        ) }] : []),
      ]} />
      {rejecting && <ConfirmDialog title={`Reject ${label(rejecting.document_type)}?`} confirm="Reject document" danger comment="required" onClose={() => setRejecting(null)}
        body={<p className="muted" style={{ margin: 0 }}>The applicant will need to provide it again.</p>}
        onConfirm={(reason) => { onVerify(rejecting, "REJECTED", reason); setRejecting(null); }} />}
    </Panel>
  );
}

function TerritoryPanel({ a, busy, onReserve, onRelease }: { a: Row; busy: string | null; onReserve: (t: Row) => void; onRelease: () => void }) {
  const t = a.territory as Row | null;
  const searching = !t && TERRITORY_STATES.includes(a.status) && can("territory.reserve");
  const f = useFields({ city: String(a.preferred_city ?? ""), state: "" });
  const [typed, setQuery] = useState<{ city?: string; state?: string } | null>(null);
  // Until someone searches, show what is available in the applicant's preferred city.
  const query = typed ?? (searching ? { city: a.preferred_city ? String(a.preferred_city) : undefined } : null);
  const results = useLoad(() => (query ? api<Row[]>("POST", "/territories/search", { body: { ...query, status: "AVAILABLE" } }) : Promise.resolve([])), [JSON.stringify(query)]);
  if (t) {
    return (
      <Panel title="Territory" action={RELEASE_STATES.includes(a.status) && can("territory.reserve") && <button className="btn danger-ghost sm" onClick={onRelease} disabled={!!busy}>Release</button>}>
        <Facts items={[["Territory", <span className="code">{t.territory_code}</span>], ["Name", t.name], ["City", [t.city, t.state].filter(Boolean).join(", ")], ["Status", <Pill value={t.status} />], ["Opportunity", t.opportunity_score ?? "—"], ["Format", t.franchise_type]]} />
      </Panel>
    );
  }
  if (!searching) return <Panel title="Territory"><div className="muted">{TERRITORY_STATES.includes(a.status) ? "You don't have access to reserve territories." : a.status === "DRAFT" || a.status === "SUBMITTED" ? "A territory is reserved during the review." : "No territory reserved."}</div></Panel>;
  return (
    <Panel title="Reserve a territory" flush>
      <form className="grid-toolbar" onSubmit={(e) => { e.preventDefault(); setQuery({ city: f.text("city"), state: f.text("state") }); }}>
        <input placeholder="City" {...f.bind("city")} style={{ maxWidth: 170 }} aria-label="City" />
        <input placeholder="State" {...f.bind("state")} style={{ maxWidth: 170 }} aria-label="State" />
        <button className="btn secondary sm" type="submit"><Icon name="search" size={15} />Search</button>
      </form>
      <Loaded load={results}>{(rows) => (
        <DataTable rows={rows} empty="No available territories match. Try another city or clear the filters." columns={[
          { key: "territory_code", label: "Territory", render: (r) => <><span className="code">{r.territory_code}</span><span className="cell-sub">{r.name}</span></> },
          { key: "city", label: "City", render: (r) => <>{r.city}<span className="cell-sub">{r.state}</span></> },
          { key: "opportunity_score", label: "Opportunity", align: "right" },
          { key: "_act", label: "", render: (r) => <button className="btn sm" disabled={!!busy} onClick={() => onReserve(r)}>{busy === `r${r.ROWID}` ? "Reserving…" : "Reserve"}</button> },
        ]} />
      )}</Loaded>
    </Panel>
  );
}

function SitesPanel({ a, sites, onPropose }: { a: Row; sites: Row[]; onPropose?: () => void }) {
  return (
    <Panel title="Site" flush action={onPropose && <button className="btn secondary sm" onClick={onPropose}>Propose site</button>}>
      <DataTable rows={sites} href={(s) => `/sites/${s.ROWID}`} empty={a.status === "SITE_REQUIRED" ? "Waiting for a proposed site." : "No site yet."} columns={[
        { key: "site_code", label: "Site", render: (s) => <><Link className="code" to={`/sites/${s.ROWID}`}>{s.site_code}</Link>{String(s.ROWID) === String(a.site_id) && <span className="cell-sub">Selected</span>}</> },
        { key: "address_line_1", label: "Address", render: (s) => <>{s.address_line_1 ?? "—"}<span className="cell-sub">{s.city}</span></> },
        { key: "site_score", label: "Score", align: "right", render: (s) => s.site_score ?? "—" },
        { key: "status", label: "Status", render: (s) => <Pill value={s.status} /> },
      ]} />
    </Panel>
  );
}

function FeasibilityPanel({ a, busy, onCreate, onEdit, onCalculate, onScenarios }: { a: Row; busy: string | null; onCreate: () => void; onEdit: () => void; onCalculate: () => void; onScenarios: () => void }) {
  const f = a.feasibility as Row | null;
  const writable = can("feasibility.write") && FEASIBILITY_STATES.includes(a.status);
  const detail = useLoad(() => (f && can("feasibility.write") ? api<Row>("GET", `/feasibility/${f.ROWID}`) : Promise.resolve(null)), [f?.ROWID, f?.MODIFIEDTIME, busy]);
  if (!f) {
    return <Panel title="Feasibility" action={writable && <button className="btn secondary sm" onClick={onCreate}>Build feasibility</button>}><div className="muted">No financial model yet.</div></Panel>;
  }
  const calculated = f.status === "CALCULATED";
  const scenarios = (detail.data?.scenarios ?? []) as Row[];
  const order = ["Best", "Base", "Worst"];
  return (
    <Panel title="Feasibility" action={<span className="panel-actions">
      {calculated && <Pill value={truthy(f.passed) ? "Passes" : "Does not pass"} tone={truthy(f.passed) ? "good" : "bad"} />}
      {writable && <>
        <button className="btn secondary sm" onClick={onEdit} disabled={!!busy}>Edit inputs</button>
        <button className="btn secondary sm" onClick={onScenarios} disabled={!!busy || !calculated}>{busy === "scen" ? "Running…" : "Run scenarios"}</button>
        <button className="btn sm" onClick={onCalculate} disabled={!!busy}>{busy === "calc" ? "Calculating…" : calculated ? "Recalculate" : "Calculate"}</button>
      </>}
    </span>}>
      <div className="stack">
        {calculated && !truthy(f.passed) && (f.fail_reasons as string[]).length > 0 && <div className="notice bad" style={{ margin: 0 }}><Icon name="alert" />{(f.fail_reasons as string[]).join(" ")}</div>}
        <Facts items={[
          ["Initial investment", inr(Number(f.initial_investment))], ["Monthly revenue", inr(Number(f.monthly_revenue))], ["Gross margin", pct(f.gross_margin_pct)],
          ["Fixed opex / month", inr(Number(f.monthly_fixed_opex))], ["Royalty", pct(f.royalty_pct)], ["Marketing fund", pct(f.marketing_fund_pct)],
          ["Monthly EBITDA", calculated ? inr(Number(f.monthly_ebitda)) : "—"], ["EBITDA margin", calculated ? pct(f.ebitda_margin_pct) : "—"],
          ["ROI", calculated ? pct(f.roi_pct) : "—"], ["Payback", calculated && f.payback_months != null ? `${+Number(f.payback_months).toFixed(1)} months` : "—"],
        ]} />
        {scenarios.length > 0 && (
          <div className="grid-scroll"><table className="grid">
            <thead><tr>{["Scenario", "Revenue / month", "EBITDA / month", "ROI", "Payback"].map((h, i) => <th key={h} className={i ? "right" : ""}><span className="th-sort">{h}</span></th>)}</tr></thead>
            <tbody>{[...scenarios].sort((x, y) => order.indexOf(x.name) - order.indexOf(y.name)).map((s) => (
              <tr key={s.ROWID}><td>{s.name}</td><td className="num">{inr(Number(s.revenue))}</td><td className="num">{inr(Number(s.ebitda))}</td><td className="num">{pct(s.roi)}</td><td className="num">{s.payback_months != null ? `${s.payback_months} mo` : "—"}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </Panel>
  );
}

function ScoreDialog({ a, onClose, onSaved }: { a: Row; onClose: () => void; onSaved: (r: Row) => void }) {
  const prior = (a.score_breakdown ?? {}) as Record<string, number>;
  // Prefill from the last score: contribution / weight gives back the 0..100 rating.
  const [ratings, setRatings] = useState<Record<string, number | null>>(Object.fromEntries(CRITERIA.map(([c, , w]) => [c, prior[c] != null ? Math.round((prior[c] / w) * 100) : c === "territory_availability" ? null : 50])));
  const act = useAction();
  const total = CRITERIA.reduce((s, [c, , w]) => s + ((ratings[c] ?? 0) * w) / 100, 0);
  const save = async () => {
    const body = Object.fromEntries(Object.entries(ratings).filter(([, v]) => v !== null)) as Record<string, number>;
    const r = await act.run("score", () => api<Row>("POST", `/applications/${a.ROWID}/score`, { body: { ratings: body } }));
    if (r) onSaved(r);
  };
  return (
    <Dialog title="Score the applicant" subtitle="Rate each criterion from 0 to 100. The weights add up to the qualification score." onClose={onClose} wide>
      <Form onSubmit={save} footer={<><span className="muted" style={{ marginRight: "auto" }}>Score <strong>{Math.round(total)}</strong>{ratings.territory_availability == null ? " plus territory availability" : ` · ${total >= 80 ? "Hot" : total >= 60 ? "Qualified" : total >= 40 ? "Nurture" : "Low"}`}</span>
        <button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={!!act.busy}>{act.busy ? "Saving…" : "Save score"}</button></>}>
        <div className="rating-list span">
          {CRITERIA.map(([code, name, w]) => (
            <div key={code} className="rating-row">
              <span>{name}<span className="cell-sub">Weight {w}{code === "territory_availability" && ratings[code] == null ? " · worked out from the city's territories" : ""}</span></span>
              {code === "territory_availability" && ratings[code] == null
                ? <button type="button" className="btn ghost sm" onClick={() => setRatings((r) => ({ ...r, [code]: 50 }))}>Rate it myself</button>
                : <input type="range" min={0} max={100} step={5} value={ratings[code] ?? 0} onChange={(e) => setRatings((r) => ({ ...r, [code]: Number(e.target.value) }))} aria-label={name} />}
              <span className="num">{ratings[code] ?? "Auto"}</span>
            </div>
          ))}
        </div>
        <div className="span"><FormError error={act.error} /></div>
      </Form>
    </Dialog>
  );
}

const MAX_UPLOAD_MB = 5;
const UPLOAD_ACCEPT = "application/pdf,image/jpeg,image/png,image/webp";

/** Reads a file as base64 without the data: prefix. */
const toBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",", 2)[1] ?? "");
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

function DocumentDialog({ a, required, onClose, onSaved }: { a: Row; required: string[]; onClose: () => void; onSaved: (d: Row) => void }) {
  const docs = (a.documents ?? []) as Row[];
  const firstMissing = required.find((t) => !docs.some((d) => d.document_type === t && d.verification_status !== "REJECTED"));
  const f = useFields({ document_type: firstMissing ?? DOC_TYPES[0], file_ref: "", document_number: "", issue_date: "", expiry_date: "" });
  const [mode, setMode] = useState<"upload" | "link">(a.uploads_enabled ? "upload" : "link");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const act = useAction();
  const pick = (picked: File | null) => {
    setFile(null); setFileError(null);
    if (!picked) return;
    if (!UPLOAD_ACCEPT.split(",").includes(picked.type)) { setFileError("Choose a PDF, JPG, PNG or WebP file."); return; }
    if (picked.size > MAX_UPLOAD_MB * 1024 * 1024) { setFileError(`This file is ${(picked.size / 1024 / 1024).toFixed(1)} MB. Files can be up to ${MAX_UPLOAD_MB} MB.`); return; }
    setFile(picked);
  };
  const meta = () => ({ document_type: f.values.document_type, document_number: f.text("document_number"), issue_date: f.text("issue_date"), expiry_date: f.text("expiry_date") });
  const save = async () => {
    const r = await act.run("doc", async () => mode === "upload"
      ? api<Row>("POST", `/applications/${a.ROWID}/documents/upload`, { body: { ...meta(), file_name: file!.name, content_type: file!.type, data_base64: await toBase64(file!) } })
      : api<Row>("POST", `/applications/${a.ROWID}/documents`, { body: { ...meta(), file_ref: f.values.file_ref.trim() } }));
    if (r) onSaved(r);
  };
  const ready = mode === "upload" ? !!file : !!f.values.file_ref.trim();
  return (
    <Dialog title="Add a document" subtitle={mode === "upload" ? `PDF, JPG, PNG or WebP, up to ${MAX_UPLOAD_MB} MB.` : "Link the file where it is stored, for example WorkDrive or Zoho CRM."} onClose={onClose}>
      <Form onSubmit={save} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={!!act.busy || !ready}>{act.busy ? (mode === "upload" ? "Uploading…" : "Adding…") : "Add document"}</button></>}>
        {a.uploads_enabled && (
          <div className="chips span" role="tablist">
            <button type="button" className={`chip ${mode === "upload" ? "on" : ""}`} onClick={() => setMode("upload")}>Upload a file</button>
            <button type="button" className={`chip ${mode === "link" ? "on" : ""}`} onClick={() => setMode("link")}>Add a link</button>
          </div>
        )}
        <Field label="Type"><select {...f.bind("document_type")}>{DOC_TYPES.map((t) => <option key={t} value={t}>{label(t)}{required.includes(t) ? " (required)" : ""}</option>)}</select></Field>
        <Field label="Document number"><input {...f.bind("document_number")} /></Field>
        {mode === "upload"
          ? <Field label="File" span error={fileError ?? act.error?.fields?.file} hint={file ? `${file.name} · ${(file.size / 1024).toFixed(0)} KB` : undefined}>
              <input type="file" accept={UPLOAD_ACCEPT} onChange={(e) => pick(e.target.files?.[0] ?? null)} />
            </Field>
          : <Field label="File link" span error={act.error?.fields?.file_ref}><input {...f.bind("file_ref")} placeholder="https://workdrive.zoho.in/…" autoFocus /></Field>}
        <Field label="Issued"><input type="date" {...f.bind("issue_date")} /></Field>
        <Field label="Expires"><input type="date" {...f.bind("expiry_date")} /></Field>
        <div className="span"><FormError error={act.error} /></div>
      </Form>
    </Dialog>
  );
}

/** Opens a stored document through a short-lived link, or a linked document directly. */
function DocumentLink({ a, d }: { a: Row; d: Row }) {
  const ref = String(d.file_ref ?? "");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (/^https?:\/\//.test(ref)) return <a href={ref} target="_blank" rel="noreferrer">Open link</a>;
  if (!ref.startsWith("stratus:")) return <span className="muted">{ref || "—"}</span>;
  const name = ref.split("/").pop();
  const open = async () => {
    // Opened first so the browser treats it as a click, then pointed at the signed link.
    const win = window.open("", "_blank");
    setBusy(true); setFailed(false);
    try {
      const r = await api<Row>("GET", `/applications/${a.ROWID}/documents/${d.ROWID}/download`);
      if (win) win.location.href = r.url; else window.location.href = r.url;
    } catch { win?.close(); setFailed(true); } finally { setBusy(false); }
  };
  return <><button className="btn ghost sm" onClick={open} disabled={busy}>{busy ? "Opening…" : "Download"}</button><span className="cell-sub">{failed ? "Couldn't open it. Try again." : name}</span></>;
}

function SiteDialog({ a, onClose, onSaved }: { a: Row; onClose: () => void; onSaved: (s: Row) => void }) {
  const f = useFields({ address_line_1: "", city: String(a.territory?.city ?? a.preferred_city ?? ""), state: String(a.territory?.state ?? a.preferred_state ?? ""), postal_code: "", area_sqft: "", rent: "", deposit: "" });
  const act = useAction();
  const save = async () => {
    const r = await act.run("site", () => api<Row>("POST", "/sites", { body: {
      application_id: String(a.ROWID), address_line_1: f.text("address_line_1"), city: f.values.city.trim(), state: f.text("state"), postal_code: f.text("postal_code"),
      area_sqft: f.num("area_sqft"), rent: f.num("rent"), deposit: f.num("deposit"),
    } }));
    if (r) onSaved(r);
  };
  return (
    <Dialog title="Propose a site" subtitle={a.territory ? `In ${a.territory.territory_code} · ${a.territory.name}` : undefined} onClose={onClose}>
      <Form onSubmit={save} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={!!act.busy || !f.values.city.trim()}>{act.busy ? "Saving…" : "Propose site"}</button></>}>
        <Field label="Address" span><input {...f.bind("address_line_1")} autoFocus /></Field>
        <Field label="City"><input {...f.bind("city")} /></Field>
        <Field label="State"><input {...f.bind("state")} /></Field>
        <Field label="Postal code"><input {...f.bind("postal_code")} /></Field>
        <Field label="Area (sq ft)"><input type="number" min={0} {...f.bind("area_sqft")} /></Field>
        <Field label="Monthly rent (₹)"><input type="number" min={0} {...f.bind("rent")} /></Field>
        <Field label="Deposit (₹)"><input type="number" min={0} {...f.bind("deposit")} /></Field>
        <div className="span"><FormError error={act.error} /></div>
      </Form>
    </Dialog>
  );
}

const FEAS_FIELDS: [key: string, text: string, hint?: string][] = [
  ["initial_investment", "Initial investment (₹)", "Fit-out, equipment, franchise fee and working capital"], ["monthly_revenue", "Monthly revenue (₹)"],
  ["gross_margin_pct", "Gross margin (%)"], ["monthly_fixed_opex", "Fixed opex per month (₹)", "Rent, salaries, utilities"],
  ["royalty_pct", "Royalty (% of revenue)"], ["marketing_fund_pct", "Marketing fund (% of revenue)"],
];

function FeasibilityDialog({ a, edit, onClose, onSaved }: { a: Row; edit: boolean; onClose: () => void; onSaved: (msg: string) => void }) {
  const m = (a.feasibility ?? {}) as Row;
  const init = (k: string, dflt: string) => (m[k] != null && m[k] !== "" ? String(m[k]) : dflt);
  const f = useFields({
    initial_investment: init("initial_investment", a.investment_capacity ? String(a.investment_capacity) : ""), monthly_revenue: init("monthly_revenue", ""),
    gross_margin_pct: init("gross_margin_pct", "65"), monthly_fixed_opex: init("monthly_fixed_opex", ""), royalty_pct: init("royalty_pct", "6"), marketing_fund_pct: init("marketing_fund_pct", "2"),
  });
  const act = useAction();
  const save = async () => {
    const inputs = Object.fromEntries(FEAS_FIELDS.map(([k]) => [k, f.num(k as keyof typeof f.values)]));
    const r = await act.run("feas", async () => {
      const model = edit ? m : await api<Row>("POST", "/feasibility", { body: { application_id: String(a.ROWID), ...inputs } });
      return api<Row>("POST", `/feasibility/${model.ROWID}/calculate`, { body: edit ? inputs : {} });
    });
    if (r) onSaved(truthy(r.passed) ? `Feasibility passes: ROI ${pct(r.roi_pct)}, payback ${r.payback_months} months.` : `Feasibility does not pass: ${(r.result?.fail_reasons ?? []).join(" ")}`);
  };
  return (
    <Dialog title={edit ? "Edit feasibility inputs" : "Build the feasibility model"} subtitle="Saving calculates ROI, payback and EBITDA against the tenant's thresholds." onClose={onClose}>
      <Form onSubmit={save} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={!!act.busy}>{act.busy ? "Calculating…" : "Save and calculate"}</button></>}>
        {FEAS_FIELDS.map(([k, text, hint], i) => (
          <Field key={k} label={text} hint={hint} error={act.error?.fields?.[k]}><input type="number" min={0} step="any" required {...f.bind(k as keyof typeof f.values)} autoFocus={i === 0} /></Field>
        ))}
        <div className="span"><FormError error={act.error} /></div>
      </Form>
    </Dialog>
  );
}

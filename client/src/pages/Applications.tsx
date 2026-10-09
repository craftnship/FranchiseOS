import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError, can, Row } from "../api";
import { useFranchiseeNames, useLoad } from "../hooks";
import { DataTable, date, ErrorState, Facts, Icon, inr, label, Loaded, PageHeader, Panel, Pill } from "../components/ui";

const FUNNEL = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "QUALIFIED", "SITE_REQUIRED", "SITE_SUBMITTED", "FEASIBILITY_REVIEW", "APPROVAL_PENDING", "APPROVED", "AGREEMENT_PENDING", "AGREEMENT_SIGNED", "ONBOARDING", "ACTIVE"];
const STATUSES = [...FUNNEL, "ON_HOLD", "REJECTED", "WITHDRAWN"];
const VIEWS: [string, string][] = [
  ["All", ""],
  ["In review", "SUBMITTED,UNDER_REVIEW,QUALIFIED"],
  ["Site & feasibility", "SITE_REQUIRED,SITE_SUBMITTED,FEASIBILITY_REVIEW"],
  ["Approval & agreement", "APPROVAL_PENDING,APPROVED,AGREEMENT_PENDING,AGREEMENT_SIGNED"],
  ["Onboarding & active", "ONBOARDING,ACTIVE"],
  ["Closed", "ON_HOLD,REJECTED,WITHDRAWN"],
];

export function Applications() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const franchisee = params.get("franchisee_id") ?? undefined;
  const load = useLoad(() => api<Row[]>("GET", "/applications", { query: { status, franchisee_id: franchisee, limit: "200" } }), [status, franchisee]);
  const names = useFranchiseeNames();
  const custom = status && !VIEWS.some(([, v]) => v === status) && !STATUSES.includes(status);
  return (
    <>
      <PageHeader title="Applications" crumbs={[["Expansion"], ["Applications"]]} subtitle="Every franchise application from first draft to an active store." />
      <Loaded load={load}>{(rows) => (
        <DataTable rows={rows} href={(a) => `/applications/${a.ROWID}`} searchKeys={["application_code", "preferred_city", "preferred_state", "status"]}
          toolbar={
            <>
              <div className="chips">
                {VIEWS.map(([text, v]) => <button key={text} className={`chip ${status === v ? "on" : ""}`} onClick={() => setParams(v ? { status: v } : {})}>{text}</button>)}
                {custom && <span className="chip on">From dashboard</span>}
              </div>
              <select value={STATUSES.includes(status) ? status : ""} onChange={(e) => setParams(e.target.value ? { status: e.target.value } : {})} aria-label="Status">
                <option value="">Any single status</option>
                {STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
              </select>
            </>
          }
          columns={[
            { key: "application_code", label: "Application", render: (a) => <span className="code">{a.application_code}</span> },
            { key: "franchisee_id", label: "Franchisee", sort: (a) => names[a.franchisee_id] ?? "", render: (a) => names[a.franchisee_id] ?? <span className="muted">—</span> },
            { key: "preferred_city", label: "Location", render: (a) => <>{a.preferred_city ?? "—"}<span className="cell-sub">{a.preferred_state}</span></> },
            { key: "application_type", label: "Format" },
            { key: "status", label: "Status", sort: (a) => STATUSES.indexOf(a.status), render: (a) => <Pill value={a.status} /> },
            { key: "qualification_score", label: "Score", align: "right", sort: (a) => Number(a.qualification_score ?? -1), render: (a) => a.qualification_score != null ? <>{a.qualification_score}{a.qualification_class && <span className="muted"> · {a.qualification_class}</span>}</> : <span className="muted">—</span> },
            { key: "investment_capacity", label: "Investment", align: "right", sort: (a) => Number(a.investment_capacity ?? 0), render: (a) => (a.investment_capacity ? inr(Number(a.investment_capacity)) : <span className="muted">—</span>) },
            { key: "CREATEDTIME", label: "Created", render: (a) => date(a.CREATEDTIME) },
          ]} />
      )}</Loaded>
    </>
  );
}

/** Where the record sits on its lifecycle; off-path states (on hold, rejected) show their own badge instead. */
export function StatusPath({ steps, current }: { steps: string[]; current: string }) {
  const at = steps.indexOf(current);
  if (at < 0) return null;
  return <div className="path">{steps.map((s, i) => <div key={s} className={`step ${i < at ? "done" : i === at ? "current" : ""}`}>{label(s)}</div>)}</div>;
}

export function ApplicationDetail() {
  const { id } = useParams();
  const load = useLoad(() => api<Row>("GET", `/applications/${id}`), [id]);
  const agreements = useLoad(() => api<Row[]>("GET", "/agreements", { query: { application_id: id } }), [id]);
  const sites = useLoad(() => api<Row[]>("GET", "/sites", { query: { application_id: id } }), [id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const send = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<Row>("POST", `/applications/${id}/agreement`);
      setNotice(r.sent ? `Agreement ${r.agreement.agreement_code} sent for signature.` : `Agreement ${r.agreement.agreement_code} was already sent.`);
      load.reload(); agreements.reload();
    } catch (e) { setError(e as ApiError); } finally { setBusy(false); }
  };
  return (
    <Loaded load={load}>{(a) => {
      const canSend = can("agreement.write") && (a.status === "APPROVED" || a.status === "AGREEMENT_PENDING");
      return (
        <>
          <PageHeader title={a.application_code} badges={<Pill value={a.status} />} crumbs={[["Expansion"], ["Applications", "/applications"], [a.application_code]]}
            subtitle={[a.preferred_city, a.preferred_state, a.application_type].filter(Boolean).join(" · ")}
            actions={canSend && <button className="btn" onClick={send} disabled={busy}><Icon name="send" size={16} />{busy ? "Sending…" : a.status === "APPROVED" ? "Send franchise agreement" : "Resend agreement"}</button>} />
          {notice && <div className="notice ok"><Icon name="check" />{notice}</div>}
          {error && <ErrorState error={error} />}
          <dl className="summary">
            <div><dt>Investment capacity</dt><dd>{a.investment_capacity ? inr(Number(a.investment_capacity)) : "—"}</dd></div>
            <div><dt>Qualification</dt><dd>{a.qualification_score ?? "—"}{a.qualification_class && <span className="badge info"><i />Class {a.qualification_class}</span>}</dd></div>
            <div><dt>Risk score</dt><dd>{a.risk_score ?? "—"}</dd></div>
            <div><dt>Created</dt><dd>{date(a.CREATEDTIME)}</dd></div>
          </dl>
          {FUNNEL.includes(a.status) && <Panel title="Progress"><StatusPath steps={FUNNEL} current={a.status} /></Panel>}
          <div className="row c2">
            <Panel title="Application details">
              <Facts items={[
                ["Application", a.application_code], ["Format", a.application_type], ["Country", a.preferred_country], ["State", a.preferred_state], ["City", a.preferred_city],
                ["Status", <Pill value={a.status} />], ...(a.held_from ? [["Held from", label(a.held_from)] as [string, string]] : []), ["Last updated", date(a.MODIFIEDTIME)],
              ]} />
            </Panel>
            <Panel title="Related records" flush>
              <table className="grid">
                <thead><tr><th><span className="th-sort">Record</span></th><th><span className="th-sort">Detail</span></th><th><span className="th-sort">Status</span></th></tr></thead>
                <tbody>
                  {(sites.data ?? []).map((s) => <tr key={`s${s.ROWID}`}><td><span className="code">{s.site_code}</span><span className="cell-sub">Site</span></td><td>{[s.address_line_1, s.city].filter(Boolean).join(", ") || "—"}</td><td><Pill value={s.status} /></td></tr>)}
                  {(agreements.data ?? []).map((g) => <tr key={`g${g.ROWID}`}><td><Link className="code" to={`/agreements/${g.ROWID}`}>{g.agreement_code}</Link><span className="cell-sub">Agreement</span></td><td>{g.signed_at ? `Signed ${date(g.signed_at)}` : `Sent ${date(g.CREATEDTIME)}`}</td><td><Pill value={g.status} /></td></tr>)}
                  {!sites.data?.length && !agreements.data?.length && <tr><td colSpan={3} className="grid-empty">No site or agreement yet.</td></tr>}
                </tbody>
              </table>
            </Panel>
          </div>
        </>
      );
    }}</Loaded>
  );
}

export function Agreements() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const load = useLoad(() => api<Row[]>("GET", "/agreements", { query: { status, limit: "200" } }), [status]);
  return (
    <>
      <PageHeader title="Agreements" crumbs={[["Contracts"], ["Agreements"]]} subtitle="Franchise agreements sent through Zoho Sign and their terms." />
      <Loaded load={load}>{(rows) => (
        <DataTable rows={rows} href={(g) => `/agreements/${g.ROWID}`} searchKeys={["agreement_code", "status"]}
          toolbar={<div className="chips">{["", "SENT", "SIGNED", "DECLINED", "VOIDED"].map((s) => <button key={s} className={`chip ${status === s ? "on" : ""}`} onClick={() => setParams(s ? { status: s } : {})}>{s ? label(s) : "All"}</button>)}</div>}
          columns={[
            { key: "agreement_code", label: "Agreement", render: (g) => <span className="code">{g.agreement_code}</span> },
            { key: "status", label: "Status", render: (g) => <Pill value={g.status} /> },
            { key: "CREATEDTIME", label: "Sent", render: (g) => date(g.CREATEDTIME) },
            { key: "signed_at", label: "Signed", render: (g) => date(g.signed_at) },
            { key: "effective_date", label: "Effective", render: (g) => date(g.effective_date) },
            { key: "expiry_date", label: "Expires", render: (g) => date(g.expiry_date) },
            { key: "application_id", label: "Application", render: (g) => <Link to={`/applications/${g.application_id}`}>Open</Link> },
          ]} />
      )}</Loaded>
    </>
  );
}

export function AgreementDetail() {
  const { id } = useParams();
  const load = useLoad(() => api<Row>("GET", `/agreements/${id}`), [id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Re-runs only the onboarding steps that have not finished (CRM, signed PDF, Books, Zoho project).
  const onboard = async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await api<Row>("POST", `/agreements/${id}/onboard`);
      setNotice(r.pending?.length ? `Still pending: ${r.pending.join(", ")}.` : "Onboarding is complete in CRM, Books and Zoho Projects.");
      load.reload();
    } catch (e) { setError(e as ApiError); } finally { setBusy(false); }
  };
  return (
    <Loaded load={load}>{(g) => (
      <>
        <PageHeader title={g.agreement_code} badges={<Pill value={g.status} />} crumbs={[["Contracts"], ["Agreements", "/agreements"], [g.agreement_code]]}
          actions={<>
            {can("agreement.write") && g.status === "SIGNED" && <button className="btn secondary" onClick={onboard} disabled={busy}><Icon name="sync" size={16} />{busy ? "Syncing…" : "Re-run onboarding sync"}</button>}
            <Link className="btn secondary" to={`/applications/${g.application_id}`}><Icon name="applications" size={16} />Open application</Link>
          </>} />
        {notice && <div className="notice ok"><Icon name="check" />{notice}</div>}
        {error && <ErrorState error={error} />}
        <dl className="summary">
          <div><dt>Sent</dt><dd>{date(g.CREATEDTIME)}</dd></div>
          <div><dt>Signed</dt><dd>{date(g.signed_at)}</dd></div>
          <div><dt>Effective</dt><dd>{date(g.effective_date)}</dd></div>
          <div><dt>Expires</dt><dd>{date(g.expiry_date)}</dd></div>
        </dl>
        <Panel title="Integration">
          <Facts items={[
            ["Zoho Sign request", g.zoho_sign_request_id ?? "Not sent through Zoho Sign"],
            ["Signed copy", g.document_ref ? "Attached to the franchisee's CRM account" : g.status === "SIGNED" ? "Not filed yet" : "After signing"],
            ["Books invoice", g.zoho_books_invoice_id ?? "No invoice yet"],
            ["Last updated", date(g.MODIFIEDTIME)],
          ]} />
        </Panel>
      </>
    )}</Loaded>
  );
}

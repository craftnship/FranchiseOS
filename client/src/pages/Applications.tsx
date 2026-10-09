import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError, Row } from "../api";
import { useLoad } from "../hooks";
import { date, ErrorState, inr, Loaded, Pill } from "../components/ui";

const STATUSES = ["", "DRAFT", "SUBMITTED", "UNDER_REVIEW", "QUALIFIED", "SITE_REQUIRED", "SITE_SUBMITTED", "FEASIBILITY_REVIEW", "APPROVAL_PENDING", "APPROVED", "AGREEMENT_PENDING", "AGREEMENT_SIGNED", "ONBOARDING", "ACTIVE", "ON_HOLD", "REJECTED", "WITHDRAWN"];

export function Applications() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const franchisee = params.get("franchisee_id") ?? undefined;
  const load = useLoad(() => api<Row[]>("GET", "/applications", { query: { status, franchisee_id: franchisee, limit: "100" } }), [status, franchisee]);
  const multi = status.includes(",");
  return (
    <>
      <h1>Applications</h1>
      <div className="filters">
        <label>Status{" "}
          <select value={multi ? "__multi" : status} onChange={(e) => setParams(e.target.value ? { status: e.target.value } : {})}>
            {multi && <option value="__multi">Filtered from the dashboard</option>}
            {STATUSES.map((s) => <option key={s} value={s}>{s ? s.replace(/_/g, " ").toLowerCase() : "All"}</option>)}
          </select>
        </label>
      </div>
      <Loaded load={load} empty={(d) => !d.length}>{(rows) => (
        <table>
          <thead><tr><th>Application</th><th>Status</th><th>City</th><th>Investment</th><th>Created</th></tr></thead>
          <tbody>{rows.map((a) => (
            <tr key={a.ROWID}><td><Link to={`/applications/${a.ROWID}`}>{a.application_code}</Link></td><td><Pill value={a.status} /></td><td>{a.preferred_city ?? "-"}</td><td>{a.investment_capacity ? inr(Number(a.investment_capacity)) : "-"}</td><td>{date(a.CREATEDTIME)}</td></tr>
          ))}</tbody>
        </table>
      )}</Loaded>
    </>
  );
}

export function ApplicationDetail() {
  const { id } = useParams();
  const load = useLoad(() => api<Row>("GET", `/applications/${id}`), [id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const send = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<Row>("POST", `/applications/${id}/agreement`);
      setNotice(r.sent ? `Agreement ${r.agreement.agreement_code} sent for signature.` : `Agreement ${r.agreement.agreement_code} was already sent.`);
      load.reload();
    } catch (e) { setError(e as ApiError); } finally { setBusy(false); }
  };
  return (
    <Loaded load={load}>{(a) => (
      <>
        <h1>{a.application_code} <Pill value={a.status} /></h1>
        <dl className="facts">
          <dt>City</dt><dd>{a.preferred_city ?? "-"}</dd>
          <dt>Type</dt><dd>{a.application_type ?? "-"}</dd>
          <dt>Investment capacity</dt><dd>{a.investment_capacity ? inr(Number(a.investment_capacity)) : "-"}</dd>
          <dt>Qualification</dt><dd>{a.qualification_score ?? "-"} {a.qualification_class && <Pill value={a.qualification_class} />}</dd>
          <dt>Created</dt><dd>{date(a.CREATEDTIME)}</dd>
        </dl>
        {(a.status === "APPROVED" || a.status === "AGREEMENT_PENDING") && (
          <p><button onClick={send} disabled={busy}>{busy ? "Sending…" : a.status === "APPROVED" ? "Send franchise agreement" : "Resend agreement"}</button></p>
        )}
        {notice && <div className="state ok">{notice}</div>}
        {error && <ErrorState error={error} />}
      </>
    )}</Loaded>
  );
}

export function Agreements() {
  const load = useLoad(() => api<Row[]>("GET", "/agreements", { query: { limit: "100" } }), []);
  return (
    <>
      <h1>Agreements</h1>
      <Loaded load={load} empty={(d) => !d.length}>{(rows) => (
        <table>
          <thead><tr><th>Agreement</th><th>Status</th><th>Signed</th><th>Effective</th><th>Expires</th><th>Application</th></tr></thead>
          <tbody>{rows.map((g) => (
            <tr key={g.ROWID}><td>{g.agreement_code}</td><td><Pill value={g.status} /></td><td>{date(g.signed_at)}</td><td>{date(g.effective_date)}</td><td>{date(g.expiry_date)}</td><td><Link to={`/applications/${g.application_id}`}>Open</Link></td></tr>
          ))}</tbody>
        </table>
      )}</Loaded>
    </>
  );
}

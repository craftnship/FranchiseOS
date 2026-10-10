import { Link, useSearchParams } from "react-router-dom";
import { api, can, Row } from "../api";
import { useAction, useLoad } from "../hooks";
import { FormError } from "../components/forms";
import { DataTable, date, Icon, label, Loaded, PageHeader, Pill } from "../components/ui";

export function Franchisees() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const load = useLoad(() => api<Row[]>("GET", "/franchisees", { query: { status, limit: "200" } }), [status]);
  const act = useAction(load.reload);
  // Contact details are kept in CRM after intake; the daily job copies edits, this does it now.
  const pull = (f: Row) => act.run(`c${f.ROWID}`, () => api<Row>("POST", `/franchisees/${f.ROWID}/sync-crm`),
    (r) => (r.changed.length ? `${f.display_name}: updated ${r.changed.map((k: string) => label(k).toLowerCase()).join(", ")} from CRM.` : `${f.display_name} already matches CRM.`));
  return (
    <>
      <PageHeader title="Franchisees" crumbs={[["Expansion"], ["Franchisees"]]} subtitle="Prospects and signed franchise partners." />
      {act.notice && <div className="notice ok"><Icon name="check" />{act.notice}</div>}
      <FormError error={act.error} />
      <Loaded load={load}>{(rows) => (
        <DataTable rows={rows} href={(f) => `/applications?franchisee_id=${f.ROWID}`} searchKeys={["franchise_code", "display_name", "legal_name", "email", "phone"]}
          toolbar={<div className="chips">{["", "ACTIVE", "PROSPECT", "INACTIVE"].map((s) => <button key={s} className={`chip ${status === s ? "on" : ""}`} onClick={() => setParams(s ? { status: s } : {})}>{s ? label(s) : "All"}</button>)}</div>}
          columns={[
            { key: "franchise_code", label: "Code", render: (f) => <span className="code">{f.franchise_code}</span> },
            { key: "display_name", label: "Name", render: (f) => <>{f.display_name}{f.legal_name && f.legal_name !== f.display_name && <span className="cell-sub">{f.legal_name}</span>}</> },
            { key: "email", label: "Contact", render: (f) => <>{f.email ?? "—"}<span className="cell-sub">{f.phone}</span></> },
            { key: "franchise_type", label: "Format" },
            { key: "status", label: "Status", render: (f) => <Pill value={f.status} /> },
            { key: "CREATEDTIME", label: "Since", render: (f) => date(f.CREATEDTIME) },
            { key: "_apps", label: "", render: (f) => <span className="panel-actions">
              <Link to={`/applications?franchisee_id=${f.ROWID}`}>Applications</Link>
              {can("application.review") && (f.zoho_lead_id || f.zoho_account_id) && <button className="btn ghost sm" disabled={act.busy === `c${f.ROWID}`} onClick={(e) => { e.stopPropagation(); pull(f); }}><Icon name="sync" size={14} />{act.busy === `c${f.ROWID}` ? "Checking…" : "Refresh from CRM"}</button>}
            </span> },
          ]} />
      )}</Loaded>
    </>
  );
}

import { Link, useSearchParams } from "react-router-dom";
import { api, Row } from "../api";
import { useLoad } from "../hooks";
import { DataTable, date, label, Loaded, PageHeader, Pill } from "../components/ui";

export function Franchisees() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const load = useLoad(() => api<Row[]>("GET", "/franchisees", { query: { status, limit: "200" } }), [status]);
  return (
    <>
      <PageHeader title="Franchisees" crumbs={[["Expansion"], ["Franchisees"]]} subtitle="Prospects and signed franchise partners." />
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
            { key: "_apps", label: "", render: (f) => <Link to={`/applications?franchisee_id=${f.ROWID}`}>Applications</Link> },
          ]} />
      )}</Loaded>
    </>
  );
}

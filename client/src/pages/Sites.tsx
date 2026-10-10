import { Link, useSearchParams } from "react-router-dom";
import { api, Row } from "../api";
import { useLoad } from "../hooks";
import { DataTable, inr, label, Loaded, PageHeader, Pill } from "../components/ui";

export function Sites() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const load = useLoad(() => api<Row[]>("GET", "/sites", { query: { status, limit: "200" } }), [status]);
  return (
    <>
      <PageHeader title="Sites" crumbs={[["Expansion"], ["Sites"]]} subtitle="Proposed store locations with their evaluation and rent." />
      <Loaded load={load}>{(rows) => {
        const statuses = [...new Set(rows.map((s) => String(s.status)))].sort();
        return (
          <DataTable rows={rows} href={(s) => `/sites/${s.ROWID}`} searchKeys={["site_code", "city", "state", "address_line_1", "status"]}
            toolbar={<div className="chips">{["", ...(status && !statuses.includes(status) ? [status] : []), ...statuses].map((s) => <button key={s} className={`chip ${status === s ? "on" : ""}`} onClick={() => setParams(s ? { status: s } : {})}>{s ? label(s) : "All"}</button>)}</div>}
            columns={[
              { key: "site_code", label: "Site", render: (s) => <span className="code">{s.site_code}</span> },
              { key: "address_line_1", label: "Address", render: (s) => <>{s.address_line_1 ?? "—"}<span className="cell-sub">{[s.city, s.state, s.postal_code].filter(Boolean).join(", ")}</span></> },
              { key: "area_sqft", label: "Area (sq ft)", align: "right", sort: (s) => Number(s.area_sqft ?? 0), render: (s) => (s.area_sqft ? Number(s.area_sqft).toLocaleString("en-IN") : "—") },
              { key: "rent", label: "Monthly rent", align: "right", sort: (s) => Number(s.rent ?? 0), render: (s) => (s.rent ? inr(Number(s.rent)) : "—") },
              { key: "site_score", label: "Score", align: "right", sort: (s) => Number(s.site_score ?? -1), render: (s) => s.site_score ?? "—" },
              { key: "recommendation", label: "Recommendation", render: (s) => (s.recommendation ? label(s.recommendation) : "—") },
              { key: "status", label: "Status", render: (s) => <Pill value={s.status} /> },
              { key: "application_id", label: "", render: (s) => s.application_id && <Link to={`/applications/${s.application_id}`}>Application</Link> },
            ]} />
        );
      }}</Loaded>
    </>
  );
}

import { useSearchParams } from "react-router-dom";
import { api, Row } from "../api";
import { useLoad } from "../hooks";
import { DataTable, label, Loaded, PageHeader, Pill, Progress } from "../components/ui";

const fmt = (n: unknown, digits = 0) => (n === null || n === undefined || n === "" ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: digits }));

export function Territories() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const load = useLoad(() => api<Row[]>("GET", "/territories", { query: { status, limit: "200" } }), [status]);
  return (
    <>
      <PageHeader title="Territories" crumbs={[["Expansion"], ["Territories"]]} subtitle="Market areas, their opportunity score and who holds them." />
      <Loaded load={load}>{(rows) => (
        <DataTable rows={rows} searchKeys={["territory_code", "name", "city", "state", "region"]}
          toolbar={<div className="chips">{["", "AVAILABLE", "RESERVED", "ALLOCATED"].map((s) => <button key={s} className={`chip ${status === s ? "on" : ""}`} onClick={() => setParams(s ? { status: s } : {})}>{s ? label(s) : "All"}</button>)}</div>}
          columns={[
            { key: "territory_code", label: "Code", render: (t) => <span className="code">{t.territory_code}</span> },
            { key: "name", label: "Territory", render: (t) => <>{t.name}<span className="cell-sub">{[t.city, t.state].filter(Boolean).join(", ")}</span></> },
            { key: "region", label: "Region" },
            { key: "franchise_type", label: "Format" },
            { key: "population", label: "Population", align: "right", sort: (t) => Number(t.population ?? 0), render: (t) => fmt(t.population) },
            { key: "opportunity_score", label: "Opportunity", sort: (t) => Number(t.opportunity_score ?? -1), render: (t) => <Progress value={t.opportunity_score} rag={Number(t.opportunity_score) >= 75 ? "GREEN" : Number(t.opportunity_score) >= 60 ? "AMBER" : "RED"} /> },
            { key: "status", label: "Status", render: (t) => <Pill value={t.status} /> },
          ]} />
      )}</Loaded>
    </>
  );
}

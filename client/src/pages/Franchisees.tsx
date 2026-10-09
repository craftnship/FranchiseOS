import { Link, useSearchParams } from "react-router-dom";
import { api, Row } from "../api";
import { useLoad } from "../hooks";
import { Loaded, Pill } from "../components/ui";

export function Franchisees() {
  const [params] = useSearchParams();
  const status = params.get("status") ?? undefined;
  const load = useLoad(() => api<Row[]>("GET", "/franchisees", { query: { status, limit: "100" } }), [status]);
  return (
    <>
      <h1>Franchisees</h1>
      {status && <p className="muted">Filtered: {status.toLowerCase()} · <Link to="/franchisees">Show all</Link></p>}
      <Loaded load={load} empty={(d) => !d.length}>{(rows) => (
        <table>
          <thead><tr><th>Code</th><th>Name</th><th>Status</th><th>Type</th><th /></tr></thead>
          <tbody>{rows.map((f) => (
            <tr key={f.ROWID}><td>{f.franchise_code}</td><td>{f.display_name}</td><td><Pill value={f.status} /></td><td>{f.franchise_type ?? "-"}</td><td><Link to={`/applications?franchisee_id=${f.ROWID}`}>Applications</Link></td></tr>
          ))}</tbody>
        </table>
      )}</Loaded>
    </>
  );
}

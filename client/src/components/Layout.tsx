import { ReactNode, useEffect, useRef, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { api, isPortal, Me, Row } from "../api";
import { Pill } from "./ui";

const STAFF_NAV = [["/", "Dashboard"], ["/applications", "Applications"], ["/projects", "Opening projects"], ["/agreements", "Agreements"]];
const PORTAL_NAV = [["/portal", "Home"], ["/portal/tasks", "Tasks"], ["/portal/agreement", "Agreement"]];

/** Search results open the record's page where the app has one, else its list. */
function searchHref(r: Row): string {
  if (r.type === "project") return `/projects/${r.id}`;
  if (r.type === "application") return `/applications/${r.id}`;
  if (r.type === "agreement") return "/agreements";
  if (r.type === "franchisee") return `/applications?franchisee_id=${r.id}`;
  return "/";
}

function Search() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Row[] | null>(null);
  const nav = useNavigate();
  const timer = useRef<number>();
  useEffect(() => {
    window.clearTimeout(timer.current);
    if (q.trim().length < 2) { setResults(null); return; }
    timer.current = window.setTimeout(() => { api<Row[]>("GET", "/search", { query: { q } }).then(setResults).catch(() => setResults([])); }, 250);
  }, [q]);
  return (
    <div className="search">
      <input type="search" placeholder="Search codes, names, cities" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
      {results && (
        <ul className="search-results" role="listbox">
          {results.length === 0 && <li className="muted">No matches</li>}
          {results.map((r) => (
            <li key={`${r.type}-${r.id}`}><button className="link" onClick={() => { setQ(""); nav(searchHref(r)); }}><span className="muted">{r.type}</span> {r.title} {r.status && <Pill value={r.status} />}</button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Layout({ me, children }: { me: Me; children: ReactNode }) {
  const portal = isPortal(me);
  const nav = portal ? PORTAL_NAV : STAFF_NAV;
  return (
    <div className="shell">
      <header className="top">
        <Link to={portal ? "/portal" : "/"} className="brand">FranchiseOS</Link>
        <nav>{nav.map(([to, label]) => <NavLink key={to} to={to} end>{label}</NavLink>)}</nav>
        {!portal && <Search />}
        <button className="link signout" onClick={() => { const c = (window as any).catalyst; if (c?.auth?.signOut) c.auth.signOut("/app/"); else window.location.href = "/__catalyst/auth/logout"; }}>Sign out</button>
      </header>
      <main>{children}</main>
    </div>
  );
}

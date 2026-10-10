import { ReactNode, useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { api, isPortal, Me, Row } from "../api";
import { Icon, label, Pill } from "./ui";
import { useLoad } from "../hooks";

type NavItem = [to: string, text: string, icon: string];
const STAFF_NAV: [string, NavItem[]][] = [
  ["Overview", [["/", "Dashboard", "dashboard"]]],
  ["Expansion", [["/applications", "Applications", "applications"], ["/approvals", "Approvals", "check"], ["/franchisees", "Franchisees", "franchisees"], ["/territories", "Territories", "territories"], ["/sites", "Sites", "sites"]]],
  ["Contracts", [["/agreements", "Agreements", "agreements"]]],
  ["Operations", [["/projects", "Opening projects", "projects"]]],
];
const PORTAL_NAV: [string, NavItem[]][] = [
  ["My franchise", [["/portal", "Home", "dashboard"], ["/portal/tasks", "Opening tasks", "projects"], ["/portal/agreement", "Agreement", "agreements"]]],
];

/** Search results open the record's page where the app has one, else its list. */
function searchHref(r: Row): string {
  if (r.type === "project") return `/projects/${r.id}`;
  if (r.type === "application") return `/applications/${r.id}`;
  if (r.type === "agreement") return `/agreements/${r.id}`;
  if (r.type === "franchisee") return `/applications?franchisee_id=${r.id}`;
  if (r.type === "territory") return "/territories";
  if (r.type === "site") return `/sites/${r.id}`;
  return "/";
}

function Search() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Row[] | null>(null);
  const nav = useNavigate();
  const timer = useRef<number>();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); input.current?.focus(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    window.clearTimeout(timer.current);
    if (q.trim().length < 2) { setResults(null); return; }
    timer.current = window.setTimeout(() => { api<Row[]>("GET", "/search", { query: { q } }).then(setResults).catch(() => setResults([])); }, 250);
  }, [q]);
  return (
    <div className="search">
      <Icon name="search" size={16} />
      <input ref={input} type="search" placeholder="Search applications, projects, franchisees…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" onKeyDown={(e) => e.key === "Escape" && setQ("")} />
      <kbd>⌘K</kbd>
      {results && (
        <ul className="search-results" role="listbox">
          {results.length === 0 && <li className="muted empty">No matches for “{q}”</li>}
          {results.map((r) => (
            <li key={`${r.type}-${r.id}`}>
              <button onClick={() => { setQ(""); nav(searchHref(r)); }}>
                <span className="result-type">{label(r.type)}</span><span className="result-title">{r.title}</span>{r.status && <Pill value={r.status} />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const signOut = () => { const c = (window as any).catalyst; if (c?.auth?.signOut) c.auth.signOut("/app/"); else window.location.href = "/__catalyst/auth/logout"; };

export function Layout({ me, children }: { me: Me; children: ReactNode }) {
  const portal = isPortal(me);
  const groups = portal ? PORTAL_NAV : STAFF_NAV;
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  const role = me.roles[0] ?? "USER";
  // Approvals waiting on this user, refreshed as they move around the app.
  const waiting = useLoad(() => (portal ? Promise.resolve([]) : api<Row[]>("GET", "/approvals", { query: { limit: "100" } })), [loc.pathname]);
  const counts: Record<string, number> = { "/approvals": waiting.data?.length ?? 0 };
  const initials = role.split("_").map((w) => w[0]).join("").slice(0, 2);
  return (
    <div className={`app ${open ? "nav-open" : ""}`}>
      <aside className="sidebar">
        <Link to={portal ? "/portal" : "/"} className="brand">
          <span className="brand-mark">F</span>
          <span><strong>FranchiseOS</strong><small>{portal ? "Franchisee portal" : "Expansion & openings"}</small></span>
        </Link>
        <nav>
          {groups.map(([group, items]) => (
            <div key={group} className="nav-group">
              <div className="nav-label">{group}</div>
              {items.map(([to, text, icon]) => <NavLink key={to} to={to} end={to === "/" || to === "/portal"}><Icon name={icon} />{text}{counts[to] > 0 && <span className="nav-count">{counts[to]}</span>}</NavLink>)}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="env">Development</span>
        </div>
      </aside>
      <div className="scrim" onClick={() => setOpen(false)} />
      <div className="main-col">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setOpen((o) => !o)} aria-label="Menu"><Icon name="menu" /></button>
          {!portal ? <Search /> : <div className="grow" />}
          <div className="user">
            <span className="avatar">{initials}</span>
            <span className="user-meta"><strong>{label(role)}</strong><small>Tenant {me.tenant_id.slice(-6)}</small></span>
            <button className="icon-btn" onClick={signOut} title="Sign out" aria-label="Sign out"><Icon name="logout" /></button>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

import { ReactNode, useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { api, can, isPortal, Me, portalHome, Row, setPortalStore } from "../api";
import { Icon, label, Pill } from "./ui";
import { useLoad } from "../hooks";
import { BrandMark, useBrand } from "../branding";

type NavItem = [to: string, text: string, icon: string, permission?: string];
const STAFF_NAV: [string, NavItem[]][] = [
  ["Overview", [["/", "Dashboard", "dashboard"], ["/analytics", "Analytics", "pulse", "dashboard.view"], ["/messages", "Messages", "chat", "dashboard.view"]]],
  ["Expansion", [["/applications", "Applications", "applications"], ["/approvals", "Approvals", "check"], ["/franchisees", "Franchisees", "franchisees"], ["/territories", "Territories", "territories"], ["/sites", "Sites", "sites"]]],
  ["Contracts", [["/agreements", "Agreements", "agreements"], ["/fees", "Franchise fees", "bank", "finance.view"], ["/renewals", "Renewals", "sync", "dashboard.view"]]],
  ["Operations", [["/projects", "Opening projects", "projects"], ["/launches", "New stores", "flag", "dashboard.view"], ["/royalties", "Royalties", "money", "dashboard.view"], ["/vendors", "Vendors", "box", "dashboard.view"], ["/audits", "Store audits", "audit", "dashboard.view"], ["/documents", "Brand documents", "folder", "dashboard.view"]]],
  ["Admin", [["/admin/users", "Users and roles", "franchisees", "user.admin"], ["/admin/integrations", "Integration health", "pulse", "integration.admin"], ["/admin/activity", "Activity log", "history", "audit.view"], ["/admin/settings", "Settings", "settings", "settings.manage"]]],
];
const PORTAL_NAV: [string, NavItem[]][] = [
  ["My franchise", [["/portal", "Home", "dashboard"], ["/portal/todo", "To do", "check"], ["/portal/messages", "Messages", "chat"], ["/portal/documents", "Documents", "folder"]]],
  ["Getting started", [["/portal/application", "Application", "applications"], ["/portal/site", "Site", "sites"], ["/portal/agreement", "Agreement", "agreements"], ["/portal/funding", "Funding and fees", "bank"]]],
  ["Opening", [["/portal/tasks", "Opening tasks", "projects"], ["/portal/construction", "Construction", "store"], ["/portal/team", "Team", "franchisees"], ["/portal/orders", "Orders", "box"], ["/portal/launch", "Opening day", "flag"]]],
  ["Trading", [["/portal/sales", "Sales reports", "money"], ["/portal/audits", "Audits", "audit"]]],
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

// Notices name staff pages; a franchisee lands on the portal page for the same thing.
const PORTAL_PAGE: [string, string][] = [
  ["action.", "/portal/audits"], ["audit.", "/portal/audits"], ["fee.", "/portal/funding"], ["funding.", "/portal/funding"], ["loan.", "/portal/funding"],
  ["launch.", "/portal/launch"], ["licence.", "/portal/tasks"], ["project.", "/portal/tasks"], ["task.", "/portal/tasks"], ["po.", "/portal/orders"],
  ["royalty.", "/portal/sales"], ["sales.", "/portal/sales"], ["renewal.", "/portal/agreement"], ["agreement.", "/portal/agreement"],
  ["snag.", "/portal/construction"], ["design.", "/portal/construction"], ["training.", "/portal/team"],
];
function portalLink(n: Row): string {
  const link = String(n.link ?? "");
  if (link.startsWith("/portal")) return link;
  return PORTAL_PAGE.find(([k]) => String(n.kind ?? "").startsWith(k))?.[1] ?? "/portal/todo";
}

/** Franchisees with more than one store choose which one the portal pages show. */
function StorePicker() {
  const home = useLoad(() => portalHome(), []);
  const stores = (home.data?.stores ?? []) as Row[];
  if (stores.length < 2) return null;
  const current = String(home.data?.project?.ROWID ?? "");
  return (
    <label className="store-picker"><Icon name="store" size={16} />
      <select aria-label="Store" value={current} onChange={(e) => { setPortalStore(e.target.value); window.location.reload(); }}>
        {stores.map((st) => <option key={String(st.ROWID)} value={String(st.ROWID)}>{st.project_code}</option>)}
      </select>
    </label>
  );
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

const ago = (iso: unknown) => {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(String(iso))) / 60000));
  if (!iso || Number.isNaN(mins)) return "";
  return mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
};

/** Inbox in the top bar: unread count, newest 20, refreshed every minute and on opening. */
function Bell({ portal }: { portal: boolean }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ items: Row[]; unread: number }>({ items: [], unread: 0 });
  const box = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  const refresh = () => api<{ items: Row[]; unread: number }>("GET", "/notifications", { query: { limit: "20" } }).then(setData).catch(() => {});
  useEffect(() => { refresh(); const t = setInterval(refresh, 60_000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (!open) return;
    refresh();
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const go = async (n: Row) => {
    setOpen(false);
    if (n.status !== "READ") await api("POST", `/notifications/${n.ROWID}/read`).catch(() => {});
    if (n.link || portal) nav(portal ? portalLink(n) : String(n.link));
    refresh();
  };
  const readAll = async () => { await api("POST", "/notifications/read-all").catch(() => {}); refresh(); };
  return (
    <div className="bell" ref={box}>
      <button className="icon-btn" onClick={() => setOpen((o) => !o)} aria-label={`Notifications${data.unread ? `, ${data.unread} unread` : ""}`} aria-expanded={open}>
        <Icon name="bell" />{data.unread > 0 && <span className="bell-count">{data.unread > 99 ? "99+" : data.unread}</span>}
      </button>
      {open && (
        <div className="bell-panel" role="dialog" aria-label="Notifications">
          <div className="bell-head"><strong>Notifications</strong>{data.unread > 0 && <button className="btn ghost sm" onClick={readAll}>Mark all read</button>}</div>
          {data.items.length === 0 ? <div className="state">Nothing yet. Approvals, signings, risks and reminders show up here.</div> : (
            <ul>
              {data.items.map((n) => (
                <li key={String(n.ROWID)} className={n.status === "READ" ? "" : "unread"}>
                  <button onClick={() => go(n)}>
                    <span className="bell-title">{n.title}</span>
                    {n.body && <span className="bell-body">{n.body}</span>}
                    <span className="bell-time">{ago(n.created_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

const signOut = () => { const c = (window as any).catalyst; if (c?.auth?.signOut) c.auth.signOut("/app/"); else window.location.href = "/__catalyst/auth/logout"; };

export function Layout({ me, children }: { me: Me; children: ReactNode }) {
  const portal = isPortal(me);
  const groups = portal ? PORTAL_NAV : STAFF_NAV;
  const { brand } = useBrand();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  const role = me.roles[0] ?? "USER";
  // Approvals waiting on this user, refreshed as they move around the app.
  const waiting = useLoad(() => (portal ? Promise.resolve([]) : api<Row[]>("GET", "/approvals", { query: { limit: "100" } })), [loc.pathname]);
  // Portal: open to-dos and unread messages. Staff: conversations with unread franchisee messages.
  const todo = useLoad(() => (portal ? api<Row>("GET", "/portal/todo") : Promise.resolve(null)), [loc.pathname]);
  const threads = useLoad(() => (!portal && can("dashboard.view") ? api<Row[]>("GET", "/messages") : Promise.resolve([])), [loc.pathname]);
  const pending = (todo.data?.items ?? []) as Row[];
  const counts: Record<string, number> = {
    "/approvals": waiting.data?.length ?? 0,
    "/portal/todo": pending.filter((t) => t.level === "overdue" || t.level === "due").length,
    "/portal/messages": parseInt(String(pending.find((t) => t.kind === "message")?.title ?? "0"), 10) || 0,
    "/messages": (threads.data ?? []).filter((t) => Number(t.unread) > 0).length,
  };
  const initials = role.split("_").map((w) => w[0]).join("").slice(0, 2);
  return (
    <div className={`app ${open ? "nav-open" : ""}`}>
      <aside className="sidebar">
        <Link to={portal ? "/portal" : "/"} className="brand">
          <BrandMark brand={brand} />
          <span><strong>{brand.name}</strong><small>{portal ? "Franchisee portal" : brand.tagline ?? "Expansion & openings"}</small></span>
        </Link>
        <nav>
          {groups.map(([group, all]) => [group, all.filter(([, , , perm]) => !perm || can(perm))] as const).filter(([, items]) => items.length).map(([group, items]) => (
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
          {!portal ? <Search /> : <><StorePicker /><div className="grow" /></>}
          <Bell portal={portal} />
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

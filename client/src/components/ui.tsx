import { ReactNode, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, drillHref, Kpi, Row } from "../api";
import { Load } from "../hooks";

const TONE: Record<string, string> = {
  GREEN: "good", AMBER: "warn", RED: "bad", LOW: "good", MEDIUM: "warn", HIGH: "bad",
  COMPLETED: "good", OPENED: "good", SIGNED: "good", ACTIVE: "good", APPROVED: "good", ALLOCATED: "good", AGREEMENT_SIGNED: "good", CALCULATED: "good",
  VERIFIED: "good", RECOMMEND: "good", PENDING: "warn", RETURNED: "warn", CONDITIONAL: "warn", REJECT: "bad", HOT: "good", NURTURE: "warn",
  SCREENING: "info", SITE_VISIT: "info", EVALUATION: "info", FEASIBILITY: "info", PROPOSED: "neutral", LEASE_PENDING: "info", LEASE_SIGNED: "good", READY_FOR_PROJECT: "good", DROPPED: "neutral",
  BLOCKED: "bad", AT_RISK: "bad", REJECTED: "bad", DECLINED: "bad", EXPIRED: "bad", VOIDED: "bad",
  IN_PROGRESS: "info", SENT: "info", VIEWED: "info", ONBOARDING: "info", PLANNING: "info", READY_FOR_OPENING: "info", RESERVED: "info",
  SUBMITTED: "info", UNDER_REVIEW: "info", QUALIFIED: "info", SITE_SUBMITTED: "info", FEASIBILITY_REVIEW: "info", APPROVAL_PENDING: "warn", AGREEMENT_PENDING: "warn", SITE_REQUIRED: "warn",
  ON_HOLD: "warn", PROSPECT: "neutral", DRAFT: "neutral", WITHDRAWN: "neutral", OPEN: "neutral", AVAILABLE: "neutral", CLOSED: "neutral",
};

export const label = (v: unknown) => { const s = String(v ?? "").replace(/_/g, " ").toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); };

/** Status badge with a tone dot; tone comes from the value (GREEN, AT_RISK, SIGNED...). */
export function Pill({ value, tone }: { value: unknown; tone?: string }) {
  if (value === null || value === undefined || value === "") return <span className="muted">—</span>;
  const v = String(value);
  return <span className={`badge ${tone ?? TONE[v] ?? "neutral"}`}><i />{label(v)}</span>;
}

const ICONS: Record<string, string> = {
  dashboard: "M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z",
  applications: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 7V3.5L18.5 9H13zM8 13h8v2H8v-2zm0 4h8v2H8v-2z",
  projects: "M12 2 2 7v2h20V7L12 2zM4 11v7H2v3h20v-3h-2v-7h-3v7h-3v-7h-4v7H7v-7H4z",
  agreements: "M19 3h-4.2A3 3 0 0 0 9.2 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-7 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm-2 14-4-4 1.4-1.4L10 14.2l6.6-6.6L18 9l-8 8z",
  franchisees: "M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13zm8 0c-.3 0-.6 0-1 .1 1.2.8 2 1.9 2 3.4V19h6v-2.5c0-2.3-4.7-3.5-7-3.5z",
  territories: "M20.5 3 15 5.1 9 3 3.4 4.9a.5.5 0 0 0-.4.5V20.5a.5.5 0 0 0 .7.5L9 18.9l6 2.1 5.6-1.9a.5.5 0 0 0 .4-.5V3.5a.5.5 0 0 0-.5-.5zM15 19l-6-2.1V5l6 2.1V19z",
  sites: "M12 2a7 7 0 0 0-7 7c0 5.3 7 13 7 13s7-7.7 7-13a7 7 0 0 0-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z",
  search: "M15.5 14h-.8l-.3-.3A6.5 6.5 0 1 0 14 15.5l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z",
  menu: "M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z",
  logout: "M16 17v-3H9v-4h7V7l5 5-5 5zM14 2a2 2 0 0 1 2 2v2h-2V4H5v16h9v-2h2v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9z",
  money: "M11.8 10.9c-2.3-.6-3-1.2-3-2.1 0-1.1 1-1.9 2.7-1.9 1.8 0 2.4.8 2.5 2.1h2.2c-.1-1.7-1.1-3.3-3.2-3.8V3h-3v2.2C8.1 5.6 6.5 6.9 6.5 8.8c0 2.3 1.9 3.4 4.6 4.1 2.5.6 3 1.5 3 2.4 0 .7-.5 1.8-2.7 1.8-2.1 0-2.9-.9-3-2.1H6.2c.1 2.2 1.8 3.5 3.8 3.9V21h3v-2.1c1.9-.4 3.5-1.5 3.5-3.6 0-2.9-2.4-3.9-4.7-4.4z",
  clock: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm.5 5v5.3l4.5 2.7-.8 1.2L11 13V7h1.5z",
  alert: "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z",
  pulse: "M3 13h4l3-8 4 16 3-8h4v-2h-5.4L14 15 10 0 6 11H3v2z",
  store: "M20 4H4v2h16V4zm1 10v-2l-1-5H4l-1 5v2h1v6h10v-6h4v6h2v-6h1zm-9 4H6v-4h6v4z",
  chevron: "M8.6 16.6 13.2 12 8.6 7.4 10 6l6 6-6 6-1.4-1.4z",
  back: "M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20v-2z",
  sync: "M12 4V1L8 5l4 4V6a6 6 0 0 1 5.3 8.8l1.5 1.5A8 8 0 0 0 12 4zm0 14a6 6 0 0 1-5.3-8.8L5.2 7.7A8 8 0 0 0 12 20v3l4-4-4-4v3z",
  send: "M2 21 23 12 2 3v7l15 2-15 2v7z",
  check: "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z",
  sort: "M7 10l5-5 5 5H7zm0 4h10l-5 5-5-5z",
};

export function Icon({ name, size = 18 }: { name: keyof typeof ICONS | string; size?: number }) {
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d={ICONS[name] ?? ""} fill="currentColor" /></svg>;
}

/** Page title bar: breadcrumbs, title with badges, subtitle and actions on the right. */
export function PageHeader({ title, badges, subtitle, crumbs, actions }: { title: ReactNode; badges?: ReactNode; subtitle?: ReactNode; crumbs?: [string, string?][]; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        {crumbs && (
          <nav className="crumbs" aria-label="Breadcrumb">
            {crumbs.map(([text, to], i) => <span key={i}>{to ? <Link to={to}>{text}</Link> : text}{i < crumbs.length - 1 && <Icon name="chevron" size={14} />}</span>)}
          </nav>
        )}
        <h1>{title}{badges}</h1>
        {subtitle && <p className="subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="header-actions">{actions}</div>}
    </div>
  );
}

export function Panel({ title, action, children, flush, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; flush?: boolean; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      {(title || action) && <header className="panel-head"><h2>{title}</h2>{action}</header>}
      <div className={flush ? "panel-body flush" : "panel-body"}>{children}</div>
    </section>
  );
}

export function KpiTile({ label, kpi, format, icon, tone = "accent", hint }: { label: string; kpi: Kpi; format?: (n: number) => string; icon?: string; tone?: string; hint?: string }) {
  const href = drillHref(kpi);
  const value = kpi.value === null ? "—" : format ? format(kpi.value) : kpi.value.toLocaleString("en-IN");
  const body = (
    <>
      <div className="kpi-top"><span className="kpi-label">{label}</span>{icon && <span className={`kpi-icon ${tone}`}><Icon name={icon} size={16} /></span>}</div>
      <div className="kpi-value">{value}</div>
      {hint && <div className="kpi-hint">{hint}</div>}
    </>
  );
  return href ? <Link className="kpi" to={href} title="View the records">{body}</Link> : <div className="kpi">{body}</div>;
}

export function Progress({ value, rag }: { value: number | null | undefined; rag?: string }) {
  if (value === null || value === undefined || value === ("" as unknown)) return <span className="muted">—</span>;
  const v = Math.max(0, Math.min(100, Number(value)));
  return <span className="progress"><span className="track"><span className={`fill ${TONE[String(rag)] ?? "accent"}`} style={{ width: `${v}%` }} /></span><span className="num">{+v.toFixed(1)}%</span></span>;
}

/** Key facts in a responsive grid of label/value pairs. */
export function Facts({ items }: { items: [string, ReactNode][] }) {
  return <dl className="facts">{items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v ?? "—"}</dd></div>)}</dl>;
}

export interface Column { key: string; label: string; render?: (r: Row) => ReactNode; sort?: (r: Row) => string | number; align?: "right"; width?: string }

/** Sortable, filterable record grid; clicking a row opens it when `href` is given. */
export function DataTable({ rows, columns, href, searchKeys, toolbar, empty = "No records match." }: { rows: Row[]; columns: Column[]; href?: (r: Row) => string; searchKeys?: string[]; toolbar?: ReactNode; empty?: string }) {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    let out = term && searchKeys ? rows.filter((r) => searchKeys.some((k) => String(r[k] ?? "").toLowerCase().includes(term))) : rows;
    if (sort) {
      const col = columns.find((c) => c.key === sort.key)!;
      const val = col.sort ?? ((r: Row) => r[col.key] ?? "");
      out = [...out].sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir; });
    }
    return out;
  }, [rows, q, sort, columns, searchKeys]);
  return (
    <div className="grid-wrap">
      {(searchKeys || toolbar) && (
        <div className="grid-toolbar">
          {searchKeys && <label className="filter-input"><Icon name="search" size={16} /><input type="search" placeholder="Filter these records" value={q} onChange={(e) => setQ(e.target.value)} /></label>}
          {toolbar}
          <span className="grid-count">{shown.length} of {rows.length} records</span>
        </div>
      )}
      <div className="grid-scroll">
        <table className="grid">
          <thead><tr>{columns.map((c) => (
            <th key={c.key} style={{ width: c.width }} className={c.align === "right" ? "right" : ""}>
              <button className="th-sort" onClick={() => setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 }))}>
                {c.label}{sort?.key === c.key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
              </button>
            </th>
          ))}</tr></thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={r.ROWID ?? r.id ?? i} className={href ? "clickable" : ""} onClick={href ? (e) => { if (!(e.target as HTMLElement).closest("a,button")) nav(href(r)); } : undefined}>
                {columns.map((c) => <td key={c.key} className={c.align === "right" ? "right num" : ""}>{c.render ? c.render(r) : r[c.key] ?? <span className="muted">—</span>}</td>)}
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={columns.length} className="grid-empty">{empty}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Loading, error and permission states for any loaded section (spec §23). */
export function Loaded<T>({ load, empty, children, emptyText = "Nothing here yet." }: { load: Load<T>; empty?: (d: T) => boolean; children: (d: T) => ReactNode; emptyText?: string }) {
  if (load.loading && !load.data) return <div className="state"><span className="spinner" />Loading…</div>;
  if (load.error) return <ErrorState error={load.error} retry={load.reload} />;
  if (!load.data || (empty && empty(load.data))) return <div className="state">{emptyText}</div>;
  return <>{children(load.data)}</>;
}

export function ErrorState({ error, retry }: { error: ApiError; retry?: () => void }) {
  const msg = error.code === "ACCESS_DENIED" ? "You don't have access to this." : error.code === "AUTH_REQUIRED" ? "Please sign in again." : error.message;
  return <div className="state error"><Icon name="alert" /> {msg} {retry && <button className="btn ghost sm" onClick={retry}>Try again</button>}</div>;
}

/** Indian short form for tiles: ₹3.15 Cr, ₹45 L. */
export const inrShort = (n: number) => (n >= 1e7 ? `₹${+(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${+(n / 1e5).toFixed(2)} L` : inr(n));
export const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
export const date = (d: unknown) => (d ? new Date(String(d).slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");
export const iso = (d: unknown) => (d ? String(d).slice(0, 10) : "");

const TONE_COLOR: Record<string, string> = { good: "#17b26a", warn: "#f79009", bad: "#f04438", info: "#2e90fa", neutral: "#98a2b3", accent: "#2f5bea" };
export const toneOf = (v: string) => TONE[v] ?? "neutral";

/** Ring chart for a small categorical breakdown, with the total in the middle. */
export function Donut({ parts, size = 132, center, caption }: { parts: { value: number; tone: string }[]; size?: number; center?: ReactNode; caption?: string }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const r = 42, c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="donut" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" width={size} height={size} role="img" aria-label={caption}>
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--neutral-bg)" strokeWidth="11" />
        {total > 0 && parts.filter((p) => p.value > 0).map((p, i) => {
          const len = (p.value / total) * c;
          const el = <circle key={i} cx="50" cy="50" r={r} fill="none" stroke={TONE_COLOR[p.tone] ?? p.tone} strokeWidth="11" strokeDasharray={`${Math.max(len - 1.2, 0.5)} ${c}`} strokeDashoffset={-offset} transform="rotate(-90 50 50)" />;
          offset += len;
          return el;
        })}
      </svg>
      <div className="donut-center"><div>{center ?? <strong>{total}</strong>}{caption && <small>{caption}</small>}</div></div>
    </div>
  );
}

import { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ApiError, drillHref, Kpi } from "../api";
import { Load } from "../hooks";

const TONE: Record<string, string> = {
  GREEN: "good", AMBER: "warn", RED: "bad", LOW: "good", MEDIUM: "warn", HIGH: "bad",
  COMPLETED: "good", OPENED: "good", SIGNED: "good", ACTIVE: "good", APPROVED: "good",
  BLOCKED: "bad", AT_RISK: "bad", REJECTED: "bad", DECLINED: "bad", EXPIRED: "bad",
  IN_PROGRESS: "info", SENT: "info", ONBOARDING: "info", PLANNING: "info",
};

export function Pill({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") return <span className="muted">-</span>;
  const v = String(value);
  return <span className={`pill ${TONE[v] ?? ""}`}>{v.replace(/_/g, " ").toLowerCase()}</span>;
}

export function KpiTile({ label, kpi, format }: { label: string; kpi: Kpi; format?: (n: number) => string }) {
  const href = drillHref(kpi);
  const value = kpi.value === null ? "-" : format ? format(kpi.value) : kpi.value.toLocaleString("en-IN");
  const body = (<><div className="kpi-value">{value}</div><div className="kpi-label">{label}</div></>);
  return href ? <Link className="kpi" to={href} title="See the records">{body}</Link> : <div className="kpi">{body}</div>;
}

/** Loading, error and permission states for any loaded section (spec §23). */
export function Loaded<T>({ load, empty, children }: { load: Load<T>; empty?: (d: T) => boolean; children: (d: T) => ReactNode }) {
  if (load.loading && !load.data) return <div className="state">Loading…</div>;
  if (load.error) return <ErrorState error={load.error} retry={load.reload} />;
  if (!load.data || (empty && empty(load.data))) return <div className="state">Nothing here yet.</div>;
  return <>{children(load.data)}</>;
}

export function ErrorState({ error, retry }: { error: ApiError; retry?: () => void }) {
  const msg = error.code === "ACCESS_DENIED" ? "You don't have access to this." : error.code === "AUTH_REQUIRED" ? "Please sign in again." : error.message;
  return <div className="state error">{msg} {retry && <button className="link" onClick={retry}>Try again</button>}</div>;
}

/** Indian short form for tiles: ₹3.15 Cr, ₹45 L. */
export const inrShort = (n: number) => (n >= 1e7 ? `₹${+(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${+(n / 1e5).toFixed(2)} L` : inr(n));
export const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
export const date = (d: unknown) => (d ? new Date(String(d).slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "-");

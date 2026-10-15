import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError, Row } from "../api";
import { ErrorState, Icon, label, PageHeader, Panel } from "../components/ui";

interface Page { items: Row[]; next_offset: number | null; entity_types: string[]; actors: Row[] }

const ACTIONS: Record<string, string> = {
  "project:built": "Project created", "project:retarget": "Target opening moved", "project:forecast": "Forecast slipped",
  "capex:budget": "Capex budget changed", "capex:spend": "Capex spend recorded", "capex:overrun": "Capex over budget", "capex:sync": "Bills synced from Books",
  "territory:reserve": "Territory reserved", "approval:start": "Approval started", "qualify:override": "Qualification overridden",
  "create:crm": "Created from CRM", "update:crm": "Updated from CRM", "create:agreement": "Agreement created", "agreement:signed": "Agreement signed",
  "transition:send": "Sent for signature", "document:upload": "Document uploaded", "document:add": "Document added",
  "checklist:completed": "Task completed", "checklist:reopened": "Task reopened", "checklist:updated": "Task changed", "checklist:blocked": "Task blocked", "checklist:unblocked": "Task unblocked",
  "integration:retried": "Integration retried", "integration:resolved": "Integration item resolved", "user:invited": "Person added", "user:linked": "First sign-in", "user:updated": "Person changed", "user:deactivated": "Person deactivated", "user:reactivated": "Person reactivated",
  "activate:signed": "Activated on signing", "activate:opened": "Activated on opening", "licence:expired": "Licence expired",
  "design:submitted": "Design sent for approval", "design:approved": "Design approved", "design:changes": "Design changes requested", "photo:added": "Site photo added",
  "snag:raised": "Snag raised", "snag:fixed": "Snag fixed", "snag:closed": "Snag verified", "snag:reopened": "Snag reopened", "snag:waived": "Snag waived",
  "staffing:plan": "Staffing plan changed", "staff:hired": "Person hired", "staff:role": "Role changed", "staff:left": "Person left",
  "training:submitted": "Training sent for sign-off", "training:signed_off": "Training signed off", "training:returned": "Training sent back",
  "fee:added": "Fee instalment added", "fee:changed": "Fee instalment changed", "fee:invoiced": "Fee instalment invoiced", "fee:instalment_paid": "Fee instalment paid", "fee:waived": "Fee instalment waived", "fee:refunded": "Deposit refunded",
  "loan:plan": "Funding plan saved", "loan:applied": "Loan applied for", "loan:sanctioned": "Loan sanctioned", "loan:rejected": "Loan rejected", "loan:disbursed": "Loan disbursed",
  "audit:scheduled": "Audit booked", "audit:completed": "Audit completed", "audit:cancelled": "Audit cancelled",
  "action:submitted": "Corrective action answered", "action:closed": "Corrective action closed", "action:reopened": "Corrective action reopened",
  "site:replaced": "Replacement site", "message:from_franchisee": "Message from franchisee", "message:from_brand": "Message to franchisee", "document:shared": "Document shared", "settings:branding": "Branding changed",
  "launch:planned": "Grand opening set", "launch:moved": "Grand opening moved", "launch:done": "Launch task done", "launch:skipped": "Launch task skipped", "launch:reopened": "Launch task reopened",
  "launch:sales": "Weekly sales reported", "launch:sales_changed": "Weekly sales changed",
  "renewal:in_discussion": "Renewal in discussion", "renewal:renewing": "Renewing", "renewal:not_renewing": "Not renewing", "renewal:renewed": "Renewed",
  "po:placed": "Order placed", "po:confirmed": "Order confirmed", "po:delivered": "Order delivered", "po:cancelled": "Order cancelled",
  "vendor:added": "Vendor added", "vendor:updated": "Vendor updated", "vendor:approved": "Vendor approved", "vendor:suspended": "Vendor suspended",
  "vendor:item_added": "Catalogue item added", "vendor:item_updated": "Catalogue item updated", "vendor:item_retired": "Catalogue item retired", "vendor:item_restored": "Catalogue item restored",
  "royalty:submitted": "Sales reported", "royalty:resubmitted": "Sales report changed", "royalty:returned": "Sales report returned", "royalty:invoiced": "Royalty invoiced", "royalty:paid": "Royalty paid", "royalty:rates": "Royalty rates changed",
};
export const actionLabel = (a: unknown) => {
  const s = String(a ?? "");
  if (ACTIONS[s]) return ACTIONS[s];
  const [verb, what] = s.split(":");
  return what ? `${label(verb)}: ${label(what).toLowerCase()}` : label(verb);
};

const when = (v: unknown) => {
  const s = String(v ?? "");
  const d = new Date(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
};
const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));

const FILTERS = ["entity_type", "actor_user_id", "from", "to", "q", "entity_id"] as const;

/** Who did what, when: the tenant's activity log with filters, paging and CSV export. */
export function AuditLog() {
  const [params, setParams] = useSearchParams();
  const query = Object.fromEntries(FILTERS.map((k) => [k, params.get(k) ?? ""])) as Record<(typeof FILTERS)[number], string>;
  const key = params.toString();
  const [text, setText] = useState(query.q);
  const [page, setPage] = useState<Page | null>(null);
  const [items, setItems] = useState<Row[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<"load" | "more" | "export" | null>("load");
  const [open, setOpen] = useState<string | null>(null);
  const fetchPage = (offset: number, limit = 50) => api<Page>("GET", "/audit", { query: { ...query, offset: String(offset), limit: String(limit) } });
  const fail = (e: unknown) => setError(e instanceof ApiError ? e : new ApiError("NETWORK", String(e), 0));

  useEffect(() => {
    let live = true;
    setBusy("load"); setError(null);
    fetchPage(0).then((p) => { if (live) { setPage(p); setItems(p.items); } }).catch((e) => live && fail(e)).finally(() => live && setBusy(null));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const set = (k: string, v: string) => { const next = new URLSearchParams(params); if (v) next.set(k, v); else next.delete(k); setParams(next); };
  const more = () => { if (page?.next_offset == null) return; setBusy("more"); fetchPage(page.next_offset).then((p) => { setPage(p); setItems((x) => [...x, ...p.items]); }).catch(fail).finally(() => setBusy(null)); };
  const exportCsv = async () => {
    setBusy("export");
    try {
      const all: Row[] = [];
      let offset: number | null = 0;
      while (offset !== null && all.length < 5000) { const p: Page = await fetchPage(offset, 100); all.push(...p.items); offset = p.next_offset; }
      const cell = (v: unknown) => `"${show(v).replace(/"/g, '""')}"`;
      const lines = [["When (UTC)", "Action", "Code", "Record type", "Record", "Record id", "By", "Email", "Details", "Correlation id"].map(cell).join(",")];
      for (const i of all) lines.push([i.at, actionLabel(i.action), i.action, i.entity_type, i.entity?.label, i.entity_id, i.actor?.name, i.actor?.email, JSON.stringify(i.details ?? {}), i.correlation_id].map(cell).join(","));
      const url = URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url; a.download = `activity-log-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { fail(e); } finally { setBusy(null); }
  };
  const filtered = FILTERS.some((k) => query[k]);

  return (
    <>
      <PageHeader title="Activity log" crumbs={[["Admin"], ["Activity log"]]} subtitle="Every change people and integrations made in FranchiseOS, newest first."
        actions={<button className="btn secondary" disabled={!!busy || !items.length} onClick={exportCsv}>{busy === "export" ? "Exporting…" : "Export CSV"}</button>} />
      <Panel flush>
        <div className="grid-toolbar audit-filters">
          <form className="filter-input" onSubmit={(e) => { e.preventDefault(); set("q", text.trim()); }}>
            <Icon name="search" size={16} /><input type="search" placeholder="Search actions and details" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text.trim() !== query.q && set("q", text.trim())} />
          </form>
          <select aria-label="Record type" value={query.entity_type} onChange={(e) => set("entity_type", e.target.value)}>
            <option value="">All records</option>
            {(page?.entity_types ?? []).map((t) => <option key={t} value={t}>{label(t)}</option>)}
          </select>
          <select aria-label="Person" value={query.actor_user_id} onChange={(e) => set("actor_user_id", e.target.value)}>
            <option value="">Anyone</option>
            <option value="SYSTEM:job">Scheduled job</option>
            <option value="SYSTEM:crm">Zoho CRM</option>
            <option value="SYSTEM:sign">Zoho Sign</option>
            {(page?.actors ?? []).map((u) => <option key={String(u.id)} value={String(u.id)}>{String(u.name)}</option>)}
          </select>
          <label className="date-range"><span className="muted">From</span><input type="date" value={query.from} max={query.to || undefined} onChange={(e) => set("from", e.target.value)} /></label>
          <label className="date-range"><span className="muted">To</span><input type="date" value={query.to} min={query.from || undefined} onChange={(e) => set("to", e.target.value)} /></label>
          {filtered && <button className="btn ghost sm" onClick={() => { setText(""); setParams({}); }}>Clear filters</button>}
        </div>
        {error ? <ErrorState error={error} retry={() => setParams(new URLSearchParams(params))} />
          : busy === "load" && !items.length ? <div className="state"><span className="spinner" />Loading…</div>
          : !items.length ? <div className="state">{filtered ? "No activity matches these filters." : "No activity recorded yet."}</div>
          : (
            <div className="grid-scroll">
              <table className="grid audit">
                <thead><tr><th style={{ width: "11rem" }}>When</th><th>What</th><th>Record</th><th>By</th><th style={{ width: "2rem" }} /></tr></thead>
                <tbody>
                  {items.map((i) => {
                    const details = Object.entries((i.details ?? {}) as Row);
                    const expanded = open === i.id;
                    return [
                      <tr key={i.id} className={details.length ? "clickable" : undefined} onClick={() => details.length && setOpen(expanded ? null : String(i.id))}>
                        <td className="nowrap">{when(i.at)}</td>
                        <td>{actionLabel(i.action)}<span className="cell-sub code">{String(i.action)}</span></td>
                        <td>{i.entity?.href ? <Link to={i.entity.href} onClick={(e) => e.stopPropagation()}>{i.entity.label}</Link> : i.entity?.label ?? <span className="muted">#{String(i.entity_id)}</span>}<span className="cell-sub">{label(i.entity_type)}</span></td>
                        <td>{i.actor?.name ?? "—"}{i.actor?.email && <span className="cell-sub">{i.actor.email}</span>}</td>
                        <td className="muted">{details.length > 0 && <span className={`caret ${expanded ? "open" : ""}`}><Icon name="chevron" size={16} /></span>}</td>
                      </tr>,
                      expanded && (
                        <tr key={`${i.id}-d`} className="audit-detail"><td colSpan={5}>
                          <dl className="facts">{details.map(([k, v]) => <div key={k}><dt>{label(k)}</dt><dd>{show(v)}</dd></div>)}</dl>
                          {i.correlation_id && <p className="muted" style={{ margin: ".6rem 0 0", fontSize: ".78rem" }}>Correlation id <span className="code">{String(i.correlation_id)}</span></p>}
                        </td></tr>
                      ),
                    ];
                  })}
                </tbody>
              </table>
            </div>
          )}
        {items.length > 0 && (
          <div className="panel-foot">
            <span className="muted">{items.length} entr{items.length === 1 ? "y" : "ies"} shown</span>
            {page?.next_offset != null && <button className="btn ghost sm" disabled={!!busy} onClick={more}>{busy === "more" ? "Loading…" : "Load more"}</button>}
          </div>
        )}
      </Panel>
    </>
  );
}

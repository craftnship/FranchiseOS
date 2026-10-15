import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, can, Row, zohoLink } from "../api";
import { useAction, useLoad } from "../hooks";
import { Dialog, Field, Form, FormError } from "../components/forms";
import { BooksInvoice, DataTable, date, Facts, Icon, inr, inrShort, label, Loaded, PageHeader, Panel, Pill } from "../components/ui";
import { Conversation, TodoList } from "../components/PortalHub";
import { Score } from "../components/Audits";
import { Variance } from "../components/Pos";

// The franchise partner's record: one page for everything about them across their applications,
// agreements and stores. A multi-unit partner gets the totals here and a link into each store page.

const TABS: [string, string][] = [["overview", "Overview"], ["stores", "Stores"], ["journey", "Applications & agreements"], ["sales", "Sales & royalties"], ["money", "Money"], ["compliance", "Compliance"], ["messages", "Messages"], ["documents", "Documents"], ["activity", "Activity"]];
const BAND_TONE: Record<string, string> = { HEALTHY: "good", WATCH: "warn", AT_RISK: "bad" };
const FEED_TEXT: Record<string, string> = { CONNECTED: "POS feed current", STALE: "POS feed stale", NONE: "No POS feed" };
const REPORT_TONE: Record<string, string> = { PAID: "good", INVOICED: "info", SUBMITTED: "warn", RETURNED: "bad", LATE: "bad", DUE: "neutral" };
const REPORT_TEXT: Record<string, string> = { LATE: "Not reported", DUE: "Not due yet", SUBMITTED: "Waiting for review" };
const TRADING = ["OPENED"];

const openUrl = async (path: string) => { const r = await api<{ url: string }>("GET", path); window.open(r.url, "_blank", "noopener"); };
const n = (v: unknown) => Number(v ?? 0);

export function FranchiseeDetail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "overview";
  const load = useLoad(() => api<Row>("GET", `/franchisees/${id}/overview`), [id]);
  const act = useAction(load.reload);
  const [editing, setEditing] = useState(false);
  const pull = (f: Row) => act.run("crm", () => api<Row>("POST", `/franchisees/${id}/sync-crm`),
    (r) => (r.changed.length ? `Updated ${r.changed.map((k: string) => label(k).toLowerCase()).join(", ")} from CRM.` : `${f.display_name} already matches CRM.`));
  return (
    <Loaded load={load}>{(d) => {
      const f = d.franchisee as Row;
      const k = d.kpis as Row;
      const tabs = TABS.filter(([key]) => key !== "money" || d.finance);
      const crm = zohoLink.crmAccount(f.zoho_account_id);
      return (
        <>
          <PageHeader title={String(f.display_name ?? f.franchise_code)} badges={<><Pill value={f.status} />{f.franchise_type && <Pill value={f.franchise_type} tone="neutral" />}</>}
            crumbs={[["Expansion"], ["Franchisees", "/franchisees"], [String(f.franchise_code)]]}
            subtitle={[f.legal_name && f.legal_name !== f.display_name ? f.legal_name : null, f.email, f.phone, f.since ? `Partner since ${date(f.since)}` : null].filter(Boolean).join(" · ")}
            actions={<>
              {can("dashboard.view") && <Link className="btn secondary" to={`/messages/${f.ROWID}`}><Icon name="chat" size={16} />Message</Link>}
              {crm && <a className="btn secondary" href={crm} target="_blank" rel="noreferrer">Open in CRM</a>}
              {can("application.review") && (f.zoho_lead_id || f.zoho_account_id) && <button className="btn secondary" disabled={!!act.busy} onClick={() => pull(f)}><Icon name="sync" size={16} />{act.busy === "crm" ? "Checking…" : "Refresh from CRM"}</button>}
              {can("application.review") && <button className="btn secondary" onClick={() => setEditing(true)}>Edit</button>}
            </>} />
          {act.notice && <div className="notice ok"><Icon name="check" />{act.notice}</div>}
          {act.error && !editing && <FormError error={act.error} />}
          <Kpis k={k} finance={!!d.finance} />
          <div className="chips" style={{ marginBottom: "1rem" }}>
            {tabs.map(([key, text]) => <button key={key} className={`chip ${tab === key ? "on" : ""}`} onClick={() => setParams(key === "overview" ? {} : { tab: key })}>{text}</button>)}
          </div>
          {tab === "overview" && <Overview d={d} />}
          {tab === "stores" && <Stores stores={d.stores as Row[]} />}
          {tab === "journey" && <Journey d={d} />}
          {tab === "sales" && <Sales d={d} />}
          {tab === "money" && d.finance && <Money d={d} />}
          {tab === "compliance" && <Compliance d={d} />}
          {tab === "messages" && <Messages id={String(id)} />}
          {tab === "documents" && <Documents d={d} />}
          {tab === "activity" && <Activity rows={d.activity as Row[]} />}
          {editing && <EditDialog f={f} onClose={() => { setEditing(false); act.clear(); }} onSaved={() => { setEditing(false); load.reload(); act.say("Franchisee details saved."); }} />}
        </>
      );
    }}</Loaded>
  );
}

function Tile({ text, value, hint, tone = "accent", icon, to }: { text: string; value: React.ReactNode; hint?: React.ReactNode; tone?: string; icon: string; to?: string }) {
  const body = <>
    <div className="kpi-top"><span className="kpi-label">{text}</span><span className={`kpi-icon ${tone}`}><Icon name={icon} size={16} /></span></div>
    <div className="kpi-value">{value}</div>
    {hint && <div className="kpi-hint">{hint}</div>}
  </>;
  return to ? <Link className="kpi" to={to}>{body}</Link> : <div className="kpi">{body}</div>;
}

/** The numbers a manager wants at a glance, summed across every store the partner owns. */
function Kpis({ k, finance }: { k: Row; finance: boolean }) {
  const s = k.stores as Row, sales = k.sales as Row, roy = k.royalty as Row, h = k.health as Row, c = k.compliance as Row, owed = k.outstanding as Row | null;
  const storesText = [s.trading ? `${s.trading} trading` : null, s.opening ? `${s.opening} opening` : null, s.pipeline ? `${s.pipeline} in pipeline` : null].filter(Boolean).join(" · ") || "No stores yet";
  return (
    <div className="kpis">
      <Tile text="Stores" icon="store" value={n(s.trading) + n(s.opening)} hint={storesText} to="?tab=stores" />
      <Tile text={`Sales ${sales.last_month?.label ?? "last month"}`} icon="money" value={n(sales.last_month?.net_sales) ? inrShort(n(sales.last_month.net_sales)) : "—"}
        hint={`${inrShort(n(sales.three_months))} over 3 months · ${FEED_TEXT[String(sales.feed)] ?? ""}`} tone={sales.feed === "STALE" ? "warn" : "accent"} to="?tab=sales" />
      <Tile text="Royalty billed, 3 months" icon="bank" value={n(roy.billed_three_months) ? inrShort(n(roy.billed_three_months)) : "—"}
        hint={roy.waiting ? `${roy.waiting} report${roy.waiting === 1 ? "" : "s"} waiting for review${roy.strayed ? `, ${roy.strayed} off POS` : ""}` : roy.rates?.royalty_pct != null ? `${roy.rates.royalty_pct}% royalty + ${roy.rates.marketing_fund_pct ?? 0}% fund` : "No trading store"} tone={roy.strayed ? "warn" : "accent"} to="?tab=sales" />
      {finance
        ? <Tile text="Outstanding" icon="clock" value={owed && n(owed.total) ? inrShort(n(owed.total)) : "—"} hint={owed && owed.overdue_count ? `${inrShort(n(owed.overdue))} overdue, oldest ${owed.oldest_days} days` : "Nothing overdue"} tone={owed && owed.overdue_count ? "bad" : "good"} to="?tab=money" />
        : <Tile text="Agreement" icon="agreements" value={c.agreement_expiry ? date(c.agreement_expiry) : "—"} hint={c.agreement_expiry ? "Current term ends" : "No signed agreement"} to="?tab=journey" />}
      <Tile text="Store health" icon="pulse" value={h.worst_band ? label(h.worst_band) : "—"} hint={h.scored ? `Average ${h.average_score} across ${h.scored} store${h.scored === 1 ? "" : "s"}` : "Not scored yet"} tone={BAND_TONE[String(h.worst_band)] ?? "accent"} to="?tab=stores" />
      <Tile text="Last audit" icon="audit" value={c.last_audit ? `${c.last_audit.score}%` : "—"} hint={c.last_audit ? `${label(c.last_audit.rating)} · ${date(c.last_audit.completed_at)}` : "No audit yet"} tone={c.last_audit ? { GREEN: "good", AMBER: "warn", RED: "bad" }[String(c.last_audit.rating)] ?? "accent" : "accent"} to="?tab=compliance" />
      <Tile text="Open actions" icon="alert" value={n(c.open_actions)} hint={c.lapsing_licences ? `${c.lapsing_licences} licence${c.lapsing_licences === 1 ? "" : "s"} lapsing soon` : "Licences current"} tone={n(c.open_actions) ? "warn" : "good"} to="?tab=compliance" />
      {finance && <Tile text="Agreement" icon="agreements" value={c.agreement_expiry ? date(c.agreement_expiry) : "—"} hint={c.agreement_expiry ? "Current term ends" : "No signed agreement"} to="?tab=journey" />}
    </div>
  );
}

function Overview({ d }: { d: Row }) {
  const sales = (d.kpis as Row).sales as Row;
  const stores = (d.stores as Row[]).filter((s) => TRADING.includes(String(s.status)));
  return (
    <div className="row c21">
      <div className="stack">
        <Panel title="Needs attention" flush><TodoList items={d.attention as Row[]} empty="Nothing waiting on this franchisee." /></Panel>
        <Panel title="Net sales by month" flush>
          <DataTable rows={(sales.by_month as Row[]).map((m) => ({ ...m, ROWID: m.period }))} empty="No trading months yet." columns={[
            { key: "label", label: "Month" },
            { key: "net_sales", label: "Net sales", align: "right", render: (m) => n(m.net_sales) ? inr(n(m.net_sales)) : "—" },
          ]} />
          {n(sales.month_to_date) > 0 && <div className="panel-body muted">This month so far: {inr(n(sales.month_to_date))}, from the POS feed.</div>}
        </Panel>
      </div>
      <div className="stack">
        <Panel title="Stores trading" flush>
          {stores.length ? stores.map((s) => (
            <div key={String(s.ROWID)} className="panel-body" style={{ borderBottom: "1px solid var(--border)" }}>
              <Link className="code" to={`/projects/${s.ROWID}`}>{s.project_code}</Link> <span className="muted">{s.city}</span>
              <div className="cell-sub">Health {s.health_score ?? "—"} <Pill value={s.health_band ?? "Not scored"} tone={BAND_TONE[String(s.health_band)]} /> · {FEED_TEXT[String(s.pos_status)]}{s.pos_last_day ? ` (${date(s.pos_last_day)})` : ""}</div>
            </div>
          )) : <div className="state">No store is trading yet.</div>}
        </Panel>
        <Panel title="Contact">
          <Facts items={[["Email", d.franchisee.email], ["Phone", d.franchisee.phone], ["Portal logins", String(d.franchisee.portal_users ?? 0)], ["CRM", d.franchisee.zoho_account_id ? "Account linked" : d.franchisee.zoho_lead_id ? "Lead linked" : "Not linked"], ["Books", d.franchisee.zoho_books_customer_id ? "Customer linked" : "Not linked"]]} />
        </Panel>
      </div>
    </div>
  );
}

function Stores({ stores }: { stores: Row[] }) {
  return (
    <Panel flush>
      <DataTable rows={stores} href={(s) => `/projects/${s.ROWID}`} empty="No stores yet." columns={[
        { key: "project_code", label: "Store", render: (s) => <><span className="code">{s.project_code}</span>{s.city && <span className="cell-sub">{s.city}</span>}</> },
        { key: "status", label: "Status", render: (s) => <Pill value={s.status} /> },
        { key: "actual_opening_date", label: "Opened / target", render: (s) => s.actual_opening_date ? date(s.actual_opening_date) : <>{date(s.target_opening_date)}<span className="cell-sub">target</span></> },
        { key: "health_score", label: "Health", render: (s) => s.health_band ? <>{s.health_score} <Pill value={s.health_band} tone={BAND_TONE[String(s.health_band)]} /></> : s.readiness_score != null ? <>{s.readiness_score}% <Pill value={s.readiness_rag} /><span className="cell-sub">readiness</span></> : "—" },
        { key: "pos_status", label: "POS feed", render: (s) => TRADING.includes(String(s.status)) ? <>{FEED_TEXT[String(s.pos_status)]}{s.pos_last_day && <span className="cell-sub">to {date(s.pos_last_day)}</span>}</> : "—" },
        { key: "risk_level", label: "Risk", render: (s) => s.risk_level ? <Pill value={s.risk_level} /> : "—" },
      ]} />
    </Panel>
  );
}

function Journey({ d }: { d: Row }) {
  return (
    <div className="stack">
      <Panel title="Applications" flush>
        <DataTable rows={d.applications as Row[]} href={(a) => `/applications/${a.ROWID}`} empty="No applications." columns={[
          { key: "application_code", label: "Application", render: (a) => <span className="code">{a.application_code}</span> },
          { key: "status", label: "Stage", render: (a) => <Pill value={a.status} /> },
          { key: "preferred_city", label: "Location", render: (a) => [a.preferred_city, a.preferred_state].filter(Boolean).join(", ") || "—" },
          { key: "application_type", label: "Format", render: (a) => label(a.application_type ?? "") },
          { key: "CREATEDTIME", label: "Created", render: (a) => date(a.CREATEDTIME) },
        ]} />
      </Panel>
      <Panel title="Sites" flush>
        <DataTable rows={d.sites as Row[]} href={(s) => `/sites/${s.ROWID}`} empty="No sites proposed." columns={[
          { key: "site_code", label: "Site", render: (s) => <span className="code">{s.site_code}</span> },
          { key: "city", label: "City", render: (s) => [s.city, s.state].filter(Boolean).join(", ") },
          { key: "site_score", label: "Score", align: "right", render: (s) => s.site_score ?? "—" },
          { key: "status", label: "Status", render: (s) => <Pill value={s.status} /> },
        ]} />
      </Panel>
      <Panel title="Agreements" flush>
        <DataTable rows={d.agreements as Row[]} href={(g) => `/agreements/${g.ROWID}`} empty="No agreement yet." columns={[
          { key: "agreement_code", label: "Agreement", render: (g) => <span className="code">{g.agreement_code}</span> },
          { key: "status", label: "Status", render: (g) => <Pill value={g.status} /> },
          { key: "signed_at", label: "Signed", render: (g) => date(g.signed_at) },
          { key: "expiry_date", label: "Term", render: (g) => g.effective_date ? <>{date(g.effective_date)} to {date(g.expiry_date)}{g.renewal_status && <span className="cell-sub">Renewal: {label(g.renewal_status)}{g.renewed_until ? ` until ${date(g.renewed_until)}` : ""}</span>}</> : "—" },
          ...(d.finance ? [{ key: "fee_status", label: "Franchise fee", render: (g: Row) => g.fee_status ? <>{label(g.fee_status)}{g.fee_total != null && <span className="cell-sub">{inr(n(g.fee_total))}{n(g.fee_balance) ? `, ${inr(n(g.fee_balance))} due` : ""}</span>}</> : "—" }] : []),
        ]} />
      </Panel>
    </div>
  );
}

function Sales({ d }: { d: Row }) {
  const r = d.royalties as Row;
  const months = r.months as Row[];
  const totals = r.totals as Row;
  const rates = (d.kpis as Row).royalty.rates as Row | null;
  return (
    <div className="stack">
      <dl className="summary">
        <div><dt>Net sales invoiced</dt><dd>{inrShort(n(totals.invoiced_net_sales))}</dd></div>
        <div><dt>Royalty billed</dt><dd>{inrShort(n(totals.royalty))}{rates?.royalty_pct != null && <span className="cell-sub">{rates.royalty_pct}% of net sales</span>}</dd></div>
        <div><dt>Marketing fund</dt><dd>{inrShort(n(totals.marketing))}{rates?.marketing_fund_pct != null && <span className="cell-sub">{rates.marketing_fund_pct}% of net sales</span>}</dd></div>
        <div><dt>{d.finance ? "Royalty outstanding" : "Waiting for review"}</dt><dd>{d.finance ? inrShort(n(totals.outstanding)) : months.filter((m) => m.status === "SUBMITTED").length}</dd></div>
      </dl>
      <Panel title="Monthly reports across stores" flush>
        <DataTable rows={months.map((m) => ({ ...m, ROWID: `${m.project_id}:${m.period}` }))} empty="No trading months yet." columns={[
          { key: "label", label: "Month", render: (m) => <>{m.label}<span className="cell-sub">{m.project_code}</span></> },
          { key: "pos_net_sales", label: "POS net", align: "right", render: (m) => m.pos_net_sales != null ? inr(n(m.pos_net_sales)) : "—" },
          { key: "reported_net_sales", label: "Reported", align: "right", render: (m) => m.reported_net_sales != null ? inr(n(m.reported_net_sales)) : "—" },
          { key: "variance_pct", label: "Variance", render: (m) => <Variance pct={m.variance_pct} /> },
          { key: "royalty_amount", label: "Royalty + fund", align: "right", render: (m) => m.royalty_amount != null ? inr(n(m.royalty_amount) + n(m.marketing_amount)) : "—" },
          { key: "status", label: "Status", render: (m) => <><Pill value={REPORT_TEXT[String(m.status)] ?? m.status} tone={REPORT_TONE[String(m.status)]} />{m.invoice_number && <span className="cell-sub"><BooksInvoice id={m.zoho_books_invoice_id} number={m.invoice_number} />{m.status === "INVOICED" && m.invoice_due_date ? `, due ${date(m.invoice_due_date)}` : ""}</span>}</> },
        ]} />
      </Panel>
      <p className="muted">Approve, return and invoice reports on the <Link to="/royalties">Royalties</Link> screen; each store page shows its own ledger and POS days.</p>
    </div>
  );
}

function Money({ d }: { d: Row }) {
  const m = d.money as Row;
  const owed = m.outstanding as Row;
  return (
    <div className="stack">
      <dl className="summary">
        <div><dt>Outstanding</dt><dd>{inr(n(owed.total))}<span className="cell-sub">{owed.count} item{owed.count === 1 ? "" : "s"}</span></dd></div>
        <div><dt>Overdue</dt><dd style={{ color: owed.overdue_count ? "var(--bad)" : undefined }}>{inr(n(owed.overdue))}{owed.overdue_count ? <span className="cell-sub">oldest {owed.oldest_days} days</span> : null}</dd></div>
        <div><dt>Royalty paid to date</dt><dd>{inr(n(m.paid_royalty))}</dd></div>
        <div><dt>Franchise fee</dt><dd>{(m.fees as Row[])[0] ? <>{label((m.fees as Row[])[0].fee_status ?? "Not raised")}<span className="cell-sub">{inr(n((m.fees as Row[])[0].fee_total))}</span></> : "—"}</dd></div>
      </dl>
      <Panel title="Owed now" flush action={<Link to="/collections">Collections</Link>}>
        <DataTable rows={m.collections as Row[]} empty="Nothing is owed." columns={[
          { key: "label", label: "Item", render: (c) => <>{c.label ?? (c.period ? `Royalty ${c.period}` : label(c.kind))}<span className="cell-sub">{c.project_code ?? ""}{c.invoice_number ? ` · ` : ""}<BooksInvoice id={c.zoho_books_invoice_id} number={c.invoice_number} fallback="" /></span></> },
          { key: "amount", label: "Due", align: "right", render: (c) => inr(n(c.amount)) },
          { key: "due_date", label: "Due on", render: (c) => date(c.due_date) },
          { key: "status", label: "Status", render: (c) => <Pill value={c.status} tone={c.status === "DISPUTED" ? "bad" : c.status === "PROMISED" ? "info" : "warn"} /> },
          { key: "reminders_sent", label: "Reminders", align: "right", render: (c) => `${c.reminders_sent ?? 0}${c.escalated ? " · escalated" : ""}` },
        ]} />
      </Panel>
      <Panel title="Fees and instalments" flush>
        <DataTable rows={m.instalments as Row[]} empty="No fee schedule yet." columns={[
          { key: "label", label: "Instalment", render: (i) => <>{i.label}<span className="cell-sub">{i.project_code ?? ""}</span></> },
          { key: "amount", label: "Amount", align: "right", render: (i) => inr(n(i.amount)) },
          { key: "due_on", label: "Due", render: (i) => i.due_on ? date(i.due_on) : label(i.raise_on ?? "") },
          { key: "status", label: "Status", render: (i) => <><Pill value={i.status} />{i.invoice_number && <span className="cell-sub"><BooksInvoice id={i.zoho_books_invoice_id} number={i.invoice_number} /></span>}</> },
          { key: "paid_on", label: "Paid", render: (i) => date(i.paid_on) },
        ]} />
      </Panel>
    </div>
  );
}

function Compliance({ d }: { d: Row }) {
  const c = d.compliance as Row;
  return (
    <div className="stack">
      <Panel title="Audits" flush action={<Link to="/audits">All audits</Link>}>
        <DataTable rows={c.audits as Row[]} href={(a) => `/audits/${a.ROWID}`} empty="No audit yet." columns={[
          { key: "audit_code", label: "Audit", render: (a) => <><span className="code">{a.audit_code}</span><span className="cell-sub">{a.project_code}</span></> },
          { key: "audit_type", label: "Type", render: (a) => label(a.audit_type) },
          { key: "status", label: "Status", render: (a) => <Pill value={a.status} /> },
          { key: "completed_at", label: "Date", render: (a) => date(a.completed_at ?? a.planned_for) },
          { key: "score", label: "Score", render: (a) => <Score score={a.score} rating={a.rating} /> },
        ]} />
      </Panel>
      <Panel title="Open corrective actions" flush>
        <DataTable rows={c.open_actions as Row[]} href={(a) => `/audits/${a.audit_id}`} empty="No open actions." columns={[
          { key: "description", label: "Action", render: (a) => <>{String(a.description).split(":")[0]}<span className="cell-sub">{a.project_code}</span></> },
          { key: "severity", label: "Severity", render: (a) => <Pill value={a.severity} tone={a.severity === "CRITICAL" ? "bad" : "warn"} /> },
          { key: "due_date", label: "Due", render: (a) => <span style={{ color: a.overdue ? "var(--bad)" : undefined }}>{date(a.due_date)}{a.overdue ? " · overdue" : ""}</span> },
          { key: "status", label: "Status", render: (a) => <Pill value={a.status === "SUBMITTED" ? "Waiting for auditor" : "Open"} tone={a.status === "SUBMITTED" ? "info" : "warn"} /> },
        ]} />
      </Panel>
      <div className="row c2">
        <Panel title="Licences" flush>
          <DataTable rows={c.licences as Row[]} empty="No licences recorded." columns={[
            { key: "name", label: "Licence", render: (l) => <>{l.name}<span className="cell-sub">{l.project_code}</span></> },
            { key: "status", label: "Status", render: (l) => <Pill value={l.status} /> },
            { key: "expires_on", label: "Expires", render: (l) => l.expires_on ? <span style={{ color: (c.lapsing as Row[]).some((x) => x.ROWID === l.ROWID) ? "var(--warn)" : undefined }}>{date(l.expires_on)}</span> : "—" },
          ]} />
        </Panel>
        <Panel title="Leases" flush>
          <DataTable rows={c.leases as Row[]} href={(l) => `/sites/${l.site_id}`} empty="No lease recorded." columns={[
            { key: "site_code", label: "Site", render: (l) => <>{l.site_code}<span className="cell-sub">{l.city}</span></> },
            { key: "monthly_rent", label: "Rent", align: "right", render: (l) => l.monthly_rent ? inr(n(l.monthly_rent)) : "—" },
            { key: "expiry_date", label: "Ends", render: (l) => <>{date(l.expiry_date)}{l.notice_by && <span className="cell-sub">notice by {date(l.notice_by)}</span>}</> },
            { key: "status", label: "Status", render: (l) => <Pill value={l.status} tone={l.status === "SIGNED" ? "good" : "warn"} /> },
          ]} />
        </Panel>
      </div>
    </div>
  );
}

function Messages({ id }: { id: string }) {
  const load = useLoad(() => api<Row>("GET", `/franchisees/${id}/messages`), [id]);
  return (
    <Loaded load={load}>{(d) => {
      const f = d.franchisee as Row;
      const noLogin = Number(f.portal_users ?? 0) === 0;
      const undelivered = !noLogin ? undefined : !f.email ? "Not emailed: no email on file" : !f.email_enabled ? "Not emailed: email is not set up" : undefined;
      return <Panel flush action={<Link to={`/messages/${id}`}>Open in Messages</Link>}><Conversation messages={d.messages as Row[]} me="BRAND" about={d.about as Row[]} undelivered={undelivered} onSend={(b) => api("POST", `/franchisees/${id}/messages`, { body: b }).then(load.reload)} /></Panel>;
    }}</Loaded>
  );
}

function Documents({ d }: { d: Row }) {
  const act = useAction();
  const docs = d.documents as Row;
  return (
    <div className="stack">
      <FormError error={act.error} />
      <Panel title="Application documents" flush>
        <DataTable rows={docs.application as Row[]} empty="No documents uploaded." columns={[
          { key: "document_type", label: "Document", render: (x) => <>{label(x.document_type)}<span className="cell-sub">{x.application_code}{x.document_number ? ` · ${x.document_number}` : ""}</span></> },
          { key: "status", label: "Status", render: (x) => <Pill value={x.status} /> },
          { key: "expiry_date", label: "Expires", render: (x) => date(x.expiry_date) },
          { key: "_open", label: "", render: (x) => x.file_ref ? (/^https?:\/\//.test(String(x.file_ref)) ? <a href={x.file_ref} target="_blank" rel="noreferrer">Open link</a> : <button className="btn ghost sm" disabled={act.busy === `a${x.ROWID}`} onClick={(e) => { e.stopPropagation(); act.run(`a${x.ROWID}`, () => openUrl(`/applications/${x.application_id}/documents/${x.ROWID}/download`)); }}>Open</button>) : "—" },
        ]} />
      </Panel>
      <Panel title="Shared with this franchisee" flush action={<Link to="/documents">Brand library</Link>}>
        <DataTable rows={docs.shared as Row[]} empty="Nothing shared beyond the brand library." columns={[
          { key: "title", label: "Document", render: (x) => <>{x.title}<span className="cell-sub">{label(x.category ?? "")}</span></> },
          { key: "CREATEDTIME", label: "Shared", render: (x) => date(x.CREATEDTIME) },
          { key: "_open", label: "", render: (x) => <button className="btn ghost sm" disabled={act.busy === `d${x.ROWID}`} onClick={(e) => { e.stopPropagation(); act.run(`d${x.ROWID}`, () => openUrl(`/documents/${x.ROWID}/file`)); }}>Open</button> },
        ]} />
      </Panel>
    </div>
  );
}

function Activity({ rows }: { rows: Row[] }) {
  return (
    <Panel flush action={<Link to="/admin/activity">Full activity log</Link>}>
      <DataTable rows={rows.map((r) => ({ ...r, ROWID: r.id }))} empty="No activity yet." columns={[
        { key: "at", label: "When", render: (r) => <>{date(r.at)}<span className="cell-sub">{String(r.at ?? "").slice(11, 16)}</span></> },
        { key: "action", label: "What", render: (r) => <>{label(String(r.action).replace(/[:.]/g, " "))}<span className="cell-sub">{label(r.entity_type)}{r.project_code ? ` ${r.project_code}` : ""}</span></> },
        { key: "actor", label: "By" },
        { key: "details", label: "Details", render: (r) => { const dd = r.details as Row; const keys = Object.keys(dd ?? {}).filter((k) => typeof dd[k] !== "object").slice(0, 3); return keys.length ? <span className="muted">{keys.map((k) => `${label(k).toLowerCase()}: ${dd[k]}`).join(" · ")}</span> : "—"; } },
      ]} />
    </Panel>
  );
}

const EDIT_FIELDS = ["display_name", "legal_name", "email", "phone", "franchise_type"] as const;

function EditDialog({ f, onClose, onSaved }: { f: Row; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState<Record<string, string>>(Object.fromEntries([...EDIT_FIELDS.map((k) => [k, String(f[k] ?? "")]), ["status", String(f.status ?? "PROSPECT")]]));
  const act = useAction();
  const set = (k: string) => (e: { target: { value: string } }) => setV((p) => ({ ...p, [k]: e.target.value }));
  const save = async () => {
    const body: Row = {};
    for (const k of [...EDIT_FIELDS, "status"]) if (v[k] !== String(f[k] ?? "")) body[k] = v[k].trim();
    if (!Object.keys(body).length) return onClose();
    const r = await act.run("save", () => api<Row>("PATCH", `/franchisees/${f.ROWID}`, { body }));
    if (r) onSaved();
  };
  return (
    <Dialog title="Edit franchisee" subtitle="Contact details are copied from CRM after intake; edits here are kept until the next CRM change." onClose={onClose}>
      <Form onSubmit={save} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={!!act.busy}>{act.busy ? "Saving…" : "Save"}</button></>}>
        <Field label="Name" span><input value={v.display_name} onChange={set("display_name")} required maxLength={200} autoFocus /></Field>
        <Field label="Legal name" span><input value={v.legal_name} onChange={set("legal_name")} maxLength={200} /></Field>
        <Field label="Email" neededFor="to send the agreement"><input type="email" value={v.email} onChange={set("email")} /></Field>
        <Field label="Phone"><input value={v.phone} onChange={set("phone")} maxLength={30} /></Field>
        <Field label="Format"><input value={v.franchise_type} onChange={set("franchise_type")} maxLength={50} /></Field>
        <Field label="Status"><select value={v.status} onChange={set("status")}>{["PROSPECT", "ACTIVE", "INACTIVE"].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
        <div className="span"><FormError error={act.error} /></div>
      </Form>
    </Dialog>
  );
}

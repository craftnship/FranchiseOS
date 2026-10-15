import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError, can, Row } from "../api";
import { useAction, useLoad } from "../hooks";
import { Dialog, Field, Form, FormError } from "./forms";
import { DataTable, date, Icon, inr, Loaded, PageHeader, Panel, Pill } from "./ui";

// The POS sales feed (docs/pos-sales.md): a franchisee connects their own Zoho Books from the portal
// home, or uploads a daily CSV; staff see each store's POS days beside what was reported.

export const FEED_TONE: Record<string, string> = { CONNECTED: "good", STALE: "warn", NONE: "neutral" };
export const FEED_TEXT: Record<string, string> = { CONNECTED: "POS connected", STALE: "POS feed stale", NONE: "No POS feed" };
const CONN_TEXT: Record<string, string> = { ACTIVE: "Connected", FAILING: "Needs reconnecting", PENDING: "Choose organisation", DISCONNECTED: "Disconnected" };
const CONN_TONE: Record<string, string> = { ACTIVE: "good", FAILING: "bad", PENDING: "warn", DISCONNECTED: "neutral" };
const money = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : inr(Number(v)));

/** Signed −12% in red, +3% in amber-ish, within tolerance plain. */
export function Variance({ pct, tolerance }: { pct: unknown; tolerance?: number }) {
  if (pct === null || pct === undefined) return <span className="muted">—</span>;
  const v = Number(pct);
  const beyond = tolerance !== undefined && Math.abs(v) > tolerance;
  return <span style={{ color: beyond ? "var(--bad)" : undefined, fontWeight: beyond ? 600 : undefined }}>{v > 0 ? "+" : ""}{v}%</span>;
}

export const FeedPill = ({ status }: { status: unknown }) => <Pill value={FEED_TEXT[String(status)] ?? "No POS feed"} tone={FEED_TONE[String(status)] ?? "neutral"} />;

/** Portal home: the franchisee's Zoho Books connection and each store's feed. */
export function ConnectCard() {
  const load = useLoad(() => api<Row>("GET", "/portal/connections"), []);
  const act = useAction(load.reload);
  const [confirm, setConfirm] = useState<Row | null>(null);
  const connect = () => act.run("start", async () => { const r = await api<{ url: string }>("POST", "/portal/connections/zoho/start"); window.location.assign(r.url); return r; });
  const pull = (c: Row) => act.run("pull", () => api<Row>("POST", `/portal/connections/${c.ROWID}/pull`), (r) => `Pulled ${r.days} day${r.days === 1 ? "" : "s"} of sales for ${r.stores} store${r.stores === 1 ? "" : "s"}.`);
  const disconnect = (c: Row) => act.run("off", () => api<Row>("DELETE", `/portal/connections/${c.ROWID}`), "Disconnected. Your past sales stay; new days stop coming in.").then(() => setConfirm(null));
  return (
    <Loaded load={load}>{(d) => {
      const conns = d.connections as Row[];
      const stores = d.stores as Row[];
      const c = conns.find((x) => x.status === "ACTIVE" || x.status === "FAILING" || x.status === "PENDING") ?? null;
      if (!stores.length) return null;
      return (
        <Panel title={<>Your Zoho Books{c && <Pill value={CONN_TEXT[String(c.status)] ?? c.status} tone={CONN_TONE[String(c.status)]} />}</>}
          action={c ? <span className="panel-actions">
            {c.status !== "PENDING" && <button className="btn ghost sm" disabled={!!act.busy} onClick={() => pull(c)}><Icon name="sync" size={14} />{act.busy === "pull" ? "Pulling…" : "Pull now"}</button>}
            <button className="btn danger-ghost sm" disabled={!!act.busy} onClick={() => setConfirm(c)}>Disconnect</button>
          </span> : d.can_connect ? <button className="btn sm" disabled={!!act.busy} onClick={connect}>{act.busy === "start" ? "Opening Zoho…" : "Connect Zoho Books"}</button> : null}>
          {act.notice && <div className="notice ok"><Icon name="check" />{act.notice}</div>}
          {act.error && <FormError error={act.error} />}
          {c ? <>
            {c.status === "FAILING" && <div className="notice warn"><Icon name="alert" /><span>{String(c.last_error ?? "The connection stopped working.")} <button className="link-btn" onClick={connect}>Reconnect</button>.</span></div>}
            {c.status === "PENDING" && <div className="notice warn"><Icon name="alert" /><span>Your Zoho account runs several organisations. <Link to="/connect/zoho/callback?pick=1">Choose the store's</Link>.</span></div>}
            {c.status === "ACTIVE" && c.last_error && <div className="notice warn"><Icon name="alert" /><span>{String(c.last_error)}</span></div>}
            <p className="muted" style={{ margin: "0 0 .5rem" }}>{c.org_name ? `${c.org_name}. ` : ""}We read daily sales totals only (invoices and credit notes), never customer details. Last pulled {c.last_pulled_at ? date(c.last_pulled_at) : "never"}.</p>
          </> : <p className="muted" style={{ margin: "0 0 .5rem" }}>{d.can_connect
            ? "Connect the Zoho Books your POS posts to and your daily sales flow in on their own; royalty is then worked out from what the POS recorded. We only read sales totals, never customer details, and you can disconnect at any time."
            : "Upload your daily sales as a CSV from the Sales reports page until the Zoho Books connection is switched on."}</p>}
          <ul className="plain">
            {stores.map((s) => <li key={String(s.ROWID)} className="stat-line"><span className="code">{String(s.project_code)}</span><FeedPill status={s.feed} />{s.last_day ? <span className="muted">last day {date(s.last_day)}</span> : <Link to="/portal/sales">Upload daily sales</Link>}</li>)}
          </ul>
          {confirm && <Dialog title="Disconnect Zoho Books?" subtitle="New days stop coming in and royalty goes back to your monthly reports." onClose={() => setConfirm(null)}>
            <Form onSubmit={() => disconnect(confirm)} footer={<><button type="button" className="btn secondary" onClick={() => setConfirm(null)}>Keep connected</button><button className="btn danger" disabled={!!act.busy}>{act.busy === "off" ? "Disconnecting…" : "Disconnect"}</button></>}>
              <div className="span"><FormError error={act.error} /></div>
            </Form>
          </Dialog>}
        </Panel>
      );
    }}</Loaded>
  );
}

/** Where Zoho sends the browser back: swaps the code for the connection, and asks which organisation when there are several. */
export function ZohoCallback() {
  const [q] = useSearchParams();
  const nav = useNavigate();
  const code = q.get("code"), state = q.get("state");
  const [result, setResult] = useState<Row | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [org, setOrg] = useState("");
  const act = useAction();
  const conns = useLoad(() => (code ? Promise.resolve(null) : api<Row>("GET", "/portal/connections")), [code]);
  useEffect(() => {
    if (!code || !state) return;
    api<Row>("POST", "/portal/connections/zoho/exchange", { body: { code, state } }).then((r) => { setResult(r); if (!r.choose) setTimeout(() => nav("/portal", { replace: true }), 1200); }).catch((e) => setError(e instanceof ApiError ? e : new ApiError("NETWORK", String(e), 0)));
  }, [code, state, nav]);
  const pending = result?.connection ?? (conns.data?.connections as Row[] | undefined)?.find((c) => c.status === "PENDING") ?? null;
  const choose = () => act.run("org", () => api<Row>("POST", `/portal/connections/${pending!.ROWID}/organization`, { body: { org_id: org } }), "Connected. Your daily sales start coming in tonight.").then((r) => r && setTimeout(() => nav("/portal", { replace: true }), 1200));
  const orgs = (result?.organizations as Row[] | undefined) ?? [];
  return (
    <>
      <PageHeader title="Connecting Zoho Books" />
      <Panel>
        {error ? <><FormError error={error} /><p><Link to="/portal">Back to home</Link></p></>
          : !code && !pending ? <p className="muted">Nothing to finish here. <Link to="/portal">Back to home</Link></p>
          : result?.choose || (!code && pending) ? <>
            <p>Your Zoho account runs more than one organisation. Which one keeps this store's books?</p>
            {act.notice ? <div className="notice ok"><Icon name="check" />{act.notice}</div> : <Form onSubmit={choose} footer={<button className="btn" disabled={!org || !!act.busy}>{act.busy ? "Saving…" : "Use this organisation"}</button>}>
              <Field label="Organisation" span>{orgs.length ? <select value={org} onChange={(e) => setOrg(e.target.value)} required><option value="">Choose…</option>{orgs.map((o) => <option key={String(o.id)} value={String(o.id)}>{String(o.name)}</option>)}</select>
                : <input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Organisation ID from Zoho Books settings" />}</Field>
              <div className="span"><FormError error={act.error} /></div>
            </Form>}
          </>
          : result ? <div className="notice ok"><Icon name="check" />Connected to {String(result.connection?.org_name ?? "Zoho Books")}. Your daily sales start coming in tonight.</div>
          : <div className="state"><span className="spinner" />Finishing the connection…</div>}
      </Panel>
    </>
  );
}

const SAMPLE = "date,gross_sales,discounts,returns,tax,transactions\n2026-10-01,52400,1200,0,2620,118";

/** One store's POS days for a month, with CSV upload for stores whose POS does not post to Books. */
export function PosPanel({ projectId, portal }: { projectId: string; portal?: boolean }) {
  const [period, setPeriod] = useState<string | undefined>(undefined);
  const load = useLoad(() => api<Row>("GET", `/projects/${projectId}/pos`, { query: { period } }), [projectId, period]);
  const act = useAction(load.reload);
  const [uploading, setUploading] = useState(false);
  const canUpload = portal || can("royalty.manage");
  return (
    <Loaded load={load}>{(d) => {
      const m = d.month as Row, st = d.store as Row, c = d.connection as Row | null, rep = d.report as Row | null;
      const months: string[] = [];
      for (let i = 0, p = String(d.period); i < 6; i++) { months.push(p); const y = Number(p.slice(0, 4)), mo = Number(p.slice(5, 7)); p = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`; }
      const label = (p: string) => new Date(`${p}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
      const shift = (n: number) => { const [y, mo] = String(d.period).split("-").map(Number); const t = new Date(Date.UTC(y, mo - 1 + n, 1)); setPeriod(t.toISOString().slice(0, 7)); };
      return (
        <Panel title={<>Daily sales from POS<FeedPill status={st.feed} /></>} flush action={<span className="panel-actions">
          <button className="btn ghost sm" onClick={() => shift(-1)} aria-label="Earlier month">‹</button>
          <select aria-label="Month" value={String(d.period)} onChange={(e) => setPeriod(e.target.value)}>{months.map((p) => <option key={p} value={p}>{label(p)}</option>)}</select>
          <button className="btn ghost sm" onClick={() => shift(1)} aria-label="Later month">›</button>
          {canUpload && <button className="btn sm" onClick={() => setUploading(true)}><Icon name="send" size={14} />Upload CSV</button>}
        </span>}>
          <dl className="summary flat">
            <div><dt>POS net sales</dt><dd>{m.days ? inr(Number(m.net_sales)) : "—"}<span className="cell-sub">{m.days ? `${m.days} of ${m.days_expected} days` : "no days yet"}</span></dd></div>
            <div><dt>Reported</dt><dd>{rep ? money(rep.basis === "POS" ? rep.reported_net_sales : rep.net_sales) : "—"}<span className="cell-sub">{rep ? (rep.basis === "POS" ? "royalty billed on POS" : "franchisee's figure") : "not reported"}</span></dd></div>
            <div><dt>Difference</dt><dd><Variance pct={rep?.variance_pct ?? (rep && m.days && Number(m.net_sales) > 0 ? Math.round((Number(rep.net_sales) / Number(m.net_sales) - 1) * 1000) / 10 : null)} tolerance={Number(d.tolerance_pct)} /><span className="cell-sub">tolerance {String(d.tolerance_pct)}%</span></dd></div>
            <div><dt>Source</dt><dd>{c ? <>{c.org_name ?? "Zoho Books"}<span className="cell-sub">{c.status === "ACTIVE" ? `last pulled ${c.last_pulled_at ? date(c.last_pulled_at) : "never"}` : CONN_TEXT[String(c.status)] ?? ""}</span></> : <>{st.last_day ? "CSV upload" : "None"}<span className="cell-sub">{st.last_day ? `last day ${date(st.last_day)}` : portal ? "connect Zoho Books from home" : "the franchisee can connect Zoho Books"}</span></>}</dd></div>
          </dl>
          {act.notice && <div className="notice ok" style={{ margin: ".75rem 1rem 0" }}><Icon name="check" />{act.notice}</div>}
          {m.gaps?.length > 0 && Number(m.days) > 0 && <div className="notice warn" style={{ margin: ".75rem 1rem 0" }}><Icon name="alert" /><span>{m.gaps.length} day{m.gaps.length === 1 ? "" : "s"} missing: {(m.gaps as string[]).slice(0, 6).map((g) => date(g)).join(", ")}{m.gaps.length > 6 ? "…" : ""}. A month with gaps is never approved on its own.</span></div>}
          {(d.days as Row[]).length > 0 ? <DataTable rows={d.days as Row[]} columns={[
            { key: "day", label: "Day", render: (r) => date(r.day) },
            { key: "gross_sales", label: "Gross", align: "right", render: (r) => money(r.gross_sales) },
            { key: "discounts", label: "Discounts", align: "right", render: (r) => money(r.discounts) },
            { key: "returns", label: "Returns", align: "right", render: (r) => money(r.returns) },
            { key: "net_sales", label: "Net", align: "right", render: (r) => <strong>{money(r.net_sales)}</strong> },
            { key: "tax", label: "Tax", align: "right", render: (r) => money(r.tax) },
            { key: "transactions", label: "Bills", align: "right", render: (r) => r.transactions ?? "—" },
            { key: "source", label: "From", render: (r) => r.source === "BOOKS" ? "Zoho Books" : "Upload" },
          ]} /> : <div className="state">No POS sales for {label(String(d.period))} yet.</div>}
          {uploading && <UploadDialog projectId={projectId} busy={act.busy === "up"} error={act.error} onClose={() => { setUploading(false); act.clear(); }}
            onSave={(csv) => act.run("up", () => api<Row>("POST", `/projects/${projectId}/pos/upload`, { body: { csv } }), (r) => `${r.days} day${r.days === 1 ? "" : "s"} saved (${r.inserted} new, ${r.updated} updated).`).then((r) => r && setUploading(false))} />}
        </Panel>
      );
    }}</Loaded>
  );
}

function UploadDialog({ busy, error, onSave, onClose }: { projectId: string; busy: boolean; error: ApiError | null; onSave: (csv: string) => void; onClose: () => void }) {
  const [csv, setCsv] = useState("");
  const [name, setName] = useState<string | null>(null);
  const read = (f: File | undefined) => { if (!f) return; setName(f.name); f.text().then(setCsv); };
  return (
    <Dialog title="Upload daily sales" subtitle="A CSV with one row per day. Days already uploaded are replaced." onClose={onClose}>
      <Form onSubmit={() => onSave(csv)} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !csv.trim()}>{busy ? "Saving…" : "Save days"}</button></>}>
        <Field label="CSV file" span hint={<>Columns: <code>date, gross_sales, discounts, returns, tax, transactions</code>. Dates as YYYY-MM-DD or DD/MM/YYYY; discounts, returns, tax and transactions may be blank.</>}>
          <input type="file" accept=".csv,text/csv" onChange={(e) => read(e.target.files?.[0])} />
          {name && <span className="muted small">{name}</span>}
        </Field>
        <Field label="Or paste the rows" span><textarea rows={6} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={SAMPLE} spellCheck={false} /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

interface RoyaltySettingsView { royalty_basis: "REPORTED" | "POS"; pos_variance_tolerance_pct: number; royalty_auto_approve: boolean; report_due_day: number; defaults: Row }

/** Admin → Settings → Royalties: what royalty is billed on, and when the month closes. */
export function RoyaltySettings() {
  const load = useLoad(() => api<RoyaltySettingsView>("GET", "/settings/royalties"), []);
  return <Loaded load={load}>{(d) => <RoyaltySettingsForm initial={d} />}</Loaded>;
}

function RoyaltySettingsForm({ initial }: { initial: RoyaltySettingsView }) {
  const [s, setS] = useState(initial);
  const act = useAction();
  const save = async () => {
    const r = await act.run("save", () => api<RoyaltySettingsView>("PUT", "/settings/royalties", { body: { royalty_basis: s.royalty_basis, pos_variance_tolerance_pct: s.pos_variance_tolerance_pct, royalty_auto_approve: s.royalty_auto_approve, report_due_day: s.report_due_day } }), "Saved. The next nightly run follows the new basis.");
    if (r) setS(r);
  };
  const pull = () => act.run("pull", () => api<Row>("POST", "/admin/pos/pull"), (r) => `Pulled ${r.pulled} day${r.pulled === 1 ? "" : "s"} over ${r.connections} connection${r.connections === 1 ? "" : "s"}; ${r.closed} month${r.closed === 1 ? "" : "s"} closed from POS${r.failed ? `; ${r.failed} failed` : ""}.`);
  return (
    <Panel title="Royalties" action={can("integration.admin") && <button type="button" className="btn ghost sm" disabled={!!act.busy} onClick={pull}>{act.busy === "pull" ? "Pulling…" : "Pull POS sales now"}</button>}>
      {act.notice && <div className="notice ok"><Icon name="check" />{act.notice}</div>}
      <Form onSubmit={save} footer={<button className="btn" disabled={!!act.busy}>{act.busy === "save" ? "Saving…" : "Save royalties"}</button>}>
        <Field label="Royalty is billed on" span hint={s.royalty_basis === "POS" ? "A store with a POS feed has its month closed from POS sales on the due day; the franchisee's own figure is kept beside it. A store with no feed is billed on its report as before." : "The franchisee reports each month and finance approves it. Stores with a POS feed show the difference, but it is not acted on."}>
          <select value={s.royalty_basis} onChange={(e) => setS({ ...s, royalty_basis: e.target.value as "REPORTED" | "POS" })}>
            <option value="REPORTED">What the franchisee reports</option>
            <option value="POS">POS sales (what the POS recorded)</option>
          </select>
        </Field>
        <Field label="Tolerance (%)" hint="A report further than this from the POS figure is flagged for finance."><input type="number" min={0} max={100} step="0.5" value={s.pos_variance_tolerance_pct} onChange={(e) => setS({ ...s, pos_variance_tolerance_pct: Number(e.target.value) })} /></Field>
        <Field label="Reports due by day" hint="Of the following month."><input type="number" min={1} max={28} value={s.report_due_day} onChange={(e) => setS({ ...s, report_due_day: Number(e.target.value) })} /></Field>
        <Field label="Approve on its own" span hint="With the POS basis: a month that is complete and within tolerance is approved and invoiced by the nightly job. Off, finance approves every month.">
          <label className="check"><input type="checkbox" checked={s.royalty_auto_approve} onChange={(e) => setS({ ...s, royalty_auto_approve: e.target.checked })} /> Invoice complete, in-tolerance months without a review</label>
        </Field>
        <div className="span"><FormError error={act.error} /></div>
      </Form>
    </Panel>
  );
}

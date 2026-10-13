import { useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, can, Row, portalHome } from "../api";
import { useAction, useLoad } from "../hooks";
import { Dialog, Field, Form, FormError } from "./forms";
import { BooksInvoice, DataTable, date, Icon, inr, Loaded, PageHeader, Panel, Pill } from "./ui";
import { FeedPill, PosPanel, Variance } from "./Pos";

const ACCEPT = "application/pdf,image/jpeg,image/png,image/webp";
export const REPORT_TONE: Record<string, string> = { SUBMITTED: "info", RETURNED: "warn", INVOICED: "warn", PAID: "good" };
const STATUS_TEXT: Record<string, string> = { SUBMITTED: "Waiting for review", RETURNED: "Needs a correction", INVOICED: "Invoiced", PAID: "Paid" };
const SOURCE_TEXT: Record<string, string> = { feasibility: "from the feasibility model", store: "set for this store", tenant: "network default", null: "not set" };

const toBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",", 2)[1] ?? "");
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});
const pct = (v: unknown) => (v === null || v === undefined ? "—" : `${Number(v)}%`);
const money = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : inr(Number(v)));

function ReportStatus({ m }: { m: Row }) {
  const r = m.report as Row | null;
  if (!r) return m.late ? <Pill value="Late" tone="bad" /> : <Pill value="Not reported" tone="neutral" />;
  return <Pill value={STATUS_TEXT[String(r.status)] ?? r.status} tone={REPORT_TONE[String(r.status)]} />;
}

/**
 * Monthly sales and royalties for one opened store. The franchisee (portal) reports each month;
 * royalty.manage edits rates, approves a report into a Books invoice or returns it with a note.
 */
export function RoyaltyPanel({ projectId, portal }: { projectId: string; portal?: boolean }) {
  const load = useLoad(() => api<Row>("GET", `/projects/${projectId}/royalties`), [projectId]);
  const act = useAction(load.reload);
  const manage = !portal && can("royalty.manage");
  const [reporting, setReporting] = useState<Row | null>(null);
  const [returning, setReturning] = useState<Row | null>(null);
  const [rates, setRates] = useState(false);
  const base = `/projects/${projectId}`;
  const close = () => { setReporting(null); setReturning(null); setRates(false); act.clear(); };
  const done = () => { setReporting(null); setReturning(null); setRates(false); };

  return (
    <Loaded load={load}>{(l) => {
      const months = l.months as Row[];
      const t = l.totals as Row;
      const rt = l.rates as Row;
      const canReport = portal || manage;
      const view = (r: Row) => act.run(`f${r.ROWID}`, async () => { const x = await api<{ url: string }>("GET", `${base}/sales/${r.ROWID}/file`); window.open(x.url, "_blank", "noopener"); });
      const approve = (r: Row) => act.run(`a${r.ROWID}`, () => api<Row>("POST", `${base}/sales/${r.ROWID}/approve`),
        (x) => x.zoho_books_invoice_id ? `Invoice ${x.invoice_number ?? ""} for ${inr(Number(x.royalty_amount) + Number(x.marketing_amount))} raised in Zoho Books and sent.` : "Approved. Nothing to invoice for this month.");
      const refresh = (r: Row) => act.run(`r${r.ROWID}`, () => api<Row>("POST", `${base}/sales/${r.ROWID}/refresh`), (x) => x.status === "PAID" ? "The invoice is paid." : `Invoice balance ${inr(Number(x.invoice_balance ?? 0))}.`);
      const dialogOpen = !!(reporting || returning || rates);
      const late = months.filter((m) => m.late || (m.report as Row | null)?.status === "RETURNED");
      const feed = l.feed as Row;
      const hasPos = feed.status !== "NONE" || months.some((m) => m.pos);
      return (
        <>
          <Panel title={<>Sales and royalties{hasPos && <FeedPill status={feed.status} />}</>} flush action={<span className="panel-actions">
            {manage && <button className="btn ghost sm" onClick={() => setRates(true)}>Edit rates</button>}
            {canReport && months.length > 0 && <button className="btn sm" onClick={() => setReporting(months.find((m) => !m.report || ["SUBMITTED", "RETURNED"].includes(String((m.report as Row).status))) ?? months[0])}>Report sales</button>}
          </span>}>
            <dl className="summary flat">
              <div><dt>Royalty</dt><dd>{pct(rt.royalty_pct)}<span className="cell-sub">{SOURCE_TEXT[String(rt.source)] ?? ""}</span></dd></div>
              <div><dt>Marketing fund</dt><dd>{pct(rt.marketing_fund_pct)}</dd></div>
              <div><dt>Invoiced so far</dt><dd>{inr(Number(t.royalty) + Number(t.marketing))}<span className="cell-sub">on {inr(Number(t.net_sales))} net sales</span></dd></div>
              <div><dt>Unpaid</dt><dd style={{ color: t.outstanding > 0 ? "var(--warn)" : undefined }}>{inr(Number(t.outstanding))}</dd></div>
            </dl>
            {feed.basis === "POS" && hasPos && <div className="notice info" style={{ margin: ".75rem 1rem 0" }}><Icon name="store" /><span>Royalty is billed on POS sales. {portal ? "Your own figure is kept beside it; a difference beyond " : "The franchisee's figure is kept beside it; a difference beyond "}{String(feed.tolerance_pct)}% waits for finance.</span></div>}
            {!months.length && <div className="state">The first month to report is the month the store opened, once it ends.</div>}
            {late.length > 0 && <div className="notice warn" style={{ margin: ".75rem 1rem 0" }}><Icon name="alert" /><span>{portal ? "Please report" : "Not reported yet"}: {late.map((m) => m.label).join(", ")}. Reports are due by day {l.report_due_day} of the next month.</span></div>}
            {rt.royalty_pct === null && manage && <div className="notice warn" style={{ margin: ".75rem 1rem 0" }}><Icon name="alert" /><span>No royalty rate. Set one before approving reports.</span></div>}
            {act.notice && <div className="notice ok" style={{ margin: ".75rem 1rem 0" }}><Icon name="check" />{act.notice}</div>}
            {act.error && !dialogOpen && <div style={{ margin: ".75rem 1rem 0" }}><FormError error={act.error} /></div>}
            {months.length > 0 && <DataTable rows={months} empty="No months yet." columns={[
              { key: "label", label: "Month", render: (m) => <>{m.label}<span className="cell-sub">Due {date(m.due_on)}</span></> },
              { key: "status", label: "Status", render: (m) => <><ReportStatus m={m} />{(m.report as Row | null)?.basis === "POS" && <Pill value="From POS" tone="good" />}{(m.report as Row | null)?.status === "RETURNED" && m.report.review_note && <span className="cell-sub">{String(m.report.review_note)}</span>}</> },
              { key: "net", label: "Net sales", align: "right", render: (m) => <>{money(m.report?.net_sales)}{m.report && <span className="cell-sub">Gross {money(m.report.gross_sales)}</span>}</> },
              ...(hasPos ? [{ key: "pos", label: "POS sales", align: "right" as const, render: (m: Row) => m.pos ? <>{inr(Number(m.pos.net_sales))}<span className="cell-sub">{m.report?.basis === "POS" ? `reported ${money(m.report.reported_net_sales)}` : `${m.pos.days} days${m.pos.gaps ? `, ${m.pos.gaps} missing` : ""}`}</span></> : <span className="muted">—</span> },
                { key: "variance", label: "Diff.", align: "right" as const, render: (m: Row) => <Variance pct={m.variance_pct} tolerance={Number(feed.tolerance_pct)} /> }] : []),
              { key: "due", label: "Royalty + fund", align: "right", render: (m) => m.report?.royalty_amount != null ? <>{inr(Number(m.report.royalty_amount) + Number(m.report.marketing_amount ?? 0))}<span className="cell-sub">{inr(Number(m.report.royalty_amount))} + {inr(Number(m.report.marketing_amount ?? 0))}</span></> : <span className="muted">—</span> },
              { key: "invoice", label: "Invoice", render: (m) => m.report?.invoice_number ? <><BooksInvoice id={m.report.zoho_books_invoice_id} number={m.report.invoice_number} /><span className="cell-sub">{m.report.status === "PAID" ? "Paid" : `${money(m.report.invoice_balance)} due ${date(m.report.invoice_due_date)}`}</span></> : <span className="muted">—</span> },
              { key: "actions", label: "", align: "right", render: (m) => {
                const r = m.report as Row | null;
                const open = !r || r.status === "SUBMITTED" || r.status === "RETURNED";
                return (
                  <span className="panel-actions">
                    {r?.file_ref && <button className="btn ghost sm" disabled={!!act.busy} onClick={() => view(r)}>File</button>}
                    {canReport && open && <button className="btn ghost sm" onClick={() => setReporting(m)}>{r ? "Change" : "Report"}</button>}
                    {manage && r?.status === "SUBMITTED" && <>
                      <button className="btn sm" disabled={!!act.busy} onClick={() => approve(r)}><Icon name="check" size={14} />{act.busy === `a${r.ROWID}` ? "Invoicing…" : "Approve"}</button>
                      <button className="btn danger-ghost sm" disabled={!!act.busy} onClick={() => setReturning(r)}>Return</button>
                    </>}
                    {manage && r?.status === "INVOICED" && <button className="btn ghost sm" disabled={!!act.busy} onClick={() => refresh(r)}><Icon name="sync" size={14} />{act.busy === `r${r.ROWID}` ? "Checking…" : "Check payment"}</button>}
                  </span>
                );
              } },
            ]} />}
            {manage && <p className="muted panel-foot">Approving a report raises one Zoho Books invoice with a royalty line and a marketing fund line, and marks it sent. Payment is picked up by the nightly sync.</p>}
          </Panel>
          {reporting && <SalesDialog month={reporting} months={months} busy={act.busy === "report"} error={act.error} onClose={close}
            onSave={(body) => act.run("report", () => api<Row>("POST", `${base}/sales`, { body }), (x) => `${x.period ? months.find((m) => m.period === x.period)?.label ?? x.period : "Month"} sales sent for review.`).then((r) => r && done())} />}
          {returning && <ReturnDialog report={returning} busy={act.busy === "return"} error={act.error} onClose={close}
            onSave={(note) => act.run("return", () => api<Row>("POST", `${base}/sales/${returning.ROWID}/return`, { body: { note } }), "Returned to the franchisee with your note.").then((r) => r && done())} />}
          {rates && <RatesDialog rates={rt} busy={act.busy === "rates"} error={act.error} onClose={close}
            onSave={(body) => act.run("rates", () => api<Row>("PATCH", `${base}/royalty-rates`, { body }), "Rates saved. They apply to reports approved from now on.").then((r) => r && done())} />}
        </>
      );
    }}</Loaded>
  );
}

function SalesDialog({ month, months, busy, error, onSave, onClose }: { month: Row; months: Row[]; busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const open = months.filter((m) => !m.report || ["SUBMITTED", "RETURNED"].includes(String(m.report.status)));
  const pick = (p: string) => months.find((m) => m.period === p)?.report as Row | null | undefined;
  const fill = (r: Row | null | undefined) => ({ gross_sales: r ? String(r.gross_sales ?? "") : "", net_sales: r ? String(r.net_sales ?? "") : "", transactions: r?.transactions != null ? String(r.transactions) : "", notes: r?.notes ? String(r.notes) : "" });
  const [period, setPeriod] = useState(String(month.period));
  const [v, setV] = useState(fill(month.report as Row | null));
  const [file, setFile] = useState<File | null>(null);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((p) => ({ ...p, [k]: e.target.value }));
  const gross = Number(v.gross_sales), net = Number(v.net_sales);
  const returned = pick(period)?.status === "RETURNED" ? pick(period) : null;
  const submit = async () => {
    const body: Row = { period, gross_sales: gross, net_sales: net, ...(v.transactions ? { transactions: Number(v.transactions) } : {}), ...(v.notes.trim() ? { notes: v.notes.trim() } : {}) };
    if (file) body.report = { file_name: file.name, content_type: file.type || "application/octet-stream", data_base64: await toBase64(file) };
    onSave(body);
  };
  return (
    <Dialog title="Report monthly sales" subtitle="Sales for one calendar month, as your point-of-sale shows them." onClose={onClose}>
      <Form onSubmit={submit} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || v.gross_sales === "" || v.net_sales === "" || !(gross >= 0) || !(net >= 0)}>{busy ? "Sending…" : "Send for review"}</button></>}>
        <Field label="Month" span><select value={period} onChange={(e) => { setPeriod(e.target.value); setV(fill(pick(e.target.value))); }}>
          {open.map((m) => <option key={String(m.period)} value={String(m.period)}>{String(m.label)}{m.report ? ` (${STATUS_TEXT[String(m.report.status)].toLowerCase()})` : ""}</option>)}
        </select></Field>
        {returned?.review_note && <div className="span notice warn"><Icon name="alert" /><span>Returned: {String(returned.review_note)}</span></div>}
        <Field label="Gross sales (₹)" hint="Before discounts and returns."><input type="number" min={0} step="any" value={v.gross_sales} onChange={set("gross_sales")} required autoFocus /></Field>
        <Field label="Net sales (₹)" hint="Royalty is charged on this." error={v.net_sales !== "" && net > gross ? "More than gross" : undefined}><input type="number" min={0} step="any" value={v.net_sales} onChange={set("net_sales")} required /></Field>
        <Field label="Bills (optional)"><input type="number" min={0} step={1} value={v.transactions} onChange={set("transactions")} /></Field>
        <Field label="Sales report (optional)" hint="PDF or a photo of the POS report."><input type="file" accept={ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
        <Field label="Notes" span><textarea rows={2} value={v.notes} onChange={set("notes")} maxLength={2000} /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

function ReturnDialog({ report, busy, error, onSave, onClose }: { report: Row; busy: boolean; error: ApiError | null; onSave: (note: string) => void; onClose: () => void }) {
  const [note, setNote] = useState("");
  return (
    <Dialog title="Return for correction" subtitle={`Net sales ${money(report.net_sales)}. The franchisee sees your note and reports again.`} onClose={onClose}>
      <Form onSubmit={() => onSave(note.trim())} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || note.trim().length < 3}>{busy ? "Returning…" : "Return"}</button></>}>
        <Field label="What needs fixing" span><textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} required autoFocus /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

function RatesDialog({ rates, busy, error, onSave, onClose }: { rates: Row; busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const [r, setR] = useState(rates.royalty_pct != null ? String(rates.royalty_pct) : "");
  const [m, setM] = useState(rates.marketing_fund_pct != null ? String(rates.marketing_fund_pct) : "0");
  return (
    <Dialog title="Royalty rates for this store" subtitle="Percent of net sales. Reports already invoiced keep their old rates." onClose={onClose}>
      <Form onSubmit={() => onSave({ royalty_pct: Number(r), marketing_fund_pct: Number(m) })} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || r === "" || m === ""}>{busy ? "Saving…" : "Save"}</button></>}>
        <Field label="Royalty (%)"><input type="number" min={0} max={50} step="0.01" value={r} onChange={(e) => setR(e.target.value)} required autoFocus /></Field>
        <Field label="Marketing fund (%)"><input type="number" min={0} max={50} step="0.01" value={m} onChange={(e) => setM(e.target.value)} required /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

/** Portal: the franchisee's sales reports and royalty invoices. */
export function PortalSales() {
  const home = useLoad(() => portalHome(), []);
  return (
    <>
      <PageHeader title="Sales reports" subtitle="Report each month's sales. We invoice the royalty and marketing fund from them." />
      <Loaded load={home}>{(h) => h.project?.status === "OPENED" ? <><RoyaltyPanel projectId={String(h.project.ROWID)} portal /><PosPanel projectId={String(h.project.ROWID)} portal /></>
        : <div className="state">Monthly sales reports start once your store opens.</div>}</Loaded>
    </>
  );
}

const FILTER_STATUS: [string, string][] = [["", "All"], ["SUBMITTED", "Waiting for review"], ["RETURNED", "Returned"], ["INVOICED", "Unpaid"], ["PAID", "Paid"]];

/** Staff: every sales report across opened stores. */
export function Royalties() {
  const [status, setStatus] = useState("SUBMITTED");
  const load = useLoad(() => api<Row>("GET", "/royalties", { query: status ? { status } : {} }), [status]);
  return (
    <>
      <PageHeader title="Royalties" crumbs={[["Operations"], ["Royalties"]]} subtitle="Monthly sales reports from opened stores, and the royalty invoices raised from them." />
      <Loaded load={load}>{(d) => {
        const t = d.totals as Row;
        return (
          <>
            <dl className="summary">
              <div><dt>Opened stores</dt><dd>{t.stores}</dd></div>
              <div><dt>Waiting for review</dt><dd>{t.waiting}{t.strayed > 0 && <span className="cell-sub" style={{ color: "var(--bad)" }}>{t.strayed} differ from POS</span>}</dd></div>
              <div><dt>Invoiced</dt><dd>{inr(Number(t.invoiced))}</dd></div>
              <div><dt>Unpaid</dt><dd style={{ color: t.outstanding > 0 ? "var(--warn)" : undefined }}>{inr(Number(t.outstanding))}</dd></div>
            </dl>
            <Panel flush>
              <DataTable rows={d.items as Row[]} href={(r) => `/projects/${r.project_id}`} searchKeys={["project_code", "franchisee", "label"]}
                empty={status ? "No reports with this status." : "No sales reported yet."}
                toolbar={<select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>{FILTER_STATUS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}
                columns={[
                  { key: "label", label: "Month" },
                  { key: "project_code", label: "Store", render: (r) => <><Link to={`/projects/${r.project_id}`}>{String(r.project_code ?? "—")}</Link><span className="cell-sub">{String(r.franchisee ?? "")}</span></> },
                  { key: "status", label: "Status", render: (r) => <Pill value={STATUS_TEXT[String(r.status)] ?? r.status} tone={REPORT_TONE[String(r.status)]} /> },
                  { key: "net_sales", label: "Net sales", align: "right", render: (r) => <>{money(r.net_sales)}{r.basis === "POS" && <span className="cell-sub">from POS</span>}</> },
                  { key: "variance_pct", label: "vs POS", align: "right", render: (r) => <Variance pct={r.variance_pct} tolerance={Number(d.tolerance_pct)} /> },
                  { key: "royalty_amount", label: "Royalty + fund", align: "right", render: (r) => r.royalty_amount != null ? inr(Number(r.royalty_amount) + Number(r.marketing_amount ?? 0)) : <span className="muted">—</span> },
                  { key: "invoice_number", label: "Invoice", render: (r) => r.invoice_number ? <><BooksInvoice id={r.zoho_books_invoice_id} number={r.invoice_number} /><span className="cell-sub">{r.status === "PAID" ? "Paid" : `${money(r.invoice_balance)} due`}</span></> : <span className="muted">—</span> },
                ]} />
            </Panel>
          </>
        );
      }}</Loaded>
    </>
  );
}

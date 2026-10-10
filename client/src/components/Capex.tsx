import { useState } from "react";
import { api, ApiError, Row } from "../api";
import { useAction, useLoad } from "../hooks";
import { Dialog, Field, Form, FormError } from "./forms";
import { DataTable, date, Icon, inr, Loaded, Panel, Pill } from "./ui";

const ACCEPT = "application/pdf,image/jpeg,image/png,image/webp";
const SOURCE: Record<string, string> = { BOOKS: "Zoho Books", MANUAL: "Recorded", PORTAL: "Franchisee" };
const BILL_TONE: Record<string, string> = { PAID: "good", OPEN: "info", OVERDUE: "bad", PARTIALLY_PAID: "warn", RECORDED: "neutral", VOID: "neutral", DRAFT: "neutral" };

const toBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",", 2)[1] ?? "");
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

/** Spent against budget; red over budget, amber from 90%. */
function Used({ pct, over, spent }: { pct: number | null; over: boolean; spent: number }) {
  if (pct === null && spent > 0) return <span style={{ color: "var(--warn)" }}>No budget</span>;
  if (pct === null) return <span className="muted">—</span>;
  const tone = over ? "bad" : pct >= 90 ? "warn" : "good";
  return <span className="progress"><span className="track"><span className={`fill ${tone}`} style={{ width: `${Math.min(100, pct)}%` }} /></span><span className="num" style={{ color: over ? "var(--bad)" : undefined }}>{pct}%</span></span>;
}

/**
 * Capex budget vs actual for one opening project. Staff edit budgets, record and recategorise spend
 * and pull Books bills; the franchisee (portal) records spend with an invoice.
 */
export function CapexPanel({ projectId, editable, portal }: { projectId: string; editable: boolean; portal?: boolean }) {
  const load = useLoad(() => api<Row>("GET", `/projects/${projectId}/capex`), [projectId]);
  const act = useAction(load.reload);
  const [budgetOf, setBudgetOf] = useState<Row | null>(null);
  const [recording, setRecording] = useState(false);
  const [moving, setMoving] = useState<Row | null>(null);
  const base = `/projects/${projectId}/capex`;
  const canRecord = editable || !!portal;

  return (
    <Loaded load={load}>{(c) => {
      const rows = c.rows as Row[];
      const spend = c.spend as Row[];
      const over = rows.filter((r) => r.over);
      const unbudgeted = rows.filter((r) => !r.budget && r.actual > 0);
      const cats = (c.lines as Row[]).map((l) => ({ code: String(l.category), name: String(l.name) }));
      const nameOf = (code: unknown) => cats.find((x) => x.code === code)?.name ?? "Other";
      const sync = () => act.run("sync", () => api<Row>("POST", `${base}/sync`), (r) => r.added || r.updated ? `Zoho Books: ${r.added} new bill${r.added === 1 ? "" : "s"}, ${r.updated} updated.` : `Zoho Books: no changes (${r.bills} bill${r.bills === 1 ? "" : "s"} for ${c.project_code}).`);
      const view = (s: Row) => act.run(`v${s.ROWID}`, async () => { const r = await api<{ url: string }>("GET", `${base}/spend/${s.ROWID}/invoice`); window.open(r.url, "_blank", "noopener"); });
      const close = () => { setBudgetOf(null); setRecording(false); setMoving(null); act.clear(); };
      const dialogOpen = !!(budgetOf || recording || moving);
      return (
        <>
          <Panel title="Capex budget" flush action={<span className="panel-actions">
            {editable && c.books_connected && <button className="btn ghost sm" disabled={!!act.busy} onClick={sync}><Icon name="sync" size={14} />{act.busy === "sync" ? "Syncing…" : "Sync from Books"}</button>}
            {canRecord && <button className="btn sm" onClick={() => setRecording(true)}>Record spend</button>}
          </span>}>
            <dl className="summary flat">
              <div><dt>Budget</dt><dd>{inr(c.budget)}</dd></div>
              <div><dt>Spent</dt><dd style={{ color: c.over ? "var(--bad)" : undefined }}>{inr(c.actual)}</dd></div>
              <div><dt>{c.variance < 0 ? "Over by" : "Remaining"}</dt><dd style={{ color: c.variance < 0 ? "var(--bad)" : undefined }}>{inr(Math.abs(c.variance))}</dd></div>
              <div><dt>Unpaid bills</dt><dd>{inr(c.outstanding)}</dd></div>
            </dl>
            {c.budget === 0 && <div className="notice warn" style={{ margin: ".75rem 1rem 0" }}><Icon name="alert" /><span>No budget yet. {editable ? "Set a budget for each category." : "The franchise team sets it."}</span></div>}
            {over.length > 0 && <div className="notice bad" style={{ margin: ".75rem 1rem 0" }}><Icon name="alert" /><span>Over budget: {over.map((r) => `${r.name} by ${inr(r.actual - r.budget)}`).join(", ")}.</span></div>}
            {c.budget > 0 && unbudgeted.length > 0 && <div className="notice warn" style={{ margin: ".75rem 1rem 0" }}><Icon name="alert" /><span>{inr(unbudgeted.reduce((a, r) => a + r.actual, 0))} is spent with no budget ({unbudgeted.map((r) => r.name).join(", ")}).{editable ? " Move it to a category or set a budget." : ""}</span></div>}
            {act.notice && <div className="notice ok" style={{ margin: ".75rem 1rem 0" }}><Icon name="check" />{act.notice}</div>}
            {act.error && !dialogOpen && <div style={{ margin: ".75rem 1rem 0" }}><FormError error={act.error} /></div>}
            <DataTable rows={rows} empty="No budget lines." columns={[
              { key: "name", label: "Category" },
              { key: "budget", label: "Budget", align: "right", render: (r) => inr(r.budget) },
              { key: "actual", label: "Spent", align: "right", render: (r) => inr(r.actual) },
              { key: "variance", label: "Remaining", align: "right", render: (r) => <span style={{ color: r.variance < 0 ? "var(--bad)" : undefined, whiteSpace: "nowrap" }}>{r.variance < 0 ? `−${inr(-r.variance)}` : inr(r.variance)}</span> },
              { key: "used_pct", label: "Used", render: (r) => <Used pct={r.used_pct} over={r.over} spent={r.actual} /> },
              ...(editable ? [{ key: "actions", label: "", align: "right" as const, render: (r: Row) => r.line_id ? <button className="btn ghost sm" onClick={() => setBudgetOf(r)}>Edit budget</button> : null }] : []),
            ]} />
            {editable && <p className="muted panel-foot">Bills in Zoho Books show up here when their reference number starts with {c.project_code}. Add the category after it, for example “{c.project_code} KITCHEN”.</p>}
          </Panel>
          <Panel title="Spend" flush action={<span className="muted">{spend.filter((s) => s.status !== "VOID").length} entries</span>}>
            <DataTable rows={spend} empty="No spend recorded yet." columns={[
              { key: "spend_date", label: "Date", render: (s) => date(s.spend_date) },
              { key: "vendor", label: "Vendor", render: (s) => <>{s.vendor}<span className="cell-sub">{SOURCE[String(s.source)] ?? s.source}{s.reference ? ` · ${s.reference}` : ""}</span></> },
              { key: "category", label: "Category", render: (s) => nameOf(s.category) },
              { key: "amount", label: "Amount", align: "right", render: (s) => <span style={{ textDecoration: s.status === "VOID" ? "line-through" : undefined }}>{inr(Number(s.amount))}</span> },
              { key: "status", label: "Status", render: (s) => <Pill value={s.status} tone={BILL_TONE[String(s.status)]} /> },
              { key: "actions", label: "", align: "right", render: (s) => (
                <span className="panel-actions">
                  {s.file_ref && <button className="btn ghost sm" disabled={!!act.busy} onClick={() => view(s)}>Invoice</button>}
                  {editable && s.status !== "VOID" && <button className="btn ghost sm" onClick={() => setMoving(s)}>Change</button>}
                </span>
              ) },
            ]} />
          </Panel>
          {budgetOf && <BudgetDialog row={budgetOf} busy={act.busy === "budget"} error={act.error} onClose={close}
            onSave={(budget) => act.run("budget", () => api<Row>("PATCH", `${base}/lines/${budgetOf.line_id}`, { body: { budget } }), `${budgetOf.name} budget saved.`).then((r) => r && setBudgetOf(null))} />}
          {recording && <SpendDialog cats={cats} needInvoice={!!portal} busy={act.busy === "spend"} error={act.error} onClose={close}
            onSave={(body) => act.run("spend", () => api<Row>("POST", `${base}/spend`, { body }), `${inr(Number(body.amount))} to ${body.vendor} recorded.`).then((r) => r && setRecording(false))} />}
          {moving && <ChangeSpendDialog spend={moving} cats={cats} busy={act.busy === "move"} error={act.error} onClose={close}
            onSave={(body) => act.run("move", () => api<Row>("PATCH", `${base}/spend/${moving.ROWID}`, { body }), body.void ? "Entry voided." : "Entry updated.").then((r) => r && setMoving(null))} />}
        </>
      );
    }}</Loaded>
  );
}

function BudgetDialog({ row, busy, error, onSave, onClose }: { row: Row; busy: boolean; error: ApiError | null; onSave: (n: number) => void; onClose: () => void }) {
  const [v, setV] = useState(String(row.budget ?? 0));
  const n = Number(v);
  return (
    <Dialog title={`${row.name} budget`} subtitle={`Spent so far ${inr(row.actual)}.`} onClose={onClose}>
      <Form onSubmit={() => onSave(n)} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !(n >= 0) || v === ""}>{busy ? "Saving…" : "Save"}</button></>}>
        <Field label="Budget (₹)" span><input type="number" min={0} step={1000} value={v} onChange={(e) => setV(e.target.value)} required autoFocus /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

function SpendDialog({ cats, needInvoice, busy, error, onSave, onClose }: { cats: { code: string; name: string }[]; needInvoice: boolean; busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [v, setV] = useState({ category: cats[0]?.code ?? "OTHER", vendor: "", spend_date: today, amount: "", reference: "", notes: "" });
  const [file, setFile] = useState<File | null>(null);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((p) => ({ ...p, [k]: e.target.value }));
  const amount = Number(v.amount);
  const submit = async () => {
    const body: Row = { category: v.category, vendor: v.vendor.trim(), spend_date: v.spend_date, amount, ...(v.reference.trim() ? { reference: v.reference.trim() } : {}), ...(v.notes.trim() ? { notes: v.notes.trim() } : {}) };
    if (file) body.invoice = { file_name: file.name, content_type: file.type, data_base64: await toBase64(file) };
    onSave(body);
  };
  return (
    <Dialog title="Record spend" subtitle="A payment for this store's fit-out that isn't billed through Zoho Books." onClose={onClose}>
      <Form onSubmit={submit} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !(amount > 0) || v.vendor.trim().length < 2 || (needInvoice && !file)}>{busy ? "Saving…" : "Record spend"}</button></>}>
        <Field label="Category"><select value={v.category} onChange={set("category")}>{cats.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}<option value="OTHER">Other</option></select></Field>
        <Field label="Amount (₹)"><input type="number" min={1} step="any" value={v.amount} onChange={set("amount")} required /></Field>
        <Field label="Vendor"><input value={v.vendor} onChange={set("vendor")} maxLength={200} required autoFocus /></Field>
        <Field label="Date"><input type="date" value={v.spend_date} max={today} onChange={set("spend_date")} required /></Field>
        <Field label="Invoice number"><input value={v.reference} onChange={set("reference")} maxLength={100} /></Field>
        <Field label={needInvoice ? "Invoice" : "Invoice (optional)"} hint="PDF, JPG or PNG."><input type="file" accept={ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} required={needInvoice} /></Field>
        <Field label="Notes" span><textarea rows={2} value={v.notes} onChange={set("notes")} maxLength={2000} /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

function ChangeSpendDialog({ spend, cats, busy, error, onSave, onClose }: { spend: Row; cats: { code: string; name: string }[]; busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const [category, setCategory] = useState(String(spend.category ?? "OTHER"));
  const books = spend.source === "BOOKS";
  return (
    <Dialog title={`${spend.vendor}, ${inr(Number(spend.amount))}`} subtitle={books ? "From Zoho Books. The category you choose stays on later syncs." : undefined} onClose={onClose}>
      <Form onSubmit={() => (category !== spend.category ? onSave({ category }) : onClose())} footer={<>
        {!books && <button type="button" className="btn danger-ghost" style={{ marginRight: "auto" }} disabled={busy} onClick={() => onSave({ void: true })}>Void entry</button>}
        <button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      </>}>
        <Field label="Category" span><select value={category} onChange={(e) => setCategory(e.target.value)}>{cats.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}<option value="OTHER">Other</option></select></Field>
        {books && <div className="span muted">To remove a Books bill from this project, void it or change its reference number in Zoho Books.</div>}
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

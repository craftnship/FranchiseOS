import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError, can, Row } from "../api";
import { useAction, useLoad } from "../hooks";
import { Dialog, Field, Form, FormError } from "./forms";
import { BooksInvoice, DataTable, date, Icon, inr, Loaded, PageHeader, Panel, Pill } from "./ui";

// Collections (docs/collections.md): finance's worklist of unpaid invoices, what was done about each,
// and the reminder ladder under Settings.

const FILTERS: [string, string][] = [["", "Open"], ["overdue", "Overdue"], ["escalated", "Escalated"], ["PROMISED", "Promised"], ["DISPUTED", "Disputed"], ["PAID", "Paid"]];
const KIND_TEXT: Record<string, string> = { FEE: "Franchise fee", INSTALMENT: "Fee instalment", ROYALTY: "Royalty" };
const MODES: [string, string][] = [["banktransfer", "Bank transfer (NEFT, RTGS, IMPS)"], ["upi", "UPI"], ["check", "Cheque"], ["cash", "Cash"], ["creditcard", "Card"], ["others", "Other"]];

function StatusPill({ c }: { c: Row }) {
  if (c.status === "PAID") return <Pill value="Paid" tone="good" />;
  if (c.status === "CLOSED") return <Pill value="Closed" tone="neutral" />;
  if (c.status === "DISPUTED") return <Pill value="Disputed" tone="warn" />;
  if (c.status === "PROMISED") return <Pill value={`Promised ${date(c.promise_date)}`} tone="info" />;
  if (c.escalated) return <Pill value="Escalated" tone="bad" />;
  if (c.promise_broken) return <Pill value="Promise missed" tone="bad" />;
  return <Pill value={c.overdue ? "Overdue" : "Open"} tone={c.overdue ? "warn" : "neutral"} />;
}

type Action = "promise" | "note" | "dispute" | "payment" | null;

/** Staff: every unpaid invoice across the network, oldest first, with what was done about it. */
export function Collections() {
  const [params, setParams] = useSearchParams();
  const filter = params.get("status") ?? "";
  const load = useLoad(() => api<Row>("GET", "/collections", { query: filter ? { status: filter } : {} }), [filter]);
  const act = useAction(load.reload);
  const [target, setTarget] = useState<{ row: Row; action: Action } | null>(null);
  const manage = can("collections.manage");
  const close = () => { setTarget(null); act.clear(); };
  const run = (key: string, row: Row, body?: unknown, done?: string | ((r: Row) => string)) => act.run(key, () => api<Row>("POST", `/collections/${row.ROWID}/${key}`, { body }), done).then((r) => { if (r) close(); return r; });
  return (
    <>
      <PageHeader title="Collections" crumbs={[["Contracts"], ["Collections"]]} subtitle="Unpaid fees, instalments and royalty invoices, how long they have waited, and what was done about each." />
      <Loaded load={load}>{(d) => {
        const t = d.totals as Row;
        return (
          <>
            <dl className="summary">
              <div><dt>Open</dt><dd>{inr(Number(t.open))}<span className="cell-sub">{t.count} invoice{t.count === 1 ? "" : "s"}</span></dd></div>
              <div><dt>Overdue</dt><dd style={{ color: t.overdue > 0 ? "var(--bad)" : undefined }}>{inr(Number(t.overdue))}<span className="cell-sub">{t.escalated ? `${t.escalated} escalated` : t.overdue_count ? `${t.overdue_count} past due` : "none past due"}</span></dd></div>
              <div><dt>Collected, 90 days</dt><dd>{t.rate_pct === null ? "—" : `${t.rate_pct}%`}<span className="cell-sub">{inr(Number(t.collected_90d))} of {inr(Number(t.billed_90d))} billed</span></dd></div>
              <div><dt>Days to pay</dt><dd>{t.days_to_pay === null ? "—" : t.days_to_pay}<span className="cell-sub">{t.broken ? `${t.broken} promise${t.broken === 1 ? "" : "s"} missed` : t.promised ? `${t.promised} promised` : "average, last 90 days"}</span></dd></div>
            </dl>
            {act.notice && <div className="notice ok"><Icon name="check" />{act.notice}</div>}
            <Panel flush>
              <DataTable rows={d.items as Row[]} searchKeys={["store", "franchisee", "invoice_number", "what"]} empty="Nothing to chase."
                toolbar={<select aria-label="Show" value={filter} onChange={(e) => setParams(e.target.value ? { status: e.target.value } : {})}>{FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}
                columns={[
                  { key: "store", label: "Store", render: (c) => <>{c.project_id ? <Link to={`/projects/${c.project_id}`}>{c.store}</Link> : c.store}<span className="cell-sub">{c.franchisee ?? ""}</span></> },
                  { key: "what", label: "For", render: (c) => <>{String(c.what).charAt(0).toUpperCase() + String(c.what).slice(1)}<span className="cell-sub">{KIND_TEXT[String(c.kind)] ?? c.kind}{c.invoice_number || c.zoho_books_invoice_id ? <> · <BooksInvoice id={c.zoho_books_invoice_id} number={c.invoice_number} fallback="Signing invoice" /></> : null}</span></> },
                  { key: "amount", label: "Owed", align: "right", sort: (c) => Number(c.amount), render: (c) => <>{inr(Number(c.amount))}{Number(c.total) > Number(c.amount) && c.status !== "PAID" && <span className="cell-sub">of {inr(Number(c.total))}</span>}</> },
                  { key: "days_late", label: "Age", sort: (c) => Number(c.days_late), render: (c) => <span className={c.overdue ? "bad-text" : ""}>{c.age}<span className="cell-sub">{c.due_date ? `Due ${date(c.due_date)}` : ""}{c.reminders_sent ? ` · ${c.reminders_sent} reminder${c.reminders_sent === 1 ? "" : "s"}` : ""}</span></span> },
                  { key: "status", label: "Status", render: (c) => <><StatusPill c={c} />{c.last_contact_note && <span className="cell-sub" title={c.last_contact_at ? date(c.last_contact_at) : undefined}>{String(c.last_contact_note).slice(0, 80)}</span>}</> },
                  ...(manage ? [{ key: "actions", label: "", render: (c: Row) => (["OPEN", "PROMISED", "DISPUTED"].includes(String(c.status)) ? <span className="panel-actions">
                    <button type="button" className="btn ghost sm" onClick={(e) => { e.stopPropagation(); setTarget({ row: c, action: "payment" }); }}>Record payment</button>
                    <button type="button" className="btn ghost sm" onClick={(e) => { e.stopPropagation(); setTarget({ row: c, action: "promise" }); }}>Promise</button>
                    <button type="button" className="btn ghost sm" onClick={(e) => { e.stopPropagation(); setTarget({ row: c, action: "note" }); }}>Note</button>
                    {c.status === "DISPUTED"
                      ? <button type="button" className="btn ghost sm" disabled={!!act.busy} onClick={(e) => { e.stopPropagation(); run("resume", c, {}, "Reminders resume for this invoice."); }}>Resume</button>
                      : <button type="button" className="btn ghost sm" onClick={(e) => { e.stopPropagation(); setTarget({ row: c, action: "dispute" }); }}>Dispute</button>}
                    <button type="button" className="btn ghost sm" disabled={!!act.busy || c.status === "DISPUTED"} onClick={(e) => { e.stopPropagation(); run("remind", c, undefined, "Reminder sent to the franchisee."); }}>Remind now</button>
                  </span> : null) }] : []),
                ]} />
            </Panel>
            <p className="muted small">Reminders follow the ladder under Settings → Collections: {(d.ladder as Row[]).map((s) => `${s.days < 0 ? `${-s.days} days before due` : s.days === 0 ? "on the due day" : `${s.days} days late`}${s.flag ? " (flagged)" : ""}`).join(", ")}. A promise holds the ladder until its date; a dispute pauses it.</p>
            {target?.action === "promise" && <PromiseDialog row={target.row} busy={act.busy === "promise"} error={act.error} onClose={close} onSave={(b) => run("promise", target.row, b, "Promise recorded; reminders wait for that date.")} />}
            {target?.action === "note" && <TextDialog title="Add a note" label="What was said" field="note" submit="Save note" row={target.row} busy={act.busy === "note"} error={act.error} onClose={close} onSave={(b) => run("note", target.row, b, "Note saved.")} />}
            {target?.action === "dispute" && <TextDialog title="Mark as disputed" subtitle="Reminders stop until someone resumes it. Say why." label="Reason" field="reason" submit="Mark disputed" row={target.row} busy={act.busy === "dispute"} error={act.error} onClose={close} onSave={(b) => run("dispute", target.row, b, "Disputed; reminders paused.")} />}
            {target?.action === "payment" && <PaymentDialog row={target.row} busy={act.busy === "payment"} error={act.error} onClose={close} onSave={(b) => run("payment", target.row, b, (r) => (r.status === "PAID" ? "Recorded in Zoho Books; the invoice is settled." : "Recorded in Zoho Books; a balance remains."))} />}
          </>
        );
      }}</Loaded>
    </>
  );
}

function Who({ row }: { row: Row }) {
  return <p className="muted" style={{ margin: "0 0 .5rem" }}>{row.store}: {inr(Number(row.amount))} for {row.what}{row.invoice_number ? ` (${row.invoice_number})` : ""}, {String(row.age).toLowerCase()}.</p>;
}

function PromiseDialog({ row, busy, error, onSave, onClose }: { row: Row; busy: boolean; error: ApiError | null; onSave: (b: { date: string; note: string | null }) => void; onClose: () => void }) {
  const [d, setD] = useState("");
  const [note, setNote] = useState("");
  return (
    <Dialog title="Promise to pay" onClose={onClose}>
      <Form onSubmit={() => onSave({ date: d, note: note.trim() || null })} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !d}>{busy ? "Saving…" : "Save promise"}</button></>}>
        <div className="span"><Who row={row} /></div>
        <Field label="Promised for" hint="Reminders wait until this day; if it passes unpaid, finance hears and the ladder resumes."><input type="date" value={d} onChange={(e) => setD(e.target.value)} required /></Field>
        <Field label="Note" span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Who promised, and how they will pay" maxLength={500} /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

function TextDialog({ title, subtitle, label, field, submit, row, busy, error, onSave, onClose }: { title: string; subtitle?: string; label: string; field: string; submit: string; row: Row; busy: boolean; error: ApiError | null; onSave: (b: Record<string, string>) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  return (
    <Dialog title={title} subtitle={subtitle} onClose={onClose}>
      <Form onSubmit={() => text.trim() && onSave({ [field]: text.trim() })} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !text.trim()}>{busy ? "Saving…" : submit}</button></>}>
        <div className="span"><Who row={row} /></div>
        <Field label={label} span><textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} autoFocus /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

function PaymentDialog({ row, busy, error, onSave, onClose }: { row: Row; busy: boolean; error: ApiError | null; onSave: (b: { amount: number; paid_on: string; mode: string; reference: string | null; note: string | null }) => void; onClose: () => void }) {
  const [amount, setAmount] = useState(String(row.amount ?? ""));
  const [on, setOn] = useState(new Date().toISOString().slice(0, 10));
  const [mode, setMode] = useState("banktransfer");
  const [ref, setRef] = useState("");
  const [note, setNote] = useState("");
  return (
    <Dialog title="Record a payment" subtitle="For money that arrived outside Zoho Books: a bank transfer, UPI, a cheque. It is recorded in Books against the invoice." onClose={onClose}>
      <Form onSubmit={() => onSave({ amount: Number(amount), paid_on: on, mode, reference: ref.trim() || null, note: note.trim() || null })} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !(Number(amount) > 0) || !on}>{busy ? "Recording…" : "Record in Books"}</button></>}>
        <div className="span"><Who row={row} /></div>
        <Field label="Amount received (₹)"><input type="number" min={1} step="0.01" max={Number(row.amount)} value={amount} onChange={(e) => setAmount(e.target.value)} required /></Field>
        <Field label="Received on"><input type="date" value={on} onChange={(e) => setOn(e.target.value)} required /></Field>
        <Field label="How"><select value={mode} onChange={(e) => setMode(e.target.value)}>{MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="Reference" hint="The UTR, cheque number or UPI reference."><input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={100} /></Field>
        <Field label="Note" span><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

// ---- Settings → Collections ----

interface LadderStep { days: number; franchisee: boolean; roles: string[]; flag: boolean }
interface CollectionsSettingsView { ladder: LadderStep[]; roles: string[]; defaults: { ladder: LadderStep[] } }
const ROLE_TEXT: Record<string, string> = { FRANCHISE_MANAGER: "Franchise manager", FINANCE_MANAGER: "Finance manager", FRANCHISE_DIRECTOR: "Director", REGIONAL_MANAGER: "Regional manager", OPERATIONS_MANAGER: "Operations manager" };

/** Admin → Settings → Collections: the reminder ladder. */
export function CollectionsSettings() {
  const load = useLoad(() => api<CollectionsSettingsView>("GET", "/settings/collections"), []);
  return <Loaded load={load}>{(d) => <LadderForm initial={d} />}</Loaded>;
}

function LadderForm({ initial }: { initial: CollectionsSettingsView }) {
  const [steps, setSteps] = useState<LadderStep[]>(initial.ladder);
  const act = useAction();
  const set = (i: number, patch: Partial<LadderStep>) => setSteps(steps.map((s, n) => (n === i ? { ...s, ...patch } : s)));
  const save = async () => {
    const r = await act.run("save", () => api<CollectionsSettingsView>("PUT", "/settings/collections", { body: { ladder: steps } }), "Ladder saved; tonight's reminders follow it.");
    if (r) setSteps(r.ladder);
  };
  return (
    <Panel title="Collections" action={<button type="button" className="btn ghost sm" onClick={() => setSteps(initial.defaults.ladder)}>Reset to default</button>}>
      {act.notice && <div className="notice ok"><Icon name="check" />{act.notice}</div>}
      <Form onSubmit={save} footer={<button className="btn" disabled={!!act.busy}>{act.busy === "save" ? "Saving…" : "Save ladder"}</button>}>
        <div className="span">
          <p className="field-hint" style={{ margin: "0 0 .5rem" }}>Who is reminded about an unpaid invoice, and when, counted from its due date. Each step goes out once per invoice, by email and in the inbox. A flagged step marks the store on the dashboard and caps its payment score.</p>
          <table className="plain-table">
            <thead><tr><th>When</th><th>Franchisee</th>{initial.roles.map((r) => <th key={r}>{ROLE_TEXT[r] ?? r}</th>)}<th>Flag</th><th /></tr></thead>
            <tbody>
              {steps.map((s, i) => (
                <tr key={i}>
                  <td><span className="panel-actions"><input type="number" min={-365} max={365} value={s.days} onChange={(e) => set(i, { days: Number(e.target.value) })} style={{ width: "5rem" }} /><span className="muted small">{s.days < 0 ? "days before due" : s.days === 0 ? "due day" : "days late"}</span></span></td>
                  <td><input type="checkbox" checked={s.franchisee} onChange={(e) => set(i, { franchisee: e.target.checked })} aria-label="Franchisee" /></td>
                  {initial.roles.map((r) => <td key={r}><input type="checkbox" checked={s.roles.includes(r)} onChange={(e) => set(i, { roles: e.target.checked ? [...s.roles, r] : s.roles.filter((x) => x !== r) })} aria-label={ROLE_TEXT[r] ?? r} /></td>)}
                  <td><input type="checkbox" checked={s.flag} onChange={(e) => set(i, { flag: e.target.checked })} aria-label="Flag the store" /></td>
                  <td><button type="button" className="link-btn" onClick={() => setSteps(steps.filter((_, n) => n !== i))} disabled={steps.length <= 1}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="btn ghost sm" style={{ marginTop: ".5rem" }} disabled={steps.length >= 10} onClick={() => setSteps([...steps, { days: Math.max(0, ...steps.map((s) => s.days)) + 7, franchisee: true, roles: [], flag: false }])}>Add a step</button>
        </div>
        <div className="span"><FormError error={act.error} /></div>
      </Form>
    </Panel>
  );
}

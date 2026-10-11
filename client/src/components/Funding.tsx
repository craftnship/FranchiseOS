import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError, can, Row } from "../api";
import { useAction, useLoad } from "../hooks";
import { upload } from "./Construction";
import { Dialog, Field, Form, FormError } from "./forms";
import { DataTable, date, Facts, Icon, inr, Loaded, PageHeader, Panel, Pill } from "./ui";

const FEE_TEXT: Record<string, string> = { SCHEDULED: "Scheduled", INVOICED: "Invoiced", PAID: "Paid", WAIVED: "Waived", REFUNDED: "Refunded" };
const FEE_TONE: Record<string, string> = { SCHEDULED: "neutral", INVOICED: "warn", PAID: "good", WAIVED: "neutral", REFUNDED: "info" };
const LOAN_TEXT: Record<string, string> = { SELF_FUNDED: "Self-funded", PLANNED: "Not applied yet", APPLIED: "Applied", SANCTIONED: "Sanctioned", DISBURSING: "Disbursing", DISBURSED: "Disbursed", REJECTED: "Rejected" };
const LOAN_TONE: Record<string, string> = { SELF_FUNDED: "good", PLANNED: "warn", APPLIED: "info", SANCTIONED: "good", DISBURSING: "info", DISBURSED: "good", REJECTED: "bad" };
const RAISE_ON: [string, string][] = [["SIGNING", "Straight away"], ["TASK", "When a checklist task is done"], ["OPENING", "When the store opens"], ["DATE", "On a date"]];
const DOCS = "application/pdf,image/jpeg,image/png,image/webp";
const today = () => new Date().toISOString().slice(0, 10);

function FeeStatus({ f }: { f: Row }) {
  if (f.due_now) return <Pill value="Ready to invoice" tone="warn" />;
  if (f.overdue) return <Pill value="Overdue" tone="bad" />;
  return <Pill value={FEE_TEXT[String(f.status)] ?? f.status} tone={FEE_TONE[String(f.status)]} />;
}

type FeeDlg = null | { kind: "instalment"; fee?: Row } | { kind: "waive"; fee: Row } | { kind: "refund"; fee: Row };
type LoanDlg = null | "plan" | "applied" | "sanctioned" | "rejected" | "disbursed";

/**
 * A store's franchise fee schedule and the franchisee's funding. fee.manage keeps the schedule;
 * `editable` (staff with project.write) and `portal` (the franchisee) record the loan.
 */
export function FundingPanel({ projectId, editable, portal, closed }: { projectId: string; editable: boolean; portal?: boolean; closed?: boolean }) {
  const load = useLoad(() => api<Row>("GET", `/projects/${projectId}/funding`), [projectId]);
  const act = useAction(load.reload);
  const [feeDlg, setFeeDlg] = useState<FeeDlg>(null);
  const [loanDlg, setLoanDlg] = useState<LoanDlg>(null);
  const manage = !portal && can("fee.manage");
  const canLoan = !closed && (editable || !!portal);
  const base = `/projects/${projectId}`;
  const close = () => { setFeeDlg(null); setLoanDlg(null); act.clear(); };
  const done = (r: unknown) => { if (r) { setFeeDlg(null); setLoanDlg(null); } };
  const fee = (f: Row, body: Row, msg: (r: Row) => string) => act.run(`f${f.ROWID}`, () => api<Row>("PATCH", `${base}/fees/${f.ROWID}`, { body }), msg);
  const loan = (body: Row, msg: string) => act.run("loan", () => api<Row>("PATCH", `${base}/funding`, { body }), msg).then(done);

  return (
    <Loaded load={load}>{(d) => {
      const fees = d.instalments as Row[], t = d.totals as Row, plan = d.plan as Row | null, fu = d.funding as Row;
      const status = String(plan?.status ?? "");
      const dialogOpen = !!(feeDlg || loanDlg);
      const notice = act.notice && <div className="notice ok" style={{ margin: ".75rem 1rem 0" }}><Icon name="check" />{act.notice}</div>;
      const error = act.error && !dialogOpen && <div style={{ margin: ".75rem 1rem 0" }}><FormError error={act.error} /></div>;
      return (
        <>
          <Panel title="Franchise fee and deposit" flush action={manage && d.agreement && !closed && <button className="btn sm" onClick={() => setFeeDlg({ kind: "instalment" })}>Add instalment</button>}>
            {!d.agreement ? <p className="muted" style={{ margin: "1rem" }}>The fee schedule starts when the agreement is signed.</p> : <>
              <dl className="summary flat">
                <div><dt>Franchise fee</dt><dd>{inr(Number(t.fee))}<span className="cell-sub">before tax</span></dd></div>
                <div><dt>Not invoiced yet</dt><dd>{inr(Number(t.scheduled))}</dd></div>
                <div><dt>Outstanding</dt><dd style={{ color: t.overdue ? "var(--bad)" : Number(t.outstanding) > 0 ? "var(--warn)" : undefined }}>{inr(Number(t.outstanding))}{t.overdue > 0 && <span className="cell-sub">{t.overdue} overdue</span>}</dd></div>
                <div><dt>Deposit held</dt><dd>{inr(Number(t.deposit_held))}</dd></div>
              </dl>
              {!feeDlg && notice}{!feeDlg && error}
              {manage && Number(d.franchise_fee) > 0 && Math.abs(Number(t.fee) - Number(d.franchise_fee)) > 0.5 && <div className="notice warn" style={{ margin: ".75rem 1rem 0" }}><Icon name="alert" /><span>The instalments add up to {inr(Number(t.fee))}; the network's franchise fee is {inr(Number(d.franchise_fee))}.</span></div>}
              <DataTable rows={fees} empty="No instalments." columns={[
                { key: "label", label: "Instalment", render: (f) => <span style={{ display: "block", minWidth: "9rem", color: f.status === "WAIVED" ? "var(--muted)" : undefined }}>{f.label}<span className="cell-sub">{f.kind === "DEPOSIT" ? "Refundable, no tax" : f.signing_invoice ? "The agreement's signing invoice" : "Fee instalment"}{f.status === "WAIVED" && f.status_note ? ` · ${f.status_note}` : ""}</span></span> },
                { key: "when", label: "When", render: (f) => f.invoiced_on ? `Invoiced ${date(f.invoiced_on)}` : <span className="muted">{f.status === "WAIVED" ? "—" : f.when}</span> },
                { key: "amount", label: "Amount", align: "right", sort: (f) => Number(f.amount), render: (f) => inr(Number(f.amount)) },
                { key: "status", label: "Status", render: (f) => <span><FeeStatus f={f} />{f.status === "PAID" && f.paid_on && <span className="cell-sub">{date(f.paid_on)}</span>}{f.status === "REFUNDED" && <span className="cell-sub">{date(f.refunded_on)}</span>}</span> },
                { key: "invoice_number", label: "Books invoice", render: (f) => f.invoice_number || f.zoho_books_invoice_id
                  ? <>{f.invoice_number ?? "Invoice raised"}<span className="cell-sub">{f.status === "INVOICED" ? `${inr(Number(f.invoice_balance ?? f.invoice_total ?? 0))} due${f.invoice_due_date ? ` ${date(f.invoice_due_date)}` : ""} · with tax` : f.invoice_total != null ? `${inr(Number(f.invoice_total))} with tax` : ""}</span></>
                  : <span className="muted">—</span> },
                ...(manage && !closed ? [{ key: "actions", label: "", align: "right" as const, render: (f: Row) => {
                  const busy = act.busy === `f${f.ROWID}`;
                  return (
                    <span className="panel-actions">
                      {f.status === "SCHEDULED" && <button className={`btn ${f.due_now ? "" : "ghost "}sm`} disabled={busy} onClick={() => fee(f, { action: "raise" }, (r) => `${f.label}: invoice ${r.invoice_number ?? ""} raised in Zoho Books and sent.`)}>{busy ? "Raising…" : "Raise now"}</button>}
                      {f.status === "SCHEDULED" && <button className="btn ghost sm" disabled={busy} onClick={() => setFeeDlg({ kind: "instalment", fee: f })}>Edit</button>}
                      {f.status === "SCHEDULED" && <button className="btn danger-ghost sm" disabled={busy} onClick={() => setFeeDlg({ kind: "waive", fee: f })}>Waive</button>}
                      {f.status === "INVOICED" && !f.signing_invoice && <button className="btn ghost sm" disabled={busy} onClick={() => fee(f, { action: "refresh" }, (r) => r.status === "PAID" ? `${f.label} is paid.` : `${f.label}: ${inr(Number(r.invoice_balance ?? 0))} still due.`)}>Check Books</button>}
                      {f.status === "PAID" && f.kind === "DEPOSIT" && <button className="btn ghost sm" disabled={busy} onClick={() => setFeeDlg({ kind: "refund", fee: f })}>Refund</button>}
                    </span>
                  );
                } }] : []),
              ]} />
              <p className="muted" style={{ margin: ".5rem 1rem .75rem", fontSize: ".85rem" }}>{portal ? "Each instalment is invoiced by Zoho Books and emailed to you when it falls due." : "Instalments are raised in Zoho Books by the nightly sync once they fall due; payments come back the same way."}</p>
            </>}
          </Panel>

          <Panel title="Funding" flush action={canLoan && <span className="panel-actions">
            {(!plan || !["SANCTIONED", "DISBURSING", "DISBURSED"].includes(status)) && <button className={`btn ${plan ? "ghost " : ""}sm`} onClick={() => setLoanDlg("plan")}>{plan ? "Edit plan" : "Set funding plan"}</button>}
            {["SANCTIONED", "DISBURSING", "DISBURSED"].includes(status) && <button className="btn ghost sm" onClick={() => setLoanDlg("plan")}>Edit own capital</button>}
            {["PLANNED", "REJECTED"].includes(status) && <button className="btn sm" onClick={() => setLoanDlg("applied")}>Record loan application</button>}
            {status === "APPLIED" && <><button className="btn sm" onClick={() => setLoanDlg("sanctioned")}>Record sanction</button><button className="btn danger-ghost sm" onClick={() => setLoanDlg("rejected")}>Rejected</button></>}
            {["SANCTIONED", "DISBURSING"].includes(status) && <button className="btn sm" onClick={() => setLoanDlg("disbursed")}>Record disbursement</button>}
          </span>}>
            <dl className="summary flat">
              <div><dt>Capex budget</dt><dd>{fu.investment > 0 ? inr(Number(fu.investment)) : "—"}</dd></div>
              <div><dt>Secured</dt><dd>{inr(Number(fu.secured))}{fu.secured_pct != null && <span className="cell-sub">{fu.secured_pct}% of budget</span>}</dd></div>
              <div><dt>Gap</dt><dd style={{ color: fu.gap > 0 ? "var(--warn)" : undefined }}>{fu.investment > 0 ? inr(Number(fu.gap)) : "—"}{fu.gap > 0 && fu.planned_gap === 0 && <span className="cell-sub">closes when the loan is sanctioned</span>}</dd></div>
              <div><dt>Loan disbursed</dt><dd>{plan && Number(plan.loan_amount) > 0 ? inr(Number(fu.disbursed)) : "—"}</dd></div>
            </dl>
            {!loanDlg && notice}{!loanDlg && error}
            {!plan ? <p className="muted" style={{ margin: "1rem" }}>{canLoan ? "Record how the store is paid for: own capital and any bank loan." : "The franchisee hasn't shared a funding plan yet."}</p> : (
              <div style={{ padding: ".25rem 1rem 1rem" }}>
                <Facts items={[
                  ["Own capital", inr(Number(plan.own_capital))],
                  ["Loan", Number(plan.loan_amount) > 0 ? <><Pill value={LOAN_TEXT[status] ?? status} tone={LOAN_TONE[status]} /> {inr(Number(plan.loan_amount))} asked</> : <Pill value="Self-funded" tone="good" />],
                  ...(plan.lender ? [["Lender", <>{plan.lender}{plan.loan_ref ? <span className="cell-sub">Ref {plan.loan_ref}</span> : null}</>] as [string, JSX.Element]] : []),
                  ...(plan.applied_on ? [["Applied", date(plan.applied_on)] as [string, string]] : []),
                  ...(plan.sanctioned_amount != null && status !== "REJECTED" && status !== "APPLIED" ? [["Sanctioned", <>{inr(Number(plan.sanctioned_amount))} on {date(plan.sanctioned_on)}<span className="cell-sub">{[plan.interest_pct != null ? `${plan.interest_pct}% interest` : null, plan.tenure_months ? `${plan.tenure_months} months` : null].filter(Boolean).join(" · ")}</span></>] as [string, JSX.Element]] : []),
                  ...(status === "REJECTED" ? [["Rejected", plan.rejected_reason || "—"] as [string, string]] : []),
                ]} />
                {(plan.disbursements as Row[]).length > 0 && <p className="muted" style={{ margin: ".5rem 0 0" }}>Disbursed: {(plan.disbursements as Row[]).map((x) => `${inr(Number(x.amount))} on ${date(x.date)}`).join(", ")}.</p>}
                {plan.sanction_ref && <button className="btn ghost sm" style={{ marginTop: ".5rem" }} onClick={() => act.run("letter", async () => { const r = await api<{ url: string }>("GET", `${base}/funding/sanction-letter`); window.open(r.url, "_blank", "noopener"); })}>Sanction letter</button>}
              </div>
            )}
          </Panel>

          {feeDlg?.kind === "instalment" && <InstalmentDialog fee={feeDlg.fee} tasks={d.tasks as Row[]} busy={act.busy === "inst"} error={act.error} onClose={close}
            onSave={(body) => act.run("inst", () => feeDlg.fee ? api<Row>("PATCH", `${base}/fees/${feeDlg.fee.ROWID}`, { body: { action: "edit", ...body } }) : api<Row>("POST", `${base}/fees`, { body }), (r) => `${r.label} saved.`).then(done)} />}
          {feeDlg?.kind === "waive" && <NoteDialog title={`Waive “${feeDlg.fee.label}”?`} subtitle={`${inr(Number(feeDlg.fee.amount))} won't be invoiced. The row stays for the record.`} label="Reason" confirm="Waive" danger busy={act.busy === `f${feeDlg.fee.ROWID}`} error={act.error} onClose={close}
            onSave={(note) => fee(feeDlg.fee, { action: "waive", note }, () => `${feeDlg.fee.label} waived.`).then(done)} />}
          {feeDlg?.kind === "refund" && <RefundDialog fee={feeDlg.fee} busy={act.busy === `f${feeDlg.fee.ROWID}`} error={act.error} onClose={close}
            onSave={(body) => fee(feeDlg.fee, { action: "refund", ...body }, () => "Deposit refund recorded.").then(done)} />}
          {loanDlg === "plan" && <PlanDialog plan={plan} locked={["SANCTIONED", "DISBURSING", "DISBURSED"].includes(status)} budget={Number(fu.investment)} busy={act.busy === "loan"} error={act.error} onClose={close}
            onSave={(body) => loan({ action: "plan", ...body }, "Funding plan saved.")} />}
          {loanDlg && loanDlg !== "plan" && <LoanStepDialog step={loanDlg} plan={plan!} busy={act.busy === "loan"} error={act.error} onClose={close}
            onSave={(body, msg) => loan({ action: loanDlg, ...body }, msg)} />}
        </>
      );
    }}</Loaded>
  );
}

function InstalmentDialog({ fee, tasks, busy, error, onSave, onClose }: { fee?: Row; tasks: Row[]; busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const str = (k: string, d = "") => (fee?.[k] === null || fee?.[k] === undefined ? d : String(fee[k]));
  const [v, setV] = useState({ kind: str("kind", "FEE"), label: str("label"), amount: str("amount"), raise_on: str("raise_on", "DATE"), task_code: str("task_code", String(tasks[0]?.code ?? "")), due_on: str("due_on").slice(0, 10) });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((p) => ({ ...p, [k]: e.target.value }));
  const ok = v.label.trim().length >= 2 && Number(v.amount) > 0 && (v.raise_on !== "DATE" || !!v.due_on) && (v.raise_on !== "TASK" || !!v.task_code);
  return (
    <Dialog title={fee ? `Edit “${fee.label}”` : "Add an instalment"} subtitle="Amounts are before tax. It is raised in Zoho Books once it falls due." onClose={onClose}>
      <Form onSubmit={() => onSave({ kind: v.kind, label: v.label.trim(), amount: Number(v.amount), raise_on: v.raise_on, task_code: v.raise_on === "TASK" ? v.task_code : null, due_on: v.raise_on === "DATE" ? v.due_on : null })}
        footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !ok}>{busy ? "Saving…" : "Save"}</button></>}>
        <Field label="What for" span><input value={v.label} onChange={set("label")} maxLength={120} required autoFocus placeholder="At fit-out" /></Field>
        <Field label="Type"><select value={v.kind} onChange={set("kind")}><option value="FEE">Franchise fee</option><option value="DEPOSIT">Security deposit (refundable)</option></select></Field>
        <Field label="Amount (₹, before tax)"><input type="number" min={1} step="any" value={v.amount} onChange={set("amount")} required /></Field>
        <Field label="Raise it" span><select value={v.raise_on} onChange={set("raise_on")}>{RAISE_ON.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        {v.raise_on === "TASK" && <Field label="Task" span><select value={v.task_code} onChange={set("task_code")}>{tasks.map((t) => <option key={String(t.code)} value={String(t.code)}>{t.name}{t.status === "COMPLETED" ? " (done)" : ""}</option>)}</select></Field>}
        {v.raise_on === "DATE" && <Field label="Due on"><input type="date" value={v.due_on} onChange={set("due_on")} required /></Field>}
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

function NoteDialog({ title, subtitle, label, confirm, danger, busy, error, onSave, onClose }: { title: string; subtitle: string; label: string; confirm: string; danger?: boolean; busy: boolean; error: ApiError | null; onSave: (note: string) => void; onClose: () => void }) {
  const [note, setNote] = useState("");
  return (
    <Dialog title={title} subtitle={subtitle} onClose={onClose}>
      <Form onSubmit={() => onSave(note.trim())} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className={`btn ${danger ? "danger" : ""}`} disabled={busy || note.trim().length < 3}>{busy ? "Saving…" : confirm}</button></>}>
        <Field label={label} span><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} required autoFocus /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

function RefundDialog({ fee, busy, error, onSave, onClose }: { fee: Row; busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const [day, setDay] = useState(today());
  const [note, setNote] = useState("");
  return (
    <Dialog title="Refund the security deposit" subtitle={`${inr(Number(fee.amount))}. Record the refund here once it's paid back; credit it in Zoho Books as usual.`} onClose={onClose}>
      <Form onSubmit={() => onSave({ refunded_on: day, ...(note.trim() ? { note: note.trim() } : {}) })} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !day}>{busy ? "Saving…" : "Record refund"}</button></>}>
        <Field label="Refunded on"><input type="date" value={day} max={today()} onChange={(e) => setDay(e.target.value)} required autoFocus /></Field>
        <Field label="Note (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Bank reference" /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

function PlanDialog({ plan, locked, budget, busy, error, onSave, onClose }: { plan: Row | null; locked: boolean; budget: number; busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const [own, setOwn] = useState(plan ? String(plan.own_capital ?? "") : "");
  const [loanAmt, setLoanAmt] = useState(plan ? String(plan.loan_amount ?? "0") : "");
  const [lender, setLender] = useState(String(plan?.lender ?? ""));
  const total = Number(own || 0) + Number(loanAmt || 0);
  return (
    <Dialog title="Funding plan" subtitle={budget > 0 ? `The store's capex budget is ${inr(budget)}.` : "How the store's fit-out, equipment and opening costs are paid for."} onClose={onClose}>
      <Form onSubmit={() => onSave({ own_capital: Number(own), loan_amount: Number(loanAmt || 0), ...(lender.trim() ? { lender: lender.trim() } : {}) })}
        footer={<><span className="muted" style={{ marginRight: "auto" }}>{inr(total)}{budget > 0 ? ` of ${inr(budget)}` : ""}</span><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || own === ""}>{busy ? "Saving…" : "Save"}</button></>}>
        <Field label="Own capital (₹)"><input type="number" min={0} step="any" value={own} onChange={(e) => setOwn(e.target.value)} required autoFocus /></Field>
        <Field label="Bank loan (₹)" hint={locked ? "Sanctioned; it can't change now." : "0 if self-funded."}><input type="number" min={0} step="any" value={loanAmt} onChange={(e) => setLoanAmt(e.target.value)} disabled={locked} /></Field>
        {!locked && Number(loanAmt) > 0 && <Field label="Lender (optional)" span><input value={lender} onChange={(e) => setLender(e.target.value)} maxLength={120} placeholder="HDFC Bank" /></Field>}
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

const STEP_TITLE: Record<string, string> = { applied: "Loan application", sanctioned: "Loan sanctioned", rejected: "Loan rejected", disbursed: "Loan disbursement" };

function LoanStepDialog({ step, plan, busy, error, onSave, onClose }: { step: string; plan: Row; busy: boolean; error: ApiError | null; onSave: (b: Row, msg: string) => void; onClose: () => void }) {
  const [v, setV] = useState({ lender: String(plan.lender ?? ""), on: today(), ref: "", amount: step === "sanctioned" ? String(plan.loan_amount ?? "") : step === "disbursed" ? String(Math.max(0, Number(plan.sanctioned_amount ?? 0) - Number(plan.disbursed_amount ?? 0))) : "", interest: "", tenure: "", reason: "" });
  const [file, setFile] = useState<File | null>(null);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((p) => ({ ...p, [k]: e.target.value }));
  const submit = async () => {
    if (step === "applied") return onSave({ lender: v.lender.trim(), applied_on: v.on, ...(v.ref.trim() ? { loan_ref: v.ref.trim() } : {}) }, `Loan application with ${v.lender.trim()} recorded.`);
    if (step === "sanctioned") return onSave({ sanctioned_on: v.on, sanctioned_amount: Number(v.amount), ...(v.interest ? { interest_pct: Number(v.interest) } : {}), ...(v.tenure ? { tenure_months: Number(v.tenure) } : {}), ...(file ? { letter: await upload(file) } : {}) }, `Sanction of ${inr(Number(v.amount))} recorded.`);
    if (step === "rejected") return onSave({ reason: v.reason.trim() }, "Rejection recorded. Apply again with another lender when ready.");
    return onSave({ amount: Number(v.amount), disbursed_on: v.on, ...(v.ref.trim() ? { note: v.ref.trim() } : {}) }, `${inr(Number(v.amount))} disbursement recorded.`);
  };
  const ok = step === "applied" ? v.lender.trim().length >= 2 && !!v.on : step === "rejected" ? v.reason.trim().length >= 3 : Number(v.amount) > 0 && !!v.on;
  return (
    <Dialog title={STEP_TITLE[step]} subtitle={step === "disbursed" ? `${inr(Number(plan.disbursed_amount ?? 0))} of ${inr(Number(plan.sanctioned_amount))} disbursed so far.` : plan.lender ? String(plan.lender) : undefined} onClose={onClose}>
      <Form onSubmit={submit} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className={`btn ${step === "rejected" ? "danger" : ""}`} disabled={busy || !ok}>{busy ? "Saving…" : "Save"}</button></>}>
        {step === "applied" && <Field label="Lender" span><input value={v.lender} onChange={set("lender")} maxLength={120} required autoFocus /></Field>}
        {step === "rejected" && <Field label="Reason the bank gave" span><input value={v.reason} onChange={set("reason")} maxLength={500} required autoFocus /></Field>}
        {(step === "sanctioned" || step === "disbursed") && <Field label={step === "sanctioned" ? "Sanctioned amount (₹)" : "Amount (₹)"}><input type="number" min={1} step="any" value={v.amount} onChange={set("amount")} required autoFocus /></Field>}
        {step !== "rejected" && <Field label={step === "applied" ? "Applied on" : step === "sanctioned" ? "Sanctioned on" : "Disbursed on"}><input type="date" value={v.on} max={today()} onChange={set("on")} required /></Field>}
        {step === "applied" && <Field label="Application number (optional)"><input value={v.ref} onChange={set("ref")} maxLength={100} /></Field>}
        {step === "sanctioned" && <>
          <Field label="Interest (% a year, optional)"><input type="number" min={0} max={50} step="0.01" value={v.interest} onChange={set("interest")} /></Field>
          <Field label="Tenure in months (optional)"><input type="number" min={1} max={360} value={v.tenure} onChange={set("tenure")} /></Field>
          <Field label="Sanction letter (optional)" hint="PDF or a photo, up to 5 MB." span><input type="file" accept={DOCS} onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
        </>}
        {step === "disbursed" && <Field label="Note (optional)"><input value={v.ref} onChange={set("ref")} maxLength={500} placeholder="Paid to the fit-out contractor" /></Field>}
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

/** Portal: the franchisee's fee instalments and loan. */
export function PortalFunding() {
  const home = useLoad(() => api<Row>("GET", "/portal/home"), []);
  return (
    <>
      <PageHeader title="Funding and fees" subtitle="Your franchise fee instalments, and how the store is funded." />
      <Loaded load={home}>{(h) => h.project ? <FundingPanel projectId={String(h.project.ROWID)} editable={false} portal closed={h.project.status === "CLOSED"} />
        : <div className="state">This opens once your agreement is signed.</div>}</Loaded>
    </>
  );
}

const FILTERS: [string, string][] = [["", "All"], ["SCHEDULED", "Scheduled"], ["INVOICED", "Unpaid"], ["overdue", "Overdue"], ["PAID", "Paid"], ["WAIVED", "Waived"]];

/** Staff: every fee instalment across the network. */
export function Fees() {
  const [params, setParams] = useSearchParams();
  const filter = params.get("overdue") === "true" ? "overdue" : params.get("status") ?? "";
  const load = useLoad(() => api<Row>("GET", "/fees", { query: filter && filter !== "overdue" ? { status: filter } : filter === "overdue" ? { status: "INVOICED" } : {} }), [filter]);
  const choose = (v: string) => setParams(v === "overdue" ? { overdue: "true" } : v ? { status: v } : {});
  return (
    <>
      <PageHeader title="Franchise fees" crumbs={[["Contracts"], ["Franchise fees"]]} subtitle="Every store's fee instalments and deposits, and where each stands in Zoho Books." />
      <Loaded load={load}>{(d) => {
        const t = d.totals as Row;
        const rows = (d.items as Row[]).filter((r) => filter !== "overdue" || r.overdue);
        return (
          <>
            <dl className="summary">
              <div><dt>Not invoiced yet</dt><dd>{inr(Number(t.scheduled))}</dd></div>
              <div><dt>Outstanding</dt><dd style={{ color: t.outstanding > 0 ? "var(--warn)" : undefined }}>{inr(Number(t.outstanding))}</dd></div>
              <div><dt>Overdue</dt><dd style={{ color: t.overdue > 0 ? "var(--bad)" : undefined }}>{t.overdue}</dd></div>
              <div><dt>Deposits held</dt><dd>{inr(Number(t.deposits_held))}</dd></div>
            </dl>
            <Panel flush>
              <DataTable rows={rows} href={(r) => `/projects/${r.project_id}`} searchKeys={["project_code", "franchisee", "label", "invoice_number"]} empty="No instalments match."
                toolbar={<select aria-label="Status" value={filter} onChange={(e) => choose(e.target.value)}>{FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}
                columns={[
                  { key: "project_code", label: "Store", render: (r) => <><Link to={`/projects/${r.project_id}`}>{String(r.project_code ?? "—")}</Link><span className="cell-sub">{String(r.franchisee ?? "")}</span></> },
                  { key: "label", label: "Instalment", render: (r) => <>{r.label}<span className="cell-sub">{r.kind === "DEPOSIT" ? "Refundable deposit" : "Fee instalment"}</span></> },
                  { key: "amount", label: "Amount", align: "right", sort: (r) => Number(r.amount), render: (r) => inr(Number(r.amount)) },
                  { key: "status", label: "Status", render: (r) => <FeeStatus f={r} /> },
                  { key: "invoice_number", label: "Invoice", render: (r) => r.invoice_number || r.zoho_books_invoice_id ? <>{String(r.invoice_number ?? "Signing invoice")}<span className="cell-sub">{r.status === "INVOICED" ? `${inr(Number(r.invoice_balance ?? 0))} due${r.invoice_due_date ? ` ${date(r.invoice_due_date)}` : ""}` : r.paid_on ? `Paid ${date(r.paid_on)}` : ""}</span></> : <span className="muted">—</span> },
                ]} />
            </Panel>
          </>
        );
      }}</Loaded>
    </>
  );
}

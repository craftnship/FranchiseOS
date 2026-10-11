import { useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, can, Row } from "../api";
import { useAction, useLoad } from "../hooks";
import { Dialog, Field, Form, FormError } from "./forms";
import { DataTable, date, Icon, inr, inrShort, Loaded, PageHeader, Panel, Pill } from "./ui";

// Opening day: the grand-opening plan, the first-weeks sales watch, and agreement renewals.

const RATING_TONE: Record<string, string> = { GREEN: "good", AMBER: "warn", RED: "bad" };
const RATING_TEXT: Record<string, string> = { GREEN: "On plan", AMBER: "Below plan", RED: "Well below" };
const TASK_TEXT: Record<string, string> = { OPEN: "To do", DONE: "Done", SKIPPED: "Skipped" };
const TASK_TONE: Record<string, string> = { OPEN: "neutral", DONE: "good", SKIPPED: "neutral" };
const RENEWAL_TEXT: Record<string, string> = { IN_DISCUSSION: "In discussion", RENEWING: "Renewing", NOT_RENEWING: "Not renewing", RENEWED: "Renewed" };
const RENEWAL_TONE: Record<string, string> = { IN_DISCUSSION: "info", RENEWING: "info", NOT_RENEWING: "bad", RENEWED: "good" };
const today = () => new Date().toISOString().slice(0, 10);
const pct = (v: unknown) => (v == null ? "—" : `${v}%`);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "15–21 Jul", or "26 Aug – 1 Sep" across a month end. */
const range = (from: unknown, to: unknown) => {
  const a = new Date(String(from).slice(0, 10) + "T00:00:00Z"), b = new Date(String(to).slice(0, 10) + "T00:00:00Z");
  return a.getUTCMonth() === b.getUTCMonth() ? `${a.getUTCDate()}–${b.getUTCDate()} ${MON[b.getUTCMonth()]}` : `${a.getUTCDate()} ${MON[a.getUTCMonth()]} – ${b.getUTCDate()} ${MON[b.getUTCMonth()]}`;
};
const Bar = ({ w }: { w: Row }) => w.pct != null
  ? <span className="week-bar"><span className="track"><span className={`fill ${RATING_TONE[String(w.rating)] ?? ""}`} style={{ width: `${Math.min(100, Number(w.pct))}%` }} /></span><em>{pct(w.pct)}</em></span> : <span className="muted">—</span>;

export function Rating({ pct: p, rating }: { pct: unknown; rating: unknown }) {
  if (p == null) return <span className="muted">—</span>;
  return <span style={{ display: "inline-flex", alignItems: "center", gap: ".4rem" }}><strong>{String(p)}%</strong>{rating ? <Pill value={RATING_TEXT[String(rating)]} tone={RATING_TONE[String(rating)]} /> : null}</span>;
}

const when = (t: Row, opening: string | null) => {
  if (!opening || !t.due_date) return "";
  const d = Math.round((Date.parse(String(t.due_date)) - Date.parse(opening)) / 86_400_000);
  return d === 0 ? "On the day" : d < 0 ? `${-d} day${d === -1 ? "" : "s"} before` : `${d} day${d === 1 ? "" : "s"} after`;
};

/** A store's opening day: the grand-opening plan and, once open, its weekly sales against plan. */
export function LaunchPanel({ projectId, target, portal }: { projectId: string; target?: unknown; portal?: boolean }) {
  const load = useLoad(() => api<Row>("GET", `/projects/${projectId}/launch`), [projectId]);
  const act = useAction(load.reload);
  const staff = !portal && can("project.write");
  const [dlg, setDlg] = useState<null | { kind: "date" | "add" | "week" | "skip"; row?: Row }>(null);
  const close = () => { setDlg(null); act.clear(); };
  const task = (t: Row, body: Row, msg: string) => act.run(`t${t.ROWID}`, () => api<Row>("PATCH", `/launch-tasks/${t.ROWID}`, { body }), msg);
  return (
    <Loaded load={load}>{(l) => {
      if (!l.planned && !l.watched && !(staff && l.can_plan)) return portal ? <div className="state">Your launch plan appears here once the brand team sets your grand-opening day.</div> : null;
      const tasks = l.tasks as Row[], weeks = l.weeks as Row[];
      const opening = (l.grand_opening_date ?? l.opened_on) as string | null;
      // Finished or reported weeks, plus the week under way; the latest first on the portal.
      const shown = weeks.filter((w) => w.finished || w.net_sales != null || w.week_no === (l.weeks_finished as number) + 1);
      if (portal) shown.reverse();
      const mayTick = (t: Row) => staff || (portal && t.owner_side === "FRANCHISEE");
      return (
        <Panel title="Opening day" flush action={staff && l.can_plan && <button className="btn sm secondary" onClick={() => setDlg({ kind: "date" })}>{l.grand_opening_date ? "Move grand opening" : "Set grand opening"}</button>}>
          <dl className="summary flat">
            <div><dt>{l.grand_opening_date ? "Grand opening" : "Opened"}</dt><dd>{l.grand_opening_date ? date(l.grand_opening_date) : date(l.opened_on)}{l.opened_on && l.grand_opening_date && l.opened_on !== l.grand_opening_date && <span className="cell-sub">Opened {date(l.opened_on)}</span>}</dd></div>
            <div><dt>Launch tasks</dt><dd>{tasks.length ? `${l.tasks_done} of ${tasks.length}` : "—"}{l.tasks_overdue > 0 && <span className="cell-sub" style={{ color: "var(--bad)" }}>{l.tasks_overdue} overdue</span>}</dd></div>
            <div><dt>Sales vs plan</dt><dd>{l.watched ? <Rating pct={l.to_date_pct} rating={l.to_date_rating} /> : l.opened_on ? "Not watched" : "After opening"}{l.watched && <span className="cell-sub">{l.monthly_plan ? `${inrShort(Number(l.sales_to_date))} to date` : "No feasibility plan"}</span>}</dd></div>
            <div><dt>Weeks reported</dt><dd>{l.watched ? `${weeks.filter((w) => w.net_sales != null).length} of ${l.weeks_finished}` : "—"}{l.weeks_missing > 0 && <span className="cell-sub" style={{ color: "var(--warn)" }}>{l.weeks_missing} missing</span>}</dd></div>
          </dl>
          {act.notice && <div className="notice ok" style={{ margin: ".75rem 1rem 0" }}><Icon name="check" />{act.notice}</div>}
          {act.error && !dlg && <div style={{ margin: ".75rem 1rem 0" }}><FormError error={act.error} /></div>}
          {l.behind && <div className="notice bad" style={{ margin: ".75rem 1rem 0" }}><Icon name="alert" /><span>Two weeks running below {String(l.behind_pct)}% of plan. {portal ? "The brand team will be in touch to help." : "Call the franchisee and agree a plan."}</span></div>}
          {!l.planned && staff && <div className="state">Set the grand-opening day to build the launch plan: {tasks.length || "a dozen"} tasks from marketing to the two-week check-in.</div>}

          {l.watched && weeks.length > 0 && <>
            <h3 className="sub-head">First {String(l.watch_weeks)} weeks</h3>
            {portal ? (
              // The franchisee reports from a phone, so each week is a row of its own.
              <ul className="module-list">
                {shown.map((w) => (
                  <li key={String(w.week_no)}>
                    <span style={{ flex: "1 1 10rem" }}>Week {w.week_no}<span className="cell-sub">{range(w.week_start, w.week_end)}</span></span>
                    <span style={{ flex: "1 1 9rem" }}>{w.net_sales != null ? inr(Number(w.net_sales)) : w.finished ? <span style={{ color: "var(--warn)" }}>Not reported</span> : <span className="muted">This week</span>}<span className="cell-sub">Plan {w.target ? inr(Number(w.target)) : "—"}</span></span>
                    <span className="panel-actions"><Bar w={w} />{w.finished && <button className={`btn sm ${w.net_sales != null ? "ghost" : ""}`} onClick={() => setDlg({ kind: "week", row: w })}>{w.net_sales != null ? "Change" : "Report"}</button>}</span>
                  </li>
                ))}
              </ul>
            ) : <DataTable rows={shown} empty="" columns={[
              { key: "week_no", label: "Week", render: (w) => <>Week {w.week_no}<span className="cell-sub">{range(w.week_start, w.week_end)}</span></> },
              { key: "net_sales", label: "Net sales", align: "right", render: (w) => w.net_sales != null ? inr(Number(w.net_sales)) : w.finished ? <span style={{ color: "var(--warn)" }}>Not reported</span> : <span className="muted">This week</span> },
              { key: "target", label: "Plan", align: "right", render: (w) => w.target ? inr(Number(w.target)) : "—" },
              { key: "pct", label: "Of plan", render: (w) => <Bar w={w} /> },
              { key: "actions", label: "", align: "right", render: (w) => staff && w.finished ? <button className="btn ghost sm" onClick={() => setDlg({ kind: "week", row: w })}>{w.net_sales != null ? "Change" : "Report"}</button> : null },
            ]} />}
          </>}

          {tasks.length > 0 && <>
            <h3 className="sub-head">Launch plan</h3>
            <ul className="module-list">
              {tasks.map((t) => (
                <li key={String(t.ROWID)}>
                  <span style={{ flex: "1 1 16rem" }}>{t.status === "DONE" ? <s className="muted">{t.item}</s> : t.item}
                    <span className="cell-sub">
                      <Pill value={t.owner_side === "BRAND" ? "Brand team" : portal ? "You" : "Franchisee"} tone={t.owner_side === "BRAND" ? "info" : "neutral"} />{" "}
                      <span style={{ color: t.overdue ? "var(--bad)" : undefined }}>{date(t.due_date)}</span> · {when(t, opening)}
                    </span>
                    {t.note && <span className="cell-sub">{t.note}</span>}
                  </span>
                  <span className="panel-actions">
                    {t.overdue ? <Pill value="Overdue" tone="bad" /> : t.status !== "OPEN" && <Pill value={TASK_TEXT[String(t.status)]} tone={TASK_TONE[String(t.status)]} />}
                    {t.status === "OPEN" && mayTick(t) && <button className="btn sm" disabled={act.busy === `t${t.ROWID}`} onClick={() => task(t, { action: "done" }, "Ticked off.")}>Done</button>}
                    {t.status === "OPEN" && staff && <button className="btn ghost sm" onClick={() => setDlg({ kind: "skip", row: t })}>Skip</button>}
                    {t.status !== "OPEN" && mayTick(t) && <button className="btn ghost sm" disabled={act.busy === `t${t.ROWID}`} onClick={() => task(t, { action: "reopen" }, "Reopened.")}>Undo</button>}
                  </span>
                </li>
              ))}
            </ul>
            {staff && <div style={{ padding: "0 1rem 1rem" }}><button className="btn ghost sm" onClick={() => setDlg({ kind: "add" })}>Add a task</button></div>}
          </>}

          {dlg?.kind === "date" && <DateDialog current={String(l.grand_opening_date ?? target ?? "")} moving={!!l.grand_opening_date} busy={act.busy === "date"} error={act.error} onClose={close}
            onSave={(d) => act.run("date", () => api<Row>("PATCH", `/projects/${projectId}/launch`, { body: { grand_opening_date: d } }), l.grand_opening_date ? "Grand opening moved; open tasks moved with it." : "Launch plan ready. The franchisee has been told.").then((r) => r && setDlg(null))} />}
          {dlg?.kind === "add" && <AddTaskDialog busy={act.busy === "add"} error={act.error} onClose={close}
            onSave={(b) => act.run("add", () => api<Row>("POST", `/projects/${projectId}/launch/tasks`, { body: b }), "Task added.").then((r) => r && setDlg(null))} />}
          {dlg?.kind === "skip" && dlg.row && <SkipDialog item={String(dlg.row.item)} busy={act.busy === `t${dlg.row.ROWID}`} error={act.error} onClose={close}
            onSave={(note) => task(dlg.row!, { action: "skip", note }, "Skipped.").then((r) => r && setDlg(null))} />}
          {dlg?.kind === "week" && dlg.row && <WeekDialog week={dlg.row} busy={act.busy === "week"} error={act.error} onClose={close}
            onSave={(b) => act.run("week", () => api<Row>("PATCH", `/projects/${projectId}/launch/weeks/${dlg.row!.week_no}`, { body: b }), `Week ${dlg.row!.week_no} saved.`).then((r) => r && setDlg(null))} />}
        </Panel>
      );
    }}</Loaded>
  );
}

function DateDialog({ current, moving, busy, error, onSave, onClose }: { current: string; moving: boolean; busy: boolean; error: ApiError | null; onSave: (d: string) => void; onClose: () => void }) {
  const [d, setD] = useState(current.slice(0, 10));
  return (
    <Dialog title={moving ? "Move the grand opening" : "Set the grand opening"} subtitle={moving ? "Launch tasks still to do move by the same number of days." : "The launch plan is built around this day and the franchisee is told."} onClose={onClose}>
      <Form onSubmit={() => onSave(d)} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !d}>{busy ? "Saving…" : "Save"}</button></>}>
        <Field label="Grand-opening day"><input type="date" value={d} onChange={(e) => setD(e.target.value)} required autoFocus /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

function AddTaskDialog({ busy, error, onSave, onClose }: { busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const [v, setV] = useState({ item: "", owner: "FRANCHISEE", due_date: today() });
  return (
    <Dialog title="Add a launch task" onClose={onClose}>
      <Form onSubmit={() => onSave({ ...v, item: v.item.trim() })} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || v.item.trim().length < 3}>{busy ? "Adding…" : "Add task"}</button></>}>
        <Field label="Task" span><input value={v.item} onChange={(e) => setV({ ...v, item: e.target.value })} maxLength={200} required autoFocus /></Field>
        <Field label="Who"><select value={v.owner} onChange={(e) => setV({ ...v, owner: e.target.value })}><option value="FRANCHISEE">Franchisee</option><option value="BRAND">Brand team</option></select></Field>
        <Field label="Due"><input type="date" value={v.due_date} onChange={(e) => setV({ ...v, due_date: e.target.value })} required /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

function SkipDialog({ item, busy, error, onSave, onClose }: { item: string; busy: boolean; error: ApiError | null; onSave: (note: string) => void; onClose: () => void }) {
  const [note, setNote] = useState("");
  return (
    <Dialog title="Skip this task?" subtitle={item} onClose={onClose}>
      <Form onSubmit={() => onSave(note.trim())} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || note.trim().length < 3}>{busy ? "Saving…" : "Skip it"}</button></>}>
        <Field label="Why" span><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} required autoFocus /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

function WeekDialog({ week, busy, error, onSave, onClose }: { week: Row; busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const [sales, setSales] = useState(week.net_sales != null ? String(week.net_sales) : "");
  const [tx, setTx] = useState(week.transactions != null ? String(week.transactions) : "");
  return (
    <Dialog title={`Week ${week.week_no} sales`} subtitle={<>{date(week.week_start)} to {date(week.week_end)}{week.target ? `. Plan ${inr(Number(week.target))}.` : ""}</>} onClose={onClose}>
      <Form onSubmit={() => onSave({ net_sales: Number(sales), ...(tx ? { transactions: Number(tx) } : {}) })} footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || sales === ""}>{busy ? "Saving…" : "Save"}</button></>}>
        <Field label="Net sales (₹, after discounts, before tax)"><input type="number" inputMode="decimal" min={0} step="1" value={sales} onChange={(e) => setSales(e.target.value)} required autoFocus /></Field>
        <Field label="Bills (optional)"><input type="number" inputMode="numeric" min={0} step="1" value={tx} onChange={(e) => setTx(e.target.value)} /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

/** Portal: the franchisee's launch plan and first-weeks sales. */
export function PortalLaunch() {
  const home = useLoad(() => api<Row>("GET", "/portal/home"), []);
  return (
    <>
      <PageHeader title="Opening day" subtitle="Your grand-opening plan, and how your first weeks are going against plan." />
      <Loaded load={home}>{(h) => h.project ? <LaunchPanel projectId={String(h.project.ROWID)} portal />
        : <div className="state">Your launch plan appears here once the brand team sets your grand-opening day.</div>}</Loaded>
    </>
  );
}

/** Staff: stores with a grand opening coming up or in their first weeks. */
export function Launches() {
  const load = useLoad(() => api<Row>("GET", "/launches"), []);
  return (
    <>
      <PageHeader title="New stores" crumbs={[["Operations"], ["New stores"]]} subtitle="Grand openings coming up, and how new stores are doing against plan in their first weeks." />
      <Loaded load={load}>{(d) => {
        const t = d.totals as Row;
        return (
          <>
            <dl className="summary">
              <div><dt>Openings coming up</dt><dd>{t.upcoming}{t.tasks_overdue > 0 && <span className="cell-sub" style={{ color: "var(--bad)" }}>{t.tasks_overdue} task{t.tasks_overdue === 1 ? "" : "s"} overdue</span>}</dd></div>
              <div><dt>In their first weeks</dt><dd>{t.watching}</dd></div>
              <div><dt>Behind plan</dt><dd style={{ color: t.behind ? "var(--bad)" : undefined }}>{t.behind}<span className="cell-sub">2 weeks under {String(d.behind_pct)}%</span></dd></div>
              <div><dt>Weeks not reported</dt><dd style={{ color: t.weeks_missing ? "var(--warn)" : undefined }}>{t.weeks_missing}</dd></div>
            </dl>
            <Panel flush>
              <DataTable rows={d.stores as Row[]} href={(r) => `/projects/${r.project_id}`} searchKeys={["project_code", "franchisee"]} empty="No grand openings planned and no stores in their first weeks." columns={[
                { key: "project_code", label: "Store", render: (r) => <><Link to={`/projects/${r.project_id}`}>{String(r.project_code)}</Link><span className="cell-sub">{String(r.franchisee ?? "")}</span></> },
                { key: "stage", label: "Stage", render: (r) => r.stage === "UPCOMING" ? <>Opens {date(r.grand_opening_date)}<span className="cell-sub">Grand opening</span></> : <>Week {r.week} of {String(d.watch_weeks)}<span className="cell-sub">Opened {date(r.opened_on)}</span></> },
                { key: "tasks_done", label: "Launch tasks", render: (r) => r.tasks ? <>{r.tasks_done} of {r.tasks}{r.tasks_overdue > 0 && <span className="cell-sub" style={{ color: "var(--bad)" }}>{r.tasks_overdue} overdue</span>}</> : <span className="muted">No plan</span> },
                { key: "last_week", label: "Last week", sort: (r) => Number(r.last_week?.pct ?? -1), render: (r) => r.last_week ? <><Rating pct={r.last_week.pct} rating={r.last_week.rating} /><span className="cell-sub">Week {r.last_week.week_no}</span></> : r.stage === "WATCH" ? <span className="muted">Not reported</span> : "—" },
                { key: "to_date_pct", label: "To date", sort: (r) => Number(r.to_date_pct ?? -1), render: (r) => r.stage === "WATCH" ? <>{r.has_plan ? <Rating pct={r.to_date_pct} rating={r.to_date_rating} /> : <span className="muted">No plan</span>}{r.behind && <span className="cell-sub" style={{ color: "var(--bad)" }}>Behind</span>}{r.weeks_missing > 0 && <span className="cell-sub" style={{ color: "var(--warn)" }}>{r.weeks_missing} week{r.weeks_missing === 1 ? "" : "s"} missing</span>}</> : "—" },
              ]} />
            </Panel>
          </>
        );
      }}</Loaded>
    </>
  );
}

/** An agreement's renewal on its page. */
export function RenewalPanel({ agreement, onChanged }: { agreement: Row; onChanged: () => void }) {
  const act = useAction(onChanged);
  const [editing, setEditing] = useState(false);
  if (agreement.status !== "SIGNED" || !agreement.expiry_date) return null;
  const left = Math.round((Date.parse(String(agreement.expiry_date).slice(0, 10)) - Date.parse(today())) / 86_400_000);
  return (
    <Panel title="Renewal" flush action={can("agreement.write") && <button className="btn sm secondary" onClick={() => setEditing(true)}>Update</button>}>
      {act.notice && <div className="notice ok" style={{ margin: ".75rem 1rem 0" }}><Icon name="check" />{act.notice}</div>}
      <dl className="summary flat">
        <div><dt>Term ends</dt><dd>{date(agreement.expiry_date)}<span className="cell-sub" style={{ color: left < 0 ? "var(--bad)" : left < 180 ? "var(--warn)" : undefined }}>{left < 0 ? `${-left} days ago` : `${left} days left`}</span></dd></div>
        <div><dt>Renewal</dt><dd>{agreement.renewal_status ? <Pill value={RENEWAL_TEXT[String(agreement.renewal_status)]} tone={RENEWAL_TONE[String(agreement.renewal_status)]} /> : <span className="muted">Not started</span>}{agreement.renewed_until && <span className="cell-sub">Until {date(agreement.renewed_until)}</span>}</dd></div>
        <div><dt>Note</dt><dd style={{ fontSize: ".85rem", fontWeight: 400, display: "block" }}>{agreement.renewal_note ?? "—"}<span className="cell-sub">{agreement.renewal_updated_at ? `Updated ${date(agreement.renewal_updated_at)}` : ""}</span></dd></div>
      </dl>
      {editing && <RenewalDialog agreement={agreement} busy={act.busy === "renew"} error={act.error} onClose={() => { setEditing(false); act.clear(); }}
        onSave={(b) => act.run("renew", () => api<Row>("PATCH", `/agreements/${agreement.ROWID}/renewal`, { body: b }), "Renewal updated.").then((r) => r && setEditing(false))} />}
    </Panel>
  );
}

function RenewalDialog({ agreement, busy, error, onSave, onClose }: { agreement: Row; busy: boolean; error: ApiError | null; onSave: (b: Row) => void; onClose: () => void }) {
  const [v, setV] = useState({ status: String(agreement.renewal_status ?? "IN_DISCUSSION"), note: String(agreement.renewal_note ?? ""), renewed_until: String(agreement.renewed_until ?? "").slice(0, 10) });
  return (
    <Dialog title={`Renewal of ${agreement.agreement_code}`} subtitle={`The current term ends ${date(agreement.expiry_date)}.`} onClose={onClose}>
      <Form onSubmit={() => onSave({ status: v.status, ...(v.note.trim() ? { note: v.note.trim() } : {}), ...(v.status === "RENEWED" ? { renewed_until: v.renewed_until } : {}) })}
        footer={<><button type="button" className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || (v.status === "RENEWED" && !v.renewed_until)}>{busy ? "Saving…" : "Save"}</button></>}>
        <Field label="Where it stands"><select value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })}>{Object.entries(RENEWAL_TEXT).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
        {v.status === "RENEWED" && <Field label="Renewed until"><input type="date" min={String(agreement.expiry_date).slice(0, 10)} value={v.renewed_until} onChange={(e) => setV({ ...v, renewed_until: e.target.value })} required /></Field>}
        <Field label="Note (optional)" span><textarea rows={3} value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} maxLength={2000} /></Field>
        <div className="span"><FormError error={error} /></div>
      </Form>
    </Dialog>
  );
}

/** Staff: agreements coming up for renewal, with each store's audit and royalty record. */
export function Renewals() {
  const load = useLoad(() => api<Row>("GET", "/renewals"), []);
  const [editing, setEditing] = useState<Row | null>(null);
  const act = useAction(load.reload);
  return (
    <>
      <PageHeader title="Renewals" crumbs={[["Contracts"], ["Renewals"]]} subtitle="Agreements ending in the next 18 months, and where each renewal stands." />
      {act.notice && <div className="notice ok"><Icon name="check" />{act.notice}</div>}
      <Loaded load={load}>{(d) => {
        const t = d.totals as Row;
        return (
          <>
            <dl className="summary">
              <div><dt>Ending in 18 months</dt><dd>{t.due}</dd></div>
              <div><dt>Inside the notice period</dt><dd style={{ color: t.in_notice ? "var(--warn)" : undefined }}>{t.in_notice}<span className="cell-sub">{String(d.notice_days)} days, not decided</span></dd></div>
              <div><dt>Ended, not decided</dt><dd style={{ color: t.expired ? "var(--bad)" : undefined }}>{t.expired}</dd></div>
              <div><dt>Renewed</dt><dd>{t.renewed}</dd></div>
            </dl>
            <Panel flush>
              <DataTable rows={d.agreements as Row[]} href={(r) => `/agreements/${r.ROWID}`} searchKeys={["agreement_code", "franchisee", "project_code"]} empty="No agreements end in the next 18 months." columns={[
                { key: "agreement_code", label: "Agreement", render: (r) => <><Link to={`/agreements/${r.ROWID}`}>{String(r.agreement_code)}</Link><span className="cell-sub">{String(r.franchisee ?? "")}</span></> },
                { key: "expiry_date", label: "Ends", render: (r) => <>{date(r.expiry_date)}<span className="cell-sub" style={{ color: r.days_left < 0 ? "var(--bad)" : r.in_notice ? "var(--warn)" : undefined }}>{r.days_left < 0 ? `${-r.days_left} days ago` : `${r.days_left} days`}</span></> },
                { key: "renewal_status", label: "Renewal", render: (r) => <>{r.renewal_status ? <Pill value={RENEWAL_TEXT[String(r.renewal_status)]} tone={RENEWAL_TONE[String(r.renewal_status)]} /> : <span className="muted">Not started</span>}{r.renewed_until && <span className="cell-sub">Until {date(r.renewed_until)}</span>}</> },
                { key: "project_code", label: "Store", render: (r) => r.project_id ? <><Link to={`/projects/${r.project_id}`}>{String(r.project_code)}</Link><span className="cell-sub">{r.last_audit_score != null ? `Last audit ${r.last_audit_score}%` : "Not audited"}{r.royalties_overdue ? ` · ${r.royalties_overdue} royalty overdue` : ""}</span></> : "—" },
                { key: "actions", label: "", align: "right", render: (r) => can("agreement.write") ? <button className="btn ghost sm" onClick={() => setEditing(r)}>Update</button> : null },
              ]} />
            </Panel>
            {editing && <RenewalDialog agreement={{ ...editing, status: "SIGNED" }} busy={act.busy === "renew"} error={act.error} onClose={() => { setEditing(null); act.clear(); }}
              onSave={(b) => act.run("renew", () => api<Row>("PATCH", `/agreements/${editing.ROWID}/renewal`, { body: b }), `${editing.agreement_code} updated.`).then((r) => r && setEditing(null))} />}
          </>
        );
      }}</Loaded>
    </>
  );
}

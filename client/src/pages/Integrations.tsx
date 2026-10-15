import { useState } from "react";
import { Link } from "react-router-dom";
import { api, Row } from "../api";
import { useAction, useLoad } from "../hooks";
import { ConfirmDialog, FormError } from "../components/forms";
import { DataTable, Facts, Icon, Loaded, PageHeader, Panel, Pill } from "../components/ui";

const SOURCE: Record<string, string> = { CRM: "Zoho CRM", SIGN: "Zoho Sign", BOOKS: "Zoho Books", PROJECTS: "Zoho Projects" };
/** Store timestamps come back as "2026-10-11 05:30:12" or ISO; shown as written, to the minute. */
const when = (v: unknown) => {
  const s = String(v ?? "");
  if (!s) return "—";
  const d = new Date(`${s.slice(0, 10)}T00:00:00Z`);
  const day = Number.isNaN(d.getTime()) ? s.slice(0, 10) : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return `${day}, ${s.slice(11, 16)}`;
};

/** Zoho connection, the daily job, and the calls and webhooks that gave up, with retry. */
export function Integrations() {
  const load = useLoad(() => api<Row>("GET", "/admin/integrations"), []);
  const act = useAction(load.reload);
  const [resolving, setResolving] = useState<Row | null>(null);
  const retry = (p: Row) => act.run(`r${p.id}`, () => api<Row>("POST", "/admin/integrations/retry", { body: { kind: p.kind, id: p.id } }), "Retried. It worked, so the item is cleared.");
  return (
    <>
      <PageHeader title="Integration health" crumbs={[["Admin"], ["Integration health"]]} subtitle="Zoho connections, the daily job, and anything that failed and needs a person."
        actions={<button className="btn secondary" disabled={load.loading} onClick={load.reload}><Icon name="sync" size={16} />Refresh</button>} />
      {act.notice && <div className="notice ok"><Icon name="check" />{act.notice}</div>}
      {act.error && !resolving && <FormError error={act.error} />}
      <Loaded load={load}>{(d) => {
        const problems = d.problems as Row[];
        const jobs = d.jobs as Row[];
        const z = d.zoho as Row | null;
        const failingJobs = jobs.filter((j) => j.ok === false).length;
        return (
          <>
            <dl className="summary">
              <div><dt>Needs attention</dt><dd style={{ color: problems.length ? "var(--bad)" : undefined }}>{problems.length}</dd></div>
              <div><dt>Daily job</dt><dd>{failingJobs ? <Pill value={`${failingJobs} step${failingJobs === 1 ? "" : "s"} failed`} tone="bad" /> : jobs.some((j) => j.ok) ? <Pill value="Healthy" tone="good" /> : <Pill value="No runs yet" tone="neutral" />}</dd></div>
              <div><dt>Zoho</dt><dd>{z ? <Pill value={z.status} tone={z.status === "ACTIVE" ? "good" : "warn"} /> : <Pill value="Not connected" tone="bad" />}</dd></div>
            </dl>
            <Panel title={<>Needs attention{problems.length > 0 && <Pill value={problems.length} tone="bad" />}</>} flush>
              {problems.length === 0 ? <div className="state"><Icon name="check" />Nothing has failed. Zoho calls that give up and webhooks that fail show up here.</div> : (
                <DataTable rows={problems} columns={[
                  { key: "at", label: "When", render: (p) => <span className="nowrap">{when(p.at)}</span> },
                  { key: "what", label: "What", render: (p) => <>{p.what}<span className="cell-sub">{SOURCE[String(p.source)] ?? p.source}{p.attempts ? `, gave up after ${p.attempts} tries` : ""}</span></> },
                  { key: "subject", label: "Record", sort: (p) => String(p.subject?.label ?? ""), render: (p) => p.subject?.href ? <Link to={p.subject.href}>{p.subject.label}</Link> : p.subject?.label ?? <span className="muted">—</span> },
                  { key: "error", label: "Error", render: (p) => <span className="error-text">{p.error ?? "—"}</span> },
                  { key: "_act", label: "", render: (p) => (
                    <span className="panel-actions">
                      {p.retryable && <button className="btn sm" disabled={!!act.busy} onClick={() => retry(p)}><Icon name="sync" size={14} />{act.busy === `r${p.id}` ? "Retrying…" : "Retry"}</button>}
                      <button className="btn ghost sm" disabled={!!act.busy} onClick={() => setResolving(p)}>Resolve</button>
                    </span>
                  ) },
                ]} />
              )}
            </Panel>
            <Panel title="Daily job" flush action={<span className="muted">Runs once a day, step by step</span>}>
              <DataTable rows={jobs} columns={[
                { key: "name", label: "Step", sort: (j) => jobs.indexOf(j) },
                { key: "ok", label: "Last run", sort: (j) => String(j.last_run ?? ""), render: (j) => j.ok === null ? <span className="muted">Not run since this screen was added</span> : <><Pill value={j.ok ? "Succeeded" : "Failed"} tone={j.ok ? "good" : "bad"} /><span className="cell-sub">{when(j.last_run)}</span></> },
                { key: "last_success", label: "Last success", render: (j) => when(j.last_success) },
                { key: "error", label: "Error", render: (j) => j.error ? <span className="error-text">{j.error}</span> : <span className="muted">—</span> },
              ]} />
            </Panel>
            <Panel title="Last 7 days" flush>
              {(d.sources as Row[]).length === 0 ? <div className="state">No Zoho calls or webhooks logged in the last 7 days.</div> : (
                <DataTable rows={d.sources as Row[]} columns={[
                  { key: "source", label: "System", render: (s) => SOURCE[String(s.source)] ?? s.source },
                  { key: "ok", label: "Worked", align: "right", sort: (s) => Number(s.ok) },
                  { key: "retried", label: "Retried or in flight", align: "right", sort: (s) => Number(s.retried) },
                  { key: "failed", label: "Gave up", align: "right", sort: (s) => Number(s.failed), render: (s) => <span style={{ color: Number(s.failed) ? "var(--bad)" : undefined }}>{s.failed}</span> },
                ]} />
              )}
              <p className="panel-foot muted">Counts CRM status updates and the CRM and Sign webhooks. Books and Projects calls report their errors on the screen that made them.</p>
            </Panel>
            <Panel title="Zoho connection">
              {z ? <Facts items={[
                ["Status", <Pill key="s" value={z.status} tone={z.status === "ACTIVE" ? "good" : "warn"} />],
                ["Data centre", z.dc],
                ["Books organisation", z.books_org],
                ["Projects portal", z.projects_portal],
                ["Refresh token", z.token_stored ? "Stored in the Data Store" : "From the function settings"],
                ["Webhook secret", z.webhook_secret_stored ? "Stored in the Data Store" : "From the function settings"],
              ]} /> : <p className="muted" style={{ margin: 0 }}>No Zoho connection is recorded for this tenant.</p>}
            </Panel>
            {resolving && <ConfirmDialog title="Resolve this item?" confirm="Resolve" comment="required" busy={!!act.busy} error={act.error} onClose={() => { setResolving(null); act.clear(); }}
              body={<p className="muted" style={{ margin: 0 }}>Use this when it was fixed another way or no longer matters. It leaves the list, and your reason goes in the activity log.</p>}
              onConfirm={(reason) => act.run("resolve", () => api<Row>("POST", "/admin/integrations/resolve", { body: { kind: resolving.kind, id: resolving.id, reason } }), "Resolved.").then((r) => r && setResolving(null))} />}
          </>
        );
      }}</Loaded>
    </>
  );
}

import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { actsAs, api, hasRole, Row } from "../api";
import { useAction, useFranchiseeNames, useLoad } from "../hooks";
import { ConfirmDialog } from "../components/forms";
import { DataTable, date, Icon, label, Loaded, PageHeader, Panel, Pill } from "../components/ui";

type Decision = "approve" | "return" | "reject";
const DECISION: Record<Decision, { title: string; confirm: string; comment: "optional" | "required"; danger?: boolean; done: string }> = {
  approve: { title: "Approve this step", confirm: "Approve", comment: "optional", done: "Approved." },
  return: { title: "Send back for rework", confirm: "Send back", comment: "required", done: "Sent back to feasibility review." },
  reject: { title: "Reject the application", confirm: "Reject", comment: "required", danger: true, done: "Rejected." },
};
const OUTCOME: Record<string, string> = {
  ADVANCED: "Approved. The next approver has it now.", APPROVED: "Final approval given. The application is approved.",
  RETURNED: "Sent back to feasibility review.", REJECTED: "The application was rejected.",
};

/** Approve, send back or reject the current step, with the comment each needs. */
export function DecisionButtons({ approval, onDone, compact }: { approval: Row; onDone: (outcome: string) => void; compact?: boolean }) {
  const [open, setOpen] = useState<Decision | null>(null);
  const act = useAction();
  const current = approval.current ?? (approval.steps as Row[] | undefined)?.find((s) => Number(s.sequence) === Number(approval.current_step));
  if (!current || approval.status !== "PENDING") return null;
  const override = !hasRole(current.approver_role) && hasRole("SUPER_ADMIN");
  const decide = async (d: Decision, comments: string) => {
    const r = await act.run(d, () => api<Row>("POST", `/approvals/${approval.ROWID}/${d}`, { body: { step: Number(current.sequence), ...(comments ? { comments } : {}) } }));
    if (r) { setOpen(null); onDone(OUTCOME[r.outcome] ?? DECISION[d].done); }
  };
  const sm = compact ? " sm" : "";
  return (
    <>
      <span className="panel-actions">
        <button className={`btn${sm}`} onClick={() => setOpen("approve")}><Icon name="check" size={15} />Approve</button>
        <button className={`btn secondary${sm}`} onClick={() => setOpen("return")}>Send back</button>
        <button className={`btn danger-ghost${sm}`} onClick={() => setOpen("reject")}>Reject</button>
      </span>
      {open && (
        <ConfirmDialog title={DECISION[open].title} confirm={DECISION[open].confirm} danger={DECISION[open].danger} comment={DECISION[open].comment}
          busy={!!act.busy} error={act.error} onClose={() => { setOpen(null); act.clear(); }} onConfirm={(c) => decide(open, c)}
          body={<p className="muted" style={{ margin: 0 }}>
            Step {current.sequence} of {approval.steps?.length ?? "?"}: {label(current.approver_role)}.
            {override && " You are deciding as super admin, so this is recorded as an override for that role."}
          </p>} />
      )}
    </>
  );
}

/** The approval chain: who decided each step, what they said, and who has it now. */
export function ApprovalSteps({ approval }: { approval: Row }) {
  const steps = (approval.steps ?? []) as Row[];
  const actions = (approval.actions ?? []) as Row[];
  const at = Number(approval.current_step);
  const finished = approval.status !== "PENDING";
  return (
    <ol className="steps">
      {steps.map((s) => {
        const acts = actions.filter((a) => String(a.step_id) === String(s.step_id));
        const last = acts[acts.length - 1];
        const seq = Number(s.sequence);
        const state = last?.action === "REJECT" ? "bad" : last?.action === "APPROVE" ? "done" : !finished && seq === at ? "current" : "";
        return (
          <li key={s.step_id ?? seq} className={state}>
            <span className="dot">{state === "done" ? "✓" : state === "bad" ? "×" : seq}</span>
            <div>
              <div className="step-title">{label(s.approver_role)}</div>
              {acts.map((a) => {
                // The API prefixes override comments with "[Super admin override for ROLE]".
                const raw = String(a.comments ?? "");
                const override = /^\[Super admin override[^\]]*\]\s*/.exec(raw);
                const text = override ? raw.slice(override[0].length) : raw;
                return <div key={a.ROWID} className="step-note">{label(a.action === "APPROVE" ? "approved" : a.action === "RETURN" ? "sent back" : "rejected")} {date(a.acted_at)}{override ? " by super admin override" : ""}{text ? `: “${text}”` : ""}</div>;
              })}
              {state === "current" && <div className="step-note">Waiting for a decision{approval.step_due_at ? `, due ${date(approval.step_due_at)}` : ""}.</div>}
            </div>
            <span className="muted" style={{ fontSize: ".8rem" }}>{s.sla_hours ? `${s.sla_hours}h SLA` : ""}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function Approvals() {
  const [params, setParams] = useSearchParams();
  const scope = params.get("scope") === "all" ? "all" : "mine";
  const load = useLoad(() => api<Row[]>("GET", "/approvals", { query: { scope, limit: "200" } }), [scope]);
  const names = useFranchiseeNames();
  const [notice, setNotice] = useState<string | null>(null);
  const seeAll = actsAs("FRANCHISE_DIRECTOR");
  return (
    <>
      <PageHeader title="Approvals" crumbs={[["Expansion"], ["Approvals"]]} subtitle="Applications waiting for a decision at your step of the approval chain." />
      {notice && <div className="notice ok"><Icon name="check" />{notice}</div>}
      <Loaded load={load}>{(rows) => (
        <DataTable rows={rows} href={(i) => (i.entity_type === "application" ? `/applications/${i.entity_id}` : "/approvals")}
          empty={scope === "mine" ? "Nothing is waiting for you." : "No approvals are pending."}
          toolbar={seeAll && <div className="chips">{(["mine", "all"] as const).map((s) => <button key={s} className={`chip ${scope === s ? "on" : ""}`} onClick={() => setParams(s === "all" ? { scope: s } : {})}>{s === "mine" ? "Waiting for me" : "All pending"}</button>)}</div>}
          columns={[
            { key: "entity", label: "Application", sort: (i) => i.entity?.code ?? "", render: (i) => i.entity ? <><Link className="code" to={`/applications/${i.entity.ROWID}`}>{i.entity.code}</Link><span className="cell-sub">{[names[i.entity.franchisee_id], i.entity.city].filter(Boolean).join(" · ")}</span></> : <span className="muted">{label(i.entity_type)}</span> },
            { key: "current_step", label: "Step", sort: (i) => Number(i.current_step), render: (i) => <>{label(i.current?.approver_role)}<span className="cell-sub">Step {i.current_step} of {JSON.parse(String(i.steps_json ?? "[]")).length}</span></> },
            { key: "step_due_at", label: "Due", render: (i) => <span className="chips">{date(i.step_due_at)}{i.overdue && <Pill value="Overdue" tone="bad" />}</span> },
            { key: "started_at", label: "Started", render: (i) => date(i.started_at ?? i.CREATEDTIME) },
            { key: "_act", label: "", render: (i) => <DecisionButtons compact approval={{ ...i, steps: JSON.parse(String(i.steps_json ?? "[]")) }} onDone={(m) => { setNotice(`${i.entity?.code ?? "Approval"}: ${m}`); load.reload(); }} /> },
          ]} />
      )}</Loaded>
    </>
  );
}

/** Approval card on the application page: the chain, plus the decision buttons when it is this user's turn. */
export function ApprovalPanel({ approval, onDone }: { approval: Row; onDone: (msg: string) => void }) {
  const current = (approval.steps as Row[]).find((s) => Number(s.sequence) === Number(approval.current_step));
  const mine = approval.status === "PENDING" && current && actsAs(current.approver_role);
  return (
    <Panel title="Approval" action={<Pill value={approval.status} />}>
      <div className="stack">
        <ApprovalSteps approval={approval} />
        {mine && <DecisionButtons approval={{ ...approval, current }} onDone={onDone} />}
      </div>
    </Panel>
  );
}

import { useState } from "react";
import { ApiError, Row } from "../api";
import { ConfirmDialog } from "./forms";
import { date, Icon, Panel, Pill } from "./ui";

/** Forecast opening from task dependencies, with the chain that sets it and the float left. */
export function ForecastPanel({ f, target, items, canRetarget, busy, error, onRetarget, onClear }: {
  f: Row; target: unknown; items: Row[]; canRetarget: boolean; busy: boolean; error: ApiError | null;
  onRetarget: (date: string, reason: string) => Promise<unknown>; onClear: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const names = new Map(items.map((i) => [String(i.task_code ?? i.ROWID), String(i.item)]));
  const slip = Number(f.slip_days ?? 0);
  const path = (f.critical_path ?? []) as string[];
  if (!target) return null;
  return (
    <Panel title={<>Opening forecast{slip > 0 ? <Pill value={`${slip} days late`} tone="bad" /> : <Pill value="On track" tone="good" />}</>}
      action={canRetarget && slip > 0 ? <button className="btn ghost sm" onClick={() => setConfirm(true)}>Move target to {date(f.forecast_opening)}</button> : undefined}>
      <dl className="facts">
        <div><dt>Target opening</dt><dd>{date(target)}</dd></div>
        <div><dt>Forecast opening</dt><dd style={{ color: slip > 0 ? "var(--bad)" : undefined }}>{date(f.forecast_opening)}</dd></div>
        <div><dt>{slip > 0 ? "Behind by" : "Float"}</dt><dd>{slip > 0 ? `${slip} days` : f.float_days == null ? "—" : `${f.float_days} days to spare`}</dd></div>
        <div><dt>Last task finishes</dt><dd>{date(f.forecast_finish)}{f.planned_finish && f.forecast_finish !== f.planned_finish && <span className="cell-sub">Planned {date(f.planned_finish)}</span>}</dd></div>
      </dl>
      {path.length > 0 && (
        <div className="issue-list" style={{ marginTop: ".9rem" }}>
          <span className="muted">Critical path</span>
          {path.map((c, i) => <span key={c} className="chips">{i > 0 && <span className="muted">→</span>}<Pill value={names.get(c) ?? c} tone={slip > 0 ? "bad" : "info"} /></span>)}
        </div>
      )}
      <p className="muted" style={{ margin: ".75rem 0 0", fontSize: ".82rem" }}>
        From each task's due date, length and the tasks it waits for. Overdue tasks are assumed to finish today, so the real date can be later.
      </p>
      {(f.cycle ?? []).length > 0 && <div className="notice warn" style={{ marginTop: ".75rem" }}><Icon name="alert" />Some tasks wait for each other in a loop ({(f.cycle as string[]).map((c) => names.get(c) ?? c).join(", ")}); those links are ignored.</div>}
      {confirm && <ConfirmDialog title={`Move the target opening to ${date(f.forecast_opening)}?`} confirm="Move target" comment="required" busy={busy} error={error}
        body={<p className="muted" style={{ margin: 0 }}>Everyone on the project sees the new date, and lease and licence checks use it. Zoho Projects keeps its own end date.</p>}
        onClose={() => { setConfirm(false); onClear(); }} onConfirm={(reason) => onRetarget(String(f.forecast_opening), reason).then((r) => r && setConfirm(false))} />}
    </Panel>
  );
}

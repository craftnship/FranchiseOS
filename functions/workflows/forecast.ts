import { TenantContext } from "../common/context";
import { logActivity } from "../common/audit";
import { Row, Store, TenantRepo } from "../common/store";
import { toBool, toNum } from "../common/values";
import { Forecast, forecastOpening, PlanTask, plannedDuration } from "../scoring/forecast";

// The opening forecast for a project, from its checklist's dependencies and durations.

const deps = (r: Row): string[] => { try { return JSON.parse(String(r.depends_on_json || "[]")) as string[]; } catch { return []; } };
const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);

/** Duration in days: stored, or worked out from the due dates when the row predates durations. */
function durationOf(r: Row, byCode: Map<string, Row>, start: string): number {
  if (r.duration_days != null && String(r.duration_days) !== "" && String(r.duration_days) !== "null") return Math.max(0, toNum(r.duration_days));
  return plannedDuration(day(r.due_date), deps(r).map((c) => day(byCode.get(c)?.due_date)), start);
}

export function planTasks(project: Row, rows: Row[]): PlanTask[] {
  const byCode = new Map(rows.map((r) => [String(r.task_code ?? r.ROWID), r]));
  const start = day(project.CREATEDTIME) ?? new Date().toISOString().slice(0, 10);
  return rows.map((r) => ({
    id: String(r.ROWID), code: String(r.task_code ?? r.ROWID), name: String(r.item), mandatory: toBool(r.mandatory),
    done: r.status === "COMPLETED", due: day(r.due_date), duration: durationOf(r, byCode, start), depends_on: deps(r),
    completed_on: day(r.completed_on) ?? (r.status === "COMPLETED" ? day(r.MODIFIEDTIME) : null),
  }));
}

export function projectForecast(project: Row, rows: Row[], today: string): Forecast {
  return forecastOpening(planTasks(project, rows), today, day(project.target_opening_date));
}

/** Alert again only when the forecast moves this much later than the date last alerted. */
const REALERT_DAYS = 7;

/**
 * Stores the forecast on the project and fills in missing durations. When the forecast opening
 * first slips past the target, or moves a week or more later than the last alert, logs
 * project:forecast so the project team and the franchisee hear about it.
 */
export async function refreshForecast(store: Store, ctx: TenantContext, project: Row, rows: Row[], today: string): Promise<Forecast> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const plan = planTasks(project, rows);
  for (const r of rows) {
    if (r.duration_days == null || String(r.duration_days) === "" || String(r.duration_days) === "null") {
      await repo.update("opening_checklists", String(r.ROWID), { duration_days: plan.find((t) => t.id === String(r.ROWID))!.duration });
    }
  }
  const f = forecastOpening(plan, today, day(project.target_opening_date));
  const patch: Row = {};
  if (day(project.forecast_opening_date) !== f.forecast_opening) patch.forecast_opening_date = f.forecast_opening;
  if (toNum(project.forecast_slip_days) !== f.slip_days || project.forecast_slip_days == null) patch.forecast_slip_days = f.slip_days;
  const alerted = day(project.forecast_alerted_on);
  const due = f.slip_days > 0 && f.forecast_opening && (!alerted || Date.parse(f.forecast_opening) - Date.parse(alerted) >= REALERT_DAYS * 86_400_000);
  if (due) patch.forecast_alerted_on = f.forecast_opening;
  if (f.slip_days === 0 && alerted) patch.forecast_alerted_on = null; // back on plan: the next slip alerts again
  if (Object.keys(patch).length) await repo.update("franchise_projects", String(project.ROWID), patch);
  if (due) {
    const names = new Map(plan.map((t) => [t.code, t.name]));
    await logActivity(store, ctx, {
      entityType: "project", entityId: String(project.ROWID), action: "project:forecast",
      metadata: { target: day(project.target_opening_date), forecast: f.forecast_opening, slip_days: f.slip_days, critical_path: f.critical_path.map((c) => names.get(c) ?? c) },
    });
  }
  return f;
}

// Opening forecast from the task network (CPM-style). Each task has a duration and the tasks it waits
// for; an open task finishes no earlier than its due date, today, or its predecessors' finish plus its
// own duration. The store can open the day after the last mandatory task finishes, so the gap between
// the plan and the target is float that absorbs delays; the opening slips once the work runs past it.

export interface PlanTask {
  id: string;
  code: string;
  name: string;
  mandatory: boolean;
  done: boolean;
  due: string | null;
  duration: number;
  depends_on: string[];
  completed_on: string | null;
}

export interface TaskForecast { id: string; code: string; finish: string; slip: number; slack: number; critical: boolean; waiting_on: string[] }

export interface Forecast {
  tasks: TaskForecast[];
  planned_finish: string | null;
  forecast_finish: string | null;
  /** Days the forecast opening is past the target. */
  slip_days: number;
  /** Days to spare before the work would push the opening past the target (0 once it slips). */
  float_days: number | null;
  forecast_opening: string | null;
  /** Open tasks that set the forecast, first to last. */
  critical_path: string[];
  /** Codes in a dependency loop; their dependencies are ignored. */
  cycle: string[];
}

const DAY = 86_400_000;
const ms = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const add = (d: string, n: number) => iso(ms(d) + n * DAY);
const diff = (a: string, b: string) => Math.round((ms(b) - ms(a)) / DAY);
const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

/** Tasks in dependency order; tasks in a loop come last with their dependencies dropped. */
function order(tasks: PlanTask[]): { sorted: PlanTask[]; cycle: string[] } {
  const byCode = new Map(tasks.map((t) => [t.code, t]));
  const state = new Map<string, 0 | 1 | 2>();
  const sorted: PlanTask[] = [];
  const cycle = new Set<string>();
  const visit = (t: PlanTask, stack: string[]) => {
    const s = state.get(t.code);
    if (s === 2) return;
    if (s === 1) { for (const c of stack.slice(stack.indexOf(t.code))) cycle.add(c); return; }
    state.set(t.code, 1);
    for (const d of t.depends_on) { const p = byCode.get(d); if (p) visit(p, [...stack, t.code]); }
    state.set(t.code, 2);
    sorted.push(t);
  };
  for (const t of tasks) visit(t, []);
  return { sorted, cycle: [...cycle] };
}

export function forecastOpening(tasks: PlanTask[], today: string, target: string | null): Forecast {
  const { sorted, cycle } = order(tasks);
  const inCycle = new Set(cycle);
  const deps = (t: PlanTask) => (inCycle.has(t.code) ? [] : t.depends_on.filter((d) => d !== t.code && sorted.some((x) => x.code === d)));
  const finish = new Map<string, string>();
  const byCode = new Map(tasks.map((t) => [t.code, t]));

  for (const t of sorted) {
    if (t.done) { finish.set(t.code, [t.completed_on ?? t.due ?? today, today].sort()[0]); continue; }
    let f: string | null = today;
    for (const d of deps(t)) f = later(f, add(finish.get(d)!, Math.max(0, t.duration)));
    f = later(f, t.due);
    finish.set(t.code, f!);
  }

  const mandatory = tasks.filter((t) => t.mandatory);
  const planned = mandatory.reduce<string | null>((a, t) => later(a, t.due), null);
  const forecastFinish = mandatory.reduce<string | null>((a, t) => later(a, finish.get(t.code)!), null);
  const earliestOpening = forecastFinish ? add(forecastFinish, 1) : null;
  const forecastOpen = target ? later(target, earliestOpening) : null;
  const slip = target && forecastOpen ? diff(target, forecastOpen) : 0;
  // The last day the work can finish without moving the opening.
  const deadline = target ? add(target, -1) : planned;

  // Backward pass: the latest each task can finish without moving the opening.
  const successors = new Map<string, PlanTask[]>();
  for (const t of sorted) for (const d of deps(t)) successors.set(d, [...(successors.get(d) ?? []), t]);
  const latest = new Map<string, string>();
  const horizon = later(deadline, forecastFinish) ?? today;
  for (const t of [...sorted].reverse()) {
    let lf = t.mandatory ? deadline ?? horizon : horizon;
    for (const s of successors.get(t.code) ?? []) {
      const bound = add(latest.get(s.code)!, -Math.max(0, s.duration));
      if (bound < lf) lf = bound;
    }
    latest.set(t.code, lf);
  }

  const out: TaskForecast[] = tasks.map((t) => {
    const f = finish.get(t.code)!;
    const slack = diff(f, latest.get(t.code)!);
    return {
      id: t.id, code: t.code, finish: f, slip: t.due && !t.done ? Math.max(0, diff(t.due, f)) : 0, slack,
      critical: !t.done && t.mandatory && slack <= 0,
      waiting_on: deps(t).filter((d) => !byCode.get(d)!.done),
    };
  });

  // Walk back from the latest-finishing open mandatory task along the predecessor that drives it.
  const path: string[] = [];
  const open = mandatory.filter((t) => !t.done).sort((a, b) => (finish.get(b.code)! > finish.get(a.code)! ? 1 : -1));
  let cur: PlanTask | undefined = open[0];
  while (cur && !path.includes(cur.code)) {
    path.unshift(cur.code);
    const preds: PlanTask[] = deps(cur).map((d) => byCode.get(d)!).filter((p) => !p.done);
    cur = preds.sort((a, b) => (finish.get(b.code)! > finish.get(a.code)! ? 1 : -1))[0];
  }

  return {
    tasks: out, planned_finish: planned, forecast_finish: forecastFinish, slip_days: slip,
    float_days: deadline && forecastFinish ? Math.max(0, diff(forecastFinish, deadline)) : null,
    forecast_opening: forecastOpen, critical_path: path, cycle,
  };
}

/** Duration of a task from its plan: days after its latest predecessor is due, or after `start` when it waits for none. */
export function plannedDuration(due: string | null, predDues: (string | null)[], start: string): number {
  if (!due) return 1;
  const from = predDues.filter(Boolean).sort().pop() ?? start;
  return Math.max(1, diff(from as string, due));
}

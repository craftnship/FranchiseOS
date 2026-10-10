import { ProjectRef, TaskState, ZohoProjectsClient } from "./clients";
import { ProviderError } from "./retry";
import { ZohoHttp } from "./zohoHttp";

// Zoho Projects V3 adapter (spec §15). V3 returns the created object; older shapes wrap it in an
// array, so ids are read from either. A project needs an owner (the portal user's zpuid).

type Obj = Record<string, unknown>;

function idOf(res: unknown, key: string): string {
  const r = (res ?? {}) as Obj;
  const wrapped = r[key] as Obj[] | Obj | undefined;
  const item = (Array.isArray(wrapped) ? wrapped[0] : wrapped) ?? r;
  const id = (item as Obj).id ?? (item as Obj).id_string;
  if (!id) throw new ProviderError(`Projects ${key} create returned no id`, 502);
  return String(id);
}

/** Status ids are per portal layout (tenant settings projects_open_status_id, projects_closed_status_id). */
export interface TaskStatusIds { open?: string; closed?: string }

const DAY_MS = 86_400_000;

/** Shifts a Zoho date or datetime by whole days, in the same shape it came in. */
export function shiftDate(value: string, days: number): string {
  if (!value.includes("T")) return new Date(Date.parse(`${value}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
  return new Date(Date.parse(value) + days * DAY_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export class HttpProjectsClient implements ZohoProjectsClient {
  constructor(
    private readonly http: ZohoHttp, private readonly baseUrl: string, private readonly portalId: string,
    private readonly ownerZpuid?: string, private readonly statuses: TaskStatusIds = {},
  ) {}

  private url(path: string): string { return `${this.baseUrl}/portal/${encodeURIComponent(this.portalId)}${path}`; }

  async createProject(data: { name: string; description?: string; start_date?: string; end_date?: string }): Promise<ProjectRef> {
    if (!this.ownerZpuid) throw new ProviderError("Projects owner is not configured (tenant setting projects_owner_zpuid)", 400, false);
    const res = await this.http.request("POST", this.url("/projects"), { ...data, owner: { zpuid: this.ownerZpuid } });
    return { id: idOf(res, "projects") };
  }

  async getProject(id: string): Promise<ProjectRef> {
    return { id: idOf(await this.http.request("GET", this.url(`/projects/${encodeURIComponent(id)}`)), "projects") };
  }

  async createTaskList(projectId: string, data: { name: string }) {
    return { id: idOf(await this.http.request("POST", this.url(`/projects/${encodeURIComponent(projectId)}/tasklists`), data), "tasklists") };
  }

  async createTask(projectId: string, data: { name: string; tasklist_id: string; start_date?: string; end_date?: string }) {
    const { tasklist_id, ...rest } = data;
    return { id: idOf(await this.http.request("POST", this.url(`/projects/${encodeURIComponent(projectId)}/tasks`), { ...rest, tasklist: { id: tasklist_id } }), "tasks") };
  }

  async updateTask(projectId: string, taskId: string, data: object): Promise<void> {
    await this.http.request("PATCH", this.url(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`), data);
  }

  async setTaskClosed(projectId: string, taskId: string, closed: boolean): Promise<void> {
    const id = closed ? this.statuses.closed : this.statuses.open;
    const setting = closed ? "projects_closed_status_id" : "projects_open_status_id";
    if (!id) throw new ProviderError(`Projects task status is not configured (tenant setting ${setting})`, 400, false);
    // A closed-type status also sets is_completed and 100% in Zoho.
    await this.updateTask(projectId, taskId, { status: { id } });
  }

  // Zoho rejects an end before the start, so both dates move by the same number of days.
  async rescheduleTask(projectId: string, taskId: string, dueDate: string): Promise<void> {
    const task = ((await this.http.request<Obj>("GET", this.url(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`))) ?? {}) as Obj;
    const item = ((Array.isArray(task.tasks) ? task.tasks[0] : task) ?? {}) as Obj;
    const end = item.end_date ? String(item.end_date) : null;
    if (!end) return this.updateTask(projectId, taskId, { end_date: dueDate });
    const days = Math.round((Date.parse(dueDate) - Date.parse(end.slice(0, 10))) / DAY_MS);
    if (!days) return;
    const start = item.start_date ? String(item.start_date) : null;
    await this.updateTask(projectId, taskId, { ...(start ? { start_date: shiftDate(start, days) } : {}), end_date: shiftDate(end, days) });
  }

  // The V3 dependency endpoint is not verified yet (plan §8), so dependencies stay local until the
  // tenant enables projects_dependencies after a live check.
  async addDependency(): Promise<void> {
    throw new ProviderError("Task dependencies are not supported by this Projects adapter yet", 501, false);
  }

  async listTasks(projectId: string): Promise<TaskState[]> {
    const out: TaskState[] = [];
    for (let page = 1; page <= 20; page++) {
      const res = (await this.http.request<Obj>("GET", this.url(`/projects/${encodeURIComponent(projectId)}/tasks?page=${page}&per_page=200`))) ?? {};
      for (const t of (res.tasks as Obj[] | undefined) ?? []) {
        const status = (t.status ?? {}) as Obj;
        out.push({
          id: String(t.id),
          status: String(status.name ?? ""),
          closed: status.is_closed_type === true || t.is_completed === true,
          ...(typeof t.completion_percentage === "number" ? { percent: t.completion_percentage } : {}),
        });
      }
      if (!((res.page_info as Obj | undefined)?.has_next_page)) break;
    }
    return out;
  }
}

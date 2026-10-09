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

export class HttpProjectsClient implements ZohoProjectsClient {
  constructor(private readonly http: ZohoHttp, private readonly baseUrl: string, private readonly portalId: string, private readonly ownerZpuid?: string) {}

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

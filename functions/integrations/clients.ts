// Provider adapter contracts (spec §13). addDependency is added for §15 / FOS-056;
// confirm Zoho Projects V3 supports it by API before Step 5 (plan §8).
export interface ProjectRef { id: string }
export interface TaskListRef { id: string }
export interface TaskRef { id: string }

export interface ZohoProjectsClient {
  createProject(data: { name: string; description?: string; start_date?: string; end_date?: string }): Promise<ProjectRef>;
  getProject(id: string): Promise<ProjectRef>;
  createTaskList(projectId: string, data: { name: string }): Promise<TaskListRef>;
  createTask(projectId: string, data: { name: string; tasklist_id: string; start_date?: string; end_date?: string }): Promise<TaskRef>;
  updateTask(projectId: string, taskId: string, data: object): Promise<void>;
  addDependency(projectId: string, predecessorTaskId: string, successorTaskId: string): Promise<void>;
}

export interface ZohoCrmClient {
  getLead(id: string): Promise<Record<string, unknown>>;
  getAccount(id: string): Promise<Record<string, unknown>>;
  getContact(id: string): Promise<Record<string, unknown>>;
  updateLead(id: string, data: object): Promise<void>;
  createAccount(data: object): Promise<{ id: string }>;
}

export interface ZohoSignClient {
  createRequest(data: object): Promise<{ id: string }>;
  sendRequest(id: string): Promise<void>;
  getRequest(id: string): Promise<{ id: string; status: string }>;
}

export interface ZohoBooksClient {
  createCustomer(data: object): Promise<{ id: string }>;
  createInvoice(data: object): Promise<{ id: string }>;
}

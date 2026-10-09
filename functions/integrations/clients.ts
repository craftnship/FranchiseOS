// Provider adapter contracts (spec §13). Each adapter returns only the ids and fields FOS stores.
export interface ProjectRef { id: string }
export interface TaskListRef { id: string }
export interface TaskRef { id: string }
/** A Zoho Projects task as the sync job needs it. */
export interface TaskState { id: string; status: string; closed: boolean; percent?: number }

export interface ZohoProjectsClient {
  createProject(data: { name: string; description?: string; start_date?: string; end_date?: string }): Promise<ProjectRef>;
  getProject(id: string): Promise<ProjectRef>;
  createTaskList(projectId: string, data: { name: string }): Promise<TaskListRef>;
  createTask(projectId: string, data: { name: string; tasklist_id: string; start_date?: string; end_date?: string }): Promise<TaskRef>;
  updateTask(projectId: string, taskId: string, data: object): Promise<void>;
  addDependency(projectId: string, predecessorTaskId: string, successorTaskId: string): Promise<void>;
  listTasks(projectId: string): Promise<TaskState[]>;
}

export interface ZohoCrmClient {
  getLead(id: string): Promise<Record<string, unknown>>;
  getAccount(id: string): Promise<Record<string, unknown>>;
  getContact(id: string): Promise<Record<string, unknown>>;
  updateLead(id: string, data: object): Promise<void>;
  createAccount(data: object): Promise<{ id: string }>;
  updateAccount(id: string, data: object): Promise<void>;
  /** Converts a lead into an Account and Contact; returns their ids. */
  convertLead(id: string): Promise<{ accountId: string; contactId: string | null }>;
  /** Attaches a file to a record, e.g. the signed agreement PDF on the Account. */
  attachFile(module: string, recordId: string, file: { name: string; type: string; data: Uint8Array }): Promise<{ id: string }>;
}

export interface SignRecipient { name: string; email: string }
/** Zoho Sign request status: draft, inprogress, completed, declined, recalled, expired. */
export interface SignRequestState { id: string; status: string; completedAt?: string }

export interface ZohoSignClient {
  /** Creates a request from a Sign template and sends it to the recipient in one call. */
  sendFromTemplate(templateId: string, data: { requestName: string; recipient: SignRecipient; fieldData?: Record<string, string> }): Promise<{ id: string }>;
  getRequest(id: string): Promise<SignRequestState>;
  /** The completed request's signed document (a PDF, or a zip when the request has several). */
  downloadSigned(id: string): Promise<{ name: string; type: string; data: Uint8Array }>;
}

export interface ZohoBooksClient {
  /** Finds a customer by email when given, else by exact contact name, so a retried run does not create a second one. */
  findCustomer(name: string, email?: string): Promise<{ id: string } | null>;
  createCustomer(data: { contact_name: string; company_name?: string; email?: string; phone?: string }): Promise<{ id: string }>;
  /** Finds an invoice by its reference number (the agreement code). */
  findInvoice(referenceNumber: string): Promise<{ id: string } | null>;
  createInvoice(data: { customer_id: string; reference_number: string; date?: string; payment_terms?: number; line_items: Array<{ name: string; description?: string; rate: number; quantity: number; tax_id?: string }> }): Promise<{ id: string }>;
  /** Emails the invoice to the given addresses, or only marks it sent when there are none. */
  sendInvoice(id: string, to: string[]): Promise<void>;
  getInvoice(id: string): Promise<BooksInvoiceState>;
}

/** Books invoice status: draft, sent, viewed, overdue, partially_paid, paid, void. */
export interface BooksInvoiceState { id: string; number: string; status: string; total: number; balance: number; due_date: string | null }

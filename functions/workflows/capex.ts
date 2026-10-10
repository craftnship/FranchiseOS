import { AppError } from "../common/errors";
import { TenantContext } from "../common/context";
import { logActivity } from "../common/audit";
import { log } from "../common/logger";
import { DuplicateKeyError, Row, Store, TenantRepo } from "../common/store";
import { round, toNum } from "../common/values";
import { BooksBill, ZohoBooksClient } from "../integrations/clients";

// Capex budget vs actual per opening project. The budget starts as the feasibility investment split
// by category; actuals are Books vendor bills whose reference number carries the project code
// (e.g. "PROJ-000012 KITCHEN"), plus spend recorded by hand or by the franchisee with an invoice.

export interface CapexCategory { code: string; name: string; share: number }

/** QSR fit-out split of the initial investment (percent); a tenant overrides it with settings_json.capex_categories. */
export const DEFAULT_CAPEX_CATEGORIES: CapexCategory[] = [
  { code: "CIVIL", name: "Civil and interiors", share: 30 },
  { code: "KITCHEN", name: "Kitchen equipment", share: 25 },
  { code: "FURNITURE", name: "Furniture and fixtures", share: 10 },
  { code: "SIGNAGE", name: "Signage and branding", share: 5 },
  { code: "IT", name: "IT and POS", share: 5 },
  { code: "LICENCES", name: "Licences and deposits", share: 3 },
  { code: "STOCK", name: "Opening stock", share: 5 },
  { code: "MARKETING", name: "Launch marketing", share: 7 },
  { code: "CONTINGENCY", name: "Contingency", share: 10 },
];
export const OTHER = "OTHER";
const COUNTED = (s: Row) => String(s.status) !== "VOID" && String(s.status) !== "DRAFT";

function settingsOf(tenant: Row | null): Record<string, unknown> {
  try { return JSON.parse(String(tenant?.settings_json ?? "{}")); } catch { return {}; }
}

export function capexCategories(tenant: Row | null): CapexCategory[] {
  const custom = settingsOf(tenant).capex_categories;
  return Array.isArray(custom) && custom.length ? (custom as CapexCategory[]) : DEFAULT_CAPEX_CATEGORIES;
}

/** Percent over budget that counts as an overrun (default 0: any spend above budget). */
function tolerance(tenant: Row | null): number {
  return toNum(settingsOf(tenant).capex_tolerance_pct ?? 0);
}

/** The feasibility investment approved for the project's application, or 0. */
async function approvedInvestment(repo: TenantRepo, project: Row): Promise<number> {
  const app = project.application_id ? await repo.findOne("franchise_applications", { ROWID: String(project.application_id) }) : null;
  const fm = app?.feasibility_id ? await repo.findOne("feasibility_models", { ROWID: String(app.feasibility_id) }) : null;
  return toNum(fm?.initial_investment);
}

/** Creates the budget lines once, splitting the feasibility investment; existing lines stay as they are. */
export async function ensureBudget(store: Store, ctx: TenantContext, project: Row): Promise<Row[]> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const pid = String(project.ROWID);
  const lines = await repo.findMany("capex_lines", { project_id: pid }, { limit: 100 });
  if (lines.length) return lines;
  const tenant = await store.findOne("tenants", { ROWID: ctx.tenantId });
  const total = await approvedInvestment(repo, project);
  for (const c of capexCategories(tenant)) {
    try {
      lines.push(await repo.insert("capex_lines", { project_id: pid, category: c.code, name: c.name, budget: round((total * c.share) / 100 / 1000, 0) * 1000, line_key: `${ctx.tenantId}:${pid}:${c.code}` }));
    } catch (e) {
      if (!(e instanceof DuplicateKeyError)) throw e;
    }
  }
  return lines;
}

export interface CapexRow { category: string; name: string; line_id: string | null; budget: number; actual: number; outstanding: number; variance: number; used_pct: number | null; over: boolean }
export interface CapexSummary { rows: CapexRow[]; budget: number; actual: number; outstanding: number; variance: number; used_pct: number | null; over: boolean; investment: number }

/** Budget vs actual by category. Spend in a category with no budget line shows under Other. */
export function summarise(lines: Row[], spend: Row[], tolerancePct = 0, investment = 0): CapexSummary {
  const by = new Map<string, CapexRow>();
  for (const l of lines) by.set(String(l.category), { category: String(l.category), name: String(l.name), line_id: String(l.ROWID), budget: toNum(l.budget), actual: 0, outstanding: 0, variance: 0, used_pct: null, over: false });
  for (const s of spend.filter(COUNTED)) {
    const cat = by.has(String(s.category)) ? String(s.category) : OTHER;
    if (!by.has(cat)) by.set(cat, { category: OTHER, name: "Other", line_id: null, budget: 0, actual: 0, outstanding: 0, variance: 0, used_pct: null, over: false });
    const r = by.get(cat)!;
    r.actual += toNum(s.amount);
    r.outstanding += toNum(s.balance);
  }
  // Only a set budget can be overrun; spend against no budget shows as unbudgeted, not as an alert.
  const over = (budget: number, actual: number) => budget > 0 && actual > budget * (1 + tolerancePct / 100);
  const rows = [...by.values()].map((r) => ({ ...r, actual: round(r.actual), outstanding: round(r.outstanding), variance: round(r.budget - r.actual), used_pct: r.budget > 0 ? round((r.actual / r.budget) * 100, 0) : null, over: over(r.budget, r.actual) }));
  const budget = rows.reduce((a, r) => a + r.budget, 0);
  const actual = round(rows.reduce((a, r) => a + r.actual, 0));
  return { rows, budget, actual, outstanding: round(rows.reduce((a, r) => a + r.outstanding, 0)), variance: round(budget - actual), used_pct: budget > 0 ? round((actual / budget) * 100, 0) : null, over: over(budget, actual), investment };
}

export async function capexFor(store: Store, ctx: TenantContext, project: Row): Promise<{ summary: CapexSummary; lines: Row[]; spend: Row[] }> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const lines = await ensureBudget(store, ctx, project);
  const spend = (await repo.findMany("capex_spend", { project_id: String(project.ROWID) }, { limit: 500 }))
    .sort((a, b) => String(b.spend_date ?? "").localeCompare(String(a.spend_date ?? "")));
  const tenant = await store.findOne("tenants", { ROWID: ctx.tenantId });
  return { summary: summarise(lines, spend, tolerance(tenant), await approvedInvestment(repo, project)), lines, spend };
}

/** Logs capex:overrun for each category (and the total) that went over budget with this change, so people are told once. */
async function alertNewOverruns(store: Store, ctx: TenantContext, project: Row, before: CapexSummary, after: CapexSummary): Promise<void> {
  const was = new Set(before.rows.filter((r) => r.over).map((r) => r.category));
  const fresh = after.rows.filter((r) => r.over && !was.has(r.category));
  const total = after.over && !before.over;
  if (!fresh.length && !total) return;
  await logActivity(store, ctx, {
    entityType: "project", entityId: String(project.ROWID), action: "capex:overrun",
    metadata: { categories: fresh.map((r) => ({ code: r.category, name: r.name, budget: r.budget, actual: r.actual })), total: total ? { budget: after.budget, actual: after.actual } : null },
  });
}

/** Wraps a spend change: summary before, change, summary after, then any overrun alert. */
async function withOverrunCheck<T>(store: Store, ctx: TenantContext, project: Row, change: () => Promise<T>): Promise<T> {
  const before = (await capexFor(store, ctx, project)).summary;
  const out = await change();
  await alertNewOverruns(store, ctx, project, before, (await capexFor(store, ctx, project)).summary);
  return out;
}

export async function setBudget(store: Store, ctx: TenantContext, project: Row, line: Row, change: { budget?: number; notes?: string | null }): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const row = await repo.update("capex_lines", String(line.ROWID), change);
  await logActivity(store, ctx, { entityType: "project", entityId: String(project.ROWID), action: "capex:budget", metadata: { category: line.category, from: toNum(line.budget), to: change.budget ?? toNum(line.budget) } });
  return row;
}

export interface SpendInput { category: string; vendor: string; spend_date: string; amount: number; reference?: string; notes?: string; file_ref?: string }

/** Spend recorded in FOS (staff, or the franchisee with an invoice). Books bills come from syncBills. */
export async function recordSpend(store: Store, ctx: TenantContext, project: Row, input: SpendInput, source: "MANUAL" | "PORTAL"): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const lines = await ensureBudget(store, ctx, project);
  if (input.category !== OTHER && !lines.some((l) => l.category === input.category)) throw new AppError("VALIDATION_FAILED", "Choose a budget category.", { category: "unknown" });
  return withOverrunCheck(store, ctx, project, async () => {
    const row = await repo.insert("capex_spend", {
      project_id: String(project.ROWID), ...input, reference: input.reference ?? null, notes: input.notes ?? null, file_ref: input.file_ref ?? null,
      source, balance: 0, status: "RECORDED", recorded_by: /^\d+$/.test(ctx.userId) ? ctx.userId : null,
      spend_key: `${ctx.tenantId}:${source}:${project.ROWID}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    });
    await logActivity(store, ctx, { entityType: "project", entityId: String(project.ROWID), action: "capex:spend", metadata: { spend_id: row.ROWID, category: input.category, amount: input.amount, source } });
    return row;
  });
}

/** Staff recategorise any entry (a Books bill keeps the category on later syncs), or void one recorded in FOS. */
export async function updateSpend(store: Store, ctx: TenantContext, project: Row, spend: Row, change: { category?: string; void?: boolean; notes?: string | null }): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  if (change.void && spend.source === "BOOKS") throw new AppError("VALIDATION_FAILED", "Void a Books bill in Zoho Books; it drops out here on the next sync.", { void: "Books bill" });
  if (change.category && change.category !== OTHER && !(await ensureBudget(store, ctx, project)).some((l) => l.category === change.category)) throw new AppError("VALIDATION_FAILED", "Choose a budget category.", { category: "unknown" });
  return withOverrunCheck(store, ctx, project, async () => {
    const patch: Row = {};
    if (change.category) patch.category = change.category;
    if (change.notes !== undefined) patch.notes = change.notes;
    if (change.void) patch.status = "VOID";
    const row = await repo.update("capex_spend", String(spend.ROWID), patch);
    await logActivity(store, ctx, { entityType: "project", entityId: String(project.ROWID), action: change.void ? "capex:void" : "capex:update", metadata: { spend_id: spend.ROWID, ...patch } });
    return row;
  });
}

/** Category from the bill reference: "PROJ-000012 KITCHEN" or "PROJ-000012/Kitchen equipment". */
export function categoryFromReference(reference: string, code: string, lines: Row[]): string {
  const rest = reference.toUpperCase().split(code.toUpperCase())[1]?.replace(/^[\s/:\-_|]+/, "").trim() ?? "";
  if (!rest) return OTHER;
  const hit = lines.find((l) => rest.startsWith(String(l.category).toUpperCase()) || rest.startsWith(String(l.name).toUpperCase()));
  return hit ? String(hit.category) : OTHER;
}

/** Pulls the project's Books bills: new ones are added, changed ones updated, a staff recategorisation kept. */
export async function syncBills(store: Store, ctx: TenantContext, books: ZohoBooksClient, project: Row): Promise<{ added: number; updated: number; bills: number }> {
  if (!books.listBills) return { added: 0, updated: 0, bills: 0 };
  const repo = new TenantRepo(store, ctx.tenantId);
  const code = String(project.project_code);
  const bills: BooksBill[] = await books.listBills(code);
  const lines = await ensureBudget(store, ctx, project);
  let added = 0, updated = 0;
  await withOverrunCheck(store, ctx, project, async () => {
    for (const b of bills) {
      const key = `${ctx.tenantId}:BOOKS:${b.id}`;
      const status = b.status.toUpperCase();
      const existing = await repo.findOne("capex_spend", { spend_key: key });
      const fields = { reference: b.number || b.reference, vendor: b.vendor, spend_date: b.date, amount: b.total, balance: b.balance, status };
      if (!existing) {
        try {
          await repo.insert("capex_spend", { project_id: String(project.ROWID), category: categoryFromReference(b.reference, code, lines), source: "BOOKS", external_id: b.id, ...fields, spend_key: key });
          added++;
        } catch (e) {
          if (!(e instanceof DuplicateKeyError)) throw e;
        }
      } else if (!sameBill(existing, fields)) {
        await repo.update("capex_spend", String(existing.ROWID), fields);
        updated++;
      }
    }
  });
  if (added || updated) await logActivity(store, ctx, { entityType: "project", entityId: String(project.ROWID), action: "capex:sync", metadata: { added, updated, bills: bills.length } });
  return { added, updated, bills: bills.length };
}

function sameBill(row: Row, b: { reference: string; vendor: string; spend_date: string | null; amount: number; balance: number; status: string }): boolean {
  return String(row.reference ?? "") === b.reference && String(row.vendor ?? "") === b.vendor && String(row.spend_date ?? "").slice(0, 10) === String(b.spend_date ?? "").slice(0, 10)
    && toNum(row.amount) === b.amount && toNum(row.balance) === b.balance && String(row.status) === b.status;
}

const OPEN = ["NOT_STARTED", "PLANNING", "IN_PROGRESS", "AT_RISK", "READY_FOR_OPENING"];

/** Daily, from the two-way sync job: Books bills for every project not yet closed. */
export async function syncTenantBills(store: Store, ctx: TenantContext, books: ZohoBooksClient): Promise<{ projects: number; added: number; failed: number }> {
  const out = { projects: 0, added: 0, failed: 0 };
  if (!books.listBills) return out;
  const repo = new TenantRepo(store, ctx.tenantId);
  for (const status of [...OPEN, "OPENED"]) {
    for (const p of await repo.findMany("franchise_projects", { status }, { limit: 500 })) {
      try {
        out.added += (await syncBills(store, ctx, books, p)).added;
        out.projects++;
      } catch (e) {
        out.failed++;
        log("warn", "capex.sync_failed", { tenant_id: ctx.tenantId, request_id: ctx.requestId, project_id: p.ROWID, error: String((e as Error)?.message ?? e).slice(0, 300) });
      }
    }
  }
  return out;
}

import { TenantContext } from "../common/context";
import { logActivity } from "../common/audit";
import { AppError } from "../common/errors";
import { DuplicateKeyError, newestFirst, Row, Store, TenantRepo } from "../common/store";
import { round, toBool, toNum } from "../common/values";
import { recordPoSpend } from "./capex";

// Approved vendors and the standard store package, and the purchase orders a store places against
// them. Items carry a capex category (KITCHEN, STOCK, ...); delivered orders count as capex spend.
//
// Vendor:  APPROVED ⇄ SUSPENDED          Item: ACTIVE ⇄ RETIRED
// Order:   PLACED → CONFIRMED (expected delivery date) → DELIVERED
//          PLACED | CONFIRMED → CANCELLED (with a reason)

export const EQUIP_ORDER_TASK = "EQUIP_ORDER";
export const EQUIP_INSTALL_TASK = "EQUIP_INSTALL";
export const STOCK_TASK = "OPENING_STOCK";
/** Catalogue categories behind the ordering tasks: kitchen equipment and opening stock. */
export const EQUIPMENT = "KITCHEN";
export const STOCK = "STOCK";
const LIVE = ["PLACED", "CONFIRMED", "DELIVERED"];

const lines = (po: Row): PoLine[] => { try { return JSON.parse(String(po.lines_json ?? "[]")); } catch { return []; } };
export interface PoLine { item_id: string; sku: string | null; name: string; category: string; unit: string | null; qty: number; unit_price: number; amount: number }

// ---- Catalogue ----

export interface VendorInput { name: string; category: string; contact_name?: string | null; email?: string | null; phone?: string | null; gstin?: string | null; city?: string | null; notes?: string | null }

export async function saveVendor(store: Store, ctx: TenantContext, input: VendorInput, existing?: Row): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const vendor_key = `${ctx.tenantId}:${input.name.trim().toLowerCase()}`;
  try {
    const row = existing ? await repo.update("vendors", String(existing.ROWID), { ...input, vendor_key })
      : await repo.insert("vendors", { ...input, vendor_key, status: "APPROVED" });
    await logActivity(store, ctx, { entityType: "vendor", entityId: String(row.ROWID), action: existing ? "vendor:updated" : "vendor:added", metadata: { name: input.name } });
    return row;
  } catch (e) {
    if (e instanceof DuplicateKeyError) throw new AppError("VALIDATION_FAILED", `${input.name} is already in the catalogue.`, { name: "already in the catalogue" });
    throw e;
  }
}

export async function setVendorStatus(store: Store, ctx: TenantContext, vendor: Row, approved: boolean, reason: string | null): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const row = await repo.update("vendors", String(vendor.ROWID), { status: approved ? "APPROVED" : "SUSPENDED", status_note: reason });
  await logActivity(store, ctx, { entityType: "vendor", entityId: String(vendor.ROWID), action: approved ? "vendor:approved" : "vendor:suspended", metadata: { name: vendor.name, reason } });
  return row;
}

export interface ItemInput { vendor_id: string; sku?: string | null; name: string; category: string; unit?: string | null; unit_price: number; lead_time_days?: number | null; standard?: boolean; standard_qty?: number | null }

export async function saveItem(store: Store, ctx: TenantContext, input: ItemInput, existing?: Row): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const vendor = await repo.findOne("vendors", { ROWID: input.vendor_id });
  if (!vendor) throw new AppError("VALIDATION_FAILED", "Choose a vendor.", { vendor_id: "not found" });
  const standard = !!input.standard;
  if (standard && !(toNum(input.standard_qty) > 0)) throw new AppError("VALIDATION_FAILED", "Say how many each store needs.", { standard_qty: "required for the standard package" });
  const fields = { ...input, standard, standard_qty: standard ? toNum(input.standard_qty) : null };
  const row = existing ? await repo.update("vendor_items", String(existing.ROWID), fields) : await repo.insert("vendor_items", { ...fields, status: "ACTIVE" });
  await logActivity(store, ctx, { entityType: "vendor", entityId: input.vendor_id, action: existing ? "vendor:item_updated" : "vendor:item_added", metadata: { item_id: String(row.ROWID), name: input.name, unit_price: input.unit_price, standard } });
  return row;
}

export async function setItemStatus(store: Store, ctx: TenantContext, item: Row, active: boolean): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const row = await repo.update("vendor_items", String(item.ROWID), { status: active ? "ACTIVE" : "RETIRED" });
  await logActivity(store, ctx, { entityType: "vendor", entityId: String(item.vendor_id), action: active ? "vendor:item_restored" : "vendor:item_retired", metadata: { item_id: String(item.ROWID), name: item.name } });
  return row;
}

/** Vendors with their items. Portal users and project screens see only approved vendors and active items. */
export async function catalogue(store: Store, ctx: TenantContext, all: boolean): Promise<Row[]> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const [vendors, items] = await Promise.all([repo.findMany("vendors", {}, { limit: 500 }), repo.findMany("vendor_items", {}, { limit: 3000 })]);
  return vendors
    .filter((v) => all || v.status === "APPROVED")
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((v) => ({
      ...v,
      items: items.filter((i) => String(i.vendor_id) === String(v.ROWID) && (all || i.status === "ACTIVE"))
        .map((i): Row => ({ ...i, standard: toBool(i.standard) }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    }));
}

// ---- Store package and orders ----

/** Each standard item a store needs, with how many are ordered and delivered for this project. */
export interface PackageLine { item_id: string; vendor_id: string; name: string; sku: string | null; category: string; unit: string | null; needed: number; ordered: number; delivered: number }

export function packageStatus(items: Row[], orders: Row[]): PackageLine[] {
  const live = orders.filter((o) => LIVE.includes(String(o.status)));
  return items.filter((i) => i.status === "ACTIVE" && toBool(i.standard)).map((i) => {
    const qty = (status?: string) => live.filter((o) => !status || o.status === status).flatMap(lines).filter((l) => l.item_id === String(i.ROWID)).reduce((s, l) => s + l.qty, 0);
    const needed = toNum(i.standard_qty);
    return { item_id: String(i.ROWID), vendor_id: String(i.vendor_id), name: String(i.name), sku: i.sku ? String(i.sku) : null, category: String(i.category), unit: i.unit ? String(i.unit) : null, needed, ordered: qty(), delivered: qty("DELIVERED") };
  }).sort((a, b) => String(a.category).localeCompare(String(b.category)) || String(a.name).localeCompare(String(b.name)));
}

/** Which ordering tasks the package now meets. A category with no standard items doesn't gate anything. */
export function packageMet(pkg: PackageLine[]): { ordered: boolean | null; installed_ready: boolean | null; stock: boolean | null } {
  const of = (cat: string) => pkg.filter((p) => p.category === cat);
  const all = (rows: PackageLine[], f: (p: PackageLine) => boolean) => (rows.length ? rows.every(f) : null);
  return {
    ordered: all(of(EQUIPMENT), (p) => p.ordered >= p.needed),
    installed_ready: all(of(EQUIPMENT), (p) => p.delivered >= p.needed),
    stock: all(of(STOCK), (p) => p.delivered >= p.needed),
  };
}

async function projectState(repo: TenantRepo, project: Row) {
  const pid = String(project.ROWID);
  const [items, orders, vendors, checklist] = await Promise.all([
    repo.findMany("vendor_items", {}, { limit: 3000 }),
    repo.findMany("purchase_orders", { project_id: pid }, { limit: 500 }),
    repo.findMany("vendors", {}, { limit: 500 }),
    repo.findMany("opening_checklists", { project_id: pid }, { limit: 300 }),
  ]);
  return { items, orders, vendors, checklist };
}

/** Tasks the package now meets: ordering equipment and receiving opening stock. */
export async function metTasks(store: Store, ctx: TenantContext, project: Row): Promise<string[]> {
  const s = await projectState(new TenantRepo(store, ctx.tenantId), project);
  const met = packageMet(packageStatus(s.items, s.orders));
  return [...(met.ordered ? [EQUIP_ORDER_TASK] : []), ...(met.stock ? [STOCK_TASK] : [])];
}

/** Ordering and installing equipment, and receiving stock, can't be ticked by hand before the package says so. */
export async function assertPackageTask(store: Store, ctx: TenantContext, project: Row, task: string): Promise<void> {
  const rule = { [EQUIP_ORDER_TASK]: ["ordered", EQUIPMENT, "ordered"], [EQUIP_INSTALL_TASK]: ["installed_ready", EQUIPMENT, "delivered"], [STOCK_TASK]: ["stock", STOCK, "delivered"] }[task] as [keyof ReturnType<typeof packageMet>, string, "ordered" | "delivered"] | undefined;
  if (!rule) return;
  const s = await projectState(new TenantRepo(store, ctx.tenantId), project);
  const pkg = packageStatus(s.items, s.orders);
  if (packageMet(pkg)[rule[0]] !== false) return;
  const short = pkg.filter((p) => p.category === rule[1] && p[rule[2]] < p.needed).map((p) => `${p.name} ${p[rule[2]]} of ${p.needed}`);
  throw new AppError("VALIDATION_FAILED", `The standard package isn't ${rule[2]} yet: ${short.slice(0, 4).join(", ")}${short.length > 4 ? "…" : ""}.`, { package: `${short.length} item${short.length === 1 ? "" : "s"} not ${rule[2]}` });
}

/** When the order is needed: equipment by its install date, stock by its task, anything else by the opening. */
function neededBy(project: Row, checklist: Row[], categories: string[]): string | null {
  const due = (code: string) => { const i = checklist.find((c) => c.task_code === code); return i?.due_date ? String(i.due_date).slice(0, 10) : null; };
  const target = project.target_opening_date ? String(project.target_opening_date).slice(0, 10) : null;
  const dates = categories.map((c) => (c === EQUIPMENT ? due(EQUIP_INSTALL_TASK) : c === STOCK ? due(STOCK_TASK) : null) ?? target).filter(Boolean) as string[];
  return dates.sort()[0] ?? null;
}

const isLate = (o: Row, today: string) =>
  ["PLACED", "CONFIRMED"].includes(String(o.status)) && (
    (!!o.expected_delivery && !!o.needed_by && String(o.expected_delivery).slice(0, 10) > String(o.needed_by).slice(0, 10)) ||
    (!!o.expected_delivery && String(o.expected_delivery).slice(0, 10) < today));

/** Everything on the project's purchasing panel. */
export async function purchasingFor(store: Store, ctx: TenantContext, project: Row, today: string): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const s = await projectState(repo, project);
  const pkg = packageStatus(s.items, s.orders);
  const vendorName = new Map(s.vendors.map((v) => [String(v.ROWID), String(v.name)]));
  const orders = s.orders
    .sort(newestFirst)
    .map((o): Row => ({ ...o, lines: lines(o), vendor_name: vendorName.get(String(o.vendor_id)) ?? "—", late: isLate(o, today), overdue: o.status === "CONFIRMED" && !!o.expected_delivery && String(o.expected_delivery).slice(0, 10) < today }));
  return {
    package: pkg, met: packageMet(pkg), orders,
    open_value: round(orders.filter((o) => o.status === "PLACED" || o.status === "CONFIRMED").reduce((t, o) => t + toNum(o.total), 0), 2),
    delivered_value: round(orders.filter((o) => o.status === "DELIVERED").reduce((t, o) => t + toNum(o.total), 0), 2),
  };
}

export interface OrderInput { vendor_id: string; lines: { item_id: string; qty: number }[]; needed_by?: string | null; notes?: string | null }

export async function placeOrder(store: Store, ctx: TenantContext, project: Row, input: OrderInput, source: "PORTAL" | "STAFF", now: Date): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const vendor = await repo.findOne("vendors", { ROWID: input.vendor_id });
  if (!vendor || vendor.status !== "APPROVED") throw new AppError("VALIDATION_FAILED", "Order from an approved vendor.", { vendor_id: "not approved" });
  const items = await repo.findMany("vendor_items", { vendor_id: input.vendor_id }, { limit: 1000 });
  const ids = new Set<string>();
  const poLines: PoLine[] = input.lines.map((l) => {
    const i = items.find((x) => String(x.ROWID) === l.item_id && x.status === "ACTIVE");
    if (!i) throw new AppError("VALIDATION_FAILED", "Every item must be in this vendor's catalogue.", { lines: "item not in the catalogue" });
    if (ids.has(l.item_id)) throw new AppError("VALIDATION_FAILED", `${i.name} is on the order twice.`, { lines: "duplicate item" });
    ids.add(l.item_id);
    const unit_price = toNum(i.unit_price);
    return { item_id: String(i.ROWID), sku: i.sku ? String(i.sku) : null, name: String(i.name), category: String(i.category), unit: i.unit ? String(i.unit) : null, qty: l.qty, unit_price, amount: round(unit_price * l.qty, 2) };
  });
  const pid = String(project.ROWID);
  const s = await projectState(repo, project);
  const seq = s.orders.length + 1;
  const po_number = `PO-${project.project_code}-${String(seq).padStart(2, "0")}`;
  const total = round(poLines.reduce((t, l) => t + l.amount, 0), 2);
  const row = await repo.insert("purchase_orders", {
    project_id: pid, franchisee_id: project.franchisee_id ?? null, vendor_id: input.vendor_id, po_number, po_key: `${ctx.tenantId}:${po_number}`,
    status: "PLACED", lines_json: JSON.stringify(poLines), total, needed_by: input.needed_by ?? neededBy(project, s.checklist, poLines.map((l) => l.category)),
    notes: input.notes ?? null, source, placed_by: ctx.userId ?? null, placed_at: now.toISOString(),
  });
  await logActivity(store, ctx, { entityType: "project", entityId: pid, action: "po:placed", metadata: { project_id: pid, po_id: String(row.ROWID), po_number, vendor: vendor.name, total, source } });
  return row;
}

export type OrderChange =
  | { action: "confirm"; expected_delivery: string; vendor_ref?: string | null }
  | { action: "deliver"; delivered_on: string; delivery_ref?: string | null; note?: string | null }
  | { action: "cancel"; reason: string };

export async function changeOrder(store: Store, ctx: TenantContext, project: Row, po: Row, change: OrderChange, now: Date): Promise<Row> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const from = String(po.status);
  const allowed: Record<string, string[]> = { confirm: ["PLACED", "CONFIRMED"], deliver: ["PLACED", "CONFIRMED"], cancel: ["PLACED", "CONFIRMED"] };
  if (!allowed[change.action].includes(from)) throw new AppError("INVALID_TRANSITION", `A ${from.toLowerCase()} order can't be ${change.action === "deliver" ? "marked delivered" : `${change.action}ed`}.`);
  const at = now.toISOString();
  const patch: Row =
    change.action === "confirm" ? { status: "CONFIRMED", expected_delivery: change.expected_delivery, vendor_ref: change.vendor_ref ?? po.vendor_ref ?? null, confirmed_by: ctx.userId ?? null, confirmed_at: at }
    : change.action === "deliver" ? { status: "DELIVERED", delivered_on: change.delivered_on, delivery_ref: change.delivery_ref ?? null, delivery_note: change.note ?? null, delivered_by: ctx.userId ?? null }
    : { status: "CANCELLED", cancel_reason: change.reason, cancelled_by: ctx.userId ?? null, cancelled_at: at };
  const row = await repo.update("purchase_orders", String(po.ROWID), patch);
  const vendor = await repo.findOne("vendors", { ROWID: String(po.vendor_id) });
  if (change.action === "deliver") await recordPoSpend(store, ctx, project, { ...po, ...patch }, lines(po), String(vendor?.name ?? "Vendor"));
  const pid = String(project.ROWID);
  const verb = { confirm: "confirmed", deliver: "delivered", cancel: "cancelled" }[change.action];
  await logActivity(store, ctx, { entityType: "project", entityId: pid, action: `po:${verb}`, metadata: {
    project_id: pid, po_id: String(po.ROWID), po_number: po.po_number, vendor: vendor?.name ?? null, total: toNum(po.total), from,
    expected_delivery: "expected_delivery" in change ? change.expected_delivery : null, reason: "reason" in change ? change.reason : null,
  } });
  return row;
}

/** Confirmed orders past their expected delivery, for the daily reminders. */
export function overdueOrders(orders: Row[], today: string): Row[] {
  return orders.filter((o) => o.status === "CONFIRMED" && o.expected_delivery && String(o.expected_delivery).slice(0, 10) < today);
}

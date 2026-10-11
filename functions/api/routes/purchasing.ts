import { z } from "zod";
import { AppError } from "../../common/errors";
import { authorize, isPortalUser } from "../../common/rbac";
import { Row } from "../../common/store";
import { DEFAULT_CAPEX_CATEGORIES } from "../../workflows/capex";
import { catalogue, changeOrder, metTasks, placeOrder, purchasingFor, saveItem, saveVendor, setItemStatus, setVendorStatus } from "../../workflows/purchasing";
import { Call, parse, Router } from "../router";
import { assertOwner, completeTasks, mustGet, signedUrl, storeUpload, uploadSchema } from "./shared";

// Vendor catalogue (vendor.manage keeps it; everyone signed in can read the approved part) and the
// purchase orders a store places from it. The franchisee (portal) or staff with project.write place
// orders; staff confirm them with the vendor's delivery date; either side records the delivery.

const text = (max: number) => z.string().trim().max(max);
const day = z.string().date();
const CATEGORIES = DEFAULT_CAPEX_CATEGORIES.map((c) => c.code) as [string, ...string[]];
const vendorSchema = z.object({
  name: text(200).min(2), category: z.enum(CATEGORIES), contact_name: text(120).nullish(), email: z.string().trim().email().max(200).nullish(),
  phone: text(20).nullish(), gstin: z.string().trim().regex(/^[0-9A-Z]{15}$/, "Enter the 15-character GSTIN.").nullish(), city: text(100).nullish(), notes: text(2000).nullish(),
}).strict();
const vendorStatusSchema = z.object({ approved: z.boolean(), reason: text(500).nullish() }).strict();
const itemSchema = z.object({
  vendor_id: z.string().min(1), sku: text(60).nullish(), name: text(200).min(2), category: z.enum(CATEGORIES), unit: text(20).nullish(),
  unit_price: z.number().nonnegative().max(1e9), lead_time_days: z.number().int().min(0).max(365).nullish(), standard: z.boolean().optional(), standard_qty: z.number().positive().max(10000).nullish(),
}).strict();
const orderSchema = z.object({
  vendor_id: z.string().min(1), lines: z.array(z.object({ item_id: z.string().min(1), qty: z.number().positive().max(100000) }).strict()).min(1).max(40),
  needed_by: day.nullish(), notes: text(2000).nullish(),
}).strict();
const changeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm"), expected_delivery: day, vendor_ref: text(100).nullish() }).strict(),
  z.object({ action: z.literal("deliver"), delivered_on: day, note: text(1000).nullish(), delivery_note: uploadSchema.optional() }).strict(),
  z.object({ action: z.literal("cancel"), reason: text(500).min(3) }).strict(),
]);

const getProject = async (call: Call) => assertOwner(call, await mustGet(call.repo, "franchise_projects", call.params.id, "NOT_FOUND"), "NOT_FOUND");
async function getOrder(call: Call): Promise<Row> {
  const po = await mustGet(call.repo, "purchase_orders", call.params.poId, "NOT_FOUND");
  if (String(po.project_id) !== call.params.id) throw new AppError("NOT_FOUND");
  return po;
}
const portalOrStaff = async (call: Call) => { if (!isPortalUser(call.ctx)) await authorize(call.ctx, "project.write", call.permissions); };
const today = (call: Call) => call.now.toISOString().slice(0, 10);

/** Completes the ordering tasks the package now meets. */
async function syncTasks(call: Call, project: Row): Promise<string[]> {
  return completeTasks(call, project, await metTasks(call.store, call.ctx, project));
}

export function purchasingRoutes(r: Router): void {
  // Catalogue. ?all=true (vendor.manage) includes suspended vendors and retired items.
  r.on("GET", "/vendors", null, async (call) => {
    const all = call.query.all === "true";
    if (all) await authorize(call.ctx, "vendor.manage", call.permissions);
    return { vendors: await catalogue(call.store, call.ctx, all), categories: DEFAULT_CAPEX_CATEGORIES.map(({ code, name }) => ({ code, name })) };
  });

  r.on("POST", "/vendors", "vendor.manage", async (call) => saveVendor(call.store, call.ctx, parse(vendorSchema, call.body)), 201);

  r.on("PATCH", "/vendors/:vendorId", "vendor.manage", async (call) => {
    const vendor = await mustGet(call.repo, "vendors", call.params.vendorId, "NOT_FOUND");
    const raw = (call.body ?? {}) as Record<string, unknown>;
    if ("approved" in raw) { const b = parse(vendorStatusSchema, raw); return setVendorStatus(call.store, call.ctx, vendor, b.approved, b.reason ?? null); }
    return saveVendor(call.store, call.ctx, parse(vendorSchema, raw), vendor);
  });

  r.on("POST", "/vendor-items", "vendor.manage", async (call) => saveItem(call.store, call.ctx, parse(itemSchema, call.body)), 201);

  r.on("PATCH", "/vendor-items/:itemId", "vendor.manage", async (call) => {
    const item = await mustGet(call.repo, "vendor_items", call.params.itemId, "NOT_FOUND");
    const raw = (call.body ?? {}) as Record<string, unknown>;
    if ("active" in raw) return setItemStatus(call.store, call.ctx, item, parse(z.object({ active: z.boolean() }).strict(), raw).active);
    return saveItem(call.store, call.ctx, parse(itemSchema, raw), item);
  });

  // A project's package, orders and delivery dates.
  r.on("GET", "/projects/:id/purchasing", null, async (call) => purchasingFor(call.store, call.ctx, await getProject(call), today(call)));

  r.on("POST", "/projects/:id/purchase-orders", null, async (call) => {
    const project = await getProject(call);
    await portalOrStaff(call);
    if (project.status === "CLOSED") throw new AppError("INVALID_TRANSITION", "This project is closed.");
    const b = parse(orderSchema, call.body);
    const row = await placeOrder(call.store, call.ctx, project, b, isPortalUser(call.ctx) ? "PORTAL" : "STAFF", call.now);
    return { ...row, tasks_completed: await syncTasks(call, project) };
  }, 201);

  // confirm (staff, with the vendor's date); deliver (franchisee or staff); cancel (franchisee while placed, or staff).
  r.on("PATCH", "/projects/:id/purchase-orders/:poId", null, async (call) => {
    const project = await getProject(call);
    const b = parse(changeSchema, call.body);
    const portal = isPortalUser(call.ctx);
    const po = await getOrder(call);
    if (b.action === "confirm" && portal) throw new AppError("ACCESS_DENIED", "The franchise team confirms orders with the vendor.");
    if (b.action === "cancel" && portal && po.status !== "PLACED") throw new AppError("ACCESS_DENIED", "Ask the franchise team to cancel a confirmed order.");
    if (!portal) await authorize(call.ctx, "project.write", call.permissions);
    if (b.action === "deliver") {
      if (b.delivered_on > today(call)) throw new AppError("VALIDATION_FAILED", "The date can't be in the future.", { delivered_on: "can't be in the future" });
      const delivery_ref = b.delivery_note ? await storeUpload(call, `projects/${call.params.id}/deliveries`, b.delivery_note) : null;
      const row = await changeOrder(call.store, call.ctx, project, po, { action: "deliver", delivered_on: b.delivered_on, note: b.note, delivery_ref }, call.now);
      return { ...row, tasks_completed: await syncTasks(call, project) };
    }
    if (b.action === "confirm" && b.expected_delivery < today(call)) throw new AppError("VALIDATION_FAILED", "The delivery date can't be in the past.", { expected_delivery: "in the past" });
    return changeOrder(call.store, call.ctx, project, po, b, call.now);
  });

  r.on("GET", "/projects/:id/purchase-orders/:poId/delivery-note", null, async (call) => {
    await getProject(call);
    return signedUrl(call, String((await getOrder(call)).delivery_ref ?? ""), "No delivery note attached.");
  });
}

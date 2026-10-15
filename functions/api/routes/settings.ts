import { randomUUID } from "crypto";
import { z } from "zod";
import { logActivity } from "../../common/audit";
import { brandingOf } from "../../common/branding";
import { createDemoLink, DEMO_DEFAULT_DAYS, DEMO_MAX_DAYS, demoLinkOf, revokeDemoLink } from "../../common/demo";
import { AppError } from "../../common/errors";
import { FileStorage, safeFileName, STRATUS_PREFIX } from "../../common/files";
import { Row, Store } from "../../common/store";
import { parse, Router } from "../router";
import { uploadSchema } from "./shared";
import { defaultFranchiseType } from "../../common/franchiseType";
import { staffConfig } from "../../workflows/staffing";

// Settings → Branding: the company name, logo and colour shown in place of FranchiseOS, on the
// sign-in screen too, so GET /branding answers signed-out visitors.

const LOGO_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const MAX_LOGO_BYTES = 1024 * 1024;

const brandingSchema = z.object({
  name: z.string().trim().max(60).nullable(),
  tagline: z.string().trim().max(60).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "use a colour like #2f5bea").nullable(),
  /** A new logo; null removes it; absent keeps the current one. */
  logo: uploadSchema.nullable().optional(),
}).strict();

/** Signed-out visitors see the tenant FOS_PUBLIC_TENANT names, or the only active tenant. */
async function publicTenant(store: Store): Promise<Row | null> {
  const code = process.env.FOS_PUBLIC_TENANT?.trim();
  if (code) return store.findOne("tenants", { tenant_code: code, status: "ACTIVE" });
  const active = await store.findMany("tenants", { status: "ACTIVE" });
  return active.length === 1 ? active[0] : null;
}

async function view(tenant: Row | null, files: FileStorage | null) {
  const b = brandingOf(tenant);
  let logo_url: string | null = null;
  if (b.logo_ref?.startsWith(STRATUS_PREFIX) && files) logo_url = await files.downloadUrl(b.logo_ref.slice(STRATUS_PREFIX.length)).catch(() => null);
  return { name: b.name, tagline: b.tagline, color: b.color, logo_url };
}

const code = z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,39}$/, "use capitals, digits and _ (e.g. SERVICE_ADVISOR)");
const setupSchema = z.object({
  default_franchise_type: z.string().trim().min(1).max(50),
  staff_roles: z.array(z.object({ code, name: z.string().trim().min(1).max(60), plural: z.string().trim().min(1).max(60), default_count: z.number().int().min(0).max(100) }).strict()).min(1).max(12),
  training_modules: z.array(z.object({ code, name: z.string().trim().min(1).max(100), roles: z.array(code).min(1), certificate: z.boolean().optional() }).strict()).min(1).max(40),
}).strict();

const settingsOf = (tenant: Row | null): Row => { try { return tenant?.settings_json ? JSON.parse(String(tenant.settings_json)) : {}; } catch { return {}; } };

const demoSchema = z.object({ days: z.number().int().min(1).max(DEMO_MAX_DAYS).optional() }).strict();

/** The tenant's read-only demo link as Settings shows it: the token the link carries, and when it lapses. */
async function demoView(store: Store, tenantId: string, now: Date) {
  const tenant = await store.findOne("tenants", { ROWID: tenantId });
  const link = demoLinkOf(tenant, now);
  return link ? { active: true, token: `${tenant!.tenant_code}.${link.token}`, expires_on: link.expires_on, created_at: link.created_at } : { active: false, token: null, expires_on: null, created_at: null };
}

async function setupView(store: Store, tenantId: string) {
  const tenant = await store.findOne("tenants", { ROWID: tenantId });
  const cfg = staffConfig(tenant);
  // Formats that have templates, so the default can be picked from what exists.
  const types = new Set<string>();
  for (const t of ["project_templates", "agreement_templates"]) for (const row of await store.findMany(t, { tenant_id: tenantId })) if (row.franchise_type) types.add(String(row.franchise_type));
  return { default_franchise_type: defaultFranchiseType(tenant), franchise_types: [...types].sort(), staff_roles: cfg.roles, training_modules: cfg.modules };
}

export function settingsRoutes(r: Router): void {
  r.on("GET", "/settings/store-setup", "settings.manage", async (call) => setupView(call.store, call.ctx.tenantId));

  r.on("PUT", "/settings/store-setup", "settings.manage", async (call) => {
    const b = parse(setupSchema, call.body);
    const dup = (xs: { code: string }[]) => xs.find((x, i) => xs.findIndex((y) => y.code === x.code) !== i)?.code;
    if (dup(b.staff_roles)) throw new AppError("VALIDATION_FAILED", `Two roles use the code ${dup(b.staff_roles)}.`, { staff_roles: "duplicate code" });
    if (dup(b.training_modules)) throw new AppError("VALIDATION_FAILED", `Two modules use the code ${dup(b.training_modules)}.`, { training_modules: "duplicate code" });
    const roles = new Set(b.staff_roles.map((x) => x.code));
    const stray = b.training_modules.find((m) => m.roles.some((x) => !roles.has(x)));
    if (stray) throw new AppError("VALIDATION_FAILED", `${stray.name} is for a role that isn't in the list.`, { training_modules: "unknown role" });
    // Roles already on a team can't disappear, or those people would drop out of the plan.
    const removed = [...staffConfig(await call.store.findOne("tenants", { ROWID: call.ctx.tenantId })).roles].map((x) => x.code).filter((c) => !roles.has(c));
    for (const c of removed) {
      if ((await call.repo.findMany("store_staff", { role_code: c, status: "ACTIVE" }, { limit: 1 })).length) throw new AppError("VALIDATION_FAILED", `People are still employed as ${c}; change their role first.`, { staff_roles: "role in use" });
    }
    const tenant = await call.store.findOne("tenants", { ROWID: call.ctx.tenantId });
    if (!tenant) throw new AppError("TENANT_NOT_FOUND");
    const settings = settingsOf(tenant);
    Object.assign(settings, { default_franchise_type: b.default_franchise_type, staff_roles: b.staff_roles, training_modules: b.training_modules.map((m) => ({ ...m, certificate: !!m.certificate })) });
    await call.store.update("tenants", call.ctx.tenantId, { settings_json: JSON.stringify(settings) });
    await logActivity(call.store, call.ctx, { entityType: "tenant", entityId: call.ctx.tenantId, action: "settings:store_setup", metadata: { default_franchise_type: b.default_franchise_type, roles: b.staff_roles.length, modules: b.training_modules.length } });
    return setupView(call.store, call.ctx.tenantId);
  });

  // Settings → Demo link: one read-only link per tenant, replaced on each create and turned off on delete.
  r.on("GET", "/settings/demo-link", "settings.manage", async (call) => demoView(call.store, call.ctx.tenantId, call.now));

  r.on("POST", "/settings/demo-link", "settings.manage", async (call) => {
    const b = parse(demoSchema, call.body);
    const tenant = await call.store.findOne("tenants", { ROWID: call.ctx.tenantId });
    if (!tenant) throw new AppError("TENANT_NOT_FOUND");
    const days = b.days ?? DEMO_DEFAULT_DAYS;
    const link = await createDemoLink(call.store, tenant, days, call.now, /^\d+$/.test(call.ctx.userId) ? call.ctx.userId : null);
    await logActivity(call.store, call.ctx, { entityType: "tenant", entityId: call.ctx.tenantId, action: "settings:demo_link_create", metadata: { days, expires_on: link.expires_on } });
    return demoView(call.store, call.ctx.tenantId, call.now);
  }, 201);

  r.on("DELETE", "/settings/demo-link", "settings.manage", async (call) => {
    const tenant = await call.store.findOne("tenants", { ROWID: call.ctx.tenantId });
    if (!tenant) throw new AppError("TENANT_NOT_FOUND");
    await revokeDemoLink(call.store, tenant);
    await logActivity(call.store, call.ctx, { entityType: "tenant", entityId: call.ctx.tenantId, action: "settings:demo_link_revoke", metadata: {} });
    return demoView(call.store, call.ctx.tenantId, call.now);
  });

  r.onPublic("GET", "/branding", async (call) => {
    const tenant = call.tenantId ? await call.store.findOne("tenants", { ROWID: call.tenantId }) : await publicTenant(call.store);
    return view(tenant, call.files);
  });

  r.on("PUT", "/settings/branding", "settings.manage", async (call) => {
    const b = parse(brandingSchema, call.body);
    const tenant = await call.store.findOne("tenants", { ROWID: call.ctx.tenantId });
    if (!tenant) throw new AppError("TENANT_NOT_FOUND");
    let settings: Row = {};
    try { settings = tenant.settings_json ? JSON.parse(String(tenant.settings_json)) : {}; } catch { settings = {}; }
    const current = brandingOf(tenant);
    let logo_ref = current.logo_ref;
    if (b.logo === null) logo_ref = null;
    else if (b.logo) {
      if (!call.files) throw new AppError("FILE_STORAGE_UNAVAILABLE", "File uploads aren't set up yet.");
      if (!LOGO_TYPES[b.logo.content_type]) throw new AppError("VALIDATION_FAILED", "Upload the logo as a PNG, JPG or WebP image.", { logo: "unsupported type" });
      const data = Buffer.from(b.logo.data_base64, "base64");
      if (!data.length) throw new AppError("VALIDATION_FAILED", "The file is empty.", { logo: "empty" });
      if (data.length > MAX_LOGO_BYTES) throw new AppError("VALIDATION_FAILED", "The logo can be up to 1 MB.", { logo: "too large" });
      const key = `tenants/${call.ctx.tenantId}/branding/${randomUUID()}/${safeFileName(b.logo.file_name)}`;
      await call.files.put(key, data, b.logo.content_type);
      logo_ref = `${STRATUS_PREFIX}${key}`;
    }
    const next = { name: b.name || null, tagline: b.tagline === undefined ? current.tagline : b.tagline || null, color: b.color?.toLowerCase() ?? null, logo_ref };
    settings.branding = next;
    await call.store.update("tenants", call.ctx.tenantId, { settings_json: JSON.stringify(settings) });
    await logActivity(call.store, call.ctx, { entityType: "tenant", entityId: call.ctx.tenantId, action: "settings:branding", metadata: { name: next.name, color: next.color, logo: b.logo === undefined ? "kept" : b.logo === null ? "removed" : "replaced" } });
    return view(await call.store.findOne("tenants", { ROWID: call.ctx.tenantId }), call.files);
  });
}

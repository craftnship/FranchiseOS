import { randomUUID } from "crypto";
import { z } from "zod";
import { logActivity } from "../../common/audit";
import { brandingOf } from "../../common/branding";
import { AppError } from "../../common/errors";
import { FileStorage, safeFileName, STRATUS_PREFIX } from "../../common/files";
import { Row, Store } from "../../common/store";
import { parse, Router } from "../router";
import { uploadSchema } from "./shared";

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

export function settingsRoutes(r: Router): void {
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

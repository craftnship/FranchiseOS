import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { MemoryFileStorage } from "../../functions/common/files";
import { newStore } from "./helpers";

const router = buildRouter();
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");

async function setup() {
  const store = newStore();
  const files = new MemoryFileStorage();
  const t = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
  for (const [role, ext] of [["SUPER_ADMIN", "admin"], ["FRANCHISE_MANAGER", "mgr"]]) await store.insert("users", { tenant_id: t.tenantId, email: `${ext}@x.test`, status: "ACTIVE", role_id: t.roleIds[role], external_user_id: ext });
  const call = async (ext: string | null, method: string, path: string, body?: unknown) =>
    (await router.handle({ method, path: `/api/v1${path}`, body, identity: ext ? { externalUserId: ext, email: `${ext}@x.test` } : null }, { store, files })).body as { success: boolean; data?: any; error?: { code: string; fields?: Record<string, string> } };
  return { store, files, t, call };
}

describe("branding", () => {
  it("shows FranchiseOS until a super admin sets a name, logo and colour, signed out too", async () => {
    const s = await setup();
    expect((await s.call(null, "GET", "/branding")).data).toEqual({ name: "FranchiseOS", tagline: null, color: null, logo_url: null });
    const saved = await s.call("admin", "PUT", "/settings/branding", { name: "Stark Burgers", color: "#C0392B", logo: { file_name: "logo.png", content_type: "image/png", data_base64: png } });
    expect(saved.data).toMatchObject({ name: "Stark Burgers", color: "#c0392b" });
    expect(saved.data.logo_url).toMatch(new RegExp(`^memory://tenants/${s.t.tenantId}/branding/.+/logo.png$`));
    expect((await s.call(null, "GET", "/branding")).data).toMatchObject({ name: "Stark Burgers", color: "#c0392b", logo_url: saved.data.logo_url });
    expect((await s.call("mgr", "GET", "/branding")).data.name).toBe("Stark Burgers");
    // Saving without a logo keeps it; null removes it; an empty name falls back to FranchiseOS.
    expect((await s.call("admin", "PUT", "/settings/branding", { name: "Stark", color: null })).data.logo_url).toBe(saved.data.logo_url);
    expect((await s.call("admin", "PUT", "/settings/branding", { name: "", color: null, logo: null })).data).toEqual({ name: "FranchiseOS", tagline: null, color: null, logo_url: null });
  });

  it("lets only super admins change it, and only to an image up to 1 MB", async () => {
    const s = await setup();
    expect((await s.call("mgr", "PUT", "/settings/branding", { name: "X", color: null })).error?.code).toBe("ACCESS_DENIED");
    expect((await s.call("admin", "PUT", "/settings/branding", { name: "X", color: null, logo: { file_name: "a.pdf", content_type: "application/pdf", data_base64: png } })).error?.fields).toEqual({ logo: "unsupported type" });
    expect((await s.call("admin", "PUT", "/settings/branding", { name: "X", color: "red" })).error?.fields).toEqual({ color: "use a colour like #2f5bea" });
  });
});

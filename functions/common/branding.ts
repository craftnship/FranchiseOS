import { Row } from "./store";

// The company name, logo and colour a tenant shows in place of FranchiseOS (settings_json.branding).

export const DEFAULT_NAME = "FranchiseOS";
export const DEFAULT_COLOR = "#2f5bea";

export interface Branding { name: string; tagline: string | null; color: string | null; logo_ref: string | null }

export function brandingOf(tenant: Row | null | undefined): Branding {
  let s: Row = {};
  try { s = tenant?.settings_json ? JSON.parse(String(tenant.settings_json)) : {}; } catch { s = {}; }
  const b = (s.branding ?? {}) as Row;
  return {
    name: typeof b.name === "string" && b.name.trim() ? b.name.trim() : DEFAULT_NAME,
    tagline: typeof b.tagline === "string" && b.tagline.trim() ? b.tagline.trim() : null,
    color: typeof b.color === "string" && /^#[0-9a-f]{6}$/i.test(b.color) ? b.color.toLowerCase() : null,
    logo_ref: typeof b.logo_ref === "string" && b.logo_ref ? b.logo_ref : null,
  };
}

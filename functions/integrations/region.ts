// Region-aware Zoho endpoints (spec §37). Never hard-code one Zoho domain in an adapter.
// Verify every base URL against current Zoho docs at build time (spec Appendix B).
export type ZohoDc = "US" | "EU" | "IN" | "AU" | "JP" | "CA" | "SA" | "CN";

const TLD: Record<ZohoDc, string> = {
  US: "com", EU: "eu", IN: "in", AU: "com.au", JP: "jp", CA: "ca", SA: "sa", CN: "com.cn",
};

export interface ZohoEndpoints { accounts: string; crm: string; projects: string; sign: string; books: string }

export function resolveZohoEndpoints(dc: string): ZohoEndpoints {
  const key = dc.toUpperCase() as ZohoDc;
  const tld = TLD[key];
  if (!tld) throw new Error(`Unsupported Zoho data center: ${dc}`);
  // Canada runs on the zohocloud.ca domain family.
  const base = key === "CA" ? "zohocloud.ca" : `zoho.${tld}`;
  const apis = key === "CA" ? "zohoapis.ca" : `zohoapis.${tld}`;
  return {
    accounts: `https://accounts.${base}`,
    crm: `https://www.${apis}/crm/v8`,
    projects: `https://projectsapi.${base}/api/v3`,
    sign: `https://sign.${base}/api/v1`,
    books: `https://www.${apis}/books/v3`,
  };
}

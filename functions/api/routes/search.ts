import { z } from "zod";
import { isPortalUser } from "../../common/rbac";
import { parse, Router } from "../router";

// Global search (plan Step 6.5): substring match on codes, names and cities across the main records.
// Portal users only search their own franchisee's records.

const TARGETS = [
  { type: "franchisee", table: "franchisees", columns: ["franchise_code", "display_name", "legal_name", "email"], label: ["franchise_code", "display_name"], owner: "ROWID", path: "/franchisees" },
  { type: "application", table: "franchise_applications", columns: ["application_code", "preferred_city"], label: ["application_code", "preferred_city"], owner: "franchisee_id", path: "/applications" },
  { type: "site", table: "sites", columns: ["site_code", "city", "address_line_1"], label: ["site_code", "city"], owner: "franchisee_id", path: "/sites" },
  { type: "agreement", table: "agreements", columns: ["agreement_code"], label: ["agreement_code", "status"], owner: "franchisee_id", path: "/agreements" },
  { type: "project", table: "franchise_projects", columns: ["project_code"], label: ["project_code", "status"], owner: "franchisee_id", path: "/projects" },
  { type: "territory", table: "territories", columns: ["territory_code", "name", "city"], label: ["territory_code", "name"], owner: null, path: "/territories" },
];

export function searchRoutes(r: Router): void {
  r.on("GET", "/search", null, async (call) => {
    const q = parse(z.object({ q: z.string().trim().min(2).max(60), limit: z.coerce.number().int().min(1).max(20).default(5) }), call.query);
    const portal = isPortalUser(call.ctx);
    const targets = TARGETS.filter((t) => !portal || t.owner);
    const groups = await Promise.all(targets.map(async (t) => {
      const where = portal ? { [t.owner!]: call.ctx.franchiseeId ?? "-" } : {};
      const rows = await call.repo.findMany(t.table, where, { contains: { columns: t.columns, term: q.q }, limit: q.limit });
      return rows.map((row) => ({ type: t.type, id: String(row.ROWID), title: t.label.map((k) => row[k]).filter(Boolean).join(" · "), status: row.status ?? null, path: `${t.path}/${row.ROWID}` }));
    }));
    return groups.flat();
  });
}

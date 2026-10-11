import { z } from "zod";
import { Row, TenantRepo } from "../../common/store";
import { parse, Router } from "../router";

// Activity log viewer (who did what, when). Reads activity_logs for the caller's tenant only.

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const listSchema = z.object({
  entity_type: z.string().max(40).optional(),
  entity_id: z.string().max(40).optional(),
  actor_user_id: z.string().max(40).optional(),
  from: day.optional(),
  to: day.optional(),
  q: z.string().trim().max(100).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Where each kind of record lives, its readable code, and the page that shows it. */
const ENTITIES: Record<string, { table: string; label: (r: Row) => string; href: (r: Row) => string | null }> = {
  application: { table: "franchise_applications", label: (r) => String(r.application_code), href: (r) => `/applications/${r.ROWID}` },
  project: { table: "franchise_projects", label: (r) => String(r.project_code), href: (r) => `/projects/${r.ROWID}` },
  site: { table: "sites", label: (r) => String(r.site_code), href: (r) => `/sites/${r.ROWID}` },
  agreement: { table: "agreements", label: (r) => String(r.agreement_code), href: (r) => `/agreements/${r.ROWID}` },
  franchisee: { table: "franchisees", label: (r) => String(r.display_name ?? r.franchise_code), href: (r) => `/applications?franchisee_id=${r.ROWID}` },
  territory: { table: "territories", label: (r) => String(r.territory_code), href: () => "/territories" },
  checklist: { table: "opening_checklists", label: (r) => String(r.item), href: (r) => (r.project_id ? `/projects/${r.project_id}` : null) },
  licence: { table: "licences", label: (r) => String(r.name), href: (r) => (r.project_id ? `/projects/${r.project_id}` : null) },
  feasibility: { table: "feasibility_models", label: () => "Feasibility", href: (r) => (r.application_id ? `/applications/${r.application_id}` : null) },
  approval_delegation: { table: "approval_delegations", label: (r) => `Delegation of ${String(r.role ?? "").toLowerCase().replace(/_/g, " ")}`, href: () => "/approvals" },
};
export const AUDIT_ENTITY_TYPES = Object.keys(ENTITIES);

const DAY_MS = 86_400_000;
const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/** Who acted: a person (by users.ROWID) or a named system process. */
function actorOf(id: unknown, users: Map<string, Row>): Row | null {
  const key = String(id ?? "");
  if (!key) return null;
  if (key.startsWith("SYSTEM")) {
    const what = key.split(":")[1] ?? "system";
    const names: Record<string, string> = { job: "Scheduled job", reminders: "Daily reminders", sign: "Zoho Sign", crm: "Zoho CRM", test: "Test hook" };
    return { id: key, name: names[what] ?? "System", system: true };
  }
  const u = users.get(key);
  return { id: key, name: u?.name ?? u?.email ?? "Unknown user", email: u?.email ?? null };
}

async function describe(repo: TenantRepo, rows: Row[]): Promise<Map<string, Row | null>> {
  const out = new Map<string, Row | null>();
  for (const r of rows) {
    const key = `${r.entity_type}:${r.entity_id}`;
    if (out.has(key)) continue;
    const e = ENTITIES[String(r.entity_type)];
    const row = e && r.entity_id ? await repo.findOne(e.table, { ROWID: String(r.entity_id) }) : null;
    out.set(key, row && e ? { label: e.label(row), href: e.href(row) } : null);
  }
  return out;
}

export function auditRoutes(r: Router): void {
  r.on("GET", "/audit", "audit.view", async (call) => {
    const q = parse(listSchema, call.query);
    const where: Record<string, string> = {};
    if (q.entity_type) where.entity_type = q.entity_type;
    if (q.entity_id) where.entity_id = q.entity_id;
    if (q.actor_user_id) where.actor_user_id = q.actor_user_id;
    const rows = await call.repo.findMany("activity_logs", where, {
      orderBy: "created_at", desc: true, offset: q.offset, limit: q.limit + 1,
      ...(q.from || q.to ? { range: { column: "created_at", from: q.from, before: q.to ? nextDay(q.to) : undefined } } : {}),
      ...(q.q ? { contains: { columns: ["action", "entity_id", "metadata_json"], term: q.q } } : {}),
    });
    const page = rows.slice(0, q.limit);
    const users = new Map((await call.repo.findMany("users", {}, { limit: 300 })).map((u) => [String(u.ROWID), u]));
    const entities = await describe(call.repo, page);
    const items = page.map((a) => {
      let meta: Row = {};
      try { meta = JSON.parse(String(a.metadata_json || "{}")) as Row; } catch { meta = { raw: a.metadata_json }; }
      const { correlation_id, ...details } = meta;
      return {
        id: String(a.ROWID), at: a.created_at, action: a.action, entity_type: a.entity_type, entity_id: a.entity_id,
        entity: entities.get(`${a.entity_type}:${a.entity_id}`) ?? null, actor: actorOf(a.actor_user_id, users),
        details, correlation_id: correlation_id ?? null,
      };
    });
    const actors = [...users.values()].map((u) => ({ id: String(u.ROWID), name: u.name ?? u.email }));
    return { items, next_offset: rows.length > q.limit ? q.offset + q.limit : null, entity_types: AUDIT_ENTITY_TYPES, actors };
  });
}

import { DuplicateKeyError, Primitive, QueryOptions, Row, Store } from "./store";

/**
 * Data Store adapter over zcatalyst-sdk-node. `app` is the result of catalyst.initialize(req).
 * Kept structurally typed so the SDK version can move without touching domain code.
 */
interface CatalystApp {
  datastore(): { table(name: string): { insertRow(r: Row): Promise<Row>; updateRow(r: Row): Promise<Row> } };
  zcql(): { executeZCQLQuery(q: string): Promise<Array<Record<string, Row>>> };
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`Unsafe identifier: ${name}`);
  return name;
}

/** ZCQL literal escaping. Values never reach a query unescaped. */
export function literal(v: Primitive): string {
  if (v === null) return "null";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("Non-finite number in query");
    return String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  return "'" + v.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

export function buildSelect(table: string, where: Record<string, Primitive>, opts: QueryOptions = {}): string {
  const t = ident(table);
  const clauses = Object.entries(where).map(([k, v]) => (v === null ? `${ident(k)} IS NULL` : `${ident(k)} = ${literal(v)}`));
  let q = `SELECT * FROM ${t}`;
  if (clauses.length) q += ` WHERE ${clauses.join(" AND ")}`;
  if (opts.orderBy) q += ` ORDER BY ${ident(opts.orderBy)} ${opts.desc ? "DESC" : "ASC"}`;
  // ZCQL caps rows per query (300); callers page with offset.
  const limit = Math.min(opts.limit ?? 300, 300);
  q += opts.offset ? ` LIMIT ${opts.offset},${limit}` : ` LIMIT ${limit}`;
  return q;
}

const ISO_UTC = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z$/;

/**
 * Data Store datetime columns reject ISO strings ("datetime value expected") and take
 * "YYYY-MM-DD HH:mm:ss". Domain code writes UTC ISO timestamps, so they are converted here.
 */
export function toStoreRow(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    const m = typeof v === "string" ? ISO_UTC.exec(v) : null;
    out[k] = m ? `${m[1]} ${m[2]}` : v;
  }
  return out;
}

function isDuplicate(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err).toLowerCase();
  // Verify the exact Data Store error code for unique violations at build time.
  return msg.includes("duplicate") || msg.includes("unique");
}

export class CatalystStore implements Store {
  constructor(private readonly app: CatalystApp) {}

  async insert(table: string, row: Row): Promise<Row> {
    try {
      return await this.app.datastore().table(ident(table)).insertRow(toStoreRow(row));
    } catch (e) {
      if (isDuplicate(e)) throw new DuplicateKeyError(table);
      throw e;
    }
  }

  async update(table: string, rowId: string, patch: Row): Promise<Row> {
    try {
      return await this.app.datastore().table(ident(table)).updateRow(toStoreRow({ ...patch, ROWID: rowId }));
    } catch (e) {
      if (isDuplicate(e)) throw new DuplicateKeyError(table);
      throw e;
    }
  }

  async findOne(table: string, where: Record<string, Primitive>): Promise<Row | null> {
    return (await this.findMany(table, where, { limit: 1 }))[0] ?? null;
  }

  async findMany(table: string, where: Record<string, Primitive>, opts?: QueryOptions): Promise<Row[]> {
    const result = await this.app.zcql().executeZCQLQuery(buildSelect(table, where, opts));
    // ZCQL wraps each row as { tableName: {...} }.
    return result.map((r) => r[table] ?? Object.values(r)[0]);
  }
}

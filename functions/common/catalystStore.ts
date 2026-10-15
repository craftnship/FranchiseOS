import { log } from "./logger";
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
/** Rows ZCQL returns per query. */
export const PAGE = 300;
/** The most rows one findMany reads without a limit; reaching it is logged, never silent. */
export const ROW_CAP = 10_000;

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
  if (opts.contains?.columns.length) {
    // ZCQL LIKE uses * as the wildcard; the term's own wildcards are dropped.
    const term = opts.contains.term.replace(/[*?]/g, "");
    clauses.push(`(${opts.contains.columns.map((c) => `${ident(c)} LIKE ${literal(`*${term}*`)}`).join(" OR ")})`);
  }
  const day = (d: string) => (d.length === 10 ? `${d} 00:00:00` : d);
  if (opts.range?.from) clauses.push(`${ident(opts.range.column)} >= ${literal(day(opts.range.from))}`);
  if (opts.range?.before) clauses.push(`${ident(opts.range.column)} < ${literal(day(opts.range.before))}`);
  let q = `SELECT * FROM ${t}`;
  if (clauses.length) q += ` WHERE ${clauses.join(" AND ")}`;
  if (opts.orderBy) q += ` ORDER BY ${ident(opts.orderBy)} ${opts.desc ? "DESC" : "ASC"}`;
  // ZCQL caps rows per query (300); findMany pages past it.
  const limit = Math.min(opts.limit ?? PAGE, PAGE);
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

/** Readable text for any thrown value; the Catalyst SDK sometimes throws plain objects. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    const parts = ["status", "statusCode", "code", "message"].filter((k) => o[k] !== undefined).map((k) => `${k}=${String(o[k])}`);
    if (parts.length) return parts.join(" ");
    try { return JSON.stringify(err).slice(0, 1000); } catch { /* fall through */ }
  }
  return String(err);
}

/** Data Store turned the call away (a throttle reply), so it did nothing and is safe to send again. */
export function isRefused(err: unknown): boolean {
  const o = (err && typeof err === "object" ? err : {}) as Record<string, unknown>;
  if ([o.status, o.statusCode].some((s) => Number(s) === 429)) return true;
  return /too many|rate.?limit|throttl|limit exceeded|request limit|try again/i.test(describeError(err));
}

/** A refusal, or a dropped connection. Retrying a dropped call is safe only when repeating it changes nothing (reads, updates). */
export function isThrottled(err: unknown): boolean {
  return isRefused(err) || /ECONNRESET|socket hang up|ETIMEDOUT/i.test(describeError(err));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** How many Data Store calls one store (one request or job run) has in flight at once. */
export const MAX_IN_FLIGHT = 4;
const RETRY_DELAYS = [250, 700, 1500];

export class CatalystStore implements Store {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly app: CatalystApp, private readonly wait: (ms: number) => Promise<void> = sleep) {}

  /** Runs a Data Store call under the in-flight cap, retrying throttled calls with backoff. */
  private async run<T>(fn: () => Promise<T>, retryable: (e: unknown) => boolean = isThrottled): Promise<T> {
    if (this.active >= MAX_IN_FLIGHT) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          return await fn();
        } catch (e) {
          if (attempt >= RETRY_DELAYS.length || !retryable(e)) throw e;
          await this.wait(RETRY_DELAYS[attempt] + Math.floor(Math.random() * 150));
        }
      }
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  async insert(table: string, row: Row): Promise<Row> {
    try {
      // An insert cut off mid-flight may already have landed, so only a clear refusal is sent again.
      return await this.run(() => this.app.datastore().table(ident(table)).insertRow(toStoreRow(row)), isRefused);
    } catch (e) {
      if (isDuplicate(e)) throw new DuplicateKeyError(table);
      throw e;
    }
  }

  async update(table: string, rowId: string, patch: Row): Promise<Row> {
    try {
      return await this.run(() => this.app.datastore().table(ident(table)).updateRow(toStoreRow({ ...patch, ROWID: rowId })));
    } catch (e) {
      if (isDuplicate(e)) throw new DuplicateKeyError(table);
      throw e;
    }
  }

  async findOne(table: string, where: Record<string, Primitive>): Promise<Row | null> {
    return (await this.findMany(table, where, { limit: 1 }))[0] ?? null;
  }

  /**
   * Every matching row up to `limit` (ROW_CAP when none is given), read 300 at a time: ZCQL caps a
   * query at 300 rows, and a caller that asks for more, or for all, must not be cut off without
   * knowing. Pages are ordered by ROWID unless the caller orders them, so no row is skipped or repeated.
   */
  async findMany(table: string, where: Record<string, Primitive>, opts: QueryOptions = {}): Promise<Row[]> {
    const want = opts.limit ?? ROW_CAP;
    if (want <= PAGE) return this.page(table, where, opts);
    const paged: QueryOptions = { ...opts, orderBy: opts.orderBy ?? "ROWID" };
    const out: Row[] = [];
    for (let offset = opts.offset ?? 0; out.length < want; offset += PAGE) {
      const rows = await this.page(table, where, { ...paged, offset, limit: Math.min(PAGE, want - out.length) });
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
    if (out.length >= want) log("warn", "store.row_cap", { table, limit: want, hint: "rows past the limit were not read" });
    return out;
  }

  private async page(table: string, where: Record<string, Primitive>, opts: QueryOptions): Promise<Row[]> {
    const q = buildSelect(table, where, opts);
    const result = await this.run(() => this.app.zcql().executeZCQLQuery(q));
    // ZCQL wraps each row as { tableName: {...} }.
    return result.map((r) => r[table] ?? Object.values(r)[0]);
  }
}

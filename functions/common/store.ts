import { AppError } from "./errors";

export type Primitive = string | number | boolean | null;
export type Row = Record<string, unknown> & { ROWID?: string };

/** Raised when an insert/update violates a unique column. This is our lock primitive (D-13). */
export class DuplicateKeyError extends Error {
  constructor(public readonly table: string, public readonly detail?: string) {
    super(`Duplicate key in ${table}`);
  }
}

export interface QueryOptions {
  orderBy?: string;
  desc?: boolean;
  limit?: number;
  offset?: number;
  /** Case-insensitive substring match on any of these columns (global search). */
  contains?: { columns: string[]; term: string };
  /** Dates (YYYY-MM-DD) bounding a date or datetime column: `from` inclusive, `before` exclusive. */
  range?: { column: string; from?: string; before?: string };
}

/**
 * Row age. Catalyst hands ROWIDs out in blocks per server, so they are not in time order: a row written on
 * the 14th can carry a lower ROWID than one written on the 13th. "Latest" therefore means CREATEDTIME, and
 * ROWID only breaks a tie within the same millisecond. Queries that want the newest rows order by CREATEDTIME
 * for the same reason; ROWID order is only for paging, where any stable order will do.
 */
const byRowid = (a: Row, b: Row) => String(a.ROWID ?? "").localeCompare(String(b.ROWID ?? ""), undefined, { numeric: true });
export const oldestFirst = (a: Row, b: Row): number => String(a.CREATEDTIME ?? "").localeCompare(String(b.CREATEDTIME ?? "")) || byRowid(a, b);
export const newestFirst = (a: Row, b: Row): number => oldestFirst(b, a);

/** Minimal persistence port. CatalystStore implements it for Data Store; MemoryStore for tests. */
export interface Store {
  insert(table: string, row: Row): Promise<Row>;
  update(table: string, rowId: string, patch: Row): Promise<Row>;
  findOne(table: string, where: Record<string, Primitive>): Promise<Row | null>;
  findMany(table: string, where: Record<string, Primitive>, opts?: QueryOptions): Promise<Row[]>;
}

/**
 * Tenant-scoped repository (§6, FOS-005). Every read and write carries tenant_id taken from
 * the server-side context; callers cannot widen or replace it.
 */
export class TenantRepo {
  constructor(private readonly store: Store, private readonly tenantId: string) {
    if (!tenantId) throw new AppError("TENANT_NOT_FOUND");
  }

  insert(table: string, row: Row): Promise<Row> {
    return this.store.insert(table, { ...row, tenant_id: this.tenantId });
  }

  async update(table: string, rowId: string, patch: Row): Promise<Row> {
    await this.getById(table, rowId); // ownership check before write
    const { tenant_id: _ignored, ...safe } = patch;
    return this.store.update(table, rowId, safe);
  }

  findOne(table: string, where: Record<string, Primitive>): Promise<Row | null> {
    return this.store.findOne(table, { ...where, tenant_id: this.tenantId });
  }

  findMany(table: string, where: Record<string, Primitive> = {}, opts?: QueryOptions): Promise<Row[]> {
    return this.store.findMany(table, { ...where, tenant_id: this.tenantId }, opts);
  }

  async getById(table: string, rowId: string): Promise<Row> {
    const row = await this.store.findOne(table, { ROWID: rowId, tenant_id: this.tenantId });
    if (!row) throw new AppError("INVALID_REQUEST", `Record not found in ${table}.`);
    return row;
  }
}

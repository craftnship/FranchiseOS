import { DuplicateKeyError, Primitive, QueryOptions, Row, Store } from "./store";

/** In-memory Store honouring unique columns, used by unit tests and local runs. */
export class MemoryStore implements Store {
  private tables = new Map<string, Row[]>();
  private seq = 1000;

  constructor(private readonly uniqueColumns: Record<string, string[]> = {}) {}

  private rows(table: string): Row[] {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table)!;
  }

  private checkUnique(table: string, row: Row, selfId?: string): void {
    for (const col of this.uniqueColumns[table] ?? []) {
      const v = row[col];
      if (v === undefined || v === null) continue;
      if (this.rows(table).some((r) => r.ROWID !== selfId && r[col] === v)) throw new DuplicateKeyError(table, col);
    }
  }

  async insert(table: string, row: Row): Promise<Row> {
    this.checkUnique(table, row);
    const now = new Date().toISOString();
    const stored = { ...row, ROWID: String(++this.seq), CREATEDTIME: now, MODIFIEDTIME: now };
    this.rows(table).push(stored);
    return { ...stored };
  }

  async update(table: string, rowId: string, patch: Row): Promise<Row> {
    const row = this.rows(table).find((r) => r.ROWID === rowId);
    if (!row) throw new Error(`Row ${rowId} not found in ${table}`);
    const next = { ...row, ...patch, ROWID: rowId, MODIFIEDTIME: new Date().toISOString() };
    this.checkUnique(table, next, rowId);
    Object.assign(row, next);
    return { ...row };
  }

  async findOne(table: string, where: Record<string, Primitive>): Promise<Row | null> {
    return (await this.findMany(table, where, { limit: 1 }))[0] ?? null;
  }

  async findMany(table: string, where: Record<string, Primitive>, opts: QueryOptions = {}): Promise<Row[]> {
    let out = this.rows(table).filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
    if (opts.orderBy) {
      const k = opts.orderBy;
      const cmp = (x: unknown, y: unknown) =>
        typeof x === "number" && typeof y === "number" ? x - y : String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
      out = [...out].sort((a, b) => cmp(a[k], b[k]) * (opts.desc ? -1 : 1));
    }
    const start = opts.offset ?? 0;
    return out.slice(start, opts.limit ? start + opts.limit : undefined).map((r) => ({ ...r }));
  }
}

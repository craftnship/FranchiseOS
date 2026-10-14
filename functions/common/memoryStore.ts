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
    // A test may hand in CREATEDTIME to stage rows whose age and ROWID disagree, as the Data Store's can.
    const stored = { ...row, ROWID: String(++this.seq), CREATEDTIME: row.CREATEDTIME ?? now, MODIFIEDTIME: now };
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
    if (opts.contains?.columns.length) {
      const term = opts.contains.term.toLowerCase();
      out = out.filter((r) => opts.contains!.columns.some((c) => String(r[c] ?? "").toLowerCase().includes(term)));
    }
    const rg = opts.range;
    if (rg?.from) out = out.filter((r) => r[rg.column] != null && String(r[rg.column]) >= rg.from!);
    if (rg?.before) out = out.filter((r) => r[rg.column] != null && String(r[rg.column]) < rg.before!);
    if (opts.orderBy) {
      const k = opts.orderBy;
      const cmp = (x: unknown, y: unknown) =>
        typeof x === "number" && typeof y === "number" ? x - y : /^\d+$/.test(String(x)) && /^\d+$/.test(String(y)) ? Number(x) - Number(y) : String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
      const dir = opts.desc ? -1 : 1;
      out = [...out].sort((a, b) => (cmp(a[k], b[k]) || cmp(a.ROWID, b.ROWID)) * dir);
    }
    const start = opts.offset ?? 0;
    return out.slice(start, opts.limit ? start + opts.limit : undefined).map((r) => ({ ...r }));
  }
}

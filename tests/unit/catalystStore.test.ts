import { describe, expect, it } from "vitest";
import { CatalystStore, describeError, isThrottled, MAX_IN_FLIGHT, ROW_CAP } from "../../functions/common/catalystStore";

const fakeApp = (exec: (q: string) => Promise<unknown[]>) => ({
  datastore: () => ({ table: () => ({ insertRow: async (r: any) => r, updateRow: async (r: any) => r }) }),
  zcql: () => ({ executeZCQLQuery: exec as any }),
});

describe("Catalyst store under load", () => {
  it("retries a throttled query and gives up on other errors", async () => {
    let calls = 0;
    const store = new CatalystStore(fakeApp(async () => { if (++calls < 3) throw { status: 429, message: "Too many requests" }; return [{ t: { ROWID: "1" } }]; }), async () => {});
    expect(await store.findMany("t", {})).toEqual([{ ROWID: "1" }]);
    expect(calls).toBe(3);
    let bad = 0;
    const broken = new CatalystStore(fakeApp(async () => { bad++; throw new Error("Invalid column"); }), async () => {});
    await expect(broken.findMany("t", {})).rejects.toThrow("Invalid column");
    expect(bad).toBe(1);
  });

  it("reads past the 300-row ZCQL cap in pages, and stops at the limit asked for", async () => {
    const queries: string[] = [];
    const rowsFor = (q: string) => {
      queries.push(q);
      const m = /LIMIT (?:(\d+),)?(\d+)$/.exec(q)!;
      const offset = Number(m[1] ?? 0), limit = Number(m[2]);
      // 720 rows in the table.
      return Array.from({ length: Math.max(0, Math.min(limit, 720 - offset)) }, (_, i) => ({ t: { ROWID: String(offset + i + 1) } }));
    };
    const store = new CatalystStore(fakeApp(async (q) => rowsFor(q)), async () => {});
    const all = await store.findMany("t", { status: "OPENED" });
    expect(all).toHaveLength(720);
    expect(all.at(-1)).toEqual({ ROWID: "720" });
    expect(queries).toHaveLength(3);
    expect(queries[1]).toContain("ORDER BY ROWID ASC LIMIT 300,300");
    queries.length = 0;
    expect(await store.findMany("t", {}, { limit: 500 })).toHaveLength(500);
    expect(queries.map((q) => q.slice(q.indexOf("LIMIT")))).toEqual(["LIMIT 300", "LIMIT 300,200"]);
    queries.length = 0;
    expect(await store.findMany("t", {}, { limit: 40, orderBy: "period", desc: true })).toHaveLength(40);
    expect(queries).toEqual(["SELECT * FROM t ORDER BY period DESC LIMIT 40"]);
    expect(ROW_CAP).toBeGreaterThan(720);
  });

  it("caps queries in flight", async () => {
    let now = 0, peak = 0;
    const store = new CatalystStore(fakeApp(async () => { peak = Math.max(peak, ++now); await new Promise((r) => setTimeout(r, 5)); now--; return []; }));
    await Promise.all(Array.from({ length: 12 }, () => store.findMany("t", {})));
    expect(peak).toBe(MAX_IN_FLIGHT);
  });

  it("sends an insert again only when it was refused, never after a dropped connection", async () => {
    const appWith = (fail: () => unknown) => {
      let n = 0;
      const app = { datastore: () => ({ table: () => ({ insertRow: async (r: any) => { if (++n === 1) throw fail(); return r; }, updateRow: async (r: any) => r }) }), zcql: () => ({ executeZCQLQuery: async () => [] }) };
      return { app, calls: () => n };
    };
    const refused = appWith(() => ({ status: 429, message: "Too many requests" }));
    await new CatalystStore(refused.app as any, async () => {}).insert("t", { a: 1 });
    expect(refused.calls()).toBe(2);
    const dropped = appWith(() => new Error("socket hang up"));
    await expect(new CatalystStore(dropped.app as any, async () => {}).insert("t", { a: 1 })).rejects.toThrow("socket hang up");
    expect(dropped.calls()).toBe(1);
  });

  it("describes plain-object errors instead of [object Object]", () => {
    expect(describeError({ status: 500, code: "ZCQL_ERROR", message: "Limit exceeded" })).toBe("status=500 code=ZCQL_ERROR message=Limit exceeded");
    expect(isThrottled({ code: "X", message: "API request limit exceeded" })).toBe(true);
    expect(isThrottled(new Error("No such table"))).toBe(false);
  });
});

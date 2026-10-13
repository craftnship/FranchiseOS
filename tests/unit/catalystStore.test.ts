import { describe, expect, it } from "vitest";
import { CatalystStore, describeError, isThrottled, MAX_IN_FLIGHT } from "../../functions/common/catalystStore";

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

  it("caps queries in flight", async () => {
    let now = 0, peak = 0;
    const store = new CatalystStore(fakeApp(async () => { peak = Math.max(peak, ++now); await new Promise((r) => setTimeout(r, 5)); now--; return []; }));
    await Promise.all(Array.from({ length: 12 }, () => store.findMany("t", {})));
    expect(peak).toBe(MAX_IN_FLIGHT);
  });

  it("describes plain-object errors instead of [object Object]", () => {
    expect(describeError({ status: 500, code: "ZCQL_ERROR", message: "Limit exceeded" })).toBe("status=500 code=ZCQL_ERROR message=Limit exceeded");
    expect(isThrottled({ code: "X", message: "API request limit exceeded" })).toBe(true);
    expect(isThrottled(new Error("No such table"))).toBe(false);
  });
});

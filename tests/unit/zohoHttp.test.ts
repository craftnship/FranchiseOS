import { describe, expect, it } from "vitest";
import { ProviderError } from "../../functions/integrations/retry";
import { ZohoHttp } from "../../functions/integrations/zohoHttp";

// Every Zoho call has a time limit and a second chance: a read is tried again after a refusal, a
// server error or a timeout; a write only after a refusal, which Zoho never acted on.

const reply = (status: number, body: unknown = {}) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

describe("Zoho HTTP", () => {
  it("tries a read again after a refusal, a server error or a timeout, then gives up", async () => {
    const seen: string[] = [];
    const answers = [reply(429, { message: "Too many" }), reply(502, { message: "Bad gateway" }), reply(200, { ok: 1 })];
    const http = new ZohoHttp({ accessToken: async () => "tok" }, async (url, init) => { seen.push(`${init?.method} ${url}`); expect(init?.signal).toBeDefined(); return answers.shift()!; });
    expect(await http.request("GET", "https://books.zoho.in/api/v3/invoices/1")).toEqual({ ok: 1 });
    expect(seen).toHaveLength(3);
    const dead = new ZohoHttp({ accessToken: async () => "tok" }, async () => reply(503, { message: "down" }));
    await expect(dead.request("GET", "https://books.zoho.in/api/v3/invoices/1")).rejects.toThrow("failed (503)");
  });

  it("sends a write again only when it was refused, never after a server error", async () => {
    let n = 0;
    const refused = new ZohoHttp({ accessToken: async () => "tok" }, async () => (++n === 1 ? reply(429, { message: "Too many" }) : reply(201, { invoice: { id: "1" } })));
    expect(await refused.request("POST", "https://books.zoho.in/api/v3/invoices", { a: 1 })).toEqual({ invoice: { id: "1" } });
    expect(n).toBe(2);
    let m = 0;
    const broken = new ZohoHttp({ accessToken: async () => "tok" }, async () => { m++; return reply(500, { message: "oops" }); });
    await expect(broken.request("POST", "https://books.zoho.in/api/v3/invoices", { a: 1 })).rejects.toThrow("failed (500)");
    expect(m).toBe(1);
  });

  it("turns a hung call into a timeout the caller can read", async () => {
    const hung = new ZohoHttp({ accessToken: async () => "tok" }, async () => { const e = new Error("aborted"); e.name = "TimeoutError"; throw e; });
    const err = await hung.request("POST", "https://sign.zoho.in/api/v1/requests", {}).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe("Zoho POST /api/v1/requests timed out after 15s");
    expect(err.status).toBe(504);
  });
});

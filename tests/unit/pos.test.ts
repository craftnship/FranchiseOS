import { describe, expect, it } from "vitest";
import { buildRouter } from "../../functions/api/app";
import { bootstrapTenant } from "../../database/seed/bootstrapTenant";
import { HttpBooksClient } from "../../functions/integrations/booksClient";
import { posCredentialsFromEnv } from "../../functions/integrations/tenantClients";
import { signState, verifyState } from "../../functions/integrations/zohoOAuth";
import { reportingScore, scoreHealth } from "../../functions/scoring/health";
import { parseSalesCsv, runPosSalesJob } from "../../functions/workflows/posSales";
import { computeNetworkHealth } from "../../functions/workflows/storeHealth";
import { newStore } from "./helpers";

const router = buildRouter();
const NOW = "2026-10-11T06:00:00Z";
const APP = { clientId: "cid", clientSecret: "sec" };
const SECRET = "state-secret";

/** A fake fetch for the OAuth exchange and the Books organisation list. */
function zohoFetch(orgs: { organization_id: string; name: string }[], calls: string[] = []) {
  return async (url: string, init?: { method?: string; body?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${url.split("?")[0]}`);
    const json = (data: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => data, text: async () => JSON.stringify(data), headers: { get: () => null } });
    if (url.includes("/oauth/v2/token")) {
      const grant = new URLSearchParams(init?.body ?? "").get("grant_type");
      return json(grant === "authorization_code" ? { access_token: "AT", refresh_token: "RT-1", expires_in: 3600 } : { access_token: "AT", expires_in: 3600 });
    }
    if (url.endsWith("/organizations")) return json({ code: 0, organizations: orgs });
    return json({ code: 1000, message: `unexpected ${url}` }, false);
  };
}

async function setup(opts: { settings?: Record<string, unknown> } = {}) {
  const store = newStore();
  const t = await bootstrapTenant(store, { tenantCode: "STARK", name: "Stark", zohoDc: "IN" });
  const tid = t.tenantId;
  if (opts.settings) {
    const tenant = (await store.findOne("tenants", { ROWID: tid }))!;
    await store.update("tenants", tid, { settings_json: JSON.stringify({ ...JSON.parse(String(tenant.settings_json ?? "{}")), ...opts.settings }) });
  }
  const ins = (table: string, row: Record<string, unknown>) => store.insert(table, { tenant_id: tid, ...row });
  const user = (role: string, ext: string, extra: Record<string, unknown> = {}) => ins("users", { email: `${ext}@x.test`, status: "ACTIVE", role_id: t.roleIds[role], external_user_id: ext, ...extra });
  await user("SUPER_ADMIN", "tony");
  await user("FINANCE_MANAGER", "fin");
  await user("FRANCHISE_MANAGER", "fm");
  const fr = await ins("franchisees", { franchise_code: "FR-1", tenant_code_key: `${tid}:FR-1`, display_name: "Pepper Potts", email: "pepper@x.test", status: "ACTIVE", zoho_books_customer_id: "CUST-1" });
  const fr2 = await ins("franchisees", { franchise_code: "FR-2", tenant_code_key: `${tid}:FR-2`, display_name: "Happy Hogan", status: "ACTIVE" });
  await user("FRANCHISEE", "pepper", { franchisee_id: fr.ROWID });
  await user("FRANCHISEE", "happy", { franchisee_id: fr2.ROWID });
  const app = await ins("franchise_applications", { application_code: "APP-1", tenant_code_key: `${tid}:APP-1`, franchisee_id: fr.ROWID, status: "ACTIVE" });
  await ins("feasibility_models", { application_id: app.ROWID, site_id: "1", status: "CALCULATED", royalty_pct: 6, marketing_fund_pct: 2, monthly_revenue: 1_000_000 });
  const project = await ins("franchise_projects", { project_code: "PROJ-1", tenant_code_key: `${tid}:PROJ-1`, application_id: app.ROWID, franchisee_id: fr.ROWID, status: "OPENED", actual_opening_date: "2026-08-20" });
  const invoices: any[] = [];
  const books = {
    findCustomer: async () => null, createCustomer: async () => ({ id: "C" }),
    findInvoice: async (ref: string) => invoices.find((x) => x.ref === ref) ?? null,
    createInvoice: async (d: any) => { const inv = { id: `INV-${invoices.length + 1}`, ref: d.reference_number, lines: d.line_items, status: "draft" }; invoices.push(inv); return { id: inv.id }; },
    sendInvoice: async (id: string) => { invoices.find((x) => x.id === id).status = "sent"; },
    getInvoice: async (id: string) => { const i = invoices.find((x) => x.id === id); const total = i.lines.reduce((a: number, l: any) => a + l.rate, 0); return { id, number: `INV/${id}`, status: i.status, total, balance: total, due_date: "2026-11-10", last_payment_date: null }; },
  } as any;
  const oauth = { app: APP, stateSecret: SECRET, redirectUri: "https://app.test/", fetchFn: zohoFetch([{ organization_id: "ORG-1", name: "Pepper Apparel LLP" }]) };
  const call = async (ext: string, method: string, path: string, body?: unknown, now = NOW, query: Record<string, string> = {}) => {
    const res = await router.handle({ method, path: `/api/v1${path}`, body, query, identity: { externalUserId: ext, email: `${ext}@x.test` } }, { store, now: () => new Date(now), zoho: async () => ({ books }) as any, oauth });
    return res.body as { success: boolean; data?: any; error?: { code: string; fields?: Record<string, string>; message?: string } };
  };
  const inbox = async (ext: string) => (await call(ext, "GET", "/notifications")).data.items.map((n: any) => n.title) as string[];
  const base = `/projects/${project.ROWID}`;
  /** A franchisee Books feed: the same net every day from `from` to `to`. */
  const feed = (from: string, to: string, net: number, opts: { skip?: string[]; fail?: string } = {}) => ({
    dailySales: async (a: string, b: string) => {
      if (opts.fail) throw new Error(opts.fail);
      const out: any[] = [];
      for (let d = from; d <= to; d = new Date(Date.parse(d) + 86_400_000).toISOString().slice(0, 10)) if (d >= a && d <= b && !opts.skip?.includes(d)) out.push({ day: d, gross_sales: net + 1000, discounts: 1000, returns: 0, tax: net * 0.05, transactions: 40 });
      return out;
    },
  });
  const job = (booksFor: (c: any) => any, now = NOW) => runPosSalesJob(store, booksFor, async () => ({ books }) as any, { today: now.slice(0, 10), now: new Date(now), requestId: "J" });
  return { store, tid, fr, fr2, project, base, call, inbox, invoices, feed, job, oauth };
}

describe("POS sales feed: connecting", () => {
  it("signs a state that expires and cannot be altered", () => {
    const st = signState(SECRET, { tenant_id: "T", franchisee_id: "F", user_id: "U" }, Date.parse(NOW));
    expect(verifyState(SECRET, st, Date.parse(NOW) + 60_000)).toMatchObject({ tenant_id: "T", franchisee_id: "F" });
    expect(verifyState(SECRET, st, Date.parse(NOW) + 16 * 60_000)).toBeNull();
    expect(verifyState("other", st, Date.parse(NOW))).toBeNull();
    const [body, sig] = st.split(".");
    const forged = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), franchisee_id: "F2" })).toString("base64url")}.${sig}`;
    expect(verifyState(SECRET, forged, Date.parse(NOW))).toBeNull();
    expect(verifyState(SECRET, "garbage", Date.parse(NOW))).toBeNull();
  });

  it("gives the franchisee a consent link, stores the connection on return, and keeps the token to itself", async () => {
    const s = await setup();
    const start = await s.call("pepper", "POST", "/portal/connections/zoho/start");
    const url = new URL(start.data.url);
    expect(url.origin + url.pathname).toBe("https://accounts.zoho.in/oauth/v2/auth");
    expect(url.searchParams.get("scope")).toBe("ZohoBooks.invoices.READ,ZohoBooks.creditnotes.READ,ZohoBooks.settings.READ");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.test/");
    expect(url.searchParams.get("access_type")).toBe("offline");
    const state = url.searchParams.get("state")!;
    // Another franchisee cannot finish Pepper's link; a stale one is refused too.
    expect((await s.call("happy", "POST", "/portal/connections/zoho/exchange", { code: "CODE", state })).error?.code).toBe("ACCESS_DENIED");
    expect((await s.call("pepper", "POST", "/portal/connections/zoho/exchange", { code: "CODE", state }, "2026-10-11T07:00:00Z")).error?.code).toBe("ACCESS_DENIED");
    const done = await s.call("pepper", "POST", "/portal/connections/zoho/exchange", { code: "CODE", state });
    expect(done.data).toMatchObject({ choose: false, connection: { status: "ACTIVE", org_id: "ORG-1", org_name: "Pepper Apparel LLP" } });
    expect(JSON.stringify(done.data)).not.toContain("RT-1");
    const row = (await s.store.findMany("franchisee_connections", { tenant_id: s.tid }))[0];
    expect(row).toMatchObject({ franchisee_id: s.fr.ROWID, provider: "ZOHO_BOOKS", refresh_token: "RT-1", status: "ACTIVE", conn_key: `${s.tid}:${s.fr.ROWID}:ZOHO_BOOKS` });
    const list = (await s.call("pepper", "GET", "/portal/connections")).data;
    expect(list.connections).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain("RT-1");
    expect(list.stores).toEqual([{ ROWID: s.project.ROWID, project_code: "PROJ-1", status: "OPENED", feed: "NONE", last_day: null, pos_location_id: null }]);
    // Staff cannot see or touch the franchisee's connection; disconnecting drops the token.
    expect((await s.call("fin", "GET", "/portal/connections")).error?.code).toBe("ACCESS_DENIED");
    expect((await s.call("happy", "DELETE", `/portal/connections/${row.ROWID}`)).error?.code).toBe("NOT_FOUND");
    expect((await s.call("pepper", "DELETE", `/portal/connections/${row.ROWID}`)).data.connection.status).toBe("DISCONNECTED");
    expect((await s.store.findOne("franchisee_connections", { ROWID: String(row.ROWID) }))!.refresh_token).toBeNull();
  });

  it("asks which organisation when the account runs several", async () => {
    const s = await setup();
    s.oauth.fetchFn = zohoFetch([{ organization_id: "ORG-1", name: "Pepper Apparel LLP" }, { organization_id: "ORG-2", name: "Pepper Foods" }]);
    const state = new URL((await s.call("pepper", "POST", "/portal/connections/zoho/start")).data.url).searchParams.get("state")!;
    const done = await s.call("pepper", "POST", "/portal/connections/zoho/exchange", { code: "CODE", state });
    expect(done.data).toMatchObject({ choose: true, connection: { status: "PENDING", org_id: null } });
    expect(done.data.organizations.map((o: any) => o.id)).toEqual(["ORG-1", "ORG-2"]);
    const id = done.data.connection.ROWID;
    expect((await s.call("pepper", "POST", `/portal/connections/${id}/organization`, { org_id: "ORG-9" })).error?.code).toBe("VALIDATION_FAILED");
    expect((await s.call("pepper", "POST", `/portal/connections/${id}/organization`, { org_id: "ORG-2" })).data.connection).toMatchObject({ status: "ACTIVE", org_name: "Pepper Foods" });
  });

  it("consents through the franchisee client when there is one, else the brand's", () => {
    expect(posCredentialsFromEnv({ ZOHO_CLIENT_ID: "brand", ZOHO_CLIENT_SECRET: "b", ZOHO_POS_CLIENT_ID: "pos", ZOHO_POS_CLIENT_SECRET: "p" } as NodeJS.ProcessEnv)).toEqual({ clientId: "pos", clientSecret: "p" });
    expect(posCredentialsFromEnv({ ZOHO_CLIENT_ID: "brand", ZOHO_CLIENT_SECRET: "b", ZOHO_FRANCHISEE_CLIENT_ID: "fr", ZOHO_FRANCHISEE_CLIENT_SECRET: "f" } as NodeJS.ProcessEnv)).toEqual({ clientId: "fr", clientSecret: "f" });
    expect(posCredentialsFromEnv({ ZOHO_CLIENT_ID: "brand", ZOHO_CLIENT_SECRET: "b" } as NodeJS.ProcessEnv)).toEqual({ clientId: "brand", clientSecret: "b" });
    expect(posCredentialsFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("says so when the OAuth client or state secret is not set up", async () => {
    const s = await setup();
    s.oauth.stateSecret = null;
    expect((await s.call("pepper", "GET", "/portal/connections")).data.can_connect).toBe(false);
    expect((await s.call("pepper", "POST", "/portal/connections/zoho/start")).error?.code).toBe("ZOHO_SYNC_FAILED");
  });
});

describe("POS sales feed: pulling", () => {
  it("sums invoices and credit notes per day from Books, skipping drafts and voids", async () => {
    const pages: Record<string, any> = {
      "/invoices": { code: 0, invoices: [
        { date: "2026-10-01", status: "paid", total: 1050, sub_total: 1000, tax_total: 50, discount_total: 20 },
        { date: "2026-10-01", status: "sent", total: 525, sub_total: 500, tax_total: 25 },
        { date: "2026-10-01", status: "draft", total: 9999 }, { date: "2026-10-02", status: "void", total: 9999 },
        { date: "2026-10-02", status: "paid", total: 210 },
      ] },
      "/creditnotes": { code: 0, creditnotes: [{ date: "2026-10-01", status: "open", total: 105, sub_total: 100, tax_total: 5 }, { date: "2026-10-02", status: "void", total: 50 }] },
    };
    const seen: string[] = [];
    const http = { request: async (_m: string, url: string) => { seen.push(url); const u = new URL(url); return pages[u.pathname.replace("/api/v3", "")]; } } as any;
    const books = new HttpBooksClient(http, "https://books.zoho.in/api/v3", "ORG-1");
    const days = await books.dailySales("2026-10-01", "2026-10-03", "LOC-7");
    expect(days).toEqual([
      { day: "2026-10-01", gross_sales: 1500, discounts: 20, returns: 100, tax: 75, transactions: 2 },
      { day: "2026-10-02", gross_sales: 210, discounts: 0, returns: 0, tax: 0, transactions: 1 },
    ]);
    expect(seen[0]).toContain("date_start=2026-10-01");
    expect(seen[0]).toContain("location_id=LOC-7");
  });

  it("pulls ninety days first, three days after, and a rerun corrects instead of duplicating", async () => {
    const s = await setup();
    await s.store.insert("franchisee_connections", { tenant_id: s.tid, franchisee_id: s.fr.ROWID, provider: "ZOHO_BOOKS", zoho_dc: "IN", org_id: "ORG-1", org_name: "Pepper Apparel LLP", refresh_token: "RT", status: "ACTIVE", conn_key: `${s.tid}:${s.fr.ROWID}:ZOHO_BOOKS` });
    const asked: [string, string][] = [];
    const wrap = (f: any) => ({ dailySales: async (a: string, b: string) => { asked.push([a, b]); return f.dailySales(a, b); } });
    const r1 = await s.job(() => wrap(s.feed("2026-08-20", "2026-10-10", 30_000)));
    expect(asked[0]).toEqual(["2026-08-20", "2026-10-11"]); // the first pull reaches back to the opening day
    expect(r1).toMatchObject({ connections: 1, pulled: 52, failed: 0 });
    const r2 = await s.job(() => wrap(s.feed("2026-08-20", "2026-10-10", 31_000)));
    expect(asked[1]).toEqual(["2026-10-08", "2026-10-11"]);
    expect(r2.pulled).toBe(3);
    const rows = await s.store.findMany("pos_sales", { tenant_id: s.tid });
    expect(rows).toHaveLength(52);
    expect(rows.find((x) => x.day === "2026-10-10")).toMatchObject({ net_sales: 31_000, gross_sales: 32_000, discounts: 1000, source: "BOOKS" });
    expect(rows.find((x) => x.day === "2026-10-01")).toMatchObject({ net_sales: 30_000 });
    expect(await s.store.findOne("franchise_projects", { ROWID: String(s.project.ROWID) })).toMatchObject({ pos_last_day: "2026-10-10", pos_status: "CONNECTED" });
    // The store page shows the month: days, totals and no gaps.
    const m = (await s.call("fin", "GET", `${s.base}/pos`, undefined, NOW, { period: "2026-09" })).data;
    expect(m.month).toMatchObject({ net_sales: 900_000, days: 30, days_expected: 30, gaps: [] });
    expect(m.store.feed).toBe("CONNECTED");
    expect(m.connection).toMatchObject({ org_name: "Pepper Apparel LLP" });
    expect((await s.call("happy", "GET", `${s.base}/pos`)).error?.code).toBe("NOT_FOUND");
    // Three days on without a pull, the feed reads stale.
    await s.job(() => ({ dailySales: async () => [] }), "2026-10-14T06:00:00Z");
    expect((await s.store.findOne("franchise_projects", { ROWID: String(s.project.ROWID) }))!.pos_status).toBe("STALE");
  });

  it("marks a failing connection, tells the franchisee once, and recovers on the next good pull", async () => {
    const s = await setup();
    const conn = await s.store.insert("franchisee_connections", { tenant_id: s.tid, franchisee_id: s.fr.ROWID, provider: "ZOHO_BOOKS", zoho_dc: "IN", org_id: "ORG-1", org_name: "Pepper Apparel LLP", refresh_token: "RT", status: "ACTIVE", conn_key: `${s.tid}:${s.fr.ROWID}:ZOHO_BOOKS` });
    expect((await s.job(() => s.feed("2026-08-20", "2026-10-10", 1, { fail: "invalid_token: refresh token revoked" }))).failed).toBe(1);
    expect(await s.store.findOne("franchisee_connections", { ROWID: String(conn.ROWID) })).toMatchObject({ status: "FAILING", last_error: "invalid_token: refresh token revoked" });
    expect(await s.inbox("pepper")).toEqual(["Zoho Books sales feed stopped for Pepper Apparel LLP"]);
    expect(await s.inbox("fm")).toEqual(["Zoho Books sales feed stopped for Pepper Apparel LLP"]);
    await s.job(() => s.feed("2026-08-20", "2026-10-10", 1, { fail: "still broken" }), "2026-10-12T06:00:00Z");
    expect(await s.inbox("pepper")).toHaveLength(1);
    expect((await s.job(() => s.feed("2026-08-20", "2026-10-10", 20_000), "2026-10-13T06:00:00Z")).failed).toBe(0);
    expect(await s.store.findOne("franchisee_connections", { ROWID: String(conn.ROWID) })).toMatchObject({ status: "ACTIVE", last_error: null });
  });
});

describe("POS sales feed: royalty on real sales", () => {
  it("closes the month from POS with the variance against the franchisee's figure, and waits for finance", async () => {
    const s = await setup({ settings: { royalty_basis: "POS" } });
    await s.store.insert("franchisee_connections", { tenant_id: s.tid, franchisee_id: s.fr.ROWID, provider: "ZOHO_BOOKS", zoho_dc: "IN", org_id: "ORG-1", refresh_token: "RT", status: "ACTIVE", conn_key: `${s.tid}:${s.fr.ROWID}:ZOHO_BOOKS` });
    // Pepper reported September 12% under what the POS will say.
    const rep = (await s.call("pepper", "POST", `${s.base}/sales`, { period: "2026-09", gross_sales: 800_000, net_sales: 792_000 })).data;
    const r = await s.job(() => s.feed("2026-08-20", "2026-10-10", 30_000));
    expect(r).toMatchObject({ closed: 2, approved: 0 });
    const sep = (await s.store.findOne("sales_reports", { ROWID: String(rep.ROWID) }))!;
    expect(sep).toMatchObject({ basis: "POS", source: "POS", status: "SUBMITTED", net_sales: 900_000, pos_net_sales: 900_000, reported_net_sales: 792_000, variance_pct: -12 });
    const aug = await s.store.findOne("sales_reports", { period_key: `${s.tid}:${s.project.ROWID}:2026-08` });
    expect(aug).toMatchObject({ basis: "POS", net_sales: 360_000, reported_net_sales: null, variance_pct: null });
    expect(s.invoices).toHaveLength(0);
    // The ledger and the owner's attention list carry the difference.
    const l = (await s.call("tony", "GET", `${s.base}/royalties`)).data;
    expect(l.feed).toMatchObject({ status: "CONNECTED", basis: "POS", last_day: "2026-10-10" });
    expect(l.months[0]).toMatchObject({ period: "2026-09", variance_pct: -12, strayed: true, pos: { net_sales: 900_000, days: 30, gaps: 0 } });
    const o = (await s.call("tony", "GET", "/dashboard/owner")).data;
    expect(o.revenue.pos).toEqual({ connected: 1, stale: 0, total: 1, basis: "POS" });
    expect(o.attention.items.filter((i: any) => i.kind === "POS").map((i: any) => i.title)).toEqual(["PROJ-1 Sep 2026: sales under-reported by 12%"]);
    expect((await s.call("tony", "GET", "/royalties", undefined, NOW, { status: "SUBMITTED" })).data.totals).toMatchObject({ waiting: 2, strayed: 1 });
    // Finance approves as usual; the invoice is on the POS figure.
    const ok = await s.call("tony", "POST", `${s.base}/sales/${rep.ROWID}/approve`);
    expect(ok.data).toMatchObject({ status: "INVOICED", royalty_amount: 54_000 });
    // A rerun leaves the invoiced month alone and re-closes the open one.
    await s.job(() => s.feed("2026-08-20", "2026-10-10", 30_000), "2026-10-12T06:00:00Z");
    expect((await s.store.findOne("sales_reports", { ROWID: String(rep.ROWID) }))!.status).toBe("INVOICED");
    expect(s.invoices).toHaveLength(1);
  });

  it("approves and invoices once when the tenant allows it, the month is complete and within tolerance", async () => {
    const s = await setup({ settings: { royalty_basis: "POS", royalty_auto_approve: true, pos_variance_tolerance_pct: 5 } });
    await s.store.insert("franchisee_connections", { tenant_id: s.tid, franchisee_id: s.fr.ROWID, provider: "ZOHO_BOOKS", zoho_dc: "IN", org_id: "ORG-1", refresh_token: "RT", status: "ACTIVE", conn_key: `${s.tid}:${s.fr.ROWID}:ZOHO_BOOKS` });
    await s.call("pepper", "POST", `${s.base}/sales`, { period: "2026-09", gross_sales: 900_000, net_sales: 880_000 }); // 2.2% under: within tolerance
    const r = await s.job(() => s.feed("2026-08-20", "2026-10-10", 30_000));
    expect(r).toMatchObject({ closed: 2, approved: 2 });
    expect(s.invoices.map((i) => i.ref)).toEqual(["ROY-PROJ-1-202608", "ROY-PROJ-1-202609"]);
    const sep = await s.store.findOne("sales_reports", { period_key: `${s.tid}:${s.project.ROWID}:2026-09` });
    expect(sep).toMatchObject({ status: "INVOICED", basis: "POS", royalty_amount: 54_000, variance_pct: -2.2 });
    await s.job(() => s.feed("2026-08-20", "2026-10-10", 30_000), "2026-10-12T06:00:00Z");
    expect(s.invoices).toHaveLength(2);
  });

  it("never approves a month with a gap in the feed, or one beyond tolerance", async () => {
    const s = await setup({ settings: { royalty_basis: "POS", royalty_auto_approve: true } });
    await s.store.insert("franchisee_connections", { tenant_id: s.tid, franchisee_id: s.fr.ROWID, provider: "ZOHO_BOOKS", zoho_dc: "IN", org_id: "ORG-1", refresh_token: "RT", status: "ACTIVE", conn_key: `${s.tid}:${s.fr.ROWID}:ZOHO_BOOKS` });
    await s.call("pepper", "POST", `${s.base}/sales`, { period: "2026-08", gross_sales: 300_000, net_sales: 300_000 }); // 17% under the POS figure
    const r = await s.job(() => s.feed("2026-08-20", "2026-10-10", 30_000, { skip: ["2026-09-14"] }));
    expect(r).toMatchObject({ closed: 2, approved: 0 });
    expect(s.invoices).toHaveLength(0);
    const m = (await s.call("tony", "GET", `${s.base}/pos`, undefined, NOW, { period: "2026-09" })).data;
    expect(m.month).toMatchObject({ days: 29, days_expected: 30, gaps: ["2026-09-14"] });
    expect(await s.store.findOne("sales_reports", { period_key: `${s.tid}:${s.project.ROWID}:2026-08` })).toMatchObject({ status: "SUBMITTED", variance_pct: -16.7 });
  });

  it("keeps billing on the report when the basis is REPORTED, but shows the difference", async () => {
    const s = await setup();
    await s.store.insert("franchisee_connections", { tenant_id: s.tid, franchisee_id: s.fr.ROWID, provider: "ZOHO_BOOKS", zoho_dc: "IN", org_id: "ORG-1", refresh_token: "RT", status: "ACTIVE", conn_key: `${s.tid}:${s.fr.ROWID}:ZOHO_BOOKS` });
    await s.job(() => s.feed("2026-08-20", "2026-10-10", 30_000));
    const rep = (await s.call("pepper", "POST", `${s.base}/sales`, { period: "2026-09", gross_sales: 800_000, net_sales: 792_000 })).data;
    expect(rep).toMatchObject({ pos_net_sales: 900_000, variance_pct: -12, net_sales: 792_000 });
    expect(rep.basis ?? null).toBeNull();
    expect((await s.store.findMany("sales_reports", { tenant_id: s.tid })).length).toBe(1);
    const o = (await s.call("tony", "GET", "/dashboard/owner")).data;
    expect(o.revenue.pos.basis).toBe("REPORTED");
    expect(o.attention.items.filter((i: any) => i.kind === "POS")).toHaveLength(1);
    expect((await s.call("tony", "POST", `${s.base}/sales/${rep.ROWID}/approve`)).data).toMatchObject({ royalty_amount: 47_520 });
  });
});

describe("POS sales feed: uploads and settings", () => {
  it("checks a CSV row by row", () => {
    const b = { opened: "2026-08-20", today: "2026-10-11" };
    expect(parseSalesCsv("date,gross_sales,discounts,returns,tax,transactions\n2026-10-01,52400,1200,,2620,118\n02/10/2026,\"48,000\",,500,,\n", b)).toEqual([
      { day: "2026-10-01", gross_sales: 52_400, discounts: 1200, returns: 0, tax: 2620, transactions: 118 },
      { day: "2026-10-02", gross_sales: 48_000, discounts: 0, returns: 500, tax: 0, transactions: null },
    ]);
    const fields = (csv: string) => { try { parseSalesCsv(csv, b); return null; } catch (e: any) { return e.fields; } };
    expect(fields("day,amount\n1,2")).toEqual({ csv: "missing date, gross_sales" });
    expect(fields("date,gross_sales\n2026-10-11,1")).toEqual({ "line 2": "2026-10-11 has not finished yet" });
    expect(fields("date,gross_sales\n2026-08-01,1")).toEqual({ "line 2": "2026-08-01 is before the store opened" });
    expect(fields("date,gross_sales,returns\n2026-10-01,100,200")).toEqual({ "line 2": "discounts and returns are more than gross" });
    expect(fields("date,gross_sales\n2026-10-01,abc\n2026-10-02,5\n2026-10-02,6")).toEqual({ "line 2": "gross_sales is not a number", "line 4": "2026-10-02 appears twice" });
    expect(fields("date,gross_sales\n31/02/2026,5")).toEqual({ "line 2": "date must be YYYY-MM-DD or DD/MM/YYYY" });
  });

  it("takes the franchisee's upload, or finance's, and feeds the ledger from it", async () => {
    const s = await setup();
    const csv = "date,gross_sales,discounts,returns,tax,transactions\n" + Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")},31000,1000,0,1500,40`).join("\n");
    expect((await s.call("happy", "POST", `${s.base}/pos/upload`, { csv })).error?.code).toBe("NOT_FOUND");
    expect((await s.call("fin", "POST", `${s.base}/pos/upload`, { csv })).error?.code).toBe("ACCESS_DENIED");
    const up = await s.call("pepper", "POST", `${s.base}/pos/upload`, { csv });
    expect(up.data).toMatchObject({ inserted: 30, updated: 0, days: 30, from: "2026-09-01", to: "2026-09-30" });
    expect((await s.call("tony", "POST", `${s.base}/pos/upload`, { csv })).data).toMatchObject({ inserted: 0, updated: 30 });
    expect((await s.store.findMany("pos_sales", { tenant_id: s.tid }))[0]).toMatchObject({ source: "UPLOAD", net_sales: 30_000 });
    const l = (await s.call("pepper", "GET", `${s.base}/royalties`)).data;
    expect(l.feed).toMatchObject({ status: "STALE", last_day: "2026-09-30" });
    expect(l.months.find((m: any) => m.period === "2026-09").pos).toMatchObject({ net_sales: 900_000, days: 30, gaps: 0 });
    expect((await s.call("pepper", "GET", "/portal/connections")).data.stores[0]).toMatchObject({ feed: "STALE", last_day: "2026-09-30" });
  });

  it("lets settings.manage choose the basis, the tolerance and the due day", async () => {
    const s = await setup();
    expect((await s.call("fin", "GET", "/settings/royalties")).error?.code).toBe("ACCESS_DENIED");
    expect((await s.call("tony", "GET", "/settings/royalties")).data).toMatchObject({ royalty_basis: "REPORTED", pos_variance_tolerance_pct: 5, royalty_auto_approve: false, report_due_day: 7 });
    const put = await s.call("tony", "PUT", "/settings/royalties", { royalty_basis: "POS", pos_variance_tolerance_pct: 2, royalty_auto_approve: true, report_due_day: 5 });
    expect(put.data).toMatchObject({ royalty_basis: "POS", pos_variance_tolerance_pct: 2, royalty_auto_approve: true, report_due_day: 5 });
    expect((await s.call("tony", "GET", `${s.base}/royalties`)).data.feed).toMatchObject({ basis: "POS", tolerance_pct: 2 });
    expect((await s.call("tony", "PUT", "/settings/royalties", { royalty_basis: "BOTH", pos_variance_tolerance_pct: 2, royalty_auto_approve: true, report_due_day: 5 })).error?.code).toBe("VALIDATION_FAILED");
  });
});

describe("POS sales feed: health score", () => {
  it("judges a store on the feed by whether it is current and whether the report strayed", () => {
    expect(reportingScore({ due: 0, on_time: 0, late: 0, feed: { status: "CONNECTED", last_day: "2026-10-10", variance: [] } })).toBe(100);
    expect(reportingScore({ due: 3, on_time: 1, late: 2, feed: { status: "STALE", last_day: "2026-10-01", variance: [] } })).toBe(60);
    expect(reportingScore({ due: 3, on_time: 3, late: 0, feed: { status: "CONNECTED", last_day: "2026-10-10", variance: [{ period: "2026-09", pct: -12 }] } })).toBe(20);
    // A strayed report holds an otherwise healthy store at Watch, and is the first reason given.
    const inputs = { sales: { vs_plan_pct: 10, months: 3, months_under: 0 }, payments: { owed: 0, overdue: 0, oldest_days: 0, monthly_royalty: null }, compliance: null, customer: null, reporting: { due: 3, on_time: 3, late: 0, feed: { status: "CONNECTED" as const, last_day: "2026-10-10", variance: [{ period: "2026-09", pct: -12 }] } } };
    const r = scoreHealth(inputs);
    expect(r).toMatchObject({ band: "WATCH", capped: true });
    expect(r.reasons[0]).toMatchObject({ part: "reporting", text: "Sep 2026 sales under-reported by 12%" });
    // With the amounts, and the other way round when the report is the higher figure.
    const feed = (pct: number) => ({ due: 3, on_time: 3, late: 0, feed: { status: "CONNECTED" as const, last_day: "2026-10-10", variance: [{ period: "2026-09", pct, pos: 2_108_960, reported: 1_883_000 }] } });
    expect(scoreHealth({ ...inputs, reporting: feed(-10.7) }).reasons[0].text).toBe("Sep 2026 sales under-reported by 11% (POS ₹21.1 L, reported ₹18.8 L)");
    expect(scoreHealth({ ...inputs, reporting: feed(4) }).reasons[0].text).toBe("Sep 2026 report 4% above POS sales (POS ₹21.1 L, reported ₹18.8 L)");
  });

  it("reads the feed from the store's rows", async () => {
    const s = await setup();
    await s.store.update("franchise_projects", String(s.project.ROWID), { pos_last_day: "2026-10-10", pos_status: "CONNECTED" });
    await s.store.insert("sales_reports", { tenant_id: s.tid, project_id: s.project.ROWID, period: "2026-09", period_key: `${s.tid}:${s.project.ROWID}:2026-09`, status: "SUBMITTED", net_sales: 792_000, pos_net_sales: 900_000, variance_pct: -12 });
    const h = await computeNetworkHealth(s.store, { tenantId: s.tid }, "2026-10-11");
    expect(h.stores[0].inputs.reporting).toMatchObject({ feed: { status: "CONNECTED", last_day: "2026-10-10", variance: [{ period: "2026-09", pct: -12 }] } });
    expect(h.stores[0].parts.find((p) => p.part === "reporting")).toMatchObject({ score: 20 });
  });
});

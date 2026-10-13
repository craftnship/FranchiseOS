import { z } from "zod";
import { logActivity } from "../../common/audit";
import { AppError } from "../../common/errors";
import { authorize, isPortalUser } from "../../common/rbac";
import { Row } from "../../common/store";
import { toNumOrNull } from "../../common/values";
import { endpointsFor } from "../../integrations/zohoHttp";
import { BOOKS_READ_SCOPES, consentUrl, exchangeCode, signState, verifyState } from "../../integrations/zohoOAuth";
import { franchiseeBooks } from "../../integrations/tenantClients";
import { DEFAULT_APP_URL } from "../../workflows/notifications";
import { closeDueMonths, feedStatus, parseSalesCsv, POS_DEFAULTS, POS_PROVIDER, posMonth, posSettings, pullConnection, refreshFeedStatus, refreshVariance, upsertDays } from "../../workflows/posSales";
import { periodOf, prevPeriod, royaltySettings } from "../../workflows/royalties";
import { Call, parse, Router } from "../router";
import { assertOwner, mustGet, settings as settingsOf, staffCan } from "./shared";

// The POS sales feed (docs/pos-sales.md): a franchisee connects their own Zoho Books from the portal,
// the daily job pulls sales per day, or a store uploads a CSV; staff read the feed per store and set
// the royalty basis under Settings.

const FRANCHISEE_ROLES = ["FRANCHISEE", "FRANCHISEE_STAFF"];
const exchangeSchema = z.object({ code: z.string().trim().min(1).max(500), state: z.string().trim().min(1).max(2000) }).strict();
const orgSchema = z.object({ org_id: z.string().trim().min(1).max(50) }).strict();
const uploadSchema = z.object({ csv: z.string().min(1).max(200_000) }).strict();
const periodSchema = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "use YYYY-MM").optional() });
const pct = z.coerce.number().min(0).max(100);
const royaltySettingsSchema = z.object({
  royalty_basis: z.enum(["REPORTED", "POS"]), pos_variance_tolerance_pct: pct, royalty_auto_approve: z.boolean(),
  report_due_day: z.coerce.number().int().min(1).max(28),
}).strict();

const today = (call: Call) => call.now.toISOString().slice(0, 10);
const franchiseeOf = (call: Call): string => {
  if (!call.ctx.franchiseeId || !call.ctx.roles.some((r) => FRANCHISEE_ROLES.includes(r))) throw new AppError("ACCESS_DENIED", "Only the franchisee can manage the sales feed.");
  return String(call.ctx.franchiseeId);
};
/** A connection row as callers may see it: never the token. */
const connView = (c: Row) => ({
  ROWID: c.ROWID, provider: c.provider, status: c.status, org_id: c.org_id ?? null, org_name: c.org_name ?? null, scopes: c.scopes ?? null,
  connected_at: c.connected_at ?? null, last_pulled_at: c.last_pulled_at ?? null, last_error: c.last_error ?? null,
});
const storeView = (p: Row, day: string, s: ReturnType<typeof posSettings>) => ({
  ROWID: p.ROWID, project_code: p.project_code, status: p.status, feed: feedStatus(p, day, s), last_day: p.pos_last_day ? String(p.pos_last_day).slice(0, 10) : null, pos_location_id: p.pos_location_id ?? null,
});

/** Where Zoho sends the browser back: the web app itself, which hands code and state to the exchange route. */
async function redirectUri(call: Call): Promise<string> {
  if (call.oauth.redirectUri) return call.oauth.redirectUri;
  const s = settingsOf(await call.store.findOne("tenants", { ROWID: call.ctx.tenantId }));
  return String(s.app_url ?? process.env.FOS_APP_URL ?? DEFAULT_APP_URL);
}

function oauthReady(call: Call): { app: { clientId: string; clientSecret: string }; secret: string } {
  if (!call.oauth.app || !call.oauth.stateSecret) throw new AppError("ZOHO_SYNC_FAILED", "Connecting Zoho Books is not set up yet. Ask your franchisor to finish the Zoho setup (FOS_STATE_SECRET and the OAuth client).");
  return { app: call.oauth.app, secret: call.oauth.stateSecret };
}

const settingsView = (tenant: Row | null) => {
  const s = posSettings(tenant);
  return { ...s, report_due_day: royaltySettings(tenant).report_due_day, defaults: POS_DEFAULTS };
};

export function posRoutes(r: Router): void {
  // The franchisee's connection and each store's feed, for the portal home card.
  r.on("GET", "/portal/connections", "portal.view", async (call) => {
    const fid = franchiseeOf(call);
    const [conns, projects, tenant] = await Promise.all([
      call.repo.findMany("franchisee_connections", { franchisee_id: fid }, { orderBy: "ROWID", limit: 20 }),
      call.repo.findMany("franchise_projects", { franchisee_id: fid, status: "OPENED" }, { orderBy: "ROWID", limit: 100 }),
      call.store.findOne("tenants", { ROWID: call.ctx.tenantId }),
    ]);
    const s = posSettings(tenant);
    return {
      connections: conns.filter((c) => c.status !== "DISCONNECTED").map(connView),
      stores: projects.filter((p) => p.actual_opening_date).map((p) => storeView(p, today(call), s)),
      can_connect: !!(call.oauth.app && call.oauth.stateSecret), basis: s.royalty_basis,
    };
  });

  // Step 1: the Zoho consent page, with a signed state that can only come back to this franchisee.
  r.on("POST", "/portal/connections/zoho/start", "portal.view", async (call) => {
    const fid = franchiseeOf(call);
    const { app, secret } = oauthReady(call);
    const state = signState(secret, { tenant_id: call.ctx.tenantId, franchisee_id: fid, user_id: call.ctx.userId }, call.now.getTime());
    return { url: consentUrl(endpointsFor(call.ctx.zohoDc || "IN"), app.clientId, await redirectUri(call), state), scopes: BOOKS_READ_SCOPES };
  });

  // Step 2: back from Zoho. The code becomes a refresh token; the organisations it can see decide the rest.
  r.on("POST", "/portal/connections/zoho/exchange", "portal.view", async (call) => {
    const fid = franchiseeOf(call);
    const { app, secret } = oauthReady(call);
    const b = parse(exchangeSchema, call.body);
    const st = verifyState(secret, b.state, call.now.getTime());
    if (!st || st.tenant_id !== call.ctx.tenantId || st.franchisee_id !== fid) throw new AppError("ACCESS_DENIED", "This connection link is not yours or has expired. Start again from the portal home.");
    const dc = call.ctx.zohoDc || "IN";
    const fetchFn = call.oauth.fetchFn ?? (globalThis.fetch as unknown as NonNullable<typeof call.oauth.fetchFn>);
    const { refreshToken } = await exchangeCode(fetchFn, endpointsFor(dc), app, await redirectUri(call), b.code);
    const probe = franchiseeBooks(app, { refresh_token: refreshToken, org_id: "-", zoho_dc: dc }, call.oauth.fetchFn);
    const orgs = probe?.listOrganizations ? await probe.listOrganizations() : [];
    if (!orgs.length) throw new AppError("ZOHO_SYNC_FAILED", "That Zoho account has no Books organisation. Sign in to the account that runs the store's books.");
    const one = orgs.length === 1 ? orgs[0] : null;
    const key = `${call.ctx.tenantId}:${fid}:${POS_PROVIDER}`;
    const fields: Row = {
      zoho_dc: dc, org_id: one?.id ?? null, org_name: one?.name ?? null, refresh_token: refreshToken, scopes: BOOKS_READ_SCOPES.join(","),
      status: one ? "ACTIVE" : "PENDING", connected_by: call.ctx.userId, connected_at: call.now.toISOString(), last_pulled_at: null, last_error: null,
    };
    const existing = await call.repo.findOne("franchisee_connections", { conn_key: key });
    const row = existing ? await call.repo.update("franchisee_connections", String(existing.ROWID), fields) : await call.repo.insert("franchisee_connections", { ...fields, franchisee_id: fid, provider: POS_PROVIDER, conn_key: key });
    await logActivity(call.store, call.ctx, { entityType: "franchisee", entityId: fid, action: "pos:connected", metadata: { connection_id: String(row.ROWID), org_id: one?.id ?? null, organisations: orgs.length, reconnected: !!existing } });
    return { connection: connView(row), organizations: orgs, choose: !one };
  });

  // A token that sees several organisations: the franchisee says which one is the store's.
  r.on("POST", "/portal/connections/:id/organization", "portal.view", async (call) => {
    const fid = franchiseeOf(call);
    const conn = await mustGet(call.repo, "franchisee_connections", call.params.id, "NOT_FOUND");
    if (String(conn.franchisee_id) !== fid || conn.status === "DISCONNECTED") throw new AppError("NOT_FOUND");
    const b = parse(orgSchema, call.body);
    const { app } = oauthReady(call);
    const probe = franchiseeBooks(app, { ...conn, org_id: "-" }, call.oauth.fetchFn);
    const orgs = probe?.listOrganizations ? await probe.listOrganizations() : [];
    const org = orgs.find((o) => o.id === b.org_id);
    if (!org) throw new AppError("VALIDATION_FAILED", "Pick one of the organisations the connected account can see.", { org_id: "unknown organisation" });
    const row = await call.repo.update("franchisee_connections", String(conn.ROWID), { org_id: org.id, org_name: org.name, status: "ACTIVE", last_error: null });
    await logActivity(call.store, call.ctx, { entityType: "franchisee", entityId: fid, action: "pos:organisation_chosen", metadata: { connection_id: String(row.ROWID), org_id: org.id } });
    return { connection: connView(row) };
  });

  r.on("DELETE", "/portal/connections/:id", "portal.view", async (call) => {
    const fid = franchiseeOf(call);
    const conn = await mustGet(call.repo, "franchisee_connections", call.params.id, "NOT_FOUND");
    if (String(conn.franchisee_id) !== fid) throw new AppError("NOT_FOUND");
    // The token goes; the days already pulled stay, since royalty was billed on them.
    const row = await call.repo.update("franchisee_connections", String(conn.ROWID), { status: "DISCONNECTED", refresh_token: null, last_error: null });
    await logActivity(call.store, call.ctx, { entityType: "franchisee", entityId: fid, action: "pos:disconnected", metadata: { connection_id: String(row.ROWID), org_id: conn.org_id ?? null } });
    return { connection: connView(row) };
  });

  // Pulls this franchisee's connection now (after connecting, or when a day looks wrong).
  r.on("POST", "/portal/connections/:id/pull", "portal.view", async (call) => {
    const fid = franchiseeOf(call);
    const conn = await mustGet(call.repo, "franchisee_connections", call.params.id, "NOT_FOUND");
    if (String(conn.franchisee_id) !== fid || conn.status !== "ACTIVE" && conn.status !== "FAILING") throw new AppError("NOT_FOUND");
    const { app } = oauthReady(call);
    const books = franchiseeBooks(app, conn, call.oauth.fetchFn);
    if (!books) throw new AppError("ZOHO_SYNC_FAILED", "The connection has no organisation yet.");
    const r = await pullConnection(call.store, call.ctx, conn, books, { today: today(call), now: call.now });
    if (!r.ok) throw new AppError("ZOHO_SYNC_FAILED", r.error ?? "The pull failed.");
    await refreshFeedStatus(call.repo, today(call), posSettings(await call.store.findOne("tenants", { ROWID: call.ctx.tenantId })));
    await refreshVariance(call.store, call.ctx, today(call));
    return r;
  });

  // One store's feed for a month: the days, the gaps and what the franchisee reported. The store's own franchisee, or staff.
  r.on("GET", "/projects/:id/pos", null, async (call) => {
    const project = await assertOwner(call, await mustGet(call.repo, "franchise_projects", call.params.id, "NOT_FOUND"), "NOT_FOUND");
    await staffCan(call, "dashboard.view", "royalty.manage");
    const q = parse(periodSchema, call.query);
    const day = today(call);
    const period = q.period ?? prevPeriod(periodOf(day));
    const [tenant, conn] = await Promise.all([
      call.store.findOne("tenants", { ROWID: call.ctx.tenantId }),
      project.franchisee_id ? call.repo.findOne("franchisee_connections", { conn_key: `${call.ctx.tenantId}:${project.franchisee_id}:${POS_PROVIDER}` }) : null,
    ]);
    const s = posSettings(tenant);
    const month = await posMonth(call.repo, project, period, day);
    const report = await call.repo.findOne("sales_reports", { period_key: `${call.ctx.tenantId}:${project.ROWID}:${period}` });
    const { rows, ...summary } = month;
    return {
      store: storeView(project, day, s), connection: conn && conn.status !== "DISCONNECTED" ? connView(conn) : null, basis: s.royalty_basis, tolerance_pct: s.pos_variance_tolerance_pct,
      period, month: summary, days: rows.map((x) => ({ day: String(x.day).slice(0, 10), gross_sales: toNumOrNull(x.gross_sales), discounts: toNumOrNull(x.discounts), returns: toNumOrNull(x.returns), net_sales: toNumOrNull(x.net_sales), tax: toNumOrNull(x.tax), transactions: toNumOrNull(x.transactions), source: x.source })),
      report: report ? { ROWID: report.ROWID, status: report.status, basis: report.basis ?? "REPORTED", net_sales: toNumOrNull(report.net_sales), reported_net_sales: toNumOrNull(report.reported_net_sales), pos_net_sales: toNumOrNull(report.pos_net_sales), variance_pct: toNumOrNull(report.variance_pct) } : null,
    };
  });

  // Daily sales as a CSV, for tills that do not post to Books: the franchisee, or staff with royalty.manage.
  r.on("POST", "/projects/:id/pos/upload", null, async (call) => {
    const project = await assertOwner(call, await mustGet(call.repo, "franchise_projects", call.params.id, "NOT_FOUND"), "NOT_FOUND");
    if (isPortalUser(call.ctx)) { if (!call.ctx.roles.some((x) => FRANCHISEE_ROLES.includes(x))) throw new AppError("ACCESS_DENIED", "Only the franchisee uploads sales."); }
    else await authorize(call.ctx, "royalty.manage", call.permissions);
    if (project.status !== "OPENED" || !project.actual_opening_date) throw new AppError("INVALID_TRANSITION", "Daily sales start once the store has opened.");
    const b = parse(uploadSchema, call.body);
    const days = parseSalesCsv(b.csv, { opened: String(project.actual_opening_date).slice(0, 10), today: today(call) });
    const r = await upsertDays(call.store, call.ctx, project, days, "UPLOAD", call.now);
    await refreshVariance(call.store, call.ctx, today(call));
    await logActivity(call.store, call.ctx, { entityType: "project", entityId: String(project.ROWID), action: "pos:uploaded", metadata: { ...r, days: days.length, by: isPortalUser(call.ctx) ? "PORTAL" : "STAFF" } });
    return { ...r, days: days.length };
  }, 201);

  // Runs the tenant's pull and month close now.
  r.on("POST", "/admin/pos/pull", "integration.admin", async (call) => {
    const day = today(call);
    const out = { connections: 0, pulled: 0, failed: 0, closed: 0, approved: 0, stale: 0 };
    const app = call.oauth.app;
    const conns = (await Promise.all(["ACTIVE", "FAILING"].map((status) => call.repo.findMany("franchisee_connections", { provider: POS_PROVIDER, status }, { orderBy: "ROWID", limit: 1000 })))).flat();
    for (const conn of conns) {
      out.connections++;
      const books = app ? franchiseeBooks(app, conn, call.oauth.fetchFn) : null;
      if (!books) { out.failed++; continue; }
      const r = await pullConnection(call.store, call.ctx, conn, books, { today: day, now: call.now });
      if (r.ok) out.pulled += r.days; else out.failed++;
    }
    out.stale = await refreshFeedStatus(call.repo, day, posSettings(await call.store.findOne("tenants", { ROWID: call.ctx.tenantId })));
    await refreshVariance(call.store, call.ctx, day);
    const c = await closeDueMonths(call.store, call.ctx, { today: day, now: call.now, books: (await call.zoho().catch(() => null))?.books ?? null });
    out.closed = c.closed; out.approved = c.approved;
    await logActivity(call.store, call.ctx, { entityType: "tenant", entityId: call.ctx.tenantId, action: "pos:pulled", metadata: { ...out } });
    return out;
  });

  r.on("GET", "/settings/royalties", "settings.manage", async (call) => settingsView(await call.store.findOne("tenants", { ROWID: call.ctx.tenantId })));

  r.on("PUT", "/settings/royalties", "settings.manage", async (call) => {
    const b = parse(royaltySettingsSchema, call.body);
    const tenant = await call.store.findOne("tenants", { ROWID: call.ctx.tenantId });
    if (!tenant) throw new AppError("TENANT_NOT_FOUND");
    const s = settingsOf(tenant);
    Object.assign(s, { royalty_basis: b.royalty_basis, pos_variance_tolerance_pct: b.pos_variance_tolerance_pct, royalty_auto_approve: b.royalty_auto_approve, sales_report_due_day: b.report_due_day });
    await call.store.update("tenants", call.ctx.tenantId, { settings_json: JSON.stringify(s) });
    await logActivity(call.store, call.ctx, { entityType: "tenant", entityId: call.ctx.tenantId, action: "settings:royalties", metadata: { ...b } });
    return settingsView(await call.store.findOne("tenants", { ROWID: call.ctx.tenantId }));
  });
}

import { logActivity } from "../common/audit";
import { Mailer, TenantContext } from "../common/context";
import { AppError } from "../common/errors";
import { log } from "../common/logger";
import { DuplicateKeyError, Row, Store, TenantRepo } from "../common/store";
import { round, toNum, toNumOrNull } from "../common/values";
import { ZohoBooksClient } from "../integrations/clients";
import { ZohoClients } from "../integrations/tenantClients";
import { addDays } from "./launch";
import { deliver } from "./notifications";
import { approveReport, duePeriods, nextPeriod, periodLabel, periodOf, royaltySettings } from "./royalties";

// POS sales feed (docs/pos-sales.md): each store's daily sales from the franchisee's own Zoho Books,
// or a CSV upload, into pos_sales; the month closed from those rows so royalty is billed on what the
// till recorded, with the franchisee's own figure kept beside it as the variance.

export const POS_PROVIDER = "ZOHO_BOOKS";
export type RoyaltyBasis = "REPORTED" | "POS";
export type FeedStatus = "CONNECTED" | "STALE" | "NONE";
const PULL_DAYS = 3, FIRST_PULL_DAYS = 90;
const round2 = (n: number) => Math.round(n * 100) / 100;
const dayOf = (v: unknown) => (v ? String(v).slice(0, 10) : null);

export interface PosSettings { royalty_basis: RoyaltyBasis; pos_variance_tolerance_pct: number; royalty_auto_approve: boolean; pos_stale_days: number }
export const POS_DEFAULTS: PosSettings = { royalty_basis: "REPORTED", pos_variance_tolerance_pct: 5, royalty_auto_approve: false, pos_stale_days: 2 };

export function posSettings(tenant: Row | null): PosSettings {
  let s: Record<string, unknown> = {};
  try { s = tenant?.settings_json ? JSON.parse(String(tenant.settings_json)) : {}; } catch { s = {}; }
  const num = (v: unknown, d: number) => (v == null || v === "" || !Number.isFinite(Number(v)) || Number(v) < 0 ? d : Number(v));
  return {
    royalty_basis: s.royalty_basis === "POS" ? "POS" : "REPORTED",
    pos_variance_tolerance_pct: num(s.pos_variance_tolerance_pct, POS_DEFAULTS.pos_variance_tolerance_pct),
    royalty_auto_approve: s.royalty_auto_approve === true || s.royalty_auto_approve === "true",
    pos_stale_days: Math.max(1, Math.round(num(s.pos_stale_days, POS_DEFAULTS.pos_stale_days))),
  };
}

/** Whether a store's feed is current, judged from the last day it has rows for. */
export function feedStatus(project: Row, today: string, settings: PosSettings = POS_DEFAULTS): FeedStatus {
  const last = dayOf(project.pos_last_day);
  if (!last) return "NONE";
  return last < addDays(today, -settings.pos_stale_days) ? "STALE" : "CONNECTED";
}

export interface PosDayInput { day: string; gross_sales: number; discounts?: number; returns?: number; tax?: number; transactions?: number | null }
export interface UpsertResult { inserted: number; updated: number; from: string | null; to: string | null }

/** Writes one row per day (by day_key, so a rerun corrects instead of duplicating) and moves the store's last day forward. */
export async function upsertDays(store: Store, ctx: Pick<TenantContext, "tenantId">, project: Row, days: PosDayInput[], source: "BOOKS" | "UPLOAD", now: Date): Promise<UpsertResult> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const pid = String(project.ROWID);
  const out: UpsertResult = { inserted: 0, updated: 0, from: null, to: null };
  for (const d of days) {
    const gross = round2(toNum(d.gross_sales)), discounts = round2(toNum(d.discounts)), returns = round2(toNum(d.returns));
    const fields: Row = {
      day: d.day, gross_sales: gross, discounts, returns, net_sales: round2(gross - discounts - returns), tax: round2(toNum(d.tax)),
      transactions: d.transactions == null ? null : Math.round(toNum(d.transactions)), source, pulled_at: now.toISOString(),
    };
    const key = `${ctx.tenantId}:${pid}:${d.day}`;
    const existing = await repo.findOne("pos_sales", { day_key: key });
    if (existing) { await repo.update("pos_sales", String(existing.ROWID), fields); out.updated++; }
    else {
      try { await repo.insert("pos_sales", { ...fields, project_id: pid, franchisee_id: project.franchisee_id ?? null, day_key: key }); out.inserted++; }
      catch (e) {
        if (!(e instanceof DuplicateKeyError)) throw e;
        const again = await repo.findOne("pos_sales", { day_key: key });
        if (again) { await repo.update("pos_sales", String(again.ROWID), fields); out.updated++; }
      }
    }
    out.from = out.from && out.from < d.day ? out.from : d.day;
    out.to = out.to && out.to > d.day ? out.to : d.day;
  }
  if (out.to) {
    const last = dayOf(project.pos_last_day);
    await repo.update("franchise_projects", pid, { pos_last_day: last && last > out.to ? last : out.to, pos_status: "CONNECTED" });
  }
  return out;
}

export interface PosMonth {
  period: string; net_sales: number; gross_sales: number; discounts: number; returns: number; tax: number; transactions: number;
  days: number; days_expected: number; gaps: string[]; first_day: string | null; last_day: string | null; rows: Row[];
}

/** One store's till rows for a month, with the days the month should have had (from the opening day to yesterday) that are missing. */
export async function posMonth(repo: TenantRepo, project: Row, period: string, today: string): Promise<PosMonth> {
  const from = `${period}-01`, before = `${nextPeriod(period)}-01`;
  const rows = await repo.findMany("pos_sales", { project_id: String(project.ROWID) }, { range: { column: "day", from, before }, orderBy: "day", limit: 40 });
  const have = new Set(rows.map((r) => dayOf(r.day)!));
  const opened = dayOf(project.actual_opening_date);
  const start = opened && opened > from ? opened : from;
  const end = addDays(before, -1) < today ? addDays(before, -1) : addDays(today, -1);
  const gaps: string[] = [];
  let expected = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) { expected++; if (!have.has(d)) gaps.push(d); }
  const sum = (k: string) => round2(rows.reduce((a, r) => a + toNum(r[k]), 0));
  return {
    period, net_sales: sum("net_sales"), gross_sales: sum("gross_sales"), discounts: sum("discounts"), returns: sum("returns"), tax: sum("tax"), transactions: rows.reduce((a, r) => a + toNum(r.transactions), 0),
    days: rows.length, days_expected: expected, gaps, first_day: dayOf(rows[0]?.day), last_day: dayOf(rows.at(-1)?.day), rows,
  };
}

/** The franchisee's figure against the till's, as a percentage of the till: −12 means they reported 12% less. */
export const variancePct = (reported: number | null, pos: number): number | null => (reported === null || pos <= 0 ? null : round((reported / pos - 1) * 100, 1));

export interface CloseResult { action: "no_feed" | "invoiced_already" | "closed" | "approved"; report?: Row; variance_pct?: number | null; gaps?: number }

/**
 * Closes a month from the till: writes or updates the month's sales report on the POS basis, keeps
 * the franchisee's own figure as the variance, and approves it when the tenant allows that and the
 * month is complete and within tolerance. Otherwise finance approves it as usual.
 */
export async function closeMonthFromPos(store: Store, ctx: TenantContext, project: Row, period: string, opts: { today: string; now: Date; books: ZohoBooksClient | null; settings: PosSettings }): Promise<CloseResult> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const month = await posMonth(repo, project, period, opts.today);
  if (!month.days) return { action: "no_feed" };
  const key = `${ctx.tenantId}:${project.ROWID}:${period}`;
  const existing = await repo.findOne("sales_reports", { period_key: key });
  if (existing && (existing.status === "INVOICED" || existing.status === "PAID")) return { action: "invoiced_already", report: existing };
  // The franchisee's own number: what they typed in, kept from an earlier close when the row is already on the POS basis.
  const reported = existing ? (existing.basis === "POS" ? toNumOrNull(existing.reported_net_sales) : toNumOrNull(existing.net_sales)) : null;
  const variance = variancePct(reported, month.net_sales);
  const fields: Row = {
    basis: "POS", source: "POS", gross_sales: month.gross_sales, net_sales: month.net_sales, transactions: month.transactions || null,
    pos_net_sales: month.net_sales, reported_net_sales: reported, variance_pct: variance,
    status: "SUBMITTED", submitted_by: ctx.userId, submitted_at: opts.now.toISOString(), review_note: null,
  };
  let report: Row;
  if (existing) report = await repo.update("sales_reports", String(existing.ROWID), fields);
  else {
    try { report = await repo.insert("sales_reports", { ...fields, project_id: String(project.ROWID), franchisee_id: project.franchisee_id ?? null, period, period_key: key }); }
    catch (e) {
      if (!(e instanceof DuplicateKeyError)) throw e;
      const again = await repo.findOne("sales_reports", { period_key: key });
      if (!again || again.status === "INVOICED" || again.status === "PAID") return { action: "invoiced_already", report: again ?? undefined };
      report = await repo.update("sales_reports", String(again.ROWID), fields);
    }
  }
  await logActivity(store, ctx, {
    entityType: "sales_report", entityId: String(report.ROWID), action: "royalty:closed_from_pos",
    metadata: { project_id: String(project.ROWID), period, pos_net_sales: month.net_sales, reported_net_sales: reported, variance_pct: variance, days: month.days, gaps: month.gaps.length },
  });
  const within = variance === null || Math.abs(variance) <= opts.settings.pos_variance_tolerance_pct;
  if (opts.settings.royalty_auto_approve && within && !month.gaps.length && opts.books) {
    try {
      const approved = await approveReport(store, ctx, opts.books, project, report, opts.now);
      return { action: "approved", report: approved, variance_pct: variance, gaps: 0 };
    } catch (e) {
      // Finance picks it up from the Royalties screen; the report stays submitted.
      log("warn", "pos.auto_approve_failed", { tenant_id: ctx.tenantId, request_id: ctx.requestId, report_id: String(report.ROWID), error: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  }
  return { action: "closed", report, variance_pct: variance, gaps: month.gaps.length };
}

/** Months the job should close for a store today: due months of the last three whose report is not yet invoiced. */
export function periodsToClose(project: Row, today: string, dueDay: number): string[] {
  return duePeriods(project, today).slice(-3).filter((p) => `${nextPeriod(p)}-${String(dueDay).padStart(2, "0")}` <= today);
}

export interface PullResult { connection_id: string; ok: boolean; stores: number; days: number; error?: string }

/** The stores a connection feeds: every opened store of its franchisee, each with its Books location when it has one. */
async function storesOf(repo: TenantRepo, conn: Row): Promise<Row[]> {
  return (await repo.findMany("franchise_projects", { franchisee_id: String(conn.franchisee_id), status: "OPENED" }, { orderBy: "ROWID", limit: 100 })).filter((p) => p.actual_opening_date);
}

/**
 * Pulls one connection: the last three days, or ninety on the first pull or when a store fell
 * behind. A franchisee with one store gets the whole organisation; with several, each store needs
 * its Books location (pos_location_id) or it is left without a feed.
 */
export async function pullConnection(store: Store, ctx: TenantContext, conn: Row, books: ZohoBooksClient, opts: { today: string; now: Date }): Promise<PullResult> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const out: PullResult = { connection_id: String(conn.ROWID), ok: true, stores: 0, days: 0 };
  const stores = await storesOf(repo, conn);
  const notes: string[] = [];
  try {
    if (!books.dailySales) throw new AppError("ZOHO_SYNC_FAILED", "Books client cannot list daily sales.");
    for (const p of stores) {
      if (stores.length > 1 && !p.pos_location_id) { notes.push(`${p.project_code}: set its Zoho Books location to tell its sales apart`); continue; }
      const last = dayOf(p.pos_last_day);
      const behind = !conn.last_pulled_at || !last || last < addDays(opts.today, -PULL_DAYS);
      const from = addDays(opts.today, -(behind ? FIRST_PULL_DAYS : PULL_DAYS));
      const opened = dayOf(p.actual_opening_date)!;
      const days = await books.dailySales(from > opened ? from : opened, opts.today, p.pos_location_id ? String(p.pos_location_id) : null);
      const r = await upsertDays(store, ctx, p, days, "BOOKS", opts.now);
      out.stores++; out.days += r.inserted + r.updated;
    }
    const patch: Row = { last_pulled_at: opts.now.toISOString(), last_error: notes.length ? notes.join("; ") : null };
    if (conn.status === "FAILING") patch.status = "ACTIVE";
    await repo.update("franchisee_connections", String(conn.ROWID), patch);
  } catch (e) {
    const error = String((e as Error)?.message ?? e).slice(0, 300);
    out.ok = false; out.error = error;
    await repo.update("franchisee_connections", String(conn.ROWID), { status: "FAILING", last_error: error });
    log("warn", "pos.pull_failed", { tenant_id: ctx.tenantId, request_id: ctx.requestId, connection_id: String(conn.ROWID), error });
    // Tell the franchisee once per failure, not every night; the brand's franchise manager too.
    if (conn.status !== "FAILING") {
      const owners = (await store.findMany("users", { tenant_id: ctx.tenantId, franchisee_id: String(conn.franchisee_id), status: "ACTIVE" })).map((u) => String(u.ROWID));
      await deliver(store, ctx, {
        kind: "pos.connection_failed", entityType: "franchisee", entityId: String(conn.franchisee_id), userIds: owners, roles: ["FRANCHISE_MANAGER"],
        title: `Zoho Books sales feed stopped${conn.org_name ? ` for ${conn.org_name}` : ""}`,
        body: `${error.split("\n")[0].slice(0, 160)} Reconnect Zoho Books from the portal home so royalty keeps using till sales.`,
        link: "/portal", dedupe: `pos:failed:${conn.ROWID}:${opts.today}`,
      }, opts.now);
    }
  }
  return out;
}

export interface PosJobResult { tenants: number; connections: number; pulled: number; stores_stale: number; closed: number; approved: number; failed: number }

/** Refreshes every opened store's feed status from its last day; returns how many are stale. */
export async function refreshFeedStatus(repo: TenantRepo, today: string, settings: PosSettings): Promise<number> {
  let stale = 0;
  for (const p of await repo.findMany("franchise_projects", { status: "OPENED" }, { orderBy: "ROWID", limit: 10_000 })) {
    const status = feedStatus(p, today, settings);
    if (status === "STALE") stale++;
    if ((p.pos_status ?? "NONE") !== status) await repo.update("franchise_projects", String(p.ROWID), { pos_status: status });
  }
  return stale;
}

/** Closes due months from the till for every opened store with a feed, when the tenant bills on POS. */
export async function closeDueMonths(store: Store, ctx: TenantContext, opts: { today: string; now: Date; books: ZohoBooksClient | null }): Promise<{ closed: number; approved: number }> {
  const repo = new TenantRepo(store, ctx.tenantId);
  const tenant = await store.findOne("tenants", { ROWID: ctx.tenantId });
  const settings = posSettings(tenant);
  const out = { closed: 0, approved: 0 };
  if (settings.royalty_basis !== "POS") return out;
  const dueDay = royaltySettings(tenant).report_due_day;
  for (const p of await repo.findMany("franchise_projects", { status: "OPENED" }, { orderBy: "ROWID", limit: 10_000 })) {
    if (!p.pos_last_day) continue;
    for (const period of periodsToClose(p, opts.today, dueDay)) {
      const r = await closeMonthFromPos(store, ctx, p, period, { ...opts, settings });
      if (r.action === "closed") out.closed++;
      if (r.action === "approved") { out.closed++; out.approved++; }
    }
  }
  return out;
}

export type BooksForConnection = (conn: Row) => ZohoBooksClient | null;

/** The daily job step: pull every active connection, refresh feed statuses, close due months. */
export async function runPosSalesJob(store: Store, booksFor: BooksForConnection, zoho: (tenantId: string) => Promise<ZohoClients | null>, opts: { today: string; now: Date; requestId: string; mailer?: Mailer }): Promise<PosJobResult> {
  const out: PosJobResult = { tenants: 0, connections: 0, pulled: 0, stores_stale: 0, closed: 0, approved: 0, failed: 0 };
  for (const tenant of await store.findMany("tenants", { status: "ACTIVE" })) {
    out.tenants++;
    const tenantId = String(tenant.ROWID);
    const ctx: TenantContext = { tenantId, userId: "SYSTEM:job", roles: ["SYSTEM"], zohoDc: String(tenant.zoho_dc), requestId: opts.requestId, correlationId: opts.requestId, mailer: opts.mailer };
    const repo = new TenantRepo(store, tenantId);
    try {
      // Both lists first, so a connection that fails during this run is not tried twice.
      const conns = (await Promise.all(["ACTIVE", "FAILING"].map((status) => repo.findMany("franchisee_connections", { provider: POS_PROVIDER, status }, { orderBy: "ROWID", limit: 10_000 })))).flat();
      for (const conn of conns) {
        out.connections++;
        const books = booksFor(conn);
        if (!books) { out.failed++; log("warn", "pos.no_client", { tenant_id: tenantId, request_id: opts.requestId, connection_id: String(conn.ROWID) }); continue; }
        const r = await pullConnection(store, ctx, conn, books, opts);
        if (r.ok) out.pulled += r.days; else out.failed++;
      }
      out.stores_stale += await refreshFeedStatus(repo, opts.today, posSettings(tenant));
      await refreshVariance(store, ctx, opts.today);
      const books = (await zoho(tenantId).catch(() => null))?.books ?? null;
      const c = await closeDueMonths(store, ctx, { today: opts.today, now: opts.now, books });
      out.closed += c.closed; out.approved += c.approved;
    } catch (e) {
      out.failed++;
      log("warn", "job.pos_sales_failed", { tenant_id: tenantId, request_id: opts.requestId, error: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  }
  log("info", "job.pos_sales", { request_id: opts.requestId, ...out });
  return out;
}

// ---- CSV upload -------------------------------------------------------------------------------

const CSV_COLUMNS = ["date", "gross_sales", "discounts", "returns", "tax", "transactions"];
const MAX_CSV_ROWS = 400;

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** "2026-10-12", "12/10/2026" or "12-10-2026" as an ISO day, or null. */
export function parseDay(s: string): string | null {
  const t = s.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) { const d = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t); if (d) m = [t, d[3], d[2].padStart(2, "0"), d[1].padStart(2, "0")] as unknown as RegExpExecArray; }
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) || new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) !== iso ? null : iso;
}

/**
 * A daily-sales CSV (date, gross_sales, discounts, returns, tax, transactions; the last four may be
 * blank) checked row by row. Problems name the line, so the franchisee can fix the file.
 */
export function parseSalesCsv(text: string, bounds: { opened: string | null; today: string }): PosDayInput[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new AppError("VALIDATION_FAILED", "The file is empty.", { csv: "empty" });
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z_]/g, (c) => (c === " " ? "_" : "")));
  const col = (name: string) => header.indexOf(name);
  const missing = ["date", "gross_sales"].filter((c) => col(c) < 0);
  if (missing.length) throw new AppError("VALIDATION_FAILED", `The first row must name the columns: ${CSV_COLUMNS.join(", ")}.`, { csv: `missing ${missing.join(", ")}` });
  if (lines.length - 1 > MAX_CSV_ROWS) throw new AppError("VALIDATION_FAILED", `Upload up to ${MAX_CSV_ROWS} days at a time.`, { csv: "too many rows" });
  const problems: Record<string, string> = {};
  const out = new Map<string, PosDayInput>();
  const num = (cells: string[], name: string, line: number, required = false): number | undefined => {
    const i = col(name);
    const raw = i < 0 ? "" : cells[i] ?? "";
    const v = raw.replace(/[₹,\s]/g, "");
    if (v === "") { if (required) problems[`line ${line}`] = `${name} is missing`; return undefined; }
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) { problems[`line ${line}`] = `${name} is not a number`; return undefined; }
    return n;
  };
  lines.slice(1).forEach((raw, i) => {
    const line = i + 2, cells = splitCsvLine(raw);
    const day = parseDay(cells[col("date")] ?? "");
    if (!day) { problems[`line ${line}`] = "date must be YYYY-MM-DD or DD/MM/YYYY"; return; }
    if (day >= bounds.today) { problems[`line ${line}`] = `${day} has not finished yet`; return; }
    if (bounds.opened && day < bounds.opened) { problems[`line ${line}`] = `${day} is before the store opened`; return; }
    const gross = num(cells, "gross_sales", line, true);
    const discounts = num(cells, "discounts", line) ?? 0, returns = num(cells, "returns", line) ?? 0, tax = num(cells, "tax", line) ?? 0, transactions = num(cells, "transactions", line);
    if (gross === undefined) return;
    if (discounts + returns > gross) { problems[`line ${line}`] = "discounts and returns are more than gross"; return; }
    if (out.has(day)) { problems[`line ${line}`] = `${day} appears twice`; return; }
    out.set(day, { day, gross_sales: gross, discounts, returns, tax, transactions: transactions === undefined ? null : Math.round(transactions) });
  });
  const keys = Object.keys(problems);
  if (keys.length) throw new AppError("VALIDATION_FAILED", `${keys.length} line${keys.length === 1 ? "" : "s"} need fixing; the first is ${keys[0]}: ${problems[keys[0]]}.`, Object.fromEntries(keys.slice(0, 20).map((k) => [k, problems[k]])));
  return [...out.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** The till's months for a store's ledger: one read over the whole span, summed per month, with variance against the report. */
export async function posByPeriod(repo: TenantRepo, project: Row, periods: string[], today: string): Promise<Map<string, { net_sales: number; days: number; gaps: number; last_day: string | null }>> {
  const out = new Map<string, { net_sales: number; days: number; gaps: number; last_day: string | null }>();
  if (!periods.length) return out;
  const sorted = [...periods].sort();
  const rows = await repo.findMany("pos_sales", { project_id: String(project.ROWID) }, { range: { column: "day", from: `${sorted[0]}-01`, before: `${nextPeriod(sorted.at(-1)!)}-01` }, orderBy: "day", limit: 10_000 });
  const opened = dayOf(project.actual_opening_date);
  for (const period of sorted) {
    const mine = rows.filter((r) => periodOf(String(r.day)) === period);
    if (!mine.length) continue;
    const from = `${period}-01`, before = `${nextPeriod(period)}-01`;
    const start = opened && opened > from ? opened : from;
    const end = addDays(before, -1) < today ? addDays(before, -1) : addDays(today, -1);
    let expected = 0;
    for (let d = start; d <= end; d = addDays(d, 1)) expected++;
    out.set(period, { net_sales: round2(mine.reduce((a, r) => a + toNum(r.net_sales), 0)), days: mine.length, gaps: Math.max(0, expected - mine.length), last_day: dayOf(mine.at(-1)!.day) });
  }
  return out;
}

/**
 * Puts the till's figure and the variance on a franchisee's report, so the Royalties screen and the
 * attention list can show it without reading the days again. Reports already on the POS basis keep theirs.
 */
export async function attachVariance(store: Store, ctx: Pick<TenantContext, "tenantId">, project: Row, report: Row, today: string): Promise<Row> {
  if (report.basis === "POS") return report;
  const repo = new TenantRepo(store, ctx.tenantId);
  const t = (await posByPeriod(repo, project, [String(report.period)], today)).get(String(report.period));
  if (!t) return report;
  const variance = variancePct(toNum(report.net_sales), t.net_sales);
  if (toNumOrNull(report.pos_net_sales) === t.net_sales && toNumOrNull(report.variance_pct) === variance) return report;
  return repo.update("sales_reports", String(report.ROWID), { pos_net_sales: t.net_sales, reported_net_sales: toNum(report.net_sales), variance_pct: variance });
}

/** After a pull: the variance on every open report of the last three months, for stores with a feed. */
export async function refreshVariance(store: Store, ctx: Pick<TenantContext, "tenantId">, today: string): Promise<number> {
  const repo = new TenantRepo(store, ctx.tenantId);
  let changed = 0;
  for (const p of await repo.findMany("franchise_projects", { status: "OPENED" }, { orderBy: "ROWID", limit: 10_000 })) {
    if (!p.pos_last_day) continue;
    const periods = duePeriods(p, today).slice(-3);
    for (const period of periods) {
      const r = await repo.findOne("sales_reports", { period_key: `${ctx.tenantId}:${p.ROWID}:${period}` });
      if (!r || r.basis === "POS" || r.status === "INVOICED" || r.status === "PAID") continue;
      if ((await attachVariance(store, ctx, p, r, today)) !== r) changed++;
    }
  }
  return changed;
}

export const varianceText = (reported: number, pos: number, period: string) => {
  const v = variancePct(reported, pos);
  const inr = (n: number) => (n >= 100_000 ? `₹${round(n / 100_000, 1)} L` : `₹${Math.round(n).toLocaleString("en-IN")}`);
  return v === null ? "" : `reported ${inr(reported)} for ${periodLabel(period)}, the till says ${inr(pos)} (${v > 0 ? "+" : ""}${v}%)`;
};

import { z } from "zod";
import { AppError } from "../../common/errors";
import { isPortalUser } from "../../common/rbac";
import { onboardSignedAgreement, sendAgreement } from "../../workflows/agreements";
import { transitionEntity } from "../../workflows/transition";
import { Call, page, parse, Router } from "../router";
import { syncTenantFees } from "../../workflows/fees";
import { assertOwner, fetchAll, mustGet, ownerFilter } from "./shared";

async function zohoOrFail(call: Call) {
  const zoho = await call.zoho();
  if (!zoho) throw new AppError("ZOHO_SYNC_FAILED", "Zoho is not connected for this tenant.");
  return zoho;
}

export function agreementRoutes(r: Router): void {
  r.on("POST", "/applications/:id/agreement", "agreement.write", async (call) => {
    const zoho = await zohoOrFail(call);
    return sendAgreement(call.store, call.ctx, zoho.sign, { applicationId: call.params.id, permissions: call.permissions, onTransition: call.onTransition });
  }, 201);

  r.on("GET", "/agreements", null, async (call) => {
    const q = parse(page.extend({ status: z.string().optional(), application_id: z.string().optional(), fee_status: z.string().optional() }), call.query);
    const where = { ...(q.status ? { status: q.status } : {}), ...(q.application_id ? { application_id: q.application_id } : {}), ...ownerFilter(call) };
    if (!q.fee_status) return call.repo.findMany("agreements", where, { orderBy: "CREATEDTIME", desc: true, limit: q.limit, offset: q.offset });
    // Fee states are few and agreements are pilot-scale, so the comma list filters in code.
    const states = q.fee_status.split(",");
    const rows = await fetchAll(call.repo, "agreements", where);
    return rows.filter((a) => states.includes(String(a.fee_status ?? ""))).sort((a, b) => String(b.CREATEDTIME).localeCompare(String(a.CREATEDTIME))).slice(q.offset, q.offset + q.limit);
  });

  // Checks Books now for every unsettled fee instead of waiting for the daily job.
  r.on("POST", "/fees/sync", "dashboard.view", async (call) => {
    const zoho = await zohoOrFail(call);
    if (!zoho.books) throw new AppError("ZOHO_SYNC_FAILED", "Zoho Books is not connected for this tenant.");
    return syncTenantFees(call.store, call.ctx, zoho.books, zoho.crm, call.now);
  });

  r.on("GET", "/agreements/:id", null, async (call) => {
    const g = assertOwner(call, await mustGet(call.repo, "agreements", call.params.id, "AGREEMENT_NOT_FOUND"), "AGREEMENT_NOT_FOUND");
    // The signing invoice's number lives on its fee instalment; the CRM account is the one the signed copy is filed on.
    const instalment = g.zoho_books_invoice_id
      ? (await call.repo.findMany("fee_instalments", { agreement_id: String(g.ROWID) }, { limit: 50 })).find((x) => String(x.zoho_books_invoice_id) === String(g.zoho_books_invoice_id))
      : null;
    const franchisee = await call.repo.findOne("franchisees", { ROWID: String(g.franchisee_id) });
    const crm_account_id = String(g.document_ref ?? "").match(/^crm:Accounts\/([^/]+)\//)?.[1] ?? (franchisee?.zoho_account_id ? String(franchisee.zoho_account_id) : null);
    return { ...g, invoice_number: instalment?.invoice_number ?? null, crm_account_id: isPortalUser(call.ctx) ? null : crm_account_id };
  });

  // The signed agreement, fetched from Zoho Sign and kept in file storage, as a short-lived download link.
  r.on("GET", "/agreements/:id/signed-copy", null, async (call) => {
    const g = assertOwner(call, await mustGet(call.repo, "agreements", call.params.id, "AGREEMENT_NOT_FOUND"), "AGREEMENT_NOT_FOUND");
    if (g.status !== "SIGNED" || !g.zoho_sign_request_id) throw new AppError("NOT_FOUND", "There's no signed copy yet.");
    if (!call.files) throw new AppError("FILE_STORAGE_UNAVAILABLE", "File storage isn't set up.");
    const sign = (await call.zoho().catch(() => null))?.sign;
    if (!sign) throw new AppError("ZOHO_SYNC_FAILED", "Zoho Sign isn't connected, so the signed copy can't be fetched.");
    const file = await sign.downloadSigned(String(g.zoho_sign_request_id));
    const ext = file.type === "application/zip" ? "zip" : "pdf";
    const key = `tenants/${call.ctx.tenantId}/agreements/${g.ROWID}/${String(g.agreement_code)}-signed.${ext}`;
    await call.files.put(key, Buffer.from(file.data), file.type || "application/pdf", { overwrite: true });
    return { url: await call.files.downloadUrl(key) };
  });

  // Voids the FOS record only; recall the request in Zoho Sign as well so it cannot be signed.
  r.on("POST", "/agreements/:id/void", "agreement.write", async (call) => {
    await mustGet(call.repo, "agreements", call.params.id, "AGREEMENT_NOT_FOUND");
    return transitionEntity("agreement", call.params.id, "void", call.ctx, { store: call.store, permissions: call.permissions, onTransition: call.onTransition });
  });

  // Finishes the post-signature steps that are still pending (a Zoho outage, an interrupted run).
  r.on("POST", "/agreements/:id/onboard", "agreement.write", async (call) => {
    const agreement = await mustGet(call.repo, "agreements", call.params.id, "AGREEMENT_NOT_FOUND");
    if (agreement.status !== "SIGNED") throw new AppError("INVALID_TRANSITION", `Agreement is ${agreement.status}, not signed.`);
    const zoho = await call.zoho();
    return onboardSignedAgreement(call.store, call.ctx, { crm: zoho?.crm ?? null, sign: zoho?.sign ?? null, books: zoho?.books ?? null, projects: zoho?.projects ?? null }, { agreementId: call.params.id, now: call.now, onTransition: call.onTransition });
  });
}

import { z } from "zod";
import { AppError } from "../../common/errors";
import { onboardSignedAgreement, sendAgreement } from "../../workflows/agreements";
import { transitionEntity } from "../../workflows/transition";
import { Call, page, parse, Router } from "../router";
import { assertOwner, mustGet, ownerFilter } from "./shared";

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
    const q = parse(page.extend({ status: z.string().optional(), application_id: z.string().optional() }), call.query);
    const where = { ...(q.status ? { status: q.status } : {}), ...(q.application_id ? { application_id: q.application_id } : {}), ...ownerFilter(call) };
    return call.repo.findMany("agreements", where, { orderBy: "CREATEDTIME", desc: true, limit: q.limit, offset: q.offset });
  });

  r.on("GET", "/agreements/:id", null, async (call) =>
    assertOwner(call, await mustGet(call.repo, "agreements", call.params.id, "AGREEMENT_NOT_FOUND"), "AGREEMENT_NOT_FOUND"));

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

import { z } from "zod";
import { AppError } from "../../common/errors";
import { logActivity } from "../../common/audit";
import { Row } from "../../common/store";
import { toNum } from "../../common/values";
import { calculateFeasibility, calculateScenarios, DEFAULT_FEASIBILITY_THRESHOLDS, DEFAULT_SCENARIOS, FeasibilityInput, FeasibilityThresholds } from "../../scoring/feasibility";
import { transitionEntity } from "../../workflows/transition";
import { Call, parse, Router } from "../router";
import { mustGet, settings } from "./shared";

const money = z.number().nonnegative();
const pct = z.number().min(0).max(100);
const inputs = {
  initial_investment: z.number().positive(),
  monthly_revenue: money,
  gross_margin_pct: pct,
  monthly_fixed_opex: money,
  royalty_pct: pct,
  marketing_fund_pct: pct,
};
const lineItem = z.object({ category: z.string().max(50), item: z.string().max(200), amount: z.number(), assumption: z.string().max(1000).optional() }).strict();
const createSchema = z.object({ application_id: z.string().min(1), site_id: z.string().min(1).optional(), currency: z.string().length(3).optional(), ...inputs, line_items: z.array(lineItem).max(200).optional() }).strict();
const calcSchema = z.object(Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof inputs]: z.ZodOptional<(typeof inputs)[K]> }).strict();
const scenarioSchema = z.object({
  scenarios: z.array(z.object({ name: z.string().min(1).max(40), revenue_multiplier: z.number().positive().max(5), cost_multiplier: z.number().positive().max(5) }).strict()).min(1).max(10).optional(),
}).strict();

/** Application states in which the financial model may still change. */
const OPEN_APP_STATES = ["SITE_SUBMITTED", "FEASIBILITY_REVIEW"];

function inputOf(row: Row): FeasibilityInput {
  return {
    initial_investment: toNum(row.initial_investment), monthly_revenue: toNum(row.monthly_revenue), gross_margin_pct: toNum(row.gross_margin_pct),
    monthly_fixed_opex: toNum(row.monthly_fixed_opex), royalty_pct: toNum(row.royalty_pct), marketing_fund_pct: toNum(row.marketing_fund_pct),
  };
}

async function thresholds(call: Call): Promise<FeasibilityThresholds> {
  const tenant = await call.store.findOne("tenants", { ROWID: call.ctx.tenantId });
  return { ...DEFAULT_FEASIBILITY_THRESHOLDS, ...(settings(tenant).feasibility_thresholds as Partial<FeasibilityThresholds> | undefined) };
}

async function openModel(call: Call): Promise<{ model: Row; app: Row }> {
  const model = await mustGet(call.repo, "feasibility_models", call.params.id, "FEASIBILITY_NOT_FOUND");
  const app = await mustGet(call.repo, "franchise_applications", String(model.application_id), "APPLICATION_NOT_FOUND");
  if (!OPEN_APP_STATES.includes(String(app.status))) throw new AppError("APPLICATION_INVALID_STATE", `Feasibility is locked once the application is ${app.status}.`);
  return { model, app };
}

export function feasibilityRoutes(r: Router): void {
  r.on("POST", "/feasibility", "feasibility.write", async (call) => {
    const { line_items, ...body } = parse(createSchema, call.body);
    const app = await mustGet(call.repo, "franchise_applications", body.application_id, "APPLICATION_NOT_FOUND");
    if (!OPEN_APP_STATES.includes(String(app.status))) throw new AppError("APPLICATION_INVALID_STATE", `An application in ${app.status} is not ready for feasibility.`);
    const siteId = body.site_id ?? (app.site_id ? String(app.site_id) : undefined);
    if (!siteId) throw new AppError("VALIDATION_FAILED", "site_id is required.", { site_id: "required" });
    await mustGet(call.repo, "sites", siteId, "SITE_NOT_FOUND");
    const tenant = await call.store.findOne("tenants", { ROWID: call.ctx.tenantId });
    const model = await call.repo.insert("feasibility_models", {
      ...body, site_id: siteId, currency: body.currency ?? String(tenant?.currency ?? "INR"), status: "DRAFT",
    });
    for (const li of line_items ?? []) await call.repo.insert("feasibility_inputs", { ...li, feasibility_id: String(model.ROWID) });
    await call.repo.update("franchise_applications", String(app.ROWID), { feasibility_id: String(model.ROWID) });
    if (app.status === "SITE_SUBMITTED") {
      await transitionEntity("application", String(app.ROWID), "start_feasibility", call.ctx, { store: call.store, onTransition: call.onTransition, permissions: call.permissions });
    }
    await logActivity(call.store, call.ctx, { entityType: "feasibility", entityId: String(model.ROWID), action: "create", metadata: { application_id: body.application_id } });
    return model;
  }, 201);

  r.on("GET", "/feasibility/:id", "feasibility.write", async (call) => {
    const model = await mustGet(call.repo, "feasibility_models", call.params.id, "FEASIBILITY_NOT_FOUND");
    const [line_items, scenarios] = await Promise.all([
      call.repo.findMany("feasibility_inputs", { feasibility_id: call.params.id }),
      call.repo.findMany("feasibility_scenarios", { feasibility_id: call.params.id }),
    ]);
    return { ...model, fail_reasons: model.fail_reasons_json ? JSON.parse(String(model.fail_reasons_json)) : [], line_items, scenarios };
  });

  // Optional input overrides, then the D-15 model with tenant thresholds.
  r.on("POST", "/feasibility/:id/calculate", "feasibility.write", async (call) => {
    const overrides = parse(calcSchema, call.body);
    const { model } = await openModel(call);
    const input = { ...inputOf(model), ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)) } as FeasibilityInput;
    const result = calculateFeasibility(input, await thresholds(call));
    const row = await call.repo.update("feasibility_models", call.params.id, {
      ...input,
      monthly_opex: result.monthly_opex, monthly_ebitda: result.monthly_ebitda, annual_ebitda: result.annual_ebitda,
      ebitda_margin_pct: result.ebitda_margin_pct, roi_pct: result.roi_pct, payback_months: result.payback_months,
      passed: result.passed, fail_reasons_json: JSON.stringify(result.fail_reasons), status: "CALCULATED",
    });
    await logActivity(call.store, call.ctx, { entityType: "feasibility", entityId: call.params.id, action: "calculate", metadata: { passed: result.passed, roi_pct: result.roi_pct } });
    return { ...row, result };
  });

  // Scenario rows are upserted by name so re-running replaces rather than duplicates.
  r.on("POST", "/feasibility/:id/scenarios", "feasibility.write", async (call) => {
    const body = parse(scenarioSchema, call.body);
    const { model } = await openModel(call);
    const results = calculateScenarios(inputOf(model), body.scenarios ?? DEFAULT_SCENARIOS, await thresholds(call));
    const existing = await call.repo.findMany("feasibility_scenarios", { feasibility_id: call.params.id });
    const out: Row[] = [];
    for (const s of results) {
      const row = {
        feasibility_id: call.params.id, name: s.name, revenue_multiplier: s.revenue_multiplier, cost_multiplier: s.cost_multiplier,
        revenue: s.result.monthly_revenue, ebitda: s.result.monthly_ebitda, roi: s.result.roi_pct, payback_months: s.result.payback_months,
      };
      const prior = existing.find((e) => e.name === s.name);
      out.push(prior ? await call.repo.update("feasibility_scenarios", String(prior.ROWID), row) : await call.repo.insert("feasibility_scenarios", row));
    }
    return out.map((row, i) => ({ ...row, passed: results[i].result.passed, fail_reasons: results[i].result.fail_reasons }));
  });
}

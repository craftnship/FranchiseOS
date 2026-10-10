import { z } from "zod";
import type { FileStorage } from "../common/files";
import { AppError } from "../common/errors";
import { Mailer, TenantContext } from "../common/context";
import { StoreUserDirectory, storePermissionLookup } from "../common/directory";
import { log } from "../common/logger";
import { authorize, PermissionLookup } from "../common/rbac";
import { fail, newRequestId, ok } from "../common/response";
import { Store, TenantRepo } from "../common/store";
import { IdentityUser, resolveTenant } from "../common/tenant";
import { CrmFactory, pushApplicationStatus } from "../integrations/crmSync";
import { ProviderError } from "../integrations/retry";
import { ZohoClients, ZohoFactory } from "../integrations/tenantClients";
import { TransitionDeps } from "../workflows/transition";

// Framework-free router for the /api/v1 Advanced I/O function (D-14). The Catalyst entry point
// adapts Node's req/res to ApiRequest, so every route is testable against MemoryStore.

export interface ApiRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  identity: IdentityUser | null;
  requestId?: string;
  correlationId?: string;
}

export interface ApiResult { status: number; body: unknown }

export interface ApiDeps {
  store: Store;
  /** Overrides role_permissions lookups (tests). */
  permissions?: PermissionLookup;
  now?: () => Date;
  /** Builds the tenant's CRM client; null when CRM is not connected. */
  crm?: CrmFactory;
  /** Builds all of the tenant's Zoho clients (Sign, Books, Projects); null when not connected. */
  zoho?: ZohoFactory;
  /** Where uploaded documents are stored; absent until a Stratus bucket is configured. */
  files?: FileStorage;
  /** Sends notification emails; absent until a sender is configured. */
  mailer?: Mailer;
}

export interface Call {
  ctx: TenantContext;
  repo: TenantRepo;
  store: Store;
  permissions: PermissionLookup;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  now: Date;
  /** Passed to transitionEntity: writes application status back to the CRM lead. */
  onTransition: NonNullable<TransitionDeps["onTransition"]>;
  /** The tenant's Zoho clients, or null when Zoho is not connected. */
  zoho: () => Promise<ZohoClients | null>;
  files: FileStorage | null;
}

export type Handler = (call: Call) => Promise<unknown>;

interface Route { method: string; parts: string[]; permission: string | null; handler: Handler; status: number }

export const API_PREFIXES = ["/server/fos_api", "/server/fos_webhooks", "/api/v1"];

export function normalizePath(path: string): string {
  let p = path.split("?")[0].replace(/\/+$/, "") || "/";
  for (const prefix of API_PREFIXES) if (p.startsWith(prefix)) p = p.slice(prefix.length) || "/";
  return p;
}

export class Router {
  private routes: Route[] = [];

  /** permission null = any authenticated tenant user; handlers may check more. */
  on(method: string, pattern: string, permission: string | null, handler: Handler, status = 200): this {
    this.routes.push({ method: method.toUpperCase(), parts: pattern.split("/").filter(Boolean), permission, handler, status });
    return this;
  }

  private match(method: string, path: string): { route: Route; params: Record<string, string> } | "method" | null {
    const parts = path.split("/").filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      const okParts = route.parts.every((rp, i) => {
        if (rp.startsWith(":")) { params[rp.slice(1)] = decodeURIComponent(parts[i]); return true; }
        return rp === parts[i];
      });
      if (!okParts) continue;
      pathMatched = true;
      if (route.method === method.toUpperCase()) return { route, params };
    }
    return pathMatched ? "method" : null;
  }

  async handle(req: ApiRequest, deps: ApiDeps): Promise<ApiResult> {
    const requestId = req.requestId ?? newRequestId();
    try {
      const m = this.match(req.method, normalizePath(req.path));
      if (m === null) throw new AppError("NOT_FOUND", "Route not found.");
      if (m === "method") throw new AppError("INVALID_REQUEST", "Method not allowed on this route.");
      const ctx: TenantContext = { ...await resolveTenant(req.identity, new StoreUserDirectory(deps.store), { requestId, correlationId: req.correlationId }), mailer: deps.mailer };
      const permissions = deps.permissions ?? storePermissionLookup(deps.store, ctx.tenantId);
      if (m.route.permission) await authorize(ctx, m.route.permission, permissions);
      const data = await m.route.handler({
        ctx,
        repo: new TenantRepo(deps.store, ctx.tenantId),
        store: deps.store,
        permissions,
        params: m.params,
        query: req.query ?? {},
        body: req.body ?? {},
        now: deps.now?.() ?? new Date(),
        onTransition: async (e) => {
          if (e.entityType !== "application" || !deps.crm) return;
          await pushApplicationStatus(deps.store, ctx, await deps.crm(ctx.tenantId).catch(() => null), e.entity);
        },
        zoho: async () => (deps.zoho ? deps.zoho(ctx.tenantId) : null),
        files: deps.files ?? null,
      });
      return { status: m.route.status, body: ok(data, requestId) };
    } catch (caught) {
      // A Zoho failure carries Zoho's own reason, which names what to fix and holds no secrets.
      const err = caught instanceof ProviderError ? new AppError("ZOHO_SYNC_FAILED", caught.message.slice(0, 300)) : caught;
      if (!(err instanceof AppError)) log("error", "api.unhandled", { request_id: requestId, error: String((err as Error)?.stack ?? err) });
      return fail(err, requestId);
    }
  }
}

/** Parses a body or query with zod; failures become VALIDATION_FAILED with per-field messages. */
export function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const fields: Record<string, string> = {};
  for (const issue of r.error.issues) fields[issue.path.join(".") || "_"] = issue.message;
  throw new AppError("VALIDATION_FAILED", "Request validation failed.", fields);
}

export const page = z.object({
  limit: z.coerce.number().int().min(1).max(300).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

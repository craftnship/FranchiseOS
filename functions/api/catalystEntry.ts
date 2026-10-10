import type { IncomingMessage, ServerResponse } from "http";
import { CatalystStore } from "../common/catalystStore";
import { StratusFileStorage } from "../common/files";
import { mailerFromEnv } from "../common/mailer";
import { newRequestId } from "../common/response";
import { IdentityUser } from "../common/tenant";
import { crmFactory, zohoCredentialsFromEnv, zohoFactory } from "../integrations/tenantClients";
import { buildRouter } from "./app";

// Entry point of the fos_api Advanced I/O function. API Gateway forwards /api/v1/* here with
// Catalyst Authentication enforced; the user comes from the SDK, never from the request body.

// Room for a 5 MB document upload sent base64-encoded.
const MAX_BODY_BYTES = 7_500_000;
const router = buildRouter();

interface CatalystSdk {
  initialize(req: IncomingMessage, opts?: { scope?: string }): {
    userManagement(): { getCurrentUser(): Promise<{ user_id: string | number; email_id: string }> };
    stratus(): { bucket(name: string): ConstructorParameters<typeof StratusFileStorage>[0] };
  } & ConstructorParameters<typeof CatalystStore>[0];
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error("BODY_TOO_LARGE")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse, sdk: CatalystSdk): Promise<void> {
  const requestId = newRequestId();
  const url = new URL(req.url ?? "/", "http://localhost");
  let body: unknown = {};
  try {
    const raw = ["POST", "PUT", "PATCH"].includes(req.method ?? "") ? await readBody(req) : "";
    body = raw ? JSON.parse(raw) : {};
  } catch {
    send(res, 400, { success: false, error: { code: "INVALID_REQUEST", message: "Request body must be valid JSON under 7.5 MB." }, meta: { request_id: requestId } });
    return;
  }

  const app = sdk.initialize(req);
  let identity: IdentityUser | null = null;
  try {
    const u = await app.userManagement().getCurrentUser();
    if (u?.user_id) identity = { externalUserId: String(u.user_id), email: u.email_id };
  } catch {
    identity = null; // resolveTenant turns this into AUTH_REQUIRED
  }

  const correlation = req.headers["x-correlation-id"];
  const result = await router.handle(
    {
      method: req.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      identity,
      requestId,
      correlationId: typeof correlation === "string" ? correlation.slice(0, 100) : undefined,
    },
    (() => {
      // Admin scope for data: the signed-in user only identifies the caller. Catalyst's App User
      // role is read-only on every table; FranchiseOS enforces tenant isolation and RBAC itself.
      const admin = sdk.initialize(req, { scope: "admin" });
      const store = new CatalystStore(admin);
      const creds = zohoCredentialsFromEnv();
      // Document uploads are on once FOS_STRATUS_BUCKET names the bucket.
      const bucket = process.env.FOS_STRATUS_BUCKET?.trim();
      const files = bucket ? new StratusFileStorage(admin.stratus().bucket(bucket)) : undefined;
      return { store, crm: crmFactory(store, creds), zoho: zohoFactory(store, creds), files, mailer: mailerFromEnv(admin) };
    })(),
  );
  send(res, result.status, result.body);
}

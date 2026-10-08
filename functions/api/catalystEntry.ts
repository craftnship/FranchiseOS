import type { IncomingMessage, ServerResponse } from "http";
import { CatalystStore } from "../common/catalystStore";
import { newRequestId } from "../common/response";
import { IdentityUser } from "../common/tenant";
import { buildRouter } from "./app";

// Entry point of the fos_api Advanced I/O function. API Gateway forwards /api/v1/* here with
// Catalyst Authentication enforced; the user comes from the SDK, never from the request body.

const MAX_BODY_BYTES = 1_000_000;
const router = buildRouter();

interface CatalystSdk {
  initialize(req: IncomingMessage): {
    userManagement(): { getCurrentUser(): Promise<{ user_id: string | number; email_id: string }> };
  } & ConstructorParameters<typeof CatalystStore>[0];
}

function readBody(req: IncomingMessage): Promise<string> {
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

function send(res: ServerResponse, status: number, body: unknown): void {
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
    send(res, 400, { success: false, error: { code: "INVALID_REQUEST", message: "Request body must be valid JSON under 1 MB." }, meta: { request_id: requestId } });
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
    { store: new CatalystStore(app) },
  );
  send(res, result.status, result.body);
}

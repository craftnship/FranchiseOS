import { createHmac, timingSafeEqual } from "crypto";
import { ZohoEndpoints } from "./region";
import { ProviderError } from "./retry";
import { FetchLike } from "./zohoHttp";

// The consent flow a franchisee goes through to let FranchiseOS read sales from their own Zoho Books
// (docs/pos-sales.md). The brand's OAuth client asks; the state is signed so the callback can only
// land on the franchisee who started it.

export const BOOKS_READ_SCOPES = ["ZohoBooks.invoices.READ", "ZohoBooks.creditnotes.READ", "ZohoBooks.settings.READ"];
const STATE_TTL_MS = 15 * 60_000;

export interface OAuthState { tenant_id: string; franchisee_id: string; user_id: string; exp: number }

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const sig = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("base64url");

export function signState(secret: string, state: Omit<OAuthState, "exp">, now = Date.now()): string {
  const body = b64(JSON.stringify({ ...state, exp: now + STATE_TTL_MS }));
  return `${body}.${sig(secret, body)}`;
}

/** The state back from Zoho, or null when it was not ours, was altered, or is older than 15 minutes. */
export function verifyState(secret: string, state: string, now = Date.now()): OAuthState | null {
  const [body, given] = String(state ?? "").split(".");
  if (!body || !given) return null;
  const want = sig(secret, body);
  if (want.length !== given.length || !timingSafeEqual(Buffer.from(want), Buffer.from(given))) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString()) as OAuthState;
    return s.exp > now && s.tenant_id && s.franchisee_id ? s : null;
  } catch { return null; }
}

export function consentUrl(endpoints: ZohoEndpoints, clientId: string, redirectUri: string, state: string, scopes = BOOKS_READ_SCOPES): string {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: scopes.join(","), access_type: "offline", prompt: "consent", state });
  return `${endpoints.accounts}/oauth/v2/auth?${q}`;
}

/** Swaps the one-time code for a refresh token. Zoho answers 200 with an `error` field on failure. */
export async function exchangeCode(fetchFn: FetchLike, endpoints: ZohoEndpoints, creds: { clientId: string; clientSecret: string }, redirectUri: string, code: string): Promise<{ refreshToken: string; accessToken: string }> {
  const body = new URLSearchParams({ grant_type: "authorization_code", client_id: creds.clientId, client_secret: creds.clientSecret, redirect_uri: redirectUri, code }).toString();
  const res = await fetchFn(`${endpoints.accounts}/oauth/v2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; error?: string };
  if (!res.ok || !data.refresh_token || !data.access_token) throw new ProviderError(`Zoho did not grant access: ${data.error ?? res.status}`, res.ok ? 400 : res.status, false);
  return { refreshToken: data.refresh_token, accessToken: data.access_token };
}

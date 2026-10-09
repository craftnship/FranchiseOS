import { ProviderError } from "./retry";
import { resolveZohoEndpoints, ZohoEndpoints } from "./region";

// Zoho OAuth and HTTP (spec §13, §37). Access tokens are cached per refresh token until shortly
// before expiry; tokens never reach logs (logger redacts *token* keys).

export interface TokenProvider { accessToken(): Promise<string> }

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

const cache = new Map<string, { token: string; expiresAt: number }>();

export class RefreshTokenProvider implements TokenProvider {
  constructor(
    private readonly endpoints: ZohoEndpoints,
    private readonly creds: { clientId: string; clientSecret: string; refreshToken: string },
    private readonly fetchFn: FetchLike = fetch as unknown as FetchLike,
    private readonly now: () => number = Date.now,
  ) {}

  async accessToken(): Promise<string> {
    const key = `${this.endpoints.accounts}:${this.creds.refreshToken}`;
    const hit = cache.get(key);
    if (hit && hit.expiresAt > this.now()) return hit.token;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
      refresh_token: this.creds.refreshToken,
    }).toString();
    const res = await this.fetchFn(`${this.endpoints.accounts}/oauth/v2/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !data.access_token) throw new ProviderError(`Zoho token refresh failed: ${data.error ?? res.status}`, res.ok ? 401 : res.status, false);
    cache.set(key, { token: data.access_token, expiresAt: this.now() + ((data.expires_in ?? 3600) - 300) * 1000 });
    return data.access_token;
  }
}

/** Clears cached tokens (tests, credential rotation). */
export function clearTokenCache(): void { cache.clear(); }

export class ZohoHttp {
  constructor(private readonly tokens: TokenProvider, private readonly fetchFn: FetchLike = fetch as unknown as FetchLike) {}

  async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const token = await this.tokens.accessToken();
    const res = await this.fetchFn(url, {
      method,
      headers: { Authorization: `Zoho-oauthtoken ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const data = text ? safeJson(text) : undefined;
    if (!res.ok) {
      const msg = (data as { message?: string; code?: string } | undefined)?.message ?? text.slice(0, 200);
      throw new ProviderError(`Zoho ${method} ${new URL(url).pathname} failed (${res.status}): ${msg}`, res.status);
    }
    return data as T;
  }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 200) }; }
}

export function endpointsFor(dc: string): ZohoEndpoints {
  return resolveZohoEndpoints(dc);
}

import { DuplicateKeyError, Store } from "./store";

// Business ID prefixes from spec §9.
export const ID_PREFIX = {
  franchisee: "FR",
  application: "APP",
  territory: "TER",
  site: "SITE",
  agreement: "AGR",
  project: "PROJ",
  audit: "AUD",
} as const;
export type IdKind = keyof typeof ID_PREFIX;

export function formatId(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(6, "0")}`;
}

/**
 * Concurrency-safe business IDs (§9, D-13). Each issued number is a row in id_sequences whose
 * seq_key column is unique, so two writers can never claim the same number; the loser retries.
 */
export async function nextBusinessId(store: Store, tenantId: string, kind: IdKind, maxAttempts = 50): Promise<string> {
  const prefix = ID_PREFIX[kind];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Re-read the high-water mark on every attempt so a burst of writers converges quickly.
    const latest = await store.findMany("id_sequences", { tenant_id: tenantId, prefix }, { orderBy: "seq_no", desc: true, limit: 1 });
    const n = latest.length ? Number(latest[0].seq_no) + 1 : 1;
    try {
      await store.insert("id_sequences", { tenant_id: tenantId, prefix, seq_no: n, seq_key: `${tenantId}:${prefix}:${n}` });
      return formatId(prefix, n);
    } catch (e) {
      if (!(e instanceof DuplicateKeyError)) throw e;
      await new Promise((r) => setTimeout(r, Math.random() * 5 * attempt));
    }
  }
  throw new Error(`Could not allocate ${prefix} id after ${maxAttempts} attempts`);
}

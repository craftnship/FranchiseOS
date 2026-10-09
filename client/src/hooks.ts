import { useCallback, useEffect, useState } from "react";
import { api, ApiError, Row } from "./api";

export interface Load<T> { data: T | null; error: ApiError | null; loading: boolean; reload: () => void }

/** Runs an API call on mount and whenever deps change. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): Load<T> {
  const [state, setState] = useState<{ data: T | null; error: ApiError | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn().then((data) => live && setState({ data, error: null, loading: false }))
      .catch((error) => live && setState({ data: null, error: error instanceof ApiError ? error : new ApiError("NETWORK", String(error), 0), loading: false }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

/** Franchisee names by ROWID, for showing who a record belongs to in lists. */
export function useFranchiseeNames(): Record<string, string> {
  const load = useLoad(() => api<Row[]>("GET", "/franchisees", { query: { limit: "200" } }), []);
  return Object.fromEntries((load.data ?? []).map((f) => [String(f.ROWID), String(f.display_name ?? f.franchise_code)]));
}

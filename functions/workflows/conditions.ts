// Tiny, safe condition language for approval steps (condition_json). No eval.
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { field: string; op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in"; value: unknown };

export function evaluate(cond: Condition | null | undefined, facts: Record<string, unknown>): boolean {
  if (!cond) return true;
  if ("all" in cond) return cond.all.every((c) => evaluate(c, facts));
  if ("any" in cond) return cond.any.some((c) => evaluate(c, facts));
  const actual = facts[cond.field];
  const n = (x: unknown) => Number(x);
  switch (cond.op) {
    case "eq": return actual === cond.value;
    case "neq": return actual !== cond.value;
    case "gt": return n(actual) > n(cond.value);
    case "gte": return n(actual) >= n(cond.value);
    case "lt": return n(actual) < n(cond.value);
    case "lte": return n(actual) <= n(cond.value);
    case "in": return Array.isArray(cond.value) && cond.value.includes(actual);
  }
}

export function parseCondition(json: unknown): Condition | null {
  if (json === null || json === undefined || json === "") return null;
  return typeof json === "string" ? (JSON.parse(json) as Condition) : (json as Condition);
}

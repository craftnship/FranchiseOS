import { AppError } from "../common/errors";

export interface Weighted { code: string; weight: number }

/** Configurable weights must total 100% (spec §17, §18, FOS-019). */
export function assertWeightsTotal100(items: Weighted[], label: string): void {
  const total = items.reduce((s, i) => s + i.weight, 0);
  if (Math.abs(total - 100) > 0.001) {
    throw new AppError("VALIDATION_FAILED", `${label} weights total ${total}%, expected 100%.`, { weights: `total ${total}` });
  }
  if (items.some((i) => i.weight < 0)) throw new AppError("VALIDATION_FAILED", `${label} weights must not be negative.`);
}

export function clamp(n: number, lo = 0, hi = 100): number {
  return Math.min(hi, Math.max(lo, n));
}

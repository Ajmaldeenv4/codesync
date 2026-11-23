export interface Summary {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

/** Nearest-rank percentiles, rounded to 0.1. */
export function summarize(samples: number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) =>
    round(sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN);
  return { count: sorted.length, p50: at(50), p95: at(95), max: at(100) };
}

export function round(value: number): number {
  return Math.round(value * 10) / 10;
}

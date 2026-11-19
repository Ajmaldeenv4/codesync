/** Token bucket per key (user id): `capacity` runs in a burst, refilling `refillPerSecond`. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes one token. Returns 0 when allowed, otherwise the seconds until the next token. */
  take(key: string): number {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    const elapsed = (now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerSecond);
    bucket.updatedAt = now;
    this.buckets.set(key, bucket);
    this.prune(now);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - bucket.tokens) / this.refillPerSecond);
  }

  /** Forgets buckets that have fully refilled, so the map doesn't grow without bound. */
  private prune(now: number) {
    if (this.buckets.size < 1000) return;
    const fullAfterMs = (this.capacity / this.refillPerSecond) * 1000;
    for (const [key, b] of this.buckets) {
      if (now - b.updatedAt > fullAfterMs) this.buckets.delete(key);
    }
  }
}

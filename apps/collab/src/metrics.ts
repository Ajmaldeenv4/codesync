/** Counts events in one-second buckets and reports the average rate over a sliding window. */
export class RateCounter {
  private readonly buckets = new Map<number, number>();

  constructor(
    private readonly windowSeconds = 10,
    private readonly now: () => number = Date.now,
  ) {}

  record(count = 1): void {
    const second = Math.floor(this.now() / 1000);
    this.buckets.set(second, (this.buckets.get(second) ?? 0) + count);
    this.prune(second);
  }

  /** Events per second averaged over the last `windowSeconds` full seconds. */
  perSecond(): number {
    const current = Math.floor(this.now() / 1000);
    this.prune(current);
    let total = 0;
    for (const [second, count] of this.buckets) {
      if (second > current - this.windowSeconds && second <= current) total += count;
    }
    return Math.round((total / this.windowSeconds) * 100) / 100;
  }

  private prune(current: number): void {
    for (const second of this.buckets.keys()) {
      if (second <= current - this.windowSeconds) this.buckets.delete(second);
    }
  }
}

export interface CollabMetrics {
  connectedClients: number;
  activeRooms: number;
  updatesPerSecond: number;
  uptimeSeconds: number;
}

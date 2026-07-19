interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucketLimiter {
  readonly #buckets = new Map<string, Bucket>();
  constructor(
    private readonly capacity: number,
    private readonly refillPerMinute = capacity,
  ) {}

  take(key: string, now = Date.now()) {
    const existing = this.#buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    const elapsedMinutes = Math.max(0, now - existing.updatedAt) / 60_000;
    const available = Math.min(
      this.capacity,
      existing.tokens + elapsedMinutes * this.refillPerMinute,
    );
    if (available < 1) {
      existing.tokens = available;
      existing.updatedAt = now;
      this.#buckets.set(key, existing);
      return false;
    }
    existing.tokens = available - 1;
    existing.updatedAt = now;
    this.#buckets.set(key, existing);
    if (this.#buckets.size > 10_000) this.prune(now);
    return true;
  }

  prune(now = Date.now()) {
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.updatedAt > 3_600_000) this.#buckets.delete(key);
    }
  }
}

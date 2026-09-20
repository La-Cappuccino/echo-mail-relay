// Minimal in-process token bucket for /send (SPEC D2). No new deps, no
// external store — the relay runs as a single instance, so in-memory is
// the correct scope. Buckets refill continuously; a full bucket allows a
// burst of `capacity` calls, sustained throughput is `refillPerSec`.

export interface RateLimiterOptions {
  capacity: number; // burst size (max tokens in a bucket)
  refillPerSec: number; // sustained tokens per second
}

interface Bucket {
  tokens: number;
  last: number; // ms epoch of last refill
}

const PRUNE_THRESHOLD = 10_000; // keep memory bounded under key/IP churn

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private opts: RateLimiterOptions) {}

  /** Number of live buckets. Exposed so the prune policy is testable. */
  get size(): number {
    return this.buckets.size;
  }

  /**
   * Take `cost` tokens for `key`. Returns false when the caller is rate-limited,
   * and in that case spends nothing. A weighted cost is how one bulk request
   * can be charged for the recipients it carries rather than counting as one
   * call (a 500-recipient send must not be as cheap as a single mail).
   */
  take(key: string, cost = 1, now = Date.now()): boolean {
    const bucket = this.refill(key, now);
    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }

  /**
   * Would `take(key, cost)` succeed right now? Spends nothing, so a caller can
   * confirm it has budget, run a check that might still refuse the request, and
   * only then charge — without the refused path silently eating the budget.
   */
  canTake(key: string, cost = 1, now = Date.now()): boolean {
    return this.refill(key, now).tokens >= cost;
  }

  private refill(key: string, now: number): Bucket {
    this.prune(now);
    const bucket = this.buckets.get(key);
    if (!bucket) {
      const fresh = { tokens: this.opts.capacity, last: now };
      this.buckets.set(key, fresh);
      return fresh;
    }
    const elapsedSec = Math.max(0, now - bucket.last) / 1000;
    bucket.tokens = Math.min(this.opts.capacity, bucket.tokens + elapsedSec * this.opts.refillPerSec);
    bucket.last = now;
    return bucket;
  }

  private prune(now: number): void {
    if (this.buckets.size < PRUNE_THRESHOLD) return;
    for (const [key, bucket] of this.buckets) {
      // Evicting a bucket recreates it at full capacity, so a bucket may only
      // be dropped once it would have refilled to capacity on its own. Pruning
      // on idle time alone would refund a spent hourly budget after a minute.
      const elapsedSec = Math.max(0, now - bucket.last) / 1000;
      const replenished = bucket.tokens + elapsedSec * this.opts.refillPerSec;
      if (replenished >= this.opts.capacity) this.buckets.delete(key);
    }
  }
}

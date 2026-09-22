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
const IDLE_MS = 60_000;

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private opts: RateLimiterOptions) {}

  /** Take one token for `key`. Returns false when the caller is rate-limited. */
  take(key: string, now = Date.now()): boolean {
    this.prune(now);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.opts.capacity, last: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsedSec = Math.max(0, now - bucket.last) / 1000;
      bucket.tokens = Math.min(this.opts.capacity, bucket.tokens + elapsedSec * this.opts.refillPerSec);
      bucket.last = now;
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  private prune(now: number): void {
    if (this.buckets.size < PRUNE_THRESHOLD) return;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.last > IDLE_MS) this.buckets.delete(key);
    }
  }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from './ratelimit.js';

test('take(key) still costs exactly one token — existing callers are unaffected', () => {
  const limiter = new RateLimiter({ capacity: 3, refillPerSec: 0 });
  assert.equal(limiter.take('a'), true);
  assert.equal(limiter.take('a'), true);
  assert.equal(limiter.take('a'), true);
  assert.equal(limiter.take('a'), false);
  // a different key has its own full bucket
  assert.equal(limiter.take('b'), true);
});

test('take(key, cost) spends `cost` tokens at once', () => {
  const limiter = new RateLimiter({ capacity: 10, refillPerSec: 0 });
  assert.equal(limiter.take('a', 7), true);
  assert.equal(limiter.take('a', 3), true);
  assert.equal(limiter.take('a', 1), false);
});

test('a cost larger than the remaining tokens is refused and spends nothing', () => {
  const limiter = new RateLimiter({ capacity: 10, refillPerSec: 0 });
  assert.equal(limiter.take('a', 6), true);
  assert.equal(limiter.take('a', 6), false); // only 4 left
  assert.equal(limiter.take('a', 4), true); // …and those 4 are still there
});

test('a cost larger than the bucket capacity can never succeed', () => {
  const limiter = new RateLimiter({ capacity: 10, refillPerSec: 1000 });
  assert.equal(limiter.take('a', 11), false);
});

test('cost 0 is always allowed and spends nothing', () => {
  const limiter = new RateLimiter({ capacity: 1, refillPerSec: 0 });
  assert.equal(limiter.take('a', 0), true);
  assert.equal(limiter.take('a', 1), true);
});

test('buckets refill over time and stay capped at capacity', () => {
  const limiter = new RateLimiter({ capacity: 100, refillPerSec: 10 });
  const t0 = 1_000_000;
  assert.equal(limiter.take('a', 100, t0), true);
  assert.equal(limiter.take('a', 1, t0), false);
  assert.equal(limiter.take('a', 50, t0 + 5_000), true); // 5s × 10/s = 50 tokens
  assert.equal(limiter.take('a', 1, t0 + 5_000), false);
  // long idle: refill is clamped to capacity, not accumulated forever
  assert.equal(limiter.take('a', 100, t0 + 3_600_000), true);
  assert.equal(limiter.take('a', 1, t0 + 3_600_000), false);
});

test('an explicit `now` is still honoured as the third argument', () => {
  const limiter = new RateLimiter({ capacity: 1, refillPerSec: 1 });
  const t0 = 2_000_000;
  assert.equal(limiter.take('a', 1, t0), true);
  assert.equal(limiter.take('a', 1, t0), false);
  assert.equal(limiter.take('a', 1, t0 + 1_000), true);
});

// --- prune must not hand back budget (Codex #7) ---

test('prune never evicts a bucket that is still depleted', () => {
  // The hourly recipient budget refills at ~0.56 tokens/s, so a bucket idle
  // for a minute is nowhere near full. Evicting it would recreate it at full
  // capacity — i.e. silently refund a spent budget.
  const limiter = new RateLimiter({ capacity: 2000, refillPerSec: 2000 / 3600 });
  const t0 = 1_000_000;
  assert.equal(limiter.take('project:a', 2000, t0), true);

  // Force a prune sweep by pushing the map past its threshold.
  const later = t0 + 120_000;
  for (let i = 0; i < 10_050; i += 1) limiter.take(`filler:${i}`, 1, later);

  // 120s × 0.56/s ≈ 67 tokens back — not 2000.
  assert.equal(limiter.take('project:a', 500, later), false);
  assert.equal(limiter.take('project:a', 60, later), true);
});

test('prune still evicts buckets that have fully replenished', () => {
  const limiter = new RateLimiter({ capacity: 10, refillPerSec: 10 });
  const t0 = 1_000_000;
  assert.equal(limiter.take('spent', 10, t0), true);

  // 10s later `spent` is back to capacity, so it is safe to drop.
  const later = t0 + 10_000;
  for (let i = 0; i < 10_050; i += 1) limiter.take(`filler:${i}`, 1, later);
  assert.equal(limiter.size, 10_050, 'the replenished bucket should have been pruned');
});

// --- canTake: check without spending (needed to preflight before charging) ---

test('canTake reports availability without spending anything', () => {
  const limiter = new RateLimiter({ capacity: 5, refillPerSec: 0 });
  assert.equal(limiter.canTake('a', 5), true);
  assert.equal(limiter.canTake('a', 5), true); // still true — nothing was spent
  assert.equal(limiter.canTake('a', 6), false);
  assert.equal(limiter.take('a', 5), true);
  assert.equal(limiter.canTake('a', 1), false);
});

test('canTake accounts for refill the same way take does', () => {
  const limiter = new RateLimiter({ capacity: 10, refillPerSec: 1 });
  const t0 = 1_000_000;
  assert.equal(limiter.take('a', 10, t0), true);
  assert.equal(limiter.canTake('a', 5, t0), false);
  assert.equal(limiter.canTake('a', 5, t0 + 5_000), true);
});

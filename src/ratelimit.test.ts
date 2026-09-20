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

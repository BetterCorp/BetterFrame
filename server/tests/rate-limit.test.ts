import assert from "node:assert/strict";
import test from "node:test";
import { createRateLimiter } from "../src/shared/rate-limit.js";

test("rotating untrusted keys cannot grow storage or evict an active quota", () => {
  let now = 0;
  const limiter = createRateLimiter({ windowMs: 1_000, max: 2, maxBuckets: 2 }, () => now);
  assert.equal(limiter.take("serial:registered"), true);
  assert.equal(limiter.take("serial:registered"), true);
  assert.equal(limiter.take("session:known"), true);
  for (let i = 0; i < 20_000; i++) assert.equal(limiter.take(`untrusted:${i}`), false);
  assert.equal(limiter.remaining("untrusted:new"), 0);
  assert.equal(limiter.take("serial:registered"), false);
  // Other live keys keep their remaining quota when key storage is full.
  assert.equal(limiter.take("session:known"), true);
  now = 1_000;
  // Expired buckets disappear without ever accessing their keys again.
  assert.equal(limiter.take("new:first"), true);
  assert.equal(limiter.take("new:second"), true);
  assert.equal(limiter.take("new:third"), false);
});

test("aggregate hit storage is bounded and reset releases its capacity", () => {
  const limiter = createRateLimiter({ windowMs: 1_000, max: 10, maxBuckets: 10, maxEntries: 3 }, () => 0);
  assert.equal(limiter.take("a"), true);
  assert.equal(limiter.take("a"), true);
  assert.equal(limiter.take("b"), true);
  assert.equal(limiter.take("b"), false);
  assert.equal(limiter.take("c"), false);
  assert.equal(limiter.remaining("a"), 0);
  limiter.reset("a");
  limiter.reset("a");
  assert.equal(limiter.remaining("b"), 2);
  assert.equal(limiter.take("c"), true);
  assert.equal(limiter.take("c"), true);
  assert.equal(limiter.take("c"), false);
});

test("global sweeps reclaim expired hits within a still-active sliding window", () => {
  let now = 0;
  const limiter = createRateLimiter({ windowMs: 2_000, max: 3, maxEntries: 3 }, () => now);
  assert.equal(limiter.take("old"), true);
  now = 1_000;
  assert.equal(limiter.take("old"), true);
  assert.equal(limiter.take("other"), true);
  now = 2_000;
  assert.equal(limiter.take("new"), true);
  assert.equal(limiter.take("new"), false);
  assert.equal(limiter.remaining("old"), 0);
  now = 3_000;
  assert.equal(limiter.remaining("old"), 2);
  assert.equal(limiter.take("new"), true);
  assert.equal(limiter.take("new"), true);
  assert.equal(limiter.take("new"), false);
});

test("default limits also bound serial and polling-secret churn", () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 60 }, () => 0);
  for (let i = 0; i < 10_000; i++) assert.equal(limiter.take(`session:${i}`), true);
  for (let i = 10_000; i < 20_000; i++) assert.equal(limiter.take(`serial:${i}`), false);
  assert.equal(limiter.remaining("session:0"), 59);
});

test("target expiry between global sweeps releases capacity without double-counting later", () => {
  let now = 0;
  const limiter = createRateLimiter({ windowMs: 2_000, max: 3, maxBuckets: 2, maxEntries: 3 }, () => now);
  assert.equal(limiter.take("a"), true);
  assert.equal(limiter.take("a"), true);
  now = 1_500;
  assert.equal(limiter.take("b"), true); // Next global sweep is at 2,500.
  now = 2_000;
  assert.equal(limiter.remaining("a"), 2); // Exact boundary expires both old hits.
  assert.equal(limiter.take("c"), true); // Both timestamp and bucket capacity were released.
  assert.equal(limiter.take("c"), true);
  assert.equal(limiter.take("c"), false);
  now = 2_500;
  assert.equal(limiter.remaining("b"), 0); // Global sweep must not subtract old hits twice.
  limiter.reset("c");
  assert.equal(limiter.remaining("b"), 2);
  assert.equal(limiter.take("b"), true);
  assert.equal(limiter.take("b"), true);
  assert.equal(limiter.take("b"), false);
});

test("querying unknown keys does not allocate buckets", () => {
  const limiter = createRateLimiter({ windowMs: 1_000, max: 1, maxBuckets: 1 }, () => 0);
  for (let i = 0; i < 1_000; i++) assert.equal(limiter.remaining(`unknown:${i}`), 1);
  assert.equal(limiter.take("known"), true);
  assert.equal(limiter.remaining("unknown:new"), 0);
  assert.equal(limiter.take("known"), false);
});

test("invalid limits fail before admitting traffic", () => {
  for (const invalid of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    for (const field of ["windowMs", "max", "maxBuckets", "maxEntries"]) {
      assert.throws(() => createRateLimiter({ windowMs: 1_000, max: 2, [field]: invalid }), /invalid rate limit configuration/);
    }
  }
});

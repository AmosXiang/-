import assert from 'node:assert/strict';
import test from 'node:test';
import { AgnesImageRateLimiter } from './rateLimiter.ts';

test('1K limiter grants 20 immediately and queues requests 21-25 without loss', async () => {
  const limiter = new AgnesImageRateLimiter();
  const startedAt = Date.now();
  const completions = await Promise.all(Array.from({ length: 25 }, async (_, index) => {
    const permit = await limiter.acquire(1024, 1024, 120_000);
    const item = { request: index + 1, waitedMs: Date.now() - startedAt, queuedAhead: permit.queuedAhead };
    console.log('[RateLimiterAcceptance]', JSON.stringify(item));
    return item;
  }));
  assert.equal(completions.length, 25);
  assert.ok(completions.slice(0, 20).every(item => item.waitedMs < 1_000));
  assert.ok(completions.slice(20).every(item => item.waitedMs >= 2_500));
});

import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../src/rateLimit';

describe('rate limiter', () => {
  it('allows up to the limit per window, per key, then resets', () => {
    let t = 0;
    const rl = createRateLimiter(() => t);
    expect([1, 2, 3].map(() => rl.take('a', 2, 1000))).toEqual([true, true, false]);
    expect(rl.take('b', 2, 1000)).toBe(true);
    t = 1000;
    expect(rl.take('a', 2, 1000)).toBe(true);
  });
});

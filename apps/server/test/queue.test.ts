import { describe, expect, it } from 'vitest';
import { FetchQueue } from '../src/queue';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('FetchQueue', () => {
  it('respects global and per-domain limits', async () => {
    const q = new FetchQueue({ global: 3, perDomain: 2 });
    const running = new Map<string, number>();
    let maxTotal = 0;
    let maxA = 0;
    const gates = Array.from({ length: 6 }, deferred);
    gates.forEach((g, i) => {
      const domain = i < 4 ? 'a.com' : 'b.com';
      q.push(domain, async () => {
        running.set(domain, (running.get(domain) ?? 0) + 1);
        maxTotal = Math.max(maxTotal, [...running.values()].reduce((x, y) => x + y, 0));
        maxA = Math.max(maxA, running.get('a.com') ?? 0);
        await g.promise;
        running.set(domain, running.get(domain)! - 1);
      });
    });
    gates.forEach((g) => g.resolve());
    await q.onIdle();
    expect(maxTotal).toBeLessThanOrEqual(3);
    expect(maxA).toBeLessThanOrEqual(2);
  });

  it('keeps going when a task throws', async () => {
    const q = new FetchQueue({ global: 1, perDomain: 1 });
    let ran = false;
    q.push('a', async () => { throw new Error('boom'); });
    q.push('a', async () => { ran = true; });
    await q.onIdle();
    expect(ran).toBe(true);
  });

  it('refuses work past maxWaiting', () => {
    const q = new FetchQueue({ global: 1, perDomain: 1, maxWaiting: 1 });
    const never = () => new Promise<void>(() => {});
    expect(q.push('a', never)).toBe(true); // running
    expect(q.push('a', never)).toBe(true); // waiting
    expect(q.push('a', never)).toBe(false);
  });
});

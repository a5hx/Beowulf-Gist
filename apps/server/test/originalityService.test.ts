import { describe, expect, it, vi } from 'vitest';
import type { Layer3Result } from '@gist/shared';
import type { FingerprintMatches } from '@gist/layer3';
import { createOriginalityService, MEMO_MAX_AGE_MS } from '../src/originalityService';

const now = new Date('2026-09-30T00:00:00Z');
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const copied: FingerprintMatches = {
  own: { count: 100, domain: 'me.com', publishedAt: null },
  matches: [...range(80).map((h) => ({ hash: h, domain: 'a.com', publishedAt: null, thin: false })), { hash: 1, domain: 'b.com', publishedAt: null, thin: false }],
};
const sparse: FingerprintMatches = { own: { count: 10, domain: 'me.com', publishedAt: null }, matches: [] };

function setup(over: Partial<{ memo: Map<string, Layer3Result>; matches: (u: string) => Promise<FingerprintMatches | null>; memoFails: boolean }> = {}) {
  const repo = {
    getOriginalityMemo: vi.fn(async () => {
      if (over.memoFails) throw new Error('db');
      return over.memo ?? new Map<string, Layer3Result>();
    }),
    putOriginalityMemo: vi.fn(async () => {}),
    fingerprintMatches: vi.fn(over.matches ?? (async () => copied)),
  };
  return { svc: createOriginalityService({ repo, now: () => now }), repo };
}

describe('originality service', () => {
  it('computes on a memo miss and memoizes enough-evidence results', async () => {
    const { svc, repo } = setup();
    const r = await svc.forUrls(['https://me.com/a']);
    expect(r.get('https://me.com/a')).toMatchObject({ evidence: 'enough', coverage: 0.8 });
    expect(repo.getOriginalityMemo).toHaveBeenCalledWith(['https://me.com/a'], '1.0.0', MEMO_MAX_AGE_MS);
    expect(repo.putOriginalityMemo).toHaveBeenCalledTimes(1);
  });

  it('uses memo hits without recomputing', async () => {
    const hit = { evidence: 'enough', coverage: 0.3 } as Layer3Result;
    const { svc, repo } = setup({ memo: new Map([['https://me.com/a', hit]]) });
    expect((await svc.forUrls(['https://me.com/a'])).get('https://me.com/a')).toBe(hit);
    expect(repo.fingerprintMatches).not.toHaveBeenCalled();
  });

  it('does not memoize insufficient results (siblings may be indexed moments later)', async () => {
    const { svc, repo } = setup({ matches: async () => sparse });
    expect((await svc.forUrls(['https://me.com/a'])).get('https://me.com/a')?.evidence).toBe('insufficient');
    expect(repo.putOriginalityMemo).not.toHaveBeenCalled();
  });

  it('omits URLs without fingerprints or whose computation fails, and never throws', async () => {
    const { svc } = setup({
      matches: async (u) => (u.includes('none') ? null : u.includes('bad') ? Promise.reject(new Error('x')) : copied),
      memoFails: true,
    });
    const r = await svc.forUrls(['https://none.com/', 'https://bad.com/', 'https://ok.com/']);
    expect([...r.keys()]).toEqual(['https://ok.com/']);
  });

  it('computes URLs concurrently, at most 5 at a time (final review #8)', async () => {
    let inFlight = 0;
    let peak = 0;
    const { svc } = setup({
      matches: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return copied;
      },
    });
    const urls = Array.from({ length: 12 }, (_, i) => `https://s${i}.com/`);
    expect((await svc.forUrls(urls)).size).toBe(12);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(5);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { Layer1Result } from '@gist/shared';
import { FetchQueue } from '../src/queue';
import type { StoredScore } from '../src/repo';
import { createScoreService } from '../src/scoreService';
import type { FetchOutcome } from '../src/fetcher/fetchPage';

const fakeResult: Layer1Result = {
  layer1Version: '1.0.0',
  dimensions: { info: { score: 70, signals: [] }, human: { score: 70, signals: [] }, monetization: { score: 70, signals: [] } },
  styleAdjust: 0, styleSignals: [], fetchedAt: '2026-09-29T00:00:00.000Z',
};

function setup(fetchImpl: (url: string) => Promise<FetchOutcome>, score = (_h: string, _a: Date) => fakeResult) {
  const store = new Map<string, StoredScore>();
  const failures: [string, string][] = [];
  const repo = {
    getScores: vi.fn(async (urls: string[]) => new Map(urls.filter((u) => store.has(u)).map((u) => [u, store.get(u)!]))),
    putScore: vi.fn(async (s: StoredScore) => { store.set(s.urlNorm, s); }),
    recordFailure: vi.fn(async (d: string, r: string) => { failures.push([d, r]); }),
  };
  const queue = new FetchQueue({ global: 5, perDomain: 2 });
  const fetchPage = vi.fn(fetchImpl);
  const svc = createScoreService({ repo, queue, fetchPage, score, now: () => new Date('2026-09-29T00:00:00Z'), version: '1.0.0' });
  return { svc, queue, repo, fetchPage, failures };
}

describe('scoreService', () => {
  it('returns pending on a miss, then ready once fetched', async () => {
    const { svc, queue } = setup(async () => ({ ok: true, html: '<p>x</p>', finalUrl: 'https://a.com/' }));
    expect(await svc.lookup(['https://a.com/'])).toEqual({ 'https://a.com/': { status: 'pending' } });
    await queue.onIdle();
    expect(await svc.lookup(['https://a.com/'])).toEqual({ 'https://a.com/': { status: 'ready', layer1: fakeResult } });
  });

  it('fetches a URL only once even if asked repeatedly while in flight', async () => {
    const { svc, queue, fetchPage } = setup(async () => ({ ok: true, html: '', finalUrl: '' }));
    await svc.lookup(['https://a.com/']);
    await svc.lookup(['https://a.com/']);
    await queue.onIdle();
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('stores failures with reason and counts them by registrable domain', async () => {
    const { svc, queue, failures } = setup(async () => ({ ok: false, reason: 'blocked_challenge' }));
    await svc.lookup(['https://www.shop.example.co.uk/p']);
    await queue.onIdle();
    expect(await svc.lookup(['https://www.shop.example.co.uk/p'])).toEqual({
      'https://www.shop.example.co.uk/p': { status: 'failed', reason: 'blocked_challenge' },
    });
    expect(failures).toEqual([['example.co.uk', 'blocked_challenge']]);
  });

  it('records parse failures when the scorer throws', async () => {
    const { svc, queue } = setup(async () => ({ ok: true, html: '', finalUrl: '' }), () => { throw new Error('bad'); });
    await svc.lookup(['https://a.com/']);
    await queue.onIdle();
    expect((await svc.lookup(['https://a.com/']))['https://a.com/']).toEqual({ status: 'failed', reason: 'parse' });
  });

  it('answers keyed by the URL as sent, and rejects non-http URLs without fetching', async () => {
    const { svc, fetchPage } = setup(async () => ({ ok: true, html: '', finalUrl: '' }));
    const res = await svc.lookup(['HTTPS://A.com/x#frag', 'javascript:alert(1)']);
    expect(res['HTTPS://A.com/x#frag']).toEqual({ status: 'pending' });
    expect(res['javascript:alert(1)']).toEqual({ status: 'failed', reason: 'ssrf' });
    expect(fetchPage).toHaveBeenCalledWith('https://a.com/x');
  });
});

import { normalizeUrl, registrableDomain, type FailReason, type Layer1Result, type ScoreItem } from '@gist/shared';
import type { FetchOutcome } from './fetcher/fetchPage';
import type { FetchQueue } from './queue';
import type { Repo } from './repo';

export type ScoreService = { lookup(urls: string[]): Promise<Record<string, ScoreItem>> };

export function createScoreService(deps: {
  repo: Pick<Repo, 'getScores' | 'putScore' | 'recordFailure'>;
  queue: FetchQueue;
  fetchPage: (url: string) => Promise<FetchOutcome>;
  score: (html: string, at: Date) => Layer1Result;
  now: () => Date;
  version: string;
}): ScoreService {
  const inflight = new Set<string>();

  const domainOf = (url: string) => registrableDomain(url) ?? new URL(url).hostname;

  async function fail(url: string, reason: FailReason) {
    await deps.repo.putScore({ urlNorm: url, layer1Version: deps.version, status: 'failed', result: null, failReason: reason, fetchedAt: deps.now() });
    await deps.repo.recordFailure(domainOf(url), reason);
  }

  function enqueue(url: string) {
    if (inflight.has(url)) return;
    inflight.add(url);
    const accepted = deps.queue.push(domainOf(url), async () => {
      try {
        const out = await deps.fetchPage(url);
        if (!out.ok) return await fail(url, out.reason);
        let result: Layer1Result;
        try {
          result = deps.score(out.html, deps.now());
        } catch {
          return await fail(url, 'parse');
        }
        await deps.repo.putScore({ urlNorm: url, layer1Version: deps.version, status: 'ready', result, failReason: null, fetchedAt: deps.now() });
      } finally {
        inflight.delete(url);
      }
    });
    if (!accepted) inflight.delete(url);
  }

  return {
    async lookup(rawUrls) {
      const out: Record<string, ScoreItem> = {};
      const norm = new Map<string, string>();
      for (const raw of rawUrls) {
        const n = normalizeUrl(raw);
        if (n) norm.set(raw, n);
        else out[raw] = { status: 'failed', reason: 'ssrf' };
      }
      const stored = await deps.repo.getScores([...new Set(norm.values())], deps.version);
      for (const [raw, n] of norm) {
        const s = stored.get(n);
        if (s?.status === 'ready' && s.result) out[raw] = { status: 'ready', layer1: s.result };
        else if (s?.status === 'failed' && s.failReason) out[raw] = { status: 'failed', reason: s.failReason };
        else {
          out[raw] = { status: 'pending' };
          enqueue(n);
        }
      }
      return out;
    },
  };
}

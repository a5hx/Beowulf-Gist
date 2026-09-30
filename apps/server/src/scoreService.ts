import { indexDomain, normalizeUrl, registrableDomain, type FailReason, type Layer3Result, type ScoreItem } from '@gist/shared';
import type { PageAnalysis } from './analyze';
import type { FetchOutcome } from './fetcher/fetchPage';
import type { FetchQueue } from './queue';
import type { Repo } from './repo';

export type ScoreService = { lookup(urls: string[]): Promise<Record<string, ScoreItem>> };

export function createScoreService(deps: {
  repo: Pick<Repo, 'getScores' | 'putScore' | 'recordFailure' | 'replaceFingerprints'>;
  queue: FetchQueue;
  fetchPage: (url: string) => Promise<FetchOutcome>;
  analyze: (html: string, at: Date, pageUrl?: string) => PageAnalysis;
  now: () => Date;
  version: string;
  originality?: { forUrls(urls: string[]): Promise<Map<string, Layer3Result>> };
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
        let analysis: PageAnalysis;
        try {
          analysis = deps.analyze(out.html, deps.now(), out.finalUrl || url);
        } catch {
          return await fail(url, 'parse');
        }
        await deps.repo.putScore({ urlNorm: url, layer1Version: deps.version, status: 'ready', result: analysis.layer1, failReason: null, fetchedAt: deps.now() });
        if (analysis.index) {
          await deps.repo
            .replaceFingerprints(url, indexDomain(url) ?? domainOf(url), analysis.index.publishedAt, analysis.index.hashes, deps.now(), {
              thin: analysis.index.thin,
              canonical: analysis.index.canonical,
            })
            .catch(() => {}); // the originality index is best-effort; Layer 1 is already stored
        }
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
      const ready: string[] = [];
      for (const [raw, n] of norm) {
        const s = stored.get(n);
        if (s?.status === 'ready' && s.result) {
          out[raw] = { status: 'ready', layer1: s.result };
          ready.push(n);
        } else if (s?.status === 'failed' && s.failReason) out[raw] = { status: 'failed', reason: s.failReason };
        else {
          out[raw] = { status: 'pending' };
          enqueue(n);
        }
      }
      if (deps.originality && ready.length > 0) {
        const l3 = await deps.originality.forUrls([...new Set(ready)]).catch(() => new Map<string, Layer3Result>());
        for (const [raw, n] of norm) {
          const item = out[raw];
          const r = l3.get(n);
          if (item?.status === 'ready' && r) out[raw] = { ...item, layer3: r };
        }
      }
      return out;
    },
  };
}

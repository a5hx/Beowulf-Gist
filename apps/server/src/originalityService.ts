import { LAYER3_VERSION, originality } from '@gist/layer3';
import type { Layer3Result } from '@gist/shared';
import type { Repo } from './repo';

export const MEMO_MAX_AGE_MS = 6 * 3600 * 1000;
const CONCURRENCY = 5;

/** Originality computed at read time (siblings may be indexed after this page), memoized only when conclusive. */
export function createOriginalityService(d: {
  repo: Pick<Repo, 'getOriginalityMemo' | 'putOriginalityMemo' | 'fingerprintMatches'>;
  now: () => Date;
}) {
  return {
    async forUrls(urls: string[]): Promise<Map<string, Layer3Result>> {
      const out = new Map<string, Layer3Result>();
      if (urls.length === 0) return out;
      let memo = new Map<string, Layer3Result>();
      try {
        memo = await d.repo.getOriginalityMemo(urls, LAYER3_VERSION, MEMO_MAX_AGE_MS);
      } catch {
        // memo unavailable: compute fresh
      }
      const results: (Layer3Result | undefined)[] = new Array(urls.length);
      const one = async (url: string): Promise<Layer3Result | undefined> => {
        const hit = memo.get(url);
        if (hit) return hit;
        try {
          const matches = await d.repo.fingerprintMatches(url);
          if (!matches) return undefined;
          const result = originality({ ...matches, now: d.now() });
          if (result.evidence === 'enough') await d.repo.putOriginalityMemo(url, LAYER3_VERSION, result, d.now()).catch(() => {});
          return result;
        } catch {
          return undefined; // leave layer3 off for this URL (spec §10)
        }
      };
      // Bounded concurrency: a results page's URLs are independent lookups on the /score critical path.
      let next = 0;
      const worker = async () => {
        while (next < urls.length) {
          const i = next++;
          results[i] = await one(urls[i]!);
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
      urls.forEach((url, i) => {
        const r = results[i];
        if (r) out.set(url, r);
      });
      return out;
    },
  };
}

import { combine } from '@gist/combiner';
import type { FlagVerdict, Layer1Result, Layer3Result, ListEntry, ScoreItem, Verdict } from '@gist/shared';
import type { Api } from './api';
import type { Fallback } from './fallback';

/** Sleeps between polls, so checks land at roughly 1.5 s, 4 s and 8 s after the first response (spec §5.3). */
export const POLL_DELAYS = [1500, 2500, 4000];
const BATCH = 20;

export function createOrchestrator(d: {
  api: Pick<Api, 'score'>;
  match: (url: string) => ListEntry | null;
  override: (url: string) => Promise<FlagVerdict | null>;
  greenDot: () => Promise<boolean>;
  fallback: Fallback;
  sleep: (ms: number) => Promise<void>;
}) {
  const cache = new Map<string, { layer1: Layer1Result; layer3: Layer3Result | null }>();

  async function verdict(url: string): Promise<Verdict> {
    const hit = cache.get(url);
    const layer1 = hit?.layer1 ?? (await d.fallback.cached(url));
    return combine({ layer1, layer3: hit?.layer3 ?? null, entry: d.match(url), override: await d.override(url), greenDot: await d.greenDot() });
  }

  async function verdicts(urls: string[]): Promise<Record<string, Verdict>> {
    const out: Record<string, Verdict> = {};
    for (const u of urls) out[u] = await verdict(u);
    return out;
  }

  async function run(input: string[], emit: (v: Record<string, Verdict>) => void): Promise<void> {
    const urls = [...new Set(input)];
    const safeEmit = async (list: string[]) => {
      try {
        emit(await verdicts(list));
        return true;
      } catch {
        return false; // port closed: stop working for this page
      }
    };
    if (!(await safeEmit(urls))) return;

    let pending: string[] = [];
    for (const u of urls) if (!cache.has(u) && !(await d.fallback.cached(u))) pending.push(u);
    const failed: string[] = [];
    let readyThisRun = 0;

    for (let attempt = 0; attempt <= POLL_DELAYS.length && pending.length > 0; attempt++) {
      if (attempt > 0) await d.sleep(POLL_DELAYS[attempt - 1]!);
      const results: Record<string, ScoreItem> = {};
      try {
        for (let i = 0; i < pending.length; i += BATCH) Object.assign(results, await d.api.score(pending.slice(i, i + BATCH)));
      } catch {
        break;
      }
      const ready: string[] = [];
      const next: string[] = [];
      for (const u of pending) {
        const r = results[u];
        if (r?.status === 'ready') {
          if (cache.size > 2000) cache.clear();
          cache.set(u, { layer1: r.layer1, layer3: r.layer3 ?? null });
          ready.push(u);
          readyThisRun++;
        } else if (r?.status === 'failed') failed.push(u);
        else next.push(u);
      }
      if (ready.length > 0 && !(await safeEmit(ready))) return;
      pending = next;
    }

    // Originality is computed at read time, so a page read before its siblings were indexed came back without
    // evidence. If siblings became ready during this run, ask once more for the pages that lacked evidence.
    if (readyThisRun > 1) {
      const recheck = urls.filter((u) => {
        const hit = cache.get(u);
        return !!hit && hit.layer3?.evidence !== 'enough';
      });
      const improved: string[] = [];
      try {
        for (let i = 0; i < recheck.length; i += BATCH) {
          const res = await d.api.score(recheck.slice(i, i + BATCH));
          for (const u of recheck.slice(i, i + BATCH)) {
            const r = res[u];
            if (r?.status === 'ready' && r.layer3?.evidence === 'enough') {
              cache.set(u, { layer1: r.layer1, layer3: r.layer3 });
              improved.push(u);
            }
          }
        }
      } catch {
        // offline: keep what we have
      }
      if (improved.length > 0 && !(await safeEmit(improved))) return;
    }

    if (failed.length > 0 && (await d.fallback.enabled())) {
      for (const u of failed) {
        if ((await d.fallback.score(u)) && !(await safeEmit([u]))) return;
      }
    }
  }

  /**
   * Like verdict(), but on a cache miss asks the server once (usually a server cache hit). Used after a flag:
   * the MV3 worker may have been recycled since the page was scored, taking the in-memory cache with it.
   */
  async function refresh(url: string): Promise<Verdict> {
    if (!cache.has(url) && !(await d.fallback.cached(url))) {
      try {
        const r = (await d.api.score([url]))[url];
        if (r?.status === 'ready') cache.set(url, { layer1: r.layer1, layer3: r.layer3 ?? null });
      } catch {
        // offline: fall back to whatever list/override info we have
      }
    }
    return verdict(url);
  }

  return { run, verdict, refresh };
}

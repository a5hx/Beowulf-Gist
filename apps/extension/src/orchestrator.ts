import { combine } from '@gist/combiner';
import type { FlagVerdict, Layer1Result, ListEntry, ScoreItem, Verdict } from '@gist/shared';
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
  const cache = new Map<string, Layer1Result>();

  async function verdict(url: string): Promise<Verdict> {
    const layer1 = cache.get(url) ?? (await d.fallback.cached(url));
    return combine({ layer1, entry: d.match(url), override: await d.override(url), greenDot: await d.greenDot() });
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
          cache.set(u, r.layer1);
          ready.push(u);
        } else if (r?.status === 'failed') failed.push(u);
        else next.push(u);
      }
      if (ready.length > 0 && !(await safeEmit(ready))) return;
      pending = next;
    }

    if (failed.length > 0 && (await d.fallback.enabled())) {
      for (const u of failed) {
        if ((await d.fallback.score(u)) && !(await safeEmit([u]))) return;
      }
    }
  }

  return { run, verdict };
}

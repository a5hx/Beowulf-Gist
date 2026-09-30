import type { Layer1Result } from '@gist/shared';
import type { KV } from './kv';

const KEY = 'fallback';
const TTL = 14 * 24 * 60 * 60 * 1000;
const MAX = 500;
type Stored = Record<string, { result: Layer1Result; at: number }>;

export type Fallback = {
  cached(url: string): Promise<Layer1Result | null>;
  enabled(): Promise<boolean>;
  score(url: string): Promise<Layer1Result | null>;
};

/** Scores pages the server could not fetch, on this device only; results are never uploaded (spec D1). */
export function createFallback(deps: {
  kv: KV;
  hasPermission: () => Promise<boolean>;
  fetchHtml: (url: string) => Promise<string | null>;
  score: (html: string, at: Date) => Layer1Result;
  now: () => number;
}): Fallback {
  return {
    async cached(url) {
      const e = (await deps.kv.get<Stored>(KEY))?.[url];
      return e && deps.now() - e.at < TTL ? e.result : null;
    },
    enabled: () => deps.hasPermission(),
    async score(url) {
      if (!(await deps.hasPermission())) return null;
      const html = await deps.fetchHtml(url);
      if (html === null) return null;
      let result: Layer1Result;
      try {
        result = deps.score(html, new Date(deps.now()));
      } catch {
        return null;
      }
      const all: Stored = { ...(await deps.kv.get<Stored>(KEY)) };
      delete all[url];
      all[url] = { result, at: deps.now() };
      const keys = Object.keys(all);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX))) delete all[k];
      await deps.kv.set(KEY, all);
      return result;
    },
  };
}

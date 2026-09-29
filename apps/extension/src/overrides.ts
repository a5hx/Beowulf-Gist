import type { FlagVerdict } from '@gist/shared';
import type { KV } from './kv';

const KEY = 'overrides';
const MAX = 5000;
type Stored = Record<string, FlagVerdict>;

export async function getOverride(kv: KV, url: string): Promise<FlagVerdict | null> {
  return (await kv.get<Stored>(KEY))?.[url] ?? null;
}

/** Most recent flag wins; the oldest entries are evicted past MAX (object keys keep insertion order). */
export async function setOverride(kv: KV, url: string, verdict: FlagVerdict, max = MAX): Promise<void> {
  const all: Stored = { ...(await kv.get<Stored>(KEY)) };
  delete all[url];
  all[url] = verdict;
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) delete all[k];
  await kv.set(KEY, all);
}

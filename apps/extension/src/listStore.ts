import { createMatcher, listBundleSchema, type ListBundle, type ListEntry } from '@gist/shared';
import type { Api } from './api';
import type { KV } from './kv';

type Stored = { bundle: ListBundle; etag: string | null; syncedAt: number };

export type ListStore = {
  load(): Promise<void>;
  current(): ListBundle;
  match(url: string): ListEntry | null;
  sync(): Promise<'updated' | 'unchanged' | 'failed'>;
  lastSyncedAt(): number;
};

export function createListStore(deps: { kv: KV; api: Pick<Api, 'lists'>; bundled: ListBundle; now: () => number }): ListStore {
  let state: Stored = { bundle: deps.bundled, etag: null, syncedAt: 0 };
  let matcher = createMatcher(state.bundle.domains);
  const apply = (s: Stored) => {
    state = s;
    matcher = createMatcher(s.bundle.domains);
  };

  return {
    async load() {
      const s = await deps.kv.get<Stored>('lists');
      if (s && listBundleSchema.safeParse(s.bundle).success) apply(s);
    },
    current: () => state.bundle,
    match: (url) => matcher(url),
    lastSyncedAt: () => state.syncedAt,
    async sync() {
      try {
        const r = await deps.api.lists(state.etag);
        if (r.status === 304) {
          apply({ ...state, syncedAt: deps.now() });
          await deps.kv.set('lists', state);
          return 'unchanged';
        }
        const parsed = listBundleSchema.safeParse(r.bundle);
        if (!parsed.success) return 'failed';
        apply({ bundle: parsed.data, etag: r.etag, syncedAt: deps.now() });
        await deps.kv.set('lists', state);
        return 'updated';
      } catch {
        return 'failed';
      }
    },
  };
}

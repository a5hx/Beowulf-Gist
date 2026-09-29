import type { FlagReason, FlagVerdict, ScoreItem } from '@gist/shared';

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`api responded ${status}`);
  }
}

export type Api = {
  score(urls: string[]): Promise<Record<string, ScoreItem>>;
  lists(etag: string | null): Promise<{ status: 304 } | { status: 200; bundle: unknown; etag: string | null }>;
  registerDevice(key: string): Promise<void>;
  flag(key: string, body: { url: string; verdict: FlagVerdict; reason?: FlagReason }): Promise<void>;
  event(body: { configVersion: number; event: 'no_matches' }): Promise<void>;
};

export function createApi(base: string, fetchFn: typeof fetch = (input, init) => fetch(input, init)): Api {
  const post = async (path: string, body: unknown, extraHeaders: Record<string, string> = {}) => {
    const res = await fetchFn(`${base}${path}`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ApiError(res.status);
    return res;
  };

  return {
    async score(urls) {
      const res = await post('/score', { urls });
      return ((await res.json()) as { results: Record<string, ScoreItem> }).results;
    },
    async lists(etag) {
      const res = await fetchFn(`${base}/lists`, { credentials: 'omit', headers: etag ? { 'if-none-match': etag } : {} });
      if (res.status === 304) return { status: 304 };
      if (!res.ok) throw new ApiError(res.status);
      return { status: 200, bundle: await res.json(), etag: res.headers.get('etag') };
    },
    async registerDevice(key) {
      await post('/devices', { key });
    },
    async flag(key, body) {
      await post('/flags', body, { authorization: `Device ${key}` });
    },
    async event(body) {
      await post('/events', body);
    },
  };
}

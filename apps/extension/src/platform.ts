import { browser } from 'wxt/browser';
import type { KV } from './kv';

export const browserKV: KV = {
  async get<T>(key: string) {
    return (await browser.storage.local.get(key))[key] as T | undefined;
  },
  async set<T>(key: string, value: T) {
    await browser.storage.local.set({ [key]: value });
  },
};

export function hasAllSitesPermission(): Promise<boolean> {
  return browser.permissions.contains({ origins: ['<all_urls>'] });
}

/** Device fallback fetch: no cookies (spec §8.4), html only, 3 MB cap, 8 s timeout. */
export async function fetchHtmlFromDevice(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { credentials: 'omit', redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (!res.ok || !/text\/html|application\/xhtml\+xml/i.test(res.headers.get('content-type') ?? '')) return null;
    const text = await res.text();
    return text.length > 3 * 1024 * 1024 ? null : text;
  } catch {
    return null;
  }
}

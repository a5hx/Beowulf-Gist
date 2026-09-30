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

export { fetchHtmlFromDevice } from './deviceFetch';

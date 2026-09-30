import { describe, expect, it } from 'vitest';
import config from '../wxt.config';
import { fetchHtmlFromDevice } from '../src/deviceFetch';

describe('privacy rules (spec §8)', () => {
  it('§8.4 device-fallback fetches send no cookies and accept only html', async () => {
    const calls: RequestInit[] = [];
    const fake = (async (_u: string, init: RequestInit) => {
      calls.push(init);
      return new Response('<p>hi</p>', { headers: { 'content-type': 'text/html' } });
    }) as unknown as typeof fetch;
    expect(await fetchHtmlFromDevice('https://a.com/', fake)).toBe('<p>hi</p>');
    expect(calls[0]!.credentials).toBe('omit');
    const json = (async () => Response.json({})) as unknown as typeof fetch;
    expect(await fetchHtmlFromDevice('https://a.com/', json)).toBeNull();
  });

  it('§8.5 install-time permissions are exactly storage, alarms, activeTab + API origin; <all_urls> is optional', () => {
    const m = (config as { manifest: Record<string, unknown> }).manifest;
    expect(m.permissions).toEqual(['storage', 'alarms', 'activeTab']);
    expect(m.host_permissions).toEqual(['http://localhost:8787/*']);
    expect(m.optional_host_permissions).toEqual(['<all_urls>']);
  });
});

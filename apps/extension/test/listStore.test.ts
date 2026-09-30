import { describe, expect, it, vi } from 'vitest';
import type { ListBundle } from '@gist/shared';
import { memoryKV } from '../src/kv';
import { createListStore } from '../src/listStore';

const selectors = { version: 1, result: '#rso div.g', title: 'h3', exclude: [] };
const bundled: ListBundle = { version: 'bundled', domains: [], selectors };
const remote: ListBundle = {
  version: 'remote1',
  domains: [{ match: 'farm.com', matchLevel: 'domain', kind: 'farm', siteBehavior: 10, reasons: ['r'], source: 'seed' }],
  selectors: { ...selectors, version: 2 },
};

describe('listStore', () => {
  it('starts from the bundled copy', () => {
    const s = createListStore({ kv: memoryKV(), api: { lists: vi.fn() }, bundled, now: () => 0 });
    expect(s.current().version).toBe('bundled');
    expect(s.match('https://farm.com/')).toBeNull();
  });

  it('sync applies a valid remote bundle, persists it and survives reload', async () => {
    const kv = memoryKV();
    const api = { lists: vi.fn(async () => ({ status: 200 as const, bundle: remote, etag: '"remote1"' })) };
    const s = createListStore({ kv, api, bundled, now: () => 1000 });
    expect(await s.sync()).toBe('updated');
    expect(s.match('https://www.farm.com/x')?.kind).toBe('farm');
    expect(s.lastSyncedAt()).toBe(1000);

    const reloaded = createListStore({ kv, api, bundled, now: () => 2000 });
    await reloaded.load();
    expect(reloaded.current().version).toBe('remote1');
  });

  it('sends the stored etag and treats 304 as unchanged', async () => {
    const kv = memoryKV();
    const api = { lists: vi.fn().mockResolvedValueOnce({ status: 200, bundle: remote, etag: '"remote1"' }).mockResolvedValueOnce({ status: 304 }) };
    const s = createListStore({ kv, api, bundled, now: () => 0 });
    await s.sync();
    expect(await s.sync()).toBe('unchanged');
    expect(api.lists).toHaveBeenLastCalledWith('"remote1"');
    expect(s.current().version).toBe('remote1');
  });

  it('keeps the last good bundle when the remote one is invalid or the request fails', async () => {
    const api = { lists: vi.fn().mockResolvedValueOnce({ status: 200, bundle: { version: 'bad' }, etag: null }).mockRejectedValueOnce(new Error('offline')) };
    const s = createListStore({ kv: memoryKV(), api, bundled, now: () => 0 });
    expect(await s.sync()).toBe('failed');
    expect(await s.sync()).toBe('failed');
    expect(s.current().version).toBe('bundled');
  });

  it('ignores corrupted persisted state on load', async () => {
    const kv = memoryKV({ lists: { bundle: { nope: true }, etag: null, syncedAt: 1 } });
    const s = createListStore({ kv, api: { lists: vi.fn() }, bundled, now: () => 0 });
    await s.load();
    expect(s.current().version).toBe('bundled');
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { Layer1Result } from '@gist/shared';
import { createFallback } from '../src/fallback';
import { memoryKV } from '../src/kv';

const result = { layer1Version: 't' } as Layer1Result;
const DAY = 86_400_000;

function setup(over: Partial<Parameters<typeof createFallback>[0]> = {}) {
  let t = 0;
  const deps = {
    kv: memoryKV(),
    hasPermission: vi.fn(async () => true),
    fetchHtml: vi.fn(async () => '<p>hi</p>'),
    score: vi.fn(() => result),
    now: () => t,
    ...over,
  };
  return { fb: createFallback(deps), deps, setTime: (n: number) => (t = n) };
}

describe('fallback', () => {
  it('does nothing without the optional permission', async () => {
    const { fb, deps } = setup({ hasPermission: async () => false });
    expect(await fb.score('https://a.com/')).toBeNull();
    expect(deps.fetchHtml).not.toHaveBeenCalled();
  });
  it('scores, caches for 14 days, then expires', async () => {
    const { fb, setTime } = setup();
    expect(await fb.score('https://a.com/')).toBe(result);
    setTime(13 * DAY);
    expect(await fb.cached('https://a.com/')).toEqual(result);
    setTime(15 * DAY);
    expect(await fb.cached('https://a.com/')).toBeNull();
  });
  it('returns null when the fetch fails or the scorer throws', async () => {
    expect(await setup({ fetchHtml: async () => null }).fb.score('https://a.com/')).toBeNull();
    expect(await setup({ score: () => { throw new Error('x'); } }).fb.score('https://a.com/')).toBeNull();
  });
  it('keeps at most 500 entries', async () => {
    const { fb } = setup();
    for (let i = 0; i <= 500; i++) await fb.score(`https://a.com/${i}`);
    expect(await fb.cached('https://a.com/0')).toBeNull();
    expect(await fb.cached('https://a.com/500')).toEqual(result);
  });
});

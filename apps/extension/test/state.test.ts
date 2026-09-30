import { describe, expect, it } from 'vitest';
import { addDimmed, getDimmed } from '../src/counter';
import { memoryKV } from '../src/kv';
import { getOverride, setOverride } from '../src/overrides';
import { DEFAULT_SETTINGS, getSettings, isPaused, togglePause, updateSettings } from '../src/settings';

describe('settings', () => {
  it('defaults, merges patches and toggles pause per host', async () => {
    const kv = memoryKV();
    expect(await getSettings(kv)).toEqual(DEFAULT_SETTINGS);
    await updateSettings(kv, { greenDot: true });
    expect((await getSettings(kv)).greenDot).toBe(true);
    let s = await togglePause(kv, 'WWW.Google.com');
    expect(isPaused(s, 'www.google.com')).toBe(true);
    s = await togglePause(kv, 'www.google.com');
    expect(isPaused(s, 'www.google.com')).toBe(false);
  });
});

describe('overrides', () => {
  it('stores the latest verdict per url and caps the map size', async () => {
    const kv = memoryKV();
    await setOverride(kv, 'https://a.com/', 'slop');
    await setOverride(kv, 'https://a.com/', 'fine');
    expect(await getOverride(kv, 'https://a.com/')).toBe('fine');
    expect(await getOverride(kv, 'https://b.com/')).toBeNull();
    for (let i = 0; i < 3; i++) await setOverride(kv, `https://x.com/${i}`, 'slop', 3);
    expect(await getOverride(kv, 'https://a.com/')).toBeNull(); // oldest evicted past max
    expect(await getOverride(kv, 'https://x.com/2')).toBe('slop');
  });
});

describe('dimmed counter', () => {
  it('counts per UTC day and resets the next day', async () => {
    const kv = memoryKV();
    await addDimmed(kv, 2, new Date('2026-09-29T10:00:00Z'));
    await addDimmed(kv, 1, new Date('2026-09-29T23:00:00Z'));
    expect(await getDimmed(kv, new Date('2026-09-29T23:30:00Z'))).toBe(3);
    expect(await getDimmed(kv, new Date('2026-09-30T00:01:00Z'))).toBe(0);
    await addDimmed(kv, 1, new Date('2026-09-30T00:02:00Z'));
    expect(await getDimmed(kv, new Date('2026-09-30T00:03:00Z'))).toBe(1);
  });
});

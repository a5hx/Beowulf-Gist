import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api';
import { createFlagSender } from '../src/flagSender';
import { memoryKV } from '../src/kv';

const flag = { url: 'https://farm.com/x', verdict: 'slop' as const, reason: 'filler' as const };

describe('flagSender', () => {
  it('sends with the registered device key', async () => {
    const kv = memoryKV();
    const api = { registerDevice: vi.fn(async () => {}), flag: vi.fn(async () => {}) };
    await createFlagSender({ kv, api }).send(flag);
    expect(api.flag).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/), flag);
    expect(await kv.get('flagQueue')).toBeUndefined();
  });

  it('queues when registration failed (offline at install), then flushes later', async () => {
    const kv = memoryKV();
    const api = { registerDevice: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined), flag: vi.fn(async () => {}) };
    const sender = createFlagSender({ kv, api });
    await sender.send(flag);
    expect(api.flag).not.toHaveBeenCalled();
    expect(await kv.get('flagQueue')).toEqual([flag]);
    await sender.flush();
    expect(api.flag).toHaveBeenCalledTimes(1);
    expect(await kv.get('flagQueue')).toEqual([]);
  });

  it('re-registers after a 401 (server lost the device) and retries', async () => {
    const kv = memoryKV();
    const api = { registerDevice: vi.fn(async () => {}), flag: vi.fn().mockRejectedValueOnce(new ApiError(401)).mockResolvedValue(undefined) };
    const sender = createFlagSender({ kv, api });
    await sender.send(flag);
    expect(await kv.get('flagQueue')).toEqual([flag]);
    await sender.flush();
    expect(api.registerDevice).toHaveBeenCalledTimes(2);
    expect(await kv.get('flagQueue')).toEqual([]);
  });

  it('drops flags the server rejects as invalid (400), keeps rate-limited ones (429)', async () => {
    const kv = memoryKV();
    const api = { registerDevice: vi.fn(async () => {}), flag: vi.fn().mockRejectedValueOnce(new ApiError(400)).mockRejectedValueOnce(new ApiError(429)) };
    const sender = createFlagSender({ kv, api });
    await sender.send(flag);
    expect(await kv.get('flagQueue')).toBeUndefined();
    await sender.send(flag);
    expect(await kv.get('flagQueue')).toEqual([flag]);
  });

  it('does not lose flags sent concurrently while offline', async () => {
    const kv = memoryKV();
    const api = { registerDevice: vi.fn(async () => { throw new Error('offline'); }), flag: vi.fn() };
    const sender = createFlagSender({ kv, api });
    await Promise.all([1, 2, 3].map((i) => sender.send({ url: `https://a.com/${i}`, verdict: 'fine' })));
    expect(((await kv.get('flagQueue')) as unknown[]).length).toBe(3);
  });

  it('keeps a flag sent while a flush is in progress', async () => {
    const kv = memoryKV({ device: { key: 'k'.repeat(64), registered: true }, flagQueue: [flag] });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const api = {
      registerDevice: vi.fn(async () => {}),
      flag: vi.fn(async (_k: string, f: { url: string }) => {
        if (f.url === flag.url) { await gate; throw new Error('offline'); }
        throw new Error('offline');
      }),
    };
    const sender = createFlagSender({ kv, api });
    const flushing = sender.flush();
    const later = { url: 'https://b.com/', verdict: 'fine' as const };
    const sending = sender.send(later);
    release();
    await Promise.all([flushing, sending]);
    expect(await kv.get('flagQueue')).toEqual(expect.arrayContaining([flag, later]));
  });

  it('caps the queue at 200', async () => {
    const kv = memoryKV();
    const api = { registerDevice: vi.fn(async () => { throw new Error('offline'); }), flag: vi.fn() };
    const sender = createFlagSender({ kv, api });
    for (let i = 0; i < 205; i++) await sender.send({ url: `https://a.com/${i}`, verdict: 'fine' });
    expect(((await kv.get('flagQueue')) as unknown[]).length).toBe(200);
  });
});

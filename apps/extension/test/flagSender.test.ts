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

  it('caps the queue at 200', async () => {
    const kv = memoryKV();
    const api = { registerDevice: vi.fn(async () => { throw new Error('offline'); }), flag: vi.fn() };
    const sender = createFlagSender({ kv, api });
    for (let i = 0; i < 205; i++) await sender.send({ url: `https://a.com/${i}`, verdict: 'fine' });
    expect(((await kv.get('flagQueue')) as unknown[]).length).toBe(200);
  });
});

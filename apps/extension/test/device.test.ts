import { describe, expect, it, vi } from 'vitest';
import { ensureDevice, newDeviceKey } from '../src/device';
import { memoryKV } from '../src/kv';

describe('device', () => {
  it('generates 64-hex keys', () => {
    expect(newDeviceKey()).toMatch(/^[0-9a-f]{64}$/);
    expect(newDeviceKey()).not.toBe(newDeviceKey());
  });

  it('creates, registers once, and reuses the key', async () => {
    const kv = memoryKV();
    const api = { registerDevice: vi.fn(async () => {}) };
    const a = await ensureDevice(kv, api);
    const b = await ensureDevice(kv, api);
    expect(a).toEqual({ key: b.key, registered: true });
    expect(api.registerDevice).toHaveBeenCalledTimes(1);
  });

  it('keeps the key and retries registration after a failure', async () => {
    const kv = memoryKV();
    const api = { registerDevice: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined) };
    const first = await ensureDevice(kv, api);
    expect(first.registered).toBe(false);
    const second = await ensureDevice(kv, api);
    expect(second).toEqual({ key: first.key, registered: true });
  });
});

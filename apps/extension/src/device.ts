import type { Api } from './api';
import type { KV } from './kv';

export type DeviceState = { key: string; registered: boolean };

export function newDeviceKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Creates the key once; registration is retried on every call until it succeeds (offline installs). */
export async function ensureDevice(kv: KV, api: Pick<Api, 'registerDevice'>): Promise<DeviceState> {
  let state = await kv.get<DeviceState>('device');
  if (!state) {
    state = { key: newDeviceKey(), registered: false };
    await kv.set('device', state);
  }
  if (!state.registered) {
    try {
      await api.registerDevice(state.key);
      state = { ...state, registered: true };
      await kv.set('device', state);
    } catch {
      // stays unregistered; next call retries
    }
  }
  return state;
}

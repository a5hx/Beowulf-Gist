import type { FlagReason, FlagVerdict } from '@gist/shared';
import { ApiError, type Api } from './api';
import { ensureDevice, type DeviceState } from './device';
import type { KV } from './kv';

export type PendingFlag = { url: string; verdict: FlagVerdict; reason?: FlagReason };
const QUEUE = 'flagQueue';
const MAX_QUEUE = 200;

export function createFlagSender(d: { kv: KV; api: Pick<Api, 'flag' | 'registerDevice'> }) {
  /** true = done (sent, or permanently rejected); false = keep for retry. */
  async function trySend(f: PendingFlag): Promise<boolean> {
    const dev = await ensureDevice(d.kv, d.api);
    if (!dev.registered) return false;
    try {
      await d.api.flag(dev.key, f);
      return true;
    } catch (err) {
      if (!(err instanceof ApiError)) return false;
      if (err.status === 401) {
        await d.kv.set<DeviceState>('device', { ...dev, registered: false });
        return false;
      }
      return err.status >= 400 && err.status < 500 && err.status !== 429;
    }
  }

  return {
    async send(f: PendingFlag) {
      if (await trySend(f)) return;
      const q = (await d.kv.get<PendingFlag[]>(QUEUE)) ?? [];
      q.push(f);
      await d.kv.set(QUEUE, q.slice(-MAX_QUEUE));
    },
    async flush() {
      const q = (await d.kv.get<PendingFlag[]>(QUEUE)) ?? [];
      const keep: PendingFlag[] = [];
      for (const f of q) if (!(await trySend(f))) keep.push(f);
      await d.kv.set(QUEUE, keep);
    },
  };
}

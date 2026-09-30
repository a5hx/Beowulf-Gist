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

  // Every queue read-modify-write runs through this chain, so concurrent sends and flushes can't overwrite each other.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
  const edit = (fn: (q: PendingFlag[]) => PendingFlag[]) =>
    serial(async () => d.kv.set(QUEUE, fn((await d.kv.get<PendingFlag[]>(QUEUE)) ?? []).slice(-MAX_QUEUE)));

  return {
    async send(f: PendingFlag) {
      if (await trySend(f)) return;
      await edit((q) => [...q, f]);
    },
    async flush() {
      // Claim the queue, try each flag outside the lock, then put failures back ahead of anything queued meanwhile.
      let claimed: PendingFlag[] = [];
      await edit((q) => {
        claimed = q;
        return [];
      });
      const keep: PendingFlag[] = [];
      for (const f of claimed) if (!(await trySend(f))) keep.push(f);
      await edit((q) => [...keep, ...q]);
    },
  };
}

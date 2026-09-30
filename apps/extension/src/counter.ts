import type { KV } from './kv';

type Stored = { day: string; n: number };
const day = (now: Date) => now.toISOString().slice(0, 10);

export async function addDimmed(kv: KV, n: number, now: Date): Promise<void> {
  const d = day(now);
  const cur = await kv.get<Stored>('dimmed');
  await kv.set<Stored>('dimmed', { day: d, n: (cur?.day === d ? cur.n : 0) + n });
}

export async function getDimmed(kv: KV, now: Date): Promise<number> {
  const cur = await kv.get<Stored>('dimmed');
  return cur?.day === day(now) ? cur.n : 0;
}

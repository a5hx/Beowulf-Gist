import type { KV } from './kv';

export type Settings = { enabled: boolean; greenDot: boolean; pausedHosts: string[] };
export const DEFAULT_SETTINGS: Settings = { enabled: true, greenDot: false, pausedHosts: [] };

export async function getSettings(kv: KV): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await kv.get<Partial<Settings>>('settings')) };
}

export async function updateSettings(kv: KV, patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings(kv)), ...patch };
  await kv.set('settings', next);
  return next;
}

export function isPaused(s: Settings, host: string): boolean {
  return s.pausedHosts.includes(host.toLowerCase());
}

export async function togglePause(kv: KV, host: string): Promise<Settings> {
  const h = host.toLowerCase();
  const s = await getSettings(kv);
  const pausedHosts = s.pausedHosts.includes(h) ? s.pausedHosts.filter((x) => x !== h) : [...s.pausedHosts, h];
  return updateSettings(kv, { pausedHosts });
}

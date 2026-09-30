import type { ListBundle } from '@gist/shared';
import type { AppDeps } from '../../src/app';
import type { NewFlag } from '../../src/repo';

export function createMemoryRepo(bundle: ListBundle | null = null) {
  const devices = new Set<string>();
  const flags: NewFlag[] = [];
  const events: [number, string][] = [];
  const repo: AppDeps['repo'] = {
    latestBundle: async () => bundle,
    registerDevice: async (h) => { devices.add(h); },
    deviceExists: async (h) => devices.has(h),
    countFlagsToday: async (h) => flags.filter((f) => f.keyHash === h).length,
    insertFlag: async (f) => { flags.push(f); },
    recordEvent: async (v, e) => { events.push([v, e]); },
  };
  return { repo, devices, flags, events };
}

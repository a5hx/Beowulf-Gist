import { createHash } from 'node:crypto';
import { z } from 'zod';
import { listBundleSchema, listEntrySchema, selectorConfigSchema, type ListBundle, type ListEntry } from '@gist/shared';

export function buildBundle(domainFiles: { name: string; data: unknown }[], selectors: unknown): ListBundle {
  const domains: ListEntry[] = [];
  const seen = new Map<string, string>();
  for (const f of domainFiles) {
    const parsed = z.array(listEntrySchema).safeParse(f.data);
    if (!parsed.success) {
      throw new Error(`${f.name}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    for (const e of parsed.data) {
      const key = `${e.matchLevel}:${e.match}`;
      const prev = seen.get(key);
      if (prev) throw new Error(`${f.name}: duplicate entry ${key} (also in ${prev})`);
      seen.set(key, f.name);
      domains.push(e);
    }
  }
  const sel = selectorConfigSchema.parse(selectors);
  domains.sort((a, b) => a.match.localeCompare(b.match) || a.matchLevel.localeCompare(b.matchLevel));
  const version = createHash('sha256').update(JSON.stringify({ domains, selectors: sel })).digest('hex').slice(0, 12);
  return listBundleSchema.parse({ version, domains, selectors: sel });
}

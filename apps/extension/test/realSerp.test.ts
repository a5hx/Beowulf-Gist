// @vitest-environment happy-dom
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { selectorConfigSchema } from '@gist/shared';
import { readResults } from '../src/serp/reader';

// Resolve with node:path: under happy-dom the global URL is happy-dom's class, which breaks file-URL resolution.
const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'fixtures') + sep;
const cfg = selectorConfigSchema.parse(JSON.parse(readFileSync(join(here, '../../../data/selectors.json'), 'utf8')));
const files = readdirSync(dir).filter((f) => f.startsWith('serp-') && f.endsWith('.html'));

describe.skipIf(files.length === 0)('real Google SERPs', () => {
  it.each(files)('%s: finds 5+ organic results, none Google-internal, no duplicates of ads', (file) => {
    document.documentElement.innerHTML = readFileSync(`${dir}${file}`, 'utf8');
    const results = readResults(document, cfg, 'https://www.google.com/search?q=x');
    expect(results.length).toBeGreaterThanOrEqual(5);
    for (const r of results) expect(new URL(r.url).hostname).not.toMatch(/google\./);
    expect(new Set(results.map((r) => r.el)).size).toBe(results.length);
  });
});

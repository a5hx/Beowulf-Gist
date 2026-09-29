# Gist Free-Tier Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Gist free tier: a Chrome MV3 extension that scores Google results with an open-source Layer 1 heuristic package, a domain list and a scoring backend, then tags, dims or collapses results and explains why.

**Architecture:** A pnpm TypeScript monorepo. Pure packages (`@gist/shared`, `@gist/layer1`, `@gist/combiner`) hold all scoring logic and run unchanged on the server and in the extension. A Hono + Postgres backend fetches result pages once (SSRF-safe), caches Layer 1 scores per URL, and serves the domain list, selector config and flag intake. The WXT extension reads the results page, combines scores on the device and renders the UI in a Shadow DOM.

**Tech Stack:** Node 20.10+, pnpm 9, TypeScript 5.6, Vitest 2 (happy-dom for DOM tests), linkedom, tldts, zod 3, Hono 4 + @hono/node-server, postgres.js 3, undici 6, ipaddr.js 2, Testcontainers (Postgres 16), WXT 0.20, Playwright (layout check only).

**Spec:** `docs/superpowers/specs/2026-09-29-gist-free-tier-core-design.md`. Read it before starting any task. Every design decision (D1–D6), threshold and endpoint shape comes from there.

## Global Constraints

- **No git commits.** The user will commit later. Skip every commit step, and do not run `git init`.
- Node `>=20.10`. The package manager is pnpm `9.15.0`, installed with `npm install -g pnpm@9.15.0` because pnpm is not on this machine yet.
- The machine is Windows, but the Bash tool is Git Bash, so use POSIX shell syntax. In Node scripts, build paths with `fileURLToPath`, never `new URL(...).pathname`.
- Weights: info 30, originality 25, human 20, siteBehavior 15, monetization 10. Style adjustment is capped at ±5 (Layer 1 only produces values in [-5, 0]).
- Bands: 80–100 Solid, 60–79 OK, 40–59 Thin, 20–39 Filler, 0–19 Slop.
- Guardrails, in this order: farm cap 25 → human floor 50 → bands → low-confidence floor `Thin` (`LOW_CONFIDENCE_FLOOR`).
- The search query never leaves the device. `/score` requests carry no cookies, device key or query (`credentials: 'omit'`).
- Server logs never contain URLs; they log the route label only.
- Install-time permissions are exactly `storage`, `alarms`, `activeTab`, plus the API origin as a host permission, plus the Google content-script matches. `<all_urls>` is an optional host permission.
- Fetch limits: 8 s timeout, 3 MB body, 5 redirects, http/https only, text/html only, 20 global / 2 per registrable domain concurrency.
- Cache TTLs: ready scores 14 days, failures 1 day, device-fallback results 14 days.
- Any text that comes from a scored page or the domain list is rendered with `textContent`, never `innerHTML`.
- Test files live in `test/` next to `src/` in each package. Run everything with `pnpm test` from the repo root.

## Review Focus

1. **Google changes its markup and no results match.** A person expects Gist to do nothing and change nothing on the page, with a single anonymous `no_matches` report sent that day. Pinned in Task 20 (`controller.test.ts`: "reports no_matches once when #rso has no readable results").
2. **Hostile or malformed page HTML** (empty string, no `<body>`, binary junk, an author name containing `<img onerror>`). A person expects Layer 1 not to throw and the label to show page text literally. Pinned in Task 5 (`robustness.test.ts`) and Task 19 (`label.test.ts`: "renders page-derived text as text").
3. **The same URL appearing twice on one results page** (for example a top result repeated lower down, or in continuous scroll). A person expects both copies to get the same verdict. Pinned in Task 20 (`controller.test.ts`: "applies verdicts to duplicate URLs, including ones that appear later").
4. **Offline at install, or the server's device table reset (401).** A person expects their flags to be queued and sent later, never silently lost. Pinned in Task 16 (`flagSender.test.ts`: "queues when registration failed" and "re-registers after a 401").
5. **The service worker port disconnecting mid-poll** (tab closed, or the SW recycled). A person expects no unhandled errors and polling to stop. Pinned in Task 16 (`orchestrator.test.ts`: "stops quietly when emit throws").

---

## File Structure

```
package.json, pnpm-workspace.yaml, tsconfig.base.json, vitest.workspace.ts, .gitignore, .dockerignore, Dockerfile
packages/shared/        src/{index,url,domain,types,schemas}.ts                 test/
packages/layer1/        src/{index,dom,signals,info,human,monetization,style}.ts test/{fixtures.ts,*.test.ts}
packages/combiner/      src/index.ts                                             test/
apps/server/            src/{index,env,db,repo,app,rateLimit,clientIp,queue,scoreService}.ts
                        src/fetcher/{ssrf,fetchPage,robots}.ts
                        migrations/001_init.sql  scripts/{lists-publish,review}.ts  test/
apps/extension/         wxt.config.ts  entrypoints/{background.ts,google.content.ts,popup/,welcome/}
                        src/{config,google,kv,platform,settings,overrides,counter,device,api,
                             listStore,fallback,orchestrator,flagSender,messages}.ts
                        src/serp/{reader,controller,expanded,port}.ts  src/render/{styles,badge,label,apply}.ts  test/
data/                   selectors.json  domains/{farms,humans}.json  domains/README.md  bundle.json (generated)
scripts/                lists-build.ts  layout-check.ts  lib/bundle.ts  test/
eval/                   lib.ts  run-eval.ts  snapshot.ts  labels.jsonl  snapshots/ (ignored)  test/
.github/workflows/layout-check.yml
```

Each pure package exposes `src/index.ts` directly through `"exports"`; there is no build step. The server runs with `tsx`, and the extension is bundled by WXT/Vite.

---

### Task 1: Monorepo scaffold and URL normalization

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `.gitignore`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/url.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/test/url.test.ts`

**Interfaces:**
- Produces: `normalizeUrl(input: string): string | null`, exported from `@gist/shared`.

- [ ] **Step 1: Install pnpm**

Run: `npm install -g pnpm@9.15.0 && pnpm -v`
Expected: `9.15.0`

- [ ] **Step 2: Create root files**

`package.json`:
```json
{
  "name": "gist",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.15.0",
  "engines": { "node": ">=20.10" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "@types/node": "^20.17.10",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  }
}
```

`vitest.workspace.ts`:
```ts
export default ['packages/*', 'apps/*'];
```

`.gitignore`:
```
node_modules/
.output/
.wxt/
dist/
eval/snapshots/
*.log
.env
```

- [ ] **Step 3: Create the shared package skeleton**

`packages/shared/package.json`:
```json
{
  "name": "@gist/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": { "tldts": "^6.1.69", "zod": "^3.24.1" }
}
```

`packages/shared/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

- [ ] **Step 4: Write the failing test**

`packages/shared/test/url.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { normalizeUrl } from '../src/url';

describe('normalizeUrl', () => {
  it('lowercases scheme and host but keeps path case', () => {
    expect(normalizeUrl('HTTPS://Example.COM/Path')).toBe('https://example.com/Path');
  });
  it('drops the fragment and default ports', () => {
    expect(normalizeUrl('https://example.com:443/a#section')).toBe('https://example.com/a');
    expect(normalizeUrl('http://example.com:80/a')).toBe('http://example.com/a');
  });
  it('removes tracking params and sorts the rest', () => {
    expect(normalizeUrl('https://e.com/a?utm_source=x&b=2&a=1&gclid=z&fbclid=q&mc_cid=1&mc_eid=2')).toBe(
      'https://e.com/a?a=1&b=2',
    );
  });
  it('drops an empty query entirely', () => {
    expect(normalizeUrl('https://e.com/a?utm_medium=x')).toBe('https://e.com/a');
  });
  it('strips credentials', () => {
    expect(normalizeUrl('https://user:pw@e.com/a')).toBe('https://e.com/a');
  });
  it('converts IDN hosts to punycode', () => {
    expect(normalizeUrl('https://bücher.de/x')).toBe('https://xn--bcher-kva.de/x');
  });
  it('rejects non-http(s) and garbage', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('ftp://e.com/a')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });
  it('is idempotent', () => {
    const once = normalizeUrl('https://E.com/a?b=2&a=1#x')!;
    expect(normalizeUrl(once)).toBe(once);
  });
});
```

- [ ] **Step 5: Install dependencies and confirm the test fails**

Run: `pnpm install && pnpm test`
Expected: FAIL, "Failed to resolve import "../src/url"".

- [ ] **Step 6: Implement**

`packages/shared/src/url.ts`:
```ts
const TRACKING = [/^utm_/i, /^gclid$/i, /^fbclid$/i, /^mc_cid$/i, /^mc_eid$/i];

/** Canonical form used as the cache key everywhere. Returns null for anything that is not http(s). */
export function normalizeUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // URL already lowercases scheme/host, punycodes IDN hosts and drops default ports.
  u.hash = '';
  u.username = '';
  u.password = '';
  const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING.some((re) => re.test(k)));
  kept.sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);
  return u.toString();
}
```

`packages/shared/src/index.ts`:
```ts
export * from './url';
```

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `pnpm test`
Expected: PASS (8 tests).

---

### Task 2: Shared types, schemas and domain matching

**Files:**
- Create: `packages/shared/src/types.ts`, `packages/shared/src/schemas.ts`, `packages/shared/src/domain.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/domain.test.ts`, `packages/shared/test/schemas.test.ts`

**Interfaces:**
- Produces (all exported from `@gist/shared`):
  - Types: `Signal`, `DimensionResult`, `Layer1Result`, `ListEntry`, `SelectorConfig`, `ListBundle`, `FlagReason`, `FlagVerdict`, `Confidence`, `VerdictName`, `Action`, `DimensionKey`, `Verdict`, `FailReason`, `ScoreItem`
  - Schemas: `listEntrySchema`, `selectorConfigSchema`, `listBundleSchema`, `flagReasonSchema`, `flagBodySchema`, `scoreBodySchema`, `eventBodySchema`, `deviceBodySchema`
  - `registrableDomain(url: string): string | null`
  - `createMatcher(entries: readonly ListEntry[]): (url: string) => ListEntry | null`

- [ ] **Step 1: Write the failing tests**

`packages/shared/test/domain.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createMatcher, registrableDomain } from '../src/domain';
import type { ListEntry } from '../src/types';

const entry = (match: string, matchLevel: 'domain' | 'host', kind: 'farm' | 'human'): ListEntry => ({
  match, matchLevel, kind, siteBehavior: kind === 'farm' ? 10 : 90, reasons: ['r'], source: 'seed',
});

describe('registrableDomain', () => {
  it('uses the public suffix list', () => {
    expect(registrableDomain('https://www.bbc.co.uk/news')).toBe('bbc.co.uk');
    expect(registrableDomain('https://a.b.example.com/')).toBe('example.com');
  });
  it('returns null for invalid input', () => {
    expect(registrableDomain('nope')).toBeNull();
  });
});

describe('createMatcher', () => {
  const match = createMatcher([
    entry('farm.com', 'domain', 'farm'),
    entry('blogspot.com', 'domain', 'farm'),
    entry('goodcook.blogspot.com', 'host', 'human'),
  ]);

  it('matches a domain entry on any subdomain', () => {
    expect(match('https://www.farm.com/x')?.match).toBe('farm.com');
    expect(match('https://recipes.farm.com/x')?.match).toBe('farm.com');
  });
  it('prefers a host entry over a domain entry', () => {
    expect(match('https://goodcook.blogspot.com/p')?.kind).toBe('human');
  });
  it('host entries do not leak to other hosts on the platform', () => {
    expect(match('https://other.blogspot.com/p')?.kind).toBe('farm');
  });
  it('returns null when nothing matches or input is invalid', () => {
    expect(match('https://unknown.org/')).toBeNull();
    expect(match('garbage')).toBeNull();
  });
});
```

`packages/shared/test/schemas.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { flagBodySchema, listBundleSchema, listEntrySchema, scoreBodySchema } from '../src/schemas';

const selectors = { version: 1, result: '#rso div.g', title: 'h3', exclude: [] };
const goodEntry = { match: 'farm.com', matchLevel: 'domain', kind: 'farm', siteBehavior: 10, reasons: ['Mass-produced recipes'], source: 'seed' };

describe('schemas', () => {
  it('accepts a valid bundle', () => {
    expect(listBundleSchema.safeParse({ version: 'abc', domains: [goodEntry], selectors }).success).toBe(true);
  });
  it('requires siteBehavior on every entry', () => {
    const { siteBehavior: _, ...noSb } = goodEntry;
    expect(listEntrySchema.safeParse(noSb).success).toBe(false);
  });
  it('rejects uppercase or schemed matches', () => {
    expect(listEntrySchema.safeParse({ ...goodEntry, match: 'https://farm.com' }).success).toBe(false);
    expect(listEntrySchema.safeParse({ ...goodEntry, match: 'Farm.com' }).success).toBe(false);
  });
  it('requires a reason for slop flags and forbids one for fine flags', () => {
    expect(flagBodySchema.safeParse({ url: 'https://a.com', verdict: 'slop' }).success).toBe(false);
    expect(flagBodySchema.safeParse({ url: 'https://a.com', verdict: 'slop', reason: 'filler' }).success).toBe(true);
    expect(flagBodySchema.safeParse({ url: 'https://a.com', verdict: 'fine', reason: 'filler' }).success).toBe(false);
    expect(flagBodySchema.safeParse({ url: 'https://a.com', verdict: 'fine' }).success).toBe(true);
  });
  it('score body: 1–20 urls and nothing else (no query field allowed)', () => {
    expect(scoreBodySchema.safeParse({ urls: ['https://a.com'] }).success).toBe(true);
    expect(scoreBodySchema.safeParse({ urls: [] }).success).toBe(false);
    expect(scoreBodySchema.safeParse({ urls: Array(21).fill('https://a.com') }).success).toBe(false);
    expect(scoreBodySchema.safeParse({ urls: ['https://a.com'], query: 'cookies' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm test`
Expected: FAIL, "Failed to resolve import "../src/domain"".

- [ ] **Step 3: Implement**

`packages/shared/src/schemas.ts`:
```ts
import { z } from 'zod';

export const listEntrySchema = z
  .object({
    match: z.string().min(1).regex(/^[a-z0-9.-]+$/, 'lowercase hostname or domain only'),
    matchLevel: z.enum(['domain', 'host']),
    kind: z.enum(['farm', 'human']),
    siteBehavior: z.number().int().min(0).max(100),
    reasons: z.array(z.string().min(1)).min(1),
    source: z.enum(['seed', 'review']),
  })
  .strict();

export const selectorConfigSchema = z
  .object({
    version: z.number().int().positive(),
    result: z.string().min(1),
    title: z.string().min(1),
    exclude: z.array(z.string().min(1)),
  })
  .strict();

export const listBundleSchema = z
  .object({ version: z.string().min(1), domains: z.array(listEntrySchema), selectors: selectorConfigSchema })
  .strict();

export const flagReasonSchema = z.enum(['filler', 'ai_images', 'fake_reviews', 'untested_roundup', 'other']);

export const flagBodySchema = z
  .object({ url: z.string().url().max(2048), verdict: z.enum(['slop', 'fine']), reason: flagReasonSchema.optional() })
  .strict()
  .refine((b) => (b.verdict === 'slop' ? b.reason !== undefined : b.reason === undefined), {
    message: 'reason is required for slop flags and not allowed for fine flags',
  });

export const scoreBodySchema = z.object({ urls: z.array(z.string().min(1).max(2048)).min(1).max(20) }).strict();

export const eventBodySchema = z
  .object({ configVersion: z.number().int().positive(), event: z.literal('no_matches') })
  .strict();

export const deviceBodySchema = z.object({ key: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
```

`packages/shared/src/types.ts`:
```ts
import type { z } from 'zod';
import type { flagReasonSchema, listBundleSchema, listEntrySchema, selectorConfigSchema } from './schemas';

/** effect: signed points on its dimension; positive helps the grade, negative hurts it. */
export type Signal = { id: string; label: string; effect: number };
export type DimensionResult = { score: number; signals: Signal[] };

export type Layer1Result = {
  layer1Version: string;
  dimensions: { info: DimensionResult; human: DimensionResult; monetization: DimensionResult };
  styleAdjust: number;
  styleSignals: Signal[];
  fetchedAt: string;
};

export type ListEntry = z.infer<typeof listEntrySchema>;
export type SelectorConfig = z.infer<typeof selectorConfigSchema>;
export type ListBundle = z.infer<typeof listBundleSchema>;
export type FlagReason = z.infer<typeof flagReasonSchema>;
export type FlagVerdict = 'slop' | 'fine';

export type Confidence = 'high' | 'low' | 'none';
export type VerdictName = 'Solid' | 'OK' | 'Thin' | 'Filler' | 'Slop';
export type Action = 'none' | 'dot' | 'tag' | 'dim' | 'collapse';
export type DimensionKey = 'info' | 'originality' | 'human' | 'siteBehavior' | 'monetization';

export type Verdict = {
  grade: number | null;
  verdict: VerdictName | null;
  confidence: Confidence;
  action: Action;
  dimensions: Record<DimensionKey, number | null>;
  reasons: Signal[];
  userOverride: FlagVerdict | null;
};

export type FailReason =
  | 'timeout'
  | 'network'
  | `http_${number}`
  | 'blocked_challenge'
  | 'robots'
  | 'too_large'
  | 'not_html'
  | 'ssrf'
  | 'parse';

export type ScoreItem =
  | { status: 'ready'; layer1: Layer1Result }
  | { status: 'pending' }
  | { status: 'failed'; reason: FailReason };
```

`packages/shared/src/domain.ts`:
```ts
import { getDomain, getHostname } from 'tldts';
import type { ListEntry } from './types';

export function registrableDomain(url: string): string | null {
  return getDomain(url)?.toLowerCase() ?? null;
}

/** Builds an O(1) matcher. Host-level entries win over domain-level ones (spec §4.3). */
export function createMatcher(entries: readonly ListEntry[]): (url: string) => ListEntry | null {
  const hosts = new Map<string, ListEntry>();
  const domains = new Map<string, ListEntry>();
  for (const e of entries) (e.matchLevel === 'host' ? hosts : domains).set(e.match, e);
  return (url) => {
    const host = getHostname(url)?.toLowerCase();
    if (!host || !host.includes('.')) return null;
    const hostHit = hosts.get(host);
    if (hostHit) return hostHit;
    const domain = getDomain(url)?.toLowerCase();
    return (domain && domains.get(domain)) || null;
  };
}
```

`packages/shared/src/index.ts`:
```ts
export * from './url';
export * from './types';
export * from './schemas';
export * from './domain';
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm test`
Expected: PASS (all shared tests). Also run `pnpm --filter @gist/shared typecheck`. Expected: no errors.

---
### Task 3: Layer 1 page context and the information-value dimension

**Files:**
- Create: `packages/layer1/package.json`, `packages/layer1/tsconfig.json`
- Create: `packages/layer1/src/dom.ts`, `packages/layer1/src/signals.ts`, `packages/layer1/src/info.ts`
- Create: `packages/layer1/test/fixtures.ts`
- Test: `packages/layer1/test/info.test.ts`

**Interfaces:**
- Consumes: `DimensionResult`, `Signal` from `@gist/shared`.
- Produces:
  - `buildContext(html: string): PageContext`, where `PageContext = { document: Document; main: Element; mainText: string; mainWords: number; bodyWords: number; blocks: Element[] }`
  - `wordCount(text: string): number`
  - `clamp(n, lo = 0, hi = 100)`, `lerpScore(value, zeroAt, fullAt): number` (0–100), `signal(id, label, effect): Signal`
  - `countSpecifics(text: string): number`, `scoreInfo(ctx: PageContext): DimensionResult`
  - Test fixtures (exported through `@gist/layer1/fixtures` for later tasks): `page`, `farmRecipe`, `blogRecipe`, `forumThread`, `nonNativeHowTo`, `tinyPage`

- [ ] **Step 1: Create the package**

`packages/layer1/package.json`:
```json
{
  "name": "@gist/layer1",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "license": "MIT",
  "exports": { ".": "./src/index.ts", "./fixtures": "./test/fixtures.ts" },
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": { "@gist/shared": "workspace:*", "linkedom": "^0.18.5" }
}
```

`packages/layer1/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

Run: `pnpm install`

- [ ] **Step 2: Write the fixtures**

These fixtures are shared by Tasks 3–6. `packages/layer1/test/fixtures.ts`:
```ts
export function page(head: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Test</title>${head}</head><body>${body}</body></html>`;
}

const FARM_SENTENCES = [
  'Cookies are one of the most loved treats in the world and everyone has a favorite kind.',
  "In today's fast-paced world, it's important to note that baking at home can be a wonderful experience.",
  "Whether you're a beginner or an expert, this guide will help you on your baking journey.",
  'Many people wonder what makes a cookie truly great, and the answer might surprise you.',
  'Baking is a tapestry of flavors, textures and memories that bring families together.',
];

export function repeatParagraphs(sentences: string[], targetWords: number): string {
  const out: string[] = [];
  let words = 0;
  for (let i = 0; words < targetWords; i++) {
    const s = sentences[i % sentences.length]!;
    out.push(`<p>${s}</p>`);
    words += s.split(/\s+/).length;
  }
  return out.join('\n');
}

/** Long preamble, ad slots, stock images, affiliate links, popup script, generic author, stock phrases. */
export const farmRecipe = () =>
  page(
    `<meta name="author" content="admin">
     <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script>
     <script src="https://scripts.mediavine.com/tags/site.js"></script>
     <script src="https://a.omappapi.com/app/js/api.min.js"></script>`,
    `<nav><a href="/">Home</a><a href="/recipes">Recipes</a></nav>
     <article>
       <h1>The Best Chocolate Chip Cookies Ever</h1>
       ${Array.from({ length: 8 }, () => `<div class="ad-container"><ins class="adsbygoogle"></ins></div>${repeatParagraphs(FARM_SENTENCES, 110)}`).join('\n')}
       <h2>Ingredients</h2>
       <ul><li>1 cup butter</li><li>2 cups flour</li><li>1 tsp baking soda</li><li>2 eggs</li></ul>
       <img src="https://www.shutterstock.com/image-photo/cookies-1.jpg">
       <img src="https://www.shutterstock.com/image-photo/cookies-2.jpg">
       <img src="https://media.istockphoto.com/cookies-3.jpg">
       <p>Shop our picks: <a href="https://amzn.to/abc1">mixer</a> <a href="https://amzn.to/abc2">tray</a>
          <a href="https://amzn.to/abc3">spatula</a> <a href="https://amzn.to/abc4">bowl</a>
          <a href="https://amzn.to/abc5">scale</a> <a href="/about">about us</a> <a href="/contact">contact</a></p>
     </article>
     <footer>© Cookie Hub</footer>`,
  );

/** Named author, first-hand detail up front, numbered steps, original photos, real comments. */
export const blogRecipe = () =>
  page(
    `<meta name="author" content="Maria Lopez">`,
    `<nav><a href="/">Home</a></nav>
     <article>
       <h1>Brown Butter Chocolate Chip Cookies</h1>
       <p>I've baked these cookies every Sunday since 2019, and my version uses 225 g of browned butter and 2 large eggs.</p>
       <p>The trick I learned the hard way: chill the dough for 24 hours. My first batches spread into thin puddles because I skipped it.</p>
       <h2>Ingredients</h2>
       <ul><li>225 g unsalted butter, browned</li><li>200 g dark brown sugar</li><li>50 g white sugar</li><li>2 large eggs</li>
           <li>280 g plain flour</li><li>1 tsp baking soda</li><li>1 tsp flaky salt</li><li>250 g dark chocolate, chopped</li></ul>
       <h2>Method</h2>
       <ol>
         <li>Brown the butter over medium heat for about 6 minutes until it smells nutty.</li>
         <li>Cool it for 15 minutes, then whisk in both sugars.</li>
         <li>Beat in the eggs one at a time.</li>
         <li>Fold in the flour, baking soda and salt.</li>
         <li>Stir through the chocolate.</li>
         <li>Chill the dough for 24 hours.</li>
         <li>Scoop 50 g balls onto a lined tray.</li>
         <li>Bake at 180 °C for 11 minutes, until the edges are golden.</li>
       </ol>
       <p>We tested this with three flours in March 2023. Bread flour gave a chewier cookie, but my kids preferred plain flour, so that is what I use now.</p>
       <p>If your oven runs hot, drop it to 170 °C and check at 9 minutes. I keep an oven thermometer on the middle rack because mine runs about 10 °C high.</p>
       <img src="/uploads/2023/03/cookies-dough.jpg"><img src="/uploads/2023/03/cookies-tray.jpg">
       <img src="/uploads/2023/03/cookies-stack.jpg"><img src="/uploads/2023/03/cookies-broken.jpg">
     </article>
     <section id="comments">
       <div class="comment">Made these last night, the 24 hour chill really works.</div>
       <div class="comment">Swapped half the flour for bread flour, very chewy.</div>
       <div class="comment">My oven runs hot too, 170 worked perfectly.</div>
     </section>
     <footer>© Maria's Kitchen</footer>`,
  );

/** Short, specific, first-person answers from several usernames. */
export const forumThread = () =>
  page(
    '',
    `<main>
       <h1>Oven runs hot, how do you calibrate?</h1>
       <div class="post"><span class="author">breadnerd</span><p>My oven reads 180 °C but my thermometer says 195 °C. I have tried the dial adjustment but it drifts again after a week.</p></div>
       <div class="post"><span class="author">kiln_kate</span><p>I had the same problem. Most ovens have a calibration screw behind the knob. I turned mine 2 notches and it has held for 8 months.</p></div>
       <div class="post"><span class="author">maple_oak</span><p>We replaced the sensor instead. The part cost $18 and took 20 minutes with a screwdriver.</p></div>
       <div class="post"><span class="author">quietbaker</span><p>Check the door seal first. Mine was torn and the oven lost about 15 °C every time the fan kicked in.</p></div>
       <div class="post"><span class="author">breadnerd</span><p>Thanks, the screw fixed it. It is now within 3 °C across the whole rack after 2 weeks.</p></div>
     </main>`,
  );

/** Plain, formulaic English from a non-native writer, with one stock phrase, but concrete and useful. */
export const nonNativeHowTo = () =>
  page(
    `<meta name="author" content="Nguyen Van An">`,
    `<article>
       <h1>How to fix slow Wi-Fi on router model AX3000</h1>
       <p>I have this router since 2021 and I fix the slow Wi-Fi problem many times for my family.</p>
       <p>It is important to note that you need the admin password before you start this steps.</p>
       <ol>
         <li>Open the browser and go to the address 192.168.0.1 on your computer.</li>
         <li>Log in with the admin password that is on the sticker under the router.</li>
         <li>Go to the Wireless menu and choose the 5 GHz band for your devices.</li>
         <li>Change the channel width from 20 MHz to 80 MHz and then save the setting.</li>
         <li>Change the channel number to 36 because this channel is often more free.</li>
         <li>Update the firmware to version 1.2.8 from the official support page.</li>
         <li>Restart the router and wait around 3 minutes before you test again.</li>
         <li>Test the speed again with the same device in the same room as before.</li>
       </ol>
       <p>After these steps my speed go from 40 Mbps to 310 Mbps in the living room.</p>
       <p>If the speed is still slow, you can move the router to a more high place in the house.</p>
       <p>I hope this guide help you, and please ask me in the comment if you have a problem.</p>
     </article>`,
  );

export const tinyPage = () => page('', '<p>Hello world, this page says almost nothing.</p>');
```

- [ ] **Step 3: Write the failing test**

`packages/layer1/test/info.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildContext } from '../src/dom';
import { countSpecifics, scoreInfo } from '../src/info';
import { blogRecipe, farmRecipe, forumThread, nonNativeHowTo, tinyPage } from './fixtures';

describe('countSpecifics', () => {
  it('counts numbers with units, money, years, dates and versions', () => {
    expect(countSpecifics('Bake at 180 °C for 11 minutes using 225 g butter')).toBe(3);
    // $18, 2023, 1.2.8 — "March 2023" is not a date match (needs a day number like "March 5")
    expect(countSpecifics('It cost $18 in March 2023, version 1.2.8')).toBe(3);
  });
  it('does not treat words starting with a unit letter as units', () => {
    expect(countSpecifics('5 great ideas and 2 large eggs')).toBe(0);
  });
});

describe('buildContext', () => {
  it('prefers <article> and strips nav/footer from main', () => {
    const ctx = buildContext(blogRecipe());
    expect(ctx.mainText).toContain('Brown the butter');
    expect(ctx.mainText).not.toContain("Maria's Kitchen");
    expect(ctx.bodyWords).toBeGreaterThan(ctx.mainWords);
  });
  it('separates words across adjacent block elements', () => {
    const ctx = buildContext('<p>alpha</p><p>beta</p>');
    expect(ctx.mainWords).toBe(2);
  });
});

describe('scoreInfo', () => {
  it('scores the content farm low', () => {
    const r = scoreInfo(buildContext(farmRecipe()));
    expect(r.score).toBeLessThan(40);
    expect(r.signals.find((s) => s.id === 'info.early')?.effect).toBeLessThan(0);
  });
  it('scores the real blog high', () => {
    expect(scoreInfo(buildContext(blogRecipe())).score).toBeGreaterThanOrEqual(60);
  });
  it('scores the forum thread and the non-native how-to as useful', () => {
    expect(scoreInfo(buildContext(forumThread())).score).toBeGreaterThanOrEqual(60);
    expect(scoreInfo(buildContext(nonNativeHowTo())).score).toBeGreaterThanOrEqual(60);
  });
  it('caps very short pages at 40', () => {
    const r = scoreInfo(buildContext(tinyPage()));
    expect(r.score).toBeLessThanOrEqual(40);
  });
});
```

- [ ] **Step 4: Run the tests and confirm they fail**

Run: `pnpm test packages/layer1`
Expected: FAIL, "Failed to resolve import "../src/dom"".

- [ ] **Step 5: Implement**

`packages/layer1/src/signals.ts`:
```ts
import type { Signal } from '@gist/shared';

export const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));

/** Linear 0–100 score: `zeroAt` maps to 0 and `fullAt` maps to 100. Works in either direction. */
export const lerpScore = (value: number, zeroAt: number, fullAt: number) =>
  clamp(Math.round(((value - zeroAt) / (fullAt - zeroAt)) * 100));

export const signal = (id: string, label: string, effect: number): Signal => ({ id, label, effect: Math.round(effect) });
```

`packages/layer1/src/dom.ts`:
```ts
import { parseHTML } from 'linkedom';

const STRIP_ALWAYS = 'script,style,noscript,template,svg';
const STRIP_CHROME = 'nav,header,footer,aside,form,iframe';
const BLOCKS = 'p,li,pre,blockquote,h2,h3,h4';

export type PageContext = {
  document: Document;
  main: Element;
  mainText: string;
  mainWords: number;
  bodyWords: number;
  blocks: Element[];
};

export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

export function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function buildContext(html: string): PageContext {
  // A space after every tag keeps words in adjacent blocks from merging ("<p>a</p><p>b</p>" → "a b").
  // NUL characters are stripped because they are never meaningful in HTML text.
  const spaced = html.replace(/\u0000/g, '').replace(/>(?=\S)/g, '> ');
  const source = /<html[\s>]/i.test(spaced) ? spaced : `<!doctype html><html><head></head><body>${spaced}</body></html>`;
  const { document } = parseHTML(source) as unknown as { document: Document };
  const body: Element = document.body ?? document.documentElement;

  const bodyClone = body.cloneNode(true) as Element;
  bodyClone.querySelectorAll(STRIP_ALWAYS).forEach((e) => e.remove());
  const bodyWords = wordCount(textOf(bodyClone));

  let chosen: Element | null = null;
  for (const sel of ['article', 'main', '[role="main"]']) {
    const els = [...document.querySelectorAll(sel)];
    if (els.length) {
      chosen = els.reduce((a, b) => (textOf(b).length > textOf(a).length ? b : a));
      break;
    }
  }
  const main = (chosen ?? body).cloneNode(true) as Element;
  main.querySelectorAll(`${STRIP_ALWAYS},${STRIP_CHROME}`).forEach((e) => e.remove());
  const mainText = textOf(main);
  const blocks = [...main.querySelectorAll(BLOCKS)].filter((el) => !el.parentElement?.closest('p,li,pre,blockquote'));
  return { document, main, mainText, mainWords: wordCount(mainText), bodyWords, blocks };
}
```

`packages/layer1/src/info.ts`:
```ts
import type { DimensionResult } from '@gist/shared';
import { type PageContext, textOf, wordCount } from './dom';
import { lerpScore, signal } from './signals';

const UNITS =
  'mg|g|kg|lbs?|oz|ml|l|cups?|tbsp|tsp|°\\s?[cf]|degrees|mins?|minutes?|hours?|hrs?|seconds?|secs?|days?|weeks?|months?|years?' +
  '|%|px|ms|gb|mb|kb|tb|mm|cm|km|mph|v|w|kw|kwh|mah|hz|ghz|mhz|mbps|gbps|fps';

const PATTERNS: RegExp[] = [
  new RegExp(`\\b\\d+(?:[.,/]\\d+)?\\s?(?:${UNITS})(?![a-z])`, 'gi'),
  /[$€£₹]\s?\d[\d,]*(?:\.\d+)?/g,
  /\b(?:19|20)\d{2}\b/g,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b(?!\d)/gi,
  /\bv?\d+\.\d+\.\d+\b/g,
];

export function countSpecifics(text: string): number {
  return PATTERNS.reduce((n, re) => n + (text.match(re)?.length ?? 0), 0);
}

function isSubstantive(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'pre') return true;
  if (tag === 'li' && el.parentElement?.tagName.toLowerCase() === 'ol') return true;
  const t = textOf(el);
  const n = countSpecifics(t);
  return n >= 2 || (n >= 1 && wordCount(t) >= 12);
}

export function scoreInfo(ctx: PageContext): DimensionResult {
  const words = ctx.mainWords;
  const structural = ctx.main.querySelectorAll('ol > li').length + ctx.main.querySelectorAll('pre').length;
  const specifics = countSpecifics(ctx.mainText) + structural;
  const per100 = words ? (specifics / words) * 100 : 0;
  const specScore = lerpScore(per100, 0, 3);

  let before = 0;
  let found = false;
  for (const b of ctx.blocks) {
    if (isSubstantive(b)) {
      found = true;
      break;
    }
    before += wordCount(textOf(b));
  }
  if (!found) before = words;
  const earlyScore = lerpScore(before, 600, 50);

  const ratio = ctx.bodyWords ? words / ctx.bodyWords : 0;
  const ratioScore = lerpScore(ratio, 0.15, 0.6);

  let score = Math.round(0.5 * specScore + 0.3 * earlyScore + 0.2 * ratioScore);
  const signals = [
    signal('info.specifics', `${specifics} concrete details (numbers, units, dates, steps) in ${words} words`, (specScore - 50) * 0.5),
    signal(
      'info.early',
      !found ? 'No clearly useful passage found' : before <= 50 ? 'Gets to the useful part right away' : `Useful content starts after ${before} words`,
      (earlyScore - 50) * 0.3,
    ),
    signal('info.ratio', `Main content is ${Math.round(ratio * 100)}% of the page text`, (ratioScore - 50) * 0.2),
  ];
  if (words < 100 && score > 40) {
    signals.push(signal('info.short', `Very little text (${words} words)`, 40 - score));
    score = 40;
  }
  return { score, signals };
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm test packages/layer1`
Expected: PASS. If a fixture expectation fails, **tune the constants in `info.ts`** (the unit list, the `lerpScore` bounds), not the fixture or the expectation. The fixtures encode the behavior the spec requires.

---

### Task 4: Layer 1 human-presence and monetization dimensions

**Files:**
- Create: `packages/layer1/src/human.ts`, `packages/layer1/src/monetization.ts`
- Test: `packages/layer1/test/human.test.ts`, `packages/layer1/test/monetization.test.ts`

**Interfaces:**
- Consumes: `PageContext`, `buildContext`, `textOf`, `clamp`, `signal` (Task 3).
- Produces: `findAuthor(document: Document): string | null`, `scoreHuman(ctx: PageContext): DimensionResult`, `scoreMonetization(ctx: PageContext): DimensionResult`.

- [ ] **Step 1: Write the failing tests**

`packages/layer1/test/human.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildContext } from '../src/dom';
import { findAuthor, scoreHuman } from '../src/human';
import { blogRecipe, farmRecipe, forumThread, nonNativeHowTo, page } from './fixtures';

describe('findAuthor', () => {
  it('reads meta author', () => {
    expect(findAuthor(buildContext(blogRecipe()).document)).toBe('Maria Lopez');
  });
  it('reads JSON-LD author inside @graph', () => {
    const html = page(
      `<script type="application/ld+json">{"@graph":[{"@type":"Article","author":{"@type":"Person","name":"Sam Reed"}}]}</script>`,
      '<p>x</p>',
    );
    expect(findAuthor(buildContext(html).document)).toBe('Sam Reed');
  });
  it('survives malformed JSON-LD and falls back to byline', () => {
    const html = page(`<script type="application/ld+json">{not json</script>`, '<span class="byline">By Ana Ruiz</span>');
    expect(findAuthor(buildContext(html).document)).toBe('Ana Ruiz');
  });
});

describe('scoreHuman', () => {
  it('real blog: named author, first person, comments, original photos', () => {
    const r = scoreHuman(buildContext(blogRecipe()));
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.signals.map((s) => s.id)).toEqual(
      expect.arrayContaining(['human.author', 'human.first_person', 'human.comments', 'human.images']),
    );
  });
  it('farm: generic author, no first person, stock images', () => {
    const r = scoreHuman(buildContext(farmRecipe()));
    expect(r.score).toBeLessThan(40);
    expect(r.signals.map((s) => s.id)).toEqual(expect.arrayContaining(['human.generic_author', 'human.stock_images']));
  });
  it('forum and non-native pages get credit for a real voice', () => {
    expect(scoreHuman(buildContext(forumThread())).score).toBeGreaterThanOrEqual(70);
    expect(scoreHuman(buildContext(nonNativeHowTo())).score).toBeGreaterThanOrEqual(70);
  });
});
```

`packages/layer1/test/monetization.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildContext } from '../src/dom';
import { scoreMonetization } from '../src/monetization';
import { blogRecipe, farmRecipe, page } from './fixtures';

describe('scoreMonetization', () => {
  it('farm with ads, affiliate links and a popup scores near zero', () => {
    const r = scoreMonetization(buildContext(farmRecipe()));
    expect(r.score).toBeLessThanOrEqual(10);
    expect(r.signals.map((s) => s.id)).toEqual(expect.arrayContaining(['money.ads', 'money.affiliate', 'money.popup']));
  });
  it('clean blog scores 100', () => {
    expect(scoreMonetization(buildContext(blogRecipe())).score).toBe(100);
  });
  it('counts nested ad containers once', () => {
    const one = page('', `<article><p>${'word '.repeat(300)}</p></article><div class="ad-wrapper"><div class="ad-slot"><ins class="adsbygoogle"></ins></div></div>`);
    const r = scoreMonetization(buildContext(one));
    expect(r.signals.find((s) => s.id === 'money.ads')?.label).toMatch(/^1 ad slot/);
  });
  it('does not treat "add-to-cart" or "header" as ads', () => {
    const html = page('', `<article><p>${'word '.repeat(300)}</p><button class="add-to-cart">Add</button><div class="header-bar"></div></article>`);
    expect(scoreMonetization(buildContext(html)).score).toBe(100);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm test packages/layer1`
Expected: FAIL, "Failed to resolve import "../src/human"".

- [ ] **Step 3: Implement**

`packages/layer1/src/human.ts`:
```ts
import type { DimensionResult, Signal } from '@gist/shared';
import { type PageContext, textOf } from './dom';
import { clamp, signal } from './signals';

const GENERIC_AUTHORS = /^(admin|administrator|staff|editor|editors|editorial( team)?|team|guest|author|webmaster|contributor|user)$/i;
const STOCK_IMG = /shutterstock|istockphoto|gettyimages|stock\.adobe|adobestock|dreamstime|depositphotos|pexels|unsplash|pixabay|123rf/i;
const FIRST_PERSON = /\b(?:i|i'm|i've|i'd|i'll|my|me|mine|we|we've|our)\b/gi;

function findLdAuthor(node: unknown, depth = 0): string | null {
  if (depth > 6 || node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findLdAuthor(n, depth + 1);
      if (r) return r;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  const a = obj.author;
  if (typeof a === 'string' && a.trim()) return a.trim();
  if (a && typeof a === 'object') {
    for (const x of Array.isArray(a) ? a : [a]) {
      const name = (x as { name?: unknown } | null)?.name;
      if (typeof name === 'string' && name.trim()) return name.trim();
    }
  }
  for (const v of Object.values(obj)) {
    const r = findLdAuthor(v, depth + 1);
    if (r) return r;
  }
  return null;
}

export function findAuthor(document: Document): string | null {
  const meta = document
    .querySelector('meta[name="author"], meta[name="Author"], meta[property="article:author"]')
    ?.getAttribute('content')
    ?.trim();
  if (meta && !/^https?:/i.test(meta)) return meta;
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const name = findLdAuthor(JSON.parse(s.textContent ?? ''));
      if (name) return name;
    } catch {
      // malformed JSON-LD is common; ignore it
    }
  }
  const byline = textOf(
    document.querySelector('[rel="author"], [itemprop="author"], .author, .byline, .post-author, .entry-author, .author-name'),
  ).replace(/^by\s+/i, '');
  return byline && byline.length <= 80 ? byline : null;
}

function countComments(document: Document): number {
  let max = 0;
  for (const c of document.querySelectorAll('#comments, .comments, .comment-list, .commentlist, .comments-area, [itemtype*="Comment"]')) {
    max = Math.max(max, c.querySelectorAll('.comment, [itemtype*="Comment"], li, article').length);
  }
  return max;
}

export function scoreHuman(ctx: PageContext): DimensionResult {
  const signals: Signal[] = [];
  let score = 20;

  const author = findAuthor(ctx.document);
  if (author && !GENERIC_AUTHORS.test(author)) {
    score += 35;
    signals.push(signal('human.author', `Named author: ${author}`, 35));
  } else if (author) {
    signals.push(signal('human.generic_author', `Author listed only as "${author}"`, -35));
  } else {
    signals.push(signal('human.no_author', 'No named author', -35));
  }

  const text = ctx.mainText.replace(/’/g, "'");
  const fp = text.match(FIRST_PERSON)?.length ?? 0;
  if (ctx.mainWords && (fp / ctx.mainWords) * 100 >= 0.5) {
    score += 20;
    signals.push(signal('human.first_person', 'Written from first-hand experience', 20));
  } else {
    signals.push(signal('human.no_first_person', 'No first-hand voice', -20));
  }

  const comments = countComments(ctx.document);
  if (comments >= 2) {
    score += 15;
    signals.push(signal('human.comments', `${comments} reader comments`, 15));
  }

  const srcs = new Set(
    [...ctx.main.querySelectorAll('img')].map((i) => i.getAttribute('src') || i.getAttribute('data-src') || '').filter(Boolean),
  );
  const stock = [...srcs].filter((s) => STOCK_IMG.test(s)).length;
  const original = srcs.size - stock;
  if (original >= 3) {
    score += 10;
    signals.push(signal('human.images', `${original} original images`, 10));
  }
  if (stock >= 2 && stock >= srcs.size / 2) {
    score -= 10;
    signals.push(signal('human.stock_images', `${stock} stock images`, -10));
  }
  return { score: clamp(score), signals };
}
```

`packages/layer1/src/monetization.ts`:
```ts
import type { DimensionResult, Signal } from '@gist/shared';
import type { PageContext } from './dom';
import { clamp, signal } from './signals';

const AD_SCRIPT =
  /googlesyndication|doubleclick\.net|adnxs\.com|amazon-adsystem|taboola|outbrain|mediavine|adthrive|ezoic|ezojs|raptive|pubmatic|criteo|adsafeprotected|moatads|revcontent|mgid\.com|propellerads/i;
const AD_TOKEN = /^(?:ads?|advert|advertisement|adsbygoogle|adslot|adunit|dfp)(?:[-_].*)?$/i;
const AFFILIATE =
  /[?&](?:tag|affid|aff_id|affiliate_id)=|amzn\.to\/|go\.skimresources\.com|shareasale\.com|awin1\.com|rstyle\.me|click\.linksynergy\.com|anrdoezrs\.net|dpbolvw\.net|jdoqocy\.com|tkqlhce\.com|kqzyfj\.com|hop\.clickbank\.net|sjv\.io|pntra\.com/i;
const POPUP = /optinmonster|omappapi|optmstr|sumo\.com|sumome|popupsmart|privy\.com|getsitecontrol|poptin|convertbox|hellobar|wisepops|justuno/i;

function isAdElement(el: Element): boolean {
  const tokens = [...(el.getAttribute('class') ?? '').split(/\s+/), el.getAttribute('id') ?? ''].filter(Boolean);
  return tokens.some((t) => AD_TOKEN.test(t));
}

function hasAdAncestor(el: Element): boolean {
  for (let p = el.parentElement; p; p = p.parentElement) if (isAdElement(p)) return true;
  return false;
}

export function scoreMonetization(ctx: PageContext): DimensionResult {
  const doc = ctx.document;
  const body: Element = doc.body ?? doc.documentElement;
  const scripts = [...doc.querySelectorAll('script')];
  const signals: Signal[] = [];

  const adScripts = scripts.filter((s) => AD_SCRIPT.test(s.getAttribute('src') ?? '')).length;
  const adElements = [...body.querySelectorAll('div,ins,aside,section,span')].filter((el) => isAdElement(el) && !hasAdAncestor(el)).length;
  const units = adElements + adScripts;
  const per1000 = (units / Math.max(ctx.mainWords, 200)) * 1000;
  const adPenalty = Math.min(60, Math.round(per1000 * 8));
  if (adPenalty > 0) {
    signals.push(signal('money.ads', `${units} ad slot${units === 1 ? '' : 's'} or ad scripts (${per1000.toFixed(1)} per 1,000 words)`, -adPenalty));
  }

  const links = [...ctx.main.querySelectorAll('a[href]')];
  const aff = links.filter((a) => AFFILIATE.test(a.getAttribute('href') ?? '') || /\bsponsored\b/i.test(a.getAttribute('rel') ?? '')).length;
  const affPenalty = Math.min(30, Math.round((links.length ? aff / links.length : 0) * 100));
  if (affPenalty > 0) signals.push(signal('money.affiliate', `${aff} of ${links.length} links are affiliate links`, -affPenalty));

  const popup = scripts.some((s) => POPUP.test(s.getAttribute('src') ?? '') || POPUP.test(s.textContent ?? ''));
  if (popup) signals.push(signal('money.popup', 'Popup or signup-wall script', -10));

  const score = clamp(100 - adPenalty - affPenalty - (popup ? 10 : 0));
  if (score === 100) signals.push(signal('money.clean', 'No ad slots, affiliate links or popups found', 0));
  return { score, signals };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm test packages/layer1`
Expected: PASS. As in Task 3, tune the constants rather than the expectations.

---

### Task 5: Layer 1 style tells, `scoreHtml`, and robustness

**Files:**
- Create: `packages/layer1/src/style.ts`, `packages/layer1/src/index.ts`
- Test: `packages/layer1/test/style.test.ts`, `packages/layer1/test/robustness.test.ts`

**Interfaces:**
- Consumes: Tasks 3–4.
- Produces: `LAYER1_VERSION = '1.0.0'`, `scoreHtml(html: string, fetchedAt: Date): Layer1Result`, `scoreStyle(ctx): { adjust: number; signals: Signal[] }`. Later tasks import only `scoreHtml` and `LAYER1_VERSION` from `@gist/layer1`.

- [ ] **Step 1: Write the failing tests**

`packages/layer1/test/style.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildContext } from '../src/dom';
import { scoreStyle } from '../src/style';
import { blogRecipe, farmRecipe, nonNativeHowTo } from './fixtures';

describe('scoreStyle', () => {
  it('farm: stock phrases and uniform rhythm hit the -5 floor', () => {
    expect(scoreStyle(buildContext(farmRecipe())).adjust).toBe(-5);
  });
  it('real blog: no adjustment', () => {
    expect(scoreStyle(buildContext(blogRecipe())).adjust).toBe(0);
  });
  it('never goes below -5 or above 0', () => {
    const a = scoreStyle(buildContext(nonNativeHowTo())).adjust;
    expect(a).toBeGreaterThanOrEqual(-5);
    expect(a).toBeLessThanOrEqual(0);
  });
});
```

`packages/layer1/test/robustness.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { LAYER1_VERSION, scoreHtml } from '../src/index';
import { blogRecipe } from './fixtures';

const at = new Date('2026-09-29T00:00:00Z');
const inRange = (n: number) => n >= 0 && n <= 100 && Number.isInteger(n);

describe('scoreHtml', () => {
  it('returns the full Layer1Result shape', () => {
    const r = scoreHtml(blogRecipe(), at);
    expect(r.layer1Version).toBe(LAYER1_VERSION);
    expect(r.fetchedAt).toBe('2026-09-29T00:00:00.000Z');
    expect(Object.keys(r.dimensions).sort()).toEqual(['human', 'info', 'monetization']);
    expect(Array.isArray(r.styleSignals)).toBe(true);
  });

  it.each([
    ['empty string', ''],
    ['plain text', 'just some text without tags'],
    ['unclosed html', '<html><body><p>open'],
    ['binary junk', '\u0000\u0001\u0002�'.repeat(500)],
    ['huge single line', `<p>${'x'.repeat(200_000)}</p>`],
    ['script-only', '<script>var a = "<p>" > 1;</script>'],
  ])('does not throw on %s and keeps scores in range', (_, html) => {
    const r = scoreHtml(html, at);
    for (const d of Object.values(r.dimensions)) expect(inRange(d.score)).toBe(true);
    expect(r.styleAdjust).toBeGreaterThanOrEqual(-5);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm test packages/layer1`
Expected: FAIL, "Failed to resolve import "../src/style"".

- [ ] **Step 3: Implement**

`packages/layer1/src/style.ts`:
```ts
import type { Signal } from '@gist/shared';
import { type PageContext, wordCount } from './dom';
import { signal } from './signals';

const PHRASES = [
  "in today's fast-paced world", 'delve into', "it's important to note", 'it is important to note', 'in conclusion',
  "whether you're a", 'look no further', 'unlock the', 'navigating the', 'a testament to', 'game-changer', 'game changer',
  'elevate your', 'in the realm of', 'embark on', 'treasure trove', 'seamlessly', 'tapestry', 'ever-evolving', 'dive into',
];

/** Weak evidence only: at most -5 in total (spec §4.1). */
export function scoreStyle(ctx: PageContext): { adjust: number; signals: Signal[] } {
  const signals: Signal[] = [];
  const text = ctx.mainText.toLowerCase().replace(/’/g, "'");
  const hits = PHRASES.reduce((n, p) => n + text.split(p).length - 1, 0);
  const per1000 = ctx.mainWords ? (hits / ctx.mainWords) * 1000 : 0;
  const phrasePenalty = Math.min(3, Math.round(per1000));
  if (phrasePenalty > 0) signals.push(signal('style.phrases', `${hits} stock filler phrases`, -phrasePenalty));

  const lengths = ctx.mainText.split(/(?<=[.!?])\s+/).map(wordCount).filter((n) => n >= 3);
  let rhythmPenalty = 0;
  if (lengths.length >= 15) {
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const sd = Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length);
    if (sd / mean < 0.3) {
      rhythmPenalty = 2;
      signals.push(signal('style.rhythm', 'Unusually uniform sentence rhythm', -2));
    }
  }
  return { adjust: 0 - phrasePenalty - rhythmPenalty, signals };
}
```

`packages/layer1/src/index.ts`:
```ts
import type { Layer1Result } from '@gist/shared';
import { buildContext } from './dom';
import { scoreHuman } from './human';
import { scoreInfo } from './info';
import { scoreMonetization } from './monetization';
import { scoreStyle } from './style';

/** Bump whenever heuristics change: it is part of the server cache key, so pages get re-scored. */
export const LAYER1_VERSION = '1.0.0';

export function scoreHtml(html: string, fetchedAt: Date): Layer1Result {
  const ctx = buildContext(html);
  const style = scoreStyle(ctx);
  return {
    layer1Version: LAYER1_VERSION,
    dimensions: { info: scoreInfo(ctx), human: scoreHuman(ctx), monetization: scoreMonetization(ctx) },
    styleAdjust: style.adjust,
    styleSignals: style.signals,
    fetchedAt: fetchedAt.toISOString(),
  };
}

export { buildContext } from './dom';
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm test packages/layer1 && pnpm --filter @gist/layer1 typecheck`
Expected: PASS, no type errors. If the "huge single line" case is slow (>2 s), leave it for now and note it for the reviewer. Don't add a timeout.

---
### Task 6: Combiner (grade, verdict, confidence, guardrails, overrides)

**Files:**
- Create: `packages/combiner/package.json`, `packages/combiner/tsconfig.json`, `packages/combiner/src/index.ts`
- Test: `packages/combiner/test/combine.test.ts`, `packages/combiner/test/fairness.test.ts`

**Interfaces:**
- Consumes: `Layer1Result`, `ListEntry`, `Verdict`, `VerdictName`, `FlagVerdict`, `DimensionKey`, `Signal` from `@gist/shared`; `scoreHtml` and fixtures from `@gist/layer1` (tests only).
- Produces (from `@gist/combiner`):
  - `WEIGHTS`, `LOW_CONFIDENCE_FLOOR: VerdictName = 'Thin'`, `FARM_CAP = 25`, `HUMAN_FLOOR = 50`
  - `verdictFor(grade: number): VerdictName`
  - `type CombineInput = { layer1: Layer1Result | null; entry: ListEntry | null; override: FlagVerdict | null; greenDot: boolean; lowConfidenceFloor?: VerdictName }`
  - `combine(input: CombineInput): Verdict`

- [ ] **Step 1: Create the package**

`packages/combiner/package.json`:
```json
{
  "name": "@gist/combiner",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "license": "MIT",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": { "@gist/shared": "workspace:*" },
  "devDependencies": { "@gist/layer1": "workspace:*" }
}
```

`packages/combiner/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing tests**

`packages/combiner/test/combine.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { Layer1Result, ListEntry } from '@gist/shared';
import { combine, verdictFor } from '../src/index';

const l1 = (info: number, human: number, money: number, styleAdjust = 0): Layer1Result => ({
  layer1Version: 'test',
  dimensions: {
    info: { score: info, signals: [{ id: 'info.x', label: 'info signal', effect: -3 }] },
    human: { score: human, signals: [{ id: 'human.x', label: 'human signal', effect: 20 }] },
    monetization: { score: money, signals: [] },
  },
  styleAdjust,
  styleSignals: [],
  fetchedAt: '2026-09-29T00:00:00.000Z',
});
const farm = (siteBehavior: number): ListEntry => ({ match: 'farm.com', matchLevel: 'domain', kind: 'farm', siteBehavior, reasons: ['Mass-produced recipes'], source: 'seed' });
const human = (siteBehavior: number): ListEntry => ({ match: 'cook.com', matchLevel: 'domain', kind: 'human', siteBehavior, reasons: ['Independent recipe developer'], source: 'seed' });
const base = { layer1: null, entry: null, override: null, greenDot: false } as const;

describe('verdictFor', () => {
  it('uses the spec bands', () => {
    expect([100, 80, 79, 60, 59, 40, 39, 20, 19, 0].map(verdictFor)).toEqual(
      ['Solid', 'Solid', 'OK', 'OK', 'Thin', 'Thin', 'Filler', 'Filler', 'Slop', 'Slop'],
    );
  });
});

describe('combine', () => {
  it('returns confidence none with nothing scored', () => {
    const v = combine(base);
    expect(v).toMatchObject({ grade: null, verdict: null, confidence: 'none', action: 'none' });
    expect(v.dimensions.originality).toBeNull();
  });

  it('rescales weights over scored dimensions only', () => {
    // (100*30 + 0*20 + 100*10) / 60 = 66.67
    const v = combine({ ...base, layer1: l1(100, 0, 100) });
    expect(v.grade).toBe(67);
    expect(v.verdict).toBe('OK');
    expect(v.confidence).toBe('low');
  });

  it('applies styleAdjust and clamps to 0..100', () => {
    expect(combine({ ...base, layer1: l1(0, 0, 0, -5) }).grade).toBe(0);
    expect(combine({ ...base, layer1: l1(100, 100, 100, -5) }).grade).toBe(95);
  });

  it('strict rule: Layer 1 alone never goes below Thin, but keeps the real grade', () => {
    const v = combine({ ...base, layer1: l1(10, 10, 10) });
    expect(v).toMatchObject({ grade: 10, verdict: 'Thin', confidence: 'low', action: 'tag' });
  });

  it('lowConfidenceFloor option lets eval simulate rule B', () => {
    expect(combine({ ...base, layer1: l1(10, 10, 10), lowConfidenceFloor: 'Filler' })).toMatchObject({ verdict: 'Filler', action: 'dim' });
    expect(combine({ ...base, layer1: l1(10, 10, 10), lowConfidenceFloor: 'Slop' }).verdict).toBe('Slop');
  });

  it('farm entry caps at 25 and is high confidence', () => {
    // (90*30 + 90*20 + 10*15 + 90*10) / 75 = 74 -> capped 25
    const v = combine({ ...base, layer1: l1(90, 90, 90), entry: farm(10) });
    expect(v).toMatchObject({ grade: 25, verdict: 'Filler', confidence: 'high', action: 'dim' });
    expect(v.reasons.some((r) => r.id === 'guard.farm_cap')).toBe(true);
  });

  it('farm entry alone (before Layer 1 arrives) can collapse', () => {
    expect(combine({ ...base, entry: farm(5) })).toMatchObject({ grade: 5, verdict: 'Slop', confidence: 'high', action: 'collapse' });
  });

  it('human entry lifts to at least 50', () => {
    // (10*30 + 10*20 + 90*15 + 10*10) / 75 = 26 -> floored 50
    expect(combine({ ...base, layer1: l1(10, 10, 10), entry: human(90) })).toMatchObject({ grade: 50, verdict: 'Thin', action: 'tag' });
  });

  it('green dot only when enabled and Solid', () => {
    expect(combine({ ...base, layer1: l1(90, 90, 90) }).action).toBe('none');
    expect(combine({ ...base, layer1: l1(90, 90, 90), greenDot: true }).action).toBe('dot');
  });

  it('user "fine" override removes any action but keeps the verdict', () => {
    const v = combine({ ...base, entry: farm(5), override: 'fine' });
    expect(v).toMatchObject({ verdict: 'Slop', action: 'none', userOverride: 'fine' });
  });

  it('user "slop" override dims, keeps collapse, and works with no score', () => {
    expect(combine({ ...base, layer1: l1(70, 70, 70), override: 'slop' }).action).toBe('dim');
    expect(combine({ ...base, entry: farm(5), override: 'slop' }).action).toBe('collapse');
    expect(combine({ ...base, override: 'slop' })).toMatchObject({ confidence: 'none', action: 'dim' });
  });

  it('sorts reasons by absolute effect, list reasons first for list hits', () => {
    const v = combine({ ...base, layer1: l1(90, 90, 90), entry: farm(10) });
    const effects = v.reasons.map((r) => Math.abs(r.effect));
    expect(effects).toEqual([...effects].sort((a, b) => b - a));
    expect(v.reasons[0]!.id).toMatch(/^(list\.farm|guard\.farm_cap)/);
  });
});
```

`packages/combiner/test/fairness.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { scoreHtml } from '@gist/layer1';
import { farmRecipe, forumThread, nonNativeHowTo } from '@gist/layer1/fixtures';
import { combine } from '../src/index';

const at = new Date('2026-09-29T00:00:00Z');
const raw = (html: string, styleOverride?: number) => {
  const layer1 = scoreHtml(html, at);
  return combine({
    layer1: styleOverride === undefined ? layer1 : { ...layer1, styleAdjust: styleOverride },
    entry: null, override: null, greenDot: false, lowConfidenceFloor: 'Slop',
  });
};

describe('fairness (spec §9)', () => {
  it.each([['non-native how-to', nonNativeHowTo()], ['forum thread', forumThread()]])(
    '%s is not pushed below Thin, and style moves it by at most 5',
    (_, html) => {
      const withStyle = raw(html).grade!;
      const withoutStyle = raw(html, 0).grade!;
      expect(withStyle).toBeGreaterThanOrEqual(40);
      expect(withoutStyle - withStyle).toBeLessThanOrEqual(5);
    },
  );

  it('farm page: Layer 1 alone only tags it; with a farm list entry it collapses', () => {
    const layer1 = scoreHtml(farmRecipe(), at);
    expect(combine({ layer1, entry: null, override: null, greenDot: false })).toMatchObject({ verdict: 'Thin', action: 'tag' });
    const entry = { match: 'farm.com', matchLevel: 'domain', kind: 'farm', siteBehavior: 10, reasons: ['r'], source: 'seed' } as const;
    expect(combine({ layer1, entry, override: null, greenDot: false }).action).toBe('collapse');
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `pnpm test packages/combiner`
Expected: FAIL, "Failed to resolve import "../src/index"".

- [ ] **Step 4: Implement**

`packages/combiner/src/index.ts`:
```ts
import type { Action, DimensionKey, FlagVerdict, Layer1Result, ListEntry, Signal, Verdict, VerdictName } from '@gist/shared';

export const WEIGHTS: Record<DimensionKey, number> = { info: 30, originality: 25, human: 20, siteBehavior: 15, monetization: 10 };
/** Strict rule D2. Change to 'Filler' to let Layer 1 alone dim (rule B) once eval supports it. */
export const LOW_CONFIDENCE_FLOOR: VerdictName = 'Thin';
export const FARM_CAP = 25;
export const HUMAN_FLOOR = 50;

const SEVERITY: VerdictName[] = ['Solid', 'OK', 'Thin', 'Filler', 'Slop'];
const ACTIONS: Record<VerdictName, Action> = { Solid: 'none', OK: 'none', Thin: 'tag', Filler: 'dim', Slop: 'collapse' };

export function verdictFor(grade: number): VerdictName {
  return grade >= 80 ? 'Solid' : grade >= 60 ? 'OK' : grade >= 40 ? 'Thin' : grade >= 20 ? 'Filler' : 'Slop';
}

export type CombineInput = {
  layer1: Layer1Result | null;
  entry: ListEntry | null;
  override: FlagVerdict | null;
  greenDot: boolean;
  lowConfidenceFloor?: VerdictName;
};

export function combine(input: CombineInput): Verdict {
  const { layer1, entry, override } = input;
  const floor = input.lowConfidenceFloor ?? LOW_CONFIDENCE_FLOOR;
  const dimensions: Record<DimensionKey, number | null> = {
    info: layer1?.dimensions.info.score ?? null,
    originality: null, // needs deep scan (out of scope)
    human: layer1?.dimensions.human.score ?? null,
    siteBehavior: entry?.siteBehavior ?? null,
    monetization: layer1?.dimensions.monetization.score ?? null,
  };

  const reasons: Signal[] = [];
  if (entry) entry.reasons.forEach((label, i) => reasons.push({ id: `list.${entry.kind}.${i}`, label, effect: entry.kind === 'farm' ? -50 : 50 }));
  if (layer1) {
    for (const d of Object.values(layer1.dimensions)) reasons.push(...d.signals);
    reasons.push(...layer1.styleSignals);
  }

  const scored = (Object.keys(WEIGHTS) as DimensionKey[]).filter((k) => dimensions[k] !== null);
  if (scored.length === 0) {
    return finish({ grade: null, verdict: null, confidence: 'none', action: 'none', dimensions, reasons, userOverride: override });
  }

  const totalWeight = scored.reduce((s, k) => s + WEIGHTS[k], 0);
  const weighted = scored.reduce((s, k) => s + (dimensions[k] as number) * WEIGHTS[k], 0) / totalWeight;
  let grade = Math.round(Math.min(100, Math.max(0, weighted + (layer1?.styleAdjust ?? 0))));
  const confidence = entry ? 'high' : 'low';

  if (entry?.kind === 'farm' && grade > FARM_CAP) {
    reasons.push({ id: 'guard.farm_cap', label: `Known content farm: score capped at ${FARM_CAP}`, effect: FARM_CAP - grade });
    grade = FARM_CAP;
  }
  if (entry?.kind === 'human' && grade < HUMAN_FLOOR) {
    reasons.push({ id: 'guard.human_floor', label: `Verified human site: score raised to ${HUMAN_FLOOR}`, effect: HUMAN_FLOOR - grade });
    grade = HUMAN_FLOOR;
  }

  let verdict = verdictFor(grade);
  if (confidence === 'low' && SEVERITY.indexOf(verdict) > SEVERITY.indexOf(floor)) verdict = floor;
  const action: Action = verdict === 'Solid' && input.greenDot ? 'dot' : ACTIONS[verdict];
  return finish({ grade, verdict, confidence, action, dimensions, reasons, userOverride: override });
}

function finish(v: Verdict): Verdict {
  const reasons = [...v.reasons].sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
  let action = v.action;
  if (v.userOverride === 'fine') action = 'none';
  if (v.userOverride === 'slop') action = v.action === 'collapse' ? 'collapse' : 'dim';
  return { ...v, reasons, action };
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm test packages/combiner && pnpm --filter @gist/combiner typecheck`
Expected: PASS. If a fairness test fails, the fix belongs in Layer 1 (Tasks 3–5), not in the combiner or the test.

---

### Task 7: Domain list, selector config and bundle builder

**Files:**
- Create: `data/selectors.json`, `data/domains/farms.json`, `data/domains/humans.json`, `data/domains/README.md`
- Create: `scripts/lib/bundle.ts`, `scripts/lists-build.ts`, `tsconfig.json` (root)
- Modify: `package.json` (root: scripts and devDependencies), `vitest.workspace.ts`
- Test: `scripts/test/bundle.test.ts`
- Generated: `data/bundle.json`

**Interfaces:**
- Consumes: `listEntrySchema`, `selectorConfigSchema`, `listBundleSchema`, `ListBundle` from `@gist/shared`.
- Produces: `buildBundle(domainFiles: { name: string; data: unknown }[], selectors: unknown): ListBundle`; the file `data/bundle.json` (imported by the extension in Task 14 and published by the server in Task 13); `pnpm lists:build`.

- [ ] **Step 1: Wire root tooling**

Replace root `package.json` `scripts` and `devDependencies` with:
```json
  "scripts": {
    "test": "vitest run",
    "typecheck": "pnpm -r typecheck && tsc -p tsconfig.json",
    "lists:build": "tsx scripts/lists-build.ts"
  },
  "devDependencies": {
    "@gist/shared": "workspace:*",
    "@types/node": "^20.17.10",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8",
    "zod": "^3.24.1"
  }
```

Root `tsconfig.json`:
```json
{ "extends": "./tsconfig.base.json", "include": ["scripts", "eval"] }
```

`vitest.workspace.ts`:
```ts
export default [
  'packages/*',
  'apps/*',
  { test: { name: 'root', include: ['scripts/test/**/*.test.ts', 'eval/test/**/*.test.ts'], environment: 'node' } },
];
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing test**

`scripts/test/bundle.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildBundle } from '../lib/bundle';

const selectors = { version: 1, result: '#rso div.g', title: 'h3', exclude: [] };
const farm = { match: 'farm.com', matchLevel: 'domain', kind: 'farm', siteBehavior: 10, reasons: ['r'], source: 'seed' };
const human = { match: 'cook.org', matchLevel: 'domain', kind: 'human', siteBehavior: 90, reasons: ['r'], source: 'seed' };

describe('buildBundle', () => {
  it('merges files, sorts entries and derives a stable content version', () => {
    const a = buildBundle([{ name: 'humans.json', data: [human] }, { name: 'farms.json', data: [farm] }], selectors);
    const b = buildBundle([{ name: 'farms.json', data: [farm] }, { name: 'humans.json', data: [human] }], selectors);
    expect(a.domains.map((d) => d.match)).toEqual(['cook.org', 'farm.com']);
    expect(a.version).toMatch(/^[0-9a-f]{12}$/);
    expect(a.version).toBe(b.version);
  });
  it('changes version when content changes', () => {
    const a = buildBundle([{ name: 'f.json', data: [farm] }], selectors);
    const b = buildBundle([{ name: 'f.json', data: [{ ...farm, siteBehavior: 11 }] }], selectors);
    expect(a.version).not.toBe(b.version);
  });
  it('rejects duplicates across files with both file names in the message', () => {
    expect(() => buildBundle([{ name: 'a.json', data: [farm] }, { name: 'b.json', data: [farm] }], selectors)).toThrow(/b\.json.*domain:farm\.com.*a\.json/);
  });
  it('reports which file and field is invalid', () => {
    expect(() => buildBundle([{ name: 'farms.json', data: [{ ...farm, siteBehavior: 500 }] }], selectors)).toThrow(/farms\.json: 0\.siteBehavior/);
  });
  it('rejects invalid selectors', () => {
    expect(() => buildBundle([], { version: 0, result: '', title: 'h3', exclude: [] })).toThrow();
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `pnpm test scripts`
Expected: FAIL, "Failed to resolve import "../lib/bundle"".

- [ ] **Step 4: Implement**

`scripts/lib/bundle.ts`:
```ts
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
```

`scripts/lists-build.ts`:
```ts
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle } from './lib/bundle';

const dataDir = fileURLToPath(new URL('../data/', import.meta.url));
const domainDir = join(dataDir, 'domains');
const files = readdirSync(domainDir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((name) => ({ name, data: JSON.parse(readFileSync(join(domainDir, name), 'utf8')) as unknown }));
const bundle = buildBundle(files, JSON.parse(readFileSync(join(dataDir, 'selectors.json'), 'utf8')));
writeFileSync(join(dataDir, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`);
console.log(`bundle ${bundle.version}: ${bundle.domains.length} domain entries, selectors v${bundle.selectors.version}`);
```

- [ ] **Step 5: Create the data files**

`data/selectors.json`. These are starting selectors; Task 17 verifies them against real saved Google pages:
```json
{
  "version": 1,
  "result": "#rso div.MjjYud, #rso div.g",
  "title": "h3",
  "exclude": ["#tads", "#tadsb", "#bottomads", "[data-text-ad]", "g-scrolling-carousel", "g-section-with-header", "related-question-pair", "[data-initq]", "block-component"]
}
```

`data/domains/farms.json`:
```json
[]
```

`data/domains/humans.json`:
```json
[]
```

`data/domains/README.md`:
```markdown
# Domain lists

Entries here are the only thing that can dim or collapse a result at launch (spec D2), so every entry needs evidence.

Each entry: `{ "match", "matchLevel": "domain"|"host", "kind": "farm"|"human", "siteBehavior": 0–100, "reasons": [...], "source": "seed"|"review" }`.

## Adding a farm (`farms.json`)
Add a domain only when **at least two** of these are true and written in `reasons` (reasons are shown to users in "Why?"):
- Publishes many articles per day across unrelated topics (topic sprawl).
- Output jumped sharply after 2022, or the domain changed owners and its topic (expired-domain takeover).
- Pages sampled (5+) consistently bury the answer under 500+ words of filler.
- No named authors, or author profiles that cannot be verified.
Set `siteBehavior` 0–19 for egregious farms (these collapse), 20–39 otherwise (these dim).

## Adding a verified human site (`humans.json`)
Named person or small team, posting history over years, first-hand work (original photos, tested results). `siteBehavior` 70–100.

Use `"matchLevel": "host"` for one blog on a shared platform (e.g. `someone.blogspot.com`, `someone.substack.com`).

Run `pnpm lists:build` after editing; it validates and regenerates `data/bundle.json`.
```

- [ ] **Step 6: Run the tests and build the bundle**

Run: `pnpm test scripts && pnpm lists:build`
Expected: tests PASS. Output: `bundle <12 hex>: 0 domain entries, selectors v1`, and `data/bundle.json` exists.

> **Owner task (not code):** before launch the owner must fill in `farms.json` (the spec says "a few hundred") and `humans.json` using the README criteria. The plan does not invent domain entries. Listing a real site as a farm without evidence is exactly the false-positive risk the spec warns about.

---
### Task 8: Server database, migrations and repository

**Files:**
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/vitest.config.ts`
- Create: `apps/server/migrations/001_init.sql`, `apps/server/src/db.ts`, `apps/server/src/repo.ts`
- Create: `apps/server/test/helpers/db.ts`
- Test: `apps/server/test/repo.test.ts`

**Interfaces:**
- Consumes: `FailReason`, `Layer1Result`, `ListBundle` from `@gist/shared`.
- Produces:
  - `type Sql`, `connect(url: string): Sql`, `migrate(sql: Sql): Promise<void>`
  - `interface Repo` with `getScores`, `putScore`, `recordFailure`, `registerDevice`, `deviceExists`, `countFlagsToday`, `insertFlag`, `latestBundle`, `publishBundle`, `recordEvent`, `flagSummary`, `failureSummary` (signatures below)
  - `type StoredScore`, `type NewFlag`, `createRepo(sql: Sql): Repo`
  - Test helper `startDb(): Promise<{ sql: Sql; stop(): Promise<void> }>`

Docker must be running for these tests (Testcontainers). Check with `docker info`.

- [ ] **Step 1: Create the package**

`apps/server/package.json`:
```json
{
  "name": "@gist/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "lists:publish": "tsx scripts/lists-publish.ts",
    "review": "tsx scripts/review.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@gist/layer1": "workspace:*",
    "@gist/shared": "workspace:*",
    "@hono/node-server": "^1.13.7",
    "hono": "^4.6.14",
    "ipaddr.js": "^2.2.0",
    "postgres": "^3.4.5",
    "tsx": "^4.19.2",
    "undici": "^6.21.0",
    "zod": "^3.24.1"
  },
  "devDependencies": { "@testcontainers/postgresql": "^10.16.0" }
}
```

`apps/server/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test", "scripts"] }
```

`apps/server/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 180_000 } });
```

Run: `pnpm install`

- [ ] **Step 2: Write the migration**

`apps/server/migrations/001_init.sql`:
```sql
CREATE TABLE IF NOT EXISTS page_scores (
  url_norm       text        NOT NULL,
  layer1_version text        NOT NULL,
  status         text        NOT NULL CHECK (status IN ('ready', 'failed')),
  result         jsonb,
  fail_reason    text,
  fetched_at     timestamptz NOT NULL,
  PRIMARY KEY (url_norm, layer1_version)
);

CREATE TABLE IF NOT EXISTS fetch_failures (
  day    date    NOT NULL,
  domain text    NOT NULL,
  reason text    NOT NULL,
  count  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, domain, reason)
);

CREATE TABLE IF NOT EXISTS devices (
  key_hash   text        PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS flags (
  id         bigserial   PRIMARY KEY,
  key_hash   text        NOT NULL REFERENCES devices (key_hash),
  url_norm   text        NOT NULL,
  domain     text        NOT NULL,
  verdict    text        NOT NULL CHECK (verdict IN ('slop', 'fine')),
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flags_domain_idx ON flags (domain);
CREATE INDEX IF NOT EXISTS flags_key_created_idx ON flags (key_hash, created_at);

CREATE TABLE IF NOT EXISTS list_versions (
  version      text        PRIMARY KEY,
  bundle       jsonb       NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  day            date    NOT NULL,
  config_version integer NOT NULL,
  event          text    NOT NULL,
  count          integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, config_version, event)
);
```

- [ ] **Step 3: Write the DB helper and the failing test**

`apps/server/test/helpers/db.ts`:
```ts
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { connect, migrate, type Sql } from '../../src/db';

export async function startDb(): Promise<{ sql: Sql; stop: () => Promise<void> }> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const sql = connect(container.getConnectionUri());
  await migrate(sql);
  return {
    sql,
    stop: async () => {
      await sql.end();
      await container.stop();
    },
  };
}
```

`apps/server/test/repo.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Layer1Result, ListBundle } from '@gist/shared';
import { migrate, type Sql } from '../src/db';
import { createRepo, type Repo } from '../src/repo';
import { startDb } from './helpers/db';

const layer1: Layer1Result = {
  layer1Version: '1.0.0',
  dimensions: { info: { score: 50, signals: [] }, human: { score: 50, signals: [] }, monetization: { score: 50, signals: [] } },
  styleAdjust: 0,
  styleSignals: [],
  fetchedAt: '2026-09-29T00:00:00.000Z',
};
const bundle = (version: string): ListBundle => ({ version, domains: [], selectors: { version: 1, result: 'x', title: 'h3', exclude: [] } });
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

let db: Awaited<ReturnType<typeof startDb>>;
let sql: Sql;
let repo: Repo;

beforeAll(async () => {
  db = await startDb();
  sql = db.sql;
  repo = createRepo(sql);
});
afterAll(async () => db.stop());
beforeEach(async () => {
  await sql`TRUNCATE page_scores, fetch_failures, flags, devices, list_versions, events`;
});

describe('repo', () => {
  it('migrate is idempotent', async () => {
    await expect(migrate(sql)).resolves.toBeUndefined();
  });

  it('returns fresh ready scores and round-trips JSON', async () => {
    await repo.putScore({ urlNorm: 'https://a.com/', layer1Version: '1.0.0', status: 'ready', result: layer1, failReason: null, fetchedAt: new Date() });
    const got = await repo.getScores(['https://a.com/', 'https://b.com/'], '1.0.0');
    expect(got.size).toBe(1);
    expect(got.get('https://a.com/')?.result).toEqual(layer1);
  });

  it('expires ready after 14 days and failed after 1 day', async () => {
    await repo.putScore({ urlNorm: 'https://old.com/', layer1Version: '1.0.0', status: 'ready', result: layer1, failReason: null, fetchedAt: daysAgo(15) });
    await repo.putScore({ urlNorm: 'https://fail.com/', layer1Version: '1.0.0', status: 'failed', result: null, failReason: 'timeout', fetchedAt: daysAgo(2) });
    await repo.putScore({ urlNorm: 'https://failnew.com/', layer1Version: '1.0.0', status: 'failed', result: null, failReason: 'http_403', fetchedAt: new Date() });
    const got = await repo.getScores(['https://old.com/', 'https://fail.com/', 'https://failnew.com/'], '1.0.0');
    expect([...got.keys()]).toEqual(['https://failnew.com/']);
    expect(got.get('https://failnew.com/')?.failReason).toBe('http_403');
  });

  it('ignores other layer1 versions and upserts', async () => {
    await repo.putScore({ urlNorm: 'https://a.com/', layer1Version: '0.9.0', status: 'ready', result: layer1, failReason: null, fetchedAt: new Date() });
    expect((await repo.getScores(['https://a.com/'], '1.0.0')).size).toBe(0);
    await repo.putScore({ urlNorm: 'https://a.com/', layer1Version: '1.0.0', status: 'failed', result: null, failReason: 'parse', fetchedAt: new Date() });
    await repo.putScore({ urlNorm: 'https://a.com/', layer1Version: '1.0.0', status: 'ready', result: layer1, failReason: null, fetchedAt: new Date() });
    expect((await repo.getScores(['https://a.com/'], '1.0.0')).get('https://a.com/')?.status).toBe('ready');
  });

  it('counts failures per day, domain and reason', async () => {
    await repo.recordFailure('a.com', 'timeout');
    await repo.recordFailure('a.com', 'timeout');
    await repo.recordFailure('a.com', 'blocked_challenge');
    const rows = await repo.failureSummary(7);
    expect(rows).toEqual(expect.arrayContaining([{ domain: 'a.com', reason: 'timeout', count: 2 }, { domain: 'a.com', reason: 'blocked_challenge', count: 1 }]));
  });

  it('devices and flags', async () => {
    expect(await repo.deviceExists('h1')).toBe(false);
    await repo.registerDevice('h1');
    await repo.registerDevice('h1'); // idempotent
    expect(await repo.deviceExists('h1')).toBe(true);
    await repo.insertFlag({ keyHash: 'h1', urlNorm: 'https://farm.com/x', domain: 'farm.com', verdict: 'slop', reason: 'filler' });
    await repo.insertFlag({ keyHash: 'h1', urlNorm: 'https://farm.com/y', domain: 'farm.com', verdict: 'fine', reason: null });
    expect(await repo.countFlagsToday('h1')).toBe(2);
    const [row] = await repo.flagSummary();
    expect(row).toMatchObject({ domain: 'farm.com', slop: 1, fine: 1, devices: 1, reasons: { filler: 1 } });
  });

  it('latestBundle returns the most recently published version, and republishing promotes it', async () => {
    expect(await repo.latestBundle()).toBeNull();
    await repo.publishBundle(bundle('v1'));
    await repo.publishBundle(bundle('v2'));
    expect((await repo.latestBundle())?.version).toBe('v2');
    await repo.publishBundle(bundle('v1'));
    expect((await repo.latestBundle())?.version).toBe('v1');
  });

  it('records events', async () => {
    await repo.recordEvent(1, 'no_matches');
    await repo.recordEvent(1, 'no_matches');
    const [row] = await sql`SELECT count FROM events WHERE config_version = 1`;
    expect(row?.count).toBe(2);
  });
});
```

- [ ] **Step 4: Run the tests and confirm they fail**

Run: `pnpm test apps/server`
Expected: FAIL, "Failed to resolve import "../src/db"".

- [ ] **Step 5: Implement**

`apps/server/src/db.ts`:
```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

export type Sql = postgres.Sql;

export function connect(url: string): Sql {
  return postgres(url, { max: 10, onnotice: () => {} });
}

/** Runs every migration file in order. Files are written to be idempotent (IF NOT EXISTS). */
export async function migrate(sql: Sql): Promise<void> {
  const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await sql.unsafe(readFileSync(join(dir, file), 'utf8'));
  }
}
```

`apps/server/src/repo.ts`:
```ts
import type { FailReason, Layer1Result, ListBundle } from '@gist/shared';
import type { Sql } from './db';

export type StoredScore = {
  urlNorm: string;
  layer1Version: string;
  status: 'ready' | 'failed';
  result: Layer1Result | null;
  failReason: FailReason | null;
  fetchedAt: Date;
};
export type NewFlag = { keyHash: string; urlNorm: string; domain: string; verdict: 'slop' | 'fine'; reason: string | null };
export type FlagSummaryRow = { domain: string; slop: number; fine: number; devices: number; reasons: Record<string, number> | null; firstSeen: Date; lastSeen: Date };
export type FailureSummaryRow = { domain: string; reason: string; count: number };

export interface Repo {
  getScores(urls: string[], layer1Version: string): Promise<Map<string, StoredScore>>;
  putScore(s: StoredScore): Promise<void>;
  recordFailure(domain: string, reason: FailReason): Promise<void>;
  registerDevice(keyHash: string): Promise<void>;
  deviceExists(keyHash: string): Promise<boolean>;
  countFlagsToday(keyHash: string): Promise<number>;
  insertFlag(f: NewFlag): Promise<void>;
  latestBundle(): Promise<ListBundle | null>;
  publishBundle(b: ListBundle): Promise<void>;
  recordEvent(configVersion: number, event: string): Promise<void>;
  flagSummary(): Promise<FlagSummaryRow[]>;
  failureSummary(days: number): Promise<FailureSummaryRow[]>;
}

type ScoreRow = { url_norm: string; layer1_version: string; status: 'ready' | 'failed'; result: Layer1Result | null; fail_reason: FailReason | null; fetched_at: Date };

export function createRepo(sql: Sql): Repo {
  return {
    async getScores(urls, layer1Version) {
      const out = new Map<string, StoredScore>();
      if (urls.length === 0) return out;
      const rows = await sql<ScoreRow[]>`
        SELECT url_norm, layer1_version, status, result, fail_reason, fetched_at
        FROM page_scores
        WHERE url_norm = ANY(${sql.array(urls)}::text[])
          AND layer1_version = ${layer1Version}
          AND ((status = 'ready'  AND fetched_at > now() - interval '14 days')
            OR (status = 'failed' AND fetched_at > now() - interval '1 day'))`;
      for (const r of rows) {
        out.set(r.url_norm, { urlNorm: r.url_norm, layer1Version: r.layer1_version, status: r.status, result: r.result, failReason: r.fail_reason, fetchedAt: r.fetched_at });
      }
      return out;
    },

    async putScore(s) {
      await sql`
        INSERT INTO page_scores (url_norm, layer1_version, status, result, fail_reason, fetched_at)
        VALUES (${s.urlNorm}, ${s.layer1Version}, ${s.status}, ${s.result ? sql.json(s.result as never) : null}, ${s.failReason}, ${s.fetchedAt})
        ON CONFLICT (url_norm, layer1_version) DO UPDATE
          SET status = EXCLUDED.status, result = EXCLUDED.result, fail_reason = EXCLUDED.fail_reason, fetched_at = EXCLUDED.fetched_at`;
    },

    async recordFailure(domain, reason) {
      await sql`
        INSERT INTO fetch_failures (day, domain, reason, count) VALUES (current_date, ${domain}, ${reason}, 1)
        ON CONFLICT (day, domain, reason) DO UPDATE SET count = fetch_failures.count + 1`;
    },

    async registerDevice(keyHash) {
      await sql`INSERT INTO devices (key_hash) VALUES (${keyHash}) ON CONFLICT DO NOTHING`;
    },

    async deviceExists(keyHash) {
      const rows = await sql`SELECT 1 FROM devices WHERE key_hash = ${keyHash}`;
      return rows.length > 0;
    },

    async countFlagsToday(keyHash) {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM flags WHERE key_hash = ${keyHash} AND created_at >= date_trunc('day', now())`;
      return row?.n ?? 0;
    },

    async insertFlag(f) {
      await sql`
        INSERT INTO flags (key_hash, url_norm, domain, verdict, reason)
        VALUES (${f.keyHash}, ${f.urlNorm}, ${f.domain}, ${f.verdict}, ${f.reason})`;
    },

    async latestBundle() {
      const [row] = await sql<{ bundle: ListBundle }[]>`SELECT bundle FROM list_versions ORDER BY published_at DESC LIMIT 1`;
      return row?.bundle ?? null;
    },

    async publishBundle(b) {
      await sql`
        INSERT INTO list_versions (version, bundle) VALUES (${b.version}, ${sql.json(b as never)})
        ON CONFLICT (version) DO UPDATE SET published_at = now()`;
    },

    async recordEvent(configVersion, event) {
      await sql`
        INSERT INTO events (day, config_version, event, count) VALUES (current_date, ${configVersion}, ${event}, 1)
        ON CONFLICT (day, config_version, event) DO UPDATE SET count = events.count + 1`;
    },

    async flagSummary() {
      const rows = await sql<{ domain: string; slop: number; fine: number; devices: number; reasons: Record<string, number> | null; first_seen: Date; last_seen: Date }[]>`
        SELECT f.domain,
               count(*) FILTER (WHERE f.verdict = 'slop')::int AS slop,
               count(*) FILTER (WHERE f.verdict = 'fine')::int AS fine,
               count(DISTINCT f.key_hash)::int AS devices,
               (SELECT jsonb_object_agg(r.reason, r.n)
                  FROM (SELECT reason, count(*)::int AS n FROM flags f2
                        WHERE f2.domain = f.domain AND reason IS NOT NULL GROUP BY reason) r) AS reasons,
               min(f.created_at) AS first_seen,
               max(f.created_at) AS last_seen
        FROM flags f
        GROUP BY f.domain
        ORDER BY slop DESC, devices DESC
        LIMIT 200`;
      return rows.map((r) => ({ domain: r.domain, slop: r.slop, fine: r.fine, devices: r.devices, reasons: r.reasons, firstSeen: r.first_seen, lastSeen: r.last_seen }));
    },

    async failureSummary(days) {
      return sql<FailureSummaryRow[]>`
        SELECT domain, reason, sum(count)::int AS count
        FROM fetch_failures
        WHERE day > current_date - ${days}::int
        GROUP BY domain, reason
        ORDER BY count DESC
        LIMIT 100`;
    },
  };
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm test apps/server`
Expected: PASS. The first run pulls `postgres:16-alpine`, so allow a few minutes. If `failureSummary` returns a `RowList` whose `toEqual` comparison fails, wrap the return value in `[...rows]`.

---

### Task 9: SSRF-safe page fetcher

**Files:**
- Create: `apps/server/src/fetcher/ssrf.ts`, `apps/server/src/fetcher/fetchPage.ts`
- Test: `apps/server/test/ssrf.test.ts`, `apps/server/test/fetchPage.test.ts`

**Interfaces:**
- Consumes: `FailReason` from `@gist/shared`.
- Produces:
  - `type AddressPolicy = (ip: string) => boolean`; `isPublicAddress: AddressPolicy`; `hostIsIpLiteral(hostname): string | null`
  - `createSafeLookup(policy)`; `createSafeAgent(policy: AddressPolicy): Agent`
  - `type FetchOutcome = { ok: true; html: string; finalUrl: string } | { ok: false; reason: FailReason }`
  - `type FetchOptions = { dispatcher: Dispatcher; userAgent: string; policy: AddressPolicy; robotsAllowed: (url: string) => Promise<boolean>; timeoutMs?: number; maxBytes?: number; maxRedirects?: number }`
  - `fetchPage(url: string, o: FetchOptions): Promise<FetchOutcome>`
  - `fetchText(url, o: { dispatcher; userAgent; policy }): Promise<string | null>` (used for robots.txt)
  - `looksLikeChallenge(status: number, body: string): boolean`

- [ ] **Step 1: Write the failing tests**

`apps/server/test/ssrf.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createSafeLookup, hostIsIpLiteral, isPublicAddress } from '../src/fetcher/ssrf';

describe('isPublicAddress', () => {
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('allows public %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '255.255.255.255', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
});

describe('hostIsIpLiteral', () => {
  it('detects v4 and bracketed v6 literals', () => {
    expect(hostIsIpLiteral('127.0.0.1')).toBe('127.0.0.1');
    expect(hostIsIpLiteral('[::1]')).toBe('::1');
    expect(hostIsIpLiteral('example.com')).toBeNull();
  });
});

describe('createSafeLookup', () => {
  it('rejects hostnames resolving to private addresses', async () => {
    const lookup = createSafeLookup(isPublicAddress);
    const err = await new Promise<unknown>((resolve) => lookup('localhost', {}, (e: unknown) => resolve(e)));
    expect((err as { code?: string }).code).toBe('ESSRF');
  });
});
```

`apps/server/test/fetchPage.test.ts`:
```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSafeAgent, isPublicAddress } from '../src/fetcher/ssrf';
import { fetchPage, looksLikeChallenge, type FetchOptions } from '../src/fetcher/fetchPage';

let server: Server;
let base: string;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    const html = (s: number, body: string) => { res.writeHead(s, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
    switch (req.url) {
      case '/ok': return html(200, '<html><body><p>hello</p></body></html>');
      case '/ua': return html(200, String(req.headers['user-agent']));
      case '/redirect': res.writeHead(302, { location: '/ok' }); return res.end();
      case '/loop': res.writeHead(302, { location: '/loop' }); return res.end();
      case '/to-private': res.writeHead(302, { location: `http://127.0.0.2:${port}/ok` }); return res.end();
      case '/json': res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}');
      case '/big': return html(200, `<p>${'x'.repeat(5000)}</p>`);
      case '/cf': return html(503, '<html><head><title>Just a moment...</title></head><body>cf-chl</body></html>');
      case '/missing': return html(404, 'not found');
      case '/slow': return; // never responds
      default: return html(500, 'err');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});
afterAll(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

const localOnly = (ip: string) => ip === '127.0.0.1';
const opts = (over: Partial<FetchOptions> = {}): FetchOptions => ({
  dispatcher: createSafeAgent(localOnly),
  userAgent: 'GistBot/1.0 (+https://example.test/bot)',
  policy: localOnly,
  robotsAllowed: async () => true,
  timeoutMs: 1000,
  maxBytes: 1000,
  ...over,
});

describe('fetchPage', () => {
  it('fetches html and sends the GistBot user agent', async () => {
    expect(await fetchPage(`${base}/ok`, opts())).toMatchObject({ ok: true, finalUrl: `${base}/ok` });
    const ua = await fetchPage(`${base}/ua`, opts());
    expect(ua.ok && ua.html).toContain('GistBot/1.0');
  });
  it('follows redirects', async () => {
    expect(await fetchPage(`${base}/redirect`, opts())).toMatchObject({ ok: true, finalUrl: `${base}/ok` });
  });
  it('stops redirect loops', async () => {
    expect(await fetchPage(`${base}/loop`, opts())).toEqual({ ok: false, reason: 'network' });
  });
  it('re-checks policy after a redirect', async () => {
    expect(await fetchPage(`${base}/to-private`, opts())).toEqual({ ok: false, reason: 'ssrf' });
  });
  it('classifies non-html, too-large, challenge, http errors and timeouts', async () => {
    expect(await fetchPage(`${base}/json`, opts())).toEqual({ ok: false, reason: 'not_html' });
    expect(await fetchPage(`${base}/big`, opts())).toEqual({ ok: false, reason: 'too_large' });
    expect(await fetchPage(`${base}/cf`, opts())).toEqual({ ok: false, reason: 'blocked_challenge' });
    expect(await fetchPage(`${base}/missing`, opts())).toEqual({ ok: false, reason: 'http_404' });
    expect(await fetchPage(`${base}/slow`, opts({ timeoutMs: 200 }))).toEqual({ ok: false, reason: 'timeout' });
  });
  it('honours robots', async () => {
    expect(await fetchPage(`${base}/ok`, opts({ robotsAllowed: async () => false }))).toEqual({ ok: false, reason: 'robots' });
  });
});

describe('fetchPage with the production policy', () => {
  const prod = () => opts({ dispatcher: createSafeAgent(isPublicAddress), policy: isPublicAddress });
  it.each([
    ['loopback literal', () => `${base}/ok`],
    ['v6 loopback literal', () => `http://[::1]:${port}/ok`],
    ['cloud metadata', () => 'http://169.254.169.254/latest/meta-data/'],
    ['hostname resolving to loopback', () => `http://localhost:${port}/ok`],
    ['non-http scheme', () => 'file:///etc/passwd'],
  ])('blocks %s', async (_, url) => {
    expect(await fetchPage(url(), prod())).toEqual({ ok: false, reason: 'ssrf' });
  });
});

describe('looksLikeChallenge', () => {
  it('needs a challenge marker', () => {
    expect(looksLikeChallenge(403, 'Forbidden')).toBe(false);
    expect(looksLikeChallenge(403, '<script src="/cdn-cgi/challenge-platform/x"></script>')).toBe(true);
  });
  it('ignores long normal pages that merely mention captcha-like strings', () => {
    expect(looksLikeChallenge(200, `cf-chl ${'x'.repeat(30_000)}`)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm test apps/server/test/ssrf apps/server/test/fetchPage`
Expected: FAIL, "Failed to resolve import "../src/fetcher/ssrf"".

- [ ] **Step 3: Implement**

`apps/server/src/fetcher/ssrf.ts`:
```ts
import dns from 'node:dns';
import ipaddr from 'ipaddr.js';
import { Agent } from 'undici';

export type AddressPolicy = (ip: string) => boolean;

/** Only globally routable unicast addresses. IPv4-mapped IPv6 is unwrapped first. */
export const isPublicAddress: AddressPolicy = (ip) => {
  if (!ipaddr.isValid(ip)) return false;
  let addr = ipaddr.parse(ip);
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) addr = v6.toIPv4Address();
  }
  return addr.range() === 'unicast';
};

export function hostIsIpLiteral(hostname: string): string | null {
  const h = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return ipaddr.isValid(h) ? h : null;
}

export class SsrfError extends Error {
  readonly code = 'ESSRF';
}

type LookupCallback = (err: Error | null, address?: string | dns.LookupAddress[], family?: number) => void;

/**
 * dns.lookup replacement used by the socket itself. The address we validate is the address we connect to,
 * which closes the DNS-rebinding gap between "check" and "connect".
 */
export function createSafeLookup(policy: AddressPolicy) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = addresses as dns.LookupAddress[];
      if (list.length === 0 || list.some((a) => !policy(a.address))) {
        return callback(new SsrfError(`blocked address for ${hostname}`));
      }
      if (options.all) return callback(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

export function createSafeAgent(policy: AddressPolicy): Agent {
  return new Agent({ connect: { lookup: createSafeLookup(policy) as never }, connections: 50 });
}
```

`apps/server/src/fetcher/fetchPage.ts`:
```ts
import { request, type Dispatcher } from 'undici';
import type { FailReason } from '@gist/shared';
import { hostIsIpLiteral, type AddressPolicy } from './ssrf';

export type FetchOutcome = { ok: true; html: string; finalUrl: string } | { ok: false; reason: FailReason };
export type FetchOptions = {
  dispatcher: Dispatcher;
  userAgent: string;
  policy: AddressPolicy;
  robotsAllowed: (url: string) => Promise<boolean>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
};

const CHALLENGE =
  /cf-chl|challenge-platform|<title>\s*Just a moment\.\.\.\s*<\/title>|Attention Required! \| Cloudflare|captcha-delivery\.com|px-captcha|_Incapsula_Resource/i;

export function looksLikeChallenge(status: number, body: string): boolean {
  if (!CHALLENGE.test(body)) return false;
  return status === 403 || status === 429 || status === 503 || body.length < 20_000;
}

function classifyError(err: unknown): FailReason {
  const e = err as { name?: string; code?: string; cause?: { code?: string; name?: string } } | null;
  if (e?.code === 'ESSRF' || e?.cause?.code === 'ESSRF') return 'ssrf';
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || e?.cause?.name === 'TimeoutError' || /TIMEOUT|ABORTED/.test(e?.code ?? '')) {
    return 'timeout';
  }
  return 'network';
}

async function readCapped(body: Dispatcher.ResponseData['body'], max: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += (chunk as Buffer).length;
    if (size > max) {
      body.destroy();
      return null;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function blockedTarget(target: URL, policy: AddressPolicy): boolean {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return true;
  const literal = hostIsIpLiteral(target.hostname);
  return literal !== null && !policy(literal);
}

export async function fetchPage(url: string, o: FetchOptions): Promise<FetchOutcome> {
  const timeoutMs = o.timeoutMs ?? 8000;
  const maxBytes = o.maxBytes ?? 3 * 1024 * 1024;
  const maxRedirects = o.maxRedirects ?? 5;
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let target: URL;
    try {
      target = new URL(current);
    } catch {
      return { ok: false, reason: 'ssrf' };
    }
    if (blockedTarget(target, o.policy)) return { ok: false, reason: 'ssrf' };
    if (!(await o.robotsAllowed(target.toString()))) return { ok: false, reason: 'robots' };

    try {
      const res = await request(target, {
        method: 'GET',
        dispatcher: o.dispatcher,
        signal,
        headers: { 'user-agent': o.userAgent, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', 'accept-language': 'en' },
      });
      const status = res.statusCode;
      if (status >= 300 && status < 400) {
        await res.body.dump();
        const location = res.headers.location;
        if (!location) return { ok: false, reason: `http_${status}` };
        current = new URL(String(location), target).toString();
        continue;
      }
      if (status >= 400) {
        const body = (await readCapped(res.body, 64 * 1024)) ?? '';
        return { ok: false, reason: looksLikeChallenge(status, body) ? 'blocked_challenge' : `http_${status}` };
      }
      if (!/text\/html|application\/xhtml\+xml/i.test(String(res.headers['content-type'] ?? ''))) {
        await res.body.dump();
        return { ok: false, reason: 'not_html' };
      }
      const html = await readCapped(res.body, maxBytes);
      if (html === null) return { ok: false, reason: 'too_large' };
      if (looksLikeChallenge(status, html)) return { ok: false, reason: 'blocked_challenge' };
      return { ok: true, html, finalUrl: target.toString() };
    } catch (err) {
      return { ok: false, reason: classifyError(err) };
    }
  }
  return { ok: false, reason: 'network' }; // too many redirects
}

export async function fetchText(url: string, o: { dispatcher: Dispatcher; userAgent: string; policy: AddressPolicy }): Promise<string | null> {
  try {
    const target = new URL(url);
    if (blockedTarget(target, o.policy)) return null;
    const res = await request(target, { dispatcher: o.dispatcher, signal: AbortSignal.timeout(5000), headers: { 'user-agent': o.userAgent } });
    if (res.statusCode !== 200) {
      await res.body.dump();
      return null;
    }
    return await readCapped(res.body, 500 * 1024);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm test apps/server/test/ssrf apps/server/test/fetchPage`
Expected: PASS. If "hostname resolving to loopback" returns `network` rather than `ssrf`, log the thrown error. It means undici wraps the lookup error differently, so extend `classifyError` to find `ESSRF` wherever it appears (e.g. `err.cause.cause`). Don't weaken the test.

---

### Task 10: robots.txt (GistBot rules only)

**Files:**
- Create: `apps/server/src/fetcher/robots.ts`
- Test: `apps/server/test/robots.test.ts`

**Interfaces:**
- Produces: `type RobotsRules = { allow: string[]; disallow: string[] }`; `parseRobotsForAgent(txt: string, agent?: string): RobotsRules | null`; `isPathAllowed(rules: RobotsRules | null, pathWithQuery: string): boolean`; `createRobotsChecker(deps: { fetchText: (url: string) => Promise<string | null>; now: () => number; ttlMs?: number }): (url: string) => Promise<boolean>`

- [ ] **Step 1: Write the failing test**

`apps/server/test/robots.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { createRobotsChecker, isPathAllowed, parseRobotsForAgent } from '../src/fetcher/robots';

describe('parseRobotsForAgent', () => {
  it('ignores rules aimed only at *', () => {
    expect(parseRobotsForAgent('User-agent: *\nDisallow: /')).toBeNull();
  });
  it('collects GistBot rules case-insensitively, including multi-agent groups', () => {
    const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: Foo\nUser-agent: gistbot\nDisallow: /private\nAllow: /private/ok\n# comment\n';
    expect(parseRobotsForAgent(txt)).toEqual({ allow: ['/private/ok'], disallow: ['/private'] });
  });
  it('treats "GistBot/1.0" as GistBot', () => {
    expect(parseRobotsForAgent('User-agent: GistBot/1.0\nDisallow: /x')).toEqual({ allow: [], disallow: ['/x'] });
  });
  it('empty Disallow means allow everything', () => {
    expect(parseRobotsForAgent('User-agent: GistBot\nDisallow:')).toEqual({ allow: [], disallow: [] });
  });
});

describe('isPathAllowed', () => {
  const rules = { allow: ['/private/ok', '/*.html$'], disallow: ['/private', '/tmp*'] };
  it('applies longest match, allow wins ties', () => {
    expect(isPathAllowed(rules, '/private/secret')).toBe(false);
    expect(isPathAllowed(rules, '/private/ok/page')).toBe(true);
    expect(isPathAllowed(rules, '/tmpfile')).toBe(false);
    expect(isPathAllowed(rules, '/public')).toBe(true);
  });
  it('supports $ anchoring', () => {
    expect(isPathAllowed({ allow: [], disallow: ['/*.pdf$'] }, '/a.pdf')).toBe(false);
    expect(isPathAllowed({ allow: [], disallow: ['/*.pdf$'] }, '/a.pdf?x=1')).toBe(true);
  });
  it('null rules allow everything', () => {
    expect(isPathAllowed(null, '/anything')).toBe(true);
  });
});

describe('createRobotsChecker', () => {
  it('fetches robots.txt once per origin within the TTL, then refreshes', async () => {
    let t = 0;
    const fetchText = vi.fn(async () => 'User-agent: GistBot\nDisallow: /no');
    const check = createRobotsChecker({ fetchText, now: () => t, ttlMs: 1000 });
    expect(await check('https://a.com/yes')).toBe(true);
    expect(await check('https://a.com/no')).toBe(false);
    expect(fetchText).toHaveBeenCalledTimes(1);
    expect(fetchText).toHaveBeenCalledWith('https://a.com/robots.txt');
    t = 2000;
    await check('https://a.com/yes');
    expect(fetchText).toHaveBeenCalledTimes(2);
  });
  it('treats a missing robots.txt as allow', async () => {
    const check = createRobotsChecker({ fetchText: async () => null, now: () => 0 });
    expect(await check('https://b.com/x')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm test apps/server/test/robots`
Expected: FAIL, "Failed to resolve import "../src/fetcher/robots"".

- [ ] **Step 3: Implement**

`apps/server/src/fetcher/robots.ts`:
```ts
export type RobotsRules = { allow: string[]; disallow: string[] };

/**
 * Returns rules from groups naming GistBot, or null if none do. Groups for `*` are deliberately ignored:
 * fetches are triggered by a user's search, like a link preview (spec §6.2).
 */
export function parseRobotsForAgent(txt: string, agent = 'gistbot'): RobotsRules | null {
  const rules: RobotsRules = { allow: [], disallow: [] };
  let matched = false;
  let groupAgents: string[] = [];
  let inRules = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const idx = line.indexOf(':');
    if (!line || idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (inRules) {
        groupAgents = [];
        inRules = false;
      }
      groupAgents.push(value.toLowerCase().split('/')[0]!.trim());
      if (groupAgents.includes(agent)) matched = true;
    } else if (key === 'allow' || key === 'disallow') {
      inRules = true;
      if (groupAgents.includes(agent) && value) (key === 'allow' ? rules.allow : rules.disallow).push(value);
    }
  }
  return matched ? rules : null;
}

function patternToRegex(p: string): RegExp {
  const anchored = p.endsWith('$');
  const body = anchored ? p.slice(0, -1) : p;
  const escaped = body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

export function isPathAllowed(rules: RobotsRules | null, pathWithQuery: string): boolean {
  if (!rules) return true;
  let best: { len: number; allow: boolean } | null = null;
  const consider = (patterns: string[], allow: boolean) => {
    for (const p of patterns) {
      if (!patternToRegex(p).test(pathWithQuery)) continue;
      if (!best || p.length > best.len || (p.length === best.len && allow)) best = { len: p.length, allow };
    }
  };
  consider(rules.disallow, false);
  consider(rules.allow, true);
  return best ? (best as { allow: boolean }).allow : true;
}

export function createRobotsChecker(deps: { fetchText: (url: string) => Promise<string | null>; now: () => number; ttlMs?: number }) {
  const ttl = deps.ttlMs ?? 24 * 60 * 60 * 1000;
  const cache = new Map<string, { at: number; rules: Promise<RobotsRules | null> }>();
  return async (url: string): Promise<boolean> => {
    const u = new URL(url);
    let hit = cache.get(u.origin);
    if (!hit || deps.now() - hit.at > ttl) {
      if (cache.size > 10_000) cache.clear();
      hit = { at: deps.now(), rules: deps.fetchText(`${u.origin}/robots.txt`).then((t) => (t ? parseRobotsForAgent(t) : null)) };
      cache.set(u.origin, hit);
    }
    return isPathAllowed(await hit.rules, u.pathname + u.search);
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm test apps/server/test/robots`
Expected: PASS.

---

### Task 11: Fetch queue and score service

**Files:**
- Create: `apps/server/src/queue.ts`, `apps/server/src/scoreService.ts`
- Test: `apps/server/test/queue.test.ts`, `apps/server/test/scoreService.test.ts`

**Interfaces:**
- Consumes: `Repo` (`getScores`, `putScore`, `recordFailure`) from Task 8; `FetchOutcome` from Task 9; `normalizeUrl`, `registrableDomain`, `ScoreItem`, `Layer1Result` from `@gist/shared`.
- Produces:
  - `class FetchQueue` with `constructor(opts: { global: number; perDomain: number; maxWaiting?: number })`, `push(domain: string, task: () => Promise<void>): boolean`, `onIdle(): Promise<void>`
  - `type ScoreService = { lookup(urls: string[]): Promise<Record<string, ScoreItem>> }`
  - `createScoreService(deps: { repo: Pick<Repo, 'getScores' | 'putScore' | 'recordFailure'>; queue: FetchQueue; fetchPage: (url: string) => Promise<FetchOutcome>; score: (html: string, at: Date) => Layer1Result; now: () => Date; version: string }): ScoreService`

- [ ] **Step 1: Write the failing tests**

`apps/server/test/queue.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { FetchQueue } from '../src/queue';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('FetchQueue', () => {
  it('respects global and per-domain limits', async () => {
    const q = new FetchQueue({ global: 3, perDomain: 2 });
    const running = new Map<string, number>();
    let maxTotal = 0;
    let maxA = 0;
    const gates = Array.from({ length: 6 }, deferred);
    gates.forEach((g, i) => {
      const domain = i < 4 ? 'a.com' : 'b.com';
      q.push(domain, async () => {
        running.set(domain, (running.get(domain) ?? 0) + 1);
        maxTotal = Math.max(maxTotal, [...running.values()].reduce((x, y) => x + y, 0));
        maxA = Math.max(maxA, running.get('a.com') ?? 0);
        await g.promise;
        running.set(domain, running.get(domain)! - 1);
      });
    });
    gates.forEach((g) => g.resolve());
    await q.onIdle();
    expect(maxTotal).toBeLessThanOrEqual(3);
    expect(maxA).toBeLessThanOrEqual(2);
  });

  it('keeps going when a task throws', async () => {
    const q = new FetchQueue({ global: 1, perDomain: 1 });
    let ran = false;
    q.push('a', async () => { throw new Error('boom'); });
    q.push('a', async () => { ran = true; });
    await q.onIdle();
    expect(ran).toBe(true);
  });

  it('refuses work past maxWaiting', () => {
    const q = new FetchQueue({ global: 1, perDomain: 1, maxWaiting: 1 });
    const never = () => new Promise<void>(() => {});
    expect(q.push('a', never)).toBe(true); // running
    expect(q.push('a', never)).toBe(true); // waiting
    expect(q.push('a', never)).toBe(false);
  });
});
```

`apps/server/test/scoreService.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import type { Layer1Result } from '@gist/shared';
import { FetchQueue } from '../src/queue';
import type { StoredScore } from '../src/repo';
import { createScoreService } from '../src/scoreService';
import type { FetchOutcome } from '../src/fetcher/fetchPage';

const fakeResult: Layer1Result = {
  layer1Version: '1.0.0',
  dimensions: { info: { score: 70, signals: [] }, human: { score: 70, signals: [] }, monetization: { score: 70, signals: [] } },
  styleAdjust: 0, styleSignals: [], fetchedAt: '2026-09-29T00:00:00.000Z',
};

function setup(fetchImpl: (url: string) => Promise<FetchOutcome>, score = (_h: string, _a: Date) => fakeResult) {
  const store = new Map<string, StoredScore>();
  const failures: [string, string][] = [];
  const repo = {
    getScores: vi.fn(async (urls: string[]) => new Map(urls.filter((u) => store.has(u)).map((u) => [u, store.get(u)!]))),
    putScore: vi.fn(async (s: StoredScore) => { store.set(s.urlNorm, s); }),
    recordFailure: vi.fn(async (d: string, r: string) => { failures.push([d, r]); }),
  };
  const queue = new FetchQueue({ global: 5, perDomain: 2 });
  const fetchPage = vi.fn(fetchImpl);
  const svc = createScoreService({ repo, queue, fetchPage, score, now: () => new Date('2026-09-29T00:00:00Z'), version: '1.0.0' });
  return { svc, queue, repo, fetchPage, failures };
}

describe('scoreService', () => {
  it('returns pending on a miss, then ready once fetched', async () => {
    const { svc, queue } = setup(async () => ({ ok: true, html: '<p>x</p>', finalUrl: 'https://a.com/' }));
    expect(await svc.lookup(['https://a.com/'])).toEqual({ 'https://a.com/': { status: 'pending' } });
    await queue.onIdle();
    expect(await svc.lookup(['https://a.com/'])).toEqual({ 'https://a.com/': { status: 'ready', layer1: fakeResult } });
  });

  it('fetches a URL only once even if asked repeatedly while in flight', async () => {
    const { svc, queue, fetchPage } = setup(async () => ({ ok: true, html: '', finalUrl: '' }));
    await svc.lookup(['https://a.com/']);
    await svc.lookup(['https://a.com/']);
    await queue.onIdle();
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('stores failures with reason and counts them by registrable domain', async () => {
    const { svc, queue, failures } = setup(async () => ({ ok: false, reason: 'blocked_challenge' }));
    await svc.lookup(['https://www.shop.example.co.uk/p']);
    await queue.onIdle();
    expect(await svc.lookup(['https://www.shop.example.co.uk/p'])).toEqual({
      'https://www.shop.example.co.uk/p': { status: 'failed', reason: 'blocked_challenge' },
    });
    expect(failures).toEqual([['example.co.uk', 'blocked_challenge']]);
  });

  it('records parse failures when the scorer throws', async () => {
    const { svc, queue } = setup(async () => ({ ok: true, html: '', finalUrl: '' }), () => { throw new Error('bad'); });
    await svc.lookup(['https://a.com/']);
    await queue.onIdle();
    expect((await svc.lookup(['https://a.com/']))['https://a.com/']).toEqual({ status: 'failed', reason: 'parse' });
  });

  it('answers keyed by the URL as sent, and rejects non-http URLs without fetching', async () => {
    const { svc, fetchPage } = setup(async () => ({ ok: true, html: '', finalUrl: '' }));
    const res = await svc.lookup(['HTTPS://A.com/x#frag', 'javascript:alert(1)']);
    expect(res['HTTPS://A.com/x#frag']).toEqual({ status: 'pending' });
    expect(res['javascript:alert(1)']).toEqual({ status: 'failed', reason: 'ssrf' });
    expect(fetchPage).toHaveBeenCalledWith('https://a.com/x');
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm test apps/server/test/queue apps/server/test/scoreService`
Expected: FAIL, unresolved imports.

- [ ] **Step 3: Implement**

`apps/server/src/queue.ts`:
```ts
type Job = { domain: string; run: () => Promise<void> };

/** In-process queue with a global and a per-domain concurrency cap (spec §6.2). */
export class FetchQueue {
  private active = 0;
  private readonly perDomainActive = new Map<string, number>();
  private readonly waiting: Job[] = [];
  private idleWaiters: (() => void)[] = [];

  constructor(private readonly opts: { global: number; perDomain: number; maxWaiting?: number }) {}

  /** Returns false (and drops the task) when the backlog is full; callers treat that URL as still pending. */
  push(domain: string, run: () => Promise<void>): boolean {
    if (this.waiting.length >= (this.opts.maxWaiting ?? 5000)) return false;
    this.waiting.push({ domain, run });
    this.pump();
    return true;
  }

  onIdle(): Promise<void> {
    if (this.active === 0 && this.waiting.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private pump(): void {
    for (let i = 0; i < this.waiting.length && this.active < this.opts.global; ) {
      const job = this.waiting[i]!;
      if ((this.perDomainActive.get(job.domain) ?? 0) >= this.opts.perDomain) {
        i++;
        continue;
      }
      this.waiting.splice(i, 1);
      this.start(job);
    }
    if (this.active === 0 && this.waiting.length === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      waiters.forEach((w) => w());
    }
  }

  private start(job: Job): void {
    this.active++;
    this.perDomainActive.set(job.domain, (this.perDomainActive.get(job.domain) ?? 0) + 1);
    job
      .run()
      .catch(() => {})
      .finally(() => {
        this.active--;
        const n = this.perDomainActive.get(job.domain)! - 1;
        if (n === 0) this.perDomainActive.delete(job.domain);
        else this.perDomainActive.set(job.domain, n);
        this.pump();
      });
  }
}
```

`apps/server/src/scoreService.ts`:
```ts
import { normalizeUrl, registrableDomain, type FailReason, type Layer1Result, type ScoreItem } from '@gist/shared';
import type { FetchOutcome } from './fetcher/fetchPage';
import type { FetchQueue } from './queue';
import type { Repo } from './repo';

export type ScoreService = { lookup(urls: string[]): Promise<Record<string, ScoreItem>> };

export function createScoreService(deps: {
  repo: Pick<Repo, 'getScores' | 'putScore' | 'recordFailure'>;
  queue: FetchQueue;
  fetchPage: (url: string) => Promise<FetchOutcome>;
  score: (html: string, at: Date) => Layer1Result;
  now: () => Date;
  version: string;
}): ScoreService {
  const inflight = new Set<string>();

  const domainOf = (url: string) => registrableDomain(url) ?? new URL(url).hostname;

  async function fail(url: string, reason: FailReason) {
    await deps.repo.putScore({ urlNorm: url, layer1Version: deps.version, status: 'failed', result: null, failReason: reason, fetchedAt: deps.now() });
    await deps.repo.recordFailure(domainOf(url), reason);
  }

  function enqueue(url: string) {
    if (inflight.has(url)) return;
    inflight.add(url);
    const accepted = deps.queue.push(domainOf(url), async () => {
      try {
        const out = await deps.fetchPage(url);
        if (!out.ok) return await fail(url, out.reason);
        let result: Layer1Result;
        try {
          result = deps.score(out.html, deps.now());
        } catch {
          return await fail(url, 'parse');
        }
        await deps.repo.putScore({ urlNorm: url, layer1Version: deps.version, status: 'ready', result, failReason: null, fetchedAt: deps.now() });
      } finally {
        inflight.delete(url);
      }
    });
    if (!accepted) inflight.delete(url);
  }

  return {
    async lookup(rawUrls) {
      const out: Record<string, ScoreItem> = {};
      const norm = new Map<string, string>();
      for (const raw of rawUrls) {
        const n = normalizeUrl(raw);
        if (n) norm.set(raw, n);
        else out[raw] = { status: 'failed', reason: 'ssrf' };
      }
      const stored = await deps.repo.getScores([...new Set(norm.values())], deps.version);
      for (const [raw, n] of norm) {
        const s = stored.get(n);
        if (s?.status === 'ready' && s.result) out[raw] = { status: 'ready', layer1: s.result };
        else if (s?.status === 'failed' && s.failReason) out[raw] = { status: 'failed', reason: s.failReason };
        else {
          out[raw] = { status: 'pending' };
          enqueue(n);
        }
      }
      return out;
    },
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm test apps/server/test/queue apps/server/test/scoreService`
Expected: PASS.

---

### Task 12: HTTP API (routes, rate limits, privacy-safe logging)

**Files:**
- Create: `apps/server/src/rateLimit.ts`, `apps/server/src/clientIp.ts`, `apps/server/src/app.ts`
- Create: `apps/server/test/helpers/memoryRepo.ts`
- Test: `apps/server/test/rateLimit.test.ts`, `apps/server/test/app.test.ts`

**Interfaces:**
- Consumes: `ScoreService` (Task 11), `Repo` (Task 8), schemas and `normalizeUrl`/`registrableDomain` from `@gist/shared`.
- Produces:
  - `type RateLimiter = { take(key: string, limit: number, windowMs: number): boolean }`; `createRateLimiter(now?: () => number): RateLimiter`
  - `createClientIp(header: string | undefined): (c: Context) => string`
  - `type AppDeps = { scores: ScoreService; repo: Pick<Repo, 'latestBundle' | 'registerDevice' | 'deviceExists' | 'countFlagsToday' | 'insertFlag' | 'recordEvent'>; limiter: RateLimiter; clientIp: (c: Context) => string; log: (line: string) => void }`
  - `createApp(deps: AppDeps): Hono`
  - `sha256Hex(s: string): string`

- [ ] **Step 1: Write the failing tests**

`apps/server/test/rateLimit.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../src/rateLimit';

describe('rate limiter', () => {
  it('allows up to the limit per window, per key, then resets', () => {
    let t = 0;
    const rl = createRateLimiter(() => t);
    expect([1, 2, 3].map(() => rl.take('a', 2, 1000))).toEqual([true, true, false]);
    expect(rl.take('b', 2, 1000)).toBe(true);
    t = 1000;
    expect(rl.take('a', 2, 1000)).toBe(true);
  });
});
```

`apps/server/test/helpers/memoryRepo.ts`:
```ts
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
```

`apps/server/test/app.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { ListBundle } from '@gist/shared';
import { createApp, sha256Hex } from '../src/app';
import { createRateLimiter } from '../src/rateLimit';
import { createMemoryRepo } from './helpers/memoryRepo';

const KEY = 'a'.repeat(64);
const bundle: ListBundle = { version: 'abc123def456', domains: [], selectors: { version: 1, result: 'x', title: 'h3', exclude: [] } };

function setup(b: ListBundle | null = bundle) {
  const mem = createMemoryRepo(b);
  const logs: string[] = [];
  const scoreCalls: string[][] = [];
  const app = createApp({
    scores: { lookup: async (urls) => { scoreCalls.push(urls); return Object.fromEntries(urls.map((u) => [u, { status: 'pending' as const }])); } },
    repo: mem.repo,
    limiter: createRateLimiter(() => 0),
    clientIp: () => '203.0.113.9',
    log: (l) => logs.push(l),
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { app, mem, logs, scoreCalls, post };
}

describe('POST /score', () => {
  it('passes urls to the score service', async () => {
    const { post, scoreCalls } = setup();
    const res = await post('/score', { urls: ['https://a.com/'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: { 'https://a.com/': { status: 'pending' } } });
    expect(scoreCalls).toEqual([['https://a.com/']]);
  });
  it('rejects a query field, too many urls and bad JSON', async () => {
    const { post, app } = setup();
    expect((await post('/score', { urls: ['https://a.com/'], query: 'cookies' })).status).toBe(400);
    expect((await post('/score', { urls: Array(21).fill('https://a.com/') })).status).toBe(400);
    expect((await app.request('/score', { method: 'POST', body: '{nope' })).status).toBe(400);
  });
  it('rate limits at 60 per minute per IP', async () => {
    const { post } = setup();
    for (let i = 0; i < 60; i++) expect((await post('/score', { urls: ['https://a.com/'] })).status).toBe(200);
    expect((await post('/score', { urls: ['https://a.com/'] })).status).toBe(429);
  });
});

describe('GET /lists', () => {
  it('serves the bundle with an ETag and honours If-None-Match', async () => {
    const { app } = setup();
    const res = await app.request('/lists');
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"abc123def456"');
    expect(await res.json()).toEqual(bundle);
    expect((await app.request('/lists', { headers: { 'if-none-match': '"abc123def456"' } })).status).toBe(304);
  });
  it('503 when nothing is published', async () => {
    expect((await setup(null).app.request('/lists')).status).toBe(503);
  });
});

describe('devices and flags', () => {
  it('registers a device by hash only', async () => {
    const { post, mem } = setup();
    expect((await post('/devices', { key: 'short' })).status).toBe(400);
    expect((await post('/devices', { key: KEY })).status).toBe(201);
    expect([...mem.devices]).toEqual([sha256Hex(KEY)]);
  });
  it('requires a registered device key', async () => {
    const { post } = setup();
    expect((await post('/flags', { url: 'https://a.com', verdict: 'fine' })).status).toBe(401);
    expect((await post('/flags', { url: 'https://a.com', verdict: 'fine' }, { authorization: `Device ${KEY}` })).status).toBe(401);
  });
  it('stores normalized url and registrable domain', async () => {
    const { post, mem } = setup();
    await post('/devices', { key: KEY });
    const res = await post('/flags', { url: 'https://WWW.Farm.com/x?utm_source=g#top', verdict: 'slop', reason: 'filler' }, { authorization: `Device ${KEY}` });
    expect(res.status).toBe(201);
    expect(mem.flags).toEqual([{ keyHash: sha256Hex(KEY), urlNorm: 'https://www.farm.com/x', domain: 'farm.com', verdict: 'slop', reason: 'filler' }]);
  });
  it('validates reason rules and caps 100 flags per key per day', async () => {
    const { post } = setup();
    await post('/devices', { key: KEY });
    const auth = { authorization: `Device ${KEY}` };
    expect((await post('/flags', { url: 'https://a.com', verdict: 'slop' }, auth)).status).toBe(400);
    for (let i = 0; i < 100; i++) await post('/flags', { url: `https://a.com/${i}`, verdict: 'fine' }, auth);
    expect((await post('/flags', { url: 'https://a.com/x', verdict: 'fine' }, auth)).status).toBe(429);
  });
});

describe('POST /events', () => {
  it('records a no_matches event', async () => {
    const { post, mem } = setup();
    expect((await post('/events', { configVersion: 3, event: 'no_matches' })).status).toBe(204);
    expect(mem.events).toEqual([[3, 'no_matches']]);
    expect((await post('/events', { configVersion: 3, event: 'other' })).status).toBe(400);
  });
});

describe('privacy: logs', () => {
  it('never contain URLs, only route labels', async () => {
    const { post, app, logs } = setup();
    await post('/score', { urls: ['https://secret.example/private-page'] });
    await app.request('/nope/https://secret.example/x');
    expect(logs.join('\n')).not.toContain('secret.example');
    expect(logs).toEqual([expect.stringMatching(/^POST \/score 200 \d+ms$/), expect.stringMatching(/^GET unmatched 404 \d+ms$/)]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm test apps/server/test/rateLimit apps/server/test/app`
Expected: FAIL, unresolved imports.

- [ ] **Step 3: Implement**

`apps/server/src/rateLimit.ts`:
```ts
export type RateLimiter = { take(key: string, limit: number, windowMs: number): boolean };

/** Fixed-window, in-memory. Good enough for a single instance; revisit when scaling out. */
export function createRateLimiter(now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, { start: number; count: number; windowMs: number }>();
  return {
    take(key, limit, windowMs) {
      const t = now();
      if (windows.size > 50_000) for (const [k, w] of windows) if (t - w.start >= w.windowMs) windows.delete(k);
      const w = windows.get(key);
      if (!w || t - w.start >= windowMs) {
        windows.set(key, { start: t, count: 1, windowMs });
        return true;
      }
      if (w.count >= limit) return false;
      w.count++;
      return true;
    },
  };
}
```

`apps/server/src/clientIp.ts`:
```ts
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

/** Behind a proxy (e.g. Fly's `fly-client-ip`), pass the header name; otherwise the socket address is used. */
export function createClientIp(header: string | undefined) {
  return (c: Context): string => {
    const fromHeader = header ? c.req.header(header)?.split(',')[0]?.trim() : undefined;
    return fromHeader || getConnInfo(c).remote.address || 'unknown';
  };
}
```

`apps/server/src/app.ts`:
```ts
import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deviceBodySchema, eventBodySchema, flagBodySchema, normalizeUrl, registrableDomain, scoreBodySchema } from '@gist/shared';
import type { RateLimiter } from './rateLimit';
import type { Repo } from './repo';
import type { ScoreService } from './scoreService';

export type AppDeps = {
  scores: ScoreService;
  repo: Pick<Repo, 'latestBundle' | 'registerDevice' | 'deviceExists' | 'countFlagsToday' | 'insertFlag' | 'recordEvent'>;
  limiter: RateLimiter;
  clientIp: (c: Context) => string;
  log: (line: string) => void;
};

type Env = { Variables: { route: string } };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

export function createApp(d: AppDeps) {
  const app = new Hono<Env>();

  // Log the route label, never the raw path or body: URLs must not reach logs (spec §8.3).
  app.use('*', async (c, next) => {
    const start = Date.now();
    c.set('route', 'unmatched');
    await next();
    d.log(`${c.req.method} ${c.get('route')} ${c.res.status} ${Date.now() - start}ms`);
  });
  app.use('*', bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ error: 'body too large' }, 413) }));

  const readJson = async (c: Context): Promise<unknown> => {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  };
  const limited = (c: Context, name: string, limit: number, windowMs: number) => !d.limiter.take(`${name}:${d.clientIp(c)}`, limit, windowMs);

  app.post('/score', async (c) => {
    c.set('route', '/score');
    if (limited(c, 'score', 60, MINUTE)) return c.json({ error: 'rate limited' }, 429);
    const body = scoreBodySchema.safeParse(await readJson(c));
    if (!body.success) return c.json({ error: 'invalid body' }, 400);
    return c.json({ results: await d.scores.lookup(body.data.urls) });
  });

  app.get('/lists', async (c) => {
    c.set('route', '/lists');
    const bundle = await d.repo.latestBundle();
    if (!bundle) return c.json({ error: 'no lists published' }, 503);
    const etag = `"${bundle.version}"`;
    c.header('ETag', etag);
    c.header('Cache-Control', 'public, max-age=3600');
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);
    return c.json(bundle);
  });

  app.post('/devices', async (c) => {
    c.set('route', '/devices');
    if (limited(c, 'devices', 10, HOUR)) return c.json({ error: 'rate limited' }, 429);
    const body = deviceBodySchema.safeParse(await readJson(c));
    if (!body.success) return c.json({ error: 'invalid body' }, 400);
    await d.repo.registerDevice(sha256Hex(body.data.key));
    return c.json({ ok: true }, 201);
  });

  app.post('/flags', async (c) => {
    c.set('route', '/flags');
    const m = /^Device ([0-9a-f]{64})$/.exec(c.req.header('authorization') ?? '');
    if (!m) return c.json({ error: 'unauthorized' }, 401);
    const keyHash = sha256Hex(m[1]!);
    if (!(await d.repo.deviceExists(keyHash))) return c.json({ error: 'unauthorized' }, 401);
    if ((await d.repo.countFlagsToday(keyHash)) >= 100) return c.json({ error: 'rate limited' }, 429);
    const body = flagBodySchema.safeParse(await readJson(c));
    if (!body.success) return c.json({ error: 'invalid body' }, 400);
    const urlNorm = normalizeUrl(body.data.url);
    if (!urlNorm) return c.json({ error: 'invalid url' }, 400);
    const domain = registrableDomain(urlNorm) ?? new URL(urlNorm).hostname;
    await d.repo.insertFlag({ keyHash, urlNorm, domain, verdict: body.data.verdict, reason: body.data.reason ?? null });
    return c.json({ ok: true }, 201);
  });

  app.post('/events', async (c) => {
    c.set('route', '/events');
    if (limited(c, 'events', 10, DAY)) return c.json({ error: 'rate limited' }, 429);
    const body = eventBodySchema.safeParse(await readJson(c));
    if (!body.success) return c.json({ error: 'invalid body' }, 400);
    await d.repo.recordEvent(body.data.configVersion, body.data.event);
    return c.body(null, 204);
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((err, c) => {
    d.log(`error ${c.get('route')} ${err.name}`);
    return c.json({ error: 'internal' }, 500);
  });
  return app;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm test apps/server`
Expected: PASS (all server tests, including repo).

---

### Task 13: Server boot, list publishing, review CLI, Dockerfile

**Files:**
- Create: `apps/server/src/env.ts`, `apps/server/src/index.ts`
- Create: `apps/server/scripts/lists-publish.ts`, `apps/server/scripts/review.ts`
- Create: `Dockerfile`, `.dockerignore`
- Modify: root `package.json` (add the `lists:publish` and `review` scripts)
- Test: `apps/server/test/env.test.ts`

**Interfaces:**
- Consumes: everything in Tasks 8–12, `scoreHtml`/`LAYER1_VERSION` from `@gist/layer1`, `listBundleSchema` from `@gist/shared`, `data/bundle.json` from Task 7.
- Produces: `readEnv(env: NodeJS.ProcessEnv): { databaseUrl: string; port: number; botInfoUrl: string; clientIpHeader: string | undefined }`; the runnable server on `PORT` (default 8787).

- [ ] **Step 1: Write the failing test**

`apps/server/test/env.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { readEnv } from '../src/env';

describe('readEnv', () => {
  it('requires DATABASE_URL and BOT_INFO_URL', () => {
    expect(() => readEnv({})).toThrow(/DATABASE_URL/);
    expect(() => readEnv({ DATABASE_URL: 'postgres://x' })).toThrow(/BOT_INFO_URL/);
  });
  it('applies defaults', () => {
    expect(readEnv({ DATABASE_URL: 'postgres://x', BOT_INFO_URL: 'https://gist.example/bot' })).toEqual({
      databaseUrl: 'postgres://x', port: 8787, botInfoUrl: 'https://gist.example/bot', clientIpHeader: undefined,
    });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm test apps/server/test/env`
Expected: FAIL, unresolved import.

- [ ] **Step 3: Implement**

`apps/server/src/env.ts`:
```ts
export function readEnv(env: NodeJS.ProcessEnv) {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`Missing required env var ${k}`);
    return v;
  };
  return {
    databaseUrl: need('DATABASE_URL'),
    port: Number(env.PORT ?? 8787),
    botInfoUrl: need('BOT_INFO_URL'),
    clientIpHeader: env.CLIENT_IP_HEADER || undefined,
  };
}
```

`apps/server/src/index.ts`:
```ts
import { serve } from '@hono/node-server';
import { LAYER1_VERSION, scoreHtml } from '@gist/layer1';
import { createApp } from './app';
import { createClientIp } from './clientIp';
import { connect, migrate } from './db';
import { readEnv } from './env';
import { fetchPage, fetchText } from './fetcher/fetchPage';
import { createRobotsChecker } from './fetcher/robots';
import { createSafeAgent, isPublicAddress } from './fetcher/ssrf';
import { FetchQueue } from './queue';
import { createRateLimiter } from './rateLimit';
import { createRepo } from './repo';
import { createScoreService } from './scoreService';

const env = readEnv(process.env);
const sql = connect(env.databaseUrl);
await migrate(sql);
const repo = createRepo(sql);

const dispatcher = createSafeAgent(isPublicAddress);
const userAgent = `GistBot/1.0 (+${env.botInfoUrl})`;
const robotsAllowed = createRobotsChecker({
  fetchText: (url) => fetchText(url, { dispatcher, userAgent, policy: isPublicAddress }),
  now: Date.now,
});

const scores = createScoreService({
  repo,
  queue: new FetchQueue({ global: 20, perDomain: 2 }),
  fetchPage: (url) => fetchPage(url, { dispatcher, userAgent, policy: isPublicAddress, robotsAllowed }),
  score: scoreHtml,
  now: () => new Date(),
  version: LAYER1_VERSION,
});

const app = createApp({
  scores,
  repo,
  limiter: createRateLimiter(),
  clientIp: createClientIp(env.clientIpHeader),
  log: (line) => console.log(line),
});

serve({ fetch: app.fetch, port: env.port }, (info) => console.log(`gist server on :${info.port} (layer1 ${LAYER1_VERSION})`));
```

`apps/server/scripts/lists-publish.ts`:
```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listBundleSchema } from '@gist/shared';
import { connect, migrate } from '../src/db';
import { createRepo } from '../src/repo';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL');
const path = fileURLToPath(new URL('../../../data/bundle.json', import.meta.url));
const bundle = listBundleSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
const sql = connect(url);
await migrate(sql);
await createRepo(sql).publishBundle(bundle);
console.log(`published ${bundle.version} (${bundle.domains.length} domains, selectors v${bundle.selectors.version})`);
await sql.end();
```

`apps/server/scripts/review.ts`:
```ts
import { connect } from '../src/db';
import { createRepo } from '../src/repo';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL');
const sql = connect(url);
const repo = createRepo(sql);

console.log('\n== Flags by domain (top 200) ==');
console.table(
  (await repo.flagSummary()).map((r) => ({
    domain: r.domain, slop: r.slop, fine: r.fine, devices: r.devices,
    reasons: Object.entries(r.reasons ?? {}).map(([k, v]) => `${k}:${v}`).join(' '),
    first: r.firstSeen.toISOString().slice(0, 10), last: r.lastSeen.toISOString().slice(0, 10),
  })),
);
console.log('\n== Fetch failures, last 7 days (top 100) ==');
console.table(await repo.failureSummary(7));
console.log('\nDecisions go into data/domains/*.json via PR, then `pnpm lists:build && pnpm lists:publish`.');
await sql.end();
```

Add to the root `package.json` `scripts`:
```json
    "lists:publish": "pnpm --filter @gist/server lists:publish",
    "review": "pnpm --filter @gist/server review"
```

`Dockerfile`:
```dockerfile
FROM node:20-alpine
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter "@gist/server..."
ENV NODE_ENV=production
EXPOSE 8787
CMD ["pnpm", "--filter", "@gist/server", "start"]
```

`.dockerignore`:
```
node_modules
**/node_modules
apps/extension/.output
apps/extension/.wxt
eval/snapshots
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm test apps/server/test/env`
Expected: PASS.

- [ ] **Step 5: Smoke-test the real server locally**

Run each command separately:
```bash
docker run -d --name gist-pg -e POSTGRES_PASSWORD=gist -p 5432:5432 postgres:16-alpine
export DATABASE_URL=postgres://postgres:gist@localhost:5432/postgres BOT_INFO_URL=https://example.invalid/bot
pnpm lists:build && pnpm lists:publish
pnpm --filter @gist/server start   # leave running in a second terminal / background
curl -s localhost:8787/lists | head -c 200
curl -s -X POST localhost:8787/score -H 'content-type: application/json' -d '{"urls":["https://en.wikipedia.org/wiki/Cookie"]}'
# wait ~3 s, then repeat the /score call
```
Expected: `/lists` returns the bundle JSON. The first `/score` returns `pending`, and the second returns `ready` with Layer 1 dimensions. The server log shows only lines like `POST /score 200 12ms`.

`BOT_INFO_URL` is a placeholder until the domain is chosen (spec §10). Before deploying, set it to a real page that explains GistBot and how to opt out with `User-agent: GistBot`.

---
### Task 14: Extension scaffold and local state (settings, overrides, counter)

**Files:**
- Create: `apps/extension/package.json`, `apps/extension/tsconfig.json`, `apps/extension/wxt.config.ts`
- Create: `apps/extension/src/google.ts`, `apps/extension/src/config.ts`, `apps/extension/src/kv.ts`, `apps/extension/src/platform.ts`
- Create: `apps/extension/src/settings.ts`, `apps/extension/src/overrides.ts`, `apps/extension/src/counter.ts`
- Test: `apps/extension/test/state.test.ts`, `apps/extension/test/google.test.ts`

**Interfaces:**
- Consumes: `FlagVerdict` from `@gist/shared`.
- Produces:
  - `GOOGLE_MATCHES: string[]`, `isWebSearch(url: URL): boolean`
  - `API_BASE: string`
  - `interface KV { get<T>(key: string): Promise<T | undefined>; set<T>(key: string, value: T): Promise<void> }`, `memoryKV(initial?)`
  - `browserKV: KV`, `hasAllSitesPermission(): Promise<boolean>`, `fetchHtmlFromDevice(url: string): Promise<string | null>` (platform.ts, not unit-tested)
  - `type Settings = { enabled: boolean; greenDot: boolean; pausedHosts: string[] }`, `DEFAULT_SETTINGS`, `getSettings(kv)`, `updateSettings(kv, patch)`, `togglePause(kv, host)`, `isPaused(settings, host)`
  - `getOverride(kv, url): Promise<FlagVerdict | null>`, `setOverride(kv, url, verdict, max = 5000): Promise<void>`
  - `addDimmed(kv, n, now: Date)`, `getDimmed(kv, now: Date): Promise<number>`

Only files under `src/` that don't import `wxt/*` are unit-tested. `platform.ts` and `entrypoints/` are thin adapters, checked manually in Task 21.

- [ ] **Step 1: Create the package**

`apps/extension/package.json`:
```json
{
  "name": "@gist/extension",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wxt",
    "build": "wxt build",
    "zip": "wxt zip",
    "postinstall": "wxt prepare",
    "typecheck": "wxt prepare && tsc --noEmit"
  },
  "dependencies": {
    "@gist/combiner": "workspace:*",
    "@gist/layer1": "workspace:*",
    "@gist/shared": "workspace:*"
  },
  "devDependencies": { "happy-dom": "^15.11.7", "wxt": "^0.20.0" }
}
```

`apps/extension/tsconfig.json`:
```json
{ "extends": "./.wxt/tsconfig.json", "compilerOptions": { "strict": true, "resolveJsonModule": true } }
```

`apps/extension/src/google.ts`:
```ts
const TLDS = ['com', 'co.uk', 'co.in', 'ca', 'com.au', 'de', 'fr', 'es', 'it', 'nl', 'co.jp', 'com.br', 'ie', 'co.nz', 'com.sg'];

export const GOOGLE_MATCHES = TLDS.map((t) => `https://www.google.${t}/search*`);

/** Web results only: no Images/News/Shopping tabs (tbm=…), and only the default or "Web" (udm=14) view. */
export function isWebSearch(url: URL): boolean {
  if (url.pathname !== '/search' || url.searchParams.has('tbm')) return false;
  const udm = url.searchParams.get('udm');
  return udm === null || udm === '14';
}
```

`apps/extension/wxt.config.ts`:
```ts
import { defineConfig } from 'wxt';
import { GOOGLE_MATCHES } from './src/google';

const API_BASE = process.env.WXT_API_BASE ?? 'http://localhost:8787';

export default defineConfig({
  manifest: {
    name: 'Gist',
    description: 'Dims low-value Google results and shows you why.',
    permissions: ['storage', 'alarms', 'activeTab'],
    host_permissions: [`${new URL(API_BASE).origin}/*`],
    optional_host_permissions: ['<all_urls>'],
  },
  vite: () => ({ server: { fs: { allow: ['../..'] } } }),
});

export { GOOGLE_MATCHES };
```

`apps/extension/src/config.ts`:
```ts
export const API_BASE: string = (import.meta.env.WXT_API_BASE as string | undefined) ?? 'http://localhost:8787';
```

`apps/extension/src/kv.ts`:
```ts
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

export function memoryKV(initial: Record<string, unknown> = {}): KV & { dump(): Record<string, unknown> } {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    async get<T>(key: string) {
      return structuredClone(data.get(key)) as T | undefined;
    },
    async set<T>(key: string, value: T) {
      data.set(key, structuredClone(value));
    },
    dump: () => Object.fromEntries(data),
  };
}
```

`apps/extension/src/platform.ts`:
```ts
import { browser } from 'wxt/browser';
import type { KV } from './kv';

export const browserKV: KV = {
  async get<T>(key: string) {
    return (await browser.storage.local.get(key))[key] as T | undefined;
  },
  async set<T>(key: string, value: T) {
    await browser.storage.local.set({ [key]: value });
  },
};

export function hasAllSitesPermission(): Promise<boolean> {
  return browser.permissions.contains({ origins: ['<all_urls>'] });
}

/** Device fallback fetch: no cookies (spec §8.4), html only, 3 MB cap, 8 s timeout. */
export async function fetchHtmlFromDevice(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { credentials: 'omit', redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (!res.ok || !/text\/html|application\/xhtml\+xml/i.test(res.headers.get('content-type') ?? '')) return null;
    const text = await res.text();
    return text.length > 3 * 1024 * 1024 ? null : text;
  } catch {
    return null;
  }
}
```

Run: `pnpm install`
Expected: `wxt prepare` runs in postinstall and creates `apps/extension/.wxt/`.

- [ ] **Step 2: Write the failing tests**

`apps/extension/test/google.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { GOOGLE_MATCHES, isWebSearch } from '../src/google';

describe('google', () => {
  it('matches web search pages only', () => {
    expect(isWebSearch(new URL('https://www.google.com/search?q=x'))).toBe(true);
    expect(isWebSearch(new URL('https://www.google.com/search?q=x&udm=14'))).toBe(true);
    expect(isWebSearch(new URL('https://www.google.com/search?q=x&udm=2'))).toBe(false);
    expect(isWebSearch(new URL('https://www.google.com/search?q=x&tbm=isch'))).toBe(false);
    expect(isWebSearch(new URL('https://www.google.com/maps'))).toBe(false);
  });
  it('covers google.com and major country domains', () => {
    expect(GOOGLE_MATCHES).toContain('https://www.google.com/search*');
    expect(GOOGLE_MATCHES).toContain('https://www.google.co.in/search*');
  });
});
```

`apps/extension/test/state.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { addDimmed, getDimmed } from '../src/counter';
import { memoryKV } from '../src/kv';
import { getOverride, setOverride } from '../src/overrides';
import { DEFAULT_SETTINGS, getSettings, isPaused, togglePause, updateSettings } from '../src/settings';

describe('settings', () => {
  it('defaults, merges patches and toggles pause per host', async () => {
    const kv = memoryKV();
    expect(await getSettings(kv)).toEqual(DEFAULT_SETTINGS);
    await updateSettings(kv, { greenDot: true });
    expect((await getSettings(kv)).greenDot).toBe(true);
    let s = await togglePause(kv, 'WWW.Google.com');
    expect(isPaused(s, 'www.google.com')).toBe(true);
    s = await togglePause(kv, 'www.google.com');
    expect(isPaused(s, 'www.google.com')).toBe(false);
  });
});

describe('overrides', () => {
  it('stores the latest verdict per url and caps the map size', async () => {
    const kv = memoryKV();
    await setOverride(kv, 'https://a.com/', 'slop');
    await setOverride(kv, 'https://a.com/', 'fine');
    expect(await getOverride(kv, 'https://a.com/')).toBe('fine');
    expect(await getOverride(kv, 'https://b.com/')).toBeNull();
    for (let i = 0; i < 3; i++) await setOverride(kv, `https://x.com/${i}`, 'slop', 3);
    expect(await getOverride(kv, 'https://a.com/')).toBeNull(); // oldest evicted past max
    expect(await getOverride(kv, 'https://x.com/2')).toBe('slop');
  });
});

describe('dimmed counter', () => {
  it('counts per UTC day and resets the next day', async () => {
    const kv = memoryKV();
    await addDimmed(kv, 2, new Date('2026-09-29T10:00:00Z'));
    await addDimmed(kv, 1, new Date('2026-09-29T23:00:00Z'));
    expect(await getDimmed(kv, new Date('2026-09-29T23:30:00Z'))).toBe(3);
    expect(await getDimmed(kv, new Date('2026-09-30T00:01:00Z'))).toBe(0);
    await addDimmed(kv, 1, new Date('2026-09-30T00:02:00Z'));
    expect(await getDimmed(kv, new Date('2026-09-30T00:03:00Z'))).toBe(1);
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `pnpm test apps/extension`
Expected: FAIL on `state.test.ts` (unresolved imports). `google.test.ts` passes.

- [ ] **Step 4: Implement**

`apps/extension/src/settings.ts`:
```ts
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
```

`apps/extension/src/overrides.ts`:
```ts
import type { FlagVerdict } from '@gist/shared';
import type { KV } from './kv';

const KEY = 'overrides';
const MAX = 5000;
type Stored = Record<string, FlagVerdict>;

export async function getOverride(kv: KV, url: string): Promise<FlagVerdict | null> {
  return (await kv.get<Stored>(KEY))?.[url] ?? null;
}

/** Most recent flag wins; the oldest entries are evicted past MAX (object keys keep insertion order). */
export async function setOverride(kv: KV, url: string, verdict: FlagVerdict, max = MAX): Promise<void> {
  const all: Stored = { ...(await kv.get<Stored>(KEY)) };
  delete all[url];
  all[url] = verdict;
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) delete all[k];
  await kv.set(KEY, all);
}
```

`apps/extension/src/counter.ts`:
```ts
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
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm test apps/extension`
Expected: PASS.

---

### Task 15: Extension API client, device key and list store

**Files:**
- Create: `apps/extension/src/api.ts`, `apps/extension/src/device.ts`, `apps/extension/src/listStore.ts`
- Test: `apps/extension/test/api.test.ts`, `apps/extension/test/device.test.ts`, `apps/extension/test/listStore.test.ts`

**Interfaces:**
- Consumes: `KV` (Task 14); `ScoreItem`, `FlagReason`, `FlagVerdict`, `ListBundle`, `ListEntry`, `listBundleSchema`, `createMatcher` from `@gist/shared`.
- Produces:
  - `class ApiError extends Error { status: number }`
  - `type Api = { score(urls): Promise<Record<string, ScoreItem>>; lists(etag: string | null): Promise<{ status: 304 } | { status: 200; bundle: unknown; etag: string | null }>; registerDevice(key): Promise<void>; flag(key, body: { url: string; verdict: FlagVerdict; reason?: FlagReason }): Promise<void>; event(body: { configVersion: number; event: 'no_matches' }): Promise<void> }`
  - `createApi(base: string, fetchFn?: typeof fetch): Api`
  - `type DeviceState = { key: string; registered: boolean }`, `newDeviceKey(): string`, `ensureDevice(kv, api: Pick<Api, 'registerDevice'>): Promise<DeviceState>`
  - `type ListStore = { load(): Promise<void>; current(): ListBundle; match(url: string): ListEntry | null; sync(): Promise<'updated' | 'unchanged' | 'failed'>; lastSyncedAt(): number }`
  - `createListStore(deps: { kv: KV; api: Pick<Api, 'lists'>; bundled: ListBundle; now: () => number }): ListStore`

- [ ] **Step 1: Write the failing tests**

`apps/extension/test/api.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ApiError, createApi } from '../src/api';

function fakeFetch(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return responses.shift()!;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('api', () => {
  it('score: body is exactly {urls}, no credentials, no identifying headers (spec §8.1)', async () => {
    const { fn, calls } = fakeFetch([Response.json({ results: { 'https://a.com/': { status: 'pending' } } })]);
    const res = await createApi('https://api.test', fn).score(['https://a.com/']);
    expect(res).toEqual({ 'https://a.com/': { status: 'pending' } });
    expect(calls[0]!.url).toBe('https://api.test/score');
    expect(calls[0]!.init.credentials).toBe('omit');
    expect(calls[0]!.init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ urls: ['https://a.com/'] });
  });

  it('lists: sends If-None-Match and handles 304', async () => {
    const { fn, calls } = fakeFetch([new Response(null, { status: 304 })]);
    expect(await createApi('https://api.test', fn).lists('"v1"')).toEqual({ status: 304 });
    expect(calls[0]!.init.headers).toEqual({ 'if-none-match': '"v1"' });
  });

  it('lists: returns bundle and etag on 200', async () => {
    const { fn } = fakeFetch([Response.json({ version: 'v2' }, { headers: { etag: '"v2"' } })]);
    expect(await createApi('https://api.test', fn).lists(null)).toEqual({ status: 200, bundle: { version: 'v2' }, etag: '"v2"' });
  });

  it('flag: authorizes with the device key', async () => {
    const { fn, calls } = fakeFetch([new Response(null, { status: 201 })]);
    await createApi('https://api.test', fn).flag('k'.repeat(64), { url: 'https://a.com/', verdict: 'fine' });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Device ${'k'.repeat(64)}`);
  });

  it('throws ApiError with the status on non-2xx', async () => {
    const { fn } = fakeFetch([new Response(null, { status: 429 })]);
    await expect(createApi('https://api.test', fn).score(['https://a.com/'])).rejects.toMatchObject({ status: 429 });
    expect(new ApiError(500)).toBeInstanceOf(Error);
  });
});
```

`apps/extension/test/device.test.ts`:
```ts
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
```

`apps/extension/test/listStore.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import type { ListBundle } from '@gist/shared';
import { memoryKV } from '../src/kv';
import { createListStore } from '../src/listStore';

const selectors = { version: 1, result: '#rso div.g', title: 'h3', exclude: [] };
const bundled: ListBundle = { version: 'bundled', domains: [], selectors };
const remote: ListBundle = {
  version: 'remote1',
  domains: [{ match: 'farm.com', matchLevel: 'domain', kind: 'farm', siteBehavior: 10, reasons: ['r'], source: 'seed' }],
  selectors: { ...selectors, version: 2 },
};

describe('listStore', () => {
  it('starts from the bundled copy', () => {
    const s = createListStore({ kv: memoryKV(), api: { lists: vi.fn() }, bundled, now: () => 0 });
    expect(s.current().version).toBe('bundled');
    expect(s.match('https://farm.com/')).toBeNull();
  });

  it('sync applies a valid remote bundle, persists it and survives reload', async () => {
    const kv = memoryKV();
    const api = { lists: vi.fn(async () => ({ status: 200 as const, bundle: remote, etag: '"remote1"' })) };
    const s = createListStore({ kv, api, bundled, now: () => 1000 });
    expect(await s.sync()).toBe('updated');
    expect(s.match('https://www.farm.com/x')?.kind).toBe('farm');
    expect(s.lastSyncedAt()).toBe(1000);

    const reloaded = createListStore({ kv, api, bundled, now: () => 2000 });
    await reloaded.load();
    expect(reloaded.current().version).toBe('remote1');
  });

  it('sends the stored etag and treats 304 as unchanged', async () => {
    const kv = memoryKV();
    const api = { lists: vi.fn().mockResolvedValueOnce({ status: 200, bundle: remote, etag: '"remote1"' }).mockResolvedValueOnce({ status: 304 }) };
    const s = createListStore({ kv, api, bundled, now: () => 0 });
    await s.sync();
    expect(await s.sync()).toBe('unchanged');
    expect(api.lists).toHaveBeenLastCalledWith('"remote1"');
    expect(s.current().version).toBe('remote1');
  });

  it('keeps the last good bundle when the remote one is invalid or the request fails', async () => {
    const api = { lists: vi.fn().mockResolvedValueOnce({ status: 200, bundle: { version: 'bad' }, etag: null }).mockRejectedValueOnce(new Error('offline')) };
    const s = createListStore({ kv: memoryKV(), api, bundled, now: () => 0 });
    expect(await s.sync()).toBe('failed');
    expect(await s.sync()).toBe('failed');
    expect(s.current().version).toBe('bundled');
  });

  it('ignores corrupted persisted state on load', async () => {
    const kv = memoryKV({ lists: { bundle: { nope: true }, etag: null, syncedAt: 1 } });
    const s = createListStore({ kv, api: { lists: vi.fn() }, bundled, now: () => 0 });
    await s.load();
    expect(s.current().version).toBe('bundled');
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm test apps/extension`
Expected: FAIL, unresolved imports for `api`, `device`, `listStore`.

- [ ] **Step 3: Implement**

`apps/extension/src/api.ts`:
```ts
import type { FlagReason, FlagVerdict, ScoreItem } from '@gist/shared';

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`api responded ${status}`);
  }
}

export type Api = {
  score(urls: string[]): Promise<Record<string, ScoreItem>>;
  lists(etag: string | null): Promise<{ status: 304 } | { status: 200; bundle: unknown; etag: string | null }>;
  registerDevice(key: string): Promise<void>;
  flag(key: string, body: { url: string; verdict: FlagVerdict; reason?: FlagReason }): Promise<void>;
  event(body: { configVersion: number; event: 'no_matches' }): Promise<void>;
};

export function createApi(base: string, fetchFn: typeof fetch = (input, init) => fetch(input, init)): Api {
  const post = async (path: string, body: unknown, extraHeaders: Record<string, string> = {}) => {
    const res = await fetchFn(`${base}${path}`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ApiError(res.status);
    return res;
  };

  return {
    async score(urls) {
      const res = await post('/score', { urls });
      return ((await res.json()) as { results: Record<string, ScoreItem> }).results;
    },
    async lists(etag) {
      const res = await fetchFn(`${base}/lists`, { credentials: 'omit', headers: etag ? { 'if-none-match': etag } : {} });
      if (res.status === 304) return { status: 304 };
      if (!res.ok) throw new ApiError(res.status);
      return { status: 200, bundle: await res.json(), etag: res.headers.get('etag') };
    },
    async registerDevice(key) {
      await post('/devices', { key });
    },
    async flag(key, body) {
      await post('/flags', body, { authorization: `Device ${key}` });
    },
    async event(body) {
      await post('/events', body);
    },
  };
}
```

`apps/extension/src/device.ts`:
```ts
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
```

`apps/extension/src/listStore.ts`:
```ts
import { createMatcher, listBundleSchema, type ListBundle, type ListEntry } from '@gist/shared';
import type { Api } from './api';
import type { KV } from './kv';

type Stored = { bundle: ListBundle; etag: string | null; syncedAt: number };

export type ListStore = {
  load(): Promise<void>;
  current(): ListBundle;
  match(url: string): ListEntry | null;
  sync(): Promise<'updated' | 'unchanged' | 'failed'>;
  lastSyncedAt(): number;
};

export function createListStore(deps: { kv: KV; api: Pick<Api, 'lists'>; bundled: ListBundle; now: () => number }): ListStore {
  let state: Stored = { bundle: deps.bundled, etag: null, syncedAt: 0 };
  let matcher = createMatcher(state.bundle.domains);
  const apply = (s: Stored) => {
    state = s;
    matcher = createMatcher(s.bundle.domains);
  };

  return {
    async load() {
      const s = await deps.kv.get<Stored>('lists');
      if (s && listBundleSchema.safeParse(s.bundle).success) apply(s);
    },
    current: () => state.bundle,
    match: (url) => matcher(url),
    lastSyncedAt: () => state.syncedAt,
    async sync() {
      try {
        const r = await deps.api.lists(state.etag);
        if (r.status === 304) {
          apply({ ...state, syncedAt: deps.now() });
          await deps.kv.set('lists', state);
          return 'unchanged';
        }
        const parsed = listBundleSchema.safeParse(r.bundle);
        if (!parsed.success) return 'failed';
        apply({ bundle: parsed.data, etag: r.etag, syncedAt: deps.now() });
        await deps.kv.set('lists', state);
        return 'updated';
      } catch {
        return 'failed';
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm test apps/extension`
Expected: PASS.

---

### Task 16: Device fallback, score orchestrator and flag sender

**Files:**
- Create: `apps/extension/src/fallback.ts`, `apps/extension/src/orchestrator.ts`, `apps/extension/src/flagSender.ts`
- Test: `apps/extension/test/fallback.test.ts`, `apps/extension/test/orchestrator.test.ts`, `apps/extension/test/flagSender.test.ts`

**Interfaces:**
- Consumes: `KV` (14), `Api`/`ApiError`/`ensureDevice` (15), `combine` from `@gist/combiner`, `Layer1Result`, `ListEntry`, `ScoreItem`, `Verdict`, `FlagVerdict`, `FlagReason` from `@gist/shared`.
- Produces:
  - `type Fallback = { cached(url): Promise<Layer1Result | null>; enabled(): Promise<boolean>; score(url): Promise<Layer1Result | null> }`
  - `createFallback(deps: { kv; hasPermission: () => Promise<boolean>; fetchHtml: (url) => Promise<string | null>; score: (html: string, at: Date) => Layer1Result; now: () => number }): Fallback`
  - `POLL_DELAYS = [1500, 2500, 4000]`
  - `createOrchestrator(deps: { api: Pick<Api, 'score'>; match: (url) => ListEntry | null; override: (url) => Promise<FlagVerdict | null>; greenDot: () => Promise<boolean>; fallback: Fallback; sleep: (ms: number) => Promise<void> }): { run(urls: string[], emit: (v: Record<string, Verdict>) => void): Promise<void>; verdict(url: string): Promise<Verdict> }`
  - `type PendingFlag = { url: string; verdict: FlagVerdict; reason?: FlagReason }`
  - `createFlagSender(deps: { kv; api: Pick<Api, 'flag' | 'registerDevice'> }): { send(f: PendingFlag): Promise<void>; flush(): Promise<void> }`

- [ ] **Step 1: Write the failing tests**

`apps/extension/test/fallback.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import type { Layer1Result } from '@gist/shared';
import { createFallback } from '../src/fallback';
import { memoryKV } from '../src/kv';

const result = { layer1Version: 't' } as Layer1Result;
const DAY = 86_400_000;

function setup(over: Partial<Parameters<typeof createFallback>[0]> = {}) {
  let t = 0;
  const deps = {
    kv: memoryKV(),
    hasPermission: vi.fn(async () => true),
    fetchHtml: vi.fn(async () => '<p>hi</p>'),
    score: vi.fn(() => result),
    now: () => t,
    ...over,
  };
  return { fb: createFallback(deps), deps, setTime: (n: number) => (t = n) };
}

describe('fallback', () => {
  it('does nothing without the optional permission', async () => {
    const { fb, deps } = setup({ hasPermission: async () => false });
    expect(await fb.score('https://a.com/')).toBeNull();
    expect(deps.fetchHtml).not.toHaveBeenCalled();
  });
  it('scores, caches for 14 days, then expires', async () => {
    const { fb, setTime } = setup();
    expect(await fb.score('https://a.com/')).toBe(result);
    setTime(13 * DAY);
    expect(await fb.cached('https://a.com/')).toEqual(result);
    setTime(15 * DAY);
    expect(await fb.cached('https://a.com/')).toBeNull();
  });
  it('returns null when the fetch fails or the scorer throws', async () => {
    expect(await setup({ fetchHtml: async () => null }).fb.score('https://a.com/')).toBeNull();
    expect(await setup({ score: () => { throw new Error('x'); } }).fb.score('https://a.com/')).toBeNull();
  });
  it('keeps at most 500 entries', async () => {
    const { fb } = setup();
    for (let i = 0; i <= 500; i++) await fb.score(`https://a.com/${i}`);
    expect(await fb.cached('https://a.com/0')).toBeNull();
    expect(await fb.cached('https://a.com/500')).toEqual(result);
  });
});
```

`apps/extension/test/orchestrator.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import type { Layer1Result, ListEntry, ScoreItem, Verdict } from '@gist/shared';
import type { Fallback } from '../src/fallback';
import { createOrchestrator, POLL_DELAYS } from '../src/orchestrator';

const layer1 = (score: number): Layer1Result => ({
  layer1Version: 't',
  dimensions: { info: { score, signals: [] }, human: { score, signals: [] }, monetization: { score, signals: [] } },
  styleAdjust: 0, styleSignals: [], fetchedAt: '2026-09-29T00:00:00.000Z',
});
const farmEntry: ListEntry = { match: 'farm.com', matchLevel: 'domain', kind: 'farm', siteBehavior: 5, reasons: ['Content farm'], source: 'seed' };
const FARM = 'https://farm.com/a';
const OK = 'https://ok.com/b';

function setup(responses: (Record<string, ScoreItem> | Error)[], opts: { fallbackEnabled?: boolean; overrides?: Record<string, 'slop' | 'fine'> } = {}) {
  const sleeps: number[] = [];
  const fbStore = new Map<string, Layer1Result>();
  const api = {
    score: vi.fn(async (urls: string[]) => {
      const r = responses.shift();
      if (r instanceof Error) throw r;
      return r ?? Object.fromEntries(urls.map((u) => [u, { status: 'pending' as const }]));
    }),
  };
  const fallback: Fallback & { score: ReturnType<typeof vi.fn> } = {
    cached: async (u) => fbStore.get(u) ?? null,
    enabled: async () => opts.fallbackEnabled ?? false,
    score: vi.fn(async (u: string) => { fbStore.set(u, layer1(80)); return layer1(80); }),
  };
  const orch = createOrchestrator({
    api,
    match: (u) => (u.includes('farm.com') ? farmEntry : null),
    override: async (u) => opts.overrides?.[u] ?? null,
    greenDot: async () => false,
    fallback,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  const emits: Record<string, Verdict>[] = [];
  return { orch, api, fallback, sleeps, emits, emit: (v: Record<string, Verdict>) => { emits.push(v); } };
}

describe('orchestrator', () => {
  it('emits list verdicts immediately, before the server answers', async () => {
    const t = setup([]);
    await t.orch.run([FARM, OK], t.emit);
    expect(t.emits[0]![FARM]).toMatchObject({ confidence: 'high', action: 'collapse' });
    expect(t.emits[0]![OK]).toMatchObject({ confidence: 'none', action: 'none' });
  });

  it('polls pending URLs at the spec schedule, then gives up', async () => {
    const t = setup([]);
    await t.orch.run([OK], t.emit);
    expect(t.api.score).toHaveBeenCalledTimes(1 + POLL_DELAYS.length);
    expect(t.sleeps).toEqual([1500, 2500, 4000]);
    expect(t.emits).toHaveLength(1);
  });

  it('emits again only for URLs whose Layer 1 arrived', async () => {
    const t = setup([{ [OK]: { status: 'pending' }, [FARM]: { status: 'pending' } }, { [OK]: { status: 'ready', layer1: layer1(10) }, [FARM]: { status: 'pending' } }]);
    await t.orch.run([FARM, OK], t.emit);
    expect(Object.keys(t.emits[1]!)).toEqual([OK]);
    expect(t.emits[1]![OK]).toMatchObject({ confidence: 'low', verdict: 'Thin', grade: 10 });
  });

  it('uses the device fallback for failed URLs only when enabled', async () => {
    const on = setup([{ [OK]: { status: 'failed', reason: 'blocked_challenge' } }], { fallbackEnabled: true });
    await on.orch.run([OK], on.emit);
    expect(on.fallback.score).toHaveBeenCalledWith(OK);
    expect(on.emits.at(-1)![OK]).toMatchObject({ confidence: 'low', verdict: 'Solid' });

    const off = setup([{ [OK]: { status: 'failed', reason: 'blocked_challenge' } }]);
    await off.orch.run([OK], off.emit);
    expect(off.fallback.score).not.toHaveBeenCalled();
  });

  it('survives API errors with just the immediate emit', async () => {
    const t = setup([new Error('offline')]);
    await expect(t.orch.run([OK], t.emit)).resolves.toBeUndefined();
    expect(t.emits).toHaveLength(1);
  });

  it('stops quietly when emit throws (port disconnected)', async () => {
    const t = setup([]);
    await expect(t.orch.run([OK], () => { throw new Error('port closed'); })).resolves.toBeUndefined();
    expect(t.api.score).not.toHaveBeenCalled();
  });

  it('does not re-request URLs cached by an earlier run, and dedupes input', async () => {
    const t = setup([{ [OK]: { status: 'ready', layer1: layer1(70) } }]);
    await t.orch.run([OK, OK], t.emit);
    expect(t.api.score).toHaveBeenCalledWith([OK]);
    await t.orch.run([OK], t.emit);
    expect(t.api.score).toHaveBeenCalledTimes(1);
  });

  it('sends at most 20 URLs per request', async () => {
    const urls = Array.from({ length: 25 }, (_, i) => `https://s${i}.com/`);
    const t = setup([]);
    await t.orch.run(urls, t.emit);
    expect(t.api.score.mock.calls[0]![0]).toHaveLength(20);
    expect(t.api.score.mock.calls[1]![0]).toHaveLength(5);
  });

  it('verdict() reflects the user override', async () => {
    const t = setup([], { overrides: { [FARM]: 'fine' } });
    expect(await t.orch.verdict(FARM)).toMatchObject({ action: 'none', userOverride: 'fine' });
  });
});
```

`apps/extension/test/flagSender.test.ts`:
```ts
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
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm test apps/extension`
Expected: FAIL, unresolved imports for the three modules.

- [ ] **Step 3: Implement**

`apps/extension/src/fallback.ts`:
```ts
import type { Layer1Result } from '@gist/shared';
import type { KV } from './kv';

const KEY = 'fallback';
const TTL = 14 * 24 * 60 * 60 * 1000;
const MAX = 500;
type Stored = Record<string, { result: Layer1Result; at: number }>;

export type Fallback = {
  cached(url: string): Promise<Layer1Result | null>;
  enabled(): Promise<boolean>;
  score(url: string): Promise<Layer1Result | null>;
};

/** Scores pages the server could not fetch, on this device only; results are never uploaded (spec D1). */
export function createFallback(deps: {
  kv: KV;
  hasPermission: () => Promise<boolean>;
  fetchHtml: (url: string) => Promise<string | null>;
  score: (html: string, at: Date) => Layer1Result;
  now: () => number;
}): Fallback {
  return {
    async cached(url) {
      const e = (await deps.kv.get<Stored>(KEY))?.[url];
      return e && deps.now() - e.at < TTL ? e.result : null;
    },
    enabled: () => deps.hasPermission(),
    async score(url) {
      if (!(await deps.hasPermission())) return null;
      const html = await deps.fetchHtml(url);
      if (html === null) return null;
      let result: Layer1Result;
      try {
        result = deps.score(html, new Date(deps.now()));
      } catch {
        return null;
      }
      const all: Stored = { ...(await deps.kv.get<Stored>(KEY)) };
      delete all[url];
      all[url] = { result, at: deps.now() };
      const keys = Object.keys(all);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX))) delete all[k];
      await deps.kv.set(KEY, all);
      return result;
    },
  };
}
```

`apps/extension/src/orchestrator.ts`:
```ts
import { combine } from '@gist/combiner';
import type { FlagVerdict, Layer1Result, ListEntry, ScoreItem, Verdict } from '@gist/shared';
import type { Api } from './api';
import type { Fallback } from './fallback';

/** Sleeps between polls, so checks land at roughly 1.5 s, 4 s and 8 s after the first response (spec §5.3). */
export const POLL_DELAYS = [1500, 2500, 4000];
const BATCH = 20;

export function createOrchestrator(d: {
  api: Pick<Api, 'score'>;
  match: (url: string) => ListEntry | null;
  override: (url: string) => Promise<FlagVerdict | null>;
  greenDot: () => Promise<boolean>;
  fallback: Fallback;
  sleep: (ms: number) => Promise<void>;
}) {
  const cache = new Map<string, Layer1Result>();

  async function verdict(url: string): Promise<Verdict> {
    const layer1 = cache.get(url) ?? (await d.fallback.cached(url));
    return combine({ layer1, entry: d.match(url), override: await d.override(url), greenDot: await d.greenDot() });
  }

  async function verdicts(urls: string[]): Promise<Record<string, Verdict>> {
    const out: Record<string, Verdict> = {};
    for (const u of urls) out[u] = await verdict(u);
    return out;
  }

  async function run(input: string[], emit: (v: Record<string, Verdict>) => void): Promise<void> {
    const urls = [...new Set(input)];
    const safeEmit = async (list: string[]) => {
      try {
        emit(await verdicts(list));
        return true;
      } catch {
        return false; // port closed: stop working for this page
      }
    };
    if (!(await safeEmit(urls))) return;

    let pending: string[] = [];
    for (const u of urls) if (!cache.has(u) && !(await d.fallback.cached(u))) pending.push(u);
    const failed: string[] = [];

    for (let attempt = 0; attempt <= POLL_DELAYS.length && pending.length > 0; attempt++) {
      if (attempt > 0) await d.sleep(POLL_DELAYS[attempt - 1]!);
      const results: Record<string, ScoreItem> = {};
      try {
        for (let i = 0; i < pending.length; i += BATCH) Object.assign(results, await d.api.score(pending.slice(i, i + BATCH)));
      } catch {
        break;
      }
      const ready: string[] = [];
      const next: string[] = [];
      for (const u of pending) {
        const r = results[u];
        if (r?.status === 'ready') {
          if (cache.size > 2000) cache.clear();
          cache.set(u, r.layer1);
          ready.push(u);
        } else if (r?.status === 'failed') failed.push(u);
        else next.push(u);
      }
      if (ready.length > 0 && !(await safeEmit(ready))) return;
      pending = next;
    }

    if (failed.length > 0 && (await d.fallback.enabled())) {
      for (const u of failed) {
        if ((await d.fallback.score(u)) && !(await safeEmit([u]))) return;
      }
    }
  }

  return { run, verdict };
}
```

`apps/extension/src/flagSender.ts`:
```ts
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
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm test apps/extension`
Expected: PASS.

---

### Task 17: SERP reader (plus verification against real Google pages)

**Files:**
- Create: `apps/extension/src/serp/reader.ts`
- Create: `apps/extension/test/fixtures/serp-*.html` (saved manually, Step 5)
- Test: `apps/extension/test/reader.test.ts`, `apps/extension/test/realSerp.test.ts`
- Possibly modify: `data/selectors.json` (then re-run `pnpm lists:build`)

**Interfaces:**
- Consumes: `normalizeUrl`, `SelectorConfig` from `@gist/shared`.
- Produces: `type SerpResult = { id: string; el: HTMLElement; anchor: HTMLAnchorElement; url: string }`; `resolveResultHref(href: string, base: string): string | null`; `readResults(root: ParentNode, cfg: SelectorConfig, base: string): SerpResult[]` (marks each result element with `data-gist-id` and skips marked ones on later calls).

- [ ] **Step 1: Write the failing test**

`apps/extension/test/reader.test.ts`:
```ts
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { readResults, resolveResultHref } from '../src/serp/reader';

const cfg = { version: 1, result: '#rso div.MjjYud, #rso div.g', title: 'h3', exclude: ['#tads', 'related-question-pair', 'g-scrolling-carousel'] };
const BASE = 'https://www.google.com/search?q=cookies';
const organic = (href: string, title = 'T') => `<div class="MjjYud"><div class="g"><a href="${href}"><h3>${title}</h3></a><cite>x</cite></div></div>`;
const serp = (inner: string) => { document.body.innerHTML = `<div id="rso">${inner}</div>`; };

beforeEach(() => { document.body.innerHTML = ''; });

describe('resolveResultHref', () => {
  it('decodes Google /url redirects and normalizes', () => {
    expect(resolveResultHref('/url?q=https://blog.test/b%3Fx%3D1%26utm_source%3Dg&sa=U', BASE)).toBe('https://blog.test/b?x=1');
  });
  it('rejects Google-internal and non-http links', () => {
    expect(resolveResultHref('https://www.google.com/maps/place/x', BASE)).toBeNull();
    expect(resolveResultHref('/search?q=more', BASE)).toBeNull();
    expect(resolveResultHref('https://webcache.googleusercontent.com/x', BASE)).toBeNull();
    expect(resolveResultHref('javascript:void(0)', BASE)).toBeNull();
  });
  it('punycodes IDN hosts', () => {
    expect(resolveResultHref('https://bücher.de/x', BASE)).toBe('https://xn--bcher-kva.de/x');
  });
});

describe('readResults', () => {
  it('reads organic results, keeping only the innermost match', () => {
    serp(organic('https://a.com/1') + organic('https://b.com/2'));
    const r = readResults(document, cfg, BASE);
    expect(r.map((x) => x.url)).toEqual(['https://a.com/1', 'https://b.com/2']);
    expect(r.every((x) => x.el.classList.contains('g'))).toBe(true);
    expect(r[0]!.anchor.tagName).toBe('A');
  });
  it('skips excluded blocks and results without a title link', () => {
    serp(
      `<div id="tads">${organic('https://ad.test/')}</div>` +
      `<related-question-pair>${organic('https://paa.test/')}</related-question-pair>` +
      `<div class="MjjYud"><div class="g"><h3>No link</h3></div></div>` +
      organic('https://real.test/'),
    );
    expect(readResults(document, cfg, BASE).map((x) => x.url)).toEqual(['https://real.test/']);
  });
  it('skips Google-internal results', () => {
    serp(organic('https://www.google.com/maps') + organic('https://ok.test/'));
    expect(readResults(document, cfg, BASE).map((x) => x.url)).toEqual(['https://ok.test/']);
  });
  it('does not re-read processed results but picks up new ones', () => {
    serp(organic('https://a.com/'));
    expect(readResults(document, cfg, BASE)).toHaveLength(1);
    expect(readResults(document, cfg, BASE)).toHaveLength(0);
    document.getElementById('rso')!.insertAdjacentHTML('beforeend', organic('https://b.com/'));
    expect(readResults(document, cfg, BASE).map((x) => x.url)).toEqual(['https://b.com/']);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm test apps/extension/test/reader`
Expected: FAIL, unresolved import.

- [ ] **Step 3: Implement**

`apps/extension/src/serp/reader.ts`:
```ts
import { normalizeUrl, type SelectorConfig } from '@gist/shared';

export type SerpResult = { id: string; el: HTMLElement; anchor: HTMLAnchorElement; url: string };

const GOOGLE_HOST = /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/i;
const GOOGLE_OTHER = /(^|\.)(googleusercontent|gstatic)\.com$/i;
let nextId = 0;

export function resolveResultHref(href: string, base: string): string | null {
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  if (GOOGLE_HOST.test(u.hostname) && u.pathname === '/url') {
    const target = u.searchParams.get('q') ?? u.searchParams.get('url');
    if (!target) return null;
    try {
      u = new URL(target);
    } catch {
      return null;
    }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (GOOGLE_HOST.test(u.hostname) || GOOGLE_OTHER.test(u.hostname)) return null;
  return normalizeUrl(u.toString());
}

export function readResults(root: ParentNode, cfg: SelectorConfig, base: string): SerpResult[] {
  const candidates = [...root.querySelectorAll<HTMLElement>(cfg.result)];
  const out: SerpResult[] = [];
  for (const el of candidates) {
    if (el.dataset.gistId) continue;
    if (candidates.some((other) => other !== el && el.contains(other))) continue; // keep innermost
    if (cfg.exclude.some((sel) => el.closest(sel))) continue;
    const anchor = el.querySelector(cfg.title)?.closest('a') as HTMLAnchorElement | null;
    if (!anchor) continue;
    const url = resolveResultHref(anchor.getAttribute('href') ?? '', base);
    if (!url) continue;
    el.dataset.gistId = String(++nextId);
    out.push({ id: el.dataset.gistId, el, anchor, url });
  }
  return out;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm test apps/extension/test/reader`
Expected: PASS.

- [ ] **Step 5: Verify against real Google pages**

Save three real results pages. In Chrome (logged out, English), search `chocolate chip cookie recipe`, `how to reset tp-link router` and `best running shoes 2026`. Save each with Ctrl+S → "Webpage, HTML Only" to `apps/extension/test/fixtures/serp-cookies.html`, `serp-router.html` and `serp-shoes.html`.

`apps/extension/test/realSerp.test.ts`:
```ts
// @vitest-environment happy-dom
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { selectorConfigSchema } from '@gist/shared';
import { readResults } from '../src/serp/reader';

const dir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const cfg = selectorConfigSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL('../../../data/selectors.json', import.meta.url)), 'utf8')));
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
```

Run: `pnpm test apps/extension/test/realSerp`
Expected: PASS for all three files. Open each file in a browser and compare it with the result count Gist reads. If results are missing, or ads/People Also Ask boxes are read as results, adjust `data/selectors.json` (increment `version` whenever you change it), run `pnpm lists:build`, and re-run both reader tests. Record the final selectors in the task report.

---
### Task 18: Rendering: badge, tag, dim and collapse

**Files:**
- Create: `apps/extension/src/serp/expanded.ts`, `apps/extension/src/render/styles.ts`, `apps/extension/src/render/badge.ts`, `apps/extension/src/render/label.ts`, `apps/extension/src/render/apply.ts`
- Test: `apps/extension/test/apply.test.ts`

In this task `label.ts` is the complete card builder. Task 19 only adds tests for the card's behavior.

**Interfaces:**
- Consumes: `SerpResult` (Task 17); `Verdict`, `FlagVerdict`, `FlagReason`, `DimensionKey` from `@gist/shared`.
- Produces:
  - `type ExpandedSet = { has(url: string): boolean; add(url: string): void }`, `createExpandedSet(storage: Pick<Storage, 'getItem' | 'setItem'> | null, key?: string): ExpandedSet`
  - `type RenderDeps = { expanded: ExpandedSet; onFlag: (url: string, verdict: FlagVerdict, reason?: FlagReason) => void }`
  - `renderBadge(r: SerpResult, v: Verdict, deps: RenderDeps): ShadowRoot`
  - `buildCard(url: string, v: Verdict, deps: RenderDeps): HTMLElement`
  - `applyVerdict(r: SerpResult, v: Verdict, deps: RenderDeps): void`
  - DOM contract (used by tests): badge host is `span[data-gist-badge]` right after the result's anchor, with an open shadow root containing `.badge`, `.tag`, `.dot`, `.card`. The collapse bar is `div[data-gist-collapsed="<id>"]` right before the result.

- [ ] **Step 1: Write the failing test**

`apps/extension/test/apply.test.ts`:
```ts
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { Verdict } from '@gist/shared';
import { applyVerdict } from '../src/render/apply';
import { createExpandedSet } from '../src/serp/expanded';
import type { SerpResult } from '../src/serp/reader';

export const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  grade: 50, verdict: 'Thin', confidence: 'low', action: 'tag',
  dimensions: { info: 50, originality: null, human: 50, siteBehavior: null, monetization: 50 },
  reasons: [{ id: 'info.early', label: 'Useful content starts after 900 words', effect: -15 }],
  userOverride: null,
  ...over,
});

let r: SerpResult;
const deps = () => ({ expanded: createExpandedSet(null), onFlag: () => {} });
const shadow = () => document.querySelector('span[data-gist-badge]')!.shadowRoot!;

beforeEach(() => {
  document.body.innerHTML = '<div id="rso"><div class="g"><a href="https://a.com/"><h3>A</h3></a></div></div>';
  const el = document.querySelector<HTMLElement>('.g')!;
  r = { id: '1', el, anchor: el.querySelector('a')!, url: 'https://a.com/' };
});

describe('applyVerdict', () => {
  it('tag: adds one badge host right after the anchor with a Thin tag', () => {
    applyVerdict(r, verdict(), deps());
    applyVerdict(r, verdict(), deps());
    expect(document.querySelectorAll('span[data-gist-badge]')).toHaveLength(1);
    expect(r.anchor.nextElementSibling?.matches('span[data-gist-badge]')).toBe(true);
    expect(shadow().querySelector('.tag')?.textContent).toBe('Thin');
    expect(r.el.style.opacity).toBe('');
  });

  it('dim: fades the result and tags it Filler', () => {
    applyVerdict(r, verdict({ verdict: 'Filler', action: 'dim', confidence: 'high', grade: 25 }), deps());
    expect(r.el.style.opacity).toBe('0.45');
    expect(shadow().querySelector('.tag')?.textContent).toBe('Filler');
  });

  it('collapse: hides the result behind a bar with the top negative reason; Show expands it', () => {
    const d = deps();
    applyVerdict(r, verdict({ verdict: 'Slop', action: 'collapse', confidence: 'high', grade: 5 }), d);
    expect(r.el.style.display).toBe('none');
    const bar = document.querySelector('div[data-gist-collapsed="1"]')!;
    expect(bar.nextElementSibling).toBe(r.el);
    expect(bar.shadowRoot!.textContent).toContain('Collapsed by Gist: Useful content starts after 900 words');
    bar.shadowRoot!.querySelector('button')!.click();
    expect(document.querySelector('div[data-gist-collapsed]')).toBeNull();
    expect(r.el.style.display).toBe('');
    expect(r.el.style.opacity).toBe('0.45');
    expect(d.expanded.has('https://a.com/')).toBe(true);
  });

  it('collapse on an already-expanded URL shows it dimmed with no bar', () => {
    const d = deps();
    d.expanded.add('https://a.com/');
    applyVerdict(r, verdict({ verdict: 'Slop', action: 'collapse' }), d);
    expect(document.querySelector('div[data-gist-collapsed]')).toBeNull();
    expect(r.el.style.opacity).toBe('0.45');
  });

  it('re-applying with action none clears dim and collapse (e.g. after "Fine")', () => {
    applyVerdict(r, verdict({ verdict: 'Slop', action: 'collapse' }), deps());
    applyVerdict(r, verdict({ verdict: 'Slop', action: 'none', userOverride: 'fine' }), deps());
    expect(r.el.style.display).toBe('');
    expect(r.el.style.opacity).toBe('');
    expect(document.querySelector('div[data-gist-collapsed]')).toBeNull();
    expect(shadow().querySelector('.tag')).toBeNull();
  });

  it('dot: shows a green dot for Solid when enabled', () => {
    applyVerdict(r, verdict({ verdict: 'Solid', action: 'dot', grade: 90 }), deps());
    expect(shadow().querySelector('.dot')).not.toBeNull();
  });
});

describe('createExpandedSet', () => {
  it('persists to the given storage and tolerates null', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    createExpandedSet(storage).add('https://a.com/');
    expect(createExpandedSet(storage).has('https://a.com/')).toBe(true);
    expect(createExpandedSet(null).has('x')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm test apps/extension/test/apply`
Expected: FAIL, unresolved imports.

- [ ] **Step 3: Implement**

`apps/extension/src/serp/expanded.ts`:
```ts
export type ExpandedSet = { has(url: string): boolean; add(url: string): void };

/** Collapsed results the user chose to show, kept for the tab session (sessionStorage on the Google origin). */
export function createExpandedSet(storage: Pick<Storage, 'getItem' | 'setItem'> | null, key = 'gist-expanded'): ExpandedSet {
  let set = new Set<string>();
  try {
    set = new Set(JSON.parse(storage?.getItem(key) ?? '[]') as string[]);
  } catch {
    // corrupted or unavailable storage: start empty
  }
  return {
    has: (url) => set.has(url),
    add: (url) => {
      set.add(url);
      try {
        storage?.setItem(key, JSON.stringify([...set]));
      } catch {
        // storage full or blocked: keep in memory only
      }
    },
  };
}
```

`apps/extension/src/render/styles.ts`:
```ts
export const BADGE_CSS = `
:host { all: initial; display: inline-block; vertical-align: middle; margin-left: 6px; font: 12px/1.4 system-ui, sans-serif; position: relative; z-index: 5; }
.wrap { display: inline-flex; align-items: center; gap: 4px; position: relative; }
.badge { all: unset; cursor: pointer; width: 18px; height: 18px; border-radius: 50%; display: inline-grid; place-items: center; font-weight: 700; font-size: 11px; color: #fff; background: #6b7280; }
.badge:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
.badge.conf-high { background: #374151; }
.badge.conf-none { background: #9ca3af; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #16a34a; }
.tag { padding: 0 6px; border-radius: 8px; font-size: 11px; background: #fef3c7; color: #92400e; }
.tag-dim, .tag-collapse { background: #fee2e2; color: #991b1b; }
.card { position: absolute; top: 24px; left: 0; width: 280px; padding: 12px; border-radius: 10px; background: #fff; color: #111827; box-shadow: 0 8px 24px rgba(0,0,0,.18); border: 1px solid #e5e7eb; }
.card[hidden] { display: none; }
.head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
.grade { font-size: 22px; font-weight: 700; }
.verdict { font-weight: 600; }
.low { font-size: 10px; padding: 0 5px; border-radius: 6px; background: #e5e7eb; color: #374151; }
.note { font-size: 11px; color: #4b5563; margin-bottom: 6px; }
.row { display: grid; grid-template-columns: 110px 1fr 28px; align-items: center; gap: 6px; margin: 3px 0; }
.bar { height: 6px; border-radius: 3px; background: #e5e7eb; overflow: hidden; }
.fill { display: block; height: 100%; background: #2563eb; }
.num { text-align: right; color: #6b7280; }
.na { color: #9ca3af; }
details { margin-top: 8px; } summary { cursor: pointer; color: #2563eb; }
ul { margin: 6px 0 0; padding-left: 16px; } li { margin: 2px 0; }
.flags { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; align-items: center; }
.flags button { all: unset; cursor: pointer; padding: 2px 8px; border: 1px solid #d1d5db; border-radius: 6px; }
.flags button:focus-visible { outline: 2px solid #2563eb; }
@media (prefers-color-scheme: dark) {
  .card { background: #1f2937; color: #f9fafb; border-color: #374151; }
  .bar { background: #374151; } .flags button { border-color: #4b5563; }
}`;

export const BAR_CSS = `
:host { all: initial; display: block; font: 13px/1.5 system-ui, sans-serif; }
.bar { padding: 6px 10px; margin: 4px 0 12px; border-radius: 8px; background: #f3f4f6; color: #4b5563; }
button { all: unset; cursor: pointer; color: #2563eb; }
button:focus-visible { outline: 2px solid #2563eb; }
@media (prefers-color-scheme: dark) { .bar { background: #1f2937; color: #d1d5db; } }`;
```

`apps/extension/src/render/label.ts`:
```ts
import type { DimensionKey, FlagReason, Verdict } from '@gist/shared';
import type { RenderDeps } from './badge';

const DIMS: [DimensionKey, string][] = [
  ['info', 'Information value'],
  ['originality', 'Originality'],
  ['human', 'Human presence'],
  ['siteBehavior', 'Site behavior'],
  ['monetization', 'Low ad pressure'],
];
const REASONS: [FlagReason, string][] = [
  ['filler', 'Filler'],
  ['ai_images', 'AI images'],
  ['fake_reviews', 'Fake reviews'],
  ['untested_roundup', 'Untested roundup'],
  ['other', 'Other'],
];

/** Every string that may come from a scored page is set with textContent (never innerHTML). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', undefined, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

export function buildCard(url: string, v: Verdict, deps: RenderDeps): HTMLElement {
  const card = el('div', 'card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Gist nutrition label');

  const head = el('div', 'head');
  if (v.confidence === 'none' || v.grade === null) {
    head.append(el('span', 'verdict', 'Not scored yet'));
  } else {
    head.append(el('span', 'grade', String(v.grade)), el('span', 'verdict', v.verdict ?? ''));
    if (v.confidence === 'low') head.append(el('span', 'low', 'low confidence'));
  }
  card.append(head);
  if (v.userOverride) card.append(el('div', 'note', `You marked this as ${v.userOverride}`));

  for (const [key, label] of DIMS) {
    const row = el('div', 'row');
    row.dataset.dim = key;
    row.append(el('span', 'name', label));
    const score = v.dimensions[key];
    if (score === null) {
      const na = el('span', 'na', '—');
      na.title = key === 'originality' ? 'Needs deep scan (Pro)' : 'Not available for this page';
      row.append(na, el('span'));
    } else {
      const bar = el('span', 'bar');
      const fill = el('span', 'fill');
      fill.style.width = `${score}%`;
      bar.append(fill);
      row.append(bar, el('span', 'num', String(score)));
    }
    card.append(row);
  }

  if (v.reasons.length > 0) {
    const details = el('details');
    const ul = el('ul');
    for (const r of v.reasons.slice(0, 8)) ul.append(el('li', undefined, r.label));
    details.append(el('summary', undefined, 'Why?'), ul);
    card.append(details);
  }

  const flags = el('div', 'flags');
  const showReasons = () =>
    flags.replaceChildren(
      el('span', undefined, 'What kind?'),
      ...REASONS.map(([reason, label]) => {
        const b = button(label, () => deps.onFlag(url, 'slop', reason));
        b.dataset.reason = reason;
        return b;
      }),
    );
  flags.append(button('Slop', showReasons), button('Fine', () => deps.onFlag(url, 'fine')));
  card.append(flags);
  return card;
}
```

`apps/extension/src/render/badge.ts`:
```ts
import type { FlagReason, FlagVerdict, Verdict } from '@gist/shared';
import type { ExpandedSet } from '../serp/expanded';
import type { SerpResult } from '../serp/reader';
import { buildCard } from './label';
import { BADGE_CSS } from './styles';

export type RenderDeps = { expanded: ExpandedSet; onFlag: (url: string, verdict: FlagVerdict, reason?: FlagReason) => void };

function mountBadge(r: SerpResult): ShadowRoot {
  let host = r.el.querySelector<HTMLElement>('span[data-gist-badge]');
  if (!host) {
    host = document.createElement('span');
    host.dataset.gistBadge = r.id;
    host.attachShadow({ mode: 'open' });
    r.anchor.after(host);
  }
  return host.shadowRoot!;
}

function tagText(v: Verdict): string | null {
  if (v.action === 'tag') return v.verdict;
  if (v.action === 'dim' || v.action === 'collapse') return v.userOverride === 'slop' ? 'Flagged by you' : v.verdict;
  return null;
}

export function renderBadge(r: SerpResult, v: Verdict, deps: RenderDeps): ShadowRoot {
  const shadow = mountBadge(r);
  const style = document.createElement('style');
  style.textContent = BADGE_CSS;
  const wrap = document.createElement('span');
  wrap.className = 'wrap';

  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = `badge conf-${v.confidence}`;
  badge.textContent = 'G';
  badge.setAttribute('aria-label', 'Gist: why this result was rated');
  badge.setAttribute('aria-haspopup', 'dialog');
  wrap.append(badge);

  if (v.action === 'dot') {
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.title = 'Solid';
    wrap.append(dot);
  }
  const text = tagText(v);
  if (text) {
    const tag = document.createElement('span');
    tag.className = `tag tag-${v.action}`;
    tag.textContent = text;
    wrap.append(tag);
  }

  const card = buildCard(r.url, v, deps);
  card.hidden = true;
  wrap.append(card);
  shadow.replaceChildren(style, wrap);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    card.hidden = false;
  };
  const close = () => {
    clearTimeout(timer);
    card.hidden = true;
  };
  badge.addEventListener('mouseenter', () => {
    clearTimeout(timer);
    timer = setTimeout(open, 300);
  });
  badge.addEventListener('focus', open);
  wrap.addEventListener('mouseleave', close);
  wrap.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') close();
  });
  return shadow;
}
```

`apps/extension/src/render/apply.ts`:
```ts
import type { Verdict } from '@gist/shared';
import type { SerpResult } from '../serp/reader';
import { renderBadge, type RenderDeps } from './badge';
import { BAR_CSS } from './styles';

function collapse(r: SerpResult, v: Verdict, deps: RenderDeps): void {
  r.el.style.display = 'none';
  const bar = document.createElement('div');
  bar.dataset.gistCollapsed = r.id;
  const shadow = bar.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = BAR_CSS;
  const box = document.createElement('div');
  box.className = 'bar';
  const reason = document.createElement('span');
  reason.textContent = v.reasons.find((x) => x.effect < 0)?.label ?? 'Low-value page';
  const show = document.createElement('button');
  show.type = 'button';
  show.textContent = 'Show';
  show.addEventListener('click', () => {
    deps.expanded.add(r.url);
    bar.remove();
    r.el.style.display = '';
    r.el.style.opacity = '0.45';
  });
  box.append('Collapsed by Gist: ', reason, ' · ', show);
  shadow.append(style, box);
  r.el.before(bar);
}

/** Idempotent: resets previous rendering for this result, then applies the verdict's action. */
export function applyVerdict(r: SerpResult, v: Verdict, deps: RenderDeps): void {
  renderBadge(r, v, deps);
  r.el.style.opacity = '';
  r.el.style.display = '';
  document.querySelector(`div[data-gist-collapsed="${r.id}"]`)?.remove();
  if (v.action === 'dim' || (v.action === 'collapse' && deps.expanded.has(r.url))) r.el.style.opacity = '0.45';
  else if (v.action === 'collapse') collapse(r, v, deps);
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm test apps/extension/test/apply`
Expected: PASS.

---

### Task 19: Nutrition label behavior (hover, keyboard, Why?, flagging, XSS safety)

**Files:**
- Test: `apps/extension/test/label.test.ts`
- Modify (only if a test fails): `apps/extension/src/render/label.ts`, `apps/extension/src/render/badge.ts`

**Interfaces:**
- Consumes: `renderBadge`, `buildCard`, `RenderDeps` (Task 18).
- Produces: the verified card behavior. No new exports.

- [ ] **Step 1: Write the test**

`apps/extension/test/label.test.ts`:
```ts
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Verdict } from '@gist/shared';
import { renderBadge } from '../src/render/badge';
import { createExpandedSet } from '../src/serp/expanded';
import type { SerpResult } from '../src/serp/reader';

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  grade: 34, verdict: 'Thin', confidence: 'low', action: 'tag',
  dimensions: { info: 20, originality: null, human: 40, siteBehavior: null, monetization: 60 },
  reasons: Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, label: `reason ${i}`, effect: -(10 - i) })),
  userOverride: null,
  ...over,
});

let r: SerpResult;
let onFlag: ReturnType<typeof vi.fn>;
const render = (v: Verdict) => renderBadge(r, v, { expanded: createExpandedSet(null), onFlag });

beforeEach(() => {
  document.body.innerHTML = '<div class="g"><a href="https://a.com/"><h3>A</h3></a></div>';
  const el = document.querySelector<HTMLElement>('.g')!;
  r = { id: '1', el, anchor: el.querySelector('a')!, url: 'https://a.com/' };
  onFlag = vi.fn();
});
afterEach(() => vi.useRealTimers());

describe('nutrition label', () => {
  it('opens 300 ms after hovering the badge and closes on Escape', () => {
    vi.useFakeTimers();
    const s = render(verdict());
    const card = s.querySelector<HTMLElement>('.card')!;
    s.querySelector('.badge')!.dispatchEvent(new Event('mouseenter'));
    vi.advanceTimersByTime(299);
    expect(card.hidden).toBe(true);
    vi.advanceTimersByTime(1);
    expect(card.hidden).toBe(false);
    s.querySelector('.wrap')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(card.hidden).toBe(true);
  });

  it('opens immediately on keyboard focus and closes on mouseleave', () => {
    const s = render(verdict());
    s.querySelector<HTMLElement>('.badge')!.dispatchEvent(new Event('focus'));
    expect(s.querySelector<HTMLElement>('.card')!.hidden).toBe(false);
    s.querySelector('.wrap')!.dispatchEvent(new Event('mouseleave'));
    expect(s.querySelector<HTMLElement>('.card')!.hidden).toBe(true);
  });

  it('shows grade, verdict, low-confidence badge and five dimension rows', () => {
    const s = render(verdict());
    expect(s.querySelector('.grade')?.textContent).toBe('34');
    expect(s.querySelector('.verdict')?.textContent).toBe('Thin');
    expect(s.querySelector('.low')?.textContent).toBe('low confidence');
    const rows = [...s.querySelectorAll<HTMLElement>('.row')];
    expect(rows.map((x) => x.dataset.dim)).toEqual(['info', 'originality', 'human', 'siteBehavior', 'monetization']);
    expect(rows[1]!.querySelector<HTMLElement>('.na')!.title).toBe('Needs deep scan (Pro)');
    expect(rows[0]!.querySelector<HTMLElement>('.fill')!.style.width).toBe('20%');
  });

  it('says "Not scored yet" when there is no score', () => {
    const s = render(verdict({ grade: null, verdict: null, confidence: 'none', action: 'none' }));
    expect(s.querySelector('.head')?.textContent).toBe('Not scored yet');
    expect(s.querySelector('.grade')).toBeNull();
  });

  it('notes the user override', () => {
    expect(render(verdict({ userOverride: 'fine', action: 'none' })).querySelector('.note')?.textContent).toBe('You marked this as fine');
  });

  it('lists at most 8 reasons in the given order under Why?', () => {
    const items = [...render(verdict()).querySelectorAll('details li')].map((li) => li.textContent);
    expect(items).toEqual(Array.from({ length: 8 }, (_, i) => `reason ${i}`));
  });

  it('renders page-derived text as text, never as HTML', () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    const s = render(verdict({ reasons: [{ id: 'human.author', label: `Named author: ${evil}`, effect: 35 }] }));
    expect(s.querySelector('img')).toBeNull();
    expect(s.querySelector('details li')?.textContent).toBe(`Named author: ${evil}`);
  });

  it('Fine flags directly; Slop asks for a reason first', () => {
    const s = render(verdict());
    const buttons = () => [...s.querySelectorAll<HTMLButtonElement>('.flags button')];
    buttons().find((b) => b.textContent === 'Fine')!.click();
    expect(onFlag).toHaveBeenCalledWith('https://a.com/', 'fine');
    buttons().find((b) => b.textContent === 'Slop')!.click();
    expect(buttons().map((b) => b.dataset.reason)).toEqual(['filler', 'ai_images', 'fake_reviews', 'untested_roundup', 'other']);
    buttons().find((b) => b.dataset.reason === 'untested_roundup')!.click();
    expect(onFlag).toHaveBeenLastCalledWith('https://a.com/', 'slop', 'untested_roundup');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm test apps/extension/test/label`
Expected: PASS, since Task 18 already implemented the card. For each failure, fix `label.ts`/`badge.ts` so the behavior matches the test, then re-run. Don't loosen a test.

---

### Task 20: SERP controller and extension wiring (content script + background)

**Files:**
- Create: `apps/extension/src/messages.ts`, `apps/extension/src/serp/controller.ts`, `apps/extension/src/serp/port.ts`
- Create: `apps/extension/entrypoints/google.content.ts`, `apps/extension/entrypoints/background.ts`
- Test: `apps/extension/test/controller.test.ts`

**Interfaces:**
- Consumes: everything in Tasks 14–18, `scoreHtml` from `@gist/layer1`, `normalizeUrl`/`ListBundle` from `@gist/shared`, `data/bundle.json`.
- Produces:
  - `PORT_NAME = 'gist-serp'`; types `InitResponse = { enabled: boolean; selectors: SelectorConfig }`, `RuntimeMessage` (`init` | `flag` | `dimmed` | `noMatches`), `FlagResponse = { verdict: Verdict | null }`, `PortIn = { type: 'score'; urls: string[] }`, `PortOut = { type: 'verdicts'; verdicts: Record<string, Verdict> }`
  - `createSerpController(d: ControllerDeps): { start(): void; stop(): void }`, where `ControllerDeps = { root: Document; selectors: SelectorConfig; base: string; port: { post(msg: PortIn): void; onMessage(cb: (msg: PortOut) => void): void }; flag(url, verdict, reason?): Promise<Verdict | null>; reportDimmed(n: number): void; reportNoMatches(configVersion: number): void; expanded: ExpandedSet; debounceMs?: number }`
  - `createReconnectingPort(): { post(msg: PortIn): void; onMessage(cb: (m: PortOut) => void): void }`

- [ ] **Step 1: Write the failing test**

`apps/extension/test/controller.test.ts`:
```ts
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Verdict } from '@gist/shared';
import type { PortIn, PortOut } from '../src/messages';
import { createSerpController } from '../src/serp/controller';
import { createExpandedSet } from '../src/serp/expanded';

const cfg = { version: 7, result: '#rso div.g', title: 'h3', exclude: [] };
const BASE = 'https://www.google.com/search?q=x';
const organic = (href: string) => `<div class="g"><a href="${href}"><h3>T</h3></a></div>`;
const tick = () => new Promise((r) => setTimeout(r, 20));
const v = (over: Partial<Verdict> = {}): Verdict => ({
  grade: 25, verdict: 'Filler', confidence: 'high', action: 'dim',
  dimensions: { info: null, originality: null, human: null, siteBehavior: 25, monetization: null },
  reasons: [], userOverride: null, ...over,
});

let ctl: ReturnType<typeof createSerpController>;
let posted: PortIn[];
let deliver: (m: PortOut) => void;
let dimmed: number[];
let noMatches: number[];

function start() {
  posted = []; dimmed = []; noMatches = [];
  ctl = createSerpController({
    root: document, selectors: cfg, base: BASE,
    port: { post: (m) => posted.push(m), onMessage: (cb) => { deliver = cb; } },
    flag: async () => v({ action: 'none', userOverride: 'fine' }),
    reportDimmed: (n) => dimmed.push(n),
    reportNoMatches: (ver) => noMatches.push(ver),
    expanded: createExpandedSet(null),
    debounceMs: 0,
  });
  ctl.start();
}

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => ctl?.stop());

describe('serp controller', () => {
  it('asks for scores once for all results on the page', () => {
    document.body.innerHTML = `<div id="rso">${organic('https://a.com/') + organic('https://b.com/')}</div>`;
    start();
    expect(posted).toEqual([{ type: 'score', urls: ['https://a.com/', 'https://b.com/'] }]);
  });

  it('applies verdicts and counts each dimmed URL once', () => {
    document.body.innerHTML = `<div id="rso">${organic('https://a.com/')}</div>`;
    start();
    deliver({ type: 'verdicts', verdicts: { 'https://a.com/': v() } });
    deliver({ type: 'verdicts', verdicts: { 'https://a.com/': v() } });
    expect(document.querySelector<HTMLElement>('.g')!.style.opacity).toBe('0.45');
    expect(dimmed).toEqual([1]);
  });

  it('applies verdicts to duplicate URLs, including ones that appear later', async () => {
    document.body.innerHTML = `<div id="rso">${organic('https://a.com/') + organic('https://a.com/')}</div>`;
    start();
    expect(posted).toEqual([{ type: 'score', urls: ['https://a.com/'] }]);
    deliver({ type: 'verdicts', verdicts: { 'https://a.com/': v() } });
    document.getElementById('rso')!.insertAdjacentHTML('beforeend', organic('https://a.com/'));
    await tick();
    const all = [...document.querySelectorAll<HTMLElement>('.g')];
    expect(all).toHaveLength(3);
    expect(all.every((el) => el.style.opacity === '0.45')).toBe(true);
    expect(posted).toHaveLength(1);
  });

  it('scores results added later (continuous scroll) without re-sending old ones', async () => {
    document.body.innerHTML = `<div id="rso">${organic('https://a.com/')}</div>`;
    start();
    document.getElementById('rso')!.insertAdjacentHTML('beforeend', organic('https://b.com/'));
    await tick();
    expect(posted).toEqual([{ type: 'score', urls: ['https://a.com/'] }, { type: 'score', urls: ['https://b.com/'] }]);
  });

  it('reports no_matches once when #rso has no readable results', async () => {
    document.body.innerHTML = '<div id="rso"><div class="unknown-layout"><a href="https://a.com/"><h3>T</h3></a></div></div>';
    start();
    document.getElementById('rso')!.insertAdjacentHTML('beforeend', '<div class="still-unknown"></div>');
    await tick();
    expect(noMatches).toEqual([7]);
    expect(posted).toEqual([]);
    expect(document.querySelector('span[data-gist-badge]')).toBeNull();
  });

  it('does not report no_matches on pages without #rso', () => {
    document.body.innerHTML = '<div id="other"></div>';
    start();
    expect(noMatches).toEqual([]);
  });

  it('re-renders a result after the user flags it', async () => {
    document.body.innerHTML = `<div id="rso">${organic('https://a.com/')}</div>`;
    start();
    deliver({ type: 'verdicts', verdicts: { 'https://a.com/': v() } });
    const shadow = document.querySelector('span[data-gist-badge]')!.shadowRoot!;
    [...shadow.querySelectorAll<HTMLButtonElement>('.flags button')].find((b) => b.textContent === 'Fine')!.click();
    await tick();
    expect(document.querySelector<HTMLElement>('.g')!.style.opacity).toBe('');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm test apps/extension/test/controller`
Expected: FAIL, unresolved imports.

- [ ] **Step 3: Implement messages and the controller**

`apps/extension/src/messages.ts`:
```ts
import type { FlagReason, FlagVerdict, SelectorConfig, Verdict } from '@gist/shared';

export const PORT_NAME = 'gist-serp';

export type InitResponse = { enabled: boolean; selectors: SelectorConfig };
export type FlagResponse = { verdict: Verdict | null };
export type RuntimeMessage =
  | { type: 'init'; host: string }
  | { type: 'flag'; url: string; verdict: FlagVerdict; reason?: FlagReason }
  | { type: 'dimmed'; n: number }
  | { type: 'noMatches'; configVersion: number };

export type PortIn = { type: 'score'; urls: string[] };
export type PortOut = { type: 'verdicts'; verdicts: Record<string, Verdict> };
```

`apps/extension/src/serp/controller.ts`:
```ts
import type { FlagReason, FlagVerdict, SelectorConfig, Verdict } from '@gist/shared';
import type { PortIn, PortOut } from '../messages';
import { applyVerdict } from '../render/apply';
import type { RenderDeps } from '../render/badge';
import type { ExpandedSet } from './expanded';
import { readResults, type SerpResult } from './reader';

export type ControllerDeps = {
  root: Document;
  selectors: SelectorConfig;
  base: string;
  port: { post(msg: PortIn): void; onMessage(cb: (msg: PortOut) => void): void };
  flag(url: string, verdict: FlagVerdict, reason?: FlagReason): Promise<Verdict | null>;
  reportDimmed(n: number): void;
  reportNoMatches(configVersion: number): void;
  expanded: ExpandedSet;
  debounceMs?: number;
};

export function createSerpController(d: ControllerDeps) {
  const byUrl = new Map<string, SerpResult[]>();
  const last = new Map<string, Verdict>();
  const counted = new Set<string>();
  let reportedNoMatch = false;
  let observer: MutationObserver | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const renderDeps: RenderDeps = {
    expanded: d.expanded,
    onFlag: (url, verdict, reason) => {
      void d.flag(url, verdict, reason).then((v) => v && apply(url, v));
    },
  };

  function apply(url: string, v: Verdict) {
    last.set(url, v);
    for (const r of byUrl.get(url) ?? []) applyVerdict(r, v, renderDeps);
    if ((v.action === 'dim' || v.action === 'collapse') && v.userOverride === null && !counted.has(url)) {
      counted.add(url);
      d.reportDimmed(1);
    }
  }

  function scan() {
    const found = readResults(d.root, d.selectors, d.base);
    if (found.length === 0) {
      // Layout drift: results container exists but nothing matched. Do nothing to the page, report once.
      if (!reportedNoMatch && byUrl.size === 0 && d.root.querySelector('#rso')) {
        reportedNoMatch = true;
        d.reportNoMatches(d.selectors.version);
      }
      return;
    }
    const fresh: string[] = [];
    for (const r of found) {
      const list = byUrl.get(r.url);
      if (list) list.push(r);
      else {
        byUrl.set(r.url, [r]);
        fresh.push(r.url);
      }
      const known = last.get(r.url);
      if (known) applyVerdict(r, known, renderDeps);
    }
    if (fresh.length > 0) d.port.post({ type: 'score', urls: fresh });
  }

  return {
    start() {
      d.port.onMessage((msg) => {
        if (msg.type === 'verdicts') for (const [url, v] of Object.entries(msg.verdicts)) apply(url, v);
      });
      scan();
      observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(scan, d.debounceMs ?? 200);
      });
      observer.observe(d.root.body, { childList: true, subtree: true });
    },
    stop() {
      observer?.disconnect();
      clearTimeout(timer);
    },
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm test apps/extension/test/controller`
Expected: PASS.

- [ ] **Step 5: Write the port helper and entrypoints**

`apps/extension/src/serp/port.ts`:
```ts
import { browser } from 'wxt/browser';
import { PORT_NAME, type PortIn, type PortOut } from '../messages';

/** The MV3 service worker can go away; reconnect lazily on the next post. */
export function createReconnectingPort() {
  let port: ReturnType<typeof browser.runtime.connect> | null = null;
  const listeners: ((m: PortOut) => void)[] = [];
  const connect = () => {
    const p = browser.runtime.connect({ name: PORT_NAME });
    p.onMessage.addListener((m: unknown) => listeners.forEach((l) => l(m as PortOut)));
    p.onDisconnect.addListener(() => {
      if (port === p) port = null;
    });
    port = p;
    return p;
  };
  return {
    post(msg: PortIn) {
      (port ?? connect()).postMessage(msg);
    },
    onMessage(cb: (m: PortOut) => void) {
      listeners.push(cb);
      if (!port) connect();
    },
  };
}
```

`apps/extension/entrypoints/google.content.ts`:
```ts
import { browser } from 'wxt/browser';
import { GOOGLE_MATCHES, isWebSearch } from '../src/google';
import type { FlagResponse, InitResponse, RuntimeMessage } from '../src/messages';
import { createSerpController } from '../src/serp/controller';
import { createExpandedSet } from '../src/serp/expanded';
import { createReconnectingPort } from '../src/serp/port';

const send = <T>(msg: RuntimeMessage) => browser.runtime.sendMessage(msg) as Promise<T>;

export default defineContentScript({
  matches: GOOGLE_MATCHES,
  runAt: 'document_idle',
  async main() {
    if (!isWebSearch(new URL(location.href))) return;
    const init = await send<InitResponse | null>({ type: 'init', host: location.hostname });
    if (!init?.enabled) return;
    createSerpController({
      root: document,
      selectors: init.selectors,
      base: location.href,
      port: createReconnectingPort(),
      flag: async (url, verdict, reason) => (await send<FlagResponse | null>({ type: 'flag', url, verdict, reason }))?.verdict ?? null,
      reportDimmed: (n) => void send({ type: 'dimmed', n }),
      reportNoMatches: (configVersion) => void send({ type: 'noMatches', configVersion }),
      expanded: createExpandedSet(window.sessionStorage),
    }).start();
  },
});
```

`apps/extension/entrypoints/background.ts`:
```ts
import { browser } from 'wxt/browser';
import { scoreHtml } from '@gist/layer1';
import { normalizeUrl, type ListBundle } from '@gist/shared';
import bundled from '../../../data/bundle.json';
import { createApi } from '../src/api';
import { API_BASE } from '../src/config';
import { addDimmed } from '../src/counter';
import { ensureDevice } from '../src/device';
import { createFallback } from '../src/fallback';
import { createFlagSender } from '../src/flagSender';
import { createListStore } from '../src/listStore';
import { PORT_NAME, type InitResponse, type PortIn, type PortOut, type RuntimeMessage } from '../src/messages';
import { createOrchestrator } from '../src/orchestrator';
import { getOverride, setOverride } from '../src/overrides';
import { browserKV as kv, fetchHtmlFromDevice, hasAllSitesPermission } from '../src/platform';
import { getSettings, isPaused } from '../src/settings';

const DAY = 24 * 60 * 60 * 1000;

export default defineBackground(() => {
  const api = createApi(API_BASE);
  const lists = createListStore({ kv, api, bundled: bundled as ListBundle, now: Date.now });
  const ready = lists.load().then(async () => {
    if (Date.now() - lists.lastSyncedAt() > DAY) await lists.sync();
  });
  const fallback = createFallback({ kv, hasPermission: hasAllSitesPermission, fetchHtml: fetchHtmlFromDevice, score: scoreHtml, now: Date.now });
  const orchestrator = createOrchestrator({
    api,
    match: (url) => lists.match(url),
    override: (url) => getOverride(kv, url),
    greenDot: async () => (await getSettings(kv)).greenDot,
    fallback,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  const flags = createFlagSender({ kv, api });

  browser.runtime.onInstalled.addListener(async ({ reason }) => {
    await browser.alarms.create('daily', { periodInMinutes: 24 * 60 });
    if (reason === 'install') {
      void ensureDevice(kv, api);
      await browser.tabs.create({ url: browser.runtime.getURL('/welcome.html') });
    }
  });

  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== 'daily') return;
    await ready;
    await lists.sync();
    await flags.flush();
  });

  async function handle(msg: RuntimeMessage): Promise<unknown> {
    await ready;
    switch (msg.type) {
      case 'init': {
        const s = await getSettings(kv);
        return { enabled: s.enabled && !isPaused(s, msg.host), selectors: lists.current().selectors } satisfies InitResponse;
      }
      case 'flag': {
        const url = normalizeUrl(msg.url);
        if (!url) return { verdict: null };
        await setOverride(kv, url, msg.verdict);
        void flags.send({ url, verdict: msg.verdict, reason: msg.reason });
        return { verdict: await orchestrator.verdict(url) };
      }
      case 'dimmed':
        await addDimmed(kv, msg.n, new Date());
        return null;
      case 'noMatches': {
        const day = new Date().toISOString().slice(0, 10);
        if ((await kv.get<string>('noMatchesDay')) !== day) {
          await kv.set('noMatchesDay', day);
          await api.event({ configVersion: msg.configVersion, event: 'no_matches' }).catch(() => {});
        }
        return null;
      }
    }
  }

  browser.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
    handle(msg).then(sendResponse, () => sendResponse(null));
    return true; // async response
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    port.onMessage.addListener(async (msg: PortIn) => {
      if (msg.type !== 'score') return;
      await ready;
      const urls = msg.urls.map(normalizeUrl).filter((u): u is string => u !== null);
      await orchestrator.run(urls, (verdicts) => port.postMessage({ type: 'verdicts', verdicts } satisfies PortOut));
    });
  });
});
```

- [ ] **Step 6: Build and typecheck**

Run: `pnpm --filter @gist/extension typecheck && pnpm --filter @gist/extension build`
Expected: no type errors, and `apps/extension/.output/chrome-mv3/` contains `manifest.json`. Check the manifest: `permissions` is `["storage","alarms","activeTab"]`, `host_permissions` is only the API origin, `optional_host_permissions` is `["<all_urls>"]`, and the content script matches the Google search URLs. If `defineBackground`/`defineContentScript` are reported as undefined, add `import { defineBackground } from 'wxt/utils/define-background'` / `import { defineContentScript } from 'wxt/utils/define-content-script'` (WXT 0.20 paths).

---

### Task 21: Popup, first-run page and manual end-to-end check

**Files:**
- Create: `apps/extension/entrypoints/popup/index.html`, `apps/extension/entrypoints/popup/main.ts`, `apps/extension/entrypoints/popup/style.css`
- Create: `apps/extension/entrypoints/welcome/index.html`, `apps/extension/entrypoints/welcome/main.ts`

**Interfaces:**
- Consumes: `browserKV`, `hasAllSitesPermission` (14), `getSettings`/`updateSettings`/`togglePause`/`isPaused` (14), `getDimmed` (14).
- Produces: the user-facing popup and welcome pages (no new code exports).

- [ ] **Step 1: Popup**

`apps/extension/entrypoints/popup/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Gist</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <main>
      <h1>Gist</h1>
      <label class="row"><input type="checkbox" id="enabled" /> Mark low-value results</label>
      <label class="row"><input type="checkbox" id="greenDot" /> Green dot on Solid results</label>
      <button id="pause" type="button" hidden></button>
      <p id="count" class="muted"></p>
      <section id="coverage">
        <p class="muted">Some sites block our server. Gist can read those result pages on this device instead. It sends no cookies and uploads nothing.</p>
        <button id="grant" type="button">Enable full coverage</button>
        <p id="granted" hidden>Full coverage is on.</p>
      </section>
    </main>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

`apps/extension/entrypoints/popup/style.css`:
```css
:root { color-scheme: light dark; --bg: #fff; --fg: #111827; --muted: #6b7280; --accent: #2563eb; }
@media (prefers-color-scheme: dark) { :root { --bg: #111827; --fg: #f9fafb; --muted: #9ca3af; } }
body { margin: 0; width: 300px; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, sans-serif; }
main { padding: 16px; display: grid; gap: 10px; }
h1 { margin: 0; font-size: 18px; }
.row { display: flex; gap: 8px; align-items: center; }
.muted { color: var(--muted); margin: 0; font-size: 12px; }
button { font: inherit; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--muted); background: transparent; color: var(--fg); cursor: pointer; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
#grant { border-color: var(--accent); color: var(--accent); }
```

`apps/extension/entrypoints/popup/main.ts`:
```ts
import { browser } from 'wxt/browser';
import { getDimmed } from '../../src/counter';
import { browserKV as kv, hasAllSitesPermission } from '../../src/platform';
import { getSettings, isPaused, togglePause, updateSettings } from '../../src/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function render() {
  const s = await getSettings(kv);
  $<HTMLInputElement>('enabled').checked = s.enabled;
  $<HTMLInputElement>('greenDot').checked = s.greenDot;

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const host = tab?.url ? new URL(tab.url).hostname : null;
  const pause = $<HTMLButtonElement>('pause');
  pause.hidden = !host || !/^www\.google\./.test(host);
  if (host) pause.textContent = isPaused(s, host) ? `Resume on ${host}` : `Pause on ${host}`;

  const n = await getDimmed(kv, new Date());
  $('count').textContent = `${n} result${n === 1 ? '' : 's'} dimmed today`;

  const granted = await hasAllSitesPermission();
  $('grant').hidden = granted;
  $('granted').hidden = !granted;
  return host;
}

let host: string | null = null;
render().then((h) => (host = h));

$<HTMLInputElement>('enabled').addEventListener('change', async (e) => {
  await updateSettings(kv, { enabled: (e.target as HTMLInputElement).checked });
});
$<HTMLInputElement>('greenDot').addEventListener('change', async (e) => {
  await updateSettings(kv, { greenDot: (e.target as HTMLInputElement).checked });
});
$('pause').addEventListener('click', async () => {
  if (host) await togglePause(kv, host);
  await render();
});
$('grant').addEventListener('click', async () => {
  await browser.permissions.request({ origins: ['<all_urls>'] });
  await render();
});
```

- [ ] **Step 2: First-run page**

`apps/extension/entrypoints/welcome/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Welcome to Gist</title>
    <link rel="stylesheet" href="../popup/style.css" />
    <style>body { width: auto; } main { max-width: 560px; margin: 40px auto; padding: 0 16px; }</style>
  </head>
  <body>
    <main>
      <h1>Gist is on</h1>
      <p>On Google search, Gist tags thin results, dims known content farms and explains every decision. Hover the small <strong>G</strong> badge next to a result to see why.</p>
      <h2>What leaves your device</h2>
      <ul>
        <li>The addresses of the results on the page, sent anonymously so our server can score them. Never your search terms, cookies or browsing history.</li>
        <li>Your "Slop" / "Fine" flags, tied to a random device key, never to your identity.</li>
      </ul>
      <h2>Optional: full coverage</h2>
      <p class="muted">Some sites block our server. If you allow it, Gist reads those pages on this device (no cookies, results stay on your device). Chrome will say this lets Gist "read your data on all websites".</p>
      <p><button id="grant" type="button">Enable full coverage</button> <span id="granted" hidden>Full coverage is on.</span></p>
      <p class="muted">You can change this anytime from the Gist toolbar button.</p>
    </main>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

`apps/extension/entrypoints/welcome/main.ts`:
```ts
import { browser } from 'wxt/browser';
import { hasAllSitesPermission } from '../../src/platform';

const grant = document.getElementById('grant')!;
const granted = document.getElementById('granted')!;

async function render() {
  const ok = await hasAllSitesPermission();
  grant.hidden = ok;
  granted.hidden = !ok;
}

grant.addEventListener('click', async () => {
  await browser.permissions.request({ origins: ['<all_urls>'] });
  await render();
});
void render();
```

- [ ] **Step 3: Build**

Run: `pnpm --filter @gist/extension build`
Expected: the build succeeds, and `.output/chrome-mv3/` contains `popup.html` and `welcome.html`.

- [ ] **Step 4: Manual end-to-end check (record results in the task report)**

With the local server from Task 13 Step 5 running:
1. Temporarily add one test entry to `data/domains/farms.json` for a domain that shows up for `chocolate chip cookie recipe`, with `siteBehavior` 10 and reason "TEST ENTRY – remove". Then run `pnpm lists:build && pnpm lists:publish && pnpm --filter @gist/extension build`.
2. Chrome → `chrome://extensions` → Developer mode → Load unpacked → `apps/extension/.output/chrome-mv3`. The welcome tab should open.
3. Search `chocolate chip cookie recipe`. Expect: every organic result gets a G badge. The test-farm result is collapsed with "Collapsed by Gist: TEST ENTRY – remove · Show". After 1–8 s, other badges gain grades, and some may show a "Thin" tag. No result is dimmed unless it's on the list (strict rule).
4. Hover a badge: the card opens after about 300 ms, Originality shows "—", and Why? lists signals. Tab onto a badge: the card opens. Press Escape: it closes.
5. Click "Fine" on the collapsed result: it expands immediately. Reload: it stays un-collapsed (override persisted).
6. Open the popup: the count shows ≥1 dimmed today. Toggle "Pause on www.google.com", reload the search, and nothing is marked. Resume.
7. DevTools → the service worker's Network tab: `/score` request bodies contain only `urls`, no cookies, no query. The server log shows only route labels.
8. Remove the TEST entry, then run `pnpm lists:build` again.

---

### Task 22: Evaluation harness (labeled set → precision, recall, false-positive rate)

**Files:**
- Create: `eval/lib.ts`, `eval/run-eval.ts`, `eval/snapshot.ts`, `eval/labels.jsonl` (empty), `eval/README.md`
- Modify: root `package.json` (add `@gist/layer1`, `@gist/combiner` devDependencies and the `eval`/`eval:snapshot` scripts)
- Test: `eval/test/lib.test.ts`

**Interfaces:**
- Consumes: `scoreHtml` from `@gist/layer1`; `combine`, `verdictFor` from `@gist/combiner`.
- Produces: `type Label = 'slop' | 'thin' | 'ok' | 'solid'`; `type LabelRow`; `parseLabels(text: string): LabelRow[]`; `rawGrade(layer1): number`; `predictedLabel(grade): Label`; `computeMetrics(rows: Scored[]): Metrics`; `formatReport(m: Metrics): string`; `pnpm eval`; `pnpm eval:snapshot <label> <url>`.

- [ ] **Step 1: Wire the root package**

Add to the root `package.json` `devDependencies`: `"@gist/layer1": "workspace:*"`, `"@gist/combiner": "workspace:*"`. Add to `scripts`: `"eval": "tsx eval/run-eval.ts"`, `"eval:snapshot": "tsx eval/snapshot.ts"`. Then run `pnpm install`.

- [ ] **Step 2: Write the failing test**

`eval/test/lib.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { computeMetrics, formatReport, parseLabels, predictedLabel, type Scored } from '../lib';

const row = (label: Scored['label'], grade: number, id = `${label}-${grade}`): Scored => ({ id, url: `https://x.test/${id}`, label, grade });

describe('eval lib', () => {
  it('maps grades to label bands (Filler and Slop both count as slop)', () => {
    expect([90, 70, 45, 30, 5].map(predictedLabel)).toEqual(['solid', 'ok', 'thin', 'slop', 'slop']);
  });

  it('computes per-label precision/recall and the rule-B false-positive rate', () => {
    const m = computeMetrics([row('slop', 10), row('slop', 50), row('ok', 65), row('ok', 30), row('solid', 85)]);
    expect(m.n).toBe(5);
    expect(m.perLabel.slop).toEqual({ precision: 0.5, recall: 0.5, support: 2 });
    expect(m.perLabel.thin).toEqual({ precision: 0, recall: null, support: 0 });
    expect(m.wouldDim.falsePositiveRate).toBeCloseTo(1 / 3);
    expect(m.wouldDim.falsePositives.map((r) => r.grade)).toEqual([30]);
    expect(formatReport(m)).toContain('False-positive rate');
  });

  it('parses JSONL, skipping blank lines, and reports bad lines by number', () => {
    const ok = parseLabels('{"id":"a","url":"https://a.test/","label":"ok","snapshot":"snapshots/a.html","labeledAt":"2026-09-29"}\n\n');
    expect(ok).toHaveLength(1);
    expect(() => parseLabels('{"id":"a"}\n{"id":"b","url":"u","label":"great","snapshot":"s","labeledAt":"d"}')).toThrow(/line 1/);
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `pnpm test eval`
Expected: FAIL, unresolved import.

- [ ] **Step 4: Implement**

`eval/lib.ts`:
```ts
import { combine, verdictFor } from '@gist/combiner';
import type { Layer1Result } from '@gist/shared';

export type Label = 'slop' | 'thin' | 'ok' | 'solid';
export const LABELS: Label[] = ['slop', 'thin', 'ok', 'solid'];
export type LabelRow = { id: string; url: string; label: Label; snapshot: string; labeledAt: string };
export type Scored = { id: string; url: string; label: Label; grade: number };
export type Metrics = {
  n: number;
  perLabel: Record<Label, { precision: number | null; recall: number | null; support: number }>;
  /** Pages you labeled ok/solid that Layer 1 alone would dim or collapse under rule B (grade < 40). */
  wouldDim: { falsePositiveRate: number | null; falsePositives: Scored[] };
};

export function parseLabels(text: string): LabelRow[] {
  const rows: LabelRow[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const r = JSON.parse(line) as Partial<LabelRow>;
    const valid = r.id && r.url && r.snapshot && r.labeledAt && LABELS.includes(r.label as Label);
    if (!valid) throw new Error(`labels.jsonl line ${i + 1}: needs id, url, label (${LABELS.join('|')}), snapshot, labeledAt`);
    rows.push(r as LabelRow);
  });
  return rows;
}

/** Layer-1-only grade with no floor, i.e. what rule B would act on. */
export function rawGrade(layer1: Layer1Result): number {
  return combine({ layer1, entry: null, override: null, greenDot: false, lowConfidenceFloor: 'Slop' }).grade ?? 0;
}

export function predictedLabel(grade: number): Label {
  const v = verdictFor(grade);
  return v === 'Solid' ? 'solid' : v === 'OK' ? 'ok' : v === 'Thin' ? 'thin' : 'slop';
}

export function computeMetrics(rows: Scored[]): Metrics {
  const perLabel = {} as Metrics['perLabel'];
  for (const l of LABELS) {
    const predicted = rows.filter((r) => predictedLabel(r.grade) === l);
    const actual = rows.filter((r) => r.label === l);
    const tp = predicted.filter((r) => r.label === l).length;
    perLabel[l] = {
      precision: predicted.length ? tp / predicted.length : null,
      recall: actual.length ? tp / actual.length : null,
      support: actual.length,
    };
  }
  const good = rows.filter((r) => r.label === 'ok' || r.label === 'solid');
  const falsePositives = good.filter((r) => r.grade < 40);
  return { n: rows.length, perLabel, wouldDim: { falsePositiveRate: good.length ? falsePositives.length / good.length : null, falsePositives } };
}

const pct = (x: number | null) => (x === null ? '  n/a' : `${(x * 100).toFixed(1).padStart(5)}%`);

export function formatReport(m: Metrics): string {
  const lines = [`Labeled results: ${m.n}`, '', 'label   precision  recall   support'];
  for (const l of LABELS) {
    const p = m.perLabel[l];
    lines.push(`${l.padEnd(7)} ${pct(p.precision)}    ${pct(p.recall)}   ${String(p.support).padStart(4)}`);
  }
  lines.push('', `False-positive rate if Layer 1 alone could dim (rule B): ${pct(m.wouldDim.falsePositiveRate)}`);
  for (const fp of m.wouldDim.falsePositives) lines.push(`  FP  grade ${fp.grade}  [${fp.label}]  ${fp.url}`);
  return lines.join('\n');
}
```

`eval/run-eval.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreHtml } from '@gist/layer1';
import { computeMetrics, formatReport, parseLabels, rawGrade, type Scored } from './lib';

const dir = fileURLToPath(new URL('.', import.meta.url));
const rows = parseLabels(readFileSync(join(dir, 'labels.jsonl'), 'utf8'));
if (rows.length === 0) {
  console.log('No labels yet. Add some with: pnpm eval:snapshot <slop|thin|ok|solid> <url>');
  process.exit(0);
}
const scored: Scored[] = [];
for (const r of rows) {
  const path = join(dir, r.snapshot);
  if (!existsSync(path)) {
    console.warn(`missing snapshot for ${r.id}: ${r.snapshot}`);
    continue;
  }
  scored.push({ id: r.id, url: r.url, label: r.label, grade: rawGrade(scoreHtml(readFileSync(path, 'utf8'), new Date())) });
}
console.log(formatReport(computeMetrics(scored)));
```

`eval/snapshot.ts`:
```ts
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LABELS, type Label } from './lib';

const [label, url] = process.argv.slice(2);
if (!LABELS.includes(label as Label) || !url) {
  console.error('usage: pnpm eval:snapshot <slop|thin|ok|solid> <url>');
  process.exit(1);
}
const dir = fileURLToPath(new URL('.', import.meta.url));
const id = createHash('sha1').update(url).digest('hex').slice(0, 10);
const res = await fetch(url, { headers: { 'user-agent': 'GistBot/1.0 (eval snapshot)' }, redirect: 'follow' });
if (!res.ok) {
  console.error(`fetch failed: ${res.status}. Save the page manually to eval/snapshots/${id}.html and append the label line yourself.`);
  process.exit(1);
}
mkdirSync(join(dir, 'snapshots'), { recursive: true });
writeFileSync(join(dir, 'snapshots', `${id}.html`), await res.text());
appendFileSync(join(dir, 'labels.jsonl'), `${JSON.stringify({ id, url, label, snapshot: `snapshots/${id}.html`, labeledAt: new Date().toISOString().slice(0, 10) })}\n`);
console.log(`labeled ${id} as ${label}`);
```

`eval/labels.jsonl`: create an empty file.

`eval/README.md`:
```markdown
# Layer 1 evaluation

Goal (spec §9): ~300 hand-labeled Google results, so we know when Layer 1 alone is safe to dim (switch `LOW_CONFIDENCE_FLOOR` to `'Filler'`).

- Label: `pnpm eval:snapshot <slop|thin|ok|solid> <url>`. Label by reading the page, not by guessing from the domain. Aim for a spread of topics (recipes, tech how-to, product reviews, health, travel) and roughly equal ok/solid vs thin/slop.
- Run: `pnpm eval`. The number that matters is **False-positive rate if Layer 1 alone could dim**. Agree a threshold (e.g. under 2%) before flipping the constant.
- Snapshots are git-ignored (they are third-party pages); keep them locally or in private storage.
```

- [ ] **Step 5: Run the tests and the script**

Run: `pnpm test eval && pnpm eval`
Expected: tests PASS, and `pnpm eval` prints "No labels yet…".

> **Owner task:** label about 300 results with `pnpm eval:snapshot`. This needs a human to judge each page and can't be automated.

---

### Task 23: Daily Google layout check

**Files:**
- Create: `scripts/lib/countOrganic.ts`, `scripts/layout-check.ts`, `.github/workflows/layout-check.yml`
- Modify: root `package.json` (add `playwright` and `happy-dom` devDependencies and the `layout:check` script)
- Test: `scripts/test/countOrganic.test.ts`

**Interfaces:**
- Consumes: `selectorConfigSchema` from `@gist/shared`; `data/selectors.json`.
- Produces: `COUNT_ORGANIC_SRC: string` (a self-contained browser function `(cfg) => number`, kept as a string so tsx/esbuild can't inject helpers into it); `pnpm layout:check` (exit 0 = OK, 1 = selectors broken, 2 = Google blocked the check, inconclusive).

- [ ] **Step 1: Wire the root package**

Add to the root `devDependencies`: `"playwright": "^1.49.1"`, `"happy-dom": "^15.11.7"`. Add to `scripts`: `"layout:check": "tsx scripts/layout-check.ts"`. Then run `pnpm install && pnpm exec playwright install chromium`.

- [ ] **Step 2: Write the failing test**

`scripts/test/countOrganic.test.ts`:
```ts
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { COUNT_ORGANIC_SRC } from '../lib/countOrganic';

const count = new Function(`return ${COUNT_ORGANIC_SRC}`)() as (cfg: unknown) => number;
const cfg = { version: 1, result: '#rso div.MjjYud, #rso div.g', title: 'h3', exclude: ['#tads'] };
const organic = (href: string) => `<div class="MjjYud"><div class="g"><a href="${href}"><h3>T</h3></a></div></div>`;

describe('COUNT_ORGANIC_SRC', () => {
  it('counts innermost organic results, excluding ads and Google links', () => {
    document.body.innerHTML = `<div id="rso">${organic('https://a.com/')}${organic('https://b.com/')}<div id="tads">${organic('https://ad.com/')}</div>${organic('https://www.google.com/maps')}</div>`;
    expect(count(cfg)).toBe(2);
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `pnpm test scripts`
Expected: FAIL, unresolved import.

- [ ] **Step 4: Implement**

`scripts/lib/countOrganic.ts`:
```ts
/** Mirrors apps/extension/src/serp/reader.ts, as plain ES5 source so it can run inside page.evaluate. */
export const COUNT_ORGANIC_SRC = `function (cfg) {
  var c = Array.prototype.slice.call(document.querySelectorAll(cfg.result));
  return c.filter(function (el) {
    if (c.some(function (o) { return o !== el && el.contains(o); })) return false;
    if (cfg.exclude.some(function (s) { return el.closest(s); })) return false;
    var t = el.querySelector(cfg.title);
    var a = t && t.closest('a[href]');
    if (!a) return false;
    return !/(^|\\.)google\\./.test(new URL(a.getAttribute('href'), 'https://www.google.com/').hostname);
  }).length;
}`;
```

`scripts/layout-check.ts`:
```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { selectorConfigSchema } from '@gist/shared';
import { COUNT_ORGANIC_SRC } from './lib/countOrganic';

const QUERIES = ['chocolate chip cookie recipe', 'how to reset tp-link router', 'best running shoes'];
const cfg = selectorConfigSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL('../data/selectors.json', import.meta.url)), 'utf8')));

const browser = await chromium.launch();
const page = await browser.newPage({ locale: 'en-US' });
let broken = false;
try {
  for (const q of QUERIES) {
    await page.goto(`https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en&gl=us`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('consent.google')) {
      await page.getByRole('button', { name: /accept all/i }).click();
      await page.waitForLoadState('domcontentloaded');
    }
    if (page.url().includes('/sorry/')) {
      console.error('Google served a CAPTCHA: result inconclusive');
      process.exitCode = 2;
      break;
    }
    const n = (await page.evaluate(`(${COUNT_ORGANIC_SRC})(${JSON.stringify(cfg)})`)) as number;
    console.log(`${q}: ${n} organic results (selectors v${cfg.version})`);
    if (n < 3) broken = true;
  }
} finally {
  await browser.close();
}
if (broken) {
  console.error('Selectors matched fewer than 3 results on at least one query: update data/selectors.json');
  process.exitCode = 1;
}
```

`.github/workflows/layout-check.yml`:
```yaml
name: google-layout-check
on:
  schedule: [{ cron: "17 6 * * *" }]
  workflow_dispatch: {}
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm layout:check
```

- [ ] **Step 5: Run the test and the live check**

Run: `pnpm test scripts && pnpm layout:check`
Expected: the test PASSES. The live check prints three counts ≥3 and exits 0, or exits 2 if Google shows a CAPTCHA to headless Chrome (report that; don't count it as a failure of the selectors).

---

### Task 24: Full verification and launch checklist

**Files:** none new. This task verifies the whole plan and lists what remains for the owner.

- [ ] **Step 1: Whole-repo checks**

Run: `pnpm typecheck && pnpm test && pnpm --filter @gist/extension build`
Expected: no type errors, all tests pass (Docker running for the server repo tests), and the extension builds. Paste the test summary into the report.

- [ ] **Step 2: Spec checklist**

Confirm each item and note the task that proves it:
- D1 server-first fetching with the opt-in device fallback: Tasks 11, 16, 20.
- D2 strict rule with a one-constant switch (`LOW_CONFIDENCE_FLOOR`): Task 6, plus the eval in Task 22.
- D3 combiner runs on the device: Tasks 16, 20.
- D4 no query leaves the device: the tests in Tasks 2, 12 and 15.
- §7 failure behavior (backend down → list verdicts only; no selector matches → nothing plus a report; Layer 1 throws → `parse`; list sync fails → last good copy; flag send fails → queued): Tasks 11, 15, 16, 20.
- §8 privacy rules 1–5: Tasks 12, 15, 14/20 (manifest check).

- [ ] **Step 3: Report the owner tasks that remain before launch**

The plan doesn't do these; list them for the user:
1. Curate `data/domains/farms.json` (a few hundred entries) and `humans.json` using `data/domains/README.md`.
2. Label about 300 results for the evaluation set (`eval/README.md`).
3. Choose the product name and domain, publish the GistBot info page, and set `BOT_INFO_URL`.
4. Deploy the server (Dockerfile) with Postgres on Fly.io or Railway, set `CLIENT_IP_HEADER` for the platform's proxy, and run `pnpm lists:publish` there.
5. Build the extension with `WXT_API_BASE=<prod url> pnpm --filter @gist/extension zip`, and write the Chrome Web Store listing and privacy disclosure (the text on the welcome page is a starting point).
6. Initialize git and commit (deferred at the user's request).

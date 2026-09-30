# Gist Originality Engine (Layer 3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill Gist's Originality dimension with a zero-cost, fingerprint-based signal: winnowed hashes of 8-word sequences checked against a global index of every page Gist has fetched. It feeds a new "copy evidence" confidence path in the combiner.

**Architecture:** A new pure package `@gist/layer3` (fingerprinting, originality scoring, and an in-memory index for eval) sits beside Layer 1. The server writes fingerprints in the fetch job and computes originality on `/score` reads (memoized). The combiner fills Originality and may raise confidence, allowing a dim but never a collapse. The extension passes the new `layer3` field through.

**Tech Stack:** Existing monorepo (pnpm 9, TypeScript 5.6, Vitest 2, Hono, postgres.js, Testcontainers, WXT 0.20.6). No new third-party dependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-gist-originality-engine-design.md` (read it first). It builds on `docs/superpowers/specs/2026-09-29-gist-free-tier-core-design.md`.

## Global Constraints

- **No git commits or pushes.** At the end of each task, stage with `git add -A` and tell the user it's ready to commit. Work on branch `feat/deep-scan`.
- Node 20.10 on this machine; don't upgrade dependencies. WXT stays pinned at `0.20.6`.
- Fingerprints: 8-word sequences (`SHINGLE_WORDS = 8`), winnowing window `WINDOW = 39`, cyrb53 53-bit hash.
- Evidence: `MIN_FINGERPRINTS = 40` own fingerprints **and** counting matches on `MIN_DOMAINS = 2` or more other domains.
- Boilerplate: a hash seen on **more than** `BOILERPLATE_DOMAINS = 50` distinct domains is ignored.
- Originality score: `lerpScore(coverage, 0.7, 0.1)`, so coverage of 10% or less scores 100 and 70% or more scores 0.
- Copy evidence: evidence is enough **and** `coverage >= 0.6` **and** 2 or more other domains **and** Layer-1-only grade `< 60`. It may produce Filler (dim), never Slop (collapse) without a list entry. It skips the human floor.
- Date rule: a match counts unless both dates are known and the match's `publishedAt` is later.
- Memo: 6 h max age, **only `evidence: 'enough'` results are memoized**. Retention: prune fingerprints and memos older than 90 days at boot and every 24 h.
- `/score` never fails because of Layer 3; a Layer 3 error only leaves `layer3` off for that URL.
- Search queries never reach the server (unchanged).
- Docker must be running for server repo and E2E tests (Testcontainers). For manual runs, the test Postgres is on `:55432`, because the user's own Postgres uses `:5432`.

## Review Focus

1. **Very long pages** (tens of thousands of words of main text). A person expects scoring to stay fast and the fingerprint table to stay bounded. Pinned in Task 1 ("100k words fingerprint in under 2 s") and Task 6 ("caps stored fingerprints per page at 5000").
2. **Scripts without spaces** (Chinese or Japanese pages). A person expects no crash and a neutral Originality bar. Pinned in Task 1 ("CJK text does not throw").
3. **A page scored before its siblings are indexed.** A person expects evidence to show up on the next read, not after 6 hours. Pinned in Task 7 ("does not memoize insufficient results").
4. **The same URL re-fetched after its content changed.** A person expects old fingerprints to be replaced, not added to. Pinned in Task 6 ("replaceFingerprints replaces a URL's old rows").
5. **Publish-date formats** (date-only, timezone offsets, garbage, future dates). A person expects sensible parsing and a fallback to "unknown". Pinned in Task 4 (the date-format cases).

---

## File Structure

```
packages/layer3/            NEW  src/{index,hash,fingerprint,originality,memoryIndex,math}.ts  test/{fingerprint,originality,memoryIndex}.test.ts test/words.ts
packages/shared/src/types.ts      + Layer3Result; ScoreItem.ready gains layer3?
packages/layer1/src/published.ts  NEW findPublishedAt
packages/layer1/src/index.ts      + scoreContext, exports findPublishedAt/PageContext
packages/combiner/src/index.ts    + layer3 input, copy-evidence path
apps/server/migrations/002_originality.sql  NEW
apps/server/src/repo.ts           + fingerprint/memo/prune methods
apps/server/src/analyze.ts        NEW analyzePage
apps/server/src/originalityService.ts NEW
apps/server/src/scoreService.ts   analyze dep, fingerprint write, layer3 attach
apps/server/src/index.ts          wiring + retention timer
apps/server/test/{originalityRepo,analyze,originalityService,originalityE2E}.test.ts  NEW
apps/extension/src/orchestrator.ts carries layer3
apps/extension/src/render/label.ts null-originality tooltip
eval/lib.ts, eval/run-eval.ts     layer3 via in-memory index; report counts
```

---

### Task 1: `@gist/layer3`: fingerprinting

**Files:**
- Create: `packages/layer3/package.json`, `packages/layer3/tsconfig.json`, `packages/layer3/src/hash.ts`, `packages/layer3/src/fingerprint.ts`, `packages/layer3/src/index.ts`, `packages/layer3/test/words.ts`
- Test: `packages/layer3/test/fingerprint.test.ts`

**Interfaces:**
- Produces: `cyrb53(str: string, seed?: number): number`; `SHINGLE_WORDS = 8`; `WINDOW = 39`; `normalizeWords(text: string): string[]`; `fingerprint(text: string): number[]` (unique hashes in first-seen order); test helper `randomWords(n: number, seed: number): string[]`.

- [ ] **Step 1: Create the package**

`packages/layer3/package.json`:
```json
{
  "name": "@gist/layer3",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "license": "MIT",
  "exports": { ".": "./src/index.ts", "./testing": "./test/words.ts" },
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": { "@gist/shared": "workspace:*" }
}
```

`packages/layer3/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`packages/layer3/test/words.ts`:
```ts
/** Deterministic pseudo-random words (LCG over syllables): large, diverse vocabularies for fingerprint tests. */
const SYL = ['ka', 'lo', 'mi', 'ren', 'tu', 'sa', 'vo', 'ne', 'pi', 'dar', 'shu', 'qe', 'bil', 'fo', 'zan', 'ho', 'wex', 'ly', 'gri', 'tam'];

export function randomWords(n: number, seed: number): string[] {
  let x = seed >>> 0 || 1;
  const next = () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const len = 2 + (next() % 3);
    let w = '';
    for (let j = 0; j < len; j++) w += SYL[next() % SYL.length];
    out.push(w);
  }
  return out;
}
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing test**

`packages/layer3/test/fingerprint.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { fingerprint, normalizeWords } from '../src/fingerprint';
import { randomWords } from './words';

const text = (words: string[]) => words.join(' ');
const shared = (a: number[], b: number[]) => a.filter((h) => new Set(b).has(h)).length;

describe('normalizeWords', () => {
  it('lowercases, applies NFKC, and splits on non-letters/digits', () => {
    expect(normalizeWords('Hello,  WORLD! ﬁne—2024')).toEqual(['hello', 'world', 'fine', '2024']);
  });
});

describe('fingerprint', () => {
  it('is deterministic and ignores case and punctuation', () => {
    const t = text(randomWords(300, 1));
    expect(fingerprint(t)).toEqual(fingerprint(t));
    expect(fingerprint(t.toUpperCase().replace(/ /g, ', '))).toEqual(fingerprint(t));
  });

  it('returns [] for fewer than 8 words', () => {
    expect(fingerprint('one two three four five six seven')).toEqual([]);
  });

  it('keeps roughly one fingerprint per 20 words on long text', () => {
    const n = fingerprint(text(randomWords(4000, 7))).length;
    expect(n).toBeGreaterThan(4000 / 20 * 0.6);
    expect(n).toBeLessThan(4000 / 20 * 1.6);
  });

  it('always detects a copied 50-word passage embedded in different surrounding text', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const passage = randomWords(50, 1000 + seed);
      const a = fingerprint(text([...randomWords(300, 2000 + seed), ...passage, ...randomWords(300, 3000 + seed)]));
      const b = fingerprint(text([...randomWords(250, 4000 + seed), ...passage, ...randomWords(350, 5000 + seed)]));
      expect(shared(a, b)).toBeGreaterThan(0);
    }
  });

  it('does not match a reworded passage (known limitation: lexical, not semantic)', () => {
    const passage = randomWords(60, 42);
    const reworded = passage.map((w, i) => (i % 4 === 0 ? `${w}x` : w));
    const a = fingerprint(text([...randomWords(200, 43), ...passage, ...randomWords(200, 44)]));
    const b = fingerprint(text([...randomWords(200, 45), ...reworded, ...randomWords(200, 46)]));
    expect(shared(a, b)).toBe(0);
  });

  it('fingerprints 100k words in under 2 s', () => {
    const t = text(randomWords(100_000, 9));
    const start = performance.now();
    fingerprint(t);
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it('CJK text (no spaces) does not throw', () => {
    expect(() => fingerprint('这是一个没有空格的中文段落，用于测试指纹函数的稳健性。'.repeat(50))).not.toThrow();
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `NO_COLOR=1 pnpm test packages/layer3`
Expected: FAIL, "Failed to load url ../src/fingerprint".

- [ ] **Step 4: Implement**

`packages/layer3/src/hash.ts`:
```ts
/** cyrb53 (public domain, bryc): fast 53-bit string hash that fits exactly in a JS number. */
export function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
```

`packages/layer3/src/fingerprint.ts`:
```ts
import { cyrb53 } from './hash';

export const SHINGLE_WORDS = 8;
/** Winnowing window: density ≈ 2/(WINDOW+1) ≈ 1 per 20 words; any shared run of WINDOW+SHINGLE_WORDS−1 = 46 words is caught. */
export const WINDOW = 39;

export function normalizeWords(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
}

/** Winnowed fingerprints of 8-word shingles (Schleimer et al.): unique hashes in first-seen order. */
export function fingerprint(text: string): number[] {
  const words = normalizeWords(text);
  if (words.length < SHINGLE_WORDS) return [];
  const hashes: number[] = [];
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i++) hashes.push(cyrb53(words.slice(i, i + SHINGLE_WORDS).join(' ')));

  const w = Math.min(WINDOW, hashes.length);
  const out: number[] = [];
  const seen = new Set<number>();
  let lastPos = -1;
  for (let start = 0; start + w <= hashes.length; start++) {
    let minPos = start;
    // Rightmost minimum: on ties prefer the later position, so consecutive windows keep picking the same one.
    for (let j = start; j < start + w; j++) if (hashes[j]! <= hashes[minPos]!) minPos = j;
    if (minPos !== lastPos) {
      lastPos = minPos;
      const h = hashes[minPos]!;
      if (!seen.has(h)) {
        seen.add(h);
        out.push(h);
      }
    }
  }
  return out;
}
```

`packages/layer3/src/index.ts`:
```ts
export * from './hash';
export * from './fingerprint';
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `NO_COLOR=1 pnpm test packages/layer3 && pnpm --filter @gist/layer3 typecheck`
Expected: PASS, no type errors. If the density bounds fail, check the window implementation; don't widen the bounds.

- [ ] **Step 6: Stage**

Run: `git add -A` and tell the user Task 1 is ready to commit (`feat(layer3): winnowed text fingerprints`).

---

### Task 2: `@gist/layer3`: originality scoring and the `Layer3Result` type

**Files:**
- Modify: `packages/shared/src/types.ts`
- Create: `packages/layer3/src/math.ts`, `packages/layer3/src/originality.ts`
- Modify: `packages/layer3/src/index.ts`
- Test: `packages/layer3/test/originality.test.ts`

**Interfaces:**
- Consumes: `Signal`, `DimensionResult` from `@gist/shared`.
- Produces (shared):
  ```ts
  type Layer3Result = { layer3Version: string; method: 'fingerprint'; evidence: 'enough' | 'insufficient'; originality: DimensionResult | null; coverage: number; otherDomains: string[]; computedAt: string };
  type ScoreItem = { status: 'ready'; layer1: Layer1Result; layer3?: Layer3Result } | { status: 'pending' } | { status: 'failed'; reason: FailReason };
  ```
- Produces (layer3): `LAYER3_VERSION = '1.0.0'`, `MIN_FINGERPRINTS = 40`, `MIN_DOMAINS = 2`, `type FingerprintMatches = { own: { count: number; domain: string; publishedAt: Date | null }; matches: { hash: number; domain: string; publishedAt: Date | null }[] }`, `originality(input: FingerprintMatches & { now: Date }): Layer3Result`.

- [ ] **Step 1: Add the shared types**

In `packages/shared/src/types.ts`, replace the `ScoreItem` type with:
```ts
export type Layer3Result = {
  layer3Version: string;
  /** 'fingerprint' today; 'llm' is reserved for a future Pro judge. */
  method: 'fingerprint';
  evidence: 'enough' | 'insufficient';
  originality: DimensionResult | null;
  /** Share (0..1) of own fingerprints matched on other domains, counting only matches that are not provably newer. */
  coverage: number;
  /** Matched domains, most matches first, max 5. */
  otherDomains: string[];
  computedAt: string;
};

export type ScoreItem =
  | { status: 'ready'; layer1: Layer1Result; layer3?: Layer3Result }
  | { status: 'pending' }
  | { status: 'failed'; reason: FailReason };
```

- [ ] **Step 2: Write the failing test**

`packages/layer3/test/originality.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { originality, type FingerprintMatches } from '../src/originality';

const now = new Date('2026-09-30T00:00:00Z');
const d = (s: string) => new Date(s);
const own = (count = 100, publishedAt: Date | null = null) => ({ count, domain: 'me.com', publishedAt });
const m = (hash: number, domain: string, publishedAt: Date | null = null) => ({ hash, domain, publishedAt });
const range = (n: number, from = 0) => Array.from({ length: n }, (_, i) => from + i);
const run = (x: FingerprintMatches) => originality({ ...x, now });

describe('originality', () => {
  it('computes coverage over distinct own hashes and scores it (10% → 100, 70% → 0, 40% → 50)', () => {
    const matches = (k: number) => [...range(k).map((h) => m(h, 'a.com')), m(0, 'b.com')];
    expect(run({ own: own(), matches: matches(10) }).originality?.score).toBe(100);
    expect(run({ own: own(), matches: matches(70) }).originality?.score).toBe(0);
    expect(run({ own: own(), matches: matches(40) }).originality?.score).toBe(50);
    expect(run({ own: own(), matches: matches(40) }).coverage).toBeCloseTo(0.4);
  });

  it('needs at least 40 own fingerprints', () => {
    const matches = [m(1, 'a.com'), m(2, 'b.com')];
    expect(run({ own: own(39), matches }).evidence).toBe('insufficient');
    expect(run({ own: own(39), matches }).originality).toBeNull();
    expect(run({ own: own(40), matches }).evidence).toBe('enough');
  });

  it('needs matches on at least 2 other domains', () => {
    expect(run({ own: own(), matches: range(50).map((h) => m(h, 'a.com')) }).evidence).toBe('insufficient');
    expect(run({ own: own(), matches: [...range(50).map((h) => m(h, 'a.com')), m(1, 'b.com')] }).evidence).toBe('enough');
  });

  it('ignores matches that are provably newer (copies of this page); unknown dates count', () => {
    const r = run({
      own: own(100, d('2024-01-10')),
      matches: [...range(50).map((h) => m(h, 'copier.com', d('2024-03-01'))), m(90, 'a.com', d('2023-01-01')), m(91, 'b.com', null)],
    });
    expect(r.coverage).toBeCloseTo(0.02);
    expect(r.otherDomains.sort()).toEqual(['a.com', 'b.com']);
  });

  it('never counts its own domain, orders domains by match count, max 5', () => {
    const matches = [
      m(1, 'me.com'), ...range(5).map((h) => m(h, 'big.com')), ...range(3).map((h) => m(h, 'mid.com')),
      m(1, 'c.com'), m(2, 'd.com'), m(3, 'e.com'), m(4, 'f.com'),
    ];
    const r = run({ own: own(), matches });
    expect(r.otherDomains).toEqual(['big.com', 'mid.com', 'c.com', 'd.com', 'e.com']);
  });

  it('explains copied text with a percentage and domains, and unique text positively', () => {
    const copied = run({ own: own(), matches: [...range(72).map((h) => m(h, 'a.com')), ...range(10).map((h) => m(h, 'b.com')), m(5, 'c.com')] });
    expect(copied.originality?.signals[0]).toMatchObject({ id: 'orig.copied', label: '72% of this text also appears on 3 other sites: a.com, b.com, c.com' });
    const unique = run({ own: own(), matches: [m(1, 'a.com'), m(2, 'b.com')] });
    expect(unique.originality?.signals[0]).toMatchObject({ id: 'orig.unique', effect: 25 });
  });

  it('stamps version, method and time', () => {
    expect(run({ own: own(), matches: [] })).toMatchObject({ layer3Version: '1.0.0', method: 'fingerprint', computedAt: now.toISOString() });
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `NO_COLOR=1 pnpm test packages/layer3/test/originality`
Expected: FAIL, "Failed to load url ../src/originality".

- [ ] **Step 4: Implement**

`packages/layer3/src/math.ts`:
```ts
export const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));
/** Linear 0–100 score: `zeroAt` maps to 0 and `fullAt` maps to 100. */
export const lerpScore = (value: number, zeroAt: number, fullAt: number) => clamp(Math.round(((value - zeroAt) / (fullAt - zeroAt)) * 100));
```

`packages/layer3/src/originality.ts`:
```ts
import type { Layer3Result, Signal } from '@gist/shared';
import { lerpScore } from './math';

export const LAYER3_VERSION = '1.0.0';
export const MIN_FINGERPRINTS = 40;
export const MIN_DOMAINS = 2;

export type FingerprintMatches = {
  own: { count: number; domain: string; publishedAt: Date | null };
  /** One row per (hash, matching page). Callers exclude boilerplate hashes; own-domain rows are ignored here too. */
  matches: { hash: number; domain: string; publishedAt: Date | null }[];
};

const provablyNewer = (other: Date | null, mine: Date | null) => !!other && !!mine && other.getTime() > mine.getTime();

export function originality(input: FingerprintMatches & { now: Date }): Layer3Result {
  const { own } = input;
  const counting = input.matches.filter((x) => x.domain !== own.domain && !provablyNewer(x.publishedAt, own.publishedAt));
  const matchedHashes = new Set(counting.map((x) => x.hash));
  const coverage = own.count > 0 ? Math.min(1, matchedHashes.size / own.count) : 0;

  const perDomain = new Map<string, number>();
  for (const x of counting) perDomain.set(x.domain, (perDomain.get(x.domain) ?? 0) + 1);
  const ranked = [...perDomain.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const otherDomains = ranked.slice(0, 5).map(([domain]) => domain);

  const base = {
    layer3Version: LAYER3_VERSION,
    method: 'fingerprint' as const,
    coverage: Math.round(coverage * 1000) / 1000,
    otherDomains,
    computedAt: input.now.toISOString(),
  };
  if (own.count < MIN_FINGERPRINTS || perDomain.size < MIN_DOMAINS) return { ...base, evidence: 'insufficient', originality: null };

  const score = lerpScore(coverage, 0.7, 0.1);
  const signal: Signal =
    coverage >= 0.1
      ? {
          id: 'orig.copied',
          label: `${Math.round(coverage * 100)}% of this text also appears on ${perDomain.size} other sites: ${otherDomains.slice(0, 3).join(', ')}`,
          effect: score - 50,
        }
      : { id: 'orig.unique', label: 'Most of this text appears nowhere else Gist has seen', effect: 25 };
  return { ...base, evidence: 'enough', originality: { score, signals: [signal] } };
}
```

Replace `packages/layer3/src/index.ts` with:
```ts
export * from './hash';
export * from './fingerprint';
export * from './originality';
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `NO_COLOR=1 pnpm test packages/layer3 packages/shared && pnpm --filter @gist/layer3 typecheck && pnpm --filter @gist/shared typecheck`
Expected: PASS.

- [ ] **Step 6: Stage**

Run: `git add -A`. Ready to commit: `feat(layer3): originality score with evidence and date rules`.

---

### Task 3: `@gist/layer3`: in-memory index (for eval and tests)

**Files:**
- Create: `packages/layer3/src/memoryIndex.ts`
- Modify: `packages/layer3/src/index.ts`
- Test: `packages/layer3/test/memoryIndex.test.ts`

**Interfaces:**
- Consumes: `FingerprintMatches` (Task 2).
- Produces: `BOILERPLATE_DOMAINS = 50`; `createMemoryIndex(): { add(url: string, domain: string, publishedAt: Date | null, hashes: number[]): void; matchesFor(url: string): FingerprintMatches | null }`. It applies the same filters as the server repository: own domain excluded, and hashes seen on more than 50 distinct domains dropped.

- [ ] **Step 1: Write the failing test**

`packages/layer3/test/memoryIndex.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createMemoryIndex } from '../src/memoryIndex';

describe('memory index', () => {
  it('returns null for unknown urls and own stats for known ones', () => {
    const idx = createMemoryIndex();
    expect(idx.matchesFor('https://x.com/')).toBeNull();
    idx.add('https://me.com/a', 'me.com', new Date('2024-01-01'), [1, 2, 3]);
    expect(idx.matchesFor('https://me.com/a')?.own).toEqual({ count: 3, domain: 'me.com', publishedAt: new Date('2024-01-01') });
  });

  it('finds matches on other domains and excludes the own domain', () => {
    const idx = createMemoryIndex();
    idx.add('https://me.com/a', 'me.com', null, [1, 2, 3]);
    idx.add('https://me.com/b', 'me.com', null, [1]);
    idx.add('https://other.com/x', 'other.com', null, [2, 9]);
    expect(idx.matchesFor('https://me.com/a')?.matches).toEqual([{ hash: 2, domain: 'other.com', publishedAt: null }]);
  });

  it('drops boilerplate hashes seen on more than 50 domains', () => {
    const idx = createMemoryIndex();
    idx.add('https://me.com/a', 'me.com', null, [7, 8]);
    for (let i = 0; i < 51; i++) idx.add(`https://site${i}.com/`, `site${i}.com`, null, [7]);
    idx.add('https://copy.com/', 'copy.com', null, [8]);
    expect(idx.matchesFor('https://me.com/a')?.matches.map((m) => m.hash)).toEqual([8]);
  });

  it('re-adding a url replaces its fingerprints', () => {
    const idx = createMemoryIndex();
    idx.add('https://a.com/', 'a.com', null, [1, 2]);
    idx.add('https://b.com/', 'b.com', null, [1]);
    idx.add('https://a.com/', 'a.com', null, [3]);
    expect(idx.matchesFor('https://b.com/')?.matches).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `NO_COLOR=1 pnpm test packages/layer3/test/memoryIndex`
Expected: FAIL, unresolved import.

- [ ] **Step 3: Implement**

`packages/layer3/src/memoryIndex.ts`:
```ts
import type { FingerprintMatches } from './originality';

export const BOILERPLATE_DOMAINS = 50;

type Page = { domain: string; publishedAt: Date | null; hashes: number[] };

/** In-memory twin of the server's fingerprint table; same filters. Used by eval and tests. */
export function createMemoryIndex() {
  const pages = new Map<string, Page>();
  const postings = new Map<number, Set<string>>();

  const unlink = (url: string) => {
    for (const h of pages.get(url)?.hashes ?? []) postings.get(h)?.delete(url);
  };

  return {
    add(url: string, domain: string, publishedAt: Date | null, hashes: number[]): void {
      unlink(url);
      pages.set(url, { domain, publishedAt, hashes: [...new Set(hashes)] });
      for (const h of pages.get(url)!.hashes) {
        if (!postings.has(h)) postings.set(h, new Set());
        postings.get(h)!.add(url);
      }
    },
    matchesFor(url: string): FingerprintMatches | null {
      const page = pages.get(url);
      if (!page) return null;
      const matches: FingerprintMatches['matches'] = [];
      for (const h of page.hashes) {
        const urls = [...(postings.get(h) ?? [])];
        if (new Set(urls.map((u) => pages.get(u)!.domain)).size > BOILERPLATE_DOMAINS) continue;
        for (const u of urls) {
          const other = pages.get(u)!;
          if (other.domain !== page.domain) matches.push({ hash: h, domain: other.domain, publishedAt: other.publishedAt });
        }
      }
      return { own: { count: page.hashes.length, domain: page.domain, publishedAt: page.publishedAt }, matches };
    },
  };
}
```

Add to `packages/layer3/src/index.ts`:
```ts
export * from './memoryIndex';
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `NO_COLOR=1 pnpm test packages/layer3 && pnpm --filter @gist/layer3 typecheck`
Expected: PASS.

- [ ] **Step 5: Stage**

Run: `git add -A`. Ready to commit: `feat(layer3): in-memory fingerprint index`.

---

### Task 4: Layer 1: `findPublishedAt` and `scoreContext`

**Files:**
- Create: `packages/layer1/src/published.ts`
- Modify: `packages/layer1/src/index.ts`
- Test: `packages/layer1/test/published.test.ts`

**Interfaces:**
- Consumes: `buildContext`, `PageContext` (existing).
- Produces: `findPublishedAt(document: Document, now?: Date): Date | null`; `scoreContext(ctx: PageContext, fetchedAt: Date): Layer1Result` (`scoreHtml(html, at)` becomes `scoreContext(buildContext(html), at)`). Also exports `type PageContext` from `@gist/layer1`. `LAYER1_VERSION` is unchanged.

- [ ] **Step 1: Write the failing test**

`packages/layer1/test/published.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildContext } from '../src/dom';
import { findPublishedAt } from '../src/published';
import { buildContext as exportedBuild, scoreContext, scoreHtml } from '../src/index';
import { blogRecipe, page } from './fixtures';

const now = new Date('2026-09-30T00:00:00Z');
const at = (head: string, body = '<p>x</p>') => findPublishedAt(buildContext(page(head, body)).document, now);

describe('findPublishedAt', () => {
  it('reads article:published_time first', () => {
    expect(at(`<meta property="article:published_time" content="2024-01-10T08:00:00+05:30">
      <script type="application/ld+json">{"datePublished":"2020-01-01"}</script>`)).toEqual(new Date('2024-01-10T02:30:00Z'));
  });
  it('falls back to JSON-LD datePublished, searched recursively', () => {
    expect(at(`<script type="application/ld+json">{"@graph":[{"@type":"Article","datePublished":"2023-05-02"}]}</script>`)).toEqual(new Date('2023-05-02'));
  });
  it('then time[itemprop=datePublished], then meta name=date', () => {
    expect(at('', '<time itemprop="datePublished" datetime="2022-02-02">Feb 2</time>')).toEqual(new Date('2022-02-02'));
    expect(at('<meta name="date" content="2021-03-03">')).toEqual(new Date('2021-03-03'));
  });
  it('skips invalid and future dates, returning the next valid source or null', () => {
    expect(at(`<meta property="article:published_time" content="not a date"><meta name="date" content="2021-03-03">`)).toEqual(new Date('2021-03-03'));
    expect(at('<meta name="date" content="2026-10-05">')).toBeNull();
    expect(at('')).toBeNull();
  });
});

describe('scoreContext', () => {
  it('matches scoreHtml for the same page', () => {
    const t = new Date('2026-09-30T00:00:00Z');
    expect(scoreContext(exportedBuild(blogRecipe()), t)).toEqual(scoreHtml(blogRecipe(), t));
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `NO_COLOR=1 pnpm test packages/layer1/test/published`
Expected: FAIL, "Failed to load url ../src/published".

- [ ] **Step 3: Implement**

`packages/layer1/src/published.ts`:
```ts
function findLdValue(node: unknown, key: string, depth = 0): string | null {
  if (depth > 6 || node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findLdValue(n, key, depth + 1);
      if (r) return r;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj[key] === 'string' && (obj[key] as string).trim()) return (obj[key] as string).trim();
  for (const v of Object.values(obj)) {
    const r = findLdValue(v, key, depth + 1);
    if (r) return r;
  }
  return null;
}

/** Publication date from the page's own metadata, or null. Future dates (beyond now + 1 day) are treated as bogus. */
export function findPublishedAt(document: Document, now: Date = new Date()): Date | null {
  let ld: string | null = null;
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      ld = findLdValue(JSON.parse(s.textContent ?? ''), 'datePublished');
    } catch {
      // malformed JSON-LD is common; ignore it
    }
    if (ld) break;
  }
  const candidates = [
    document.querySelector('meta[property="article:published_time"]')?.getAttribute('content'),
    ld,
    document.querySelector('time[datetime][itemprop="datePublished"]')?.getAttribute('datetime'),
    document.querySelector('meta[name="date"]')?.getAttribute('content'),
  ];
  for (const c of candidates) {
    if (!c) continue;
    const d = new Date(c.trim());
    if (!Number.isNaN(d.getTime()) && d.getTime() <= now.getTime() + 86_400_000) return d;
  }
  return null;
}
```

Replace `packages/layer1/src/index.ts` with:
```ts
import type { Layer1Result } from '@gist/shared';
import { buildContext, type PageContext } from './dom';
import { scoreHuman } from './human';
import { scoreInfo } from './info';
import { scoreMonetization } from './monetization';
import { scoreStyle } from './style';

/** Bump whenever heuristics change: it is part of the server cache key, so pages get re-scored. */
export const LAYER1_VERSION = '1.1.0';

/** Scores an already-built context, so callers that also fingerprint the page parse the HTML once. */
export function scoreContext(ctx: PageContext, fetchedAt: Date): Layer1Result {
  const style = scoreStyle(ctx);
  return {
    layer1Version: LAYER1_VERSION,
    dimensions: { info: scoreInfo(ctx), human: scoreHuman(ctx), monetization: scoreMonetization(ctx) },
    styleAdjust: style.adjust,
    styleSignals: style.signals,
    fetchedAt: fetchedAt.toISOString(),
  };
}

export function scoreHtml(html: string, fetchedAt: Date): Layer1Result {
  return scoreContext(buildContext(html), fetchedAt);
}

export { buildContext, type PageContext } from './dom';
export { findPublishedAt } from './published';
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `NO_COLOR=1 pnpm test packages/layer1 packages/combiner && pnpm --filter @gist/layer1 typecheck`
Expected: PASS (all existing Layer 1 tests too).

- [ ] **Step 5: Stage**

Run: `git add -A`. Ready to commit: `feat(layer1): findPublishedAt and scoreContext`.

---

### Task 5: Combiner: originality and the copy-evidence path

**Files:**
- Modify: `packages/combiner/src/index.ts`
- Test: `packages/combiner/test/originality.test.ts`

**Interfaces:**
- Consumes: `Layer3Result` (Task 2).
- Produces: `CombineInput` gains `layer3?: Layer3Result | null` (optional, so existing callers compile unchanged); `COPY_COVERAGE = 0.6`; `layer1Grade(layer1: Layer1Result): number`.

> Ruling carried into this task: the spec writes `layer3: Layer3Result | null`. It's optional here so the free-tier callers and tests compile unchanged; `undefined` behaves exactly like `null`.

- [ ] **Step 1: Write the failing test**

`packages/combiner/test/originality.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { Layer1Result, Layer3Result, ListEntry } from '@gist/shared';
import { combine, layer1Grade } from '../src/index';

const l1 = (s: number): Layer1Result => ({
  layer1Version: 't',
  dimensions: { info: { score: s, signals: [] }, human: { score: s, signals: [] }, monetization: { score: s, signals: [] } },
  styleAdjust: 0, styleSignals: [], fetchedAt: '2026-09-30T00:00:00.000Z',
});
const l3 = (coverage: number, evidence: 'enough' | 'insufficient' = 'enough', domains = ['a.com', 'b.com']): Layer3Result => ({
  layer3Version: 't', method: 'fingerprint', evidence, coverage, otherDomains: domains, computedAt: '2026-09-30T00:00:00.000Z',
  originality: evidence === 'enough'
    ? { score: Math.max(0, Math.min(100, Math.round(((coverage - 0.7) / -0.6) * 100))), signals: [{ id: 'orig.copied', label: 'copied', effect: -40 }] }
    : null,
});
const base = { entry: null, override: null, greenDot: false } as const;
const human: ListEntry = { match: 'h.com', matchLevel: 'domain', kind: 'human', siteBehavior: 90, reasons: ['Verified'], source: 'seed' };
const farm: ListEntry = { match: 'f.com', matchLevel: 'domain', kind: 'farm', siteBehavior: 5, reasons: ['Farm'], source: 'seed' };

describe('combine with layer3', () => {
  it('layer1Grade is the Layer-1-only weighted grade', () => {
    expect(layer1Grade(l1(30))).toBe(30);
  });

  it('insufficient evidence leaves originality null and changes nothing', () => {
    const v = combine({ ...base, layer1: l1(30), layer3: l3(0.9, 'insufficient') });
    expect(v.dimensions.originality).toBeNull();
    expect(v).toMatchObject({ confidence: 'low', verdict: 'Thin' });
  });

  it('copied + thin Layer 1 is high confidence and dims (Filler)', () => {
    // (30*30 + 0*25 + 30*20 + 30*10) / 85 = 21
    const v = combine({ ...base, layer1: l1(30), layer3: l3(0.8) });
    expect(v).toMatchObject({ grade: 21, verdict: 'Filler', confidence: 'high', action: 'dim' });
    expect(v.dimensions.originality).toBe(0);
    expect(v.reasons.some((r) => r.id === 'guard.copy_evidence')).toBe(true);
  });

  it('copy evidence alone never collapses: Slop is capped at Filler', () => {
    expect(combine({ ...base, layer1: l1(10), layer3: l3(0.9) })).toMatchObject({ verdict: 'Filler', action: 'dim' });
  });

  it('a farm list entry can still collapse', () => {
    expect(combine({ ...base, entry: farm, layer1: l1(10), layer3: l3(0.9) }).action).toBe('collapse');
  });

  it('good Layer 1 (syndication) is not copy evidence: only a low originality bar', () => {
    const v = combine({ ...base, layer1: l1(80), layer3: l3(0.9) });
    expect(v.confidence).toBe('low');
    expect(v.action).not.toBe('dim');
    expect(v.reasons.some((r) => r.id === 'guard.copy_evidence')).toBe(false);
  });

  it('coverage below 0.6 or fewer than 2 domains is not copy evidence', () => {
    expect(combine({ ...base, layer1: l1(30), layer3: l3(0.59) }).confidence).toBe('low');
    expect(combine({ ...base, layer1: l1(30), layer3: l3(0.9, 'enough', ['a.com']) }).confidence).toBe('low');
  });

  it('copy evidence overrides the verified-human floor (spec guardrail)', () => {
    expect(combine({ ...base, entry: human, layer1: l1(20) }).grade).toBe(50);
    const v = combine({ ...base, entry: human, layer1: l1(20), layer3: l3(0.9) });
    expect(v.grade).toBeLessThan(50);
    expect(v.action).toBe('dim');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `NO_COLOR=1 pnpm test packages/combiner/test/originality`
Expected: FAIL, `layer1Grade is not a function` and assertion failures.

- [ ] **Step 3: Implement**

In `packages/combiner/src/index.ts`, make these edits.

1. The import line becomes:
```ts
import type { Action, DimensionKey, FlagVerdict, Layer1Result, Layer3Result, ListEntry, Signal, Verdict, VerdictName } from '@gist/shared';
```

2. After `export const HUMAN_FLOOR = 50;`, add:
```ts
/** Copy evidence (spec O5): enough fingerprint evidence, >= 60% copied, >= 2 other domains, and a thin Layer 1. */
export const COPY_COVERAGE = 0.6;
const LAYER1_KEYS = ['info', 'human', 'monetization'] as const;

/** Grade from Layer 1's own dimensions only (no list, no originality). */
export function layer1Grade(layer1: Layer1Result): number {
  const total = LAYER1_KEYS.reduce((s, k) => s + WEIGHTS[k], 0);
  const weighted = LAYER1_KEYS.reduce((s, k) => s + layer1.dimensions[k].score * WEIGHTS[k], 0) / total;
  return Math.round(Math.min(100, Math.max(0, weighted + layer1.styleAdjust)));
}
```

3. In `CombineInput`, add the field `layer3?: Layer3Result | null;`.

4. In `combine`, replace everything from `const { layer1, entry, override } = input;` up to (not including) `let verdict = verdictFor(grade);` with:
```ts
  const { layer1, entry, override } = input;
  const floor = input.lowConfidenceFloor ?? LOW_CONFIDENCE_FLOOR;
  const l3 = input.layer3?.evidence === 'enough' ? input.layer3 : null;
  const dimensions: Record<DimensionKey, number | null> = {
    info: layer1?.dimensions.info.score ?? null,
    originality: l3?.originality?.score ?? null,
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
  if (l3?.originality) reasons.push(...l3.originality.signals);

  const scored = (Object.keys(WEIGHTS) as DimensionKey[]).filter((k) => dimensions[k] !== null);
  if (scored.length === 0) {
    return finish({ grade: null, verdict: null, confidence: 'none', action: 'none', dimensions, reasons, userOverride: override });
  }

  const copyEvidence =
    !!l3 && !!layer1 && l3.coverage >= COPY_COVERAGE && l3.otherDomains.length >= 2 && layer1Grade(layer1) < 60;

  const totalWeight = scored.reduce((s, k) => s + WEIGHTS[k], 0);
  const weighted = scored.reduce((s, k) => s + (dimensions[k] as number) * WEIGHTS[k], 0) / totalWeight;
  let grade = Math.round(Math.min(100, Math.max(0, weighted + (layer1?.styleAdjust ?? 0))));
  const confidence = entry || copyEvidence ? 'high' : 'low';

  if (entry?.kind === 'farm' && grade > FARM_CAP) {
    reasons.push({ id: 'guard.farm_cap', label: `Known content farm: score capped at ${FARM_CAP}`, effect: FARM_CAP - grade });
    grade = FARM_CAP;
  }
  if (entry?.kind === 'human' && grade < HUMAN_FLOOR && !copyEvidence) {
    reasons.push({ id: 'guard.human_floor', label: `Verified human site: score raised to ${HUMAN_FLOOR}`, effect: HUMAN_FLOOR - grade });
    grade = HUMAN_FLOOR;
  }
  if (copyEvidence) reasons.push({ id: 'guard.copy_evidence', label: 'Copied text plus thin content: page-level evidence', effect: -30 });
```

5. Right after `let verdict = verdictFor(grade);`, add:
```ts
  if (copyEvidence && !entry && verdict === 'Slop') verdict = 'Filler'; // copy evidence may dim, never collapse
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `NO_COLOR=1 pnpm test packages/combiner && pnpm --filter @gist/combiner typecheck`
Expected: PASS, including all existing combine and fairness tests.

- [ ] **Step 5: Stage**

Run: `git add -A`. Ready to commit: `feat(combiner): originality dimension and copy-evidence confidence path`.

---
### Task 6: Server: migration and repository methods for fingerprints and memo

**Files:**
- Create: `apps/server/migrations/002_originality.sql`
- Modify: `apps/server/src/repo.ts`, `apps/server/package.json` (add `"@gist/layer3": "workspace:*"` to dependencies), `apps/server/test/repo.test.ts` (TRUNCATE list)
- Test: `apps/server/test/originalityRepo.test.ts`

**Interfaces:**
- Consumes: `BOILERPLATE_DOMAINS`, `FingerprintMatches` from `@gist/layer3`; `Layer3Result` from `@gist/shared`.
- Produces on `Repo`, with `MAX_FINGERPRINTS_PER_PAGE = 5000` exported from `repo.ts`:
  - `replaceFingerprints(urlNorm: string, domain: string, publishedAt: Date | null, hashes: number[], fetchedAt: Date): Promise<void>`
  - `fingerprintMatches(urlNorm: string): Promise<FingerprintMatches | null>` (null when the URL has no stored fingerprints)
  - `getOriginalityMemo(urls: string[], version: string, maxAgeMs: number): Promise<Map<string, Layer3Result>>`
  - `putOriginalityMemo(urlNorm: string, version: string, result: Layer3Result, computedAt: Date): Promise<void>`
  - `pruneFingerprints(olderThanDays: number): Promise<{ fingerprints: number; memos: number }>`

- [ ] **Step 1: Write the migration and add the dependency**

`apps/server/migrations/002_originality.sql`:
```sql
CREATE TABLE IF NOT EXISTS fingerprints (
  url_norm     text        NOT NULL,
  hash         bigint      NOT NULL,
  domain       text        NOT NULL,
  published_at timestamptz,
  fetched_at   timestamptz NOT NULL,
  PRIMARY KEY (url_norm, hash)
);
CREATE INDEX IF NOT EXISTS fingerprints_hash_idx ON fingerprints (hash);
CREATE INDEX IF NOT EXISTS fingerprints_fetched_idx ON fingerprints (fetched_at);

CREATE TABLE IF NOT EXISTS originality_memo (
  url_norm       text        NOT NULL,
  layer3_version text        NOT NULL,
  result         jsonb       NOT NULL,
  computed_at    timestamptz NOT NULL,
  PRIMARY KEY (url_norm, layer3_version)
);
```

Add `"@gist/layer3": "workspace:*"` to `apps/server/package.json` `dependencies`, then run `pnpm install`.

- [ ] **Step 2: Write the failing test**

`apps/server/test/originalityRepo.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Layer3Result } from '@gist/shared';
import type { Sql } from '../src/db';
import { createRepo, MAX_FINGERPRINTS_PER_PAGE, type Repo } from '../src/repo';
import { startDb } from './helpers/db';

let db: Awaited<ReturnType<typeof startDb>>;
let sql: Sql;
let repo: Repo;
const t = new Date('2026-09-30T00:00:00Z');
const l3 = (coverage: number): Layer3Result => ({
  layer3Version: '1.0.0', method: 'fingerprint', evidence: 'enough', coverage, otherDomains: ['a.com', 'b.com'],
  originality: { score: 10, signals: [] }, computedAt: t.toISOString(),
});

beforeAll(async () => {
  db = await startDb();
  sql = db.sql;
  repo = createRepo(sql);
});
afterAll(async () => db.stop());
beforeEach(async () => {
  await sql`TRUNCATE fingerprints, originality_memo`;
});

describe('fingerprint repository', () => {
  it("replaceFingerprints replaces a URL's old rows", async () => {
    await repo.replaceFingerprints('https://me.com/a', 'me.com', null, [1, 2, 3], t);
    await repo.replaceFingerprints('https://me.com/a', 'me.com', null, [4], t);
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM fingerprints WHERE url_norm = 'https://me.com/a'`;
    expect(row!.n).toBe(1);
  });

  it('caps stored fingerprints per page at 5000', async () => {
    await repo.replaceFingerprints('https://big.com/', 'big.com', null, Array.from({ length: MAX_FINGERPRINTS_PER_PAGE + 10 }, (_, i) => i + 1), t);
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM fingerprints`;
    expect(row!.n).toBe(MAX_FINGERPRINTS_PER_PAGE);
  });

  it('round-trips large 53-bit hashes and dates, and excludes the own domain', async () => {
    const big = 2 ** 52 + 12345;
    await repo.replaceFingerprints('https://me.com/a', 'me.com', new Date('2024-01-10T00:00:00Z'), [big, 2], t);
    await repo.replaceFingerprints('https://me.com/b', 'me.com', null, [2], t);
    await repo.replaceFingerprints('https://other.com/x', 'other.com', new Date('2023-01-01T00:00:00Z'), [big], t);
    const m = await repo.fingerprintMatches('https://me.com/a');
    expect(m?.own).toEqual({ count: 2, domain: 'me.com', publishedAt: new Date('2024-01-10T00:00:00Z') });
    expect(m?.matches).toEqual([{ hash: big, domain: 'other.com', publishedAt: new Date('2023-01-01T00:00:00Z') }]);
    expect(await repo.fingerprintMatches('https://unknown.com/')).toBeNull();
  });

  it('drops boilerplate hashes seen on more than 50 domains', async () => {
    await repo.replaceFingerprints('https://me.com/a', 'me.com', null, [7, 8], t);
    for (let i = 0; i < 51; i++) await repo.replaceFingerprints(`https://site${i}.com/`, `site${i}.com`, null, [7], t);
    await repo.replaceFingerprints('https://copy.com/', 'copy.com', null, [8], t);
    expect((await repo.fingerprintMatches('https://me.com/a'))?.matches.map((x) => x.hash)).toEqual([8]);
  });

  it('memo respects max age and version', async () => {
    await repo.putOriginalityMemo('https://a.com/', '1.0.0', l3(0.8), new Date());
    await repo.putOriginalityMemo('https://b.com/', '1.0.0', l3(0.5), new Date(Date.now() - 7 * 3600_000));
    const got = await repo.getOriginalityMemo(['https://a.com/', 'https://b.com/'], '1.0.0', 6 * 3600_000);
    expect([...got.keys()]).toEqual(['https://a.com/']);
    expect(got.get('https://a.com/')?.coverage).toBe(0.8);
    expect((await repo.getOriginalityMemo(['https://a.com/'], '2.0.0', 6 * 3600_000)).size).toBe(0);
  });

  it('prunes fingerprints and memos older than the cutoff', async () => {
    await repo.replaceFingerprints('https://old.com/', 'old.com', null, [1, 2], new Date(Date.now() - 91 * 86_400_000));
    await repo.replaceFingerprints('https://new.com/', 'new.com', null, [3], new Date());
    await repo.putOriginalityMemo('https://old.com/', '1.0.0', l3(0.1), new Date(Date.now() - 91 * 86_400_000));
    expect(await repo.pruneFingerprints(90)).toEqual({ fingerprints: 2, memos: 1 });
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM fingerprints`;
    expect(row!.n).toBe(1);
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `NO_COLOR=1 pnpm test apps/server/test/originalityRepo`
Expected: FAIL. `MAX_FINGERPRINTS_PER_PAGE` is undefined and `repo.replaceFingerprints is not a function`.

- [ ] **Step 4: Implement**

In `apps/server/src/repo.ts`:

1. The imports become:
```ts
import { BOILERPLATE_DOMAINS, type FingerprintMatches } from '@gist/layer3';
import type { FailReason, Layer1Result, Layer3Result, ListBundle } from '@gist/shared';
import type { Sql } from './db';
```

2. After the existing type declarations, add:
```ts
/** Bounds the table on huge pages (~1 fingerprint per 20 words → 5000 ≈ 100k words). */
export const MAX_FINGERPRINTS_PER_PAGE = 5000;
```

3. Add to `interface Repo`:
```ts
  replaceFingerprints(urlNorm: string, domain: string, publishedAt: Date | null, hashes: number[], fetchedAt: Date): Promise<void>;
  fingerprintMatches(urlNorm: string): Promise<FingerprintMatches | null>;
  getOriginalityMemo(urls: string[], version: string, maxAgeMs: number): Promise<Map<string, Layer3Result>>;
  putOriginalityMemo(urlNorm: string, version: string, result: Layer3Result, computedAt: Date): Promise<void>;
  pruneFingerprints(olderThanDays: number): Promise<{ fingerprints: number; memos: number }>;
```

4. Add these methods at the end of the object returned by `createRepo` (after `eventSummary`):
```ts
    async replaceFingerprints(urlNorm, domain, publishedAt, hashes, fetchedAt) {
      const rows = [...new Set(hashes)].slice(0, MAX_FINGERPRINTS_PER_PAGE).map((hash) => ({
        url_norm: urlNorm, hash: String(hash), domain, published_at: publishedAt, fetched_at: fetchedAt,
      }));
      await sql.begin(async (tx) => {
        await tx`DELETE FROM fingerprints WHERE url_norm = ${urlNorm}`;
        for (let i = 0; i < rows.length; i += 1000) {
          await tx`INSERT INTO fingerprints ${tx(rows.slice(i, i + 1000) as never, 'url_norm', 'hash', 'domain', 'published_at', 'fetched_at')}`;
        }
      });
    },

    async fingerprintMatches(urlNorm) {
      const [own] = await sql<{ n: number; domain: string | null; published_at: Date | null }[]>`
        SELECT count(*)::int AS n, min(domain) AS domain, min(published_at) AS published_at
        FROM fingerprints WHERE url_norm = ${urlNorm}`;
      if (!own || own.n === 0 || !own.domain) return null;
      const rows = await sql<{ hash: string; domain: string; published_at: Date | null }[]>`
        WITH own AS (SELECT hash FROM fingerprints WHERE url_norm = ${urlNorm}),
        boiler AS (
          SELECT f.hash FROM fingerprints f JOIN own USING (hash)
          GROUP BY f.hash HAVING count(DISTINCT f.domain) > ${BOILERPLATE_DOMAINS})
        SELECT f.hash::text AS hash, f.domain, f.published_at
        FROM fingerprints f JOIN own USING (hash)
        WHERE f.domain <> ${own.domain} AND f.hash NOT IN (SELECT hash FROM boiler)`;
      return {
        own: { count: own.n, domain: own.domain, publishedAt: own.published_at },
        matches: rows.map((r) => ({ hash: Number(r.hash), domain: r.domain, publishedAt: r.published_at })),
      };
    },

    async getOriginalityMemo(urls, version, maxAgeMs) {
      const out = new Map<string, Layer3Result>();
      if (urls.length === 0) return out;
      const rows = await sql<{ url_norm: string; result: Layer3Result }[]>`
        SELECT url_norm, result FROM originality_memo
        WHERE url_norm = ANY(${sql.array(urls)}::text[]) AND layer3_version = ${version}
          AND computed_at > now() - (${maxAgeMs} * interval '1 millisecond')`;
      for (const r of rows) out.set(r.url_norm, r.result);
      return out;
    },

    async putOriginalityMemo(urlNorm, version, result, computedAt) {
      await sql`
        INSERT INTO originality_memo (url_norm, layer3_version, result, computed_at)
        VALUES (${urlNorm}, ${version}, ${sql.json(result as never)}, ${computedAt})
        ON CONFLICT (url_norm, layer3_version) DO UPDATE SET result = EXCLUDED.result, computed_at = EXCLUDED.computed_at`;
    },

    async pruneFingerprints(olderThanDays) {
      const [f] = await sql<{ n: number }[]>`
        WITH d AS (DELETE FROM fingerprints WHERE fetched_at < now() - (${olderThanDays} * interval '1 day') RETURNING 1)
        SELECT count(*)::int AS n FROM d`;
      const [m] = await sql<{ n: number }[]>`
        WITH d AS (DELETE FROM originality_memo WHERE computed_at < now() - (${olderThanDays} * interval '1 day') RETURNING 1)
        SELECT count(*)::int AS n FROM d`;
      return { fingerprints: f?.n ?? 0, memos: m?.n ?? 0 };
    },
```

5. In `apps/server/test/repo.test.ts`, extend the `TRUNCATE` in `beforeEach` so the suites stay isolated:
```ts
  await sql`TRUNCATE page_scores, fetch_failures, flags, devices, list_versions, events, fingerprints, originality_memo`;
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `NO_COLOR=1 pnpm test apps/server/test/originalityRepo apps/server/test/repo && pnpm --filter @gist/server typecheck`
Expected: PASS (needs Docker).

- [ ] **Step 6: Stage**

Run: `git add -A`. Ready to commit: `feat(server): fingerprint index, originality memo, retention`.

---

### Task 7: Server: analysis, originality service, `/score` wiring, retention timer

**Files:**
- Create: `apps/server/src/analyze.ts`, `apps/server/src/originalityService.ts`
- Modify: `apps/server/src/scoreService.ts`, `apps/server/src/index.ts`, `apps/server/test/scoreService.test.ts`
- Test: `apps/server/test/analyze.test.ts`, `apps/server/test/originalityService.test.ts`

**Interfaces:**
- Consumes: `buildContext`, `scoreContext`, `findPublishedAt` (Task 4); `fingerprint`, `originality`, `LAYER3_VERSION`, `FingerprintMatches` (Tasks 1–2); Repo methods (Task 6).
- Produces:
  - `type PageAnalysis = { layer1: Layer1Result; index: { hashes: number[]; publishedAt: Date | null } | null }`
  - `analyzePage(html: string, at: Date, deps?: { fingerprint?: (t: string) => number[]; log?: (l: string) => void }): PageAnalysis`
  - `MEMO_MAX_AGE_MS = 6 * 3600 * 1000`
  - `createOriginalityService(d: { repo: Pick<Repo, 'getOriginalityMemo' | 'putOriginalityMemo' | 'fingerprintMatches'>; now: () => Date }): { forUrls(urls: string[]): Promise<Map<string, Layer3Result>> }` (never throws)
  - `createScoreService` deps change: `score` is replaced by `analyze: (html: string, at: Date) => PageAnalysis`; `repo` adds `'replaceFingerprints'`; there's a new optional `originality?: { forUrls(urls: string[]): Promise<Map<string, Layer3Result>> }`

- [ ] **Step 1: Write the failing tests**

`apps/server/test/analyze.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { scoreHtml } from '@gist/layer1';
import { blogRecipe } from '@gist/layer1/fixtures';
import { analyzePage } from '../src/analyze';

const at = new Date('2026-09-30T00:00:00Z');

describe('analyzePage', () => {
  it('returns the Layer 1 result plus fingerprints of the main text', () => {
    const a = analyzePage(blogRecipe(), at);
    expect(a.layer1).toEqual(scoreHtml(blogRecipe(), at));
    expect(a.index?.hashes.length).toBeGreaterThan(0);
    expect(a.index?.publishedAt).toBeNull();
  });

  it('a fingerprinting failure keeps Layer 1 and logs only the error name', () => {
    const logs: string[] = [];
    const a = analyzePage(blogRecipe(), at, { fingerprint: () => { throw new RangeError('boom'); }, log: (l) => logs.push(l) });
    expect(a.layer1.dimensions.info.score).toBeGreaterThan(0);
    expect(a.index).toBeNull();
    expect(logs).toEqual(['error layer3 RangeError']);
  });
});
```

`apps/server/test/originalityService.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import type { Layer3Result } from '@gist/shared';
import type { FingerprintMatches } from '@gist/layer3';
import { createOriginalityService, MEMO_MAX_AGE_MS } from '../src/originalityService';

const now = new Date('2026-09-30T00:00:00Z');
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const copied: FingerprintMatches = {
  own: { count: 100, domain: 'me.com', publishedAt: null },
  matches: [...range(80).map((h) => ({ hash: h, domain: 'a.com', publishedAt: null })), { hash: 1, domain: 'b.com', publishedAt: null }],
};
const sparse: FingerprintMatches = { own: { count: 10, domain: 'me.com', publishedAt: null }, matches: [] };

function setup(over: Partial<{ memo: Map<string, Layer3Result>; matches: (u: string) => Promise<FingerprintMatches | null>; memoFails: boolean }> = {}) {
  const repo = {
    getOriginalityMemo: vi.fn(async () => {
      if (over.memoFails) throw new Error('db');
      return over.memo ?? new Map<string, Layer3Result>();
    }),
    putOriginalityMemo: vi.fn(async () => {}),
    fingerprintMatches: vi.fn(over.matches ?? (async () => copied)),
  };
  return { svc: createOriginalityService({ repo, now: () => now }), repo };
}

describe('originality service', () => {
  it('computes on a memo miss and memoizes enough-evidence results', async () => {
    const { svc, repo } = setup();
    const r = await svc.forUrls(['https://me.com/a']);
    expect(r.get('https://me.com/a')).toMatchObject({ evidence: 'enough', coverage: 0.8 });
    expect(repo.getOriginalityMemo).toHaveBeenCalledWith(['https://me.com/a'], '1.0.0', MEMO_MAX_AGE_MS);
    expect(repo.putOriginalityMemo).toHaveBeenCalledTimes(1);
  });

  it('uses memo hits without recomputing', async () => {
    const hit = { evidence: 'enough', coverage: 0.3 } as Layer3Result;
    const { svc, repo } = setup({ memo: new Map([['https://me.com/a', hit]]) });
    expect((await svc.forUrls(['https://me.com/a'])).get('https://me.com/a')).toBe(hit);
    expect(repo.fingerprintMatches).not.toHaveBeenCalled();
  });

  it('does not memoize insufficient results (siblings may be indexed moments later)', async () => {
    const { svc, repo } = setup({ matches: async () => sparse });
    expect((await svc.forUrls(['https://me.com/a'])).get('https://me.com/a')?.evidence).toBe('insufficient');
    expect(repo.putOriginalityMemo).not.toHaveBeenCalled();
  });

  it('omits URLs without fingerprints or whose computation fails, and never throws', async () => {
    const { svc } = setup({
      matches: async (u) => (u.includes('none') ? null : u.includes('bad') ? Promise.reject(new Error('x')) : copied),
      memoFails: true,
    });
    const r = await svc.forUrls(['https://none.com/', 'https://bad.com/', 'https://ok.com/']);
    expect([...r.keys()]).toEqual(['https://ok.com/']);
  });
});
```

In `apps/server/test/scoreService.test.ts`, change the type import to `import type { Layer1Result, Layer3Result } from '@gist/shared';` and replace the `setup` function with this version (existing calls `setup(fetchImpl)` and `setup(fetchImpl, score)` keep working):
```ts
function setup(
  fetchImpl: (url: string) => Promise<FetchOutcome>,
  score = (_h: string, _a: Date) => fakeResult,
  extra: { originality?: { forUrls(urls: string[]): Promise<Map<string, Layer3Result>> }; fingerprintsFail?: boolean } = {},
) {
  const store = new Map<string, StoredScore>();
  const failures: [string, string][] = [];
  const indexed: [string, string, number[]][] = [];
  const repo = {
    getScores: vi.fn(async (urls: string[]) => new Map(urls.filter((u) => store.has(u)).map((u) => [u, store.get(u)!]))),
    putScore: vi.fn(async (s: StoredScore) => { store.set(s.urlNorm, s); }),
    recordFailure: vi.fn(async (d: string, r: string) => { failures.push([d, r]); }),
    replaceFingerprints: vi.fn(async (u: string, d: string, _p: Date | null, h: number[]) => {
      if (extra.fingerprintsFail) throw new Error('db');
      indexed.push([u, d, h]);
    }),
  };
  const queue = new FetchQueue({ global: 5, perDomain: 2 });
  const fetchPage = vi.fn(fetchImpl);
  const analyze = (h: string, a: Date) => ({ layer1: score(h, a), index: { hashes: [1, 2, 3], publishedAt: null } });
  const svc = createScoreService({ repo, queue, fetchPage, analyze, now: () => new Date('2026-09-29T00:00:00Z'), version: '1.0.0', originality: extra.originality });
  return { svc, queue, repo, fetchPage, failures, indexed };
}
```
Then append these tests inside `describe('scoreService', ...)`:
```ts
  it('indexes fingerprints by registrable domain after a successful fetch', async () => {
    const { svc, queue, indexed } = setup(async () => ({ ok: true, html: '<p>x</p>', finalUrl: '' }));
    await svc.lookup(['https://www.blog.example.co.uk/p']);
    await queue.onIdle();
    expect(indexed).toEqual([['https://www.blog.example.co.uk/p', 'example.co.uk', [1, 2, 3]]]);
  });

  it('a fingerprint write failure still stores the Layer 1 result', async () => {
    const { svc, queue } = setup(async () => ({ ok: true, html: '', finalUrl: '' }), undefined, { fingerprintsFail: true });
    await svc.lookup(['https://a.com/']);
    await queue.onIdle();
    expect((await svc.lookup(['https://a.com/']))['https://a.com/']).toMatchObject({ status: 'ready' });
  });

  it('attaches layer3 to ready results, keyed by the URL as sent', async () => {
    const l3 = { evidence: 'enough', coverage: 0.7 } as Layer3Result;
    const originality = { forUrls: vi.fn(async (urls: string[]) => new Map(urls.map((u) => [u, l3]))) };
    const { svc, queue } = setup(async () => ({ ok: true, html: '', finalUrl: '' }), undefined, { originality });
    await svc.lookup(['HTTPS://A.com/x']);
    await queue.onIdle();
    expect((await svc.lookup(['HTTPS://A.com/x']))['HTTPS://A.com/x']).toEqual({ status: 'ready', layer1: fakeResult, layer3: l3 });
    expect(originality.forUrls).toHaveBeenLastCalledWith(['https://a.com/x']);
  });

  it('a failing originality service never fails /score', async () => {
    const originality = { forUrls: vi.fn(async (): Promise<Map<string, Layer3Result>> => { throw new Error('boom'); }) };
    const { svc, queue } = setup(async () => ({ ok: true, html: '', finalUrl: '' }), undefined, { originality });
    await svc.lookup(['https://a.com/']);
    await queue.onIdle();
    expect((await svc.lookup(['https://a.com/']))['https://a.com/']).toEqual({ status: 'ready', layer1: fakeResult });
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `NO_COLOR=1 pnpm test apps/server/test/analyze apps/server/test/originalityService apps/server/test/scoreService`
Expected: FAIL. The new modules are missing, and the scoreService tests fail because `analyze` isn't used yet.

- [ ] **Step 3: Implement**

`apps/server/src/analyze.ts`:
```ts
import { buildContext, findPublishedAt, scoreContext } from '@gist/layer1';
import { fingerprint as defaultFingerprint } from '@gist/layer3';
import type { Layer1Result } from '@gist/shared';

export type PageAnalysis = { layer1: Layer1Result; index: { hashes: number[]; publishedAt: Date | null } | null };

/** Parses once: Layer 1 scores plus fingerprints for the originality index. Layer 3 failures never cost Layer 1. */
export function analyzePage(
  html: string,
  at: Date,
  deps: { fingerprint?: (text: string) => number[]; log?: (line: string) => void } = {},
): PageAnalysis {
  const ctx = buildContext(html);
  const layer1 = scoreContext(ctx, at);
  try {
    return { layer1, index: { hashes: (deps.fingerprint ?? defaultFingerprint)(ctx.mainText), publishedAt: findPublishedAt(ctx.document, at) } };
  } catch (err) {
    deps.log?.(`error layer3 ${(err as Error).name}`);
    return { layer1, index: null };
  }
}
```

`apps/server/src/originalityService.ts`:
```ts
import { LAYER3_VERSION, originality } from '@gist/layer3';
import type { Layer3Result } from '@gist/shared';
import type { Repo } from './repo';

export const MEMO_MAX_AGE_MS = 6 * 3600 * 1000;

/** Originality computed at read time (siblings may be indexed after this page), memoized only when conclusive. */
export function createOriginalityService(d: {
  repo: Pick<Repo, 'getOriginalityMemo' | 'putOriginalityMemo' | 'fingerprintMatches'>;
  now: () => Date;
}) {
  return {
    async forUrls(urls: string[]): Promise<Map<string, Layer3Result>> {
      const out = new Map<string, Layer3Result>();
      if (urls.length === 0) return out;
      let memo = new Map<string, Layer3Result>();
      try {
        memo = await d.repo.getOriginalityMemo(urls, LAYER3_VERSION, MEMO_MAX_AGE_MS);
      } catch {
        // memo unavailable: compute fresh
      }
      for (const url of urls) {
        const hit = memo.get(url);
        if (hit) {
          out.set(url, hit);
          continue;
        }
        try {
          const matches = await d.repo.fingerprintMatches(url);
          if (!matches) continue;
          const result = originality({ ...matches, now: d.now() });
          out.set(url, result);
          if (result.evidence === 'enough') await d.repo.putOriginalityMemo(url, LAYER3_VERSION, result, d.now()).catch(() => {});
        } catch {
          // leave layer3 off for this URL (spec §10)
        }
      }
      return out;
    },
  };
}
```

Replace `apps/server/src/scoreService.ts` with:
```ts
import { normalizeUrl, registrableDomain, type FailReason, type Layer3Result, type ScoreItem } from '@gist/shared';
import type { PageAnalysis } from './analyze';
import type { FetchOutcome } from './fetcher/fetchPage';
import type { FetchQueue } from './queue';
import type { Repo } from './repo';

export type ScoreService = { lookup(urls: string[]): Promise<Record<string, ScoreItem>> };

export function createScoreService(deps: {
  repo: Pick<Repo, 'getScores' | 'putScore' | 'recordFailure' | 'replaceFingerprints'>;
  queue: FetchQueue;
  fetchPage: (url: string) => Promise<FetchOutcome>;
  analyze: (html: string, at: Date) => PageAnalysis;
  now: () => Date;
  version: string;
  originality?: { forUrls(urls: string[]): Promise<Map<string, Layer3Result>> };
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
        let analysis: PageAnalysis;
        try {
          analysis = deps.analyze(out.html, deps.now());
        } catch {
          return await fail(url, 'parse');
        }
        await deps.repo.putScore({ urlNorm: url, layer1Version: deps.version, status: 'ready', result: analysis.layer1, failReason: null, fetchedAt: deps.now() });
        if (analysis.index) {
          await deps.repo
            .replaceFingerprints(url, domainOf(url), analysis.index.publishedAt, analysis.index.hashes, deps.now())
            .catch(() => {}); // the originality index is best-effort; Layer 1 is already stored
        }
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
      const ready: string[] = [];
      for (const [raw, n] of norm) {
        const s = stored.get(n);
        if (s?.status === 'ready' && s.result) {
          out[raw] = { status: 'ready', layer1: s.result };
          ready.push(n);
        } else if (s?.status === 'failed' && s.failReason) out[raw] = { status: 'failed', reason: s.failReason };
        else {
          out[raw] = { status: 'pending' };
          enqueue(n);
        }
      }
      if (deps.originality && ready.length > 0) {
        const l3 = await deps.originality.forUrls([...new Set(ready)]).catch(() => new Map<string, Layer3Result>());
        for (const [raw, n] of norm) {
          const item = out[raw];
          const r = l3.get(n);
          if (item?.status === 'ready' && r) out[raw] = { ...item, layer3: r };
        }
      }
      return out;
    },
  };
}
```

In `apps/server/src/index.ts`:
- Replace `import { LAYER1_VERSION, scoreHtml } from '@gist/layer1';` with `import { LAYER1_VERSION } from '@gist/layer1';`
- Add `import { analyzePage } from './analyze';` and `import { createOriginalityService } from './originalityService';`
- In `createScoreService({...})`, replace `score: scoreHtml,` with:
```ts
  analyze: (html, at) => analyzePage(html, at, { log: (line) => console.log(line) }),
  originality: createOriginalityService({ repo, now: () => new Date() }),
```
- Before `const app = createApp(`, add:
```ts
// Retention (spec §6.5): fingerprints and memos older than 90 days, at boot and daily.
const prune = () =>
  repo
    .pruneFingerprints(90)
    .then((r) => console.log(`pruned ${r.fingerprints} fingerprints, ${r.memos} memos`))
    .catch((err: Error) => console.log(`error prune ${err.name}`));
void prune();
setInterval(prune, 24 * 3600 * 1000).unref();
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `NO_COLOR=1 pnpm test apps/server && pnpm --filter @gist/server typecheck`
Expected: PASS (whole server suite; Docker needed).

- [ ] **Step 5: Stage**

Run: `git add -A`. Ready to commit: `feat(server): compute originality on /score, index fingerprints on fetch`.

---

### Task 8: End-to-end originality scenario (real Postgres)

**Files:**
- Create: `apps/server/test/fixtures/originality.ts`
- Test: `apps/server/test/originalityE2E.test.ts`
- Modify: `apps/server/package.json` (add devDependency `"@gist/combiner": "workspace:*"`)

**Interfaces:**
- Consumes: `createScoreService`, `analyzePage`, `createOriginalityService`, `createRepo`, `FetchQueue`, `startDb`; `combine` from `@gist/combiner`; `randomWords` from `@gist/layer3/testing`.
- Produces: the scenario test pinning spec §11's end-to-end case.

- [ ] **Step 1: Write the fixtures**

`apps/server/test/fixtures/originality.ts`:
```ts
import { randomWords } from '@gist/layer3/testing';

/** Article prose rich in concrete details (so honest pages score well on Layer 1), deterministic per seed. */
export function articleText(sentences: number, seed: number): string {
  const w = randomWords(sentences * 9, seed);
  const out: string[] = [];
  for (let i = 0; i < sentences; i++) {
    const [a, b, c, d, e, f, g, h, k] = w.slice(i * 9, i * 9 + 9);
    out.push(`<p>In ${2000 + (i % 24)} the ${a} ${b} team measured ${10 + i} kg of ${c} across ${3 + (i % 9)} sites near ${d}, while ${e} ${f} reported ${g} ${h} ${k} gains.</p>`);
  }
  return out.join('\n');
}

export const original = (body: string) => `<!doctype html><html><head>
  <meta name="author" content="Dana Whitfield"><meta property="article:published_time" content="2024-01-10T00:00:00Z">
  </head><body><article><h1>Field notes</h1><p>I spent 14 days on this survey and my notes follow.</p>${body}</article></body></html>`;

export const farm = (copied: string, fillerSeed: number, date: string) => `<!doctype html><html><head>
  <meta name="author" content="admin"><meta property="article:published_time" content="${date}">
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script>
  <script src="https://a.omappapi.com/app/js/api.min.js"></script>
  </head><body><article><h1>Best guide ever</h1>
  ${Array.from({ length: 12 }, () => '<div class="ad-container"></div>').join('')}
  <p>${randomWords(300, fillerSeed).join(' ')}.</p>${copied}
  <img src="https://www.shutterstock.com/a.jpg"><img src="https://www.shutterstock.com/b.jpg">
  <p><a href="https://amzn.to/1">x</a> <a href="https://amzn.to/2">y</a> <a href="/about">about</a></p>
  </article></body></html>`;

/** Wire-style syndication: named author, clean page, undated, carries most of the original. */
export const wire = (copied: string) => `<!doctype html><html><head><meta name="author" content="Staff Reporter Lee Park"></head>
  <body><article><h1>Survey findings</h1>${copied}</article></body></html>`;
```

Add `"@gist/combiner": "workspace:*"` to `apps/server/package.json` `devDependencies` and run `pnpm install`.

- [ ] **Step 2: Write the test**

`apps/server/test/originalityE2E.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { combine } from '@gist/combiner';
import { analyzePage } from '../src/analyze';
import { createOriginalityService } from '../src/originalityService';
import { FetchQueue } from '../src/queue';
import { createRepo } from '../src/repo';
import { createScoreService } from '../src/scoreService';
import { startDb } from './helpers/db';
import { articleText, farm, original, wire } from './fixtures/originality';

const paragraphs = articleText(80, 11).split('\n');
const copied = (fraction: number) => paragraphs.slice(0, Math.round(paragraphs.length * fraction)).join('\n');
const PAGES: Record<string, string> = {
  'https://original-notes.com/survey': original(paragraphs.join('\n')),
  'https://farm-alpha.com/guide': farm(copied(0.75), 101, '2024-03-01T00:00:00Z'),
  'https://farm-beta.net/guide': farm(copied(0.75), 202, '2024-03-02T00:00:00Z'),
  'https://farm-gamma.org/guide': farm(copied(0.75), 303, '2024-03-03T00:00:00Z'),
  'https://wire-news.com/story': wire(copied(0.9)),
};
const urls = Object.keys(PAGES);
const now = () => new Date('2026-09-30T00:00:00Z');

let db: Awaited<ReturnType<typeof startDb>>;
beforeAll(async () => {
  db = await startDb();
});
afterAll(async () => db.stop());

describe('originality end to end', () => {
  it('dims copying farms, protects the dated original and the clean syndicated story', async () => {
    const repo = createRepo(db.sql);
    const queue = new FetchQueue({ global: 5, perDomain: 2 });
    const svc = createScoreService({
      repo,
      queue,
      fetchPage: async (url) => ({ ok: true, html: PAGES[url]!, finalUrl: url }),
      analyze: (html, at) => analyzePage(html, at),
      now,
      version: 'e2e',
      originality: createOriginalityService({ repo, now }),
    });

    await svc.lookup(urls);
    await queue.onIdle();
    const res = await svc.lookup(urls);

    const verdict = (u: string) => {
      const item = res[u]!;
      if (item.status !== 'ready') throw new Error(`${u} not ready`);
      return { v: combine({ layer1: item.layer1, layer3: item.layer3 ?? null, entry: null, override: null, greenDot: false }), l3: item.layer3 };
    };

    for (const f of urls.filter((u) => u.includes('farm'))) {
      const { v, l3 } = verdict(f);
      expect(l3?.evidence, f).toBe('enough');
      expect(l3!.coverage, f).toBeGreaterThanOrEqual(0.6);
      expect(v.confidence, f).toBe('high');
      expect(v.action, f).toBe('dim');
    }
    expect(['none', 'tag', 'dot']).toContain(verdict('https://original-notes.com/survey').v.action);
    const w = verdict('https://wire-news.com/story');
    expect(w.v.action).not.toBe('dim');
    expect(w.v.action).not.toBe('collapse');
  });
});
```

- [ ] **Step 3: Run the test**

Run: `NO_COLOR=1 pnpm test apps/server/test/originalityE2E`
Expected: PASS. If a farm assertion fails, print that farm's `layer1Grade` and `layer3`, then tune the **fixture** (a thinner farm page, or a larger copied share within about 70–80%). Don't change production constants to fit the fixture, and record any fixture change in the ledger.

- [ ] **Step 4: Stage**

Run: `git add -A`. Ready to commit: `test(server): end-to-end originality scenario`.

---

### Task 9: Extension: carry `layer3` into verdicts; label tooltip

**Files:**
- Modify: `apps/extension/src/orchestrator.ts`, `apps/extension/src/render/label.ts`
- Modify: `apps/extension/test/orchestrator.test.ts`, `apps/extension/test/label.test.ts`

**Interfaces:**
- Consumes: `ScoreItem.ready.layer3` (Task 2), `combine({... layer3 })` (Task 5).
- Produces: no new exports. The orchestrator's in-memory cache stores `{ layer1, layer3 }` per URL.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('orchestrator', ...)` in `apps/extension/test/orchestrator.test.ts`:
```ts
  it('passes the server layer3 into verdicts (originality bar filled)', async () => {
    const layer3 = {
      layer3Version: 't', method: 'fingerprint' as const, evidence: 'enough' as const, coverage: 0.2,
      otherDomains: ['a.com', 'b.com'], originality: { score: 83, signals: [] }, computedAt: '2026-09-30T00:00:00.000Z',
    };
    const t = setup([{ [OK]: { status: 'ready', layer1: layer1(70), layer3 } }]);
    await t.orch.run([OK], t.emit);
    expect(t.emits.at(-1)![OK]!.dimensions.originality).toBe(83);
    expect((await t.orch.verdict(OK)).dimensions.originality).toBe(83);
  });
```

In `apps/extension/test/label.test.ts`, change the originality tooltip expectation to:
```ts
    expect(rows[1]!.querySelector<HTMLElement>('.na')!.title).toBe('Not enough comparisons yet');
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `NO_COLOR=1 pnpm test apps/extension/test/orchestrator apps/extension/test/label`
Expected: FAIL. `dimensions.originality` is `null`, and the tooltip still says "Needs deep scan (Pro)".

- [ ] **Step 3: Implement**

In `apps/extension/src/orchestrator.ts`:
- Change the type import to `import type { FlagVerdict, Layer1Result, Layer3Result, ListEntry, ScoreItem, Verdict } from '@gist/shared';`
- Replace `const cache = new Map<string, Layer1Result>();` with:
```ts
  const cache = new Map<string, { layer1: Layer1Result; layer3: Layer3Result | null }>();
```
- Replace the body of `verdict` with:
```ts
    const hit = cache.get(url);
    const layer1 = hit?.layer1 ?? (await d.fallback.cached(url));
    return combine({ layer1, layer3: hit?.layer3 ?? null, entry: d.match(url), override: await d.override(url), greenDot: await d.greenDot() });
```
- In `run`, replace `cache.set(u, r.layer1);` with `cache.set(u, { layer1: r.layer1, layer3: r.layer3 ?? null });`
- In `refresh`, replace `if (r?.status === 'ready') cache.set(url, r.layer1);` with `if (r?.status === 'ready') cache.set(url, { layer1: r.layer1, layer3: r.layer3 ?? null });`

In `apps/extension/src/render/label.ts`, replace `'Needs deep scan (Pro)'` with `'Not enough comparisons yet'`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `NO_COLOR=1 pnpm test apps/extension && pnpm --filter @gist/extension typecheck && pnpm --filter @gist/extension build`
Expected: PASS, and the build succeeds.

- [ ] **Step 5: Stage**

Run: `git add -A`. Ready to commit: `feat(extension): show originality from layer3`.

---

### Task 10: Eval: originality through an in-memory index

**Files:**
- Modify: `eval/lib.ts`, `eval/run-eval.ts`, `eval/test/lib.test.ts`, root `package.json` (add devDependency `"@gist/layer3": "workspace:*"`)

**Interfaces:**
- Consumes: `createMemoryIndex`, `fingerprint`, `originality` (Tasks 1–3); `buildContext`, `scoreContext`, `findPublishedAt` (Task 4); `combine` (Task 5).
- Produces: `rawGrade(layer1: Layer1Result, layer3?: Layer3Result | null): number`; `Scored` gains optional `originalityEvidence?: boolean` and `copyEvidence?: boolean`; `Metrics.originality = { withEvidence: number; dimmedByCopy: Record<Label, number> }`; the report line "Originality evidence: N of M rows; dimmed by copy evidence: slop a, thin b, ok c, solid d".

- [ ] **Step 1: Write the failing tests**

In `eval/test/lib.test.ts`, change the import to:
```ts
import { computeMetrics, formatReport, parseLabels, predictedLabel, rawGrade, type Scored } from '../lib';
```
and append inside `describe('eval lib', ...)`:
```ts
  it('reports originality evidence and copy-evidence dims per label (copy dims on ok/solid are false positives)', () => {
    const m = computeMetrics([
      { ...row('slop', 20), originalityEvidence: true, copyEvidence: true },
      { ...row('ok', 70), originalityEvidence: true, copyEvidence: true },
      { ...row('ok', 75), originalityEvidence: false },
      row('solid', 90),
    ]);
    expect(m.originality).toEqual({ withEvidence: 2, dimmedByCopy: { slop: 1, thin: 0, ok: 1, solid: 0 } });
    expect(formatReport(m)).toContain('Originality evidence: 2 of 4 rows; dimmed by copy evidence: slop 1, thin 0, ok 1, solid 0');
  });

  it('rawGrade includes originality when layer3 is given', () => {
    const layer1 = { layer1Version: 't', dimensions: { info: { score: 80, signals: [] }, human: { score: 80, signals: [] }, monetization: { score: 80, signals: [] } }, styleAdjust: 0, styleSignals: [], fetchedAt: 'x' };
    const layer3 = { layer3Version: 't', method: 'fingerprint' as const, evidence: 'enough' as const, coverage: 0.9, otherDomains: ['a.com', 'b.com'], originality: { score: 0, signals: [] }, computedAt: 'x' };
    expect(rawGrade(layer1)).toBe(80);
    expect(rawGrade(layer1, layer3)).toBe(56); // (80*30 + 0*25 + 80*20 + 80*10) / 85
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `NO_COLOR=1 pnpm test eval`
Expected: FAIL. `m.originality` is undefined, and `rawGrade(layer1, layer3)` returns 80.

- [ ] **Step 3: Implement**

In `eval/lib.ts`:
- Imports:
```ts
import { combine, verdictFor } from '@gist/combiner';
import type { Layer1Result, Layer3Result } from '@gist/shared';
```
- Replace the `Scored` type:
```ts
export type Scored = { id: string; url: string; label: Label; grade: number; originalityEvidence?: boolean; copyEvidence?: boolean };
```
- Add this field to the `Metrics` type:
```ts
  originality: { withEvidence: number; dimmedByCopy: Record<Label, number> };
```
- Replace `rawGrade`:
```ts
/** Layer-1(+3)-only grade with no floor, i.e. what rule B would act on. */
export function rawGrade(layer1: Layer1Result, layer3: Layer3Result | null = null): number {
  return combine({ layer1, layer3, entry: null, override: null, greenDot: false, lowConfidenceFloor: 'Slop' }).grade ?? 0;
}
```
- In `computeMetrics`, before the `return`, add:
```ts
  const dimmedByCopy = { slop: 0, thin: 0, ok: 0, solid: 0 } as Record<Label, number>;
  for (const r of rows) if (r.copyEvidence) dimmedByCopy[r.label]++;
  const originality = { withEvidence: rows.filter((r) => r.originalityEvidence).length, dimmedByCopy };
```
  and add `originality,` to the returned object.
- In `formatReport`, before `return lines.join('\n');`, add:
```ts
  const d = m.originality.dimmedByCopy;
  lines.push('', `Originality evidence: ${m.originality.withEvidence} of ${m.n} rows; dimmed by copy evidence: slop ${d.slop}, thin ${d.thin}, ok ${d.ok}, solid ${d.solid}`);
```

Replace `eval/run-eval.ts` with:
```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { combine } from '@gist/combiner';
import { buildContext, findPublishedAt, scoreContext } from '@gist/layer1';
import { createMemoryIndex, fingerprint, originality } from '@gist/layer3';
import { registrableDomain, type Layer1Result } from '@gist/shared';
import { computeMetrics, formatReport, parseLabels, rawGrade, type LabelRow, type Scored } from './lib';

const dir = fileURLToPath(new URL('.', import.meta.url));
const rows = parseLabels(readFileSync(join(dir, 'labels.jsonl'), 'utf8'));
if (rows.length === 0) {
  console.log('No labels yet. Add some with: pnpm eval:snapshot <slop|thin|ok|solid> <url>');
  process.exit(0);
}

// Pass 1: score and index every snapshot. Pass 2: originality against the complete index.
const now = new Date();
const index = createMemoryIndex();
const pages: { row: LabelRow; layer1: Layer1Result }[] = [];
for (const r of rows) {
  const path = join(dir, r.snapshot);
  if (!existsSync(path)) {
    console.warn(`missing snapshot for ${r.id}: ${r.snapshot}`);
    continue;
  }
  const ctx = buildContext(readFileSync(path, 'utf8'));
  index.add(r.url, registrableDomain(r.url) ?? new URL(r.url).hostname, findPublishedAt(ctx.document, now), fingerprint(ctx.mainText));
  pages.push({ row: r, layer1: scoreContext(ctx, now) });
}

const scored: Scored[] = pages.map(({ row, layer1 }) => {
  const m = index.matchesFor(row.url);
  const layer3 = m ? originality({ ...m, now }) : null;
  const v = combine({ layer1, layer3, entry: null, override: null, greenDot: false });
  return {
    id: row.id,
    url: row.url,
    label: row.label,
    grade: rawGrade(layer1, layer3),
    originalityEvidence: layer3?.evidence === 'enough',
    copyEvidence: v.reasons.some((x) => x.id === 'guard.copy_evidence'),
  };
});
console.log(formatReport(computeMetrics(scored)));
```

Add `"@gist/layer3": "workspace:*"` to the root `package.json` `devDependencies` (keep keys sorted) and run `pnpm install`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `NO_COLOR=1 pnpm test eval && pnpm exec tsc -p tsconfig.json && pnpm eval`
Expected: PASS, and `pnpm eval` prints "No labels yet…".

- [ ] **Step 5: Stage**

Run: `git add -A`. Ready to commit: `feat(eval): originality via in-memory index`.

---

### Task 11: Full verification and live smoke test

**Files:** none new.

- [ ] **Step 1: Whole-repo checks**

Run: `pnpm typecheck && NO_COLOR=1 pnpm test && pnpm --filter @gist/extension build`
Expected: no type errors, every test file passes (Docker running), and the build succeeds. Record the counts.

- [ ] **Step 2: Live smoke test on the dev server**

With the test Postgres on `:55432` (`docker start gist-pg`), restart the server so migration `002` runs:
```bash
export DATABASE_URL=postgres://postgres:gist@localhost:55432/postgres BOT_INFO_URL=https://example.invalid/bot
pnpm --filter @gist/server start   # run in the background
curl -s -X POST localhost:8787/score -H 'content-type: application/json' \
  -d '{"urls":["https://en.wikipedia.org/wiki/Cookie","https://sallysbakingaddiction.com/chewy-chocolate-chip-cookies/"]}'
# wait ~5 s, repeat the call
docker exec gist-pg psql -U postgres -c "select count(*) from fingerprints"
```
Expected:
- The second call returns `ready` items.
- `layer3` is present but usually `insufficient`, because the index is nearly empty.
- The fingerprints count is above 0.
- The server log shows only route labels and a `pruned … fingerprints` line at boot.

- [ ] **Step 3: Hand check in Chrome**

Ask the user to reload the extension in `chrome://extensions` and run a search. The Originality row should show "—" with the tooltip "Not enough comparisons yet", or a bar where evidence exists.

- [ ] **Step 4: Stage and report**

Run: `git add -A`. Report the test counts, the smoke-test output, and that everything is ready to commit.

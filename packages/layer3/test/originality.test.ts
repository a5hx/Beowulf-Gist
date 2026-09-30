import { describe, expect, it } from 'vitest';
import { originality, type FingerprintMatches } from '../src/originality';

const now = new Date('2026-09-30T00:00:00Z');
const d = (s: string) => new Date(s);
const own = (count = 100, publishedAt: Date | null = null) => ({ count, domain: 'me.com', publishedAt });
const m = (hash: number, domain: string, publishedAt: Date | null = null, thin = false) => ({ hash, domain, publishedAt, thin });
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

  it('a dated page only counts dated, not-newer matches (final review #1: undated copies cannot incriminate a dated original)', () => {
    const r = run({
      own: own(100, d('2024-01-10')),
      matches: [...range(50).map((h) => m(h, 'copier.com', d('2024-03-01'))), m(90, 'a.com', d('2023-01-01')), ...range(60).map((h) => m(h, 'scraper-a.com')), ...range(60).map((h) => m(h, 'scraper-b.com'))],
    });
    expect(r.coverage).toBeCloseTo(0.01);
    expect(r.otherDomains).toEqual(['a.com']);
    expect(r.evidence).toBe('insufficient');
  });

  it('an undated page counts any non-thin match', () => {
    const r = run({ own: own(100), matches: [m(1, 'a.com', null), m(2, 'b.com', d('2020-01-01'))] });
    expect(r.otherDomains.sort()).toEqual(['a.com', 'b.com']);
  });

  it('thin pages are never evidence against others (final review #3: backdated farms)', () => {
    const r = run({
      own: own(100, d('2024-01-10')),
      matches: [...range(80).map((h) => m(h, 'farm-a.com', d('2015-01-01'), true)), ...range(80).map((h) => m(h, 'farm-b.com', d('2015-01-01'), true))],
    });
    expect(r).toMatchObject({ evidence: 'insufficient', coverage: 0, otherDomains: [] });
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

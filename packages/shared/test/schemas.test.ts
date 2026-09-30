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

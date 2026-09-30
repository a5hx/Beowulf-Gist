import { describe, expect, it } from 'vitest';
import { scoreHtml } from '@gist/layer1';
import { blogRecipe, farmRecipe } from '@gist/layer1/fixtures';
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

  it('flags thin pages (Layer-1-only grade < 60) so they are never used as evidence (final review #1/#3)', () => {
    expect(analyzePage(blogRecipe(), at).index?.thin).toBe(false);
    expect(analyzePage(farmRecipe(), at).index?.thin).toBe(true);
  });

  it('reads rel=canonical, resolved against the page URL and normalized (final review #6)', () => {
    const html = '<html><head><link rel="canonical" href="/story?utm_source=x"></head><body><p>hi</p></body></html>';
    expect(analyzePage(html, at, {}, 'https://pub.co.uk/amp/story').index?.canonical).toBe('https://pub.co.uk/story');
    expect(analyzePage('<p>no canonical</p>', at, {}, 'https://a.com/').index?.canonical).toBeNull();
  });
});

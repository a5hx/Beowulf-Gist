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

import { describe, expect, it } from 'vitest';
import { scoreHtml } from '@gist/layer1';
import type { ListEntry } from '@gist/shared';
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
    const entry: ListEntry = { match: 'farm.com', matchLevel: 'domain', kind: 'farm', siteBehavior: 10, reasons: ['r'], source: 'seed' };
    expect(combine({ layer1, entry, override: null, greenDot: false }).action).toBe('collapse');
  });
});

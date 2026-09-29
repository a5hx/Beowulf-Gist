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

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

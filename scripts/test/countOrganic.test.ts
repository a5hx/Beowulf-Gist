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

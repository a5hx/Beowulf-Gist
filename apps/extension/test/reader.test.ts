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

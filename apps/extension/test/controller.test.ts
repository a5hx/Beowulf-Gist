// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Verdict } from '@gist/shared';
import type { PortIn, PortOut } from '../src/messages';
import { createSerpController } from '../src/serp/controller';
import { createExpandedSet } from '../src/serp/expanded';

const cfg = { version: 7, result: '#rso div.g', title: 'h3', exclude: [] };
const BASE = 'https://www.google.com/search?q=x';
const organic = (href: string) => `<div class="g"><a href="${href}"><h3>T</h3></a></div>`;
const tick = () => new Promise((r) => setTimeout(r, 20));
const v = (over: Partial<Verdict> = {}): Verdict => ({
  grade: 25, verdict: 'Filler', confidence: 'high', action: 'dim',
  dimensions: { info: null, originality: null, human: null, siteBehavior: 25, monetization: null },
  reasons: [], userOverride: null, ...over,
});

let ctl: ReturnType<typeof createSerpController>;
let posted: PortIn[];
let deliver: (m: PortOut) => void;
let dimmed: number[];
let noMatches: number[];

function start() {
  posted = []; dimmed = []; noMatches = [];
  ctl = createSerpController({
    root: document, selectors: cfg, base: BASE,
    port: { post: (m) => posted.push(m), onMessage: (cb) => { deliver = cb; } },
    flag: async () => v({ action: 'none', userOverride: 'fine' }),
    reportDimmed: (n) => dimmed.push(n),
    reportNoMatches: (ver) => noMatches.push(ver),
    expanded: createExpandedSet(null),
    debounceMs: 0,
  });
  ctl.start();
}

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => ctl?.stop());

describe('serp controller', () => {
  it('asks for scores once for all results on the page', () => {
    document.body.innerHTML = `<div id="rso">${organic('https://a.com/') + organic('https://b.com/')}</div>`;
    start();
    expect(posted).toEqual([{ type: 'score', urls: ['https://a.com/', 'https://b.com/'] }]);
  });

  it('applies verdicts and counts each dimmed URL once', () => {
    document.body.innerHTML = `<div id="rso">${organic('https://a.com/')}</div>`;
    start();
    deliver({ type: 'verdicts', verdicts: { 'https://a.com/': v() } });
    deliver({ type: 'verdicts', verdicts: { 'https://a.com/': v() } });
    expect(document.querySelector<HTMLElement>('.g')!.style.opacity).toBe('0.45');
    expect(dimmed).toEqual([1]);
  });

  it('applies verdicts to duplicate URLs, including ones that appear later', async () => {
    document.body.innerHTML = `<div id="rso">${organic('https://a.com/') + organic('https://a.com/')}</div>`;
    start();
    expect(posted).toEqual([{ type: 'score', urls: ['https://a.com/'] }]);
    deliver({ type: 'verdicts', verdicts: { 'https://a.com/': v() } });
    document.getElementById('rso')!.insertAdjacentHTML('beforeend', organic('https://a.com/'));
    await tick();
    const all = [...document.querySelectorAll<HTMLElement>('.g')];
    expect(all).toHaveLength(3);
    expect(all.every((el) => el.style.opacity === '0.45')).toBe(true);
    expect(posted).toHaveLength(1);
  });

  it('scores results added later (continuous scroll) without re-sending old ones', async () => {
    document.body.innerHTML = `<div id="rso">${organic('https://a.com/')}</div>`;
    start();
    document.getElementById('rso')!.insertAdjacentHTML('beforeend', organic('https://b.com/'));
    await tick();
    expect(posted).toEqual([{ type: 'score', urls: ['https://a.com/'] }, { type: 'score', urls: ['https://b.com/'] }]);
  });

  it('reports no_matches once when #rso has no readable results', async () => {
    document.body.innerHTML = '<div id="rso"><div class="unknown-layout"><a href="https://a.com/"><h3>T</h3></a></div></div>';
    start();
    document.getElementById('rso')!.insertAdjacentHTML('beforeend', '<div class="still-unknown"></div>');
    await tick();
    expect(noMatches).toEqual([7]);
    expect(posted).toEqual([]);
    expect(document.querySelector('span[data-gist-badge]')).toBeNull();
  });

  it('does not report no_matches on pages without #rso', () => {
    document.body.innerHTML = '<div id="other"></div>';
    start();
    expect(noMatches).toEqual([]);
  });

  it('re-renders a result after the user flags it', async () => {
    document.body.innerHTML = `<div id="rso">${organic('https://a.com/')}</div>`;
    start();
    deliver({ type: 'verdicts', verdicts: { 'https://a.com/': v() } });
    const shadow = document.querySelector('span[data-gist-badge]')!.shadowRoot!;
    [...shadow.querySelectorAll<HTMLButtonElement>('.flags button')].find((b) => b.textContent === 'Fine')!.click();
    await tick();
    expect(document.querySelector<HTMLElement>('.g')!.style.opacity).toBe('');
  });
});

// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { Verdict } from '@gist/shared';
import { applyVerdict } from '../src/render/apply';
import { createExpandedSet } from '../src/serp/expanded';
import type { SerpResult } from '../src/serp/reader';

export const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  grade: 50, verdict: 'Thin', confidence: 'low', action: 'tag',
  dimensions: { info: 50, originality: null, human: 50, siteBehavior: null, monetization: 50 },
  reasons: [{ id: 'info.early', label: 'Useful content starts after 900 words', effect: -15 }],
  userOverride: null,
  ...over,
});

let r: SerpResult;
const deps = () => ({ expanded: createExpandedSet(null), onFlag: () => {} });
const shadow = () => document.querySelector('span[data-gist-badge]')!.shadowRoot!;

beforeEach(() => {
  document.body.innerHTML = '<div id="rso"><div class="g"><a href="https://a.com/"><h3>A</h3></a></div></div>';
  const el = document.querySelector<HTMLElement>('.g')!;
  r = { id: '1', el, anchor: el.querySelector('a')!, url: 'https://a.com/' };
});

describe('applyVerdict', () => {
  it('tag: adds one badge host right after the anchor with a Thin tag', () => {
    applyVerdict(r, verdict(), deps());
    applyVerdict(r, verdict(), deps());
    expect(document.querySelectorAll('span[data-gist-badge]')).toHaveLength(1);
    expect(r.anchor.nextElementSibling?.matches('span[data-gist-badge]')).toBe(true);
    expect(shadow().querySelector('.tag')?.textContent).toBe('Thin');
    expect(r.el.style.opacity).toBe('');
  });

  it('dim: fades the result and tags it Filler', () => {
    applyVerdict(r, verdict({ verdict: 'Filler', action: 'dim', confidence: 'high', grade: 25 }), deps());
    expect(r.el.style.opacity).toBe('0.45');
    expect(shadow().querySelector('.tag')?.textContent).toBe('Filler');
  });

  it('collapse: hides the result behind a bar with the top negative reason; Show expands it', () => {
    const d = deps();
    applyVerdict(r, verdict({ verdict: 'Slop', action: 'collapse', confidence: 'high', grade: 5 }), d);
    expect(r.el.style.display).toBe('none');
    const bar = document.querySelector('div[data-gist-collapsed="1"]')!;
    expect(bar.nextElementSibling).toBe(r.el);
    expect(bar.shadowRoot!.textContent).toContain('Collapsed by Gist: Useful content starts after 900 words');
    bar.shadowRoot!.querySelector('button')!.click();
    expect(document.querySelector('div[data-gist-collapsed]')).toBeNull();
    expect(r.el.style.display).toBe('');
    expect(r.el.style.opacity).toBe('0.45');
    expect(d.expanded.has('https://a.com/')).toBe(true);
  });

  it('collapse on an already-expanded URL shows it dimmed with no bar', () => {
    const d = deps();
    d.expanded.add('https://a.com/');
    applyVerdict(r, verdict({ verdict: 'Slop', action: 'collapse' }), d);
    expect(document.querySelector('div[data-gist-collapsed]')).toBeNull();
    expect(r.el.style.opacity).toBe('0.45');
  });

  it('re-applying with action none clears dim and collapse (e.g. after "Fine")', () => {
    applyVerdict(r, verdict({ verdict: 'Slop', action: 'collapse' }), deps());
    applyVerdict(r, verdict({ verdict: 'Slop', action: 'none', userOverride: 'fine' }), deps());
    expect(r.el.style.display).toBe('');
    expect(r.el.style.opacity).toBe('');
    expect(document.querySelector('div[data-gist-collapsed]')).toBeNull();
    expect(shadow().querySelector('.tag')).toBeNull();
  });

  it('dot: shows a green dot for Solid when enabled', () => {
    applyVerdict(r, verdict({ verdict: 'Solid', action: 'dot', grade: 90 }), deps());
    expect(shadow().querySelector('.dot')).not.toBeNull();
  });
});

describe('createExpandedSet', () => {
  it('persists to the given storage and tolerates null', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    createExpandedSet(storage).add('https://a.com/');
    expect(createExpandedSet(storage).has('https://a.com/')).toBe(true);
    expect(createExpandedSet(null).has('x')).toBe(false);
  });
});

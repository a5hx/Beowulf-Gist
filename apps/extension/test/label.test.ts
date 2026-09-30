// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Verdict } from '@gist/shared';
import { renderBadge } from '../src/render/badge';
import { createExpandedSet } from '../src/serp/expanded';
import type { SerpResult } from '../src/serp/reader';

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  grade: 34, verdict: 'Thin', confidence: 'low', action: 'tag',
  dimensions: { info: 20, originality: null, human: 40, siteBehavior: null, monetization: 60 },
  reasons: Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, label: `reason ${i}`, effect: -(10 - i) })),
  userOverride: null,
  ...over,
});

let r: SerpResult;
let onFlag: ReturnType<typeof vi.fn>;
const render = (v: Verdict) => renderBadge(r, v, { expanded: createExpandedSet(null), onFlag });

beforeEach(() => {
  document.body.innerHTML = '<div class="g"><a href="https://a.com/"><h3>A</h3></a></div>';
  const el = document.querySelector<HTMLElement>('.g')!;
  r = { id: '1', el, anchor: el.querySelector('a')!, url: 'https://a.com/' };
  onFlag = vi.fn();
});
afterEach(() => vi.useRealTimers());

describe('nutrition label', () => {
  it('opens 300 ms after hovering the badge and closes on Escape', () => {
    vi.useFakeTimers();
    const s = render(verdict());
    const card = s.querySelector<HTMLElement>('.card')!;
    s.querySelector('.badge')!.dispatchEvent(new Event('mouseenter'));
    vi.advanceTimersByTime(299);
    expect(card.hidden).toBe(true);
    vi.advanceTimersByTime(1);
    expect(card.hidden).toBe(false);
    s.querySelector('.wrap')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(card.hidden).toBe(true);
  });

  it('opens immediately on keyboard focus and closes on mouseleave', () => {
    const s = render(verdict());
    s.querySelector<HTMLElement>('.badge')!.dispatchEvent(new Event('focus'));
    expect(s.querySelector<HTMLElement>('.card')!.hidden).toBe(false);
    s.querySelector('.wrap')!.dispatchEvent(new Event('mouseleave'));
    expect(s.querySelector<HTMLElement>('.card')!.hidden).toBe(true);
  });

  it('shows grade, verdict, low-confidence badge and five dimension rows', () => {
    const s = render(verdict());
    expect(s.querySelector('.grade')?.textContent).toBe('34');
    expect(s.querySelector('.verdict')?.textContent).toBe('Thin');
    expect(s.querySelector('.low')?.textContent).toBe('low confidence');
    const rows = [...s.querySelectorAll<HTMLElement>('.row')];
    expect(rows.map((x) => x.dataset.dim)).toEqual(['info', 'originality', 'human', 'siteBehavior', 'monetization']);
    expect(rows[1]!.querySelector<HTMLElement>('.na')!.title).toBe('Needs deep scan (Pro)');
    expect(rows[0]!.querySelector<HTMLElement>('.fill')!.style.width).toBe('20%');
  });

  it('says "Not scored yet" when there is no score', () => {
    const s = render(verdict({ grade: null, verdict: null, confidence: 'none', action: 'none' }));
    expect(s.querySelector('.head')?.textContent).toBe('Not scored yet');
    expect(s.querySelector('.grade')).toBeNull();
  });

  it('notes the user override', () => {
    expect(render(verdict({ userOverride: 'fine', action: 'none' })).querySelector('.note')?.textContent).toBe('You marked this as fine');
  });

  it('lists at most 8 reasons in the given order under Why?', () => {
    const items = [...render(verdict()).querySelectorAll('details li')].map((li) => li.textContent);
    expect(items).toEqual(Array.from({ length: 8 }, (_, i) => `reason ${i}`));
  });

  it('renders page-derived text as text, never as HTML', () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    const s = render(verdict({ reasons: [{ id: 'human.author', label: `Named author: ${evil}`, effect: 35 }] }));
    expect(s.querySelector('img')).toBeNull();
    expect(s.querySelector('details li')?.textContent).toBe(`Named author: ${evil}`);
  });

  it('Fine flags directly; Slop asks for a reason first', () => {
    const s = render(verdict());
    const buttons = () => [...s.querySelectorAll<HTMLButtonElement>('.flags button')];
    buttons().find((b) => b.textContent === 'Fine')!.click();
    expect(onFlag).toHaveBeenCalledWith('https://a.com/', 'fine');
    buttons().find((b) => b.textContent === 'Slop')!.click();
    expect(buttons().map((b) => b.dataset.reason)).toEqual(['filler', 'ai_images', 'fake_reviews', 'untested_roundup', 'other']);
    buttons().find((b) => b.dataset.reason === 'untested_roundup')!.click();
    expect(onFlag).toHaveBeenLastCalledWith('https://a.com/', 'slop', 'untested_roundup');
  });
});

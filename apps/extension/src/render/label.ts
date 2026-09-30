import type { DimensionKey, FlagReason, Verdict } from '@gist/shared';
import type { RenderDeps } from './badge';

const DIMS: [DimensionKey, string][] = [
  ['info', 'Information value'],
  ['originality', 'Originality'],
  ['human', 'Human presence'],
  ['siteBehavior', 'Site behavior'],
  ['monetization', 'Low ad pressure'],
];
const REASONS: [FlagReason, string][] = [
  ['filler', 'Filler'],
  ['ai_images', 'AI images'],
  ['fake_reviews', 'Fake reviews'],
  ['untested_roundup', 'Untested roundup'],
  ['other', 'Other'],
];

/** Every string that may come from a scored page is set with textContent (never innerHTML). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', undefined, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

export function buildCard(url: string, v: Verdict, deps: RenderDeps): HTMLElement {
  const card = el('div', 'card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Gist nutrition label');

  const head = el('div', 'head');
  if (v.confidence === 'none' || v.grade === null) {
    head.append(el('span', 'verdict', 'Not scored yet'));
  } else {
    head.append(el('span', 'grade', String(v.grade)), el('span', 'verdict', v.verdict ?? ''));
    if (v.confidence === 'low') head.append(el('span', 'low', 'low confidence'));
  }
  card.append(head);
  if (v.userOverride) card.append(el('div', 'note', `You marked this as ${v.userOverride}`));

  for (const [key, label] of DIMS) {
    const row = el('div', 'row');
    row.dataset.dim = key;
    row.append(el('span', 'name', label));
    const score = v.dimensions[key];
    if (score === null) {
      const na = el('span', 'na', '—');
      na.title = key === 'originality' ? 'Not enough comparisons yet' : 'Not available for this page';
      row.append(na, el('span'));
    } else {
      const bar = el('span', 'bar');
      const fill = el('span', 'fill');
      fill.style.width = `${score}%`;
      bar.append(fill);
      row.append(bar, el('span', 'num', String(score)));
    }
    card.append(row);
  }

  if (v.reasons.length > 0) {
    const details = el('details');
    const ul = el('ul');
    for (const r of v.reasons.slice(0, 8)) ul.append(el('li', undefined, r.label));
    details.append(el('summary', undefined, 'Why?'), ul);
    card.append(details);
  }

  const flags = el('div', 'flags');
  const showReasons = () =>
    flags.replaceChildren(
      el('span', undefined, 'What kind?'),
      ...REASONS.map(([reason, label]) => {
        const b = button(label, () => deps.onFlag(url, 'slop', reason));
        b.dataset.reason = reason;
        return b;
      }),
    );
  flags.append(button('Slop', showReasons), button('Fine', () => deps.onFlag(url, 'fine')));
  card.append(flags);
  return card;
}

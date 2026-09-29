import type { FlagReason, FlagVerdict, Verdict } from '@gist/shared';
import type { ExpandedSet } from '../serp/expanded';
import type { SerpResult } from '../serp/reader';
import { buildCard } from './label';
import { BADGE_CSS } from './styles';

export type RenderDeps = { expanded: ExpandedSet; onFlag: (url: string, verdict: FlagVerdict, reason?: FlagReason) => void };

function mountBadge(r: SerpResult): ShadowRoot {
  let host = r.el.querySelector<HTMLElement>('span[data-gist-badge]');
  if (!host) {
    host = document.createElement('span');
    host.dataset.gistBadge = r.id;
    host.attachShadow({ mode: 'open' });
    r.anchor.after(host);
  }
  return host.shadowRoot!;
}

function tagText(v: Verdict): string | null {
  if (v.action === 'tag') return v.verdict;
  if (v.action === 'dim' || v.action === 'collapse') return v.userOverride === 'slop' ? 'Flagged by you' : v.verdict;
  return null;
}

export function renderBadge(r: SerpResult, v: Verdict, deps: RenderDeps): ShadowRoot {
  const shadow = mountBadge(r);
  const style = document.createElement('style');
  style.textContent = BADGE_CSS;
  const wrap = document.createElement('span');
  wrap.className = 'wrap';

  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = `badge conf-${v.confidence}`;
  badge.textContent = 'G';
  badge.setAttribute('aria-label', 'Gist: why this result was rated');
  badge.setAttribute('aria-haspopup', 'dialog');
  wrap.append(badge);

  if (v.action === 'dot') {
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.title = 'Solid';
    wrap.append(dot);
  }
  const text = tagText(v);
  if (text) {
    const tag = document.createElement('span');
    tag.className = `tag tag-${v.action}`;
    tag.textContent = text;
    wrap.append(tag);
  }

  const card = buildCard(r.url, v, deps);
  card.hidden = true;
  wrap.append(card);
  shadow.replaceChildren(style, wrap);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    card.hidden = false;
  };
  const close = () => {
    clearTimeout(timer);
    card.hidden = true;
  };
  badge.addEventListener('mouseenter', () => {
    clearTimeout(timer);
    timer = setTimeout(open, 300);
  });
  badge.addEventListener('focus', open);
  wrap.addEventListener('mouseleave', close);
  wrap.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') close();
  });
  return shadow;
}

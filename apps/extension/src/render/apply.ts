import type { Verdict } from '@gist/shared';
import type { SerpResult } from '../serp/reader';
import { renderBadge, type RenderDeps } from './badge';
import { BAR_CSS } from './styles';

function collapse(r: SerpResult, v: Verdict, deps: RenderDeps): void {
  r.el.style.display = 'none';
  const bar = document.createElement('div');
  bar.dataset.gistCollapsed = r.id;
  const shadow = bar.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = BAR_CSS;
  const box = document.createElement('div');
  box.className = 'bar';
  const reason = document.createElement('span');
  reason.textContent = v.reasons.find((x) => x.effect < 0)?.label ?? 'Low-value page';
  const show = document.createElement('button');
  show.type = 'button';
  show.textContent = 'Show';
  show.addEventListener('click', () => {
    deps.expanded.add(r.url);
    bar.remove();
    r.el.style.display = '';
    r.el.style.opacity = '0.45';
  });
  box.append('Collapsed by Gist: ', reason, ' · ', show);
  shadow.append(style, box);
  r.el.before(bar);
}

/** Idempotent: resets previous rendering for this result, then applies the verdict's action. */
export function applyVerdict(r: SerpResult, v: Verdict, deps: RenderDeps): void {
  renderBadge(r, v, deps);
  r.el.style.opacity = '';
  r.el.style.display = '';
  document.querySelector(`div[data-gist-collapsed="${r.id}"]`)?.remove();
  if (v.action === 'dim' || (v.action === 'collapse' && deps.expanded.has(r.url))) r.el.style.opacity = '0.45';
  else if (v.action === 'collapse') collapse(r, v, deps);
}

import { normalizeUrl, type SelectorConfig } from '@gist/shared';

export type SerpResult = { id: string; el: HTMLElement; anchor: HTMLAnchorElement; url: string };

const GOOGLE_HOST = /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/i;
const GOOGLE_OTHER = /(^|\.)(googleusercontent|gstatic)\.com$/i;
let nextId = 0;

export function resolveResultHref(href: string, base: string): string | null {
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  if (GOOGLE_HOST.test(u.hostname) && u.pathname === '/url') {
    const target = u.searchParams.get('q') ?? u.searchParams.get('url');
    if (!target) return null;
    try {
      u = new URL(target);
    } catch {
      return null;
    }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (GOOGLE_HOST.test(u.hostname) || GOOGLE_OTHER.test(u.hostname)) return null;
  return normalizeUrl(u.toString());
}

export function readResults(root: ParentNode, cfg: SelectorConfig, base: string): SerpResult[] {
  const candidates = [...root.querySelectorAll<HTMLElement>(cfg.result)];
  const out: SerpResult[] = [];
  for (const el of candidates) {
    if (el.dataset.gistId) continue;
    if (candidates.some((other) => other !== el && el.contains(other))) continue; // keep innermost
    if (cfg.exclude.some((sel) => el.closest(sel))) continue;
    const anchor = el.querySelector(cfg.title)?.closest('a') as HTMLAnchorElement | null;
    if (!anchor) continue;
    const url = resolveResultHref(anchor.getAttribute('href') ?? '', base);
    if (!url) continue;
    el.dataset.gistId = String(++nextId);
    out.push({ id: el.dataset.gistId, el, anchor, url });
  }
  return out;
}

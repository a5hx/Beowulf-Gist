import type { DimensionResult, Signal } from '@gist/shared';
import type { PageContext } from './dom';
import { clamp, signal } from './signals';

const AD_SCRIPT =
  /googlesyndication|doubleclick\.net|adnxs\.com|amazon-adsystem|taboola|outbrain|mediavine|adthrive|ezoic|ezojs|raptive|pubmatic|criteo|adsafeprotected|moatads|revcontent|mgid\.com|propellerads/i;
const AD_TOKEN = /^(?:ads?|advert|advertisement|adsbygoogle|adslot|adunit|dfp)(?:[-_].*)?$/i;
const AFFILIATE =
  /[?&](?:tag|affid|aff_id|affiliate_id)=|amzn\.to\/|go\.skimresources\.com|shareasale\.com|awin1\.com|rstyle\.me|click\.linksynergy\.com|anrdoezrs\.net|dpbolvw\.net|jdoqocy\.com|tkqlhce\.com|kqzyfj\.com|hop\.clickbank\.net|sjv\.io|pntra\.com/i;
const POPUP = /optinmonster|omappapi|optmstr|sumo\.com|sumome|popupsmart|privy\.com|getsitecontrol|poptin|convertbox|hellobar|wisepops|justuno/i;

function isAdElement(el: Element): boolean {
  const tokens = [...(el.getAttribute('class') ?? '').split(/\s+/), el.getAttribute('id') ?? ''].filter(Boolean);
  return tokens.some((t) => AD_TOKEN.test(t));
}

function hasAdAncestor(el: Element): boolean {
  for (let p = el.parentElement; p; p = p.parentElement) if (isAdElement(p)) return true;
  return false;
}

export function scoreMonetization(ctx: PageContext): DimensionResult {
  const doc = ctx.document;
  const body: Element = doc.body ?? doc.documentElement;
  const scripts = [...doc.querySelectorAll('script')];
  const signals: Signal[] = [];

  const adScripts = scripts.filter((s) => AD_SCRIPT.test(s.getAttribute('src') ?? '')).length;
  const adElements = [...body.querySelectorAll('div,ins,aside,section,span')].filter((el) => isAdElement(el) && !hasAdAncestor(el)).length;
  const units = adElements + adScripts;
  const per1000 = (units / Math.max(ctx.mainWords, 200)) * 1000;
  const adPenalty = Math.min(60, Math.round(per1000 * 8));
  if (adPenalty > 0) {
    signals.push(signal('money.ads', `${units} ad slot${units === 1 ? '' : 's'} or ad scripts (${per1000.toFixed(1)} per 1,000 words)`, -adPenalty));
  }

  const links = [...ctx.main.querySelectorAll('a[href]')];
  const aff = links.filter((a) => AFFILIATE.test(a.getAttribute('href') ?? '') || /\bsponsored\b/i.test(a.getAttribute('rel') ?? '')).length;
  const affPenalty = Math.min(30, Math.round((links.length ? aff / links.length : 0) * 100));
  if (affPenalty > 0) signals.push(signal('money.affiliate', `${aff} of ${links.length} links are affiliate links`, -affPenalty));

  const popup = scripts.some((s) => POPUP.test(s.getAttribute('src') ?? '') || POPUP.test(s.textContent ?? ''));
  if (popup) signals.push(signal('money.popup', 'Popup or signup-wall script', -10));

  const score = clamp(100 - adPenalty - affPenalty - (popup ? 10 : 0));
  if (score === 100) signals.push(signal('money.clean', 'No ad slots, affiliate links or popups found', 0));
  return { score, signals };
}

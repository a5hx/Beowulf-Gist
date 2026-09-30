import type { FlagReason, FlagVerdict, SelectorConfig, Verdict } from '@gist/shared';
import type { PortIn, PortOut } from '../messages';
import { applyVerdict } from '../render/apply';
import type { RenderDeps } from '../render/badge';
import type { ExpandedSet } from './expanded';
import { readResults, type SerpResult } from './reader';

export type ControllerDeps = {
  root: Document;
  selectors: SelectorConfig;
  base: string;
  port: { post(msg: PortIn): void; onMessage(cb: (msg: PortOut) => void): void };
  flag(url: string, verdict: FlagVerdict, reason?: FlagReason): Promise<Verdict | null>;
  reportDimmed(n: number): void;
  reportNoMatches(configVersion: number): void;
  expanded: ExpandedSet;
  debounceMs?: number;
};

export function createSerpController(d: ControllerDeps) {
  const byUrl = new Map<string, SerpResult[]>();
  const last = new Map<string, Verdict>();
  const counted = new Set<string>();
  let reportedNoMatch = false;
  let observer: MutationObserver | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const renderDeps: RenderDeps = {
    expanded: d.expanded,
    onFlag: (url, verdict, reason) => {
      void d.flag(url, verdict, reason).then((v) => v && apply(url, v));
    },
  };

  function apply(url: string, v: Verdict) {
    last.set(url, v);
    for (const r of byUrl.get(url) ?? []) applyVerdict(r, v, renderDeps);
    if ((v.action === 'dim' || v.action === 'collapse') && v.userOverride === null && !counted.has(url)) {
      counted.add(url);
      d.reportDimmed(1);
    }
  }

  function scan() {
    const found = readResults(d.root, d.selectors, d.base);
    if (found.length === 0) {
      // Layout drift: results container exists but nothing matched. Do nothing to the page, report once.
      if (!reportedNoMatch && byUrl.size === 0 && d.root.querySelector(d.selectors.page ?? '#rso')) {
        reportedNoMatch = true;
        d.reportNoMatches(d.selectors.version);
      }
      return;
    }
    const fresh: string[] = [];
    for (const r of found) {
      const list = byUrl.get(r.url);
      if (list) list.push(r);
      else {
        byUrl.set(r.url, [r]);
        fresh.push(r.url);
      }
      const known = last.get(r.url);
      if (known) applyVerdict(r, known, renderDeps);
    }
    if (fresh.length > 0) d.port.post({ type: 'score', urls: fresh });
  }

  return {
    start() {
      d.port.onMessage((msg) => {
        if (msg.type === 'verdicts') for (const [url, v] of Object.entries(msg.verdicts)) apply(url, v);
      });
      scan();
      observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(scan, d.debounceMs ?? 200);
      });
      observer.observe(d.root.body, { childList: true, subtree: true });
    },
    stop() {
      observer?.disconnect();
      clearTimeout(timer);
    },
  };
}

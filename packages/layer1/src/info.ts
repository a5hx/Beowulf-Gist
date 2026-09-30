import type { DimensionResult } from '@gist/shared';
import { type PageContext, textOf, wordCount } from './dom';
import { lerpScore, signal } from './signals';

const UNITS =
  'mg|g|kg|lbs?|oz|ml|l|cups?|tbsp|tsp|°\\s?[cf]|degrees|mins?|minutes?|hours?|hrs?|seconds?|secs?|days?|weeks?|months?|years?' +
  '|%|px|ms|gb|mb|kb|tb|mm|cm|km|mph|v|w|kw|kwh|mah|hz|ghz|mhz|mbps|gbps|fps';

const PATTERNS: RegExp[] = [
  new RegExp(`\\b\\d+(?:[.,/]\\d+)?\\s?(?:${UNITS})(?![a-z])`, 'gi'),
  /[$€£₹]\s?\d[\d,]*(?:\.\d+)?/g,
  /\b(?:19|20)\d{2}\b/g,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b(?!\d)/gi,
  /\bv?\d+\.\d+\.\d+\b/g,
];

export function countSpecifics(text: string): number {
  return PATTERNS.reduce((n, re) => n + (text.match(re)?.length ?? 0), 0);
}

function isSubstantive(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'pre') return true;
  if (tag === 'li' && el.parentElement?.tagName.toLowerCase() === 'ol') return true;
  const t = textOf(el);
  const n = countSpecifics(t);
  return n >= 2 || (n >= 1 && wordCount(t) >= 12);
}

export function scoreInfo(ctx: PageContext): DimensionResult {
  const words = ctx.mainWords;
  const structural = ctx.main.querySelectorAll('ol > li').length + ctx.main.querySelectorAll('pre').length;
  const specifics = countSpecifics(ctx.mainText) + structural;
  const per100 = words ? (specifics / words) * 100 : 0;
  const specScore = lerpScore(per100, 0, 3);

  let before = 0;
  let found = false;
  for (const b of ctx.blocks) {
    if (isSubstantive(b)) {
      found = true;
      break;
    }
    before += wordCount(textOf(b));
  }
  if (!found) before = words;
  const earlyScore = lerpScore(before, 600, 50);

  const ratio = ctx.bodyWords ? words / ctx.bodyWords : 0;
  const ratioScore = lerpScore(ratio, 0.15, 0.6);

  let score = Math.round(0.5 * specScore + 0.3 * earlyScore + 0.2 * ratioScore);
  const signals = [
    signal('info.specifics', `${specifics} concrete details (numbers, units, dates, steps) in ${words} words`, (specScore - 50) * 0.5),
    signal(
      'info.early',
      !found ? 'No clearly useful passage found' : before <= 50 ? 'Gets to the useful part right away' : `Useful content starts after ${before} words`,
      (earlyScore - 50) * 0.3,
    ),
    signal('info.ratio', `Main content is ${Math.round(ratio * 100)}% of the page text`, (ratioScore - 50) * 0.2),
  ];
  if (words < 100 && score > 40) {
    signals.push(signal('info.short', `Very little text (${words} words)`, 40 - score));
    score = 40;
  }
  return { score, signals };
}

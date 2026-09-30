import type { Layer3Result, Signal } from '@gist/shared';
import { lerpScore } from './math';

export const LAYER3_VERSION = '1.0.0';
export const MIN_FINGERPRINTS = 40;
export const MIN_DOMAINS = 2;

export type FingerprintMatches = {
  own: { count: number; domain: string; publishedAt: Date | null };
  /** One row per (hash, matching page). Callers exclude boilerplate hashes; own-domain rows are ignored here too.
   *  `thin`: the matching page's own Layer 1 grade is below 60. */
  matches: { hash: number; domain: string; publishedAt: Date | null; thin: boolean }[];
};

/**
 * Which matches may count against a page (spec O6, tightened after final review):
 * - never the page's own domain;
 * - never a thin page: scrapers and farms (undated or backdated) must not be able to incriminate an original;
 * - for a dated page, only dated matches that are not newer: an undated copy cannot claim priority over a dated page.
 */
function counts(own: FingerprintMatches['own'], x: FingerprintMatches['matches'][number]): boolean {
  if (x.domain === own.domain || x.thin) return false;
  if (!own.publishedAt) return true;
  return !!x.publishedAt && x.publishedAt.getTime() <= own.publishedAt.getTime();
}

export function originality(input: FingerprintMatches & { now: Date }): Layer3Result {
  const { own } = input;
  const counting = input.matches.filter((x) => counts(own, x));
  const matchedHashes = new Set(counting.map((x) => x.hash));
  const coverage = own.count > 0 ? Math.min(1, matchedHashes.size / own.count) : 0;

  const perDomain = new Map<string, number>();
  for (const x of counting) perDomain.set(x.domain, (perDomain.get(x.domain) ?? 0) + 1);
  const ranked = [...perDomain.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const otherDomains = ranked.slice(0, 5).map(([domain]) => domain);

  const base = {
    layer3Version: LAYER3_VERSION,
    method: 'fingerprint' as const,
    coverage: Math.round(coverage * 1000) / 1000,
    otherDomains,
    computedAt: input.now.toISOString(),
  };
  if (own.count < MIN_FINGERPRINTS || perDomain.size < MIN_DOMAINS) return { ...base, evidence: 'insufficient', originality: null };

  const score = lerpScore(coverage, 0.7, 0.1);
  const signal: Signal =
    coverage >= 0.1
      ? {
          id: 'orig.copied',
          label: `${Math.round(coverage * 100)}% of this text also appears on ${perDomain.size} other sites: ${otherDomains.slice(0, 3).join(', ')}`,
          effect: score - 50,
        }
      : { id: 'orig.unique', label: 'Most of this text appears nowhere else Gist has seen', effect: 25 };
  return { ...base, evidence: 'enough', originality: { score, signals: [signal] } };
}

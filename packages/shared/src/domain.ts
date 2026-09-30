import { getDomain, getHostname } from 'tldts';
import type { ListEntry } from './types';

export function registrableDomain(url: string): string | null {
  return getDomain(url)?.toLowerCase() ?? null;
}

/**
 * Site identity for the originality index: like registrableDomain, but PSL *private* suffixes count as sites,
 * so alice.blogspot.com and bob.blogspot.com are different authors, not one domain.
 */
export function indexDomain(url: string): string | null {
  return getDomain(url, { allowPrivateDomains: true })?.toLowerCase() ?? null;
}

/** Builds an O(1) matcher. Host-level entries win over domain-level ones (spec §4.3). */
export function createMatcher(entries: readonly ListEntry[]): (url: string) => ListEntry | null {
  const hosts = new Map<string, ListEntry>();
  const domains = new Map<string, ListEntry>();
  for (const e of entries) (e.matchLevel === 'host' ? hosts : domains).set(e.match, e);
  return (url) => {
    const host = getHostname(url)?.toLowerCase();
    if (!host || !host.includes('.')) return null;
    const hostHit = hosts.get(host);
    if (hostHit) return hostHit;
    const domain = getDomain(url)?.toLowerCase();
    return (domain && domains.get(domain)) || null;
  };
}

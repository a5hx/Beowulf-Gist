import type { FingerprintMatches } from './originality';

export const BOILERPLATE_DOMAINS = 50;

type Page = { domain: string; publishedAt: Date | null; hashes: number[]; thin: boolean; canonical: string | null };

/** In-memory twin of the server's fingerprint table; same filters. Used by eval and tests. */
export function createMemoryIndex() {
  const pages = new Map<string, Page>();
  const postings = new Map<number, Set<string>>();

  const unlink = (url: string) => {
    for (const h of pages.get(url)?.hashes ?? []) postings.get(h)?.delete(url);
  };

  return {
    add(url: string, domain: string, publishedAt: Date | null, hashes: number[], meta: { thin?: boolean; canonical?: string | null } = {}): void {
      unlink(url);
      pages.set(url, { domain, publishedAt, hashes: [...new Set(hashes)], thin: meta.thin ?? false, canonical: meta.canonical ?? null });
      for (const h of pages.get(url)!.hashes) {
        if (!postings.has(h)) postings.set(h, new Set());
        postings.get(h)!.add(url);
      }
    },
    matchesFor(url: string): FingerprintMatches | null {
      const page = pages.get(url);
      if (!page) return null;
      const matches: FingerprintMatches['matches'] = [];
      for (const h of page.hashes) {
        const urls = [...(postings.get(h) ?? [])];
        if (new Set(urls.map((u) => pages.get(u)!.domain)).size > BOILERPLATE_DOMAINS) continue;
        for (const u of urls) {
          const other = pages.get(u)!;
          // rel=canonical: a declared copy (either direction, or both pointing at one canonical) is not copying.
          const declared = other.canonical === url || page.canonical === u || (page.canonical !== null && other.canonical === page.canonical);
          if (other.domain !== page.domain && !declared) matches.push({ hash: h, domain: other.domain, publishedAt: other.publishedAt, thin: other.thin });
        }
      }
      return { own: { count: page.hashes.length, domain: page.domain, publishedAt: page.publishedAt }, matches };
    },
  };
}

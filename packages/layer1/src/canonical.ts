import { normalizeUrl } from '@gist/shared';

/** The page's declared rel=canonical, resolved against its own URL and normalized; null when absent or invalid. */
export function findCanonical(document: Document, pageUrl?: string): string | null {
  const href = document.querySelector('link[rel="canonical"]')?.getAttribute('href')?.trim();
  if (!href) return null;
  try {
    return normalizeUrl(pageUrl ? new URL(href, pageUrl).toString() : href);
  } catch {
    return null;
  }
}

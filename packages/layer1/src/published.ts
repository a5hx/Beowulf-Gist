function findLdValue(node: unknown, key: string, depth = 0): string | null {
  if (depth > 6 || node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findLdValue(n, key, depth + 1);
      if (r) return r;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj[key] === 'string' && (obj[key] as string).trim()) return (obj[key] as string).trim();
  for (const v of Object.values(obj)) {
    const r = findLdValue(v, key, depth + 1);
    if (r) return r;
  }
  return null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
/** Nothing we score was published before the mid-90s web; earlier values are CMS defaults (epoch) or junk. */
const EARLIEST = Date.UTC(1995, 0, 1);

/**
 * Strict ISO-8601 only. `new Date(str)` happily turns "page 3" into 2001-03 and reads "10/01/2024" as US month-first,
 * which would corrupt the originality date rule. Values without an offset are taken as UTC, not server-local time.
 */
export function parseIsoDate(value: string): Date | null {
  const m = ISO_DATE.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', sec = '00', tz] = m;
  const offset = !tz || tz.toUpperCase() === 'Z' ? 'Z' : tz.includes(':') ? tz : `${tz.slice(0, 3)}:${tz.slice(3)}`;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${sec}${offset}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Publication date from the page's own metadata, or null. Future dates (beyond now + 1 day) are treated as bogus. */
export function findPublishedAt(document: Document, now: Date = new Date()): Date | null {
  let ld: string | null = null;
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      ld = findLdValue(JSON.parse(s.textContent ?? ''), 'datePublished');
    } catch {
      // malformed JSON-LD is common; ignore it
    }
    if (ld) break;
  }
  const candidates = [
    document.querySelector('meta[property="article:published_time"]')?.getAttribute('content'),
    ld,
    document.querySelector('time[datetime][itemprop="datePublished"]')?.getAttribute('datetime'),
    document.querySelector('meta[name="date"]')?.getAttribute('content'),
  ];
  for (const c of candidates) {
    if (!c) continue;
    const d = parseIsoDate(c);
    if (d && d.getTime() >= EARLIEST && d.getTime() <= now.getTime() + 86_400_000) return d;
  }
  return null;
}

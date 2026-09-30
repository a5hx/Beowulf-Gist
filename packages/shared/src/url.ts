const TRACKING = [/^utm_/i, /^gclid$/i, /^srsltid$/i, /^fbclid$/i, /^mc_cid$/i, /^mc_eid$/i];

/** Canonical form used as the cache key everywhere. Returns null for anything that is not http(s). */
export function normalizeUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // URL already lowercases scheme/host, punycodes IDN hosts and drops default ports.
  u.hash = '';
  u.username = '';
  u.password = '';
  const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING.some((re) => re.test(k)));
  kept.sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);
  return u.toString();
}

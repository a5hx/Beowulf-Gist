export type RateLimiter = { take(key: string, limit: number, windowMs: number): boolean };

/** Fixed-window, in-memory. Good enough for a single instance; revisit when scaling out. */
export function createRateLimiter(now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, { start: number; count: number; windowMs: number }>();
  return {
    take(key, limit, windowMs) {
      const t = now();
      if (windows.size > 50_000) for (const [k, w] of windows) if (t - w.start >= w.windowMs) windows.delete(k);
      const w = windows.get(key);
      if (!w || t - w.start >= windowMs) {
        windows.set(key, { start: t, count: 1, windowMs });
        return true;
      }
      if (w.count >= limit) return false;
      w.count++;
      return true;
    },
  };
}

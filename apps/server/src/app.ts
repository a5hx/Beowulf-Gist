import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deviceBodySchema, eventBodySchema, flagBodySchema, normalizeUrl, registrableDomain, scoreBodySchema } from '@gist/shared';
import type { RateLimiter } from './rateLimit';
import type { Repo } from './repo';
import type { ScoreService } from './scoreService';

export type AppDeps = {
  scores: ScoreService;
  repo: Pick<Repo, 'latestBundle' | 'registerDevice' | 'deviceExists' | 'countFlagsToday' | 'insertFlag' | 'recordEvent'>;
  limiter: RateLimiter;
  clientIp: (c: Context) => string;
  log: (line: string) => void;
};

type Env = { Variables: { route: string } };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

export function createApp(d: AppDeps) {
  const app = new Hono<Env>();

  // Log the route label, never the raw path or body: URLs must not reach logs (spec §8.3).
  app.use('*', async (c, next) => {
    const start = Date.now();
    c.set('route', 'unmatched');
    await next();
    d.log(`${c.req.method} ${c.get('route')} ${c.res.status} ${Date.now() - start}ms`);
  });
  app.use('*', bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ error: 'body too large' }, 413) }));

  const readJson = async (c: Context): Promise<unknown> => {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  };
  const limited = (c: Context, name: string, limit: number, windowMs: number) => !d.limiter.take(`${name}:${d.clientIp(c)}`, limit, windowMs);

  app.post('/score', async (c) => {
    c.set('route', '/score');
    if (limited(c, 'score', 60, MINUTE)) return c.json({ error: 'rate limited' }, 429);
    const body = scoreBodySchema.safeParse(await readJson(c));
    if (!body.success) return c.json({ error: 'invalid body' }, 400);
    return c.json({ results: await d.scores.lookup(body.data.urls) });
  });

  app.get('/lists', async (c) => {
    c.set('route', '/lists');
    const bundle = await d.repo.latestBundle();
    if (!bundle) return c.json({ error: 'no lists published' }, 503);
    const etag = `"${bundle.version}"`;
    c.header('ETag', etag);
    c.header('Cache-Control', 'public, max-age=3600');
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);
    return c.json(bundle);
  });

  app.post('/devices', async (c) => {
    c.set('route', '/devices');
    if (limited(c, 'devices', 10, HOUR)) return c.json({ error: 'rate limited' }, 429);
    const body = deviceBodySchema.safeParse(await readJson(c));
    if (!body.success) return c.json({ error: 'invalid body' }, 400);
    await d.repo.registerDevice(sha256Hex(body.data.key));
    return c.json({ ok: true }, 201);
  });

  app.post('/flags', async (c) => {
    c.set('route', '/flags');
    const m = /^Device ([0-9a-f]{64})$/.exec(c.req.header('authorization') ?? '');
    if (!m) return c.json({ error: 'unauthorized' }, 401);
    const keyHash = sha256Hex(m[1]!);
    if (!(await d.repo.deviceExists(keyHash))) return c.json({ error: 'unauthorized' }, 401);
    if ((await d.repo.countFlagsToday(keyHash)) >= 100) return c.json({ error: 'rate limited' }, 429);
    const body = flagBodySchema.safeParse(await readJson(c));
    if (!body.success) return c.json({ error: 'invalid body' }, 400);
    const urlNorm = normalizeUrl(body.data.url);
    if (!urlNorm) return c.json({ error: 'invalid url' }, 400);
    const domain = registrableDomain(urlNorm) ?? new URL(urlNorm).hostname;
    await d.repo.insertFlag({ keyHash, urlNorm, domain, verdict: body.data.verdict, reason: body.data.reason ?? null });
    return c.json({ ok: true }, 201);
  });

  app.post('/events', async (c) => {
    c.set('route', '/events');
    if (limited(c, 'events', 10, DAY)) return c.json({ error: 'rate limited' }, 429);
    const body = eventBodySchema.safeParse(await readJson(c));
    if (!body.success) return c.json({ error: 'invalid body' }, 400);
    await d.repo.recordEvent(body.data.configVersion, body.data.event);
    return c.body(null, 204);
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((err, c) => {
    d.log(`error ${c.get('route')} ${err.name}`);
    return c.json({ error: 'internal' }, 500);
  });
  return app;
}

import { describe, expect, it } from 'vitest';
import type { ListBundle } from '@gist/shared';
import { createApp, sha256Hex } from '../src/app';
import { createRateLimiter } from '../src/rateLimit';
import { createMemoryRepo } from './helpers/memoryRepo';

const KEY = 'a'.repeat(64);
const bundle: ListBundle = { version: 'abc123def456', domains: [], selectors: { version: 1, result: 'x', title: 'h3', exclude: [] } };

function setup(b: ListBundle | null = bundle) {
  const mem = createMemoryRepo(b);
  const logs: string[] = [];
  const scoreCalls: string[][] = [];
  const app = createApp({
    scores: { lookup: async (urls) => { scoreCalls.push(urls); return Object.fromEntries(urls.map((u) => [u, { status: 'pending' as const }])); } },
    repo: mem.repo,
    limiter: createRateLimiter(() => 0),
    clientIp: () => '203.0.113.9',
    log: (l) => logs.push(l),
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { app, mem, logs, scoreCalls, post };
}

describe('POST /score', () => {
  it('passes urls to the score service', async () => {
    const { post, scoreCalls } = setup();
    const res = await post('/score', { urls: ['https://a.com/'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: { 'https://a.com/': { status: 'pending' } } });
    expect(scoreCalls).toEqual([['https://a.com/']]);
  });
  it('rejects a query field, too many urls and bad JSON', async () => {
    const { post, app } = setup();
    expect((await post('/score', { urls: ['https://a.com/'], query: 'cookies' })).status).toBe(400);
    expect((await post('/score', { urls: Array(21).fill('https://a.com/') })).status).toBe(400);
    expect((await app.request('/score', { method: 'POST', body: '{nope' })).status).toBe(400);
  });
  it('rate limits at 60 per minute per IP', async () => {
    const { post } = setup();
    for (let i = 0; i < 60; i++) expect((await post('/score', { urls: ['https://a.com/'] })).status).toBe(200);
    expect((await post('/score', { urls: ['https://a.com/'] })).status).toBe(429);
  });
});

describe('GET /lists', () => {
  it('serves the bundle with an ETag and honours If-None-Match', async () => {
    const { app } = setup();
    const res = await app.request('/lists');
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"abc123def456"');
    expect(await res.json()).toEqual(bundle);
    expect((await app.request('/lists', { headers: { 'if-none-match': '"abc123def456"' } })).status).toBe(304);
  });
  it('503 when nothing is published', async () => {
    expect((await setup(null).app.request('/lists')).status).toBe(503);
  });
});

describe('devices and flags', () => {
  it('registers a device by hash only', async () => {
    const { post, mem } = setup();
    expect((await post('/devices', { key: 'short' })).status).toBe(400);
    expect((await post('/devices', { key: KEY })).status).toBe(201);
    expect([...mem.devices]).toEqual([sha256Hex(KEY)]);
  });
  it('requires a registered device key', async () => {
    const { post } = setup();
    expect((await post('/flags', { url: 'https://a.com', verdict: 'fine' })).status).toBe(401);
    expect((await post('/flags', { url: 'https://a.com', verdict: 'fine' }, { authorization: `Device ${KEY}` })).status).toBe(401);
  });
  it('stores normalized url and registrable domain', async () => {
    const { post, mem } = setup();
    await post('/devices', { key: KEY });
    const res = await post('/flags', { url: 'https://WWW.Farm.com/x?utm_source=g#top', verdict: 'slop', reason: 'filler' }, { authorization: `Device ${KEY}` });
    expect(res.status).toBe(201);
    expect(mem.flags).toEqual([{ keyHash: sha256Hex(KEY), urlNorm: 'https://www.farm.com/x', domain: 'farm.com', verdict: 'slop', reason: 'filler' }]);
  });
  it('validates reason rules and caps 100 flags per key per day', async () => {
    const { post } = setup();
    await post('/devices', { key: KEY });
    const auth = { authorization: `Device ${KEY}` };
    expect((await post('/flags', { url: 'https://a.com', verdict: 'slop' }, auth)).status).toBe(400);
    for (let i = 0; i < 100; i++) await post('/flags', { url: `https://a.com/${i}`, verdict: 'fine' }, auth);
    expect((await post('/flags', { url: 'https://a.com/x', verdict: 'fine' }, auth)).status).toBe(429);
  });
});

describe('POST /events', () => {
  it('records a no_matches event', async () => {
    const { post, mem } = setup();
    expect((await post('/events', { configVersion: 3, event: 'no_matches' })).status).toBe(204);
    expect(mem.events).toEqual([[3, 'no_matches']]);
    expect((await post('/events', { configVersion: 3, event: 'other' })).status).toBe(400);
  });
});

describe('privacy: logs', () => {
  it('never contain URLs, only route labels', async () => {
    const { post, app, logs } = setup();
    await post('/score', { urls: ['https://secret.example/private-page'] });
    await app.request('/nope/https://secret.example/x');
    expect(logs.join('\n')).not.toContain('secret.example');
    expect(logs).toEqual([expect.stringMatching(/^POST \/score 200 \d+ms$/), expect.stringMatching(/^GET unmatched 404 \d+ms$/)]);
  });
});

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSafeAgent, isPublicAddress } from '../src/fetcher/ssrf';
import { fetchPage, looksLikeChallenge, type FetchOptions } from '../src/fetcher/fetchPage';

let server: Server;
let base: string;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    const html = (s: number, body: string) => { res.writeHead(s, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
    switch (req.url) {
      case '/ok': return html(200, '<html><body><p>hello</p></body></html>');
      case '/ua': return html(200, String(req.headers['user-agent']));
      case '/redirect': res.writeHead(302, { location: '/ok' }); return res.end();
      case '/loop': res.writeHead(302, { location: '/loop' }); return res.end();
      case '/to-private': res.writeHead(302, { location: `http://127.0.0.2:${port}/ok` }); return res.end();
      case '/json': res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}');
      case '/big': return html(200, `<p>${'x'.repeat(5000)}</p>`);
      case '/cf': return html(503, '<html><head><title>Just a moment...</title></head><body>cf-chl</body></html>');
      case '/missing': return html(404, 'not found');
      case '/slow': return; // never responds
      default: return html(500, 'err');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});
afterAll(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

const localOnly = (ip: string) => ip === '127.0.0.1';
const opts = (over: Partial<FetchOptions> = {}): FetchOptions => ({
  dispatcher: createSafeAgent(localOnly),
  userAgent: 'GistBot/1.0 (+https://example.test/bot)',
  policy: localOnly,
  robotsAllowed: async () => true,
  timeoutMs: 1000,
  maxBytes: 1000,
  ...over,
});

describe('fetchPage', () => {
  it('fetches html and sends the GistBot user agent', async () => {
    expect(await fetchPage(`${base}/ok`, opts())).toMatchObject({ ok: true, finalUrl: `${base}/ok` });
    const ua = await fetchPage(`${base}/ua`, opts());
    expect(ua.ok && ua.html).toContain('GistBot/1.0');
  });
  it('follows redirects', async () => {
    expect(await fetchPage(`${base}/redirect`, opts())).toMatchObject({ ok: true, finalUrl: `${base}/ok` });
  });
  it('stops redirect loops', async () => {
    expect(await fetchPage(`${base}/loop`, opts())).toEqual({ ok: false, reason: 'network' });
  });
  it('re-checks policy after a redirect', async () => {
    expect(await fetchPage(`${base}/to-private`, opts())).toEqual({ ok: false, reason: 'ssrf' });
  });
  it('classifies non-html, too-large, challenge, http errors and timeouts', async () => {
    expect(await fetchPage(`${base}/json`, opts())).toEqual({ ok: false, reason: 'not_html' });
    expect(await fetchPage(`${base}/big`, opts())).toEqual({ ok: false, reason: 'too_large' });
    expect(await fetchPage(`${base}/cf`, opts())).toEqual({ ok: false, reason: 'blocked_challenge' });
    expect(await fetchPage(`${base}/missing`, opts())).toEqual({ ok: false, reason: 'http_404' });
    expect(await fetchPage(`${base}/slow`, opts({ timeoutMs: 200 }))).toEqual({ ok: false, reason: 'timeout' });
  });
  it('honours robots', async () => {
    expect(await fetchPage(`${base}/ok`, opts({ robotsAllowed: async () => false }))).toEqual({ ok: false, reason: 'robots' });
  });
});

describe('fetchPage with the production policy', () => {
  const prod = () => opts({ dispatcher: createSafeAgent(isPublicAddress), policy: isPublicAddress });
  it.each([
    ['loopback literal', () => `${base}/ok`],
    ['v6 loopback literal', () => `http://[::1]:${port}/ok`],
    ['cloud metadata', () => 'http://169.254.169.254/latest/meta-data/'],
    ['hostname resolving to loopback', () => `http://localhost:${port}/ok`],
    ['non-http scheme', () => 'file:///etc/passwd'],
  ])('blocks %s', async (_, url) => {
    expect(await fetchPage(url(), prod())).toEqual({ ok: false, reason: 'ssrf' });
  });
});

describe('looksLikeChallenge', () => {
  it('needs a challenge marker', () => {
    expect(looksLikeChallenge(403, 'Forbidden')).toBe(false);
    expect(looksLikeChallenge(403, '<script src="/cdn-cgi/challenge-platform/x"></script>')).toBe(true);
  });
  it('ignores long normal pages that merely mention captcha-like strings', () => {
    expect(looksLikeChallenge(200, `cf-chl ${'x'.repeat(30_000)}`)).toBe(false);
  });
});

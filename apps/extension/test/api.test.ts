import { describe, expect, it } from 'vitest';
import { ApiError, createApi } from '../src/api';

function fakeFetch(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return responses.shift()!;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('api', () => {
  it('score: body is exactly {urls}, no credentials, no identifying headers (spec §8.1)', async () => {
    const { fn, calls } = fakeFetch([Response.json({ results: { 'https://a.com/': { status: 'pending' } } })]);
    const res = await createApi('https://api.test', fn).score(['https://a.com/']);
    expect(res).toEqual({ 'https://a.com/': { status: 'pending' } });
    expect(calls[0]!.url).toBe('https://api.test/score');
    expect(calls[0]!.init.credentials).toBe('omit');
    expect(calls[0]!.init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ urls: ['https://a.com/'] });
  });

  it('lists: sends If-None-Match and handles 304', async () => {
    const { fn, calls } = fakeFetch([new Response(null, { status: 304 })]);
    expect(await createApi('https://api.test', fn).lists('"v1"')).toEqual({ status: 304 });
    expect(calls[0]!.init.headers).toEqual({ 'if-none-match': '"v1"' });
  });

  it('lists: returns bundle and etag on 200', async () => {
    const { fn } = fakeFetch([Response.json({ version: 'v2' }, { headers: { etag: '"v2"' } })]);
    expect(await createApi('https://api.test', fn).lists(null)).toEqual({ status: 200, bundle: { version: 'v2' }, etag: '"v2"' });
  });

  it('flag: authorizes with the device key', async () => {
    const { fn, calls } = fakeFetch([new Response(null, { status: 201 })]);
    await createApi('https://api.test', fn).flag('k'.repeat(64), { url: 'https://a.com/', verdict: 'fine' });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Device ${'k'.repeat(64)}`);
  });

  it('every request carries a timeout signal, so a hanging backend cannot stall the extension (spec §7)', async () => {
    const { fn, calls } = fakeFetch([
      Response.json({ results: {} }), new Response(null, { status: 304 }), new Response(null, { status: 201 }),
      new Response(null, { status: 201 }), new Response(null, { status: 204 }),
    ]);
    const api = createApi('https://api.test', fn);
    await api.score(['https://a.com/']);
    await api.lists(null);
    await api.registerDevice('k'.repeat(64));
    await api.flag('k'.repeat(64), { url: 'https://a.com/', verdict: 'fine' });
    await api.event({ configVersion: 1, event: 'no_matches' });
    expect(calls).toHaveLength(5);
    for (const c of calls) expect(c.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws ApiError with the status on non-2xx', async () => {
    const { fn } = fakeFetch([new Response(null, { status: 429 })]);
    await expect(createApi('https://api.test', fn).score(['https://a.com/'])).rejects.toMatchObject({ status: 429 });
    expect(new ApiError(500)).toBeInstanceOf(Error);
  });
});

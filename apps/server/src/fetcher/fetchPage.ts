import { request, type Dispatcher } from 'undici';
import type { FailReason } from '@gist/shared';
import { hostIsIpLiteral, type AddressPolicy } from './ssrf';

export type FetchOutcome = { ok: true; html: string; finalUrl: string } | { ok: false; reason: FailReason };
export type FetchOptions = {
  dispatcher: Dispatcher;
  userAgent: string;
  policy: AddressPolicy;
  robotsAllowed: (url: string) => Promise<boolean>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
};

const CHALLENGE =
  /cf-chl|challenge-platform|<title>\s*Just a moment\.\.\.\s*<\/title>|Attention Required! \| Cloudflare|captcha-delivery\.com|px-captcha|_Incapsula_Resource/i;

export function looksLikeChallenge(status: number, body: string): boolean {
  if (!CHALLENGE.test(body)) return false;
  return status === 403 || status === 429 || status === 503 || body.length < 20_000;
}

function classifyError(err: unknown): FailReason {
  const e = err as { name?: string; code?: string; cause?: { code?: string; name?: string } } | null;
  if (e?.code === 'ESSRF' || e?.cause?.code === 'ESSRF') return 'ssrf';
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || e?.cause?.name === 'TimeoutError' || /TIMEOUT|ABORTED/.test(e?.code ?? '')) {
    return 'timeout';
  }
  return 'network';
}

async function readCapped(body: Dispatcher.ResponseData['body'], max: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += (chunk as Buffer).length;
    if (size > max) {
      body.destroy();
      return null;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function blockedTarget(target: URL, policy: AddressPolicy): boolean {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return true;
  const literal = hostIsIpLiteral(target.hostname);
  return literal !== null && !policy(literal);
}

export async function fetchPage(url: string, o: FetchOptions): Promise<FetchOutcome> {
  const timeoutMs = o.timeoutMs ?? 8000;
  const maxBytes = o.maxBytes ?? 3 * 1024 * 1024;
  const maxRedirects = o.maxRedirects ?? 5;
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let target: URL;
    try {
      target = new URL(current);
    } catch {
      return { ok: false, reason: 'ssrf' };
    }
    if (blockedTarget(target, o.policy)) return { ok: false, reason: 'ssrf' };
    if (!(await o.robotsAllowed(target.toString()))) return { ok: false, reason: 'robots' };

    try {
      const res = await request(target, {
        method: 'GET',
        dispatcher: o.dispatcher,
        signal,
        headers: { 'user-agent': o.userAgent, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', 'accept-language': 'en' },
      });
      const status = res.statusCode;
      if (status >= 300 && status < 400) {
        await res.body.dump();
        const location = res.headers.location;
        if (!location) return { ok: false, reason: `http_${status}` };
        current = new URL(String(location), target).toString();
        continue;
      }
      if (status >= 400) {
        const body = (await readCapped(res.body, 64 * 1024)) ?? '';
        return { ok: false, reason: looksLikeChallenge(status, body) ? 'blocked_challenge' : `http_${status}` };
      }
      if (!/text\/html|application\/xhtml\+xml/i.test(String(res.headers['content-type'] ?? ''))) {
        await res.body.dump();
        return { ok: false, reason: 'not_html' };
      }
      const html = await readCapped(res.body, maxBytes);
      if (html === null) return { ok: false, reason: 'too_large' };
      if (looksLikeChallenge(status, html)) return { ok: false, reason: 'blocked_challenge' };
      return { ok: true, html, finalUrl: target.toString() };
    } catch (err) {
      return { ok: false, reason: classifyError(err) };
    }
  }
  return { ok: false, reason: 'network' }; // too many redirects
}

export async function fetchText(url: string, o: { dispatcher: Dispatcher; userAgent: string; policy: AddressPolicy }): Promise<string | null> {
  try {
    const target = new URL(url);
    if (blockedTarget(target, o.policy)) return null;
    const res = await request(target, { dispatcher: o.dispatcher, signal: AbortSignal.timeout(5000), headers: { 'user-agent': o.userAgent } });
    if (res.statusCode !== 200) {
      await res.body.dump();
      return null;
    }
    return await readCapped(res.body, 500 * 1024);
  } catch {
    return null;
  }
}

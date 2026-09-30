import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { combine } from '@gist/combiner';
import { analyzePage } from '../src/analyze';
import { createOriginalityService } from '../src/originalityService';
import { FetchQueue } from '../src/queue';
import { createRepo } from '../src/repo';
import { createScoreService } from '../src/scoreService';
import { startDb } from './helpers/db';
import { articleText, farm, original, wire } from './fixtures/originality';

const paragraphs = articleText(80, 11).split('\n');
const copied = (fraction: number) => paragraphs.slice(0, Math.round(paragraphs.length * fraction)).join('\n');
const PAGES: Record<string, string> = {
  'https://original-notes.com/survey': original(paragraphs.join('\n')),
  'https://farm-alpha.com/guide': farm(copied(0.75), 101, '2024-03-01T00:00:00Z'),
  'https://farm-beta.net/guide': farm(copied(0.75), 202, '2024-03-02T00:00:00Z'),
  'https://farm-gamma.org/guide': farm(copied(0.75), 303, '2024-03-03T00:00:00Z'),
  'https://wire-news.com/story': wire(copied(0.9), '2024-02-01T00:00:00Z'),
};
const urls = Object.keys(PAGES);
const now = () => new Date('2026-09-30T00:00:00Z');

let db: Awaited<ReturnType<typeof startDb>>;
beforeAll(async () => {
  db = await startDb();
});
afterAll(async () => db.stop());

describe('originality end to end', () => {
  it('dims copying farms, protects the dated original and the clean syndicated story', async () => {
    const repo = createRepo(db.sql);
    const queue = new FetchQueue({ global: 5, perDomain: 2 });
    const svc = createScoreService({
      repo,
      queue,
      fetchPage: async (url) => ({ ok: true, html: PAGES[url]!, finalUrl: url }),
      analyze: (html, at) => analyzePage(html, at),
      now,
      version: 'e2e',
      originality: createOriginalityService({ repo, now }),
    });

    await svc.lookup(urls);
    await queue.onIdle();
    const res = await svc.lookup(urls);

    const verdict = (u: string) => {
      const item = res[u]!;
      if (item.status !== 'ready') throw new Error(`${u} not ready`);
      return { v: combine({ layer1: item.layer1, layer3: item.layer3 ?? null, entry: null, override: null, greenDot: false }), l3: item.layer3 };
    };

    for (const f of urls.filter((u) => u.includes('farm'))) {
      const { v, l3 } = verdict(f);
      expect(l3?.evidence, f).toBe('enough');
      expect(l3!.coverage, f).toBeGreaterThanOrEqual(0.6);
      expect(v.confidence, f).toBe('high');
      expect(v.action, f).toBe('dim');
    }
    expect(['none', 'tag', 'dot']).toContain(verdict('https://original-notes.com/survey').v.action);
    const w = verdict('https://wire-news.com/story');
    expect(w.v.action).not.toBe('dim');
    expect(w.v.action).not.toBe('collapse');
  });

  it('a dated original with a weak Layer 1 is not dimmed by undated scrapers or a backdated farm (final review #1/#3)', async () => {
    const paras = articleText(80, 22).split('\n');
    const part = (f: number) => paras.slice(0, Math.round(paras.length * f)).join('\n');
    const pages: Record<string, string> = {
      // weak original: farm-style page (ads, generic author) but genuinely first, and dated
      'https://weak-original.com/post': farm(paras.join('\n'), 501, '2024-01-10T00:00:00Z'),
      'https://scraper-one.com/p': farm(part(0.8), 502, null),
      'https://scraper-two.net/p': farm(part(0.8), 503, null),
      'https://backdater.org/p': farm(part(0.8), 504, '2015-01-01T00:00:00Z'),
    };
    const list = Object.keys(pages);
    const repo = createRepo(db.sql);
    const queue = new FetchQueue({ global: 5, perDomain: 2 });
    const svc = createScoreService({
      repo, queue, now, version: 'e2e-2',
      fetchPage: async (url) => ({ ok: true, html: pages[url]!, finalUrl: url }),
      analyze: (html, at, pageUrl) => analyzePage(html, at, {}, pageUrl),
      originality: createOriginalityService({ repo, now }),
    });
    await svc.lookup(list);
    await queue.onIdle();
    const res = await svc.lookup(list);
    const item = res['https://weak-original.com/post']!;
    if (item.status !== 'ready') throw new Error('not ready');
    expect(item.layer3?.evidence).toBe('insufficient');
    const v = combine({ layer1: item.layer1, layer3: item.layer3 ?? null, entry: null, override: null, greenDot: false });
    expect(v.action).not.toBe('dim');
    expect(v.action).not.toBe('collapse');
  });
});

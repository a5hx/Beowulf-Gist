import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Layer1Result, ListBundle } from '@gist/shared';
import { migrate, type Sql } from '../src/db';
import { createRepo, type Repo } from '../src/repo';
import { startDb } from './helpers/db';

const layer1: Layer1Result = {
  layer1Version: '1.0.0',
  dimensions: { info: { score: 50, signals: [] }, human: { score: 50, signals: [] }, monetization: { score: 50, signals: [] } },
  styleAdjust: 0,
  styleSignals: [],
  fetchedAt: '2026-09-29T00:00:00.000Z',
};
const bundle = (version: string): ListBundle => ({ version, domains: [], selectors: { version: 1, result: 'x', title: 'h3', exclude: [] } });
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

let db: Awaited<ReturnType<typeof startDb>>;
let sql: Sql;
let repo: Repo;

beforeAll(async () => {
  db = await startDb();
  sql = db.sql;
  repo = createRepo(sql);
});
afterAll(async () => db.stop());
beforeEach(async () => {
  await sql`TRUNCATE page_scores, fetch_failures, flags, devices, list_versions, events`;
});

describe('repo', () => {
  it('migrate is idempotent', async () => {
    await expect(migrate(sql)).resolves.toBeUndefined();
  });

  it('returns fresh ready scores and round-trips JSON', async () => {
    await repo.putScore({ urlNorm: 'https://a.com/', layer1Version: '1.0.0', status: 'ready', result: layer1, failReason: null, fetchedAt: new Date() });
    const got = await repo.getScores(['https://a.com/', 'https://b.com/'], '1.0.0');
    expect(got.size).toBe(1);
    expect(got.get('https://a.com/')?.result).toEqual(layer1);
  });

  it('expires ready after 14 days and failed after 1 day', async () => {
    await repo.putScore({ urlNorm: 'https://old.com/', layer1Version: '1.0.0', status: 'ready', result: layer1, failReason: null, fetchedAt: daysAgo(15) });
    await repo.putScore({ urlNorm: 'https://fail.com/', layer1Version: '1.0.0', status: 'failed', result: null, failReason: 'timeout', fetchedAt: daysAgo(2) });
    await repo.putScore({ urlNorm: 'https://failnew.com/', layer1Version: '1.0.0', status: 'failed', result: null, failReason: 'http_403', fetchedAt: new Date() });
    const got = await repo.getScores(['https://old.com/', 'https://fail.com/', 'https://failnew.com/'], '1.0.0');
    expect([...got.keys()]).toEqual(['https://failnew.com/']);
    expect(got.get('https://failnew.com/')?.failReason).toBe('http_403');
  });

  it('ignores other layer1 versions and upserts', async () => {
    await repo.putScore({ urlNorm: 'https://a.com/', layer1Version: '0.9.0', status: 'ready', result: layer1, failReason: null, fetchedAt: new Date() });
    expect((await repo.getScores(['https://a.com/'], '1.0.0')).size).toBe(0);
    await repo.putScore({ urlNorm: 'https://a.com/', layer1Version: '1.0.0', status: 'failed', result: null, failReason: 'parse', fetchedAt: new Date() });
    await repo.putScore({ urlNorm: 'https://a.com/', layer1Version: '1.0.0', status: 'ready', result: layer1, failReason: null, fetchedAt: new Date() });
    expect((await repo.getScores(['https://a.com/'], '1.0.0')).get('https://a.com/')?.status).toBe('ready');
  });

  it('counts failures per day, domain and reason', async () => {
    await repo.recordFailure('a.com', 'timeout');
    await repo.recordFailure('a.com', 'timeout');
    await repo.recordFailure('a.com', 'blocked_challenge');
    const rows = await repo.failureSummary(7);
    expect(rows).toEqual(expect.arrayContaining([{ domain: 'a.com', reason: 'timeout', count: 2 }, { domain: 'a.com', reason: 'blocked_challenge', count: 1 }]));
  });

  it('devices and flags', async () => {
    expect(await repo.deviceExists('h1')).toBe(false);
    await repo.registerDevice('h1');
    await repo.registerDevice('h1'); // idempotent
    expect(await repo.deviceExists('h1')).toBe(true);
    await repo.insertFlag({ keyHash: 'h1', urlNorm: 'https://farm.com/x', domain: 'farm.com', verdict: 'slop', reason: 'filler' });
    await repo.insertFlag({ keyHash: 'h1', urlNorm: 'https://farm.com/y', domain: 'farm.com', verdict: 'fine', reason: null });
    expect(await repo.countFlagsToday('h1')).toBe(2);
    const [row] = await repo.flagSummary();
    expect(row).toMatchObject({ domain: 'farm.com', slop: 1, fine: 1, devices: 1, reasons: { filler: 1 } });
  });

  it('latestBundle returns the most recently published version, and republishing promotes it', async () => {
    expect(await repo.latestBundle()).toBeNull();
    await repo.publishBundle(bundle('v1'));
    await repo.publishBundle(bundle('v2'));
    expect((await repo.latestBundle())?.version).toBe('v2');
    await repo.publishBundle(bundle('v1'));
    expect((await repo.latestBundle())?.version).toBe('v1');
  });

  it('records events', async () => {
    await repo.recordEvent(1, 'no_matches');
    await repo.recordEvent(1, 'no_matches');
    const [row] = await sql`SELECT count FROM events WHERE config_version = 1`;
    expect(row?.count).toBe(2);
    await repo.recordEvent(2, 'no_matches');
    expect(await repo.eventSummary(7)).toEqual([
      { configVersion: 1, event: 'no_matches', count: 2 },
      { configVersion: 2, event: 'no_matches', count: 1 },
    ]);
  });
});

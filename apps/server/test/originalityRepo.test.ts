import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Layer3Result } from '@gist/shared';
import type { Sql } from '../src/db';
import { createRepo, MAX_FINGERPRINTS_PER_PAGE, type Repo } from '../src/repo';
import { startDb } from './helpers/db';

let db: Awaited<ReturnType<typeof startDb>>;
let sql: Sql;
let repo: Repo;
const t = new Date('2026-09-30T00:00:00Z');
const l3 = (coverage: number): Layer3Result => ({
  layer3Version: '1.0.0', method: 'fingerprint', evidence: 'enough', coverage, otherDomains: ['a.com', 'b.com'],
  originality: { score: 10, signals: [] }, computedAt: t.toISOString(),
});

beforeAll(async () => {
  db = await startDb();
  sql = db.sql;
  repo = createRepo(sql);
});
afterAll(async () => db.stop());
beforeEach(async () => {
  await sql`TRUNCATE fingerprints, originality_memo`;
});

describe('fingerprint repository', () => {
  it("replaceFingerprints replaces a URL's old rows", async () => {
    await repo.replaceFingerprints('https://me.com/a', 'me.com', null, [1, 2, 3], t);
    await repo.replaceFingerprints('https://me.com/a', 'me.com', null, [4], t);
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM fingerprints WHERE url_norm = 'https://me.com/a'`;
    expect(row!.n).toBe(1);
  });

  it('caps stored fingerprints per page at 5000', async () => {
    await repo.replaceFingerprints('https://big.com/', 'big.com', null, Array.from({ length: MAX_FINGERPRINTS_PER_PAGE + 10 }, (_, i) => i + 1), t);
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM fingerprints`;
    expect(row!.n).toBe(MAX_FINGERPRINTS_PER_PAGE);
  });

  it('round-trips large 53-bit hashes and dates, and excludes the own domain', async () => {
    const big = 2 ** 52 + 12345;
    await repo.replaceFingerprints('https://me.com/a', 'me.com', new Date('2024-01-10T00:00:00Z'), [big, 2], t);
    await repo.replaceFingerprints('https://me.com/b', 'me.com', null, [2], t);
    await repo.replaceFingerprints('https://other.com/x', 'other.com', new Date('2023-01-01T00:00:00Z'), [big], t);
    const m = await repo.fingerprintMatches('https://me.com/a');
    expect(m?.own).toEqual({ count: 2, domain: 'me.com', publishedAt: new Date('2024-01-10T00:00:00Z') });
    expect(m?.matches).toEqual([{ hash: big, domain: 'other.com', publishedAt: new Date('2023-01-01T00:00:00Z'), thin: false }]);
    expect(await repo.fingerprintMatches('https://unknown.com/')).toBeNull();
  });

  it('drops boilerplate hashes seen on more than 50 domains', async () => {
    await repo.replaceFingerprints('https://me.com/a', 'me.com', null, [7, 8], t);
    for (let i = 0; i < 51; i++) await repo.replaceFingerprints(`https://site${i}.com/`, `site${i}.com`, null, [7], t);
    await repo.replaceFingerprints('https://copy.com/', 'copy.com', null, [8], t);
    expect((await repo.fingerprintMatches('https://me.com/a'))?.matches.map((x) => x.hash)).toEqual([8]);
  });

  it('memo respects max age and version', async () => {
    await repo.putOriginalityMemo('https://a.com/', '1.0.0', l3(0.8), new Date());
    await repo.putOriginalityMemo('https://b.com/', '1.0.0', l3(0.5), new Date(Date.now() - 7 * 3600_000));
    const got = await repo.getOriginalityMemo(['https://a.com/', 'https://b.com/'], '1.0.0', 6 * 3600_000);
    expect([...got.keys()]).toEqual(['https://a.com/']);
    expect(got.get('https://a.com/')?.coverage).toBe(0.8);
    expect((await repo.getOriginalityMemo(['https://a.com/'], '2.0.0', 6 * 3600_000)).size).toBe(0);
  });

  it('prunes fingerprints and memos older than the cutoff', async () => {
    await repo.replaceFingerprints('https://old.com/', 'old.com', null, [1, 2], new Date(Date.now() - 91 * 86_400_000));
    await repo.replaceFingerprints('https://new.com/', 'new.com', null, [3], new Date());
    await repo.putOriginalityMemo('https://old.com/', '1.0.0', l3(0.1), new Date(Date.now() - 91 * 86_400_000));
    expect(await repo.pruneFingerprints(90)).toEqual({ fingerprints: 2, memos: 1 });
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM fingerprints`;
    expect(row!.n).toBe(1);
  });

  it("returns each matching page's thin flag (final review #1/#3)", async () => {
    await repo.replaceFingerprints('https://me.com/a', 'me.com', null, [5], t);
    await repo.replaceFingerprints('https://farm.com/x', 'farm.com', null, [5], t, { thin: true });
    expect((await repo.fingerprintMatches('https://me.com/a'))?.matches).toEqual([{ hash: 5, domain: 'farm.com', publishedAt: null, thin: true }]);
  });

  it('rel=canonical copies are not copying: either side pointing at the other, or a shared canonical (final review #6)', async () => {
    await repo.replaceFingerprints('https://pub.com/story', 'pub.com', null, [11, 12], t);
    await repo.replaceFingerprints('https://pub.co.uk/story', 'pub.co.uk', null, [11], t, { canonical: 'https://pub.com/story' });
    await repo.replaceFingerprints('https://pub.com.au/story', 'pub.com.au', null, [12], t, { canonical: 'https://pub.com/story' });
    await repo.replaceFingerprints('https://thief.com/x', 'thief.com', null, [11], t);
    expect((await repo.fingerprintMatches('https://pub.com/story'))?.matches.map((m) => m.domain)).toEqual(['thief.com']);
    expect((await repo.fingerprintMatches('https://pub.co.uk/story'))?.matches.map((m) => m.domain).sort()).toEqual(['thief.com']);
  });

  it('returns one row per distinct (hash, domain, date, thin), not per mirror URL (final review #8)', async () => {
    await repo.replaceFingerprints('https://me.com/a', 'me.com', null, [21], t);
    for (let i = 0; i < 3; i++) await repo.replaceFingerprints(`https://mirror.com/p${i}`, 'mirror.com', null, [21], t);
    expect((await repo.fingerprintMatches('https://me.com/a'))?.matches).toHaveLength(1);
  });
});

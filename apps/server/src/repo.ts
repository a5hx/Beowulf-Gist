import { BOILERPLATE_DOMAINS, type FingerprintMatches } from '@gist/layer3';
import type { FailReason, Layer1Result, Layer3Result, ListBundle } from '@gist/shared';
import type { Sql } from './db';

export type StoredScore = {
  urlNorm: string;
  layer1Version: string;
  status: 'ready' | 'failed';
  result: Layer1Result | null;
  failReason: FailReason | null;
  fetchedAt: Date;
};
export type NewFlag = { keyHash: string; urlNorm: string; domain: string; verdict: 'slop' | 'fine'; reason: string | null };
export type FlagSummaryRow = { domain: string; slop: number; fine: number; devices: number; reasons: Record<string, number> | null; firstSeen: Date; lastSeen: Date };
export type FailureSummaryRow = { domain: string; reason: string; count: number };
export type EventSummaryRow = { configVersion: number; event: string; count: number };

/** Bounds the table on huge pages (~1 fingerprint per 20 words → 5000 ≈ 100k words). */
export const MAX_FINGERPRINTS_PER_PAGE = 5000;

export interface Repo {
  getScores(urls: string[], layer1Version: string): Promise<Map<string, StoredScore>>;
  putScore(s: StoredScore): Promise<void>;
  recordFailure(domain: string, reason: FailReason): Promise<void>;
  registerDevice(keyHash: string): Promise<void>;
  deviceExists(keyHash: string): Promise<boolean>;
  countFlagsToday(keyHash: string): Promise<number>;
  insertFlag(f: NewFlag): Promise<void>;
  latestBundle(): Promise<ListBundle | null>;
  publishBundle(b: ListBundle): Promise<void>;
  recordEvent(configVersion: number, event: string): Promise<void>;
  flagSummary(): Promise<FlagSummaryRow[]>;
  failureSummary(days: number): Promise<FailureSummaryRow[]>;
  eventSummary(days: number): Promise<EventSummaryRow[]>;
  replaceFingerprints(urlNorm: string, domain: string, publishedAt: Date | null, hashes: number[], fetchedAt: Date, meta?: { thin?: boolean; canonical?: string | null }): Promise<void>;
  fingerprintMatches(urlNorm: string): Promise<FingerprintMatches | null>;
  getOriginalityMemo(urls: string[], version: string, maxAgeMs: number): Promise<Map<string, Layer3Result>>;
  putOriginalityMemo(urlNorm: string, version: string, result: Layer3Result, computedAt: Date): Promise<void>;
  pruneFingerprints(olderThanDays: number): Promise<{ fingerprints: number; memos: number }>;
}

type ScoreRow = { url_norm: string; layer1_version: string; status: 'ready' | 'failed'; result: Layer1Result | null; fail_reason: FailReason | null; fetched_at: Date };

export function createRepo(sql: Sql): Repo {
  return {
    async getScores(urls, layer1Version) {
      const out = new Map<string, StoredScore>();
      if (urls.length === 0) return out;
      const rows = await sql<ScoreRow[]>`
        SELECT url_norm, layer1_version, status, result, fail_reason, fetched_at
        FROM page_scores
        WHERE url_norm = ANY(${sql.array(urls)}::text[])
          AND layer1_version = ${layer1Version}
          AND ((status = 'ready'  AND fetched_at > now() - interval '14 days')
            OR (status = 'failed' AND fetched_at > now() - interval '1 day'))`;
      for (const r of rows) {
        out.set(r.url_norm, { urlNorm: r.url_norm, layer1Version: r.layer1_version, status: r.status, result: r.result, failReason: r.fail_reason, fetchedAt: r.fetched_at });
      }
      return out;
    },

    async putScore(s) {
      await sql`
        INSERT INTO page_scores (url_norm, layer1_version, status, result, fail_reason, fetched_at)
        VALUES (${s.urlNorm}, ${s.layer1Version}, ${s.status}, ${s.result ? sql.json(s.result as never) : null}, ${s.failReason}, ${s.fetchedAt})
        ON CONFLICT (url_norm, layer1_version) DO UPDATE
          SET status = EXCLUDED.status, result = EXCLUDED.result, fail_reason = EXCLUDED.fail_reason, fetched_at = EXCLUDED.fetched_at`;
    },

    async recordFailure(domain, reason) {
      await sql`
        INSERT INTO fetch_failures (day, domain, reason, count) VALUES (current_date, ${domain}, ${reason}, 1)
        ON CONFLICT (day, domain, reason) DO UPDATE SET count = fetch_failures.count + 1`;
    },

    async registerDevice(keyHash) {
      await sql`INSERT INTO devices (key_hash) VALUES (${keyHash}) ON CONFLICT DO NOTHING`;
    },

    async deviceExists(keyHash) {
      const rows = await sql`SELECT 1 FROM devices WHERE key_hash = ${keyHash}`;
      return rows.length > 0;
    },

    async countFlagsToday(keyHash) {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM flags WHERE key_hash = ${keyHash} AND created_at >= date_trunc('day', now())`;
      return row?.n ?? 0;
    },

    async insertFlag(f) {
      await sql`
        INSERT INTO flags (key_hash, url_norm, domain, verdict, reason)
        VALUES (${f.keyHash}, ${f.urlNorm}, ${f.domain}, ${f.verdict}, ${f.reason})`;
    },

    async latestBundle() {
      const [row] = await sql<{ bundle: ListBundle }[]>`SELECT bundle FROM list_versions ORDER BY published_at DESC LIMIT 1`;
      return row?.bundle ?? null;
    },

    async publishBundle(b) {
      await sql`
        INSERT INTO list_versions (version, bundle) VALUES (${b.version}, ${sql.json(b as never)})
        ON CONFLICT (version) DO UPDATE SET published_at = now()`;
    },

    async recordEvent(configVersion, event) {
      await sql`
        INSERT INTO events (day, config_version, event, count) VALUES (current_date, ${configVersion}, ${event}, 1)
        ON CONFLICT (day, config_version, event) DO UPDATE SET count = events.count + 1`;
    },

    async flagSummary() {
      const rows = await sql<{ domain: string; slop: number; fine: number; devices: number; reasons: Record<string, number> | null; first_seen: Date; last_seen: Date }[]>`
        SELECT f.domain,
               count(*) FILTER (WHERE f.verdict = 'slop')::int AS slop,
               count(*) FILTER (WHERE f.verdict = 'fine')::int AS fine,
               count(DISTINCT f.key_hash)::int AS devices,
               (SELECT jsonb_object_agg(r.reason, r.n)
                  FROM (SELECT reason, count(*)::int AS n FROM flags f2
                        WHERE f2.domain = f.domain AND reason IS NOT NULL GROUP BY reason) r) AS reasons,
               min(f.created_at) AS first_seen,
               max(f.created_at) AS last_seen
        FROM flags f
        GROUP BY f.domain
        ORDER BY slop DESC, devices DESC
        LIMIT 200`;
      return rows.map((r) => ({ domain: r.domain, slop: r.slop, fine: r.fine, devices: r.devices, reasons: r.reasons, firstSeen: r.first_seen, lastSeen: r.last_seen }));
    },

    async failureSummary(days) {
      return sql<FailureSummaryRow[]>`
        SELECT domain, reason, sum(count)::int AS count
        FROM fetch_failures
        WHERE day > current_date - ${days}::int
        GROUP BY domain, reason
        ORDER BY count DESC
        LIMIT 100`;
    },

    async eventSummary(days) {
      const rows = await sql<{ config_version: number; event: string; count: number }[]>`
        SELECT config_version, event, sum(count)::int AS count
        FROM events
        WHERE day > current_date - ${days}::int
        GROUP BY config_version, event
        ORDER BY config_version, event`;
      return rows.map((r) => ({ configVersion: r.config_version, event: r.event, count: r.count }));
    },

    async replaceFingerprints(urlNorm, domain, publishedAt, hashes, fetchedAt, meta = {}) {
      const rows = [...new Set(hashes)].slice(0, MAX_FINGERPRINTS_PER_PAGE).map((hash) => ({
        url_norm: urlNorm, hash: String(hash), domain, published_at: publishedAt, fetched_at: fetchedAt,
        thin: meta.thin ?? false, canonical: meta.canonical ?? null,
      }));
      await sql.begin(async (tx) => {
        await tx`DELETE FROM fingerprints WHERE url_norm = ${urlNorm}`;
        for (let i = 0; i < rows.length; i += 1000) {
          await tx`INSERT INTO fingerprints ${tx(rows.slice(i, i + 1000) as never, 'url_norm', 'hash', 'domain', 'published_at', 'fetched_at', 'thin', 'canonical')}`;
        }
      });
    },

    async fingerprintMatches(urlNorm) {
      const [own] = await sql<{ n: number; domain: string | null; published_at: Date | null; canonical: string | null }[]>`
        SELECT count(*)::int AS n, min(domain) AS domain, min(published_at) AS published_at, min(canonical) AS canonical
        FROM fingerprints WHERE url_norm = ${urlNorm}`;
      if (!own || own.n === 0 || !own.domain) return null;
      const rows = await sql<{ hash: string; domain: string; published_at: Date | null; thin: boolean }[]>`
        WITH own AS (SELECT hash FROM fingerprints WHERE url_norm = ${urlNorm}),
        boiler AS (
          SELECT f.hash FROM fingerprints f JOIN own USING (hash)
          GROUP BY f.hash HAVING count(DISTINCT f.domain) > ${BOILERPLATE_DOMAINS})
        SELECT DISTINCT f.hash::text AS hash, f.domain, f.published_at, f.thin
        FROM fingerprints f JOIN own USING (hash)
        WHERE f.domain <> ${own.domain} AND f.hash NOT IN (SELECT hash FROM boiler)
          -- rel=canonical: declared copies (either direction, or a shared canonical) are not copying
          AND f.canonical IS DISTINCT FROM ${urlNorm}
          AND (${own.canonical}::text IS NULL OR (f.url_norm <> ${own.canonical} AND f.canonical IS DISTINCT FROM ${own.canonical}))`;
      return {
        own: { count: own.n, domain: own.domain, publishedAt: own.published_at },
        matches: rows.map((r) => ({ hash: Number(r.hash), domain: r.domain, publishedAt: r.published_at, thin: r.thin })),
      };
    },

    async getOriginalityMemo(urls, version, maxAgeMs) {
      const out = new Map<string, Layer3Result>();
      if (urls.length === 0) return out;
      const rows = await sql<{ url_norm: string; result: Layer3Result }[]>`
        SELECT url_norm, result FROM originality_memo
        WHERE url_norm = ANY(${sql.array(urls)}::text[]) AND layer3_version = ${version}
          AND computed_at > now() - (${maxAgeMs} * interval '1 millisecond')`;
      for (const r of rows) out.set(r.url_norm, r.result);
      return out;
    },

    async putOriginalityMemo(urlNorm, version, result, computedAt) {
      await sql`
        INSERT INTO originality_memo (url_norm, layer3_version, result, computed_at)
        VALUES (${urlNorm}, ${version}, ${sql.json(result as never)}, ${computedAt})
        ON CONFLICT (url_norm, layer3_version) DO UPDATE SET result = EXCLUDED.result, computed_at = EXCLUDED.computed_at`;
    },

    async pruneFingerprints(olderThanDays) {
      const [f] = await sql<{ n: number }[]>`
        WITH d AS (DELETE FROM fingerprints WHERE fetched_at < now() - (${olderThanDays} * interval '1 day') RETURNING 1)
        SELECT count(*)::int AS n FROM d`;
      const [m] = await sql<{ n: number }[]>`
        WITH d AS (DELETE FROM originality_memo WHERE computed_at < now() - (${olderThanDays} * interval '1 day') RETURNING 1)
        SELECT count(*)::int AS n FROM d`;
      return { fingerprints: f?.n ?? 0, memos: m?.n ?? 0 };
    },
  };
}

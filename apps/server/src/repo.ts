import type { FailReason, Layer1Result, ListBundle } from '@gist/shared';
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
  };
}

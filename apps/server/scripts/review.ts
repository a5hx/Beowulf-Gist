import { connect } from '../src/db';
import { createRepo } from '../src/repo';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL');
const sql = connect(url);
const repo = createRepo(sql);

console.log('\n== Flags by domain (top 200) ==');
console.table(
  (await repo.flagSummary()).map((r) => ({
    domain: r.domain, slop: r.slop, fine: r.fine, devices: r.devices,
    reasons: Object.entries(r.reasons ?? {}).map(([k, v]) => `${k}:${v}`).join(' '),
    first: r.firstSeen.toISOString().slice(0, 10), last: r.lastSeen.toISOString().slice(0, 10),
  })),
);
console.log('\n== Fetch failures, last 7 days (top 100) ==');
console.table(await repo.failureSummary(7));
console.log('\n== Layout drift reports (no_matches), last 7 days, by selector config version ==');
console.table(await repo.eventSummary(7));
console.log('\nDecisions go into data/domains/*.json via PR, then `pnpm lists:build && pnpm lists:publish`.');
await sql.end();

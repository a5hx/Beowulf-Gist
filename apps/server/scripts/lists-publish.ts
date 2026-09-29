import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listBundleSchema } from '@gist/shared';
import { connect, migrate } from '../src/db';
import { createRepo } from '../src/repo';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL');
const path = fileURLToPath(new URL('../../../data/bundle.json', import.meta.url));
const bundle = listBundleSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
const sql = connect(url);
await migrate(sql);
await createRepo(sql).publishBundle(bundle);
console.log(`published ${bundle.version} (${bundle.domains.length} domains, selectors v${bundle.selectors.version})`);
await sql.end();

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle } from './lib/bundle';

const dataDir = fileURLToPath(new URL('../data/', import.meta.url));
const domainDir = join(dataDir, 'domains');
const files = readdirSync(domainDir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((name) => ({ name, data: JSON.parse(readFileSync(join(domainDir, name), 'utf8')) as unknown }));
const bundle = buildBundle(files, JSON.parse(readFileSync(join(dataDir, 'selectors.json'), 'utf8')));
writeFileSync(join(dataDir, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`);
console.log(`bundle ${bundle.version}: ${bundle.domains.length} domain entries, selectors v${bundle.selectors.version}`);

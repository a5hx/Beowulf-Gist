import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LABELS, type Label } from './lib';

const [label, url] = process.argv.slice(2);
if (!LABELS.includes(label as Label) || !url) {
  console.error('usage: pnpm eval:snapshot <slop|thin|ok|solid> <url>');
  process.exit(1);
}
const dir = fileURLToPath(new URL('.', import.meta.url));
const id = createHash('sha1').update(url).digest('hex').slice(0, 10);
const res = await fetch(url, { headers: { 'user-agent': 'GistBot/1.0 (eval snapshot)' }, redirect: 'follow' });
if (!res.ok) {
  console.error(`fetch failed: ${res.status}. Save the page manually to eval/snapshots/${id}.html and append the label line yourself.`);
  process.exit(1);
}
mkdirSync(join(dir, 'snapshots'), { recursive: true });
writeFileSync(join(dir, 'snapshots', `${id}.html`), await res.text());
appendFileSync(join(dir, 'labels.jsonl'), `${JSON.stringify({ id, url, label, snapshot: `snapshots/${id}.html`, labeledAt: new Date().toISOString().slice(0, 10) })}\n`);
console.log(`labeled ${id} as ${label}`);

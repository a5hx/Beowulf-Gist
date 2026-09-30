import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreHtml } from '@gist/layer1';
import { computeMetrics, formatReport, parseLabels, rawGrade, type Scored } from './lib';

const dir = fileURLToPath(new URL('.', import.meta.url));
const rows = parseLabels(readFileSync(join(dir, 'labels.jsonl'), 'utf8'));
if (rows.length === 0) {
  console.log('No labels yet. Add some with: pnpm eval:snapshot <slop|thin|ok|solid> <url>');
  process.exit(0);
}
const scored: Scored[] = [];
for (const r of rows) {
  const path = join(dir, r.snapshot);
  if (!existsSync(path)) {
    console.warn(`missing snapshot for ${r.id}: ${r.snapshot}`);
    continue;
  }
  scored.push({ id: r.id, url: r.url, label: r.label, grade: rawGrade(scoreHtml(readFileSync(path, 'utf8'), new Date())) });
}
console.log(formatReport(computeMetrics(scored)));

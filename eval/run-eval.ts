import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { combine, layer1Grade } from '@gist/combiner';
import { buildContext, findCanonical, findPublishedAt, scoreContext } from '@gist/layer1';
import { createMemoryIndex, fingerprint, originality } from '@gist/layer3';
import { indexDomain, type Layer1Result } from '@gist/shared';
import { computeMetrics, formatReport, parseLabels, rawGrade, type LabelRow, type Scored } from './lib';

const dir = fileURLToPath(new URL('.', import.meta.url));
const rows = parseLabels(readFileSync(join(dir, 'labels.jsonl'), 'utf8'));
if (rows.length === 0) {
  console.log('No labels yet. Add some with: pnpm eval:snapshot <slop|thin|ok|solid> <url>');
  process.exit(0);
}

// Pass 1: score and index every snapshot. Pass 2: originality against the complete index.
const now = new Date();
const index = createMemoryIndex();
const pages: { row: LabelRow; layer1: Layer1Result }[] = [];
for (const r of rows) {
  const path = join(dir, r.snapshot);
  if (!existsSync(path)) {
    console.warn(`missing snapshot for ${r.id}: ${r.snapshot}`);
    continue;
  }
  const ctx = buildContext(readFileSync(path, 'utf8'));
  const layer1 = scoreContext(ctx, now);
  // Same index rules as the server: thin pages are never evidence; rel=canonical copies are not copying.
  index.add(r.url, indexDomain(r.url) ?? new URL(r.url).hostname, findPublishedAt(ctx.document, now), fingerprint(ctx.mainText), {
    thin: layer1Grade(layer1) < 60,
    canonical: findCanonical(ctx.document, r.url),
  });
  pages.push({ row: r, layer1 });
}

const scored: Scored[] = pages.map(({ row, layer1 }) => {
  const m = index.matchesFor(row.url);
  const layer3 = m ? originality({ ...m, now }) : null;
  const v = combine({ layer1, layer3, entry: null, override: null, greenDot: false });
  return {
    id: row.id,
    url: row.url,
    label: row.label,
    grade: rawGrade(layer1, layer3),
    originalityEvidence: layer3?.evidence === 'enough',
    copyEvidence: v.reasons.some((x) => x.id === 'guard.copy_evidence'),
  };
});
console.log(formatReport(computeMetrics(scored)));

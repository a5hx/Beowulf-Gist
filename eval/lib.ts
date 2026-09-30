import { combine, verdictFor } from '@gist/combiner';
import type { Layer1Result } from '@gist/shared';

export type Label = 'slop' | 'thin' | 'ok' | 'solid';
export const LABELS: Label[] = ['slop', 'thin', 'ok', 'solid'];
export type LabelRow = { id: string; url: string; label: Label; snapshot: string; labeledAt: string };
export type Scored = { id: string; url: string; label: Label; grade: number };
export type Metrics = {
  n: number;
  perLabel: Record<Label, { precision: number | null; recall: number | null; support: number }>;
  /** Pages you labeled ok/solid that Layer 1 alone would dim or collapse under rule B (grade < 40). */
  wouldDim: { falsePositiveRate: number | null; falsePositives: Scored[] };
  /** Pages you labeled ok/solid that the current strict rule still marks with a Thin tag (grade < 60). */
  wouldTag: { rate: number | null; pages: Scored[] };
};

export function parseLabels(text: string): LabelRow[] {
  const rows: LabelRow[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const r = JSON.parse(line) as Partial<LabelRow>;
    const valid = r.id && r.url && r.snapshot && r.labeledAt && LABELS.includes(r.label as Label);
    if (!valid) throw new Error(`labels.jsonl line ${i + 1}: needs id, url, label (${LABELS.join('|')}), snapshot, labeledAt`);
    rows.push(r as LabelRow);
  });
  return rows;
}

/** Layer-1-only grade with no floor, i.e. what rule B would act on. */
export function rawGrade(layer1: Layer1Result): number {
  return combine({ layer1, entry: null, override: null, greenDot: false, lowConfidenceFloor: 'Slop' }).grade ?? 0;
}

export function predictedLabel(grade: number): Label {
  const v = verdictFor(grade);
  return v === 'Solid' ? 'solid' : v === 'OK' ? 'ok' : v === 'Thin' ? 'thin' : 'slop';
}

export function computeMetrics(rows: Scored[]): Metrics {
  const perLabel = {} as Metrics['perLabel'];
  for (const l of LABELS) {
    const predicted = rows.filter((r) => predictedLabel(r.grade) === l);
    const actual = rows.filter((r) => r.label === l);
    const tp = predicted.filter((r) => r.label === l).length;
    perLabel[l] = {
      precision: predicted.length ? tp / predicted.length : null,
      recall: actual.length ? tp / actual.length : null,
      support: actual.length,
    };
  }
  const good = rows.filter((r) => r.label === 'ok' || r.label === 'solid');
  const falsePositives = good.filter((r) => r.grade < 40);
  const tagged = good.filter((r) => r.grade < 60);
  return {
    n: rows.length,
    perLabel,
    wouldDim: { falsePositiveRate: good.length ? falsePositives.length / good.length : null, falsePositives },
    wouldTag: { rate: good.length ? tagged.length / good.length : null, pages: tagged },
  };
}

const pct = (x: number | null) => (x === null ? '  n/a' : `${(x * 100).toFixed(1).padStart(5)}%`);

export function formatReport(m: Metrics): string {
  const lines = [`Labeled results: ${m.n}`, '', 'label   precision  recall   support'];
  for (const l of LABELS) {
    const p = m.perLabel[l];
    lines.push(`${l.padEnd(7)} ${pct(p.precision)}    ${pct(p.recall)}   ${String(p.support).padStart(4)}`);
  }
  lines.push('', `False-positive rate if Layer 1 alone could dim (rule B): ${pct(m.wouldDim.falsePositiveRate)}`);
  for (const fp of m.wouldDim.falsePositives) lines.push(`  FP  grade ${fp.grade}  [${fp.label}]  ${fp.url}`);
  lines.push('', `Thin-tag rate on ok/solid pages (current rule): ${pct(m.wouldTag.rate)}`);
  for (const t of m.wouldTag.pages) lines.push(`  TAG grade ${t.grade}  [${t.label}]  ${t.url}`);
  return lines.join('\n');
}

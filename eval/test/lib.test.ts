import { describe, expect, it } from 'vitest';
import { computeMetrics, formatReport, parseLabels, predictedLabel, type Scored } from '../lib';

const row = (label: Scored['label'], grade: number, id = `${label}-${grade}`): Scored => ({ id, url: `https://x.test/${id}`, label, grade });

describe('eval lib', () => {
  it('maps grades to label bands (Filler and Slop both count as slop)', () => {
    expect([90, 70, 45, 30, 5].map(predictedLabel)).toEqual(['solid', 'ok', 'thin', 'slop', 'slop']);
  });

  it('computes per-label precision/recall and the rule-B false-positive rate', () => {
    const m = computeMetrics([row('slop', 10), row('slop', 50), row('ok', 65), row('ok', 30), row('solid', 85)]);
    expect(m.n).toBe(5);
    expect(m.perLabel.slop).toEqual({ precision: 0.5, recall: 0.5, support: 2 });
    expect(m.perLabel.thin).toEqual({ precision: 0, recall: null, support: 0 });
    expect(m.wouldDim.falsePositiveRate).toBeCloseTo(1 / 3);
    expect(m.wouldDim.falsePositives.map((r) => r.grade)).toEqual([30]);
    expect(formatReport(m)).toContain('False-positive rate');
  });

  it('parses JSONL, skipping blank lines, and reports bad lines by number', () => {
    const ok = parseLabels('{"id":"a","url":"https://a.test/","label":"ok","snapshot":"snapshots/a.html","labeledAt":"2026-09-29"}\n\n');
    expect(ok).toHaveLength(1);
    expect(() => parseLabels('{"id":"a"}\n{"id":"b","url":"u","label":"great","snapshot":"s","labeledAt":"d"}')).toThrow(/line 1/);
  });
});

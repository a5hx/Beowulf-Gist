import { describe, expect, it } from 'vitest';
import { computeMetrics, formatReport, parseLabels, predictedLabel, rawGrade, type Scored } from '../lib';

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

  it('reports the share of ok/solid pages that the current strict rule would still tag Thin (grade < 60)', () => {
    const m = computeMetrics([row('ok', 59), row('solid', 85), row('ok', 70), row('ok', 20), row('slop', 5)]);
    expect(m.wouldTag.rate).toBeCloseTo(2 / 4);
    expect(m.wouldTag.pages.map((r) => r.grade)).toEqual([59, 20]);
    expect(formatReport(m)).toContain('Thin-tag rate on ok/solid pages (current rule)');
  });

  it('parses JSONL, skipping blank lines, and reports bad lines by number', () => {
    const ok = parseLabels('{"id":"a","url":"https://a.test/","label":"ok","snapshot":"snapshots/a.html","labeledAt":"2026-09-29"}\n\n');
    expect(ok).toHaveLength(1);
    expect(() => parseLabels('{"id":"a"}\n{"id":"b","url":"u","label":"great","snapshot":"s","labeledAt":"d"}')).toThrow(/line 1/);
  });
  it('reports originality evidence and copy-evidence dims per label (copy dims on ok/solid are false positives)', () => {
    const m = computeMetrics([
      { ...row('slop', 20), originalityEvidence: true, copyEvidence: true },
      { ...row('ok', 70), originalityEvidence: true, copyEvidence: true },
      { ...row('ok', 75), originalityEvidence: false },
      row('solid', 90),
    ]);
    expect(m.originality).toEqual({ withEvidence: 2, dimmedByCopy: { slop: 1, thin: 0, ok: 1, solid: 0 } });
    expect(formatReport(m)).toContain('Originality evidence: 2 of 4 rows; dimmed by copy evidence: slop 1, thin 0, ok 1, solid 0');
  });

  it('rawGrade includes originality when layer3 is given', () => {
    const layer1 = { layer1Version: 't', dimensions: { info: { score: 80, signals: [] }, human: { score: 80, signals: [] }, monetization: { score: 80, signals: [] } }, styleAdjust: 0, styleSignals: [], fetchedAt: 'x' };
    const layer3 = { layer3Version: 't', method: 'fingerprint' as const, evidence: 'enough' as const, coverage: 0.9, otherDomains: ['a.com', 'b.com'], originality: { score: 0, signals: [] }, computedAt: 'x' };
    expect(rawGrade(layer1)).toBe(80);
    expect(rawGrade(layer1, layer3)).toBe(80); // good page + shared text, no copy evidence: no penalty (final review #5)
    const thin = { ...layer1, dimensions: { info: { score: 50, signals: [] }, human: { score: 50, signals: [] }, monetization: { score: 50, signals: [] } } };
    expect(rawGrade(thin, layer3)).toBe(35); // copy evidence: (50*30 + 0*25 + 50*20 + 50*10) / 85
  });
});

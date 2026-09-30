import { describe, expect, it } from 'vitest';
import type { Layer1Result, Layer3Result, ListEntry } from '@gist/shared';
import { combine, layer1Grade } from '../src/index';

const l1 = (s: number): Layer1Result => ({
  layer1Version: 't',
  dimensions: { info: { score: s, signals: [] }, human: { score: s, signals: [] }, monetization: { score: s, signals: [] } },
  styleAdjust: 0, styleSignals: [], fetchedAt: '2026-09-30T00:00:00.000Z',
});
const l3 = (coverage: number, evidence: 'enough' | 'insufficient' = 'enough', domains = ['a.com', 'b.com']): Layer3Result => ({
  layer3Version: 't', method: 'fingerprint', evidence, coverage, otherDomains: domains, computedAt: '2026-09-30T00:00:00.000Z',
  originality: evidence === 'enough'
    ? { score: Math.max(0, Math.min(100, Math.round(((coverage - 0.7) / -0.6) * 100))), signals: [{ id: 'orig.copied', label: 'copied', effect: -40 }] }
    : null,
});
const base = { entry: null, override: null, greenDot: false } as const;
const human: ListEntry = { match: 'h.com', matchLevel: 'domain', kind: 'human', siteBehavior: 90, reasons: ['Verified'], source: 'seed' };
const farm: ListEntry = { match: 'f.com', matchLevel: 'domain', kind: 'farm', siteBehavior: 5, reasons: ['Farm'], source: 'seed' };

describe('combine with layer3', () => {
  it('layer1Grade is the Layer-1-only weighted grade', () => {
    expect(layer1Grade(l1(30))).toBe(30);
  });

  it('insufficient evidence leaves originality null and changes nothing', () => {
    const v = combine({ ...base, layer1: l1(30), layer3: l3(0.9, 'insufficient') });
    expect(v.dimensions.originality).toBeNull();
    expect(v).toMatchObject({ confidence: 'low', verdict: 'Thin' });
  });

  it('copied + thin Layer 1 is high confidence and dims (Filler)', () => {
    // (30*30 + 0*25 + 30*20 + 30*10) / 85 = 21
    const v = combine({ ...base, layer1: l1(30), layer3: l3(0.8) });
    expect(v).toMatchObject({ grade: 21, verdict: 'Filler', confidence: 'high', action: 'dim' });
    expect(v.dimensions.originality).toBe(0);
    expect(v.reasons.some((r) => r.id === 'guard.copy_evidence')).toBe(true);
  });

  it('copy evidence alone never collapses: Slop is capped at Filler', () => {
    expect(combine({ ...base, layer1: l1(10), layer3: l3(0.9) })).toMatchObject({ verdict: 'Filler', action: 'dim' });
  });

  it('a farm list entry can still collapse', () => {
    expect(combine({ ...base, entry: farm, layer1: l1(10), layer3: l3(0.9) }).action).toBe('collapse');
  });

  it('good Layer 1 (syndication) is not copy evidence: only a low originality bar', () => {
    const v = combine({ ...base, layer1: l1(80), layer3: l3(0.9) });
    expect(v.confidence).toBe('low');
    expect(v.action).not.toBe('dim');
    expect(v.reasons.some((r) => r.id === 'guard.copy_evidence')).toBe(false);
  });

  it('coverage below 0.6 or fewer than 2 domains is not copy evidence', () => {
    expect(combine({ ...base, layer1: l1(30), layer3: l3(0.59) }).confidence).toBe('low');
    expect(combine({ ...base, layer1: l1(30), layer3: l3(0.9, 'enough', ['a.com']) }).confidence).toBe('low');
  });

  it('copy evidence overrides the verified-human floor (spec guardrail)', () => {
    expect(combine({ ...base, entry: human, layer1: l1(20) }).grade).toBe(50);
    const v = combine({ ...base, entry: human, layer1: l1(20), layer3: l3(0.9) });
    expect(v.grade).toBeLessThan(50);
    expect(v.action).toBe('dim');
  });

  it('a verified-human page is never collapsed by copy evidence (final review #4)', () => {
    const v = combine({ ...base, entry: human, layer1: l1(0), layer3: l3(0.95) });
    expect(v.verdict).toBe('Filler');
    expect(v.action).toBe('dim');
  });

  it('without copy evidence, originality cannot lower the verdict band (final review #5)', () => {
    // syndicated / cross-posted page: strong Layer 1, heavily shared text, no copy evidence
    const v = combine({ ...base, layer1: l1(80), layer3: l3(0.9) });
    expect(v).toMatchObject({ grade: 80, verdict: 'Solid' });
    expect(v.dimensions.originality).toBe(0); // the bar still shows the overlap honestly
  });

  it('unique text can still raise the grade without copy evidence', () => {
    const unique = { ...l3(0.05), originality: { score: 100, signals: [] } };
    expect(combine({ ...base, layer1: l1(50), layer3: unique }).grade).toBeGreaterThan(50);
  });
});

import { describe, expect, it } from 'vitest';
import type { Layer1Result, ListEntry } from '@gist/shared';
import { combine, verdictFor } from '../src/index';

const l1 = (info: number, human: number, money: number, styleAdjust = 0): Layer1Result => ({
  layer1Version: 'test',
  dimensions: {
    info: { score: info, signals: [{ id: 'info.x', label: 'info signal', effect: -3 }] },
    human: { score: human, signals: [{ id: 'human.x', label: 'human signal', effect: 20 }] },
    monetization: { score: money, signals: [] },
  },
  styleAdjust,
  styleSignals: [],
  fetchedAt: '2026-09-29T00:00:00.000Z',
});
const farm = (siteBehavior: number): ListEntry => ({ match: 'farm.com', matchLevel: 'domain', kind: 'farm', siteBehavior, reasons: ['Mass-produced recipes'], source: 'seed' });
const human = (siteBehavior: number): ListEntry => ({ match: 'cook.com', matchLevel: 'domain', kind: 'human', siteBehavior, reasons: ['Independent recipe developer'], source: 'seed' });
const base = { layer1: null, entry: null, override: null, greenDot: false } as const;

describe('verdictFor', () => {
  it('uses the spec bands', () => {
    expect([100, 80, 79, 60, 59, 40, 39, 20, 19, 0].map(verdictFor)).toEqual(
      ['Solid', 'Solid', 'OK', 'OK', 'Thin', 'Thin', 'Filler', 'Filler', 'Slop', 'Slop'],
    );
  });
});

describe('combine', () => {
  it('returns confidence none with nothing scored', () => {
    const v = combine(base);
    expect(v).toMatchObject({ grade: null, verdict: null, confidence: 'none', action: 'none' });
    expect(v.dimensions.originality).toBeNull();
  });

  it('rescales weights over scored dimensions only', () => {
    // (100*30 + 0*20 + 100*10) / 60 = 66.67
    const v = combine({ ...base, layer1: l1(100, 0, 100) });
    expect(v.grade).toBe(67);
    expect(v.verdict).toBe('OK');
    expect(v.confidence).toBe('low');
  });

  it('applies styleAdjust and clamps to 0..100', () => {
    expect(combine({ ...base, layer1: l1(0, 0, 0, -5) }).grade).toBe(0);
    expect(combine({ ...base, layer1: l1(100, 100, 100, -5) }).grade).toBe(95);
  });

  it('strict rule: Layer 1 alone never goes below Thin, but keeps the real grade', () => {
    const v = combine({ ...base, layer1: l1(10, 10, 10) });
    expect(v).toMatchObject({ grade: 10, verdict: 'Thin', confidence: 'low', action: 'tag' });
  });

  it('lowConfidenceFloor option lets eval simulate rule B', () => {
    expect(combine({ ...base, layer1: l1(10, 10, 10), lowConfidenceFloor: 'Filler' })).toMatchObject({ verdict: 'Filler', action: 'dim' });
    expect(combine({ ...base, layer1: l1(10, 10, 10), lowConfidenceFloor: 'Slop' }).verdict).toBe('Slop');
  });

  it('farm entry caps at 25 and is high confidence', () => {
    // (90*30 + 90*20 + 10*15 + 90*10) / 75 = 74 -> capped 25
    const v = combine({ ...base, layer1: l1(90, 90, 90), entry: farm(10) });
    expect(v).toMatchObject({ grade: 25, verdict: 'Filler', confidence: 'high', action: 'dim' });
    expect(v.reasons.some((r) => r.id === 'guard.farm_cap')).toBe(true);
  });

  it('farm entry alone (before Layer 1 arrives) can collapse', () => {
    expect(combine({ ...base, entry: farm(5) })).toMatchObject({ grade: 5, verdict: 'Slop', confidence: 'high', action: 'collapse' });
  });

  it('human entry lifts to at least 50', () => {
    // (10*30 + 10*20 + 90*15 + 10*10) / 75 = 26 -> floored 50
    expect(combine({ ...base, layer1: l1(10, 10, 10), entry: human(90) })).toMatchObject({ grade: 50, verdict: 'Thin', action: 'tag' });
  });

  it('green dot only when enabled and Solid', () => {
    expect(combine({ ...base, layer1: l1(90, 90, 90) }).action).toBe('none');
    expect(combine({ ...base, layer1: l1(90, 90, 90), greenDot: true }).action).toBe('dot');
  });

  it('user "fine" override removes any action but keeps the verdict', () => {
    const v = combine({ ...base, entry: farm(5), override: 'fine' });
    expect(v).toMatchObject({ verdict: 'Slop', action: 'none', userOverride: 'fine' });
  });

  it('user "slop" override dims, keeps collapse, and works with no score', () => {
    expect(combine({ ...base, layer1: l1(70, 70, 70), override: 'slop' }).action).toBe('dim');
    expect(combine({ ...base, entry: farm(5), override: 'slop' }).action).toBe('collapse');
    expect(combine({ ...base, override: 'slop' })).toMatchObject({ confidence: 'none', action: 'dim' });
  });

  it('sorts reasons by absolute effect, list reasons first for list hits', () => {
    const v = combine({ ...base, layer1: l1(90, 90, 90), entry: farm(10) });
    const effects = v.reasons.map((r) => Math.abs(r.effect));
    expect(effects).toEqual([...effects].sort((a, b) => b - a));
    expect(v.reasons[0]!.id).toMatch(/^(list\.farm|guard\.farm_cap)/);
  });
});

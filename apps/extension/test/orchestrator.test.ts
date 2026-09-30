import { describe, expect, it, vi } from 'vitest';
import type { Layer1Result, ListEntry, ScoreItem, Verdict } from '@gist/shared';
import type { Fallback } from '../src/fallback';
import { createOrchestrator, POLL_DELAYS } from '../src/orchestrator';

const layer1 = (score: number): Layer1Result => ({
  layer1Version: 't',
  dimensions: { info: { score, signals: [] }, human: { score, signals: [] }, monetization: { score, signals: [] } },
  styleAdjust: 0, styleSignals: [], fetchedAt: '2026-09-29T00:00:00.000Z',
});
const farmEntry: ListEntry = { match: 'farm.com', matchLevel: 'domain', kind: 'farm', siteBehavior: 5, reasons: ['Content farm'], source: 'seed' };
const FARM = 'https://farm.com/a';
const OK = 'https://ok.com/b';

function setup(responses: (Record<string, ScoreItem> | Error)[], opts: { fallbackEnabled?: boolean; overrides?: Record<string, 'slop' | 'fine'> } = {}) {
  const sleeps: number[] = [];
  const fbStore = new Map<string, Layer1Result>();
  const api = {
    score: vi.fn(async (urls: string[]) => {
      const r = responses.shift();
      if (r instanceof Error) throw r;
      return r ?? Object.fromEntries(urls.map((u) => [u, { status: 'pending' as const }]));
    }),
  };
  const fallback: Fallback & { score: ReturnType<typeof vi.fn> } = {
    cached: async (u) => fbStore.get(u) ?? null,
    enabled: async () => opts.fallbackEnabled ?? false,
    score: vi.fn(async (u: string) => { fbStore.set(u, layer1(80)); return layer1(80); }),
  };
  const orch = createOrchestrator({
    api,
    match: (u) => (u.includes('farm.com') ? farmEntry : null),
    override: async (u) => opts.overrides?.[u] ?? null,
    greenDot: async () => false,
    fallback,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  const emits: Record<string, Verdict>[] = [];
  return { orch, api, fallback, sleeps, emits, emit: (v: Record<string, Verdict>) => { emits.push(v); } };
}

describe('orchestrator', () => {
  it('emits list verdicts immediately, before the server answers', async () => {
    const t = setup([]);
    await t.orch.run([FARM, OK], t.emit);
    expect(t.emits[0]![FARM]).toMatchObject({ confidence: 'high', action: 'collapse' });
    expect(t.emits[0]![OK]).toMatchObject({ confidence: 'none', action: 'none' });
  });

  it('polls pending URLs at the spec schedule, then gives up', async () => {
    const t = setup([]);
    await t.orch.run([OK], t.emit);
    expect(t.api.score).toHaveBeenCalledTimes(1 + POLL_DELAYS.length);
    expect(t.sleeps).toEqual([1500, 2500, 4000]);
    expect(t.emits).toHaveLength(1);
  });

  it('emits again only for URLs whose Layer 1 arrived', async () => {
    const t = setup([{ [OK]: { status: 'pending' }, [FARM]: { status: 'pending' } }, { [OK]: { status: 'ready', layer1: layer1(10) }, [FARM]: { status: 'pending' } }]);
    await t.orch.run([FARM, OK], t.emit);
    expect(Object.keys(t.emits[1]!)).toEqual([OK]);
    expect(t.emits[1]![OK]).toMatchObject({ confidence: 'low', verdict: 'Thin', grade: 10 });
  });

  it('uses the device fallback for failed URLs only when enabled', async () => {
    const on = setup([{ [OK]: { status: 'failed', reason: 'blocked_challenge' } }], { fallbackEnabled: true });
    await on.orch.run([OK], on.emit);
    expect(on.fallback.score).toHaveBeenCalledWith(OK);
    expect(on.emits.at(-1)![OK]).toMatchObject({ confidence: 'low', verdict: 'Solid' });

    const off = setup([{ [OK]: { status: 'failed', reason: 'blocked_challenge' } }]);
    await off.orch.run([OK], off.emit);
    expect(off.fallback.score).not.toHaveBeenCalled();
  });

  it('survives API errors with just the immediate emit', async () => {
    const t = setup([new Error('offline')]);
    await expect(t.orch.run([OK], t.emit)).resolves.toBeUndefined();
    expect(t.emits).toHaveLength(1);
  });

  it('stops quietly when emit throws (port disconnected)', async () => {
    const t = setup([]);
    await expect(t.orch.run([OK], () => { throw new Error('port closed'); })).resolves.toBeUndefined();
    expect(t.api.score).not.toHaveBeenCalled();
  });

  it('does not re-request URLs cached by an earlier run, and dedupes input', async () => {
    const t = setup([{ [OK]: { status: 'ready', layer1: layer1(70) } }]);
    await t.orch.run([OK, OK], t.emit);
    expect(t.api.score).toHaveBeenCalledWith([OK]);
    await t.orch.run([OK], t.emit);
    expect(t.api.score).toHaveBeenCalledTimes(1);
  });

  it('sends at most 20 URLs per request', async () => {
    const urls = Array.from({ length: 25 }, (_, i) => `https://s${i}.com/`);
    const t = setup([]);
    await t.orch.run(urls, t.emit);
    expect(t.api.score.mock.calls[0]![0]).toHaveLength(20);
    expect(t.api.score.mock.calls[1]![0]).toHaveLength(5);
  });

  it('refresh() re-fetches Layer 1 when the worker restarted and lost its cache (flag after idle)', async () => {
    const t = setup([{ [OK]: { status: 'ready', layer1: layer1(70) } }], { overrides: { [OK]: 'fine' } });
    expect(await t.orch.refresh(OK)).toMatchObject({ grade: 70, confidence: 'low', userOverride: 'fine' });
    expect(t.api.score).toHaveBeenCalledWith([OK]);
    await t.orch.refresh(OK);
    expect(t.api.score).toHaveBeenCalledTimes(1); // cached now
  });

  it('refresh() still answers from the list when the server is unreachable', async () => {
    const t = setup([new Error('offline')]);
    expect(await t.orch.refresh(FARM)).toMatchObject({ confidence: 'high', action: 'collapse' });
  });

  it('verdict() reflects the user override', async () => {
    const t = setup([], { overrides: { [FARM]: 'fine' } });
    expect(await t.orch.verdict(FARM)).toMatchObject({ action: 'none', userOverride: 'fine' });
  });
  it('passes the server layer3 into verdicts (originality bar filled)', async () => {
    const layer3 = {
      layer3Version: 't', method: 'fingerprint' as const, evidence: 'enough' as const, coverage: 0.2,
      otherDomains: ['a.com', 'b.com'], originality: { score: 83, signals: [] }, computedAt: '2026-09-30T00:00:00.000Z',
    };
    const t = setup([{ [OK]: { status: 'ready', layer1: layer1(70), layer3 } }]);
    await t.orch.run([OK], t.emit);
    expect(t.emits.at(-1)![OK]!.dimensions.originality).toBe(83);
    expect((await t.orch.verdict(OK)).dimensions.originality).toBe(83);
  });

  it('re-asks once for originality after siblings became ready in the same run (final review #7)', async () => {
    const B = 'https://sibling.com/b';
    const l3 = (evidence: 'enough' | 'insufficient') => ({
      layer3Version: 't', method: 'fingerprint' as const, evidence, coverage: 0.2, otherDomains: ['a.com', 'b.com'],
      originality: evidence === 'enough' ? { score: 83, signals: [] } : null, computedAt: '2026-09-30T00:00:00.000Z',
    });
    const t = setup([
      { [OK]: { status: 'ready', layer1: layer1(70), layer3: l3('insufficient') }, [B]: { status: 'pending' } },
      { [B]: { status: 'ready', layer1: layer1(70), layer3: l3('insufficient') } },
      { [OK]: { status: 'ready', layer1: layer1(70), layer3: l3('enough') }, [B]: { status: 'ready', layer1: layer1(70), layer3: l3('insufficient') } },
    ]);
    await t.orch.run([OK, B], t.emit);
    expect(t.api.score).toHaveBeenCalledTimes(3);
    expect(t.api.score.mock.calls[2]![0]).toEqual([OK, B]);
    expect(t.emits.at(-1)![OK]!.dimensions.originality).toBe(83);
  });

  it('does not re-ask when nothing new became ready', async () => {
    const t = setup([{ [OK]: { status: 'ready', layer1: layer1(70) } }]);
    await t.orch.run([OK], t.emit);
    expect(t.api.score).toHaveBeenCalledTimes(1);
  });
});

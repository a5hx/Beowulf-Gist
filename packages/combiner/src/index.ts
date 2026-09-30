import type { Action, DimensionKey, FlagVerdict, Layer1Result, ListEntry, Signal, Verdict, VerdictName } from '@gist/shared';

export const WEIGHTS: Record<DimensionKey, number> = { info: 30, originality: 25, human: 20, siteBehavior: 15, monetization: 10 };
/** Strict rule D2. Change to 'Filler' to let Layer 1 alone dim (rule B) once eval supports it. */
export const LOW_CONFIDENCE_FLOOR: VerdictName = 'Thin';
export const FARM_CAP = 25;
export const HUMAN_FLOOR = 50;

const SEVERITY: VerdictName[] = ['Solid', 'OK', 'Thin', 'Filler', 'Slop'];
const ACTIONS: Record<VerdictName, Action> = { Solid: 'none', OK: 'none', Thin: 'tag', Filler: 'dim', Slop: 'collapse' };

export function verdictFor(grade: number): VerdictName {
  return grade >= 80 ? 'Solid' : grade >= 60 ? 'OK' : grade >= 40 ? 'Thin' : grade >= 20 ? 'Filler' : 'Slop';
}

export type CombineInput = {
  layer1: Layer1Result | null;
  entry: ListEntry | null;
  override: FlagVerdict | null;
  greenDot: boolean;
  lowConfidenceFloor?: VerdictName;
};

export function combine(input: CombineInput): Verdict {
  const { layer1, entry, override } = input;
  const floor = input.lowConfidenceFloor ?? LOW_CONFIDENCE_FLOOR;
  const dimensions: Record<DimensionKey, number | null> = {
    info: layer1?.dimensions.info.score ?? null,
    originality: null, // needs deep scan (out of scope)
    human: layer1?.dimensions.human.score ?? null,
    siteBehavior: entry?.siteBehavior ?? null,
    monetization: layer1?.dimensions.monetization.score ?? null,
  };

  const reasons: Signal[] = [];
  if (entry) entry.reasons.forEach((label, i) => reasons.push({ id: `list.${entry.kind}.${i}`, label, effect: entry.kind === 'farm' ? -50 : 50 }));
  if (layer1) {
    for (const d of Object.values(layer1.dimensions)) reasons.push(...d.signals);
    reasons.push(...layer1.styleSignals);
  }

  const scored = (Object.keys(WEIGHTS) as DimensionKey[]).filter((k) => dimensions[k] !== null);
  if (scored.length === 0) {
    return finish({ grade: null, verdict: null, confidence: 'none', action: 'none', dimensions, reasons, userOverride: override });
  }

  const totalWeight = scored.reduce((s, k) => s + WEIGHTS[k], 0);
  const weighted = scored.reduce((s, k) => s + (dimensions[k] as number) * WEIGHTS[k], 0) / totalWeight;
  let grade = Math.round(Math.min(100, Math.max(0, weighted + (layer1?.styleAdjust ?? 0))));
  const confidence = entry ? 'high' : 'low';

  if (entry?.kind === 'farm' && grade > FARM_CAP) {
    reasons.push({ id: 'guard.farm_cap', label: `Known content farm: score capped at ${FARM_CAP}`, effect: FARM_CAP - grade });
    grade = FARM_CAP;
  }
  if (entry?.kind === 'human' && grade < HUMAN_FLOOR) {
    reasons.push({ id: 'guard.human_floor', label: `Verified human site: score raised to ${HUMAN_FLOOR}`, effect: HUMAN_FLOOR - grade });
    grade = HUMAN_FLOOR;
  }

  let verdict = verdictFor(grade);
  if (confidence === 'low' && SEVERITY.indexOf(verdict) > SEVERITY.indexOf(floor)) verdict = floor;
  const action: Action = verdict === 'Solid' && input.greenDot ? 'dot' : ACTIONS[verdict];
  return finish({ grade, verdict, confidence, action, dimensions, reasons, userOverride: override });
}

function finish(v: Verdict): Verdict {
  const reasons = [...v.reasons].sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
  let action = v.action;
  if (v.userOverride === 'fine') action = 'none';
  if (v.userOverride === 'slop') action = v.action === 'collapse' ? 'collapse' : 'dim';
  return { ...v, reasons, action };
}

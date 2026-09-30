import type { Action, DimensionKey, FlagVerdict, Layer1Result, Layer3Result, ListEntry, Signal, Verdict, VerdictName } from '@gist/shared';

export const WEIGHTS: Record<DimensionKey, number> = { info: 30, originality: 25, human: 20, siteBehavior: 15, monetization: 10 };
/** Strict rule D2. Change to 'Filler' to let Layer 1 alone dim (rule B) once eval supports it. */
export const LOW_CONFIDENCE_FLOOR: VerdictName = 'Thin';
export const FARM_CAP = 25;
export const HUMAN_FLOOR = 50;
/** Copy evidence (spec O5): enough fingerprint evidence, >= 60% copied, >= 2 other domains, and a thin Layer 1. */
export const COPY_COVERAGE = 0.6;
const LAYER1_KEYS = ['info', 'human', 'monetization'] as const;

/** Grade from Layer 1's own dimensions only (no list, no originality). */
export function layer1Grade(layer1: Layer1Result): number {
  const total = LAYER1_KEYS.reduce((s, k) => s + WEIGHTS[k], 0);
  const weighted = LAYER1_KEYS.reduce((s, k) => s + layer1.dimensions[k].score * WEIGHTS[k], 0) / total;
  return Math.round(Math.min(100, Math.max(0, weighted + layer1.styleAdjust)));
}

const SEVERITY: VerdictName[] = ['Solid', 'OK', 'Thin', 'Filler', 'Slop'];
const ACTIONS: Record<VerdictName, Action> = { Solid: 'none', OK: 'none', Thin: 'tag', Filler: 'dim', Slop: 'collapse' };

export function verdictFor(grade: number): VerdictName {
  return grade >= 80 ? 'Solid' : grade >= 60 ? 'OK' : grade >= 40 ? 'Thin' : grade >= 20 ? 'Filler' : 'Slop';
}

export type CombineInput = {
  layer1: Layer1Result | null;
  layer3?: Layer3Result | null;
  entry: ListEntry | null;
  override: FlagVerdict | null;
  greenDot: boolean;
  lowConfidenceFloor?: VerdictName;
};

export function combine(input: CombineInput): Verdict {
  const { layer1, entry, override } = input;
  const floor = input.lowConfidenceFloor ?? LOW_CONFIDENCE_FLOOR;
  const l3 = input.layer3?.evidence === 'enough' ? input.layer3 : null;
  const dimensions: Record<DimensionKey, number | null> = {
    info: layer1?.dimensions.info.score ?? null,
    originality: l3?.originality?.score ?? null,
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
  if (l3?.originality) reasons.push(...l3.originality.signals);

  const scored = (Object.keys(WEIGHTS) as DimensionKey[]).filter((k) => dimensions[k] !== null);
  if (scored.length === 0) {
    return finish({ grade: null, verdict: null, confidence: 'none', action: 'none', dimensions, reasons, userOverride: override });
  }

  const copyEvidence =
    !!l3 && !!layer1 && l3.coverage >= COPY_COVERAGE && l3.otherDomains.length >= 2 && layer1Grade(layer1) < 60;

  const gradeOf = (keys: DimensionKey[]) => {
    const total = keys.reduce((s, k) => s + WEIGHTS[k], 0);
    const weighted = keys.reduce((s, k) => s + (dimensions[k] as number) * WEIGHTS[k], 0) / total;
    return Math.round(Math.min(100, Math.max(0, weighted + (layer1?.styleAdjust ?? 0))));
  };
  let grade = gradeOf(scored);
  // Shared text alone is not an accusation: syndication, cross-posts and mirrors of good pages share text too.
  // Without copy evidence, originality may raise the grade (unique text) but never lower it.
  const withoutOriginality = scored.filter((k) => k !== 'originality');
  if (!copyEvidence && dimensions.originality !== null && withoutOriginality.length > 0) grade = Math.max(grade, gradeOf(withoutOriginality));
  const confidence = entry || copyEvidence ? 'high' : 'low';

  if (entry?.kind === 'farm' && grade > FARM_CAP) {
    reasons.push({ id: 'guard.farm_cap', label: `Known content farm: score capped at ${FARM_CAP}`, effect: FARM_CAP - grade });
    grade = FARM_CAP;
  }
  if (entry?.kind === 'human' && grade < HUMAN_FLOOR && !copyEvidence) {
    reasons.push({ id: 'guard.human_floor', label: `Verified human site: score raised to ${HUMAN_FLOOR}`, effect: HUMAN_FLOOR - grade });
    grade = HUMAN_FLOOR;
  }
  if (copyEvidence) reasons.push({ id: 'guard.copy_evidence', label: 'Copied text plus thin content: page-level evidence', effect: -30 });

  let verdict = verdictFor(grade);
  if (copyEvidence && entry?.kind !== 'farm' && verdict === 'Slop') verdict = 'Filler'; // copy evidence may dim, never collapse
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

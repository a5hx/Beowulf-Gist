import type { z } from 'zod';
import type { flagReasonSchema, listBundleSchema, listEntrySchema, selectorConfigSchema } from './schemas';

/** effect: signed points on its dimension; positive helps the grade, negative hurts it. */
export type Signal = { id: string; label: string; effect: number };
export type DimensionResult = { score: number; signals: Signal[] };

export type Layer1Result = {
  layer1Version: string;
  dimensions: { info: DimensionResult; human: DimensionResult; monetization: DimensionResult };
  styleAdjust: number;
  styleSignals: Signal[];
  fetchedAt: string;
};

export type ListEntry = z.infer<typeof listEntrySchema>;
export type SelectorConfig = z.infer<typeof selectorConfigSchema>;
export type ListBundle = z.infer<typeof listBundleSchema>;
export type FlagReason = z.infer<typeof flagReasonSchema>;
export type FlagVerdict = 'slop' | 'fine';

export type Confidence = 'high' | 'low' | 'none';
export type VerdictName = 'Solid' | 'OK' | 'Thin' | 'Filler' | 'Slop';
export type Action = 'none' | 'dot' | 'tag' | 'dim' | 'collapse';
export type DimensionKey = 'info' | 'originality' | 'human' | 'siteBehavior' | 'monetization';

export type Verdict = {
  grade: number | null;
  verdict: VerdictName | null;
  confidence: Confidence;
  action: Action;
  dimensions: Record<DimensionKey, number | null>;
  reasons: Signal[];
  userOverride: FlagVerdict | null;
};

export type FailReason =
  | 'timeout'
  | 'network'
  | `http_${number}`
  | 'blocked_challenge'
  | 'robots'
  | 'too_large'
  | 'not_html'
  | 'ssrf'
  | 'parse';

export type Layer3Result = {
  layer3Version: string;
  /** 'fingerprint' today; 'llm' is reserved for a future Pro judge. */
  method: 'fingerprint';
  evidence: 'enough' | 'insufficient';
  originality: DimensionResult | null;
  /** Share (0..1) of own fingerprints matched on other domains, counting only matches that are not provably newer. */
  coverage: number;
  /** Matched domains, most matches first, max 5. */
  otherDomains: string[];
  computedAt: string;
};

export type ScoreItem =
  | { status: 'ready'; layer1: Layer1Result; layer3?: Layer3Result }
  | { status: 'pending' }
  | { status: 'failed'; reason: FailReason };

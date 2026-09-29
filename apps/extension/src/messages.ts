import type { FlagReason, FlagVerdict, SelectorConfig, Verdict } from '@gist/shared';

export const PORT_NAME = 'gist-serp';

export type InitResponse = { enabled: boolean; selectors: SelectorConfig };
export type FlagResponse = { verdict: Verdict | null };
export type RuntimeMessage =
  | { type: 'init'; host: string }
  | { type: 'flag'; url: string; verdict: FlagVerdict; reason?: FlagReason }
  | { type: 'dimmed'; n: number }
  | { type: 'noMatches'; configVersion: number };

export type PortIn = { type: 'score'; urls: string[] };
export type PortOut = { type: 'verdicts'; verdicts: Record<string, Verdict> };

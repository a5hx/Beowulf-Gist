import { layer1Grade } from '@gist/combiner';
import { buildContext, findCanonical, findPublishedAt, scoreContext } from '@gist/layer1';
import { fingerprint as defaultFingerprint } from '@gist/layer3';
import type { Layer1Result } from '@gist/shared';

export type PageAnalysis = {
  layer1: Layer1Result;
  index: { hashes: number[]; publishedAt: Date | null; thin: boolean; canonical: string | null } | null;
};

/** Parses once: Layer 1 scores plus what the originality index needs. Layer 3 failures never cost Layer 1. */
export function analyzePage(
  html: string,
  at: Date,
  deps: { fingerprint?: (text: string) => number[]; log?: (line: string) => void } = {},
  pageUrl?: string,
): PageAnalysis {
  const ctx = buildContext(html);
  const layer1 = scoreContext(ctx, at);
  try {
    return {
      layer1,
      index: {
        hashes: (deps.fingerprint ?? defaultFingerprint)(ctx.mainText),
        publishedAt: findPublishedAt(ctx.document, at),
        // Thin pages are indexed (so they can be judged) but never count as evidence against others.
        thin: layer1Grade(layer1) < 60,
        canonical: findCanonical(ctx.document, pageUrl),
      },
    };
  } catch (err) {
    deps.log?.(`error layer3 ${(err as Error).name}`);
    return { layer1, index: null };
  }
}

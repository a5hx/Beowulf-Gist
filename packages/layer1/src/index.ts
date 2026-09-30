import type { Layer1Result } from '@gist/shared';
import { buildContext, type PageContext } from './dom';
import { scoreHuman } from './human';
import { scoreInfo } from './info';
import { scoreMonetization } from './monetization';
import { scoreStyle } from './style';

/** Bump whenever heuristics change: it is part of the server cache key, so pages get re-scored. */
export const LAYER1_VERSION = '1.1.0';

/** Scores an already-built context, so callers that also fingerprint the page parse the HTML once. */
export function scoreContext(ctx: PageContext, fetchedAt: Date): Layer1Result {
  const style = scoreStyle(ctx);
  return {
    layer1Version: LAYER1_VERSION,
    dimensions: { info: scoreInfo(ctx), human: scoreHuman(ctx), monetization: scoreMonetization(ctx) },
    styleAdjust: style.adjust,
    styleSignals: style.signals,
    fetchedAt: fetchedAt.toISOString(),
  };
}

export function scoreHtml(html: string, fetchedAt: Date): Layer1Result {
  return scoreContext(buildContext(html), fetchedAt);
}

export { buildContext, type PageContext } from './dom';
export { findPublishedAt } from './published';
export { findCanonical } from './canonical';

import type { Layer1Result } from '@gist/shared';
import { buildContext } from './dom';
import { scoreHuman } from './human';
import { scoreInfo } from './info';
import { scoreMonetization } from './monetization';
import { scoreStyle } from './style';

/** Bump whenever heuristics change: it is part of the server cache key, so pages get re-scored. */
export const LAYER1_VERSION = '1.1.0';

export function scoreHtml(html: string, fetchedAt: Date): Layer1Result {
  const ctx = buildContext(html);
  const style = scoreStyle(ctx);
  return {
    layer1Version: LAYER1_VERSION,
    dimensions: { info: scoreInfo(ctx), human: scoreHuman(ctx), monetization: scoreMonetization(ctx) },
    styleAdjust: style.adjust,
    styleSignals: style.signals,
    fetchedAt: fetchedAt.toISOString(),
  };
}

export { buildContext } from './dom';

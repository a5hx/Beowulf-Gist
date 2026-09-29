import type { Signal } from '@gist/shared';
import { type PageContext, wordCount } from './dom';
import { signal } from './signals';

const PHRASES = [
  "in today's fast-paced world", 'delve into', "it's important to note", 'it is important to note', 'in conclusion',
  "whether you're a", 'look no further', 'unlock the', 'navigating the', 'a testament to', 'game-changer', 'game changer',
  'elevate your', 'in the realm of', 'embark on', 'treasure trove', 'seamlessly', 'tapestry', 'ever-evolving', 'dive into',
];

/** Weak evidence only: at most -5 in total (spec §4.1). */
export function scoreStyle(ctx: PageContext): { adjust: number; signals: Signal[] } {
  const signals: Signal[] = [];
  const text = ctx.mainText.toLowerCase().replace(/’/g, "'");
  const hits = PHRASES.reduce((n, p) => n + text.split(p).length - 1, 0);
  const per1000 = ctx.mainWords ? (hits / ctx.mainWords) * 1000 : 0;
  const phrasePenalty = Math.min(3, Math.round(per1000));
  if (phrasePenalty > 0) signals.push(signal('style.phrases', `${hits} stock filler phrases`, -phrasePenalty));

  const lengths = ctx.mainText.split(/(?<=[.!?])\s+/).map(wordCount).filter((n) => n >= 3);
  let rhythmPenalty = 0;
  if (lengths.length >= 15) {
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const sd = Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length);
    if (sd / mean < 0.3) {
      rhythmPenalty = 2;
      signals.push(signal('style.rhythm', 'Unusually uniform sentence rhythm', -2));
    }
  }
  return { adjust: 0 - phrasePenalty - rhythmPenalty, signals };
}

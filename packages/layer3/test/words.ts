/** Deterministic pseudo-random words (LCG over syllables): large, diverse vocabularies for fingerprint tests. */
const SYL = ['ka', 'lo', 'mi', 'ren', 'tu', 'sa', 'vo', 'ne', 'pi', 'dar', 'shu', 'qe', 'bil', 'fo', 'zan', 'ho', 'wex', 'ly', 'gri', 'tam'];

export function randomWords(n: number, seed: number): string[] {
  let x = seed >>> 0 || 1;
  const next = () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const len = 2 + (next() % 3);
    let w = '';
    for (let j = 0; j < len; j++) w += SYL[next() % SYL.length];
    out.push(w);
  }
  return out;
}

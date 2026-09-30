import { cyrb53 } from './hash';

export const SHINGLE_WORDS = 8;
/** Winnowing window: density ≈ 2/(WINDOW+1) ≈ 1 per 20 words; any shared run of WINDOW+SHINGLE_WORDS−1 = 46 words is caught. */
export const WINDOW = 39;

export function normalizeWords(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
}

/** Winnowed fingerprints of 8-word shingles (Schleimer et al.): unique hashes in first-seen order. */
export function fingerprint(text: string): number[] {
  const words = normalizeWords(text);
  if (words.length < SHINGLE_WORDS) return [];
  const hashes: number[] = [];
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i++) hashes.push(cyrb53(words.slice(i, i + SHINGLE_WORDS).join(' ')));

  const w = Math.min(WINDOW, hashes.length);
  const out: number[] = [];
  const seen = new Set<number>();
  let lastPos = -1;
  for (let start = 0; start + w <= hashes.length; start++) {
    let minPos = start;
    // Rightmost minimum: on ties prefer the later position, so consecutive windows keep picking the same one.
    for (let j = start; j < start + w; j++) if (hashes[j]! <= hashes[minPos]!) minPos = j;
    if (minPos !== lastPos) {
      lastPos = minPos;
      const h = hashes[minPos]!;
      if (!seen.has(h)) {
        seen.add(h);
        out.push(h);
      }
    }
  }
  return out;
}

import { describe, expect, it } from 'vitest';
import { fingerprint, normalizeWords } from '../src/fingerprint';
import { randomWords } from './words';

const text = (words: string[]) => words.join(' ');
const shared = (a: number[], b: number[]) => a.filter((h) => new Set(b).has(h)).length;

describe('normalizeWords', () => {
  it('lowercases, applies NFKC, and splits on non-letters/digits', () => {
    expect(normalizeWords('Hello,  WORLD! ﬁne—2024')).toEqual(['hello', 'world', 'fine', '2024']);
  });
});

describe('fingerprint', () => {
  it('is deterministic and ignores case and punctuation', () => {
    const t = text(randomWords(300, 1));
    expect(fingerprint(t)).toEqual(fingerprint(t));
    expect(fingerprint(t.toUpperCase().replace(/ /g, ', '))).toEqual(fingerprint(t));
  });

  it('returns [] for fewer than 8 words', () => {
    expect(fingerprint('one two three four five six seven')).toEqual([]);
  });

  it('keeps roughly one fingerprint per 20 words on long text', () => {
    const n = fingerprint(text(randomWords(4000, 7))).length;
    expect(n).toBeGreaterThan(4000 / 20 * 0.6);
    expect(n).toBeLessThan(4000 / 20 * 1.6);
  });

  it('always detects a copied 50-word passage embedded in different surrounding text', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const passage = randomWords(50, 1000 + seed);
      const a = fingerprint(text([...randomWords(300, 2000 + seed), ...passage, ...randomWords(300, 3000 + seed)]));
      const b = fingerprint(text([...randomWords(250, 4000 + seed), ...passage, ...randomWords(350, 5000 + seed)]));
      expect(shared(a, b)).toBeGreaterThan(0);
    }
  });

  it('does not match a reworded passage (known limitation: lexical, not semantic)', () => {
    const passage = randomWords(60, 42);
    const reworded = passage.map((w, i) => (i % 4 === 0 ? `${w}x` : w));
    const a = fingerprint(text([...randomWords(200, 43), ...passage, ...randomWords(200, 44)]));
    const b = fingerprint(text([...randomWords(200, 45), ...reworded, ...randomWords(200, 46)]));
    expect(shared(a, b)).toBe(0);
  });

  it('fingerprints 100k words in under 2 s', () => {
    const t = text(randomWords(100_000, 9));
    const start = performance.now();
    fingerprint(t);
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it('CJK text (no spaces) does not throw', () => {
    expect(() => fingerprint('这是一个没有空格的中文段落，用于测试指纹函数的稳健性。'.repeat(50))).not.toThrow();
  });
});

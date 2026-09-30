import { describe, expect, it } from 'vitest';
import { createMemoryIndex } from '../src/memoryIndex';

describe('memory index', () => {
  it('returns null for unknown urls and own stats for known ones', () => {
    const idx = createMemoryIndex();
    expect(idx.matchesFor('https://x.com/')).toBeNull();
    idx.add('https://me.com/a', 'me.com', new Date('2024-01-01'), [1, 2, 3]);
    expect(idx.matchesFor('https://me.com/a')?.own).toEqual({ count: 3, domain: 'me.com', publishedAt: new Date('2024-01-01') });
  });

  it('finds matches on other domains and excludes the own domain', () => {
    const idx = createMemoryIndex();
    idx.add('https://me.com/a', 'me.com', null, [1, 2, 3]);
    idx.add('https://me.com/b', 'me.com', null, [1]);
    idx.add('https://other.com/x', 'other.com', null, [2, 9]);
    expect(idx.matchesFor('https://me.com/a')?.matches).toEqual([{ hash: 2, domain: 'other.com', publishedAt: null, thin: false }]);
  });

  it('drops boilerplate hashes seen on more than 50 domains', () => {
    const idx = createMemoryIndex();
    idx.add('https://me.com/a', 'me.com', null, [7, 8]);
    for (let i = 0; i < 51; i++) idx.add(`https://site${i}.com/`, `site${i}.com`, null, [7]);
    idx.add('https://copy.com/', 'copy.com', null, [8]);
    expect(idx.matchesFor('https://me.com/a')?.matches.map((m) => m.hash)).toEqual([8]);
  });

  it('re-adding a url replaces its fingerprints', () => {
    const idx = createMemoryIndex();
    idx.add('https://a.com/', 'a.com', null, [1, 2]);
    idx.add('https://b.com/', 'b.com', null, [1]);
    idx.add('https://a.com/', 'a.com', null, [3]);
    expect(idx.matchesFor('https://b.com/')?.matches).toEqual([]);
  });

  it("carries each page's thin flag into matches", () => {
    const idx = createMemoryIndex();
    idx.add('https://me.com/a', 'me.com', null, [1]);
    idx.add('https://farm.com/x', 'farm.com', null, [1], { thin: true });
    expect(idx.matchesFor('https://me.com/a')?.matches).toEqual([{ hash: 1, domain: 'farm.com', publishedAt: null, thin: true }]);
  });

  it('ignores rel=canonical copies (final review #6)', () => {
    const idx = createMemoryIndex();
    idx.add('https://pub.com/story', 'pub.com', null, [11, 12]);
    idx.add('https://pub.co.uk/story', 'pub.co.uk', null, [11], { canonical: 'https://pub.com/story' });
    idx.add('https://pub.com.au/story', 'pub.com.au', null, [12], { canonical: 'https://pub.com/story' });
    idx.add('https://thief.com/x', 'thief.com', null, [11]);
    expect(idx.matchesFor('https://pub.com/story')?.matches.map((m) => m.domain)).toEqual(['thief.com']);
    expect(idx.matchesFor('https://pub.co.uk/story')?.matches.map((m) => m.domain)).toEqual(['thief.com']);
  });
});

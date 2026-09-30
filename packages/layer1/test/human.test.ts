import { describe, expect, it } from 'vitest';
import { buildContext } from '../src/dom';
import { findAuthor, scoreHuman } from '../src/human';
import { blogRecipe, farmRecipe, forumThread, nonNativeHowTo, page, referenceDoc } from './fixtures';

describe('findAuthor', () => {
  it('reads meta author', () => {
    expect(findAuthor(buildContext(blogRecipe()).document)).toBe('Maria Lopez');
  });
  it('reads JSON-LD author inside @graph', () => {
    const html = page(
      `<script type="application/ld+json">{"@graph":[{"@type":"Article","author":{"@type":"Person","name":"Sam Reed"}}]}</script>`,
      '<p>x</p>',
    );
    expect(findAuthor(buildContext(html).document)).toBe('Sam Reed');
  });
  it('survives malformed JSON-LD and falls back to byline', () => {
    const html = page(`<script type="application/ld+json">{not json</script>`, '<span class="byline">By Ana Ruiz</span>');
    expect(findAuthor(buildContext(html).document)).toBe('Ana Ruiz');
  });
});

describe('scoreHuman', () => {
  it('real blog: named author, first person, comments, original photos', () => {
    const r = scoreHuman(buildContext(blogRecipe()));
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.signals.map((s) => s.id)).toEqual(
      expect.arrayContaining(['human.author', 'human.first_person', 'human.comments', 'human.images']),
    );
  });
  it('farm: generic author, no first person, stock images', () => {
    const r = scoreHuman(buildContext(farmRecipe()));
    expect(r.score).toBeLessThan(40);
    expect(r.signals.map((s) => s.id)).toEqual(expect.arrayContaining(['human.generic_author', 'human.stock_images']));
  });
  it('missing author evidence is neutral, not negative (authorless reference docs)', () => {
    expect(scoreHuman(buildContext(referenceDoc())).score).toBeGreaterThanOrEqual(50);
  });
  it('forum and non-native pages get credit for a real voice', () => {
    expect(scoreHuman(buildContext(forumThread())).score).toBeGreaterThanOrEqual(70);
    expect(scoreHuman(buildContext(nonNativeHowTo())).score).toBeGreaterThanOrEqual(70);
  });
});
